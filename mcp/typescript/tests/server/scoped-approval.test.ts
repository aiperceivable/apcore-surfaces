import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as core from "apcore-js";
import { EventEmitter } from "apcore-js/events";
import { AsyncTaskManager } from "apcore-js/full";
import { describe, expect, it, vi } from "vitest";
import { StorageBackedApprovalHandler, supportsScopedCore } from "../../src/adapters/approval.js";
import { InMemoryApprovalStore } from "../../src/approval-store.js";
import { identityStorage } from "../../src/auth/storage.js";
import { APCoreMCP, asyncServe } from "../../src/index.js";
import { ApprovalBridge } from "../../src/server/approval-bridge.js";
import { AsyncTaskBridge, META_TOOL_NAMES } from "../../src/server/async-task-bridge.js";
import { MCPServerFactory } from "../../src/server/factory.js";
import { ExecutionRouter } from "../../src/server/router.js";

const moduleId = "sample.review";
const regularId = "sample.regular";
const approvalCheck = "__apcore_approval_check";
const reviewer = core.createIdentity("sample-user", "user");
const otherReviewer = core.createIdentity("other-user", "user");
const inputSchema = {
  type: "object",
  properties: { subject: { type: "string" }, copies: { type: "integer" } },
  required: ["subject", "copies"],
  additionalProperties: false,
};
const args = { subject: "example", copies: 2 };

interface PendingMetadata {
  approvalId: string;
  resumeToken: string;
}

function approvalMetadata(result: CallToolResult): PendingMetadata | undefined {
  return (result._meta?.apcore as { approval?: PendingMetadata } | undefined)?.approval;
}

async function connect(options: { streaming?: boolean; background?: boolean; trace?: boolean } = {}) {
  const store = new InMemoryApprovalStore();
  const notify = vi.fn().mockResolvedValue(undefined);
  const handler = new StorageBackedApprovalHandler(store, { notifyCallback: notify }).forMcpServer();
  const events = new EventEmitter();
  const audit: Record<string, unknown>[] = [];
  events.subscribe({
    eventPattern: "apcore.approval.decision",
    onEvent: (event) => { audit.push(event.data); },
  });
  const registry = new core.Registry();
  const execute = vi.fn((inputs) => ({ reviewed: inputs.subject }));
  const stream = vi.fn(async function* (inputs) { yield { reviewed: inputs.subject }; });
  await registry.register(moduleId, {
    description: "Review the supplied example",
    annotations: core.createAnnotations({
      requiresApproval: true,
      streaming: options.streaming,
      extra: options.background ? { mcp_async: "true" } : {},
    }),
    inputSchema,
    outputSchema: { type: "object" },
    execute,
    ...(options.streaming ? { [core.STREAMING_MARKER]: true, stream } : {}),
  } as never);
  await registry.register(regularId, {
    description: "Return an ordinary background result",
    annotations: core.createAnnotations({ extra: { mcp_async: "true" } }),
    inputSchema,
    outputSchema: { type: "object" },
    execute: () => ({ job: "ordinary" }),
  } as never);
  const executor = new core.Executor({ registry, approvalHandler: handler as never, eventEmitter: events });
  const manager = options.background ? new AsyncTaskManager({ executor }) : undefined;
  const asyncTaskBridge = manager ? new AsyncTaskBridge(manager as never, {
    descriptorLookup: id => registry.getDefinition(id) as never,
  }) : undefined;
  const factory = new MCPServerFactory({ richDescription: false });
  const server = factory.createServer();
  const router = new ExecutionRouter(executor as never, {
    validateInputs: true,
    trace: options.trace,
    asyncTaskBridge,
  });
  factory.registerHandlers(server, factory.buildTools(registry as never), router, {
    approvalBridge: new ApprovalBridge(handler),
    asyncTaskBridge,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "scoped-approval", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    store, notify, events, audit, client, manager, execute, stream,
    async close() {
      await client.close();
      await server.close();
      await manager?.shutdown();
      await events.shutdown();
      store.stop();
    },
  };
}

describe.skipIf(!supportsScopedCore())("scoped approval through the MCP wire", () => {
  it.each(["unary", "traced", "streamed"])("completes the %s approval lifecycle with private credential delivery", async kind => {
    const target = await connect({ trace: kind === "traced", streaming: kind === "streamed" });
    const run = (arguments_ = args, resumeToken?: string) => identityStorage.run(reviewer, () =>
      target.client.callTool({
        name: moduleId,
        arguments: arguments_,
        ...(resumeToken ? { _meta: { approvalId: resumeToken } } : {}),
      }));
    const poll = (identity: core.Identity | null, approvalId: string) => identityStorage.run(identity, async () => {
      const result = await target.client.callTool({ name: approvalCheck, arguments: { approval_id: approvalId } });
      return JSON.parse((result.content as { text: string }[])[0].text);
    });
    try {
      expect((await target.client.listTools()).tools.map(tool => tool.name)).toContain(approvalCheck);
      const pending = await run();
      const approval = approvalMetadata(pending);
      expect(pending.isError).toBe(true);
      expect(approval).toMatchObject({ approvalId: expect.any(String), resumeToken: expect.any(String) });
      const { approvalId, resumeToken } = approval!;
      expect(JSON.stringify(pending.content)).toContain("Approval is pending");
      expect(JSON.stringify(pending.content)).not.toContain(resumeToken);
      expect(target.notify).toHaveBeenCalledExactlyOnceWith(approvalId, moduleId, args);
      expect(await poll(reviewer, approvalId)).toEqual({ approval_id: approvalId, status: "pending" });
      expect(await poll(otherReviewer, approvalId)).toEqual({ approval_id: approvalId, status: "rejected" });
      expect(await poll(null, approvalId)).toEqual({ approval_id: approvalId, status: "rejected" });
      expect(approvalMetadata(await run(args, resumeToken))).toEqual(approval);
      expect(await target.store.resolve(approvalId, { approved: true })).toBe(true);
      expect(await poll(reviewer, approvalId)).toEqual({ approval_id: approvalId, status: "approved" });
      const completions = await Promise.all([
        run({ copies: 2, subject: "example" }, resumeToken),
        run(args, resumeToken),
      ]);
      expect(completions.filter(result => result.isError !== true)).toHaveLength(1);
      const runner = kind === "streamed" ? target.stream : target.execute;
      expect(runner).toHaveBeenCalledOnce();
      expect(runner.mock.calls[0][0]).toEqual(args);
      expect(JSON.stringify(completions)).not.toContain(resumeToken);

      await target.events.flush();
      expect(target.audit).toContainEqual(expect.objectContaining({ approval_id: approvalId, status: "pending" }));
      expect(target.audit).toContainEqual(expect.objectContaining({ approval_id: approvalId, status: "approved" }));
      expect(JSON.stringify(target.audit)).not.toContain(resumeToken);
    } finally {
      await target.close();
    }
  });

  it("permits ordinary background jobs and declines Phase B for background submissions", async () => {
    const target = await connect({ background: true });
    const save = vi.spyOn(target.store, "saveScopedPending");
    async function taskFor(name: string) {
      const result = await target.client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(approvalMetadata(result)).toBeUndefined();
      return JSON.parse((result.content as { text: string }[])[0].text).task_id as string;
    }
    try {
      const ordinary = await taskFor(regularId);
      const protectedTask = await taskFor(moduleId);
      await vi.waitFor(async () => {
        expect(await target.manager!.getStatus(ordinary)).toMatchObject({ status: "completed", result: { job: "ordinary" } });
        expect(await target.manager!.getStatus(protectedTask)).toMatchObject({
          status: "failed", error: expect.stringContaining("Scoped approval requires a direct tool call"),
        });
      });
      expect(save).not.toHaveBeenCalled();
      expect(target.notify).not.toHaveBeenCalled();
      expect(target.execute).not.toHaveBeenCalled();
      const syntheticToken = "4f2c29a5-d981-4e46-9ca1-0b17535abd12." + "1".repeat(64);
      const submitted = await target.client.callTool({
        name: META_TOOL_NAMES.SUBMIT,
        arguments: { module_id: regularId, arguments: args },
        _meta: { approvalId: syntheticToken },
      });
      expect(submitted).toMatchObject({ isError: true });
      expect(JSON.stringify(submitted.content)).toContain("Approval resumption requires a direct tool call");
      expect(JSON.stringify(submitted)).not.toContain(syntheticToken);
      const nested = await target.client.callTool({
        name: META_TOOL_NAMES.SUBMIT,
        arguments: { module_id: regularId, arguments: { ...args, _approval_token: "reserved input" } },
      });
      expect(nested).toMatchObject({ isError: true });
      expect(JSON.stringify(nested.content)).toContain("Approval resumption requires a direct tool call");
      expect(JSON.stringify(nested)).not.toContain("reserved input");
    } finally {
      await target.close();
    }
  });
});

it.skipIf(supportsScopedCore()).each([false, true])(
  "explicit Phase B declines unscoped Core before starting the store (facade: %s)", async throughFacade => {
    const info = console.info;
    const registry = new core.Registry();
    const approvalStore = new InMemoryApprovalStore();
    const start = vi.spyOn(approvalStore, "start");
    const options = { approvalStore, logLevel: "ERROR" as const };
    const startup = throughFacade
      ? new APCoreMCP(registry as never, options).asyncServe()
      : asyncServe(registry as never, options);
    await expect(startup).rejects.toThrow("Phase B requires Core with scoped approval support");
    expect(start).not.toHaveBeenCalled();
    expect(console.info).toBe(info);
  },
);

it.skipIf(!supportsScopedCore()).each([false, true])(
  "Phase B requires a wired Core approval gate (facade: %s)", async throughFacade => {
    const info = console.info;
    const registry = new core.Registry();
    const approvalStore = new InMemoryApprovalStore();
    const start = vi.spyOn(approvalStore, "start");
    const options = { approvalStore, strategy: "internal", logLevel: "ERROR" as const };
    const startup = throughFacade
      ? new APCoreMCP(registry as never, options).asyncServe()
      : asyncServe(registry as never, options);
    await expect(startup.then(async app => {
      await app.close();
      return app;
    })).rejects.toThrow("Phase B requires a wired Core approval gate");
    expect(start).not.toHaveBeenCalled();
    expect(console.info).toBe(info);
  },
);

it.skipIf(!supportsScopedCore()).each([false, true])(
  "asyncServe wires scoped approval for Streamable HTTP (facade: %s)", async throughFacade => {
    const registry = new core.Registry();
    await registry.register(moduleId, {
      description: "Review the supplied example",
      annotations: core.createAnnotations({ requiresApproval: true }),
      inputSchema,
      outputSchema: { type: "object" },
      execute: () => ({ reviewed: "example" }),
    } as never);
    const approvalStore = new InMemoryApprovalStore();
    const options = {
      approvalStore,
      async: false as const,
      authenticator: {
        authenticate: async (headers: Record<string, string>) =>
          headers.authorization === "Bearer fixture-identity" ? reviewer : null,
      },
    };
    const app = throughFacade
      ? await new APCoreMCP(registry as never, options).asyncServe()
      : await asyncServe(registry as never, options);
    const http = createServer(app.handler);
    const client = new Client({ name: "scoped-server", version: "1" });
    try {
      http.listen(0, "127.0.0.1");
      await once(http, "listening");
      const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
      await client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: "Bearer fixture-identity" } },
      }));
      const result = await client.callTool({ name: moduleId, arguments: args });
      const approval = approvalMetadata(result);
      expect(approval).toBeDefined();
      await approvalStore.resolve(approval!.approvalId, { approved: true });
      const resumed = await client.callTool({
        name: moduleId,
        arguments: args,
        _meta: { approvalId: approval!.resumeToken },
      });
      expect(resumed.isError).not.toBe(true);
      expect(resumed.structuredContent).toEqual({ reviewed: "example" });
    } finally {
      await client.close();
      await app.close();
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  },
);
