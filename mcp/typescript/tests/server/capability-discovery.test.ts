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
const inputSchema = {
  type: "object",
  properties: { message: { $ref: "#/$defs/message" } },
  required: ["message"],
  $defs: { message: { type: "string" } },
  additionalProperties: false,
};

it("lists the authorized caller's tools and documentation from the live Core registration", async () => {
  const registry = new Registry();
  const execute = vi.fn(() => ({ ok: true }));
  async function register(documentation: string, schema = inputSchema, version = "1.1.0"): Promise<void> {
    await registry.register(moduleId, {
      description: "A role-scoped module",
      inputSchema: schema,
      outputSchema: { type: "object" },
      annotations: createAnnotations({ readonly: true }),
      execute,
    }, version, { documentation, display: { mcp: { alias } }, versionHint: "1.1.0" });
  }
  await register("Initial documentation");
  await registry.register("example.hidden", {
    description: "Not discoverable",
    inputSchema,
    outputSchema: { type: "object" },
    annotations: createAnnotations({ discoverable: false }),
    execute,
  }, "1.0.0", { documentation: "Hidden documentation" });

  const audit = vi.fn();
  const acl = new ACL([{
    callers: ["@external"], targets: ["example.*"], description: "", effect: "allow",
    conditions: { roles: ["reader"] },
  }], "deny", audit);
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
    expect((await client.listTools()).tools).toMatchObject([{ name: alias, inputSchema }]);
    expect((await client.listResources()).resources).toMatchObject([{ uri: `docs://${moduleId}` }]);
    expect((await client.readResource({ uri: `docs://${moduleId}` })).contents)
      .toMatchObject([{ text: "Initial documentation" }]);
    expect(audit).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    expect(await registry.safeUnregister(moduleId)).toBe(true);
    const replacement = { ...inputSchema, $defs: { message: { type: "string", minLength: 2 } } };
    await register("Replacement documentation", replacement);
    expect((await client.listTools()).tools).toMatchObject([{ name: alias, inputSchema: replacement }]);
    expect((await client.readResource({ uri: `docs://${moduleId}` })).contents)
      .toMatchObject([{ text: "Replacement documentation" }]);
    token = "fixture-observer";
    expect((await client.listTools()).tools).toEqual([]);

    const forbidden = await client.callTool({ name: alias, arguments: { message: "hello" } });
    expect(forbidden.isError).toBe(true);
    token = "fixture-reader";
    const allowed = await client.callTool({ name: alias, arguments: { message: "hello" } });
    expect(allowed.structuredContent).toEqual({ ok: true });
    expect(audit).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);

    expect(await registry.safeUnregister(moduleId)).toBe(true);
    await register("Different registered version", replacement, "2.0.0");
    expect((await client.listTools()).tools).toEqual([]);
  } finally {
    await client.close();
    await app.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
