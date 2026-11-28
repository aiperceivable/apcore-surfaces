/**
 * ElicitationApprovalHandler: bridges MCP elicitation to apcore's approval system.
 *
 * Uses the MCP elicit callback (injected into Context.data) to present
 * approval requests to the human user via the MCP client.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createApprovalResult } from "apcore-js";
import { canIssueApprovalReply, recordPendingApproval } from "../approval-reply.js";
import { supportsScopedApprovalStore } from "../approval-store.js";
import { MCP_ELICIT_KEY } from "../helpers.js";
import type { ApprovalPrincipal, ApprovalScope, ApprovalStore } from "../approval-store.js";

export interface ApprovalRequest {
  moduleId: string;
  description?: string | null;
  arguments: Record<string, unknown>;
  callerId?: string | null;
  authorityKey?: string;
  context?: {
    data?: Record<string, unknown>;
    identity?: ApprovalIdentity | null;
    callerId?: string | null;
  } | null;
}

type ApprovalIdentity = Pick<ApprovalPrincipal, "type" | "id"> & { authorityKey?(): string | null };

export interface ApprovalResult {
  status: "approved" | "rejected" | "timeout" | "pending";
  /** Human-readable explanation. Never used to carry the approval id. */
  reason?: string | null;
  /** Confidential credential for the Core gate when status is pending. */
  approvalId?: string;
  /** Public record ID for telemetry and the operator. */
  auditId?: string;
}

/**
 * JSON Schema (MCP elicitation requestedSchema) for a yes/no approval prompt.
 * A boolean gives form-rendering clients (Cursor, Codex, ...) a concrete control
 * to display; an empty schema is tolerated by minimal SDK clients but
 * ignored/rejected by form-rendering clients, so the request returns no response
 * and the gate fails closed.
 */
const APPROVAL_SCHEMA: Record<string, unknown> = {
  type: "object",
  title: "Approval required",
  properties: {
    approve: {
      type: "boolean",
      title: "Approve this action?",
      description: "Select yes to allow the operation to proceed.",
    },
  },
  required: ["approve"],
};

export class ElicitationApprovalHandler {
  /**
   * Request approval via MCP elicitation.
   *
   * Extracts the elicit callback from request.context.data, builds
   * an approval message, and maps the elicit response to an ApprovalResult.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const data = request.context?.data ?? null;
    if (data === null) {
      return { status: "rejected", reason: "No context available for elicitation" };
    }

    const elicitCallback = data[MCP_ELICIT_KEY] as
      | ((
          message: string,
          requestedSchema?: Record<string, unknown>,
        ) => Promise<{ action: string; content?: Record<string, unknown> } | null>)
      | undefined;

    if (!elicitCallback) {
      return { status: "rejected", reason: "No elicitation callback available" };
    }

    const message =
      `Approval required for tool: ${request.moduleId}\n\n` +
      `${request.description ?? ""}\n\n` +
      `Arguments: ${JSON.stringify(request.arguments)}`;

    let result: { action: string; content?: Record<string, unknown> } | null;
    try {
      // Send a non-empty schema so form-rendering clients can display an
      // approve/deny control; an empty schema is silently dropped by them.
      result = await elicitCallback(message, APPROVAL_SCHEMA);
    } catch {
      return { status: "rejected", reason: "Elicitation request failed" };
    }

    if (result === null || result === undefined) {
      return { status: "rejected", reason: "Elicitation returned no response" };
    }

    if (result.action !== "accept") {
      return { status: "rejected", reason: `User action: ${result.action}` };
    }

    // action === "accept": honor an explicit approve=false from the form;
    // clients that render no field send none, so accept itself means approval.
    const content = result.content;
    const approve =
      content && typeof content.approve !== "undefined" ? Boolean(content.approve) : true;
    if (!approve) {
      return { status: "rejected", reason: "User declined approval" };
    }
    return { status: "approved" };
  }

  /**
   * Check status of an existing approval.
   *
   * Phase B (async polling) is not supported via MCP elicitation since
   * elicitation is stateless.
   */
  async checkApproval(_approvalId: string): Promise<ApprovalResult> {
    return { status: "rejected", reason: "Phase B not supported via MCP elicitation" };
  }
}

const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isPublicApprovalId(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_ID.test(value);
}

function approvalRecordId(credential: string): string | null {
  if (credential.length !== 101) return null;
  const [id, secret, remainder] = credential.split(".");
  return remainder === undefined && isPublicApprovalId(id) && /^[0-9a-f]{64}$/.test(secret ?? "") ? id : null;
}

export function isApprovalResumeToken(value: unknown): value is string {
  return typeof value === "string" && approvalRecordId(value) !== null;
}

/** The scoped gate, credential isolation, and audit IDs shipped together. */
export function supportsScopedCore(): boolean {
  const auditId = "scoped-approval-capability";
  const result = createApprovalResult({ status: "pending", ...{ auditId } });
  return Reflect.get(result, "auditId") === auditId;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function approvalPrincipal(identity: ApprovalIdentity | null | undefined): ApprovalPrincipal | null {
  if (!identity) return null;
  const authority = identity.authorityKey?.() ?? null;
  return {
    type: identity.type,
    id: identity.id,
    ...(authority === null ? {} : { authorityKey: sha256("apcore-approval-authority-v1\0" + authority) }),
  };
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return Array.from(value, canonicalValue);
  if (typeof value === "object" &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonicalValue(record[key])]));
  }
  throw new Error("Approval arguments must be JSON");
}

function businessArguments(request: ApprovalRequest): Record<string, unknown> {
  const { _approval_token: _, ...args } = request.arguments;
  return args;
}

function argumentsScopeDigest(request: ApprovalRequest, args: Record<string, unknown>): string {
  const digest: unknown = Reflect.get(request, "canonicalArgsDigest");
  if (digest == null) return sha256(JSON.stringify(canonicalValue(args)));
  const version: unknown = Reflect.get(request, "moduleVersion") ?? null;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)
      || (version !== null && typeof version !== "string")) {
    throw new Error("Invalid final approval scope");
  }
  // This prefix keeps final-scope records separate from legacy argument objects.
  return sha256("apcore-final-scope-v1\0" + JSON.stringify([version, digest]));
}

function invocationScope(request: ApprovalRequest, args: Record<string, unknown>): ApprovalScope {
  const identity = request.context?.identity;
  if ((identity?.authorityKey?.() ?? undefined) !== request.authorityKey) {
    throw new Error("Invalid approval authority binding");
  }
  return {
    principal: approvalPrincipal(identity),
    callerId: request.callerId ?? request.context?.callerId ?? null,
    moduleId: request.moduleId,
    argumentsDigest: argumentsScopeDigest(request, args),
  };
}

function rejected(reason: string): ApprovalResult {
  return { status: "rejected", reason };
}

/**
 * Phase B handler with separate public record IDs and resume credentials.
 * The operator callback receives only the public ID and business arguments.
 */
export class StorageBackedApprovalHandler {
  private readonly store: ApprovalStore;
  private readonly notifyCallback?: (approvalId: string, moduleId: string, args: Record<string, unknown>) => Promise<void>;

  constructor(
    store: ApprovalStore,
    options: {
      notifyCallback?: (approvalId: string, moduleId: string, args: Record<string, unknown>) => Promise<void>;
    } = {},
  ) {
    this.store = store;
    this.notifyCallback = options.notifyCallback;
  }

  assertScopedSupport(): void {
    if (!supportsScopedCore()) throw new Error("Phase B requires Core with scoped approval support");
    if (!supportsScopedApprovalStore(this.store)) throw new Error("Phase B requires a scoped approval store");
  }

  get supportsFinalScope(): boolean {
    return supportsScopedCore() && supportsScopedApprovalStore(this.store);
  }

  get supportsAuthorityScope(): boolean {
    return this.supportsFinalScope && this.store.supportsAuthorityScope === true;
  }

  /** Bind the provider to the server's private foreground response path. */
  forMcpServer(): Pick<StorageBackedApprovalHandler,
    "requestApproval" | "checkApproval" | "checkApprovalForPrincipal" | "checkApprovalForCall" |
    "supportsFinalScope" | "supportsAuthorityScope"> {
    const isForeground = (request: ApprovalRequest) => canIssueApprovalReply(
      request.moduleId, request.callerId ?? request.context?.callerId ?? null, request.context?.data, true,
    );
    return {
      supportsFinalScope: this.supportsFinalScope,
      supportsAuthorityScope: this.supportsAuthorityScope,
      requestApproval: async request => isForeground(request)
        ? this.requestApproval(request)
        : rejected("Scoped approval requires a direct tool call"),
      checkApproval: this.checkApproval.bind(this),
      checkApprovalForPrincipal: this.checkApprovalForPrincipal.bind(this),
      checkApprovalForCall: async (credential, request) => isForeground(request)
        ? this.checkApprovalForCall(credential, request)
        : rejected("Scoped approval requires a direct tool call"),
    };
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    if (!supportsScopedCore() || !supportsScopedApprovalStore(this.store)) {
      return rejected("Scoped approval unavailable");
    }
    if (request.authorityKey !== undefined && !this.supportsAuthorityScope) {
      return rejected("Approval authority binding unavailable");
    }
    const args = businessArguments(request);
    const contextData = request.context?.data;
    let scope: ApprovalScope;
    let auditId: string;
    let credential: string;
    try {
      scope = invocationScope(request, args);
      if (!canIssueApprovalReply(scope.moduleId, scope.callerId, contextData, false)) {
        return rejected("Scoped approval requires a direct tool call");
      }
      auditId = randomUUID();
      credential = `${auditId}.${randomBytes(32).toString("hex")}`;
      await this.store.saveScopedPending(auditId, sha256(credential), scope);
    } catch {
      console.warn("[apcore-mcp] Approval could not be recorded");
      return rejected("Approval could not be recorded");
    }

    if (this.notifyCallback) {
      try {
        await this.notifyCallback(auditId, scope.moduleId, args);
      } catch {
        console.warn("[apcore-mcp] Approval notification failed");
      }
    }
    recordPendingApproval(scope.moduleId, scope.callerId, contextData, { approvalId: auditId, resumeToken: credential });
    return { status: "pending", approvalId: credential, auditId };
  }

  async checkApproval(_approvalId: string): Promise<ApprovalResult> {
    return rejected("Scoped approval verification is required");
  }

  async checkApprovalForPrincipal(
    approvalId: string, principal: ApprovalPrincipal | null,
  ): Promise<ApprovalResult> {
    if (!isPublicApprovalId(approvalId) || !supportsScopedCore() || !supportsScopedApprovalStore(this.store)) {
      return rejected("Approval record not found");
    }
    if (principal?.authorityKey !== undefined && !this.supportsAuthorityScope) return rejected("Approval record not found");
    try {
      const record = await this.store.getScopedResult(approvalId, principal);
      return record ? { status: record.status, auditId: approvalId } : rejected("Approval record not found");
    } catch {
      return rejected("Approval status unavailable");
    }
  }

  async checkApprovalForCall(credential: string, request: ApprovalRequest): Promise<ApprovalResult> {
    const auditId = approvalRecordId(credential);
    if (!auditId || !supportsScopedCore() || !supportsScopedApprovalStore(this.store)) {
      return rejected("Approval credential unavailable for this call");
    }
    if (request.authorityKey !== undefined && !this.supportsAuthorityScope) {
      return rejected("Approval credential unavailable for this call");
    }
    try {
      const scope = invocationScope(request, businessArguments(request));
      const contextData = request.context?.data;
      if (!canIssueApprovalReply(scope.moduleId, scope.callerId, contextData, false)) {
        return rejected("Scoped approval requires a direct tool call");
      }
      const record = await this.store.consumeScoped(auditId, sha256(credential), scope);
      if (!record) return rejected("Approval credential unavailable for this call");
      if (record.status === "pending") {
        recordPendingApproval(scope.moduleId, scope.callerId, contextData, { approvalId: auditId, resumeToken: credential });
        return { status: "pending", approvalId: credential, auditId };
      }
      return { status: record.status, auditId };
    } catch {
      return rejected("Approval verification failed");
    }
  }
}
