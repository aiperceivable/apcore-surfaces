import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryApprovalStore } from "../src/approval-store.js";

describe("InMemoryApprovalStore", () => {
  let store: InMemoryApprovalStore;

  beforeEach(() => {
    store = new InMemoryApprovalStore({ resolvedTtlMs: 500, pendingTtlMs: 1_000, sweepIntervalMs: 200 });
  });

  afterEach(() => {
    store.stop();
  });

  it("savePending + getResult returns pending record", async () => {
    await store.savePending("id-1", "my.module", { x: 1 });
    const rec = await store.getResult("id-1");
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("pending");
    expect(rec!.moduleId).toBe("my.module");
    expect(rec!.reason).toBeNull();
    expect(rec!.resolvedAt).toBeNull();
    expect(typeof rec!.createdAt).toBe("number");
  });

  it("getResult returns null for unknown id", async () => {
    const rec = await store.getResult("nonexistent");
    expect(rec).toBeNull();
  });

  it("resolve approved → status 'approved', reason null", async () => {
    await store.savePending("id-2", "mod", {});
    const ok = await store.resolve("id-2", { approved: true });
    expect(ok).toBe(true);
    const rec = await store.getResult("id-2");
    expect(rec!.status).toBe("approved");
    expect(rec!.reason).toBeNull();
    expect(rec!.resolvedAt).not.toBeNull();
  });

  it("resolve rejected with reason → status 'rejected', reason set", async () => {
    await store.savePending("id-3", "mod", {});
    const ok = await store.resolve("id-3", { approved: false, reason: "not allowed" });
    expect(ok).toBe(true);
    const rec = await store.getResult("id-3");
    expect(rec!.status).toBe("rejected");
    expect(rec!.reason).toBe("not allowed");
  });

  it("resolve unknown id returns false", async () => {
    const ok = await store.resolve("does-not-exist", { approved: true });
    expect(ok).toBe(false);
  });

  it("double-resolve returns false", async () => {
    await store.savePending("id-4", "mod", {});
    const first = await store.resolve("id-4", { approved: true });
    const second = await store.resolve("id-4", { approved: true });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("at maxRecords, oldest pending evicted on save", async () => {
    const tiny = new InMemoryApprovalStore({ maxRecords: 2 });
    try {
      await tiny.savePending("a", "mod", {});
      // Small delay to ensure createdAt ordering
      await new Promise(r => setTimeout(r, 2));
      await tiny.savePending("b", "mod", {});
      // Both fit
      expect(await tiny.getResult("a")).not.toBeNull();
      expect(await tiny.getResult("b")).not.toBeNull();
      // Third save should evict oldest ("a")
      await tiny.savePending("c", "mod", {});
      expect(await tiny.getResult("a")).toBeNull();
      expect(await tiny.getResult("b")).not.toBeNull();
      expect(await tiny.getResult("c")).not.toBeNull();
    } finally {
      tiny.stop();
    }
  });

  it("waitForResolution resolves after resolve()", async () => {
    await store.savePending("id-w", "mod", {});
    const waitPromise = store.waitForResolution("id-w", 5_000);
    // Resolve shortly after
    setTimeout(() => store.resolve("id-w", { approved: true }), 10);
    const rec = await waitPromise;
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("approved");
  });

  it("waitForResolution returns null for unknown id", async () => {
    const rec = await store.waitForResolution("never-saved", 10);
    expect(rec).toBeNull();
  });

  it("waitForResolution returns immediately for already-resolved record", async () => {
    await store.savePending("id-x", "mod", {});
    await store.resolve("id-x", { approved: false, reason: "nope" });
    const rec = await store.waitForResolution("id-x", 5_000);
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("rejected");
  });

  it("sweep deletes expired pending records", async () => {
    const fastStore = new InMemoryApprovalStore({
      pendingTtlMs: 50,
      resolvedTtlMs: 5_000,
      sweepIntervalMs: 10,
    });
    fastStore.start();
    try {
      await fastStore.savePending("s1", "mod", {});
      expect(await fastStore.getResult("s1")).not.toBeNull();
      // Wait for pendingTtlMs setTimeout + sweep to fire
      await new Promise(r => setTimeout(r, 200));
      // The per-record setTimeout will have called deleteRecord
      expect(await fastStore.getResult("s1")).toBeNull();
    } finally {
      fastStore.stop();
    }
  });

  it("sweep deletes expired resolved records", async () => {
    const fastStore = new InMemoryApprovalStore({
      resolvedTtlMs: 50,
      pendingTtlMs: 5_000,
      sweepIntervalMs: 10,
    });
    fastStore.start();
    try {
      await fastStore.savePending("s2", "mod", {});
      await fastStore.resolve("s2", { approved: true });
      expect(await fastStore.getResult("s2")).not.toBeNull();
      // Wait for resolvedTtlMs setTimeout to fire
      await new Promise(r => setTimeout(r, 200));
      expect(await fastStore.getResult("s2")).toBeNull();
    } finally {
      fastStore.stop();
    }
  });

  it("start/stop is idempotent", () => {
    store.start();
    store.start(); // second call is no-op
    store.stop();
    store.stop(); // second stop is no-op
  });

  it("public record omits internal arguments_ field", async () => {
    await store.savePending("id-pub", "mod", { secret: "value" });
    const rec = await store.getResult("id-pub");
    expect(rec).not.toBeNull();
    expect("arguments_" in rec!).toBe(false);
    expect(Object.keys(rec!)).toEqual(["status", "moduleId", "reason", "createdAt", "resolvedAt"]);
  });
});

describe("scoped approval storage", () => {
  const scope = {
    principal: { type: "user", id: "operator" },
    callerId: null,
    moduleId: "test.confirm",
    argumentsDigest: "a".repeat(64),
  };
  const verifier = "b".repeat(64);
  const id = "00000000-0000-4000-8000-000000000000";

  it("matches a trusted scope and consumes an approved grant once", async () => {
    const store = new InMemoryApprovalStore();
    await store.saveScopedPending(id, verifier, scope);
    expect(await store.getScopedResult(id, { type: "user", id: "another" })).toBeNull();
    expect(await store.getScopedResult(id, scope.principal)).toMatchObject({ status: "pending" });
    expect(await store.consumeScoped(id, verifier, scope)).toMatchObject({ status: "pending" });
    await store.resolve(id, { approved: true });
    expect(await store.consumeScoped(id, verifier, { ...scope, argumentsDigest: "c".repeat(64) })).toBeNull();
    const results = await Promise.all([
      store.consumeScoped(id, verifier, scope),
      store.consumeScoped(id, verifier, scope),
    ]);
    expect(results).toEqual([expect.objectContaining({ status: "approved" }), null]);
    expect(await store.getScopedResult(id, scope.principal)).toMatchObject({ status: "approved" });
    expect(Object.keys((await store.getResult(id)) ?? {})).not.toContain("verifier");
  });

  it("rejects expired records synchronously even before sweeping", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryApprovalStore({ pendingTtlMs: 100, resolvedTtlMs: 25 });
      await store.saveScopedPending(id, verifier, scope);
      await store.resolve(id, { approved: true });
      vi.setSystemTime(Date.now() + 26);
      expect(await store.consumeScoped(id, verifier, scope)).toBeNull();
      expect(await store.getScopedResult(id, scope.principal)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
