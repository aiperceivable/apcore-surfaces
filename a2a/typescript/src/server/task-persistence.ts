import { AsyncLocalStorage } from "node:async_hooks";
import { TaskState } from "@a2a-js/sdk";
import type {
  AgentCard, CancelTaskRequest, Message, SendMessageRequest, StreamResponse, Task, TaskStatus,
} from "@a2a-js/sdk";
import { RequestMalformedError, TaskNotFoundError } from "@a2a-js/sdk/errors";
import { DefaultRequestHandler, resolveUserScope } from "@a2a-js/sdk/server";
import type {
  AgentExecutionEvent, AgentExecutor, ExecutionEventBus, ExtendedAgentCardProvider, RequestContext, ServerCallContext, TaskStore,
} from "@a2a-js/sdk/server";
import type { Identity } from "apcore-js";
import { identityOf, scopedOwner, TASK_OWNER_KEY, TASK_SKILL_KEY } from "./context.js";

const TERMINAL_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

function isTerminal(state: TaskState | undefined): boolean {
  return state !== undefined && TERMINAL_STATES.has(state);
}

interface TerminalClaim {
  readonly context: ServerCallContext;
  readonly contextId: string;
  readonly status: TaskStatus;
  writes: number;
}

function taskKey(taskId: string, context: ServerCallContext): string {
  return JSON.stringify([context.tenant ?? null, resolveUserScope(context), taskId]);
}

/** Bridge the gap between emitting a terminal status and committing it to storage. */
class TaskPersistence implements TaskStore {
  private readonly cancelRequests = new AsyncLocalStorage<string>();
  private readonly terminalClaims = new Map<string, TerminalClaim>();
  private readonly claimKeys = new WeakMap<ServerCallContext, Set<string>>();
  private readonly abandoned = new WeakSet<ServerCallContext>();
  private readonly watches = new WeakMap<ExecutionEventBus, () => void>();

  constructor(
    private readonly store: TaskStore,
    private readonly canUseScopedSkill?: (skillId: string, identity: Identity) => boolean,
  ) {}

  private canRead(task: Task, context: ServerCallContext): boolean {
    const identity = identityOf(context);
    const owner = scopedOwner(identity);
    if ((task.metadata?.[TASK_OWNER_KEY] ?? null) !== owner) return false;
    if (owner === null) return true;
    const skill = task.metadata?.[TASK_SKILL_KEY];
    return identity !== null && typeof skill === "string" && this.canUseScopedSkill?.(skill, identity) === true;
  }

  cancel<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    return this.cancelRequests.run(taskId, run);
  }

  observe(request: RequestContext, bus: ExecutionEventBus): void {
    const { taskId, context } = request;
    this.watches.get(bus)?.();
    const release = () => {
      bus.off("event", onEvent);
      bus.off("finished", release);
      this.watches.delete(bus);
    };
    const onEvent = (event: AgentExecutionEvent): void => {
      const update = event.kind === "statusUpdate" ? event.data : undefined;
      const status = update?.status;
      if (update?.taskId !== taskId || !status || !TERMINAL_STATES.has(status.state)) return;
      release();
      if (this.abandoned.has(context)) return;
      const key = taskKey(taskId, context);
      if (this.terminalClaims.has(key)) return;
      this.terminalClaims.set(key, { context, contextId: update.contextId, status, writes: 0 });
      const keys = this.claimKeys.get(context) ?? new Set<string>();
      keys.add(key);
      this.claimKeys.set(context, keys);
    };
    this.watches.set(bus, release);
    bus.on("event", onEvent);
    bus.on("finished", release);
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    let task: Task | undefined;
    try {
      task = await this.store.load(taskId, context);
    } catch (error) {
      this.abandon(context);
      throw error;
    }
    if (task && !this.canRead(task, context)) return undefined;
    if (!task || this.cancelRequests.getStore() !== taskId || isTerminal(task.status?.state)) {
      return task;
    }
    const claim = this.terminalClaims.get(taskKey(taskId, context));
    // Only an already-authorized task may resolve to a pending terminal outcome.
    if (!claim || claim.contextId !== task.contextId) return task;
    const status = structuredClone(claim.status);
    const history = status.message && !task.history?.some(message => message.messageId === status.message?.messageId)
      ? [...(task.history ?? []), status.message]
      : task.history;
    return { ...task, status, history };
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const key = taskKey(task.id, context);
    const state = task.status?.state;
    let persisting: TerminalClaim | undefined;
    try {
      if (this.cancelRequests.getStore() === task.id && state === TaskState.TASK_STATE_CANCELED) {
        // The SDK can reach its direct-write fallback with a stale Store snapshot.
        const current = await this.store.load(task.id, context);
        if (!current || !this.canRead(current, context) || isTerminal(current.status?.state)) return;
        const claim = this.terminalClaims.get(key);
        if (claim?.contextId === task.contextId && claim.status.state !== state) return;
      }

      const claim = this.terminalClaims.get(key);
      if (claim?.contextId === task.contextId && claim.status.state === state) {
        persisting = claim;
        persisting.writes++;
      }
      await this.store.save(task, context);
    } catch (error) {
      this.abandon(context);
      throw error;
    } finally {
      if (persisting) {
        persisting.writes--;
        if (persisting.writes === 0 && this.terminalClaims.get(key) === persisting) {
          this.terminalClaims.delete(key);
        }
      }
    }
  }

  async list(...args: Parameters<TaskStore["list"]>): ReturnType<TaskStore["list"]> {
    const [, context] = args;
    const page = await this.store.list(...args);
    const tasks = page.tasks.filter(task => this.canRead(task, context));
    if (scopedOwner(identityOf(context)) === null && tasks.length === page.tasks.length) return page;
    // The underlying cursor may contain the last task's id. Only expose a
    // continuation if that task is visible to the current authority.
    const lastTask = page.tasks.at(-1);
    return {
      ...page, tasks, totalSize: tasks.length,
      nextPageToken: lastTask && this.canRead(lastTask, context) ? page.nextPageToken : "",
    };
  }

  abandon(context: ServerCallContext): void {
    this.abandoned.add(context);
    for (const key of this.claimKeys.get(context) ?? []) {
      const claim = this.terminalClaims.get(key);
      if (claim?.context === context && claim.writes === 0) this.terminalClaims.delete(key);
    }
    this.claimKeys.delete(context);
  }
}

/** Preserve the SDK's normal routing, authorization, and task persistence. */
export class A2ATaskRequestHandler extends DefaultRequestHandler {
  private readonly persistence: TaskPersistence;

  constructor(
    card: AgentCard,
    store: TaskStore,
    agent: AgentExecutor,
    extendedAgentCardProvider?: ExtendedAgentCardProvider,
    canUseScopedSkill?: (skillId: string, identity: Identity) => boolean,
  ) {
    const persistence = new TaskPersistence(store, canUseScopedSkill);
    super(card, persistence, {
      execute(context, bus) {
        persistence.observe(context, bus);
        return agent.execute(context, bus);
      },
      cancelTask(taskId, bus) {
        return agent.cancelTask(taskId, bus);
      },
    }, undefined, undefined, undefined, extendedAgentCardProvider);
    this.persistence = persistence;
  }

  private async checkScopedContinuation(params: SendMessageRequest, context: ServerCallContext): Promise<void> {
    const taskId = params.message?.taskId;
    if (!taskId || scopedOwner(identityOf(context)) === null) return;
    const task = await this.persistence.load(taskId, context);
    if (!task) throw new TaskNotFoundError("Task not found");
    if (task.metadata?.[TASK_SKILL_KEY] !== params.message?.metadata?.skillId) {
      throw new RequestMalformedError("A scoped task continuation must use the original skill");
    }
  }

  override async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
    await this.checkScopedContinuation(params, context);
    return super.sendMessage(params, context);
  }

  override cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    return this.persistence.cancel(params.id, () => super.cancelTask(params, context));
  }

  override async *sendMessageStream(
    params: SendMessageRequest, context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    try {
      await this.checkScopedContinuation(params, context);
      yield* super.sendMessageStream(params, context);
    } finally {
      this.persistence.abandon(context);
    }
  }
}
