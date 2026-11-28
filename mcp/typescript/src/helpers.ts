/**
 * MCP extension helpers for apcore modules.
 *
 * Provides reportProgress() and elicit() that modules can call during execute().
 * Both read callbacks injected into context.data by the ExecutionRouter.
 * Gracefully no-op when callbacks are absent (non-MCP execution paths).
 */

/** Structural type for any object carrying a `data` dict (duck-typed Context). */
interface HasData {
  data: Record<string, unknown>;
}

/** Key under context.data where the progress callback is stored. */
export const MCP_PROGRESS_KEY = "_mcp_progress";

/** Key under context.data where the elicitation callback is stored. */
export const MCP_ELICIT_KEY = "_mcp_elicit";

/** Result returned from an elicitation request. */
export interface ElicitResult {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/**
 * Report execution progress to the MCP client.
 *
 * No-ops silently when called outside an MCP context (no callback injected).
 *
 * @param context - Object with a `data` dict (an apcore Context)
 * @param progress - Current progress value
 * @param total - Optional total for percentage calculation
 * @param message - Optional human-readable progress message
 */
export async function reportProgress(
  context: HasData,
  progress: number,
  total?: number,
  message?: string,
): Promise<void> {
  const callback = context.data[MCP_PROGRESS_KEY] as
    | ((progress: number, total?: number, message?: string) => Promise<void>)
    | undefined;
  if (callback) {
    await callback(progress, total, message);
  }
}

/**
 * Ask the MCP client for user input via the elicitation protocol.
 *
 * Returns null when called outside an MCP context (no callback injected).
 *
 * @param context - Object with a `data` dict (an apcore Context)
 * @param message - Message to display to the user
 * @param requestedSchema - Optional JSON Schema describing the expected input
 * @returns ElicitResult with the user's action and optional content, or null
 */
export async function elicit(
  context: HasData,
  message: string,
  requestedSchema?: Record<string, unknown>,
): Promise<ElicitResult | null> {
  const callback = context.data[MCP_ELICIT_KEY] as
    | ((message: string, requestedSchema?: Record<string, unknown>) => Promise<ElicitResult | null>)
    | undefined;
  if (callback) {
    return callback(message, requestedSchema);
  }
  return null;
}

type CoreElicitationReply =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" | "cancel" };

interface InteractionBindings<T> {
  withProgressReporter?(reporter: (progress: number, total?: number, message?: string) => Promise<void>): T & InteractionBindings<T>;
  withElicitationHandler?(handler: (message: string, schema?: Record<string, unknown>) => Promise<CoreElicitationReply>): T & InteractionBindings<T>;
}

/** @internal Install Core's interaction slots when present through the same detachable callback data. */
export function withCoreInteractions<T extends HasData>(context: T): T {
  const legacy = { data: context.data };
  let bound = context as T & InteractionBindings<T>;
  if (typeof bound.withProgressReporter === "function" && typeof legacy.data[MCP_PROGRESS_KEY] === "function") {
    bound = bound.withProgressReporter((progress, total, message) => reportProgress(legacy, progress, total, message));
  }
  if (typeof bound.withElicitationHandler === "function" && typeof legacy.data[MCP_ELICIT_KEY] === "function") {
    bound = bound.withElicitationHandler(async (message, schema) => {
      const result = await elicit(legacy, message, schema);
      // A detached session can no longer interact. Native Core represents it as a cancelled request.
      if (result === null || result.action === "cancel") return { action: "cancel" };
      if (result.action === "decline") return { action: "decline" };
      if (result.action === "accept" && result.content !== undefined) return { action: "accept", content: result.content };
      throw new Error("MCP elicitation did not return accepted content");
    });
  }
  return bound;
}
