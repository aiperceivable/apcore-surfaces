import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ACL, Context, Executor, Registry, createAnnotations } from "apcore-js";
import { AsyncTaskManager, TaskStatus } from "apcore-js/full";
import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import {
  AsyncTaskBridge, asyncServe, createAsyncTaskBridge, elicit, InMemoryApprovalStore, JWTAuthenticator,
  META_TOOL_NAMES, reportProgress,
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

  it("reclaims idle scoped HTTP sessions without cancelling their background work", async () => {
    const moduleId = "sample.slow";
    const backgroundId = "sample.detached";
    let notifyStarted!: () => void;
    let finishCall!: () => void;
    let finishBackground!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const finish = new Promise<void>(resolve => { finishCall = resolve; });
    const background = new Promise<void>(resolve => { finishBackground = resolve; });
    const registry = new Registry();
    await registry.register(moduleId, {
      description: "Wait for a test signal",
      inputSchema: { type: "object" }, outputSchema: { type: "object" },
      execute: async () => { notifyStarted(); await finish; return { ok: true }; },
    });
    await registry.register(backgroundId, {
      description: "Continue after the transport closes",
      inputSchema: { type: "object" }, outputSchema: { type: "object" },
      annotations: createAnnotations({ extra: { mcp_async: "true" } }),
      execute: async (_inputs, context) => {
        await background;
        if (!context) throw new Error("Missing task context");
        await reportProgress(context, 1, 1, "Done");
        expect(await elicit(context, "Continue?", { type: "object", properties: {} })).toBeNull();
        return { continued: true };
      },
    });
    vi.stubEnv("APCORE_MAX_SCOPED_HTTP_SESSIONS", "1");
    const app = await asyncServe(registry as never, {
      async: true, authenticator: auth,
      acl: new ACL([{
        callers: ["@external"], targets: [moduleId, backgroundId], effect: "allow", conditions: { scopes: ["read"] },
      }]),
    });
    const http = createServer(app.handler);
    const first = new Client({ name: "first", version: "1" });
    const next = new Client({ name: "next", version: "1" });
    const returning = new Client({ name: "returning", version: "1" });
    try {
      http.listen(0, "127.0.0.1");
      await once(http, "listening");
      const url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
      const connect = (client: Client, subject: string) => client.connect(new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${token({ sub: subject })}` } },
      }));
      await connect(first, "first-account");
      const active = first.callTool({ name: moduleId, arguments: {} });
      try {
        await Promise.race([started, active.then(() => { throw new Error("Tool completed unexpectedly"); })]);
        const rejected = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token({ sub: "next-account" })}`,
            Accept: "application/json, text/event-stream", "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "next", version: "1" } },
          }),
        });
        expect(rejected.status).toBe(503);
        await rejected.text();
      } finally {
        finishCall();
        await active;
      }
      const submission = await first.callTool({ name: backgroundId, arguments: {} }, undefined, { onprogress: vi.fn() });
      const text = (result: { content?: unknown }) => JSON.parse((result.content as { text: string }[])[0].text);
      const task = text(submission);
      expect(task).toMatchObject({ task_id: expect.any(String), status: "pending" });
      const status = (client: Client) => client.callTool({
        name: META_TOOL_NAMES.STATUS, arguments: { task_id: task.task_id },
      });
      await connect(next, "next-account");
      expect((await next.listTools()).tools.map(tool => tool.name)).toContain(moduleId);
      await expect(first.listTools()).rejects.toThrow("Session not found");
      expect(text(await status(next))).toMatchObject({ error: "ASYNC_TASK_NOT_FOUND" });
      await connect(returning, "first-account");
      expect(text(await status(returning))).toMatchObject({ status: "running" });
      finishBackground();
      await expect.poll(async () => text(await status(returning))).toMatchObject({
        status: "completed", result: { continued: true },
      });
    } finally {
      finishBackground();
      vi.unstubAllEnvs();
      await first.close();
      await next.close();
      await returning.close();
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

  it.each([false, true])("keeps scoped ownership private until publication succeeds (store failure %s)", async (fail) => {
    const scopedId = "sample.scoped";
    const legacyId = "sample.legacy";
    const registry = new Registry();
    for (const moduleId of [scopedId, legacyId]) {
      await registry.register(moduleId, {
        description: "Produce a task result",
        inputSchema: { type: "object" }, outputSchema: { type: "object" }, execute: () => ({}),
      });
    }
    const executor = new Executor({ registry, acl: new ACL([
      { callers: ["@external"], targets: [scopedId], effect: "allow", conditions: { scopes: ["write"] } },
      { callers: ["@external"], targets: [legacyId], effect: "allow" },
    ]) });
    let notifyAllocating!: () => void;
    let allowWriteStart!: () => void;
    let notifyStored!: () => void;
    let allowWriteReturn!: () => void;
    const allocating = new Promise<void>(resolve => { notifyAllocating = resolve; });
    const allowStore = new Promise<void>(resolve => { allowWriteStart = resolve; });
    const stored = new Promise<void>(resolve => { notifyStored = resolve; });
    const release = new Promise<void>(resolve => { allowWriteReturn = resolve; });
    const manager = new AsyncTaskManager({ executor });
    const save = manager.store.save.bind(manager.store);
    vi.spyOn(manager.store, "save").mockImplementation(async task => {
      const scopedPending = task.moduleId === scopedId && task.status === TaskStatus.PENDING;
      if (scopedPending) {
        notifyAllocating();
        await allowStore;
      }
      await save(task);
      if (scopedPending) {
        notifyStored();
        await release;
        if (fail) throw new Error("write acknowledged unsuccessfully");
      }
    });
    const bridge = new AsyncTaskBridge(manager, { executor, scopedTasks: true });
    const observer = new AsyncTaskBridge(manager, { executor, scopedTasks: true });
    const aliased = new AsyncTaskBridge(new AsyncTaskManager({ executor, store: manager.store }), {
      executor, scopedTasks: true,
    });
    const owner = Context.create(await auth.authenticate({ authorization: `Bearer ${token()}` }));
    const legacy = Context.create();
    const { task_id: legacyTask } = await bridge.submit(legacyId, {}, legacy);
    const scoped = bridge.submit(scopedId, {}, owner);
    let secondLegacy: ReturnType<typeof bridge.submit> | undefined;
    try {
      await expect(aliased.submit(scopedId, {}, owner)).rejects.toThrow("unavailable to this authority");
      await Promise.race([allocating, scoped.then(() => { throw new Error("Task unexpectedly published"); })]);
      secondLegacy = bridge.submit(legacyId, {}, legacy);
      // Let the other submission collect any stale owners before the store write.
      await new Promise<void>(resolve => { setImmediate(resolve); });
      allowWriteStart();
      await Promise.race([stored, scoped.then(() => { throw new Error("Task unexpectedly published"); })]);
      const list = (context: Context, via = observer) => via.handleMetaTool(META_TOOL_NAMES.LIST, {}, context);
      expect(await list(legacy)).toEqual({ tasks: [expect.objectContaining({ task_id: legacyTask })] });
      expect(await list(owner)).toEqual({ tasks: [] });
      allowWriteReturn();
      if (fail) {
        await expect(scoped).rejects.toThrow("write acknowledged unsuccessfully");
        expect(await list(owner)).toEqual({ tasks: [] });
      } else {
        const task = await scoped;
        expect(await list(owner)).toEqual({ tasks: [expect.objectContaining({ task_id: task.task_id })] });
      }
      const second = await secondLegacy;
      expect(await list(legacy)).toEqual({ tasks: [
        expect.objectContaining({ task_id: legacyTask }), expect.objectContaining({ task_id: second.task_id }),
      ] });
      expect(await list(legacy, aliased)).toEqual(await list(legacy));
    } finally {
      allowWriteStart();
      allowWriteReturn();
      await Promise.allSettled([scoped, secondLegacy]);
      await manager.shutdown();
    }
  });
});
