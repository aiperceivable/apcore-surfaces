import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ACL, createIdentity, Executor, Registry } from "apcore-js";
import { expect, it } from "vitest";
import { MCPArtifactStore, asyncServe } from "../../src/index.js";

it("appends a guarded link and serves its data only to the owning authority", async () => {
  const owner = createIdentity("owner", "agent", ["renderer"], {}, { issuer: "fixture" });
  const guest = createIdentity("guest", "agent", ["renderer"], {}, { issuer: "fixture" });
  const store = new MCPArtifactStore({ maxBytes: 100 });
  const key = store.put(Buffer.from("preview"), { name: "preview.png", mimeType: "image/png", owner });

  const moduleId = "media.preview";
  const registry = new Registry();
  await registry.register(moduleId, {
    description: "Return a preview",
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: { artifact: { type: "string", "x-mcp-artifact": true } },
      required: ["artifact"],
    },
    execute: () => ({ artifact: key }),
  });
  const acl = new ACL([{
    callers: ["@external"], targets: [moduleId], effect: "allow", description: "",
    conditions: { roles: ["renderer"] },
  }], "deny");
  const app = await asyncServe(new Executor({ registry, acl }) as never, {
    async: false,
    artifactStore: store,
    authenticator: {
      async authenticate(headers) {
        if (headers.authorization === "Bearer owner") return owner;
        if (headers.authorization === "Bearer guest") return guest;
        return null;
      },
    },
  });
  const server = createServer(app.handler);
  const reader = new Client({ name: "artifact-fixture", version: "1" });
  let authorization = "Bearer owner";
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    await reader.connect(new StreamableHTTPClientTransport(url, {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", authorization);
        return fetch(input, { ...init, headers });
      },
    }));

    const uri = "apcore-artifact://" + key;
    const result = await reader.callTool({ name: moduleId, arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ artifact: key });
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ artifact: key }) },
      { type: "resource_link", uri, name: "preview.png", mimeType: "image/png", size: 7 },
    ]);
    expect((await reader.readResource({ uri })).contents).toEqual([
      { uri, blob: Buffer.from("preview").toString("base64"), mimeType: "image/png" },
    ]);
    authorization = "Bearer guest";
    expect((await reader.callTool({ name: moduleId, arguments: {} })).content).toEqual([
      { type: "text", text: JSON.stringify({ artifact: key }) },
    ]);
    await expect(reader.readResource({ uri })).rejects.toThrow(/artifact not found/i);
  } finally {
    await reader.close();
    await app.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
