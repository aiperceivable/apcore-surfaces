import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ACL, Context, Executor, Registry, createAnnotations } from "apcore-js";
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import {
  asyncServe, createAsyncTaskBridge, InMemoryApprovalStore, JWTAuthenticator, META_TOOL_NAMES,
} from "../../src/index.js";

const key = "signed-test-secret";
const issuer = "https://issuer.example";
const audience = "mcp-test";

function token(claims: Record<string, unknown> = {}, secret = key): string {
  const payload = {
    iss: issuer, aud: audience, sub: "account", exp: Math.floor(Date.now() / 1000) + 300,
    scope: "read write", roles: ["account-role"],
    act: { sub: "actor", actorRoles: ["runner"], act: { sub: "history", actorRoles: ["admin"] } },
    ...claims,
  };
  return jwt.sign(Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)), secret);
}

const auth = new JWTAuthenticator({
  key, issuer, audience, requireAuth: false,
  delegatedClaims: { scpClaim: "scp", actorRolesClaim: "actorRoles" },
  claimMapping: { attrs: ["act"] },
});

describe("delegated MCP JWT", () => {
  it("projects only the verified current actor and normalized current scopes", async () => {
    const identity = await auth.authenticate({ authorization: `Bearer ${token({ scp: ["write", "read", "read"] })}` });
    expect(identity?.id).toBe("actor");
    expect(identity?.roles).toEqual(["runner"]);
    expect(identity?.scopes).toEqual(["read", "write"]);
    expect(identity?.delegationDepth).toBe(1);
    expect(identity?.rootSubject.id).toBe("account");
    expect(identity?.rootSubject.roles).toEqual(["account-role"]);
    expect(identity?.rootSubject.attrs).toEqual({});
  });

  it("rejects invalid signatures, missing authority, malformed chains and conflicting scope sources", async () => {
    const now = Math.floor(Date.now() / 1000);
    const actorHistory = Array.from({ length: 9 }).reduce<unknown>(
      (next, _, index) => ({ sub: `actor-${index}`, ...(next ? { act: next } : {}) }), undefined,
    );
    const candidates = [
      token({}, "incorrect"), token({ iss: "untrusted" }), token({ aud: "other" }),
      token({ exp: now - 60 }), token({ exp: undefined }), token({ nbf: now + 120 }),
      token({ iat: now + 120 }), token({ scope: "read", scp: ["write"] }),
      token({ scope: undefined }), token({ scope: "read\n" }),
      token({ act: { sub: "actor", act: null } }), token({ act: actorHistory }),
    ];
    for (const signed of candidates) {
      expect(await auth.authenticate({ authorization: `Bearer ${signed}` })).toBeNull();
    }
    const empty = await auth.authenticate({ authorization: `Bearer ${token({ scope: undefined, scp: [] })}` });
    expect(empty?.scopes).toEqual([]);
  });

  it("requires a signed algorithm and verification key in delegated mode", () => {
    expect(() => new JWTAuthenticator({ key, issuer, audience, delegatedClaims: {}, algorithms: ["none"] }))
      .toThrow("signed algorithms");
    expect(() => new JWTAuthenticator({ issuer, audience, delegatedClaims: {} })).toThrow("verification key");
  });

  it("enforces signed ownership on the HTTP session and authority on polling and atomic resumption", async () => {
    const moduleId = "sample.review";
    const registry = new Registry();
    await registry.register(moduleId, {
      description: "Approve an example",
      annotations: createAnnotations({ requiresApproval: true }),
      inputSchema: { type: "object" }, outputSchema: { type: "object" },
      execute: () => ({ approved: true }),
    });
    const store = new InMemoryApprovalStore();
    const app = await asyncServe(registry as never, {
      async: false, approvalStore: store, authenticator: auth,
      acl: new ACL([{ callers: ["@external"], targets: [moduleId], effect: "allow", conditions: { scopes: ["read"] } }]),
    });
    const http = createServer(app.handler);
    const client = new Client({ name: "mcp-delegation", version: "1" });
    const narrowed = new Client({ name: "mcp-narrowed", version: "1" });
    let credential = token();
    try {
      http.listen(0, "127.0.0.1");
      await once(http, "listening");
      const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
      await client.connect(new StreamableHTTPClientTransport(url, {
        fetch: (input, options) => {
          const headers = new Headers(options?.headers);
          headers.set("Authorization", `Bearer ${credential}`);
          return fetch(input, { ...options, headers });
        },
      }));
      const pending = await client.callTool({ name: moduleId, arguments: {} });
      const approval = (pending._meta?.apcore as { approval: { approvalId: string; resumeToken: string } }).approval;
      const resume = (session = client) => session.callTool({ name: moduleId, arguments: {}, _meta: { approvalId: approval.resumeToken } });

      expect(await store.resolve(approval.approvalId, { approved: true })).toBe(true);
      credential = token({ scope: "read" });
      await expect(client.listTools()).rejects.toThrow("Session not found");
      await narrowed.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${credential}` } },
      }));
      const poll = await narrowed.callTool({ name: "__apcore_approval_check", arguments: { approval_id: approval.approvalId } });
      expect(JSON.parse((poll.content as { text: string }[])[0].text).status).toBe("rejected");
      expect((await resume(narrowed)).isError).toBe(true);

      credential = token({ sub: "other-account" });
      await expect(client.listTools()).rejects.toThrow("Session not found");
      credential = token({}, "incorrect");
      await expect(client.listTools()).rejects.toThrow("Unauthorized");
      credential = token();
      expect((await resume()).structuredContent).toEqual({ approved: true });
      expect((await resume()).isError).toBe(true);
    } finally {
      await client.close();
      await narrowed.close();
      await app.close();
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  });

  it("rechecks current scoped permission on tasks across sessions", async () => {
    const moduleId = "sample.background";
    const registry = new Registry();
    await registry.register(moduleId, {
      description: "Produce a governed result",
      inputSchema: { type: "object" }, outputSchema: { type: "object" },
      execute: () => ({ privateResult: 42 }),
    });
    const executor = new Executor({ registry, acl: new ACL([
      { callers: ["@external"], targets: [moduleId], effect: "allow", conditions: { scopes: ["write"] } },
    ]) });
    const bridge = (await createAsyncTaskBridge(executor))!;
    const current = async (claims = {}) => Context.create(await auth.authenticate({ authorization: `Bearer ${token(claims)}` }));
    try {
      const owner = await current();
      const { task_id: taskId } = await bridge.submit(moduleId, {}, owner);
      const read = (context: Context) => bridge.handleMetaTool(META_TOOL_NAMES.STATUS, { task_id: taskId }, context);
      await expect.poll(() => read(owner)).toMatchObject({ status: "completed", result: { privateResult: 42 } });
      expect(await read(await current())).toMatchObject({ status: "completed" });
      for (const identity of [Context.create(), await current({ scope: "read" }), await current({ sub: "other" })]) {
        expect(await read(identity)).toMatchObject({ error: "ASYNC_TASK_NOT_FOUND" });
        expect(await bridge.handleMetaTool(META_TOOL_NAMES.CANCEL, { task_id: taskId }, identity))
          .toMatchObject({ error: "ASYNC_TASK_NOT_FOUND" });
        expect(await bridge.handleMetaTool(META_TOOL_NAMES.LIST, {}, identity)).toEqual({ tasks: [] });
      }
    } finally {
      await bridge.manager.shutdown?.();
    }
  });
});
