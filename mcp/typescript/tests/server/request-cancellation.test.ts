import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Executor, Registry, type Context } from "apcore-js";
import { expect, it } from "vitest";

import { MCPServerFactory } from "../../src/server/factory.js";
import { ExecutionRouter } from "../../src/server/router.js";

it("routes a wire cancellation to the target Core invocation only", async () => {
  const targetStarted = Promise.withResolvers<void>();
  const peerStarted = Promise.withResolvers<void>();
  const targetExited = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<void>();
  const registry = new Registry();
  registry.register("test.gated", {
    description: "Wait for cancellation or the test gate",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    async execute(inputs: Record<string, unknown>, context: Context) {
      if (inputs.name === "target") {
        const aborted = Promise.withResolvers<void>();
        context.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        targetStarted.resolve();
        await Promise.race([aborted.promise, release.promise]);
        targetExited.resolve(context.signal.aborted);
      } else {
        peerStarted.resolve();
        await release.promise;
      }
      return { name: inputs.name, cancelled: context.signal.aborted };
    },
  } as never);
  const factory = new MCPServerFactory();
  const server = factory.createServer();
  const executor = Executor.fromRegistry(registry);
  const router = new ExecutionRouter(executor as never);
  factory.registerHandlers(server, factory.buildTools(registry as never), router);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wire-cancellation", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const controller = new AbortController();
  const cancellation = new Error("cancel the target request");
  const target = client.callTool({ name: "test.gated", arguments: { name: "target" } }, undefined, {
    signal: controller.signal,
  }).catch((error: unknown) => error);
  const peer = client.callTool({ name: "test.gated", arguments: { name: "peer" } });
  void peer.catch(() => undefined);
  try {
    await Promise.all([targetStarted.promise, peerStarted.promise]);
    controller.abort(cancellation);
    expect(await target).toMatchObject({ message: expect.stringContaining(cancellation.message) });
    expect(await targetExited.promise).toBe(true);
    release.resolve();
    expect((await peer).structuredContent).toEqual({ name: "peer", cancelled: false });
  } finally {
    release.resolve();
    await client.close();
    await server.close();
  }
});
