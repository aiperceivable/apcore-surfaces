/**
 * D9-002: Config Bus deduplication — regression test.
 *
 * Verifies that both serve() and asyncServe() call Config.load()
 * exactly once each (via loadConfigBusOverrides), not twice.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { Executor, Registry } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mocks — must be defined before vi.mock() hoisting resolves
// ---------------------------------------------------------------------------

vi.mock("../src/server/transport.js", () => ({
  TransportManager: vi.fn(function () { return {
    runStdio: vi.fn().mockResolvedValue(undefined),
    runStreamableHttp: vi.fn().mockResolvedValue(undefined),
    runSse: vi.fn().mockResolvedValue(undefined),
    buildStreamableHttpApp: vi.fn().mockResolvedValue({
      handler: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    setModuleCount: vi.fn(),
    setMetricsCollector: vi.fn(),
    setUsageCollector: vi.fn(),
    setAsyncTaskBridge: vi.fn(),
    setAuthenticator: vi.fn(),
    setRequireAuth: vi.fn(),
    setExemptPaths: vi.fn(),
    setExplorer: vi.fn(),
  }; }),
}));

vi.mock("../src/server/factory.js", () => ({
  MCPServerFactory: vi.fn(function () { return {
    createServer: vi.fn().mockReturnValue({}),
    buildTools: vi.fn().mockReturnValue([]),
    attachAsyncMetaTools: (tools: unknown[]) => tools,
    registerHandlers: vi.fn(),
    registerResourceHandlers: vi.fn(),
  }; }),
}));

const loadConfigSpy = vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(null) });

vi.mock("apcore-js/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("apcore-js/config")>();
  return {
    ...actual,
    Config: {
      registerNamespace: actual.Config.registerNamespace.bind(actual.Config),
      load: (...args: unknown[]) => loadConfigSpy(...args),
    },
  };
});

import { serve, asyncServe } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(): Registry {
  return {
    list: vi.fn().mockReturnValue([]),
    getDefinition: vi.fn().mockReturnValue(null),
    on: vi.fn(),
  };
}

function makeExecutor(registry: Registry): Executor {
  return {
    registry,
    call: vi.fn().mockResolvedValue({ status: "ok" }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("D9-002: Config Bus deduplication", () => {
  beforeEach(() => {
    loadConfigSpy.mockClear();
    loadConfigSpy.mockReturnValue({ get: vi.fn().mockReturnValue(null) });
  });

  it("serve() calls Config.load() exactly once via loadConfigBusOverrides", async () => {
    const registry = makeRegistry();
    const executor = makeExecutor(registry);
    await serve(executor, { transport: "stdio" });
    expect(loadConfigSpy).toHaveBeenCalledTimes(1);
  });

  it("asyncServe() calls Config.load() exactly once via loadConfigBusOverrides", async () => {
    const registry = makeRegistry();
    const executor = makeExecutor(registry);
    const app = await asyncServe(executor, {});
    await app.close();
    expect(loadConfigSpy).toHaveBeenCalledTimes(1);
  });
});

describe("D9-002: Config Bus scalar key reads (transport/host/port)", () => {
  beforeEach(async () => {
    // Reset transport mock state per test.
    const { TransportManager } = await import("../src/server/transport.js");
    (TransportManager as unknown as { mockClear: () => void }).mockClear();
    loadConfigSpy.mockClear();
  });

  it("uses Config Bus mcp.port when caller does not pass port", async () => {
    // Stub Config.get to return port 9000 for mcp.port (matching the audit's
    // canonical example: APCORE_MCP_PORT=9000).
    loadConfigSpy.mockReturnValue({
      get: vi.fn((k: string) => {
        if (k === "mcp.port") return 9000;
        if (k === "mcp.transport") return "streamable-http";
        if (k === "mcp.host") return "0.0.0.0";
        return null;
      }),
    });
    const registry = makeRegistry();
    const executor = makeExecutor(registry);
    await serve(executor, {}); // no transport/host/port passed

    const { TransportManager } = await import("../src/server/transport.js");
    // The mock instance's runStreamableHttp should have been called with the
    // bus-resolved host+port.
    const lastInstance = (TransportManager as unknown as { mock: { results: Array<{ value: { runStreamableHttp: ReturnType<typeof vi.fn> } }> } }).mock.results.at(-1)?.value;
    expect(lastInstance?.runStreamableHttp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ host: "0.0.0.0", port: 9000 }),
    );
  });

  it("caller-supplied port wins over Config Bus mcp.port", async () => {
    loadConfigSpy.mockReturnValue({
      get: vi.fn((k: string) => {
        if (k === "mcp.port") return 9000;
        if (k === "mcp.transport") return "streamable-http";
        return null;
      }),
    });
    const registry = makeRegistry();
    const executor = makeExecutor(registry);
    await serve(executor, { port: 7777 }); // caller wins

    const { TransportManager } = await import("../src/server/transport.js");
    const lastInstance = (TransportManager as unknown as { mock: { results: Array<{ value: { runStreamableHttp: ReturnType<typeof vi.fn> } }> } }).mock.results.at(-1)?.value;
    expect(lastInstance?.runStreamableHttp).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ port: 7777 }),
    );
  });
});

describe("stdio reservation while resolving Config Bus transport", () => {
  it("reserves unspecified bootstrap, then restores before Config-selected HTTP setup", async () => {
    const stdout = process.stdout.write;
    loadConfigSpy.mockImplementationOnce(() => {
      expect(process.stdout.write).not.toBe(stdout);
      return { get: (key: string) => key === "mcp.transport" ? "streamable-http" : null };
    });
    await serve(makeExecutor(makeRegistry()), {
      async: false,
      onStartup: () => { expect(process.stdout.write).toBe(stdout); },
    });
    expect(process.stdout.write).toBe(stdout);
  });
});

describe("MCP project YAML through Core Config.load", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("applies transport, port, and name to the actual startup path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "apcore-mcp-project-config-"));
    try {
      const path = join(directory, "apcore.yaml");
      writeFileSync(path, [
        "apcore:",
        "  version: 1.0.0",
        "  project: {name: test-project}",
        "mcp:",
        "  transport: streamable-http",
        "  port: 9042",
        "  name: yaml-server",
      ].join("\n"));
      vi.stubEnv("APCORE_CONFIG_FILE", path);
      const actual = await vi.importActual<typeof import("apcore-js/config")>("apcore-js/config");
      loadConfigSpy.mockImplementationOnce(() => actual.Config.load(undefined, { validate: false }));

      await serve(makeExecutor(makeRegistry()), { async: false });

      const { TransportManager } = await import("../src/server/transport.js");
      const instances = vi.mocked(TransportManager).mock.results;
      expect(instances.at(-1)?.value.runStreamableHttp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ port: 9042 }),
      );
      const { MCPServerFactory } = await import("../src/server/factory.js");
      expect(vi.mocked(MCPServerFactory).mock.results.at(-1)?.value.createServer)
        .toHaveBeenCalledWith("yaml-server", expect.any(String), expect.anything());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("starts with stdio defaults when no configuration file exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "apcore-mcp-no-config-"));
    try {
      vi.stubEnv("APCORE_CONFIG_FILE", undefined);
      vi.stubEnv("HOME", directory);
      vi.stubEnv("XDG_CONFIG_HOME", directory);
      const actual = await vi.importActual<typeof import("apcore-js/config")>("apcore-js/config");
      const config = actual.Config.load(undefined, { validate: false });
      expect(config.sourcePath).toBeNull();
      loadConfigSpy.mockReturnValueOnce(config);

      await serve(makeExecutor(makeRegistry()), { async: false });

      const { TransportManager } = await import("../src/server/transport.js");
      expect(vi.mocked(TransportManager).mock.results.at(-1)?.value.runStdio)
        .toHaveBeenCalledOnce();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
