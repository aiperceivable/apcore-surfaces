import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Executor, Registry, STREAMING_MARKER, createAnnotations } from "apcore-js";
import { describe, expect, it, vi } from "vitest";
import { build } from "tsup";
import { buildModuleCommand, createCli } from "../src/main.js";
import { AuditLogger, getAuditLogger, setAuditLogger } from "../src/security/audit.js";

const moduleId = "test.completion";
const hasCompletion = "streamWithCompletion" in Executor.prototype;

type Failure = "validation" | "after" | null;

async function setup(entry: "generated" | "generic", failure: Failure = null, exitCodes?: Record<string, number>) {
  let calls = 0;
  let streams = 0;
  const registry = new Registry();
  await registry.register(moduleId, {
    description: "Stream one module invocation",
    annotations: createAnnotations({ streaming: true }),
    [STREAMING_MARKER]: true,
    inputSchema: { type: "object" },
    outputSchema: { type: "object", ...(failure === "validation" ? { required: ["absent"] } : {}) },
    execute: () => { calls++; return { result: "atomic" }; },
    async *stream() { streams++; yield { result: "chunk" }; },
  } as never);
  const executor = Executor.fromRegistry(registry);
  if (failure === "after") executor.useAfter(() => { throw new Error("private-after-cause"); });
  const exit = vi.fn();
  const previousLogger = getAuditLogger();
  const descriptor = registry.getDefinition(moduleId);
  if (!descriptor) throw new Error("The streaming test module is not registered");
  const command = entry === "generated"
    ? buildModuleCommand(descriptor, executor, 1000, undefined, undefined, { exit, exitCodes })
    : createCli({ registry, executor, exit, exitCodes });
  const auditDirectory = mkdtempSync(join(tmpdir(), "apcore-cli-strict-"));
  const auditFile = join(auditDirectory, "audit.jsonl");
  setAuditLogger(new AuditLogger(auditFile));
  let stdoutFlushed = 0;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((_chunk, encoding, callback) => {
    const done = typeof encoding === "function" ? encoding : callback;
    if (done) setImmediate(() => {
      stdoutFlushed++;
      done();
    });
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const prefix = entry === "generic" ? ["apcli", "exec", moduleId] : [];
  return {
    run: (flags: string[]) => command.parseAsync([...prefix, ...flags], { from: "user" }),
    counts: () => ({ calls, streams }), exit,
    stdout: () => stdout.mock.calls.map(([chunk]) => String(chunk)).join(""),
    stdoutFlushed: () => stdoutFlushed,
    stderr: () => stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
    audit: () => readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
    close() {
      setAuditLogger(previousLogger);
      rmSync(auditDirectory, { recursive: true, force: true });
      vi.restoreAllMocks();
    },
  };
}

describe.each(["generated", "generic"] as const)("strict streaming via %s commands", (entry) => {
  it("selects the supported path before execution", async () => {
    const app = await setup(entry);
    try {
      await app.run(["--strict-stream"]);
      if (hasCompletion) {
        expect(app.stdout()).toBe('{"result":"chunk"}\n');
        expect(app.stdoutFlushed()).toBe(1);
        expect(app.exit).not.toHaveBeenCalled();
        expect(app.audit()).toMatchObject([{ status: "success", exit_code: 0 }]);
        expect(app.counts()).toEqual({ calls: 0, streams: 1 });
      } else {
        expect(app.stdout()).toBe("");
        expect(app.stderr()).toMatch(/strict streaming.*requires/i);
        expect(app.exit).toHaveBeenCalledWith(2);
        expect(app.audit()).toMatchObject([{ status: "error", exit_code: 2 }]);
        expect(app.counts()).toEqual({ calls: 0, streams: 0 });
      }
    } finally { app.close(); }
  });

  it.skipIf(!hasCompletion).each([["validation", 45], ["after", 1]] as const)(
    "keeps emitted JSONL and fails the audit on a %s error", async (failure, exitCode) => {
      const app = await setup(entry, failure);
      try {
        await app.run(["--strict-stream"]);
        expect(app.stdout()).toBe('{"result":"chunk"}\n');
        expect(app.stdoutFlushed()).toBe(1);
        expect(app.stderr()).toContain("Streaming");
        expect(app.stderr()).not.toContain("private-after-cause");
        expect(app.exit).toHaveBeenCalledWith(exitCode);
        expect(app.audit()).toMatchObject([{ status: "error", exit_code: exitCode }]);
        expect(app.counts()).toEqual({ calls: 0, streams: 1 });
      } finally { app.close(); }
    },
  );

  it.skipIf(!hasCompletion)("does not apply a host's zero exit code to a strict failure", async () => {
    const app = await setup(entry, "after", { MODULE_EXECUTE_ERROR: 0 });
    try {
      await app.run(["--strict-stream"]);
      expect(app.exit).toHaveBeenCalledWith(1);
      expect(app.audit()).toMatchObject([{ status: "error", exit_code: 1 }]);
    } finally { app.close(); }
  });

  it("rejects sandbox delegation without starting any invocation", async () => {
    const app = await setup(entry);
    try {
      await app.run(["--sandbox", "--strict-stream"]);
      expect(app.stdout()).toBe("");
      expect(app.stderr()).toContain("--sandbox");
      expect(app.exit).toHaveBeenCalledWith(2);
      expect(app.counts()).toEqual({ calls: 0, streams: 0 });
    } finally { app.close(); }
  });
});

it("keeps the legacy stream completion and audit behavior", async () => {
  const app = await setup("generated", "after");
  try {
    await app.run(["--stream"]);
    expect(app.stdout()).toBe('{"result":"chunk"}\n');
    expect(app.exit).not.toHaveBeenCalled();
    expect(app.audit()).toMatchObject([{ status: "success", exit_code: 0 }]);
    expect(app.counts()).toEqual({ calls: 0, streams: 1 });
  } finally { app.close(); }
});

it.skipIf(!hasCompletion)("closes a strict stream and records one failed audit when its pipe closes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "apcore-cli-closed-pipe-"));
  const audit = join(directory, "audit.jsonl");
  const closed = join(directory, "producer-closed");
  const cliBundle = pathToFileURL(join(directory, "cli.mjs")).href;
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  try {
    symlinkSync(join(packageRoot, "node_modules"), join(directory, "node_modules"), "junction");
    await build({
      entry: { cli: join(packageRoot, "src/index.ts") },
      config: false,
      outDir: directory,
      outExtension: () => ({ js: ".mjs" }),
      format: ["esm"],
      dts: false,
      silent: true,
    });
    const fixture = `
      import { writeFileSync } from "node:fs";
      import { Executor, Registry, STREAMING_MARKER, createAnnotations } from "apcore-js";
      const [bundle, audit, closed] = process.argv.slice(1);
      const { AuditLogger, buildModuleCommand, setAuditLogger } = await import(bundle);
      const moduleId = "test.pipe";
      const registry = new Registry();
      await registry.register(moduleId, {
        description: "Write a provisional result",
        annotations: createAnnotations({ streaming: true }),
        [STREAMING_MARKER]: true,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        execute() { return {}; },
        async *stream() {
          try { yield { result: "provisional" }; }
          finally { writeFileSync(closed, "closed"); }
        },
      });
      setAuditLogger(new AuditLogger(audit));
      const cmd = buildModuleCommand(registry.getDefinition(moduleId), Executor.fromRegistry(registry),
        undefined, undefined, undefined, { exit: code => { process.exitCode = code; } });
      await cmd.parseAsync(["--strict-stream"], { from: "user" });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", fixture, cliBundle, audit, closed], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const [code, signal] = await once(child, "close");
    expect(signal).toBeNull();
    expect(code).toBe(1);
    expect(stderr).not.toContain("Unhandled 'error' event");
    expect(JSON.parse(stderr)).toMatchObject({ error: true, exit_code: 1 });
    expect(readFileSync(closed, "utf8")).toBe("closed");
    const entries = readFileSync(audit, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(entries).toMatchObject([{ module_id: "test.pipe", status: "error", exit_code: 1 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);
