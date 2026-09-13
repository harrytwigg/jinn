import { createHash } from 'node:crypto';
import { initDb } from '../shared/db.js';
import { createWorkItem, getWorkItem, type CreateWorkItemInput, type WorkItem } from './store.js';

/**
 * Caller-supplied create idempotency (ICI-733).
 *
 * `(source, source_ref)` already dedupes machine mints, but the server picks
 * that pair and the trigger paths do not set it usefully — a cron that fires
 * twice, or a connector that retries after a timeout it never saw resolve,
 * makes a second Todo for the same intent. An explicit key lets the CALLER say
 * "this is the same create as before".
 *
 * The receipt stores a fingerprint of the create alongside the Todo it made,
 * mirroring `work_item_edit_receipts`. Replaying the same key with a materially
 * different payload is a caller bug, not a replay: answering it with the first
 * Todo would silently drop the second create, so it raises instead.
 */

export class WorkItemCreateIdempotencyConflictError extends Error {
  readonly workItemId: string;

  constructor(workItemId: string) {
    super('Todo create idempotency key was already used for a different request');
    this.name = 'WorkItemCreateIdempotencyConflictError';
    this.workItemId = workItemId;
  }
}

export interface IdempotentCreateResult {
  item: WorkItem;
  /** True when the key had already been used and this create wrote nothing. */
  replayed: boolean;
}

/** The create fields that decide what the Todo IS. `origin` is deliberately
 *  absent: it records which surface performed the write, not what was asked
 *  for, and a retry over a different transport is still the same create. Key
 *  order is load-bearing — it feeds the canonical JSON, so entries are only
 *  ever appended. */
const CREATE_FINGERPRINT_FIELDS: ReadonlyArray<keyof CreateWorkItemInput> = [
  'title', 'body', 'status', 'department', 'assignee', 'createdBy', 'parentId',
  'dueAt', 'priority', 'source', 'sourceRef', 'acceptance', 'verifyPolicy', 'budgetUsd',
];

/** What a create asks for beyond the row itself: applied after the row rather
 *  than through `CreateWorkItemInput`, but part of the request all the same. */
export interface CreateWorkItemExtras {
  labels?: readonly string[];
  /** GEN-67: the auto-start opt-out. Only `false` is ever written, so only
   *  `false` is fingerprinted — every receipt minted before the flag existed
   *  stays byte-identical, and a retry that flips it reads as a conflict. */
  autoStart?: boolean;
}

function canonicalCreateFingerprint(input: CreateWorkItemInput, { labels, autoStart }: CreateWorkItemExtras): string {
  const payload: Record<string, unknown> = {};
  for (const key of CREATE_FINGERPRINT_FIELDS) {
    if (input[key] !== undefined) payload[key] = input[key];
  }
  // Labels are applied after the row rather than through `CreateWorkItemInput`,
  // but they are part of what the caller asked to create, and a replay keeps the
  // first call's set — so a different set is a different create, not one this
  // replay could deliver. Sorted, because a label set is a set: reordering the
  // same names is the same request and must not read as a conflict.
  if (labels !== undefined) payload.labels = [...labels].sort();
  if (autoStart === false) payload.autoStart = false;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Create a Todo at most once per key. A repeat with the same payload returns
 * the Todo the first call made, having written nothing — no second row, no
 * second `created` event, and no burned ID, because the receipt is checked
 * before the allocator is ever reached.
 */
export function createWorkItemIdempotent(
  input: CreateWorkItemInput,
  idempotencyKey: string,
  extras: CreateWorkItemExtras = {},
): IdempotentCreateResult {
  const db = initDb();
  const keyDigest = createHash('sha256').update(idempotencyKey).digest('hex');
  const fingerprint = canonicalCreateFingerprint(input, extras);

  const txn = db.transaction((): IdempotentCreateResult => {
    const receipt = db
      .prepare('SELECT work_item_id, fingerprint FROM work_item_create_receipts WHERE key_digest = ?')
      .get(keyDigest) as { work_item_id: string; fingerprint: string } | undefined;
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) throw new WorkItemCreateIdempotencyConflictError(receipt.work_item_id);
      const existing = getWorkItem(receipt.work_item_id);
      // The boot verifier proves every receipt still points at a live Todo, so
      // this is unreachable through the supported paths — and a replay that
      // returned nothing would look like a create that silently did nothing.
      if (!existing) throw new Error(`Todo ${receipt.work_item_id} recorded against a create idempotency key no longer exists`);
      return { item: existing, replayed: true };
    }
    const item = createWorkItem(input);
    db.prepare(
      `INSERT INTO work_item_create_receipts (key_digest, work_item_id, fingerprint, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(keyDigest, item.id, fingerprint, new Date().toISOString());
    return { item, replayed: false };
  });
  return txn();
}
