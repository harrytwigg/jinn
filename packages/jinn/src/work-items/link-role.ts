import type { Session, WorkItemLinkRole } from '../shared/types.js';

/**
 * Why a session is linked to a Todo.
 *
 * The link answers two different questions that used to have one answer. "Whose
 * spend is this?" wants every session that touched the Todo; "who produced this
 * work?" wants only the ones that did it. The self-review ban asks the second
 * question, so a reviewer delegated onto a Todo — linked so their rounds are
 * attributed and their comments route — was read as its producer and refused
 * the one transition a reviewer exists to make (DAH-214 item 1).
 *
 * `execute` is the default and the legacy meaning: a NULL column is an
 * execution attempt, so nothing already in the database changes meaning.
 */
export type { WorkItemLinkRole };

export const WORK_ITEM_LINK_ROLES: readonly WorkItemLinkRole[] = ['execute', 'review'];

/** Parse a role off the wire or out of a column. Anything unrecognised —
 *  including NULL — is an execution attempt, the pre-existing meaning. */
export function toWorkItemLinkRole(value: unknown): WorkItemLinkRole {
  return value === 'review' ? 'review' : 'execute';
}

/**
 * Whether a linked session counts as having EXECUTED the Todo.
 *
 * The two exclusions are the same rule seen from different angles: a Workflow
 * phase session is linked so the run's spend rolls up to the Todo it is bound
 * to, and a review session is linked so a review round is attributed and
 * steerable. Neither produced the work, so neither may be treated as its
 * producer — by the self-review ban, or by the status derivation that reads
 * attempt receipts.
 */
export function isExecutionAttempt(session: Session): boolean {
  return session.workflowProvenance?.kind !== 'phase'
    && toWorkItemLinkRole(session.workItemRole) !== 'review';
}

/**
 * The role a delegation's link should carry.
 *
 * Explicit `intent` wins; otherwise the Todo's own status decides. A Todo that
 * is already `in_review` when someone delegates onto it is being handed to a
 * reviewer — that is what `in_review` MEANS, and it is the flow the doctrine
 * prescribes (the producer submits, then hands off). Inferring it keeps every
 * existing caller working without a new argument, while `intent: 'review'`
 * stays available for a reviewer brought in before the submission.
 */
export function resolveDelegationLinkRole(intent: WorkItemLinkRole | undefined, todoStatus: string): WorkItemLinkRole {
  if (intent) return intent;
  return todoStatus === 'in_review' ? 'review' : 'execute';
}
