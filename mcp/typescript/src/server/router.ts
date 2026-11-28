/**
 * ExecutionRouter - Routes MCP tool calls to apcore module execution.
 *
 * Bridges the MCP tools/call protocol with apcore's Executor.call() or callAsync(),
 * handling success/error formatting for MCP text content responses.
 *
 * Core completion supplies the authoritative stream result. When requested,
 * provisional chunks are sent as MCP progress notifications.
 */

import * as crypto from "node:crypto";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerStdioExecution } from "./stdio-output.js";
import { CancelToken, InvalidInputError, isStreamingModule } from "apcore-js";
import { isApprovalResumeToken, supportsScopedCore } from "../adapters/approval.js";
import { confirmPendingApproval, runApprovalInvocation, type ApprovalReplyCapture } from "../approval-reply.js";
import type { Module } from "apcore-js";
import { ErrorMapper } from "../adapters/errors.js";
import { ErrorCodes } from "../types.js";
import type { Executor, ModuleDescriptor, TextContentDict, McpErrorResponse, StreamCompletion, StreamExecution, StreamStepOutcome } from "../types.js";
import { createBridgeContext } from "./context.js";
import { MCP_PROGRESS_KEY, MCP_ELICIT_KEY, withCoreInteractions } from "../helpers.js";
import type { ElicitResult } from "../helpers.js";
import { getCurrentIdentity } from "../auth/storage.js";
import type { Identity } from "../auth/types.js";
import { parseTraceparent } from "./trace-context.js";
import type { AsyncTaskBridge } from "./async-task-bridge.js";

/** Maximum recursion depth for deep merge to prevent stack overflow. */
const DEEP_MERGE_MAX_DEPTH = 32;

/**
 * Recursively merge `overlay` into `base`, capped at DEEP_MERGE_MAX_DEPTH.
 *
 * When both sides have a plain object for the same key the merge recurses.
 * All other types are overwritten by `overlay`.
 */
function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth >= DEEP_MERGE_MAX_DEPTH) {
    return { ...base, ...overlay };
  }
  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(overlay)) {
    const bVal = merged[key];
    const oVal = overlay[key];
    if (
      bVal !== null && typeof bVal === "object" && !Array.isArray(bVal) &&
      oVal !== null && typeof oVal === "object" && !Array.isArray(oVal)
    ) {
      merged[key] = deepMerge(
        bVal as Record<string, unknown>,
        oVal as Record<string, unknown>,
        depth + 1,
      );
    } else {
      merged[key] = oVal;
    }
  }
  return merged;
}

function stepSucceeded(step: StreamStepOutcome): boolean {
  return step.status === "passed" || (step.status === "skipped" &&
    (step.reason === "not_configured" || step.reason === "no_match" || step.reason === "strategy_skipped"));
}

type CorePipeline = Pick<Executor, "registry"> & {
  describePipeline(): unknown;
  governanceState(): unknown;
};

function hasCorePipeline(value: unknown): value is CorePipeline {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<CorePipeline>;
  return typeof candidate.describePipeline === "function" &&
    typeof candidate.governanceState === "function" && typeof candidate.registry?.get === "function";
}

function isCoreExecutor(executor: Executor): boolean {
  if (hasCorePipeline(executor)) return true;
  // APCore exposes the same registry as its executor. Capability checks also
  // recognize a separate installation of apcore-js.
  const inner = (executor as { executor?: unknown }).executor;
  return hasCorePipeline(inner) && inner.registry === executor.registry;
}

const streamErrorCodes: ReadonlySet<string> = new Set(Object.values(ErrorCodes));

function authoritativeOutput(receipt: StreamCompletion): Record<string, unknown> {
  if (receipt.reason === "completed" && receipt.output !== null &&
      stepSucceeded(receipt.outputValidation) && stepSucceeded(receipt.middlewareAfter)) {
    return receipt.output;
  }

  let code = ErrorCodes.MODULE_EXECUTE_ERROR as string;
  let message = "Streaming invocation did not complete successfully";
  if (receipt.errorCode !== null && streamErrorCodes.has(receipt.errorCode)) {
    code = receipt.errorCode;
  } else if (receipt.reason === "consumer_closed" || receipt.reason === "cancelled") {
    code = ErrorCodes.EXECUTION_CANCELLED;
  } else if (receipt.reason === "timed_out") {
    code = ErrorCodes.MODULE_TIMEOUT;
  } else if (receipt.reason === "completed" && !stepSucceeded(receipt.outputValidation)) {
    code = ErrorCodes.SCHEMA_VALIDATION_ERROR;
    message = "Streaming output validation did not complete successfully";
  }
  // Supply only a known code and a fixed diagnostic to the existing mapper.
  throw Object.assign(new Error(message), { code, details: null });
}

/** Tuple of [content array, isError flag, traceId] returned from handleCall. */
export type CallResult = [TextContentDict[], boolean, string | undefined];

/**
 * Extra context passed from the MCP SDK request handler.
 *
 * Mirrors the relevant subset of the SDK's `RequestHandlerExtra`:
 * - `sendNotification` — sends an out-of-band notification on the current session
 * - `sendRequest` — sends a request to the client (used for elicitation)
 * - `_meta.progressToken` — opaque token the client attached to the request
 * - `_meta.traceparent` — W3C trace_context header propagated from caller
 */
export interface HandleCallExtra {
  /** Validated MCP request metadata for Phase B resumption. */
  approvalResumeToken?: string;
  /** Per-request response handoff, created by the server factory. */
  approvalReply?: ApprovalReplyCapture;
  /** @internal Hand off the live Core schema only after a successful invocation. */
  onOutputDescriptor?: (descriptor: ModuleDescriptor) => void;
  /** MCP request cancellation, including transport disconnect. */
  signal?: AbortSignal;
  sendNotification?: (notification: Record<string, unknown>) => Promise<void>;
  sendRequest?: (request: Record<string, unknown>, resultSchema: unknown) => Promise<unknown>;
  _meta?: {
    progressToken?: string | number;
    apcore?: { version?: string };
    traceparent?: string;
  };
  versionHint?: string;
  /**
   * Transport session id (e.g. SSEServerTransport.sessionId or
   * StreamableHTTPServerTransport's per-session UUID). When present and
   * the bridge is wired, it's recorded so transport-disconnect can call
   * `cancelSessionTasks(sessionKey)` for cooperative cancellation.
   * [A-D-018]
   */
  sessionId?: string;
  /**
   * Per-call id for cooperative cancellation. When omitted, the router
   * derives one from `_meta.progressToken` or generates a UUID. Wired
   * by transport-level handlers parsing inbound MCP
   * `notifications/cancelled` and forwarding to `router.cancel(callId)`.
   * [B-002]
   */
  callId?: string | number;
  /**
   * Authenticated identity forwarded by the transport. When present, this
   * takes precedence over `getCurrentIdentity()` (AsyncLocalStorage) so
   * stateless transports that don't enter an `identityStorage.run()` scope
   * can still propagate the caller's identity to executor.call(). [A-D-211]
   */
  identity?: Identity | null;
}

/** Options for the ExecutionRouter constructor. */
export interface ExecutionRouterOptions {
  validateInputs?: boolean;
  /**
   * Optional function that formats execution results into text for LLM consumption.
   * When undefined, results are serialised with `JSON.stringify(result)`.
   * Only applied to plain-object results; non-object results always use JSON.stringify.
   */
  outputFormatter?: (result: Record<string, unknown> | Array<unknown>) => string;
  /**
   * Optional built-in output format name ("json", "csv", "jsonl").
   * Takes precedence over outputFormatter if both are set.
   *
   * - "json": native `JSON.stringify` of the result (the default serialization).
   *   It does NOT route through apcore-toolkit and is equivalent to leaving
   *   outputFormat unset.
   * - "csv" / "jsonl": delegated to apcore-toolkit's `formatCsv`/`formatJsonl`.
   *   If apcore-toolkit is not available, the call fails fast with a clear
   *   error rather than silently returning empty output.
   */
  outputFormat?: "json" | "csv" | "jsonl";
  /**
   * When true (default), redact sensitive fields from output using apcore's
   * `redactSensitive()` before formatting. Missing schemas use the default
   * key-name rules. Redaction failures withhold the output as a safe tool error.
   */
  redactOutput?: boolean;
  /**
   * When true, use callWithTrace() (if available on the executor) to include
   * pipeline trace metadata in the response `_meta.trace`. Default: false.
   */
  trace?: boolean;
  /**
   * Map of module_id to output_schema, used by redactSensitive() to identify
   * which fields should be redacted.
   */
  outputSchemaMap?: Record<string, Record<string, unknown>>;
  /**
   * Optional AsyncTaskBridge that intercepts calls to async-hinted modules
   * and the four reserved `__apcore_task_*` meta-tools. When absent, all
   * calls go through the synchronous executor path.
   */
  asyncTaskBridge?: AsyncTaskBridge;
}

/**
 * Cancellation token for inbound MCP `notifications/cancelled`. [B-002]
 *
 * Re-exported from apcore-js (a hard dependency) rather than re-implemented:
 * apcore-js's `CancelToken` is the same `AbortController`-backed real-interrupt
 * token (D-18) and a strict superset of what this bridge previously defined
 * locally (it adds `check()` / `reset()`). Re-exporting keeps the public import
 * path `import { CancelToken } from ".../server/router.js"` stable while removing
 * a hand-maintained mirror that could drift from apcore-py / apcore::CancelToken.
 */
export { CancelToken };

/**
 * [B-002] Maximum number of cancel-token entries (active + tombstones)
 * kept in the per-router map. When exceeded, oldest entries are evicted
 * in insertion order. Without this cap, tombstones from cancels on
 * unknown call_ids would accumulate unboundedly.
 */
const CANCEL_TOKENS_MAX = 4096;

export class ExecutionRouter {
  private readonly _executor: Executor;
  private readonly _errorMapper: ErrorMapper;
  private readonly _validateInputs: boolean;
  private readonly _outputFormatter?: (result: Record<string, unknown> | Array<unknown>) => string;
  private readonly _outputFormat?: "json" | "csv" | "jsonl";
  private readonly _redactOutput: boolean;
  private readonly _outputSchemaMap: Record<string, Record<string, unknown>>;
  private readonly _trace: boolean;
  private readonly _asyncTaskBridge?: AsyncTaskBridge;
  /**
   * [B-002] Per-server `call_id → CancelToken` map. Populated on
   * tool-call entry by handleCall(); consulted by cancel(callId).
   * Transport layer should forward inbound MCP `notifications/cancelled`
   * to `router.cancel(callId, reason)`.
   */
  private readonly _cancelTokens = new Map<string, CancelToken>();

  /**
   * Create an ExecutionRouter.
   *
   * @param executor - Duck-typed executor with call(moduleId, inputs) or callAsync(moduleId, inputs)
   * @param options - Optional configuration including validateInputs and outputFormatter
   */
  constructor(executor: Executor, options?: ExecutionRouterOptions) {
    this._executor = executor;
    this._errorMapper = new ErrorMapper();
    this._validateInputs = options?.validateInputs ?? false;
    this._outputFormat = options?.outputFormat;
    this._redactOutput = options?.redactOutput ?? true;
    this._outputSchemaMap = options?.outputSchemaMap ?? {};
    this._trace = options?.trace ?? false;
    this._asyncTaskBridge = options?.asyncTaskBridge;

    // Built-in tabular formats (csv/jsonl) are handled directly in
    // _formatResult via the `_outputFormat` branch — no sentinel formatter is
    // needed. "json" is a no-op (native JSON.stringify). Only a caller-supplied
    // custom formatter is stored here.
    this._outputFormatter = options?.outputFormatter;
  }

  /** Expose the async task bridge (for factory tool-list merging). */
  get asyncTaskBridge(): AsyncTaskBridge | undefined {
    return this._asyncTaskBridge;
  }

  /**
   * Cooperatively cancel an in-flight tool call. [B-002]
   *
   * Looks up the CancelToken registered for `callId` in handleCall and
   * calls `token.cancel()`. Subsequent checks (e.g., from inside the
   * executing module via `context.cancelToken?.isCancelled`) will see
   * the cancellation. When `callId` is unknown (cancel arrived before
   * submit, or after the call completed), records a tombstone so a
   * subsequent same-id submit immediately sees the cancellation.
   *
   * Returns true when a token was found and cancelled; false when the
   * callId was unknown (tombstone recorded). Wired by transport-level
   * handlers parsing inbound MCP `notifications/cancelled` messages.
   */
  cancel(callId: string, reason?: string): boolean {
    const existing = this._cancelTokens.get(callId);
    if (existing) {
      // Re-insert to refresh insertion order (Map preserves it).
      this._cancelTokens.delete(callId);
      this._cancelTokens.set(callId, existing);
      existing.cancel();
      this._evictCancelTokens();
      return true;
    }
    const tombstone = new CancelToken();
    tombstone.cancel();
    this._cancelTokens.set(callId, tombstone);
    this._evictCancelTokens();
    void reason; // referenced for API symmetry; reserved for future logging
    return false;
  }

  /**
   * Internal: register a CancelToken for the duration of a tool call.
   * Returns the token (already cancelled if a tombstone was recorded
   * before the call landed).
   */
  _registerCancelToken(callId: string): CancelToken {
    const existing = this._cancelTokens.get(callId);
    const token = new CancelToken();
    if (existing && existing.isCancelled) {
      // Tombstone race: cancel arrived before submit.
      token.cancel();
    }
    // Re-insert to refresh ordering (Map preserves insertion order).
    this._cancelTokens.delete(callId);
    this._cancelTokens.set(callId, token);
    this._evictCancelTokens();
    return token;
  }

  /** Internal: release a token slot after the call completes. */
  _releaseCancelToken(callId: string): void {
    this._cancelTokens.delete(callId);
  }

  /**
   * [B-002] Cap the cancel-tokens map at CANCEL_TOKENS_MAX. Map preserves
   * insertion order, so iterator gives oldest first.
   */
  private _evictCancelTokens(): void {
    while (this._cancelTokens.size > CANCEL_TOKENS_MAX) {
      const oldest = this._cancelTokens.keys().next().value;
      if (oldest === undefined) break;
      this._cancelTokens.delete(oldest);
    }
  }

  /** Apply schema and default key rules, withholding output if redaction fails. */
  private async _maybeRedact(
    toolName: string,
    result: unknown,
    outputSchema = this._outputSchemaMap[toolName] ?? {},
  ): Promise<unknown> {
    if (!this._redactOutput || result == null) return result;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const apcore = await import("apcore-js") as any;
      const redactSensitive = apcore.redactSensitive ?? apcore.default?.redactSensitive;
      if (typeof redactSensitive !== "function") {
        throw new Error("Output redaction failed");
      }
      return redactSensitive(result, outputSchema);
    } catch {
      // Never expose the original result or the redactor's exception details.
      throw new Error("Output redaction failed");
    }
  }

  /**
   * Format an execution result into text for LLM consumption.
   *
   * Uses the configured outputFormatter if set, otherwise falls back
   * to `JSON.stringify(result)`. The formatter is applied to
   * plain-object or array results.
   */
  private async _formatResult(result: unknown): Promise<string> {
    if (result !== null && typeof result === "object") {
      // Builtin tabular formats (csv/jsonl) apply to both arrays and plain objects.
      if (this._outputFormat && this._outputFormat !== "json") {
        const rows = Array.isArray(result) ? result : [result];
        if (rows.every((r) => r !== null && typeof r === "object" && !Array.isArray(r))) {
          // Fail-fast: a caller that explicitly requested csv/jsonl must not be
          // silently handed empty output or JSON when apcore-toolkit is missing
          // (that drops data without the LLM/caller ever knowing). Surface a
          // clear error instead.
          let toolkit: Record<string, unknown> & { default?: Record<string, unknown> };
          try {
            toolkit = await import("apcore-toolkit");
          } catch (err) {
            throw new Error(
              `outputFormat="${this._outputFormat}" requires apcore-toolkit, ` +
              `which is not installed or failed to load: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          const formatCsv = toolkit.formatCsv ?? toolkit.default?.formatCsv;
          const formatJsonl = toolkit.formatJsonl ?? toolkit.default?.formatJsonl;

          if (this._outputFormat === "csv") {
            if (typeof formatCsv !== "function") {
              throw new Error(
                `outputFormat="csv" requires apcore-toolkit's formatCsv(), which is not exported by the installed version.`,
              );
            }
            return formatCsv(rows);
          }
          if (this._outputFormat === "jsonl") {
            if (typeof formatJsonl !== "function") {
              throw new Error(
                `outputFormat="jsonl" requires apcore-toolkit's formatJsonl(), which is not exported by the installed version.`,
              );
            }
            return formatJsonl(rows);
          }
        } else {
          console.warn(`outputFormat=${this._outputFormat} requested but result is not tabular; falling back to JSON`);
        }
      }

      // Custom outputFormatter only applies to plain objects, not arrays.
      if (this._outputFormatter && !Array.isArray(result)) {
        try {
          return await this._outputFormatter(result as Record<string, unknown> | Array<unknown>);
        } catch {
          // outputFormatter failed — fall back to JSON.stringify
        }
      }
    }
    return JSON.stringify(result);
  }

  /**
   * Build error text content, appending AI guidance fields as structured JSON when present.
   *
   * Guidance keys use camelCase (aiGuidance, userFixable) — identical across Python and TypeScript.
   */
  private static _buildErrorText(errorInfo: McpErrorResponse): string {
    let text = errorInfo.message;
    const guidance: Record<string, unknown> = {};
    if (errorInfo.retryable !== undefined) guidance.retryable = errorInfo.retryable;
    if (errorInfo.aiGuidance !== undefined) guidance.aiGuidance = errorInfo.aiGuidance;
    if (errorInfo.userFixable !== undefined) guidance.userFixable = errorInfo.userFixable;
    if (errorInfo.suggestion !== undefined) guidance.suggestion = errorInfo.suggestion;
    if (Object.keys(guidance).length > 0) {
      text += "\n\n" + JSON.stringify(guidance);
    }
    return text;
  }

  /**
   * Handle an MCP tools/call request by routing to the executor.
   *
   * For streaming modules, consume the authoritative Core completion even
   * without a progress token. Send each chunk provisionally when requested.
   *
   * Non-streaming path: tries executor.call() first, then falls back to
   * executor.callAsync().
   *
   * @param toolName - The MCP tool name (maps to apcore moduleId)
   * @param args - The tool call arguments
   * @param extra - Optional MCP SDK extra context with sendNotification and _meta
   * @returns Tuple of [content, isError, traceId] where content is an array of text content dicts
   */
  async handleCall(
    toolName: string,
    args: Record<string, unknown>,
    extra?: HandleCallExtra,
  ): Promise<CallResult> {
    // [B-002] Register a CancelToken for this call so that an inbound
    // MCP `notifications/cancelled` (forwarded by the transport into
    // `router.cancel(callId, reason)`) cooperatively cancels in-flight
    // work. The callId is sourced from `extra.callId`,
    // `_meta.progressToken`, or generated. Released in `finally`.
    const rawCallId =
      (extra as { callId?: string | number } | undefined)?.callId ??
      extra?._meta?.progressToken;
    const callId =
      typeof rawCallId === "string" || typeof rawCallId === "number"
        ? String(rawCallId)
        : crypto.randomUUID();
    const cancelToken = this._registerCancelToken(callId);
    const onAbort = (): void => { cancelToken.cancel(); };
    if (extra?.signal?.aborted) onAbort();
    else extra?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this._handleCallInner(toolName, args, extra, cancelToken);
    } finally {
      try {
        registerStdioExecution(cancelToken);
      } finally {
        extra?.signal?.removeEventListener("abort", onAbort);
        this._releaseCancelToken(callId);
      }
    }
  }

  /** Use the invocation backend and trusted transport identity for one discovery request. */
  discoveryResolver(): ((moduleId: string, versionHint?: string) => ModuleDescriptor | null) | undefined {
    const backend = this._executor;
    const lookup = backend.getCallableDescriptor;
    if (typeof lookup !== "function") return undefined;
    const context = createBridgeContext({}, getCurrentIdentity());
    return (moduleId, versionHint) => lookup.call(backend, moduleId, context, versionHint);
  }

  private async _handleCallInner(
    toolName: string,
    args: Record<string, unknown>,
    extra: HandleCallExtra | undefined,
    cancelToken: CancelToken,
  ): Promise<CallResult> {
    try {
      // ── Build context with MCP callbacks ──────────────────────────────
      const resumeToken = extra?.approvalResumeToken;
      if (Object.hasOwn(args, "_approval_token")) {
        throw new InvalidInputError("Use request metadata for approval resumption");
      }
      if (resumeToken !== undefined && (!isApprovalResumeToken(resumeToken) || !supportsScopedCore())) {
        throw new InvalidInputError("Invalid or unsupported approval resume metadata");
      }
      const progressToken = extra?._meta?.progressToken;
      const sendNotification = extra?.sendNotification;
      const sendRequest = extra?.sendRequest;
      const traceparentRaw = extra?._meta?.traceparent;

      // Parse incoming W3C traceparent so the downstream trace chain continues.
      let inboundTraceId: string | undefined;
      if (typeof traceparentRaw === "string" && traceparentRaw.length > 0) {
        const parsed = await parseTraceparent(traceparentRaw);
        if (parsed) {
          inboundTraceId = parsed.traceId;
        }
      }

      const contextData: Record<string, unknown> = {};
      let hasCallbacks = false;

      // Inject progress callback if progressToken + sendNotification available
      if (progressToken !== undefined && sendNotification) {
        hasCallbacks = true;
        contextData[MCP_PROGRESS_KEY] = async (
          progress: number,
          total?: number,
          message?: string,
        ): Promise<void> => {
          await sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress,
              total: total ?? 0,
              ...(message !== undefined ? { message } : {}),
            },
          });
        };
      }

      // Inject elicitation callback if sendRequest available
      if (sendRequest) {
        hasCallbacks = true;
        contextData[MCP_ELICIT_KEY] = async (
          message: string,
          requestedSchema?: Record<string, unknown>,
        ): Promise<ElicitResult | null> => {
          const result = await sendRequest(
            {
              method: "elicitation/create",
              params: {
                message,
                requestedSchema: requestedSchema ?? { type: "object", properties: {} },
              },
            },
            ElicitResultSchema,
          );
          return (result as ElicitResult) ?? null;
        };
      }

      // [A-D-211] Identity source resolution: prefer an `extra.identity`
      // forwarded explicitly by the transport (mirrors Rust which checks
      // both, and Python which only reads extra.identity), and fall back
      // to AsyncLocalStorage-scoped getCurrentIdentity() for legacy paths.
      const identity =
        (extra as { identity?: Identity | null } | undefined)?.identity ??
        getCurrentIdentity();

      // [A-D-001] Always create a context so the cancelToken is threaded
      // into the executor pipeline. Without this, modules cannot observe
      // inbound MCP `notifications/cancelled` via `context.cancelToken?.isCancelled`
      // (cooperative) or `context.signal` (real abort, D-18), and cancellation
      // is silently broken — the router-level cancel API works but the cancel
      // signal never reaches the running module. Mirrors Python's first-class
      // `Context.create(..., cancel_token=...)` (apcore 0.22.0 D-24).
      const context = withCoreInteractions(createBridgeContext(
        contextData,
        identity,
        inboundTraceId,
        cancelToken,
      ));

      // Preserve the pre-fix traceId return contract: return the context's
      // trace_id only when the call carried "meaningful" trace context
      // (callbacks, identity, or inbound traceparent). Otherwise the returned
      // traceId is undefined so vanilla calls don't leak a freshly-generated
      // UUID. The internal context still has a UUID for child() chains.
      const effectiveTraceId: string | undefined =
        hasCallbacks || identity || inboundTraceId ? context.traceId : undefined;

      // ── F-043: Async Task Bridge meta-tool dispatch ────────────────────
      if (this._asyncTaskBridge && this._asyncTaskBridge.isMetaTool(toolName)) {
        if (resumeToken !== undefined) throw new InvalidInputError("Approval resumption requires a direct tool call");
        try {
          const metaResult = await this._asyncTaskBridge.handleMetaTool(
            toolName,
            args,
            context,
            extra?.sessionId,
          );
          const content: TextContentDict[] = [
            { type: "text", text: await this._formatResult(metaResult) },
          ];
          return [content, false, effectiveTraceId];
        } catch (err: unknown) {
          const errorInfo = this._errorMapper.toMcpError(err);
          const content: TextContentDict[] = [
            { type: "text", text: ExecutionRouter._buildErrorText(errorInfo) },
          ];
          return [content, true, effectiveTraceId];
        }
      }

      // ── F-043: Async-hinted module → AsyncTaskManager.submit() ─────────
      if (this._asyncTaskBridge?.enabled) {
        let descriptor: import("../types.js").ModuleDescriptor | null = null;
        try {
          descriptor = this._executor.registry?.getDefinition?.(toolName) ?? null;
        } catch {
          // registry lookup is best-effort — leave descriptor null
        }
        if (this._asyncTaskBridge.isAsyncModule(descriptor)) {
          if (resumeToken !== undefined) throw new InvalidInputError("Approval resumption requires a direct tool call");
          try {
            // [A-D-018] Forward progressToken AND sessionKey so the bridge
            // records both for terminal-state fan-out (progressToken) and
            // transport-disconnect cancellation (sessionKey via
            // cancelSessionTasks).
            const submitProgressToken = extra?._meta?.progressToken;
            const envelope = await this._asyncTaskBridge.submit(
              toolName,
              args,
              context,
              {
                progressToken:
                  typeof submitProgressToken === "string" ||
                  typeof submitProgressToken === "number"
                    ? submitProgressToken
                    : undefined,
                sessionKey: extra?.sessionId,
              },
            );
            const content: TextContentDict[] = [
              { type: "text", text: await this._formatResult(envelope) },
            ];
            return [content, false, effectiveTraceId];
          } catch (err: unknown) {
            const errorInfo = this._errorMapper.toMcpError(err);
            const content: TextContentDict[] = [
              { type: "text", text: ExecutionRouter._buildErrorText(errorInfo) },
            ];
            return [content, true, effectiveTraceId];
          }
        }
      }

      // ── Pre-execution validation ────────────────────────────────────
      if (this._validateInputs && this._executor.validate) {
        try {
          const rawErrors = await this._executor.validate(toolName, args);
          let errorMessages: string[] = [];
          if (Array.isArray(rawErrors)) {
            // Handle both string[] and ValidationResult.errors (array of objects)
            errorMessages = rawErrors.map((e: unknown) => {
              if (typeof e === 'string') return e;
              if (typeof e === 'object' && e !== null) {
                const obj = e as Record<string, unknown>;
                const field = obj.field ?? obj.path ?? '?';
                const msg = obj.message ?? 'invalid';
                return `${field}: ${msg}`;
              }
              return String(e);
            });
          } else if (rawErrors && typeof rawErrors === 'object' && 'valid' in (rawErrors as object)) {
            // Handle ValidationResult object
            const vr = rawErrors as { valid: boolean; errors: Array<{ field?: string; message?: string }> };
            if (!vr.valid) {
              errorMessages = vr.errors.map(e => `${e.field ?? '?'}: ${e.message ?? 'invalid'}`);
            }
          }
          if (errorMessages.length > 0) {
            const detail = errorMessages.join("; ");
            const content: TextContentDict[] = [
              { type: "text", text: `Validation failed: ${detail}` },
            ];
            return [content, true, undefined];
          }
        } catch (valError: unknown) {
          const errorInfo = this._errorMapper.toMcpError(valError);
          const content: TextContentDict[] = [
            { type: "text", text: ExecutionRouter._buildErrorText(errorInfo) },
          ];
          return [content, true, undefined];
        }
      }

      // Core separates the credential from business arguments before its pipeline.
      const executionArgs = resumeToken === undefined ? args : { ...args, _approval_token: resumeToken };

      // ── Resolve versionHint from request metadata or descriptor ──────
      let versionHint: string | undefined = extra?.versionHint
        ?? extra?._meta?.apcore?.version;
      const coreExecutor = isCoreExecutor(this._executor);
      const registry = this._executor.registry;
      let descriptor: ModuleDescriptor | null = null;
      let selectedModule: unknown;
      let declaredStreaming = false;
      try {
        descriptor = registry?.getDefinition?.(toolName) ?? null;
        declaredStreaming = !coreExecutor && descriptor?.annotations?.streaming === true;
        if (!versionHint) {
          const metaHint = descriptor?.metadata?.versionHint;
          if (typeof metaHint === "string") {
            versionHint = metaHint;
          }
        }
        if (coreExecutor || (!declaredStreaming && typeof this._executor.streamWithCompletion === "function")) {
          selectedModule = registry?.get?.(toolName, versionHint);
          declaredStreaming = selectedModule != null && isStreamingModule(selectedModule as Module);
        }
      } catch {
        // Registry lookup is best-effort for structurally compatible executors.
      }

      const generation = coreExecutor ? registry.publicGeneration?.(toolName) : undefined;
      const outputSchema = coreExecutor ? descriptor?.outputSchema ?? {} : undefined;
      const protectOutput = (output: unknown): Promise<unknown> => {
        if (coreExecutor && (descriptor === null || selectedModule == null ||
            registry.get?.(toolName) !== selectedModule || registry.publicGeneration?.(toolName) !== generation)) {
          throw new Error("Tool output registration could not be verified");
        }
        return this._maybeRedact(toolName, output, outputSchema);
      };

      // ── Streaming path ────────────────────────────────────────────────
      const wantsProgress = progressToken !== undefined && sendNotification !== undefined;
      const customStreamRequested = wantsProgress && !coreExecutor;
      // Unary Core tools report progress through the context callback and
      // return the ordinary call result, including after-middleware changes.
      const execution = typeof this._executor.streamWithCompletion === "function" &&
        (declaredStreaming || customStreamRequested)
        ? this._executor.streamWithCompletion(toolName, executionArgs, context, versionHint)
        : null;
      // Retain the old structural extension point for custom executors. An
      // older Core instead uses one ordinary invocation with full validation.
      const chunks = execution?.chunks ?? (customStreamRequested
        ? this._executor.stream?.(toolName, executionArgs, context, versionHint)
        : undefined);
      if (chunks) {
        const progress = wantsProgress ? { token: progressToken, send: sendNotification } : undefined;
        const output = await runApprovalInvocation(extra?.approvalReply, context.data, () =>
          this._collectStream(chunks, execution, protectOutput, progress));
        const redacted = await protectOutput(output);
        const text = await this._formatResult(redacted);
        if (coreExecutor && descriptor !== null) extra?.onOutputDescriptor?.(descriptor);
        return [[{ type: "text", text }], false, effectiveTraceId];
      }

      // ── Non-streaming path ────────────────────────────────────────────
      let result: Record<string, unknown>;
      let traceMeta: Record<string, unknown> | undefined;

      if (this._trace && typeof this._executor.callWithTrace === 'function') {
        const callWithTrace = this._executor.callWithTrace.bind(this._executor);
        const [traceResult, pipelineTrace] = await runApprovalInvocation(extra?.approvalReply, context.data, () =>
          callWithTrace(toolName, executionArgs, context, versionHint));
        result = traceResult;
        // Convert pipeline trace to a serialisable dict
        if (pipelineTrace && typeof pipelineTrace === 'object') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pt = pipelineTrace as any;
          traceMeta = {
            strategyName: pt.strategyName ?? pt.strategy_name ?? undefined,
            totalDurationMs: pt.totalDurationMs ?? pt.total_duration_ms ?? undefined,
            steps: Array.isArray(pt.steps)
              ? pt.steps.map((s: Record<string, unknown>) => ({
                  name: s.name,
                  durationMs: s.durationMs ?? s.duration_ms,
                  skipped: s.skipped ?? false,
                  skipReason: s.skipReason ?? s.skip_reason ?? undefined,
                }))
              : [],
          };
        }
      } else {
        const callFn = typeof this._executor.call === 'function'
          ? this._executor.call.bind(this._executor)
          : typeof this._executor.callAsync === 'function'
          ? this._executor.callAsync.bind(this._executor)
          : null;
        if (!callFn) {
          throw new Error('Executor must implement call() or callAsync()');
        }
        result = await runApprovalInvocation(extra?.approvalReply, context.data, () =>
          callFn(toolName, executionArgs, context, versionHint));
      }

      const redacted = await protectOutput(result);

      const content: TextContentDict[] = [
        {
          type: "text",
          text: await this._formatResult(redacted),
          ...(traceMeta ? { _meta: { trace: traceMeta } } : {}),
        } as TextContentDict,
      ];

      if (coreExecutor && descriptor !== null) extra?.onOutputDescriptor?.(descriptor);
      return [content, false, effectiveTraceId];
    } catch (error: unknown) {
      // Error messages, stacks, codes and attached fields may contain secrets.
      console.error("Tool execution failed");
      const errorInfo = this._errorMapper.toMcpError(error);
      if (errorInfo.errorType === ErrorCodes.APPROVAL_PENDING) confirmPendingApproval(extra?.approvalReply);

      const content: TextContentDict[] = [
        {
          type: "text",
          text: ExecutionRouter._buildErrorText(errorInfo),
        },
      ];

      return [content, true, undefined];
    }
  }

  private async _collectStream(
    chunks: AsyncIterable<Record<string, unknown>>,
    execution: StreamExecution | null,
    protectOutput: (output: unknown) => Promise<unknown>,
    progress?: { token: string | number; send: NonNullable<HandleCallExtra["sendNotification"]> },
  ): Promise<Record<string, unknown>> {
    let accumulated: Record<string, unknown> = {};
    let count = 0;
    try {
      for await (const chunk of chunks) {
        if (!execution) accumulated = deepMerge(accumulated, chunk);
        if (progress) {
          const safeChunk = await protectOutput(chunk);
          await progress.send({
            method: "notifications/progress",
            params: { progressToken: progress.token, progress: ++count, message: JSON.stringify(safeChunk) },
          });
        }
      }
    } catch (error) {
      if (!execution) throw error;
      // Core settles failures independently of iterator errors. This also
      // closes promptly if sending a progress notification failed.
      await execution.close();
      authoritativeOutput(await execution.completion);
      throw new Error("Streaming progress failed");
    }
    return execution ? authoritativeOutput(await execution.completion) : accumulated;
  }

  /**
   * Preflight validation for a tool call without executing it.
   *
   * Delegates to `executor.validate()` if the executor supports it, and
   * returns a structured validation result.
   *
   * @param toolName - The MCP tool name (maps to apcore moduleId)
   * @param arguments_ - The tool call arguments to validate
   * @returns Structured validation result with checks array
   */
  async validateTool(
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      if (typeof this._executor.validate !== 'function') {
        return {
          valid: true,
          checks: [],
          requiresApproval: false,
        };
      }

      const rawResult = await this._executor.validate(toolName, arguments_);

      // Normalise result into {valid, checks, requiresApproval}
      if (rawResult && typeof rawResult === 'object' && 'valid' in (rawResult as object)) {
        const vr = rawResult as Record<string, unknown>;
        return {
          valid: vr.valid ?? true,
          checks: Array.isArray(vr.checks) ? vr.checks : [],
          requiresApproval: vr.requiresApproval ?? vr.requires_approval ?? false,
        };
      }

      // Array of errors → convert to checks format
      if (Array.isArray(rawResult)) {
        if (rawResult.length === 0) {
          return { valid: true, checks: [], requiresApproval: false };
        }
        const checks = rawResult.map((e: unknown) => {
          const msg = typeof e === 'string' ? e
            : (typeof e === 'object' && e !== null)
              ? (e as Record<string, unknown>).message ?? String(e)
              : String(e);
          return {
            check: typeof e === 'object' && e !== null ? ((e as Record<string, unknown>).field ?? 'validation') : 'validation',
            passed: false,
            error: { message: msg },
            warnings: [],
          };
        });
        return { valid: false, checks, requiresApproval: false };
      }

      // Unexpected shape — treat as valid
      return { valid: true, checks: [], requiresApproval: false };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        valid: false,
        checks: [
          {
            check: "unexpected",
            passed: false,
            error: { message },
            warnings: [],
          },
        ],
        requiresApproval: false,
      };
    }
  }
}
