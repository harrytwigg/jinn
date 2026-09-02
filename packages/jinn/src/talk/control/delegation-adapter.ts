import { createHash } from "node:crypto";
import type { ApiContext } from "../../gateway/api.js";
import { dispatchWebSessionRun } from "../../gateway/web-session-dispatch.js";
import { claimIncomingTurn } from "../../sessions/incoming-turn.js";
import {
  createSession,
  getSessionBySessionKey,
  updateSession,
} from "../../sessions/registry.js";
import { initDb } from "../../shared/db.js";
import type { Session } from "../../shared/types.js";
import { assignWorkItem } from "../../work-items/assignment.js";
import { reconcileWorkItem } from "../../work-items/reconcile.js";
import { getWorkItem, linkSession } from "../../work-items/store.js";
import { resolveDelegationLinkRole } from "../../work-items/link-role.js";
import type { TalkControlAdapterContext, TalkControlExecution } from "./types.js";

interface DelegateEmployee {
  name: string;
  department: string | null;
  engine: string;
  model?: string;
  effortLevel?: string;
}

export interface TalkDelegationInput {
  context: ApiContext;
  sourceSessionId: string;
  todoId: string;
  prompt: string;
  employee: DelegateEmployee;
  call: TalkControlAdapterContext;
}

interface ClaimedDelegation {
  session: Session;
  queueItemId: string;
  replayed: boolean;
}

function sessionKey(call: TalkControlAdapterContext): string {
  const digest = createHash("sha256").update(`operator\0${call.idempotencyKey}`).digest("hex");
  return `delegation-idempotency:${digest}`;
}

function validateReplay(session: Session, input: TalkDelegationInput): void {
  if (session.employee !== input.employee.name || session.engine !== input.employee.engine) {
    throw new Error("delegation idempotency key was already used for a different employee");
  }
  if (session.workItemId !== null && session.workItemId !== input.todoId) {
    throw new Error("delegation idempotency key was already used for a different Todo");
  }
}

/**
 * Claim the delegation's session, Todo link, visible prompt, and queued turn in
 * one SQLite transaction. A retry repairs a pre-existing incomplete session;
 * only the durable queue winner is dispatched after commit.
 */
export function claimTalkDelegation(input: TalkDelegationInput): ClaimedDelegation {
  const key = sessionKey(input.call);
  return initDb().transaction((): ClaimedDelegation => {
    const existing = getSessionBySessionKey(key);
    if (existing) validateReplay(existing, input);
    const assigned = assignWorkItem(
      input.todoId,
      input.employee.name,
      input.employee.department,
      "operator",
      "talk",
    );
    if (!assigned) throw new Error(`Todo ${input.todoId} not found`);
    const session = existing ?? createSession({
      engine: input.employee.engine,
      source: "web",
      sourceRef: key,
      connector: "web",
      sessionKey: key,
      replyContext: { source: "web" },
      employee: input.employee.name,
      model: input.employee.model,
      effortLevel: input.employee.effortLevel,
      parentSessionId: input.sourceSessionId,
      prompt: input.prompt,
      title: `Delegate ${input.todoId}`,
    });
    // Handing an `in_review` Todo to someone is handing it to a reviewer.
    linkSession(input.todoId, session.id, null, resolveDelegationLinkRole(undefined, assigned.status));
    const turn = claimIncomingTurn({
      sessionId: session.id,
      sessionKey: key,
      prompt: input.prompt,
      isNotification: true,
      queueVisibility: "visible",
      role: "user",
      content: input.prompt,
      dedupeKey: `${input.call.idempotencyKey}:delegation-turn`,
      durableDedupe: true,
      meta: { talk: { sessionId: input.call.talkSessionId, providerCallId: input.call.providerCallId } },
    });
    reconcileWorkItem(input.todoId);
    const needsRunning = !existing || !turn.deduplicated || existing.status === "idle";
    const current = needsRunning
      ? updateSession(session.id, { status: "running", lastActivity: new Date().toISOString() }) ?? session
      : session;
    if (!turn.queueItemId) throw new Error("delegation turn lost its durable queue anchor");
    return { session: current, queueItemId: turn.queueItemId, replayed: turn.deduplicated };
  }).immediate();
}

export function delegateTodoWithTalk(input: TalkDelegationInput): TalkControlExecution {
  const engine = input.context.sessionManager.getEngine(input.employee.engine);
  if (!engine) throw new Error(`Engine ${input.employee.engine} is unavailable`);
  if (!getWorkItem(input.todoId)) throw new Error(`Todo ${input.todoId} not found`);
  const claimed = claimTalkDelegation(input);
  if (!claimed.replayed) {
    input.context.emit("queue:updated", { sessionId: claimed.session.id, sessionKey: claimed.session.sessionKey });
    dispatchWebSessionRun(claimed.session, input.prompt, engine, input.context, { queueItemId: claimed.queueItemId });
  }
  return {
    data: {
      todoId: input.todoId,
      sessionId: claimed.session.id,
      employee: claimed.session.employee,
      replayed: claimed.replayed,
    },
    uiEffect: {
      invalidate: [`todo:${input.todoId}`, `todo-sessions:${input.todoId}`, "sessions"],
      navigate: `/?session=${encodeURIComponent(claimed.session.id)}`,
    },
  };
}
