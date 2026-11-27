import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as core from "apcore-js";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { MCPServerFactory } from "../../src/server/factory.js";
import { ExecutionRouter } from "../../src/server/router.js";

const moduleId = "test.completion";
const hasCompletion = "streamWithCompletion" in core.Executor.prototype;
const redacted = "***REDACTED***";

async function connect(
  fail: "validation" | "after" | null = null,
  declaresStreaming = true,
  sdk = core,
  throughFacade = false,
) {
  let calls = 0;
  let streams = 0;
  const registry = new sdk.Registry();
  const outputSchema = {
    type: "object",
    properties: { secret: { type: "string", "x-sensitive": true } },
    ...(fail === "validation" ? { required: ["absent"] } : {}),
  };
  await registry.register(moduleId, {
    description: "Distinguish ordinary invocation and canonical streaming",
    annotations: sdk.createAnnotations({ streaming: declaresStreaming }),
    [sdk.STREAMING_MARKER]: true,
    inputSchema: { type: "object" },
    outputSchema,
    execute: () => { calls++; return { atomic: true, absent: true }; },
    async *stream() {
      streams++;
      yield { group: { detail: { left: true } }, items: [1], secret: "wire-secret" };
      yield { group: { detail: { right: true } }, items: [2] };
    },
  } as never);
  const config = new sdk.Config({ stream: { max_merge_depth: 1 } });
  const executor = throughFacade ? new sdk.APCore({ registry, config }) : new sdk.Executor({ registry, config });
  if (fail === "after") executor.useAfter(() => { throw new Error("private-after-cause"); });
  const factory = new MCPServerFactory();
  const server = factory.createServer();
  const router = new ExecutionRouter(executor as never, { outputSchemaMap: { [moduleId]: outputSchema } });
  factory.registerHandlers(server, factory.buildTools(registry as never), router);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "wire-completion", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    counts: () => ({ calls, streams }),
    async close() { await client.close(); await server.close(); },
  };
}

it.each([false, true])("uses an independent Core package (facade: %s)", async (throughFacade) => {
  const entry = await realpath(fileURLToPath(import.meta.resolve("apcore-js")));
  const source = dirname(dirname(entry));
  const copy = await mkdtemp(join(tmpdir(), "apcore-mcp-core-copy-"));
  try {
    const packageRoot = join(copy, "node_modules", "apcore-js");
    await mkdir(packageRoot, { recursive: true });
    await cp(join(source, "dist"), join(packageRoot, "dist"), { recursive: true });
    await cp(join(source, "package.json"), join(packageRoot, "package.json"));
    await symlink(dirname(source), join(packageRoot, "node_modules"), "junction");
    const sdk: typeof core = await import(/* @vite-ignore */ pathToFileURL(join(packageRoot, "dist", "index.js")).href);
    expect(sdk.Executor).not.toBe(core.Executor);
    expect(sdk.APCore).not.toBe(core.APCore);
    const notifications: unknown[] = [];
    const target = await connect(hasCompletion ? null : "after", false, sdk, throughFacade);
    try {
      const result = await target.client.callTool({ name: moduleId, arguments: {} }, undefined, hasCompletion ? undefined : {
        onprogress: ({ message }) => { notifications.push(message); },
      });
      if (hasCompletion) {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ group: { detail: { right: true } }, items: [2], secret: redacted });
        expect(target.counts()).toEqual({ calls: 0, streams: 1 });
      } else {
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
        expect(target.counts()).toEqual({ calls: 1, streams: 0 });
        expect(notifications).toEqual([]);
      }
    } finally {
      await target.close();
    }
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
});

it.each([false, true])("uses the capability before executing a tool (progress requested: %s)", async (withProgress) => {
  const target = await connect();
  const notifications: unknown[] = [];
  try {
    const result = await target.client.callTool({ name: moduleId, arguments: {} }, undefined, withProgress ? {
      onprogress: ({ message }) => { notifications.push(JSON.parse(message ?? "null")); },
    } : undefined);
    expect(result.isError).not.toBe(true);
    if (hasCompletion) {
      expect(result.structuredContent).toEqual({ group: { detail: { right: true } }, items: [2], secret: redacted });
      expect(target.counts()).toEqual({ calls: 0, streams: 1 });
      expect(notifications).toEqual(withProgress ? [
        { group: { detail: { left: true } }, items: [1], secret: redacted },
        { group: { detail: { right: true } }, items: [2] },
      ] : []);
    } else {
      expect(result.structuredContent).toEqual({ atomic: true, absent: true });
      expect(target.counts()).toEqual({ calls: 1, streams: 0 });
      expect(notifications).toEqual([]);
    }
  } finally {
    await target.close();
  }
});

it.skipIf(!hasCompletion)("runs marked native streams without annotations or a progress token", async () => {
  const target = await connect(null, false);
  try {
    const result = await target.client.callTool({ name: moduleId, arguments: {} });
    expect(result.structuredContent).toMatchObject({ items: [2] });
    expect(target.counts()).toEqual({ calls: 0, streams: 1 });
  } finally {
    await target.close();
  }
});

it.skipIf(!hasCompletion).each(["validation", "after"] as const)("rejects failed %s after provisional progress", async (failure) => {
  const target = await connect(failure);
  const notifications: unknown[] = [];
  try {
    const result = await target.client.callTool({ name: moduleId, arguments: {} }, undefined, {
      onprogress: ({ message }) => { notifications.push(JSON.parse(message ?? "null")); },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(notifications).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/wire-secret|private-after-cause/);
    expect(target.counts()).toEqual({ calls: 0, streams: 1 });
  } finally {
    await target.close();
  }
});
