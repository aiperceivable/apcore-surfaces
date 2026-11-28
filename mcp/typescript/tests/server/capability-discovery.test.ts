import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ACL, createAnnotations, createIdentity, Executor, Registry } from "apcore-js";
import { expect, it, vi } from "vitest";

import { asyncServe } from "../../src/index.js";

const moduleId = "example.limited";
const alias = "reader_example";
const argumentDependentId = "example.argument_dependent";
const approvalId = "example.review";
const hiddenId = "example.hidden";
const inputSchema = {
  type: "object",
  properties: { message: { $ref: "#/$defs/message" } },
  required: ["message"],
  $defs: { message: { type: "string" } },
  additionalProperties: false,
};
const approvalInputSchema = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
};

it("lists the authorized caller's tools and documentation from the live Core registration", async () => {
  const registry = new Registry();
  const execute = vi.fn<() => Record<string, unknown>>(() => ({ ok: true }));
  const originalOutput = {
    type: "object", properties: { ok: { type: "boolean" } },
    required: ["ok"], additionalProperties: false,
  };
  async function register(
    documentation: string, schema = inputSchema, version = "1.1.0",
    outputSchema: Record<string, unknown> = originalOutput,
  ): Promise<void> {
    await registry.register(moduleId, {
      description: "A role-scoped module",
      inputSchema: schema,
      outputSchema,
      annotations: createAnnotations({ readonly: true }),
      execute,
    }, version, { documentation, display: { mcp: { alias } }, versionHint: "1.1.0" });
  }
  await register("Initial documentation");
  await registry.register(hiddenId, {
    description: "Not discoverable",
    inputSchema,
    outputSchema: { type: "object" },
    annotations: createAnnotations({ discoverable: false }),
    execute,
  }, "1.0.0", { documentation: "Hidden documentation" });
  await registry.register(argumentDependentId, {
    description: "A module with an argument-dependent denial",
    inputSchema,
    outputSchema: originalOutput,
    execute,
  }, "1.0.0", { documentation: "Argument-dependent documentation" });
  await registry.register(approvalId, {
    description: "A module requiring approval",
    inputSchema: approvalInputSchema,
    outputSchema: originalOutput,
    annotations: createAnnotations({ requiresApproval: true }),
    execute,
  });

  const audit = vi.fn();
  const acl = new ACL([
    {
      callers: ["@external"], targets: [argumentDependentId], description: "", effect: "deny",
      conditions: { arguments: { has_key: ["message"] } },
    },
    {
      callers: ["@external"], targets: ["example.*"], description: "", effect: "allow",
      conditions: { roles: ["reader"] },
    },
  ], "deny", audit);
  const executor = new Executor({ registry, acl });
  const reader = createIdentity("reader", "user", ["reader"]);
  const observer = createIdentity("observer", "user", ["observer"]);
  const app = await asyncServe(executor as never, {
    async: false,
    authenticator: {
      authenticate: async (headers): Promise<typeof reader | null> => {
        if (headers.authorization === "Bearer fixture-reader") return reader;
        if (headers.authorization === "Bearer fixture-observer") return observer;
        return null;
      },
    },
  });
  const server = createServer(app.handler);
  const client = new Client({ name: "capability-discovery", version: "1" });
  let token = "fixture-observer";
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    await client.connect(new StreamableHTTPClientTransport(url, {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        return fetch(input, { ...init, headers });
      },
    }));

    expect((await client.listTools()).tools).toEqual([]);
    expect((await client.listResources()).resources).toEqual([]);
    await expect(client.readResource({ uri: `docs://${moduleId}` })).rejects.toThrow(/resource not found/i);
    token = "fixture-reader";
    const approvalTool = { name: approvalId, inputSchema: approvalInputSchema, _meta: { requiresApproval: true } };
    expect((await client.listTools()).tools).toMatchObject([{ name: alias, inputSchema }, approvalTool]);
    expect((await client.listResources()).resources).toMatchObject([{ uri: `docs://${moduleId}` }]);
    expect((await client.readResource({ uri: `docs://${moduleId}` })).contents)
      .toMatchObject([{ text: "Initial documentation" }]);
    for (const id of [argumentDependentId, hiddenId]) {
      await expect(client.readResource({ uri: `docs://${id}` })).rejects.toThrow(/resource not found/i);
    }
    expect(audit).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    expect(await registry.safeUnregister(moduleId)).toBe(true);
    const replacement = { ...inputSchema, $defs: { message: { type: "string", minLength: 2 } } };
    const liveOutput = {
      type: "object",
      properties: {
        headline: { type: "string" },
        memo: { type: "string", "x-sensitive": true },
        comment: { type: "string", "x-sensitive": true },
      },
      required: ["headline", "memo"],
      additionalProperties: false,
    };
    execute.mockReturnValue({ headline: "reviewed", memo: "fixture-private-memo", comment: "fixture-private-comment" });
    await register("Replacement documentation", replacement, "1.1.0", liveOutput);
    expect((await client.listTools()).tools).toMatchObject([
      { name: alias, inputSchema: replacement, outputSchema: liveOutput },
      approvalTool,
    ]);
    expect((await client.readResource({ uri: `docs://${moduleId}` })).contents)
      .toMatchObject([{ text: "Replacement documentation" }]);
    token = "fixture-observer";
    expect((await client.listTools()).tools).toEqual([]);

    const forbidden = await client.callTool({ name: alias, arguments: { message: "hello" } });
    expect(forbidden.isError).toBe(true);
    token = "fixture-reader";
    const allowed = await client.callTool({ name: alias, arguments: { message: "hello" } });
    const redacted = { headline: "reviewed", memo: "***REDACTED***", comment: "***REDACTED***" };
    expect(allowed.isError).not.toBe(true);
    expect(allowed.structuredContent).toEqual(redacted);
    expect(allowed.content).toMatchObject([{ type: "text", text: JSON.stringify(redacted) }]);
    expect(JSON.stringify(allowed)).not.toContain("fixture-private-");
    expect(audit).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);

    const needsApproval = await client.callTool({ name: approvalId, arguments: { message: "hello" } });
    expect(needsApproval.isError).toBe(true);
    expect(needsApproval.content).toMatchObject([{ type: "text", text: expect.stringMatching(/approval/i) }]);
    const conditional = await client.callTool({ name: argumentDependentId, arguments: { message: "hello" } });
    expect(conditional.isError).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);

    expect(await registry.safeUnregister(moduleId)).toBe(true);
    await register("Different registered version", replacement, "2.0.0");
    expect((await client.listTools()).tools).toMatchObject([approvalTool]);
  } finally {
    await client.close();
    await app.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
