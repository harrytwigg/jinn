import { listSessionsByWorkItem } from '../sessions/registry.js';
import { isExecutionAttempt } from './link-role.js';
import { initDb } from '../shared/db.js';
import { clearBlockRecord, DEFAULT_BLOCK_KIND, recordBlock, resolveBlock, type BlockKind } from './blocks.js';
import { cascadeCloseDescendants } from './cascade.js';
import { holdLiveSignalsUntilCommit, notifyTodoChanged, notifyTodoStatusChange } from './live-events.js';
import { clearStopCause, writeStopCause, type TodoStopCause } from './stop-cause.js';
import { EDGES } from './transition-edges.js';
import {
  appendWorkItemEvent,
  effectiveMaxRounds,
  getWorkItem,
  STICKY_STATUSES,
  type WorkItem,
  type WorkItemEvent,
  type WorkItemStatus,
} from './store.js';

/**
 * Guarded Todo transitions (GRS-021a design §1.2) — THE status write path.
 *
 * With 8 statuses + approvals + rounds, scattered `updateStatus` calls would be
 * the split-brain seed all over again. Every status change flows through
 * `transition()`: only declared edges are allowed (illegal edges THROW, never
 * silently write), every change appends a `work_item_events` audit row in the
 * SAME transaction, sticky terminals (`done`/`cancelled`/`escalated`) are left
 * only under explicit human authority, the self-review ban is structural, and
 * the bounce rule (`in_review → executing` with `rounds++`) auto-escalates at
 * the policy's max rounds instead of looping. The GRS-003a reconciler and the
 * (phase-2) dispatcher are consumers of this module, not competitors to it.
 */

export type TransitionErrorCode =
  | 'not-found'
  | 'illegal-edge'
  | 'human-required'
  | 'self-review-banned'
  | 'children-open'
  | 'escalated-descendant'
  | 'conflict';

export class TransitionError extends Error {
  readonly code: TransitionErrorCode;
  constructor(code: TransitionErrorCode, message: string) {
    super(message);
    this.name = 'TransitionError';
    this.code = code;
  }
}

export interface TransitionOptions {
  /** Caller is a human surface (operator web/API). Required to LEAVE a sticky
   *  terminal (`done`/`cancelled`/`escalated`). Agent/system callers never set it. */
  human?: boolean;
  /** Explicit status update from a human/tool surface. A manual move INTO
   *  `executing` is a start action and is legal only from backlog/assigned;
   *  reconciler derivation and review bounces deliberately leave this unset. */
  manual?: boolean;
  /**
   * The calling session's id (the GRS-017 identity seam), when the transition
   * comes from an agent. Enforces the SELF-REVIEW BAN (design §1.5): a session
   * that is one of the item's linked non-phase execution attempts cannot move
   * the item to `done` — its reviewer does. Workflow phases are linked for run
   * attribution and do not become producers merely because of that link.
   */
  callerSessionId?: string;
  /**
   * The agent lane. The calling surface has already restricted `to` to the
   * agent-settable targets, and inside that set the edge map only got in the
   * way: a Todo parked in `blocked` could not be put back to work by the agent
   * that unblocked it. Skips the edge map and the manual-start rule; nothing
   * else moves. Sticky terminals still need `human`, the self-review ban still
   * withholds `done`, and open children still block a close.
   */
  agent?: boolean;
  /**
   * Marks an `in_review → executing` transition as a review BOUNCE (rejection
   * with critique): `rounds` increments, and when the incremented count reaches
   * the policy's max rounds the item goes to `escalated` INSTEAD (design §1.3 —
   * bounded loops end in front of the operator, never spin).
   */
  bounce?: boolean;
  /**
   * The re-arm lane: `to` is dictated by a Workflow's own `todo-status` trigger,
   * not chosen by the caller, so the edge map does not apply. The board withholds
   * `in_review → assigned` from a human drag on purpose (a send-back there is a
   * review verdict, not a drag) — but work sent back for revision has to restart
   * exactly where its trigger fires, whatever status that is. Sticky terminals
   * still need `human`, and the self-review ban still withholds `done`.
   */
  requeue?: boolean;
  /** Why this block is a block (ICI-730); read only when `to` is `blocked`, and
   *  `blocks.ts` owns what each kind does. Absent, a block means `needs_input`:
   *  never `dependency`, which would re-queue work nobody asked to have back. */
  blockKind?: BlockKind;
  /**
   * Close this item's open descendants along with it (PLA-96), so recording one
   * decision costs one action instead of one per sub-task. Read only for a
   * `done` target carrying `human` — the same authority pairing `archiveWorkItem`
   * requires for cascade-cancel, because a cascade closes work its caller never
   * looked at.
   */
  cascade?: boolean;
  /**
   * Let a cascade close run over an `escalated` descendant. Withheld by default:
   * an escalation is an unanswered question put to the operator, and `done`
   * asserts an answer nobody gave. Saying so explicitly is the answer.
   */
  acknowledgeEscalated?: boolean;
  /** Why this stop will end (PLA-157): the moment a clock-wait is over, or what
   *  has to happen and who has to do it. Stored only when the move lands in
   *  `blocked`/`escalated`; leaving either deletes whatever was stored. */
  stopCause?: TodoStopCause;
  /** Free-form audit payload (critique text, verdict, reason) stored on the event. */
  detail?: Record<string, unknown>;
}

export interface TransitionResult {
  item: WorkItem;
  /** True when a bounded-loop rule — review rounds or block recurrences —
   *  redirected the target to `escalated`. */
  escalated: boolean;
  /** The committed audit event for an actual status write. Undefined for no-ops. */
  event?: WorkItemEvent;
}

// The status-change bridge lives with the other live listener (`live-events.ts`)
// and is re-exported here, because this write path is what registering against
// it actually observes.
export { setTodoStatusChangeListener, type TodoStatusChangeEvent, type TodoStatusChangeListener } from './live-events.js';
// Assignment answers who owns a Todo, not where it sits, so it has its own
// module — re-exported here because it moves status on the way and its callers
// reach for both through this one import.
export { assignWorkItem } from './assignment.js';

/** Exported for `assignment.ts`, the other write that moves status: both stamp
 *  the same provenance so one event reader covers them. */
export function todoProvenanceSnapshot(
  item: Pick<WorkItem, 'source' | 'department' | 'assignee'>,
): Pick<WorkItem, 'source' | 'department' | 'assignee'> {
  return {
    source: item.source,
    department: item.department,
    assignee: item.assignee,
  };
}

/**
 * Move a work item to `to` under the edge map. Throws `TransitionError` on an
 * unknown item, an undeclared edge, a sticky-terminal exit without human
 * authority, or a self-review `done`. Returns the updated item. The status
 * write, rounds bump, and audit event(s) commit in ONE transaction; the write
 * is optimistic (`WHERE status = <from>`) so a concurrent writer surfaces as a
 * `conflict` error instead of a silent clobber.
 */
export function transition(id: string, to: WorkItemStatus, actor: string, opts: TransitionOptions = {}): TransitionResult {
  const db = initDb();
  const txn = db.transaction((): TransitionResult => {
    const item = getWorkItem(id);
    if (!item) throw new TransitionError('not-found', `work item ${id} not found`);
    const from = item.status;
    // Resolved BEFORE the same-status shortcut, because a `dependency` block
    // routes AWAY from `blocked`: on an already-blocked Todo `to === from` no
    // longer means nothing changes, and the shortcut would swallow both the
    // move back to the queue and the count that ends the loop. Every other kind
    // does land where it already is, so their no-op stands.
    const blockKind: BlockKind | null = to === 'blocked' ? (opts.blockKind ?? DEFAULT_BLOCK_KIND) : null;
    if (from === to && blockKind !== 'dependency') return { item, escalated: false }; // no-op: no write, no event

    if (STICKY_STATUSES.has(from) && !opts.human) {
      throw new TransitionError(
        'human-required',
        `work item ${id} is ${from} — leaving a sticky terminal is a human decision (operator surface only)`,
      );
    }
    if (!opts.agent && !opts.requeue) {
      if (opts.manual && to === 'executing' && from !== 'backlog' && from !== 'assigned') {
        throw new TransitionError('illegal-edge', `illegal manual transition ${from} → ${to} for work item ${id}`);
      }
      if (!EDGES[from].has(to)) {
        throw new TransitionError('illegal-edge', `illegal transition ${from} → ${to} for work item ${id}`);
      }
    }
    if (to === 'done' && opts.callerSessionId) {
      const linked = listSessionsByWorkItem(id);
      if (linked.some((s) => s.id === opts.callerSessionId && isExecutionAttempt(s))) {
        throw new TransitionError(
          'self-review-banned',
          `session ${opts.callerSessionId} executed work item ${id} and cannot mark it done — a reviewer does (self-review ban)`,
        );
      }
    }

    // The authorized cascade (PLA-96) runs FIRST, so the gate below meets a tree
    // whose children are already closed. Without the flag nothing changes: the
    // gate's refusal stays the default answer, word for word.
    if (to === 'done' && opts.cascade && opts.human) {
      cascadeCloseDescendants(db, item, actor, opts.acknowledgeEscalated === true);
    }

    // Roll-up gate (Todos v2): a container cannot be closed over open children.
    // Deliberately stricter than spec §3.4's "non-terminal" wording: an
    // `escalated` child also blocks the close — an escalation awaiting the
    // operator must not be buried by closing its parent. (Human-authorized
    // cascade-cancel still cancels escalated children via the declared
    // escalated→cancelled edge; the cascade-close above needs
    // `acknowledgeEscalated` on top of that.)
    if (to === 'done' || to === 'cancelled') {
      const openChild = db
        .prepare("SELECT id FROM work_items WHERE parent_id = ? AND status NOT IN ('done', 'cancelled') LIMIT 1")
        .get(id) as { id: string } | undefined;
      if (openChild) {
        throw new TransitionError(
          'children-open',
          `work item ${id} still has open children (e.g. ${openChild.id}) — close or cancel them first`,
        );
      }
    }

    // The bounce rule: a rejected review returns to executing — unless this
    // rejection exhausts the policy's rounds, in which case the loop terminates
    // at the operator (escalated), never spins.
    let target = to;
    let escalatedByRounds = false;
    let rounds = item.rounds;
    if (opts.bounce && from === 'in_review' && to === 'executing') {
      rounds += 1;
      if (rounds >= effectiveMaxRounds(item)) {
        target = 'escalated';
        escalatedByRounds = true;
      }
    }

    // The block-loop breaker: the same bounded-loop shape one level down, so a
    // block that keeps coming back for the same reason ends at the operator
    // instead of cycling between a cron that unblocks and an agent that re-blocks.
    const block = blockKind ? resolveBlock(db, item, blockKind) : null;
    if (block) target = block.target;
    const escalated = escalatedByRounds || block?.escalated === true;

    // Optimistic write: 0 rows changed = someone moved it between our read and
    // this write (cross-process only — better-sqlite3 calls are synchronous).
    const now = new Date().toISOString();
    const closing = target === 'done' || target === 'cancelled';
    const result = db
      .prepare(`UPDATE work_items SET status = ?, rounds = ?, updated_at = ?, version = version + 1${
        closing ? ', closed_at = COALESCE(closed_at, ?)' : ', closed_at = NULL'
      } WHERE id = ? AND status = ?`)
      .run(...(closing ? [target, rounds, now, now, id, from] : [target, rounds, now, id, from]));
    if (result.changes === 0) {
      throw new TransitionError('conflict', `work item ${id} changed concurrently (expected status ${from})`);
    }

    if (block) recordBlock(db, id, block, now);
    // Only a successful completion resets the block history; `cancelled` keeps
    // it, because abandoning work is not evidence its blocks were resolved.
    if (target === 'done') clearBlockRecord(db, id);
    // The stop's cause belongs to the stop (PLA-157), so it is written with the
    // status that made it true and deleted the moment the Todo is no longer
    // stopped — a countdown can never outlive the wait it was counting.
    if (target !== 'blocked' && target !== 'escalated') clearStopCause(db, id);
    else if (opts.stopCause) writeStopCause(db, id, opts.stopCause, now);

    const event = appendWorkItemEvent({
      workItemId: id,
      kind: escalated ? 'escalated' : 'status_change',
      fromStatus: from,
      toStatus: target,
      actor,
      detail: {
        ...(opts.detail ?? {}),
        ...(opts.bounce ? { bounce: true, rounds } : {}),
        ...(escalatedByRounds ? { reason: 'max-rounds-exhausted', maxRounds: effectiveMaxRounds(item) } : {}),
        ...(block?.escalated ? { reason: 'block_loop_detected', blockKind, recurrences: block.recurrences } : {}),
        todoProvenance: todoProvenanceSnapshot(item),
      },
    });

    return { item: getWorkItem(id)!, escalated, event };
  });
  const result = holdLiveSignalsUntilCommit(txn);
  // ICI-749: the board's live signal belongs to the status write, not to the HTTP
  // routes. A workflow reflecting its run, the reconciler, and an approval's
  // consequence all commit here with no route to announce them, so the dashboard
  // stayed stale until a reload. Emitted before the workflow bridge so a recovery
  // failure can never swallow the update; the route lanes suppress their own
  // duplicate (`persistTodoMutationActivity`).
  if (result.event) notifyTodoChanged(result.item, 'status-transitioned', opts.callerSessionId);
  notifyTodoStatusChange(result.event, result.item);
  return result;
}

/** Convenience: the reconciler's derived writes (agent-free, event-audited).
 *  Returns undefined instead of throwing on conflict/sticky races — derivation
 *  is best-effort truth-keeping, not authority. */
export function transitionDerived(id: string, to: WorkItemStatus, actor: string, detail?: Record<string, unknown>, blockKind?: BlockKind): WorkItem | undefined {
  try {
    return transition(id, to, actor, { ...(detail ? { detail } : {}), ...(blockKind ? { blockKind } : {}) }).item;
  } catch (err) {
    if (err instanceof TransitionError) return undefined;
    throw err;
  }
}
