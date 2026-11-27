import { describe, it, expect, vi, beforeEach } from "vitest";
import { Executor, Registry as CoreRegistry } from "apcore-js";
import { Type } from "@sinclair/typebox";
import request from "supertest";
import { A2AServerFactory } from "../../src/server/factory.js";
import type { Registry } from "../../src/adapters/agent-card.js";

function makeRegistry(): Registry {
  const modules: Record<string, unknown> = {
    "echo": {
      module_id: "echo",
      description: "Echo module",
      input_schema: { type: "object" },
    },
  };
  return {
    list: () => Object.keys(modules),
    getDefinition: (id: string) => (modules[id] as any) ?? null,
    register: vi.fn((id: string, desc: unknown) => {
      modules[id] = desc;
    }),
  };
}

function makeExecutor() {
  return {
    callAsync: vi.fn().mockResolvedValue({ result: "ok" }),
  };
}

const baseOpts = {
  name: "TestAgent",
  description: "A test agent",
  version: "1.0.0",
  url: "http://localhost:3000",
};

describe("A2AServerFactory", () => {
  describe("create", () => {
    it("returns Express app and AgentCard", () => {
      const factory = new A2AServerFactory();
      const { app, agentCard } = factory.create(
        makeRegistry(),
        makeExecutor(),
        baseOpts,
      );

      expect(app).toBeDefined();
      expect(agentCard.name).toBe("TestAgent");
      expect(agentCard.version).toBe("1.0.0");
      expect(agentCard.skills).toHaveLength(1);
    });
  });

  it("persists a real APCore stream timeout and exposes it via GetTask", async () => {
    let release!: () => void;
    const stalled = new Promise<void>((resume) => { release = resume; });
    const registry = new CoreRegistry();
    registry.register("test.stall", {
      description: "Yields an artifact then stalls",
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({ value: Type.String() }),
      execute() { throw new Error("native stream must run"); },
      async *stream() {
        yield { value: "partial" };
        await stalled;
        yield { value: "late" };
      },
    });
    expect(registry.list()).toContain("test.stall");
    const { app } = new A2AServerFactory().create(
      registry as unknown as Registry, new Executor({ registry }), { ...baseOpts, executionTimeout: 0.1 },
    );
    try {
      const streamed = await request(app).post("/").set("A2A-Version", "1.0").send({
        jsonrpc: "2.0", id: 1, method: "SendStreamingMessage",
        params: { message: {
          messageId: "stall", role: "ROLE_USER", parts: [{ data: {} }], metadata: { skillId: "test.stall" },
        } },
      }).timeout({ deadline: 2000 });
      expect(streamed.status).toBe(200);
      const frames = streamed.text.split("\n").filter((line: string) => line.startsWith("data:"))
        .map((line: string) => JSON.parse(line.slice(5)).result);
      const artifacts = frames.flatMap((frame) => frame.artifactUpdate ? [frame.artifactUpdate] : []);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].lastChunk ?? false).toBe(false);
      const statuses = frames.flatMap((frame) => frame.statusUpdate ? [frame.statusUpdate] : []);
      expect(statuses.map((update) => update.status.state)).toEqual(["TASK_STATE_FAILED"]);
      const terminal = statuses[0];
      expect(terminal.status.message.parts[0].text).toBe("Execution timed out");
      const queried = await request(app).post("/").set("A2A-Version", "1.0").send({
        jsonrpc: "2.0", id: 2, method: "GetTask", params: { id: terminal.taskId },
      });
      expect(queried.body.result.status).toEqual(terminal.status);
    } finally {
      release();
    }
  });

  describe("agent card endpoint", () => {
    it("serves the A2A 1.0 primary endpoint /.well-known/agent-card.json", async () => {
      const factory = new A2AServerFactory();
      const { app } = factory.create(makeRegistry(), makeExecutor(), baseOpts);

      const res = await request(app).get("/.well-known/agent-card.json");

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("TestAgent");
      expect(res.body.version).toBe("1.0.0");
    });

    it("serves the A2A 0.3 alias /.well-known/agent.json", async () => {
      const factory = new A2AServerFactory();
      const { app } = factory.create(makeRegistry(), makeExecutor(), baseOpts);

      const res = await request(app).get("/.well-known/agent.json");

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("TestAgent");
    });
  });

  describe("health endpoint", () => {
    it("returns healthy status", async () => {
      const factory = new A2AServerFactory();
      const { app } = factory.create(makeRegistry(), makeExecutor(), baseOpts);

      const res = await request(app).get("/health");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("healthy");
      expect(res.body.moduleCount).toBe(1);
      expect(res.body.version).toBe("1.0.0");
      expect(typeof res.body.uptimeSeconds).toBe("number");
    });
  });

  describe("metrics endpoint", () => {
    it("returns metrics when enabled", async () => {
      const factory = new A2AServerFactory();
      const { app } = factory.create(makeRegistry(), makeExecutor(), {
        ...baseOpts,
        metrics: true,
      });

      const res = await request(app).get("/metrics");

      expect(res.status).toBe(200);
      expect(res.body.activeTasks).toBe(0);
      expect(res.body.completedTasks).toBe(0);
      expect(typeof res.body.uptimeSeconds).toBe("number");
    });

    it("returns 404 when metrics disabled", async () => {
      const factory = new A2AServerFactory();
      const { app } = factory.create(makeRegistry(), makeExecutor(), baseOpts);

      const res = await request(app).get("/metrics");
      expect(res.status).toBe(404);
    });
  });

  describe("registerModule", () => {
    it("calls registry.register and invalidates cache", () => {
      const factory = new A2AServerFactory();
      const registry = makeRegistry();
      factory.create(registry, makeExecutor(), baseOpts);

      factory.registerModule("new-module", {
        module_id: "new-module",
        description: "New",
      });

      expect(registry.register).toHaveBeenCalledWith("new-module", {
        module_id: "new-module",
        description: "New",
      });
    });
  });
});
