import { describe, it, expect, vi } from "vitest";
import {
  ElicitationApprovalHandler,
  StorageBackedApprovalHandler,
  supportsScopedCore,
} from "../../src/adapters/approval.js";
import { InMemoryApprovalStore } from "../../src/approval-store.js";
import { MCP_ELICIT_KEY } from "../../src/helpers.js";

describe("ElicitationApprovalHandler", () => {
  const handler = new ElicitationApprovalHandler();

  it("returns rejected when context is null", async () => {
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: null,
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("No context");
  });

  it("returns rejected when context.data is missing", async () => {
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: {},
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("No context");
  });

  it("returns rejected when elicit callback is absent", async () => {
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: {} },
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("No elicitation callback");
  });

  it("returns approved when elicit callback returns accept", async () => {
    const elicitFn = vi.fn().mockResolvedValue({ action: "accept" });
    const result = await handler.requestApproval({
      moduleId: "test.module",
      description: "Run the test",
      arguments: { key: "value" },
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("approved");
    expect(elicitFn).toHaveBeenCalledTimes(1);
    const message = elicitFn.mock.calls[0][0] as string;
    expect(message).toContain("test.module");
    expect(message).toContain("Run the test");
    expect(message).toContain("key");
  });

  it("returns rejected when elicit callback returns decline", async () => {
    const elicitFn = vi.fn().mockResolvedValue({ action: "decline" });
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("decline");
  });

  it("returns rejected when elicit callback returns cancel", async () => {
    const elicitFn = vi.fn().mockResolvedValue({ action: "cancel" });
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("cancel");
  });

  it("returns rejected when elicit callback returns null", async () => {
    const elicitFn = vi.fn().mockResolvedValue(null);
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("no response");
  });

  it("returns rejected when elicit callback throws", async () => {
    const elicitFn = vi.fn().mockRejectedValue(new Error("network error"));
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("failed");
  });

  it("sends a non-empty approval schema to the elicit callback", async () => {
    const elicitFn = vi.fn().mockResolvedValue({ action: "accept", content: {} });
    await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(elicitFn).toHaveBeenCalledTimes(1);
    const schema = elicitFn.mock.calls[0][1] as Record<string, unknown>;
    expect(schema).toBeTruthy();
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("approve");
  });

  it("returns rejected when accept carries content.approve=false", async () => {
    const elicitFn = vi.fn().mockResolvedValue({ action: "accept", content: { approve: false } });
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("rejected");
  });

  it("returns approved when accept carries content.approve=true", async () => {
    const elicitFn = vi.fn().mockResolvedValue({ action: "accept", content: { approve: true } });
    const result = await handler.requestApproval({
      moduleId: "test.module",
      arguments: {},
      context: { data: { [MCP_ELICIT_KEY]: elicitFn } },
    });

    expect(result.status).toBe("approved");
  });

  it("checkApproval always returns rejected (Phase B not supported)", async () => {
    const result = await handler.checkApproval("some-id");

    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("Phase B");
  });
});

describe("StorageBackedApprovalHandler", () => {
  const request = { moduleId: "test.module", arguments: { x: 1 } };

  it.skipIf(supportsScopedCore())("declines Phase B when Core only supports unscoped approval", async () => {
    const handler = new StorageBackedApprovalHandler(new InMemoryApprovalStore());
    expect(() => handler.assertScopedSupport()).toThrow("scoped approval support");
    expect(await handler.requestApproval(request)).toMatchObject({ status: "rejected" });
  });

  it.skipIf(!supportsScopedCore())("keeps Core credentials separate from public operator IDs", async () => {
    const store = new InMemoryApprovalStore();
    const notify = vi.fn().mockResolvedValue(undefined);
    const handler = new StorageBackedApprovalHandler(store, { notifyCallback: notify });
    try {
      const pending = await handler.requestApproval(request);
      expect(pending).toMatchObject({ status: "pending", auditId: expect.any(String), approvalId: expect.any(String) });
      expect(pending.approvalId).not.toBe(pending.auditId);
      expect(notify).toHaveBeenCalledWith(pending.auditId, request.moduleId, request.arguments);
      expect(await store.getResult(pending.auditId!)).toMatchObject({ moduleId: request.moduleId });
      expect(await store.getResult(pending.approvalId!)).toBeNull();
      expect(await handler.checkApproval(pending.approvalId!)).toMatchObject({ status: "rejected" });
      expect(await handler.checkApprovalForPrincipal(pending.auditId!, null)).toEqual({
        status: "pending", auditId: pending.auditId,
      });
      expect(await handler.checkApprovalForCall(pending.approvalId!, request)).toEqual(pending);

      await store.resolve(pending.auditId!, { approved: true });
      expect(await handler.checkApprovalForCall(pending.approvalId!, request)).toEqual({
        status: "approved", auditId: pending.auditId,
      });
      expect(await handler.checkApprovalForCall(pending.approvalId!, request)).toMatchObject({ status: "rejected" });
    } finally {
      store.stop();
    }
  });
});
