import { AsyncLocalStorage } from "node:async_hooks";

export interface PendingApprovalReply {
  readonly approvalId: string;
  readonly resumeToken: string;
}

export interface ApprovalReplyCapture {
  readonly moduleId: string;
  candidate?: PendingApprovalReply;
  confirmed: boolean;
}

interface Invocation {
  readonly reply: ApprovalReplyCapture;
  readonly contextData: object;
  active: boolean;
}

const invocations = new AsyncLocalStorage<Invocation>();
const backgroundContexts = new WeakSet<object>();
const scopedServers = new WeakSet<object>();

export function enableApprovalReplies(server: object): void {
  scopedServers.add(server);
}

export function hasApprovalReplies(server: object): boolean {
  return scopedServers.has(server);
}

export function markBackgroundApprovalContext(data: object): void {
  backgroundContexts.add(data);
}

function matchingInvocation(
  moduleId: string, callerId: string | null, contextData: object | undefined,
): Invocation | undefined {
  const invocation = invocations.getStore();
  return invocation?.active && invocation.reply.moduleId === moduleId
    && callerId === null && invocation.contextData === contextData ? invocation : undefined;
}

export function canIssueApprovalReply(
  moduleId: string, callerId: string | null, contextData: object | undefined, requireForeground: boolean,
): boolean {
  if (contextData && backgroundContexts.has(contextData)) return false;
  if (!requireForeground && invocations.getStore() === undefined) return true;
  return matchingInvocation(moduleId, callerId, contextData) !== undefined;
}

/** Enter the private handoff scope only for an active foreground Core invocation. */
export async function runApprovalInvocation<T>(
  reply: ApprovalReplyCapture | undefined, contextData: object, invoke: () => Promise<T>,
): Promise<T> {
  if (!reply) return invoke();
  const invocation: Invocation = { reply, contextData, active: true };
  try {
    return await invocations.run(invocation, invoke);
  } finally {
    invocation.active = false;
  }
}

export function recordPendingApproval(
  moduleId: string, callerId: string | null, contextData: object | undefined, approval: PendingApprovalReply,
): void {
  const invocation = matchingInvocation(moduleId, callerId, contextData);
  if (invocation) invocation.reply.candidate = approval;
}

export function confirmPendingApproval(reply: ApprovalReplyCapture | undefined): void {
  if (reply?.candidate) reply.confirmed = true;
}
