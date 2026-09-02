import { latestHumanStatusMoveAt } from './event-log.js';
import { closeWorkItemRun, findOpenWorkItemRunBySession, runOutcomeForReceipt } from './runs.js';
import { listSessionsByWorkItem } from '../sessions/registry.js';
import { isExecutionAttempt } from './link-role.js';
import { logger } from '../shared/logger.js';
import type { Session, SessionAttemptOutcome } from '../shared/types.js';

/**
 * What a Todo's execution attempts say, and as of when.
 *
 * The reconciler derives status from linked sessions; this module decides which
 * of them still get to speak. It also settles the run ledger from the same
 * receipts, because the two readings must agree about what an attempt did.
 */

/** Session lifecycle states, mirrored from `Session.status` in shared/types.ts. */
export type SessionStatus = 'idle' | 'running' | 'error' | 'waiting' | 'interrupted';

export interface WorkItemAttemptEvidence {
  status: SessionStatus;
  outcome: SessionAttemptOutcome | null;
}

/** What a Todo's attempts say, and what the operator said last. */
export interface WorkItemAttemptReading {
  /** The receipts still entitled to speak, newest-first. */
  attempts: WorkItemAttemptEvidence[];
  /** When the operator last moved this Todo himself, if he ever has. Attempts at
   *  or before it were dropped; an empty `attempts` alongside it means nothing
   *  has happened since he decided. */
  humanDecisionAt?: string;
}

/**
 * Settle the run ledger from the same receipts the status derivation reads, so
 * a Todo's attempt history closes the moment its attempts do. Best-effort per
 * session: a ledger write is reporting, and reporting must never break the
 * status the platform actually routes on.
 *
 * Callers pass sessions with Workflow phase sessions already filtered out — the
 * workflow runner settles those runs itself, and racing it would close a phase
 * attempt the run is still retrying.
 */
function closeRunsForSettledAttempts(sessions: readonly Session[]): void {
  for (const session of sessions) {
    if (!session.attemptOutcome) continue;
    try {
      const run = findOpenWorkItemRunBySession(session.id);
      // Read the receipt through the same rate-limit-aware reading the sweep
      // uses. Whichever of the two reaches an attempt first must settle it the
      // same way, or a quota window becomes `blocked` purely because the
      // reconciler got there first — and `blocked` is what the respawn guards
      // read as "a human has to clear this".
      if (run) closeWorkItemRun(run.id, { outcome: runOutcomeForReceipt(session.attemptOutcome, session.lastError) });
    } catch (err) {
      logger.warn(`Run ledger close for session ${session.id} skipped: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Drop the attempts that predate the operator's own most recent status move
 * (PLA-98). A receipt written before he decided where the Todo belongs says
 * nothing about what happened after the decision, and deriving from one reverts
 * him — on PLA-61 a ten-day-old `succeeded` session pulled a Todo he had just
 * parked in `backlog` into `in_review`, three seconds later.
 *
 * The floor is causal rather than a time window, so it clears itself: the moment
 * an attempt actually does something its `last_activity` passes the floor and
 * derivation resumes. A session that is genuinely live keeps touching
 * `last_activity`, so work happening right now still derives `executing` — that
 * is honest evidence in a way a settled corpse is not.
 *
 * Only actor `operator` raises a floor. An agent-declared move keeps today's
 * behaviour: the declared-block and review-bounce guards already cover those.
 */
function attemptsAfterHumanDecision(floor: string | undefined, sessions: readonly Session[]): readonly Session[] {
  if (!floor) return sessions;
  return sessions.filter((session) => session.lastActivity > floor);
}

/**
 * The receipts a Todo's status may be derived from, newest-first (the ordering
 * `listSessionsByWorkItem` returns and `deriveWorkItemStatus` relies on).
 * Settles the run ledger on the way through, for every non-phase attempt —
 * bookkeeping about a finished attempt stays true regardless of whether that
 * attempt still counts as evidence.
 */
export function collectAttemptEvidence(workItemId: string): WorkItemAttemptReading {
  // A Workflow phase session is linked to the run's bound Todo so the run's
  // spend rolls up there, but the RUN owns its own lifecycle: it retries,
  // parks on gates, and decides when the pipeline is finished. Deriving the
  // Todo from phase receipts would settle it on the first phase that finished —
  // `in_review` (and TRUST-closed to `done`) with four phases still to run, and
  // `in_review` is not re-derivable, so it would stay wrong for the rest of the
  // run. Same rule the `source === 'workflow'` guard states for items.
  const sessions = listSessionsByWorkItem(workItemId).filter(isExecutionAttempt);
  closeRunsForSettledAttempts(sessions);
  const humanDecisionAt = latestHumanStatusMoveAt(workItemId);
  return {
    humanDecisionAt,
    attempts: attemptsAfterHumanDecision(humanDecisionAt, sessions).map((s) => ({
      status: s.status as SessionStatus,
      outcome: s.attemptOutcome ?? null,
    })),
  };
}
