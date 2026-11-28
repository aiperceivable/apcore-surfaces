/**
 * ApprovalStore: pluggable persistence interface for Phase B approval polling.
 *
 * Users supply a concrete implementation (Redis, DB, etc.).
 * InMemoryApprovalStore is provided for testing and local development only —
 * it does NOT survive process restarts and is not suitable for production.
 */

import { timingSafeEqual } from "node:crypto";

export interface ApprovalRecord {
  status: "pending" | "approved" | "rejected";
  moduleId: string;
  reason: string | null;
  createdAt: number;       // Date.now() ms
  resolvedAt: number | null;
}

export interface ApprovalPrincipal {
  readonly type: string;
  readonly id: string;
  readonly authorityKey?: string;
}

export interface ApprovalScope {
  readonly principal: ApprovalPrincipal | null;
  readonly callerId: string | null;
  readonly moduleId: string;
  readonly argumentsDigest: string;
}

/** Pluggable storage for Phase B approval state. */
export interface ApprovalStore {
  /** The scoped methods compare authority as well as the legacy principal. */
  readonly supportsAuthorityScope?: boolean;
  savePending(approvalId: string, moduleId: string, arguments_: Record<string, unknown>): Promise<void>;
  getResult(approvalId: string): Promise<ApprovalRecord | null>;
  resolve(approvalId: string, options: { approved: boolean; reason?: string }): Promise<boolean>;
  /** Persist a public ID and SHA-256 credential verifier with the invocation scope. */
  saveScopedPending?(approvalId: string, verifier: string, scope: ApprovalScope): Promise<void>;
  /** Read only a live record owned by this trusted principal. */
  getScopedResult?(approvalId: string, principal: ApprovalPrincipal | null): Promise<ApprovalRecord | null>;
  /** Verify an unexpired record and consume an approved verifier atomically before returning it. */
  consumeScoped?(approvalId: string, verifier: string, scope: ApprovalScope): Promise<ApprovalRecord | null>;
  /**
   * Optional lifecycle hook. When present, serve()/asyncServe()/APCoreMCP call
   * it before the transport binds so the store can spin up background work
   * (e.g. InMemoryApprovalStore's sweep timer). Duck-typed everywhere it is
   * invoked, so implementations may omit it.
   */
  start?(): void;
  /**
   * Optional lifecycle hook. Called on shutdown / close() to release any
   * background resources (timers, connections). Duck-typed at every call site.
   */
  stop?(): void;
}

type ScopedMethods = "saveScopedPending" | "getScopedResult" | "consumeScoped";
export type ScopedApprovalStore = ApprovalStore & Required<Pick<ApprovalStore, ScopedMethods>>;

export function supportsScopedApprovalStore(store: ApprovalStore): store is ScopedApprovalStore {
  return typeof store.saveScopedPending === "function" &&
    typeof store.getScopedResult === "function" && typeof store.consumeScoped === "function";
}

interface InternalRecord extends ApprovalRecord {
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  scope?: ApprovalScope;
  verifier?: Buffer;
}

function samePrincipal(left: ApprovalPrincipal | null, right: ApprovalPrincipal | null): boolean {
  return left === null || right === null ? left === right :
    left.type === right.type && left.id === right.id && left.authorityKey === right.authorityKey;
}

function sameScope(left: ApprovalScope, right: ApprovalScope): boolean {
  return left.callerId === right.callerId && left.moduleId === right.moduleId &&
    left.argumentsDigest === right.argumentsDigest && samePrincipal(left.principal, right.principal);
}

function publicRecord({ status, moduleId, reason, createdAt, resolvedAt }: InternalRecord): ApprovalRecord {
  return { status, moduleId, reason, createdAt, resolvedAt };
}

/**
 * In-process store for testing and local development. State is not shared
 * between processes and lasts only until restart.
 */
export class InMemoryApprovalStore implements ScopedApprovalStore {
  readonly supportsAuthorityScope = true;

  private readonly resolvedTtlMs: number;
  private readonly pendingTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxRecords: number;

  private records = new Map<string, InternalRecord>();
  private resolvers = new Map<string, (record: ApprovalRecord | null) => void>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    resolvedTtlMs?: number;
    pendingTtlMs?: number;
    sweepIntervalMs?: number;
    maxRecords?: number;
  } = {}) {
    this.resolvedTtlMs = options.resolvedTtlMs ?? 120_000;
    this.pendingTtlMs = options.pendingTtlMs ?? 3_600_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 300_000;
    this.maxRecords = options.maxRecords ?? 10_000;
  }

  start(): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    if (typeof this.sweepTimer === "object" && this.sweepTimer !== null && "unref" in this.sweepTimer) {
      (this.sweepTimer as { unref(): void }).unref(); // don't block process exit
    }
  }

  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async savePending(approvalId: string, moduleId: string, _arguments: Record<string, unknown>): Promise<void> {
    this.insertPending(approvalId, moduleId);
  }

  async saveScopedPending(approvalId: string, verifier: string, scope: ApprovalScope): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(verifier)) throw new Error("Invalid approval verifier");
    const storedScope = { ...scope, principal: scope.principal === null ? null : { ...scope.principal } };
    this.insertPending(approvalId, scope.moduleId, storedScope, Buffer.from(verifier, "hex"));
  }

  private insertPending(approvalId: string, moduleId: string, scope?: ApprovalScope, verifier?: Buffer): void {
    const existing = this.liveRecord(approvalId);
    if (existing && (existing.scope || scope)) throw new Error("Approval record already exists");
    if (existing) this.deleteRecord(approvalId);
    if (this.records.size >= this.maxRecords) {
      this.sweep();
      if (this.records.size >= this.maxRecords) this.evictOldestPending();
      if (this.records.size >= this.maxRecords) throw new Error("Approval store capacity reached");
    }
    const createdAt = Date.now();
    const expiresAt = createdAt + this.pendingTtlMs;
    this.records.set(approvalId, {
      status: "pending",
      moduleId,
      reason: null,
      createdAt,
      resolvedAt: null,
      expiresAt,
      timer: this.scheduleExpiry(approvalId, expiresAt),
      scope,
      verifier,
    });
  }

  async getResult(approvalId: string): Promise<ApprovalRecord | null> {
    const record = this.liveRecord(approvalId);
    return record ? publicRecord(record) : null;
  }

  async getScopedResult(approvalId: string, principal: ApprovalPrincipal | null): Promise<ApprovalRecord | null> {
    const record = this.liveRecord(approvalId);
    return record?.scope && samePrincipal(record.scope.principal, principal) ? publicRecord(record) : null;
  }

  async consumeScoped(approvalId: string, verifier: string, scope: ApprovalScope): Promise<ApprovalRecord | null> {
    const record = this.liveRecord(approvalId);
    if (!record?.scope || !record.verifier || !/^[0-9a-f]{64}$/.test(verifier) ||
        !timingSafeEqual(record.verifier, Buffer.from(verifier, "hex")) || !sameScope(record.scope, scope)) return null;
    // No await between checking the scope and removing the verifier.
    if (record.status === "approved") delete record.verifier;
    return publicRecord(record);
  }

  async resolve(approvalId: string, options: { approved: boolean; reason?: string }): Promise<boolean> {
    const record = this.liveRecord(approvalId);
    if (!record || record.status !== "pending") return false;

    record.status = options.approved ? "approved" : "rejected";
    record.reason = options.reason ?? null;
    record.resolvedAt = Date.now();
    record.expiresAt = Math.min(record.expiresAt, record.resolvedAt + this.resolvedTtlMs);
    clearTimeout(record.timer);
    record.timer = this.scheduleExpiry(approvalId, record.expiresAt);
    this.resolvers.get(approvalId)?.(publicRecord(record));
    this.resolvers.delete(approvalId);
    return true;
  }

  /** Wait until resolved or timeout. Helper for tests. */
  async waitForResolution(approvalId: string, timeoutMs = 300_000): Promise<ApprovalRecord | null> {
    const record = this.liveRecord(approvalId);
    if (!record) return null;
    if (record.status !== "pending") return publicRecord(record);

    return new Promise<ApprovalRecord | null>((resolve) => {
      const timer = setTimeout(() => {
        this.resolvers.delete(approvalId);
        const current = this.liveRecord(approvalId);
        resolve(current ? publicRecord(current) : null);
      }, timeoutMs);
      this.resolvers.set(approvalId, (resolved) => {
        clearTimeout(timer);
        resolve(resolved);
      });
    });
  }

  private liveRecord(approvalId: string, now = Date.now()): InternalRecord | undefined {
    const record = this.records.get(approvalId);
    if (record && now >= record.expiresAt) {
      this.deleteRecord(approvalId);
      return undefined;
    }
    return record;
  }

  private scheduleExpiry(approvalId: string, expiresAt: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.liveRecord(approvalId), Math.max(0, expiresAt - Date.now()));
    timer.unref?.();
    return timer;
  }

  private deleteRecord(approvalId: string): void {
    const record = this.records.get(approvalId);
    if (record) clearTimeout(record.timer);
    this.records.delete(approvalId);
    this.resolvers.get(approvalId)?.(null);
    this.resolvers.delete(approvalId);
  }

  private evictOldestPending(): void {
    for (const [id, record] of this.records) {
      if (record.status === "pending") {
        this.deleteRecord(id);
        return;
      }
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const id of this.records.keys()) this.liveRecord(id, now);
  }
}
