import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Executor, Registry } from "apcore-js";
import { describe, expect, it, vi } from "vitest";
import { buildModuleCommand } from "../src/main.js";

interface FixtureCase {
  id: string;
  args: string[];
  expected: { exit_code: number; calls: number; input?: Record<string, unknown> };
}

const fixture = JSON.parse(readFileSync(
  new URL("../../conformance/fixtures/structured_flags.json", import.meta.url), "utf8",
)) as {
  schema: { type: string; properties: Record<string, Record<string, unknown>>; required: string[] };
  test_cases: FixtureCase[];
};

async function invoke(args: string[], inputSchema = fixture.schema) {
  const moduleId = "test.structured";
  const inputs: Record<string, unknown>[] = [];
  const registry = new Registry();
  await registry.register(moduleId, {
    description: "Accept JSON data from generated command options",
    inputSchema,
    outputSchema: { type: "object" },
    execute(input: Record<string, unknown>) {
      inputs.push(input);
      return {};
    },
  } as never);
  const descriptor = registry.getDefinition(moduleId);
  if (!descriptor) throw new Error("The structured test module is not registered");
  const executor = Executor.fromRegistry(registry);
  const validate = vi.spyOn(executor, "validate");
  const exit = vi.fn();
  const cmd = buildModuleCommand(descriptor, executor, 1000, undefined, undefined, { exit, printResult: false });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await cmd.parseAsync(args, { from: "user" });
    return {
      inputs,
      preflightInputs: validate.mock.calls.map(([, input]) => input),
      exitCode: exit.mock.lastCall?.[0] ?? 0,
      diagnostics: stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
    };
  } finally {
    validate.mockRestore();
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

describe("structured generated flags", () => {
  it.each(fixture.test_cases)("$id", async ({ args, expected }) => {
    const result = await invoke(args);
    expect(result.exitCode).toBe(expected.exit_code);
    expect(result.inputs).toHaveLength(expected.calls);
    if (expected.input) expect(result.inputs[0]).toEqual(expected.input);
  });

  it("passes the decoded values into preflight without running the module", async () => {
    const sample = fixture.test_cases.find(test => test.id === "objects_and_arrays");
    if (!sample?.expected.input) throw new Error("Expected input case missing");
    const result = await invoke(["--dry-run", ...sample.args]);
    expect(result.exitCode).toBe(0);
    expect(result.preflightInputs).toEqual([sample.expected.input]);
    expect(result.inputs).toEqual([]);
  });

  it("rejects malformed structured arguments before preflight is called", async () => {
    const result = await invoke(["--dry-run", "--filters", "{", "--labels", "[]"]);
    expect(result.exitCode).toBe(45);
    expect(result.preflightInputs).toEqual([]);
    expect(result.inputs).toEqual([]);
    expect(result.diagnostics).toContain("--filters");
  });

  it("passes an explicit null for a required nullable field to preflight and execution", async () => {
    const schema = {
      ...fixture.schema,
      required: ["maybe_filters"],
    };
    const args = ["--maybe-filters", "null"];

    const preflight = await invoke(["--dry-run", ...args], schema);
    expect(preflight.exitCode).toBe(0);
    expect(preflight.preflightInputs).toEqual([{ maybe_filters: null }]);
    expect(preflight.inputs).toEqual([]);

    const dispatched = await invoke(args, schema);
    expect(dispatched.exitCode).toBe(0);
    expect(dispatched.inputs).toEqual([{ maybe_filters: null }]);
  });

  it("still requires the nullable field when its value is omitted", async () => {
    const result = await invoke([], { ...fixture.schema, required: ["maybe_filters"] });
    expect(result.exitCode).toBe(45);
    expect(result.inputs).toEqual([]);
    expect(result.diagnostics).toContain("'maybe_filters' is required");
  });

  it("rejects null for a required nonnullable field supplied in a JSON file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "apcore-cli-nonnullable-"));
    const file = join(directory, "input.json");
    try {
      writeFileSync(file, JSON.stringify({ filters: null, labels: [] }));
      const result = await invoke(["--input", file]);
      expect(result.exitCode).toBe(45);
      expect(result.inputs).toEqual([]);
      expect(result.diagnostics).toContain("'filters' does not accept null");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses schema defaults as typed values", async () => {
    const schemaWithDefaults = {
      ...fixture.schema,
      properties: {
        ...fixture.schema.properties,
        filters: { ...fixture.schema.properties.filters, default: { active: true } },
        labels: { ...fixture.schema.properties.labels, default: ["default"] },
      },
    };
    const result = await invoke([], schemaWithDefaults);
    expect(result.exitCode).toBe(0);
    expect(result.inputs).toEqual([{ filters: { active: true }, labels: ["default"] }]);
  });
});
