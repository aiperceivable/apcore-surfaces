import { ErrorCodes } from "apcore-js";
import { buildCliContext } from "./acl-loader.js";
import type { Executor } from "./cli.js";
import { InvalidCliInputError, ModuleExecutionError, SchemaValidationError } from "./errors.js";
import { getAuditLogger } from "./security/audit.js";

interface StepOutcome {
  readonly status: string;
  readonly reason?: string;
}

interface StreamCompletion {
  readonly reason: string;
  readonly output: Record<string, unknown> | null;
  readonly outputValidation: StepOutcome;
  readonly middlewareAfter: StepOutcome;
  readonly errorCode: string | null;
}

export interface StreamExecution {
  readonly chunks: AsyncIterable<unknown>;
  readonly completion: Promise<StreamCompletion>;
  close(): Promise<void>;
}

const coreErrorCodes: ReadonlySet<string> = new Set(Object.values(ErrorCodes));

export function validateStrictStreamOptions(
  executor: Executor,
  sandbox: boolean,
  trace: boolean,
  strategy?: string,
): void {
  if (sandbox || trace || strategy) {
    throw new InvalidCliInputError("--strict-stream cannot be combined with --sandbox, --trace, or --strategy.");
  }
  if (typeof executor.streamWithCompletion !== "function") {
    throw new InvalidCliInputError("Strict streaming requires an Executor with stream completion support.");
  }
}

function stepSucceeded(step: StepOutcome): boolean {
  return step.status === "passed" || (step.status === "skipped" &&
    (step.reason === "not_configured" || step.reason === "no_match" || step.reason === "strategy_skipped"));
}

function completionError(receipt: StreamCompletion): Error | null {
  if (receipt.reason === "completed" && receipt.output !== null &&
      stepSucceeded(receipt.outputValidation) && stepSucceeded(receipt.middlewareAfter)) return null;
  if (receipt.errorCode !== null && coreErrorCodes.has(receipt.errorCode)) {
    return Object.assign(new Error("Streaming invocation did not complete successfully"), { code: receipt.errorCode });
  }
  if (receipt.reason === "completed" && !stepSucceeded(receipt.outputValidation)) {
    return new SchemaValidationError("Streaming output validation did not complete successfully");
  }
  return new ModuleExecutionError("Streaming invocation did not complete successfully");
}

export async function executeStrictStream(
  executor: Executor,
  moduleId: string,
  input: Record<string, unknown>,
  startTime: number,
): Promise<void> {
  const stream = executor.streamWithCompletion?.(moduleId, input, buildCliContext());
  if (!stream) {
    throw new InvalidCliInputError("Strict streaming requires an Executor with stream completion support.");
  }
  let writeOrIterationFailed = false;
  const stdout = process.stdout;
  // A failed write also emits an error event. Keep it from interrupting
  // receipt handling, cleanup, and auditing after the callback rejects.
  const onOutputError = (): void => { writeOrIterationFailed = true; };
  stdout.on("error", onOutputError);
  try {
    for await (const chunk of stream.chunks) {
      const line = JSON.stringify(chunk) + "\n";
      // The failure path can exit the process immediately. Flush each line
      // before advancing so already-emitted JSONL survives a piped exit.
      await new Promise<void>((resolve, reject) => {
        stdout.write(line, error => error ? reject(error) : resolve());
      });
    }
  } catch {
    writeOrIterationFailed = true;
    // The receipt keeps the canonical failure without exposing the iterator's
    // exception details. Close also stops the invocation if output failed.
    await stream.close();
  } finally {
    stdout.off("error", onOutputError);
  }
  const failure = completionError(await stream.completion);
  if (failure) throw failure;
  if (writeOrIterationFailed) throw new ModuleExecutionError("Streaming output failed");
  getAuditLogger()?.logExecution(moduleId, input, "success", 0, Math.round(performance.now() - startTime));
}
