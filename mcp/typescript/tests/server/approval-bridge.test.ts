import { describe, it, expect, vi } from "vitest";
import { supportsScopedCore } from "../../src/adapters/approval.js";
import { ApprovalBridge, APPROVAL_META_TOOL_NAMES } from "../../src/server/approval-bridge.js";

const check = "__apcore_approval_check";
const id = "4f2c29a5-d981-4e46-9ca1-0b17535abd12";

describe("ApprovalBridge", () => {
  it("recognizes the approval tool separately from ordinary and task tools", () => {
    expect(APPROVAL_META_TOOL_NAMES).toContain(check);
    expect(ApprovalBridge.isMetaTool(check)).toBe(true);
    expect(ApprovalBridge.isMetaTool("__apcore_task_submit")).toBe(false);
    expect(ApprovalBridge.isMetaTool("my.module")).toBe(false);
  });

  it("does not offer polling for an unscoped handler", async () => {
    const legacy = vi.fn().mockResolvedValue({ status: "approved" });
    const bridge = new ApprovalBridge({ checkApproval: legacy });
    expect(bridge.buildMetaTools()).toEqual([]);
    expect((await bridge.handleMetaTool(check, { approval_id: id }))[1]).toBe(true);
    expect(legacy).not.toHaveBeenCalled();
  });

  it.skipIf(!supportsScopedCore())("lists only the public approval ID as input", () => {
    const bridge = new ApprovalBridge({ checkApprovalForPrincipal: async () => ({ status: "pending" }) });
    expect(bridge.buildMetaTools()).toMatchObject([{
      name: check,
      inputSchema: { type: "object", required: ["approval_id"], additionalProperties: false },
    }]);
  });

  it.skipIf(!supportsScopedCore()).each(["pending", "approved", "rejected"])(
    "returns only the authorized public %s status", async status => {
      const principal = { type: "service", id: "operator-client" };
      const poll = vi.fn().mockResolvedValue({ status, reason: "private operator note" });
      const bridge = new ApprovalBridge({ checkApprovalForPrincipal: poll });
      const [content, isError, traceId] = await bridge.handleMetaTool(check, { approval_id: id }, principal);
      expect(isError).toBe(false);
      expect(traceId).toBeNull();
      expect(JSON.parse(content[0].text)).toEqual({ approval_id: id, status });
      expect(poll).toHaveBeenCalledWith(id, principal);
    },
  );

  it("does not reflect an invalid identifier", async () => {
    const bridge = new ApprovalBridge({ checkApprovalForPrincipal: vi.fn() });
    const [content, isError] = await bridge.handleMetaTool(check, { approval_id: "invalid-id" });
    expect(isError).toBe(true);
    expect(content[0].text).toBe("A public approval_id is required");
  });

  it.skipIf(!supportsScopedCore())("returns a generic store error", async () => {
    const poll = vi.fn().mockRejectedValue(new Error("private store detail"));
    const bridge = new ApprovalBridge({ checkApprovalForPrincipal: poll });
    const [content, isError] = await bridge.handleMetaTool(check, { approval_id: id });
    expect(isError).toBe(true);
    expect(content[0].text).toBe("Approval status unavailable");
  });

  it("declines an unknown meta-tool", async () => {
    const bridge = new ApprovalBridge({});
    const [, isError] = await bridge.handleMetaTool("__apcore_unknown_tool", {});
    expect(isError).toBe(true);
  });
});
