import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, ElicitResultSchema, type ElicitRequest } from "@modelcontextprotocol/sdk/types.js";
import { APCore, Context } from "apcore-js";
import { describe, expect, it, vi } from "vitest";
import { MCP_ELICIT_KEY, MCP_PROGRESS_KEY, elicit, reportProgress } from "../../src/helpers.js";
import { AsyncTaskBridge, type AsyncTaskManagerLike } from "../../src/server/async-task-bridge.js";
import { ExecutionRouter } from "../../src/server/router.js";
import { MCPServerFactory } from "../../src/server/factory.js";
import type { Executor } from "../../src/types.js";

type RealtimeContext = Context & {
  reportProgress(progress: number, total?: number, message?: string): Promise<void>;
  elicit(message: string, schema?: Record<string, unknown>): Promise<unknown>;
};

const nativeInteractions = "withProgressReporter" in Context.prototype && "withElicitationHandler" in Context.prototype;

describe("Core realtime interactions", () => {
  it.skipIf(!nativeInteractions)("routes native and legacy module callbacks through the same transport", async () => {
    const call = vi.fn(async (_moduleId: string, _args: Record<string, unknown>, value: unknown) => {
      const context = (value as Context).child("interactions.call") as RealtimeContext;
      await context.reportProgress(1, 2, "working");
      await reportProgress(context, 2, 2);
      return { reply: await context.elicit("Continue?") };
    });
    const executor = { registry: {}, call } as unknown as Executor;
    const sendNotification = vi.fn(async (_notification: Record<string, unknown>) => {});
    const sendRequest = vi.fn(async (request: Record<string, unknown>, resultSchema: unknown) => {
      expect(ElicitRequestSchema.safeParse(request).success).toBe(true);
      expect(resultSchema).toBe(ElicitResultSchema);
      return { action: "accept", content: { yes: true } };
    });

    const [content, isError] = await new ExecutionRouter(executor).handleCall("interactions.call", {}, {
      _meta: { progressToken: "interaction" }, sendNotification, sendRequest,
    });

    expect(isError).toBe(false);
    expect(JSON.parse(content[0].text)).toEqual({ reply: { action: "accept", content: { yes: true } } });
    expect(sendNotification.mock.calls.map(call => call[0])).toEqual([
      { method: "notifications/progress", params: { progressToken: "interaction", progress: 1, total: 2, message: "working" } },
      { method: "notifications/progress", params: { progressToken: "interaction", progress: 2, total: 2 } },
    ]);
    expect(sendRequest).toHaveBeenCalledOnce();
  });

  it.skipIf(!nativeInteractions)("sends progress and asks for a form through a connected MCP client", async () => {
    const core = new APCore();
    const name = "interaction.wire";
    await core.register(name, {
      description: "Ask a question after reporting progress",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      async execute(_inputs: unknown, context: Context) {
        const active = context as RealtimeContext;
        await active.reportProgress(1, 1, "ready");
        return { response: await active.elicit("Proceed?") };
      },
    });
    const factory = new MCPServerFactory();
    const server = factory.createServer();
    factory.registerHandlers(
      server, factory.buildTools(core.registry as never), new ExecutionRouter(core as never),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "realtime-test", version: "1" }, { capabilities: { elicitation: { form: {} } } });
    const ask = vi.fn(async ({ params }: ElicitRequest) => {
      expect(params.message).toBe("Proceed?");
      if (params.mode === "url") throw new Error("Expected a form request");
      expect(params.requestedSchema).toEqual({ type: "object", properties: {} });
      return { action: "accept" as const, content: { yes: true } };
    });
    client.setRequestHandler(ElicitRequestSchema, ask);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const progress: unknown[] = [];
      const result = await client.callTool({ name, arguments: {} }, undefined, {
        onprogress: update => { progress.push(update); },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ response: { action: "accept", content: { yes: true } } });
      expect(progress).toMatchObject([{ progress: 1, total: 1, message: "ready" }]);
      expect(ask).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.skipIf(!nativeInteractions)("detaches native callbacks from a background session together with legacy callbacks", async () => {
    let taskContext: RealtimeContext | undefined;
    const manager: AsyncTaskManagerLike = {
      async submit(_id, _args, opts) {
        taskContext = (opts?.context as Context).child("interactions.background") as RealtimeContext;
        return "task";
      },
      getStatus: vi.fn(), getResult: vi.fn(), cancel: vi.fn(), listTasks: vi.fn(),
    };
    const bridge = new AsyncTaskBridge(manager);
    const progress = vi.fn(async () => {});
    const ask = vi.fn(async () => ({ action: "decline" }));
    const root = Context.create(null, null, null, { [MCP_PROGRESS_KEY]: progress, [MCP_ELICIT_KEY]: ask });
    await bridge.submit("interactions.background", {}, root, { callbackSessionKey: "session", progressToken: "t" });

    await taskContext!.reportProgress(1);
    await expect(taskContext!.elicit("Continue?")).resolves.toEqual({ action: "decline" });
    expect(progress).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledOnce();

    bridge.detachSessionTasks("session");
    await taskContext!.reportProgress(2);
    await expect(taskContext!.elicit("Continue?")).resolves.toEqual({ action: "cancel" });
    await expect(elicit(taskContext!, "Continue?")).resolves.toBeNull();
    expect(progress).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledOnce();
  });
});
