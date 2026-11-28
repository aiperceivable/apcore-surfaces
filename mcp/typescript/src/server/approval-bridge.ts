/**
 * ApprovalBridge: exposes __apcore_approval_check as an MCP meta-tool.
 *
 * Symmetric with AsyncTaskBridge. Registered in MCPServerFactory.registerHandlers()
 * alongside asyncBridge.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { isPublicApprovalId, supportsScopedCore } from "../adapters/approval.js";
import type { ApprovalPrincipal } from "../approval-store.js";

export const APPROVAL_META_TOOL_NAMES = ["__apcore_approval_check"] as const;

export type ApprovalMetaToolName = (typeof APPROVAL_META_TOOL_NAMES)[number];

export class ApprovalBridge {
  constructor(private readonly handler: {
    readonly supportsAuthorityScope?: boolean;
    checkApproval?(approvalId: string): Promise<{ status: string }>;
    checkApprovalForPrincipal?(
      approvalId: string, principal: ApprovalPrincipal | null,
    ): Promise<{ status: string }>;
  }) {}

  get available(): boolean {
    return supportsScopedCore() && typeof this.handler.checkApprovalForPrincipal === "function";
  }

  static isMetaTool(name: string): name is ApprovalMetaToolName {
    return (APPROVAL_META_TOOL_NAMES as readonly string[]).includes(name);
  }

  buildMetaTools(): Tool[] {
    if (!this.available) return [];
    return [
      {
        name: "__apcore_approval_check",
        description:
          "Poll the status of a pending approval request. " +
          "Use the public approvalId from the pending result metadata. " +
          "When approved, retry the original tool with its resumeToken in request _meta.approvalId.",
        inputSchema: {
          type: "object" as const,
          properties: {
            approval_id: {
              type: "string",
              description: "The public approvalId from _meta.apcore.approval",
            },
          },
          required: ["approval_id"],
          additionalProperties: false,
        },
      },
    ];
  }

  async handleMetaTool(
    name: string,
    arguments_: Record<string, unknown>,
    principal: ApprovalPrincipal | null = null,
  ): Promise<[Array<{ type: string; text: string }>, boolean, string | null]> {
    if (name === "__apcore_approval_check") {
      return this.handleCheck(arguments_, principal);
    }
    return [
      [{ type: "text", text: `Unknown approval meta-tool: ${name}` }],
      true,
      null,
    ];
  }

  private async handleCheck(
    args: Record<string, unknown>,
    principal: ApprovalPrincipal | null,
  ): Promise<[Array<{ type: "text"; text: string }>, boolean, string | null]> {
    const approvalId = args["approval_id"];
    if (!isPublicApprovalId(approvalId)) {
      return [[{ type: "text", text: "A public approval_id is required" }], true, null];
    }
    if (!this.available || !this.handler.checkApprovalForPrincipal) {
      return [[{ type: "text", text: "Scoped approval status unavailable" }], true, null];
    }
    if (principal?.authorityKey !== undefined && this.handler.supportsAuthorityScope !== true) {
      return [[{ type: "text", text: JSON.stringify({ approval_id: approvalId, status: "rejected" }) }], false, null];
    }
    try {
      const result = await this.handler.checkApprovalForPrincipal(approvalId, principal);
      const status = result.status === "approved" || result.status === "pending" ? result.status : "rejected";
      return [[{ type: "text", text: JSON.stringify({ approval_id: approvalId, status }) }], false, null];
    } catch {
      return [[{ type: "text", text: "Approval status unavailable" }], true, null];
    }
  }
}
