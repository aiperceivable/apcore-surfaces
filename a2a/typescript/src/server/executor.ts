import { v4 as uuidv4 } from "uuid";
import { CancelToken, Context } from "apcore-js";
import { Artifact, Part, Role, TaskState } from "@a2a-js/sdk";
import type { Message, TaskStatus } from "@a2a-js/sdk";
import { TaskNotCancelableError } from "@a2a-js/sdk/errors";
import {
  AgentEvent,
  type AgentExecutor,
  type RequestContext,
  type ExecutionEventBus,
} from "@a2a-js/sdk/server";
import { getAuthIdentity } from "../auth/storage.js";
import {
  ErrorMapper,
  carriesCallerDetail,
  isGovernanceRefusal,
  sanitizeMessage,
} from "../adapters/errors.js";
import type { PartConverter } from "../adapters/parts.js";
import type { Registry } from "../adapters/agent-card.js";

/**
 * This package's default error-redaction policy, used when no deployment has
 * opted into disclosing governance refusal reasons (srs FR-ERR-011). The
 * executor swaps in its own instance when the flag is set.
 */
const errorMapper = new ErrorMapper();

/**
 * Caller-facing text for a FAILED task status.
 *
 * Delegates to {@link ErrorMapper} so the task-status surface classifies exactly
 * like the JSON-RPC surface instead of collapsing every code to one string:
 *
 * - internal / unrecognized errors keep the fixed `"Internal server error"`
 *   (srs FR-ERR-004 / FR-ERR-008, locked by the shared `error_mapping.json` and
 *   `streaming_events.json` fixtures);
 * - governance refusals carry a fixed per-class string — `"Access denied"`,
 *   `"Approval denied"`, `"Approval timed out"` (srs FR-ERR-003 / FR-ERR-009 /
 *   FR-ERR-010) — naming no caller, target, approver or rule;
 * - caller-fixable classes (schema validation, invalid input, unknown module)
 *   carry their sanitized detail, which srs FR-ERR-002 requires precisely so a
 *   caller "can correct their input without guessing".
 *
 * For those detail-carrying classes the error's `aiGuidance` is appended when
 * apcore supplied one: it exists to tell an agent what to do next, and an A2A
 * caller sees only this status message. It is withheld for every other class,
 * where the message is a fixed per-class string that must stay fixed.
 *
 * The gate is {@link carriesCallerDetail} -- the same partition `ErrorMapper`
 * itself branches on. Gating on `error.userFixable` instead would be a different
 * partition: six apcore codes are `userFixable === true` yet fall into the
 * mapper's catch-all, so e.g. a `DEPENDENCY_NOT_FOUND` failure would send the
 * caller `"Internal server error (module 'x' requires 'y' >= 2.1; ...)"` -- the
 * deliberately-opaque string extended with dependency-graph detail that
 * {@link sanitizeMessage} does not strip (it removes only paths and
 * traceback-shaped lines, not module ids, versions, env-var names or
 * hostnames). `userFixable` is settable per-error by the module author, so any
 * module could widen the fixed string further.
 */
function failureText(error: unknown, mapper: ErrorMapper = errorMapper): string {
  const message = mapper.toJsonRpcError(error).message;
  const guidance = (error as { aiGuidance?: unknown } | null)?.aiGuidance;
  if (
    carriesCallerDetail(error, mapper.discloseRefusalReason) &&
    typeof guidance === "string" &&
    guidance.trim() !== ""
  ) {
    return `${message} (${sanitizeMessage(guidance)})`;
  }
  return message;
}

function utcNow(): string {
  return new Date().toISOString();
}

function textMessage(text: string): Message {
  return {
    messageId: uuidv4(),
    contextId: "",
    taskId: "",
    role: Role.ROLE_AGENT,
    parts: [Part.fromJSON({ text })],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** Build a TaskStatus with the current timestamp (a2a-js 1.0 protobuf shape). */
function makeStatus(state: TaskState, message?: Message): TaskStatus {
  return { state, message, timestamp: utcNow() };
}

export interface ApCoreAgentExecutorOptions {
  executor: {
    callAsync(
      moduleId: string,
      inputs?: Record<string, unknown> | null,
      context?: unknown,
    ): Promise<Record<string, unknown>>;
  };
  partConverter: PartConverter;
  registry?: Registry;
  executionTimeout?: number;
  onStateChange?: (oldState: string, newState: string) => void;
  /**
   * Forward apcore's own reason for a governance refusal instead of the fixed
   * per-class string (srs FR-ERR-011). Off by default.
   */
  discloseRefusalReason?: boolean;
}

const OUTCOME_STATES = {
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  canceled: TaskState.TASK_STATE_CANCELED,
  "input-required": TaskState.TASK_STATE_INPUT_REQUIRED,
  rejected: TaskState.TASK_STATE_REJECTED,
} as const;

type TaskOutcome = keyof typeof OUTCOME_STATES;
type TerminalOutcome = Exclude<TaskOutcome, "input-required">;

interface TaskExecution {
  readonly taskId: string;
  readonly contextId: string;
  readonly token: CancelToken;
  readonly clientCancellation: AbortController;
  terminal?: TerminalOutcome;
}

export class ApCoreAgentExecutor implements AgentExecutor {
  private executor: ApCoreAgentExecutorOptions["executor"];
  private partConverter: PartConverter;
  private registry?: Registry;
  // Public executionTimeout is in seconds (matches the Python binding); stored
  // here in milliseconds for setTimeout / global_deadline arithmetic.
  private executionTimeoutMs: number;
  private onStateChange?: (oldState: string, newState: string) => void;
  // The SDK allocates one event bus per task and reuses it across interrupted turns.
  private readonly executions = new WeakMap<ExecutionEventBus, TaskExecution>();
  private errorMapper: ErrorMapper;

  constructor(opts: ApCoreAgentExecutorOptions) {
    this.executor = opts.executor;
    this.partConverter = opts.partConverter;
    this.registry = opts.registry;
    this.executionTimeoutMs = (opts.executionTimeout ?? 300) * 1000;
    this.onStateChange = opts.onStateChange;
    this.errorMapper = opts.discloseRefusalReason
      ? new ErrorMapper(true)
      : errorMapper;
  }

  private notify(oldState: string, newState: string): void {
    if (this.onStateChange) {
      try {
        this.onStateChange(oldState, newState);
      } catch {
        // Callback errors must not crash the executor
      }
    }
  }

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    // Install the cancellation state before exposing the task.
    const { taskId } = context;
    const contextId = context.contextId || taskId;
    const task: TaskExecution = {
      taskId,
      contextId,
      token: new CancelToken(),
      clientCancellation: new AbortController(),
    };
    this.executions.set(eventBus, task);
    eventBus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: makeStatus(TaskState.TASK_STATE_SUBMITTED),
        artifacts: [],
        history: [],
        metadata: undefined,
      }),
    );

    if (task.terminal !== undefined) return;

    // 2. Get skillId from message metadata
    const metadata = context.userMessage?.metadata ?? {};
    const skillId = metadata.skillId as string | undefined;
    if (!skillId) {
      this.publishOutcome(task, eventBus, "submitted", "failed", "Missing required parameter: metadata.skillId");
      return;
    }

    // 3. Validate skill exists in registry. Spec: "Validate skill_id is a known
    // module -> error -32601 if not". Fail CLOSED: if the registry lookup throws
    // or the skill is not found, publish a failed task (matches Python/Rust).
    if (this.registry) {
      let known: string[];
      try {
        known = this.registry.list();
      } catch {
        // Registry unavailable: cannot confirm the skill, so fail closed rather
        // than proceeding optimistically.
        this.publishOutcome(task, eventBus, "submitted", "failed", `Skill not found: ${skillId}`);
        return;
      }
      if (!known.includes(skillId)) {
        this.publishOutcome(task, eventBus, "submitted", "failed", `Skill not found: ${skillId}`);
        return;
      }
    }

    // 4. Parse Parts -> apcore input
    const parts: Part[] = context.userMessage?.parts ?? [];
    let descriptor = null;
    if (this.registry) {
      try {
        descriptor = this.registry.getDefinition(skillId);
      } catch {
        // Descriptor lookup failure is non-fatal
      }
    }

    let inputs: Record<string, unknown> | string;
    try {
      inputs = this.partConverter.partsToInput(parts, descriptor);
    } catch (e) {
      this.publishOutcome(task, eventBus, "submitted", "failed", String(e));
      return;
    }

    // Check if executor supports streaming (P0-A)
    const streamFn = (this.executor as { stream?: unknown }).stream;
    const canStream =
      typeof streamFn === "function" &&
      (streamFn.constructor?.name === "AsyncGeneratorFunction" ||
        Object.prototype.toString.call(streamFn) === "[object AsyncGeneratorFunction]");

    // Start both the host budget and Core's cooperative deadline for this turn.
    this.notify("submitted", "working");
    if (task.terminal !== undefined) return;
    const inputObj = typeof inputs === "string" ? { text: inputs } : inputs;
    const globalDeadline = (Date.now() + this.executionTimeoutMs) / 1000;
    // Only a client cancellation can preempt the host wait. Core may
    // signal its own token before reporting a typed timeout or cancellation.
    const clientSignal = task.clientCancellation.signal;

    try {
      const apcoreCtx = Context.create(getAuthIdentity() ?? null, null, task.token, undefined, undefined, globalDeadline);
      if (canStream) {
        await this.executeStreaming(eventBus, task, skillId, inputObj, apcoreCtx);
      } else {
        const output = await withTimeout(
          this.executor.callAsync(skillId, inputObj, apcoreCtx), this.executionTimeoutMs, clientSignal,
        );
        if (clientSignal.aborted) return;
        if (task.token.signal.aborted) {
          this.publishOutcome(task, eventBus, "working", "canceled", "Execution cancelled");
          return;
        }

        const artifact = this.partConverter.outputToParts(output, taskId);
        eventBus.publish(AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact,
          append: false,
          lastChunk: true,
          metadata: undefined,
        }));
        this.publishOutcome(task, eventBus, "working", "completed");
      }
    } catch (e: unknown) {
      if (task.terminal !== undefined) return;
      const code = (e as { code?: string } | null)?.code;
      if (e instanceof TimeoutError || code === "MODULE_TIMEOUT") {
        this.publishOutcome(task, eventBus, "working", "failed", "Execution timed out");
        task.token.cancel();
        return;
      }
      if (code === "EXECUTION_CANCELLED" || task.token.signal.aborted) {
        this.publishOutcome(task, eventBus, "working", "canceled", "Execution cancelled");
        return;
      }
      if (code === "APPROVAL_PENDING") {
        this.publishOutcome(task, eventBus, "working", "input-required", String(e));
        return;
      }
      if (isGovernanceRefusal(code)) {
        this.publishOutcome(task, eventBus, "working", "rejected", failureText(e, this.errorMapper));
        return;
      }
      console.error(`Execution failed for task ${taskId} skill ${skillId}:`, e);
      this.publishOutcome(task, eventBus, "working", "failed", failureText(e, this.errorMapper));
    }
  }

  /**
   * P0-A: Streaming execution path. Iterates executor.stream() and emits
   * TaskArtifactUpdateEvent for each chunk, then publishes completed.
   */
  private async executeStreaming(
    eventBus: ExecutionEventBus,
    task: TaskExecution,
    moduleId: string,
    inputs: Record<string, unknown>,
    apcoreCtx: Context<unknown>,
  ): Promise<void> {
    const { taskId, contextId } = task;
    const clientSignal = task.clientCancellation.signal;
    const artifactId = `art-${taskId}`;
    let chunkIndex = 0;

    const streamFn = (
      this.executor as unknown as {
        stream: (moduleId: string, inputs: Record<string, unknown>, ctx: Context<unknown>) => AsyncGenerator<Record<string, unknown>>;
      }
    ).stream;
    const iterator = streamFn.call(this.executor, moduleId, inputs, apcoreCtx)[Symbol.asyncIterator]();

    // The host uses a monotonic total budget even if the producer ignores
    // apcore's cooperative deadline.
    const deadline = performance.now() + this.executionTimeoutMs;
    let exhausted = false;
    try {
      for (;;) {
        if (clientSignal.aborted) return;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new TimeoutError();
        const next = await withTimeout(iterator.next(), remaining, clientSignal);
        if (clientSignal.aborted) return;
        if (task.token.signal.aborted) {
          this.publishOutcome(task, eventBus, "working", "canceled", "Execution cancelled");
          return;
        }
        if (next.done) {
          exhausted = true;
          break;
        }
        const artifact = this.partConverter.outputToParts(next.value, taskId);
        eventBus.publish(AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: { ...artifact, artifactId },
          append: chunkIndex > 0,
          lastChunk: false,
          metadata: undefined,
        }));
        chunkIndex++;
      }
    } finally {
      if (!exhausted) {
        // AsyncGenerator.return() waits behind any pending next().
        void Promise.resolve().then(() => iterator.return?.(undefined)).catch((error: unknown) => {
          console.warn(`[apcore-a2a] Stream cleanup failed for task ${taskId}`, error);
        });
      }
    }

    eventBus.publish(AgentEvent.artifactUpdate({
      taskId,
      contextId,
      artifact: Artifact.fromJSON({ artifactId, parts: [] }),
      append: chunkIndex > 0,
      lastChunk: true,
      metadata: undefined,
    }));
    this.publishOutcome(task, eventBus, "working", "completed");
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    const task = this.executions.get(eventBus);
    if (task?.taskId === taskId) {
      if (task.terminal === "canceled") {
        // The SDK's new cancellation listener joined after the terminal event.
        queueMicrotask(() => eventBus.finished());
        return;
      }
      if (task.terminal !== undefined) throw new TaskNotCancelableError(`Task not cancelable: ${taskId}`);
      this.publishOutcome(task, eventBus, "working", "canceled", "Canceled by client");
      task.clientCancellation.abort();
      task.token.cancel();
      return;
    }

    this.publishOutcome({ taskId, contextId: taskId }, eventBus, "working", "canceled", "Canceled by client");
  }

  private publishOutcome(
    task: Pick<TaskExecution, "taskId" | "contextId" | "terminal">,
    eventBus: ExecutionEventBus,
    previous: "submitted" | "working",
    outcome: TaskOutcome,
    message?: string,
  ): void {
    if (task.terminal !== undefined) return;
    if (outcome !== "input-required") task.terminal = outcome;
    eventBus.publish(AgentEvent.statusUpdate({
      taskId: task.taskId,
      contextId: task.contextId,
      status: makeStatus(OUTCOME_STATES[outcome], message === undefined ? undefined : textMessage(message)),
      metadata: undefined,
    }));
    this.notify(previous, outcome);
  }
}

class TimeoutError extends Error {
  constructor() {
    super("Execution timed out");
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void;
  const interruption = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Execution cancelled"));
    timer = setTimeout(() => reject(new TimeoutError()), ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, interruption]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  });
}
