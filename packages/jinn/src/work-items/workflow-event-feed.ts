import { randomUUID } from 'node:crypto';
import { initDb } from '../shared/db.js';
import { getWorkItem, type WorkItemSource, type WorkItemStatus } from './store.js';
import { getWorkItemLabels } from './labels.js';
import { todoAutoStartAllowed } from './auto-start.js';
import { isTodoId } from './id.js';

export interface WorkflowTodoStatusEvent {
  id: string;
  workItemId: string;
  fromStatus: WorkItemStatus | null;
  toStatus: WorkItemStatus;
  /** Who performed the transition, read from the audit row's own `actor`
   *  column rather than the provenance snapshot — so every event written
   *  before the trigger filter existed replays with its actor intact. */
  actor: string | null;
  /** The employee behind a `session:` actor, stamped at the moment of the move
   *  from the session's own identity — never from the request — so a trigger
   *  can tell "the assignee moved this themself" from "someone handed it to
   *  them". Null for the operator, derived movers, employee-less sessions, and
   *  every event written before the stamp existed (GEN-67). */
  actorEmployee: string | null;
  /** The employee the status route stamped this move as armed on behalf of, or
   *  null for every other event. It is written at the moment of the move, so a
   *  later change to the delegate list never rewrites what already happened. */
  armedAsDelegate: string | null;
  /** Whether the availability resume sweep wrote this move, having already
   *  settled from the failure's own reset when the quota window reopens. Written
   *  at the moment of the move, so nothing read later can claim a window nobody
   *  waited out. */
  quotaWindowDecided: boolean;
  /** A recovery sweep re-armed this Todo. Operator-filtered triggers accept it
   *  the same way they accept an availability resume: this is resuming work the
   *  operator already armed, not a new arming. */
  armedAsRecovery?: boolean;
  /** `source`, `department`, and `assignee` are the provenance snapshot frozen
   *  into the audit row when the Todo moved. `labels` and `live` are read at
   *  replay time instead: labels, assignment, and parentage all change
   *  independently of status, so a filter asking what the Todo *is* must read the
   *  row rather than whatever it carried when it moved. `live` is null once the
   *  row is gone, which is not the same as a Todo that is simply unassigned. Its
   *  `status` is the Todo's status NOW, which is what says whether the Todo is
   *  still sitting where this event put it. `autoStart` is read live too: it is
   *  the Todo's own opt-out of being auto-started (GEN-67), and a Todo that has
   *  not opted out reads true. */
  item: {
    source: WorkItemSource;
    department: string | null;
    assignee: string | null;
    labels: Array<{ id: string; name: string }>;
    autoStart: boolean;
    live: { assignee: string | null; parentId: string | null; status: WorkItemStatus } | null;
  };
}

export interface WorkflowTodoEventClaimOutcome {
  workflowId: string;
  outcome: 'started' | 'duplicate' | 'suppressed' | 'superseded' | 'deferred-then-superseded' | 'failed';
  runId?: string;
  detail: string;
}

export type WorkflowTodoEventClaim =
  /** `deferred` marks an event an earlier pass put back rather than settled, so
   *  the caller knows to re-check whatever it was waiting on before firing. */
  | { state: 'acquired'; definitionIds: string[]; deferred?: boolean }
  | { state: 'busy' }
  | { state: 'processed'; outcomes: WorkflowTodoEventClaimOutcome[] };

export interface WorkflowTodoEventFeed {
  claimEvent(eventId: string, definitionIds: string[]): WorkflowTodoEventClaim;
  completeEvent(eventId: string, outcomes: WorkflowTodoEventClaimOutcome[]): void;
  /** Record what this pass decided WITHOUT sealing the event: a later drain has
   *  to judge it again, against `definitionIds` as its candidates. */
  deferEvent(eventId: string, definitionIds: string[], outcomes: WorkflowTodoEventClaimOutcome[]): void;
  releaseEvent(eventId: string): void;
  /** Unclaimed status events, oldest first, so a caller reading a backlog
   *  sees the order the Todo actually moved in. */
  listPendingEvents(limit?: number): WorkflowTodoStatusEvent[];
}

export interface WorkflowTodoEventFeedOptions {
  ownerId?: string;
  now?: () => Date;
  leaseMs?: number;
}

interface TodoEventClaimRow {
  state: 'processing' | 'processed';
  owner: string;
  definition_ids: string;
  outcomes: string | null;
  claimed_at: string;
}

interface TodoEventRow {
  id: string;
  work_item_id: string;
  from_status: WorkItemStatus;
  to_status: WorkItemStatus;
  actor: string | null;
  detail: string | null;
}

export const CLAIMS_TABLE = 'workflow_todo_event_claims';
const CLAIMS_MIGRATION_KEY = 'todo_status_event_claims_migrated';
const LEGACY_WATERMARK_KEY = 'todo_status_replay_watermark';
const CLAIM_OWNER = randomUUID();
const DEFAULT_CLAIM_LEASE_MS = 30_000;
let claimsTableReady = false;

export function ensureClaimsTable(): ReturnType<typeof initDb> {
  const db = initDb();
  if (claimsTableReady) return db;
  db.exec(`CREATE TABLE IF NOT EXISTS ${CLAIMS_TABLE} (
    event_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('processing', 'processed')),
    owner TEXT NOT NULL,
    definition_ids TEXT NOT NULL,
    outcomes TEXT,
    claimed_at TEXT NOT NULL,
    processed_at TEXT
  )`);
  const migrated = db.prepare('SELECT value FROM meta WHERE key = ?').get(CLAIMS_MIGRATION_KEY) as { value: string } | undefined;
  if (!migrated) {
    db.transaction(() => {
      const legacy = db.prepare('SELECT value FROM meta WHERE key = ?').get(LEGACY_WATERMARK_KEY) as { value: string } | undefined;
      if (legacy) {
        try {
          const cursor = JSON.parse(legacy.value) as { createdAt?: unknown; rowid?: unknown };
          if (typeof cursor.createdAt === 'string' && Number.isFinite(cursor.rowid)) {
            db.prepare(
              `INSERT OR IGNORE INTO ${CLAIMS_TABLE}
                (event_id, state, owner, definition_ids, outcomes, claimed_at, processed_at)
               SELECT id, 'processed', 'legacy-watermark', '[]', '[]', created_at, ?
               FROM work_item_events
               WHERE created_at < ? OR (created_at = ? AND rowid <= ?)`,
            ).run(new Date().toISOString(), cursor.createdAt, cursor.createdAt, Number(cursor.rowid));
          }
        } catch {
          // A corrupt legacy cursor carries no trustworthy migration evidence.
        }
      }
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(CLAIMS_MIGRATION_KEY, '1');
    })();
  }
  claimsTableReady = true;
  return db;
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

export function parseOutcomes(raw: string | null): WorkflowTodoEventClaimOutcome[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as WorkflowTodoEventClaimOutcome[] : [];
  } catch {
    return [];
  }
}

function replayLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 500;
  return Math.max(1, Math.min(5000, Math.floor(limit as number)));
}

const WORK_ITEM_SOURCES = new Set<WorkItemSource>([
  'human', 'delegation', 'cron', 'workflow', 'session', 'connector', 'goal',
]);

function eventFromImmutableSnapshot(row: TodoEventRow): WorkflowTodoStatusEvent | null {
  if (!isTodoId(row.work_item_id)) return null;
  if (!row.detail) return null;
  try {
    const detail = JSON.parse(row.detail) as
      { todoProvenance?: unknown; actorEmployee?: unknown; armedAsDelegate?: unknown; availabilityResume?: unknown;
        recoveryResume?: unknown };
    const snapshot = detail.todoProvenance;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    const value = snapshot as Record<string, unknown>;
    if (typeof value.source !== 'string' || !WORK_ITEM_SOURCES.has(value.source as WorkItemSource)) return null;
    if (value.department !== null && typeof value.department !== 'string') return null;
    if (value.assignee !== null && typeof value.assignee !== 'string') return null;
    if (!Object.prototype.hasOwnProperty.call(value, 'department') || !Object.prototype.hasOwnProperty.call(value, 'assignee')) return null;
    const current = getWorkItem(row.work_item_id);
    return {
      id: row.id,
      workItemId: row.work_item_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      actor: row.actor,
      actorEmployee: typeof detail.actorEmployee === 'string' ? detail.actorEmployee : null,
      armedAsDelegate: typeof detail.armedAsDelegate === 'string' ? detail.armedAsDelegate : null,
      quotaWindowDecided: detail.availabilityResume === true,
      ...(detail.recoveryResume === true ? { armedAsRecovery: true } : {}),
      item: {
        source: value.source as WorkItemSource,
        department: value.department as string | null,
        assignee: value.assignee as string | null,
        labels: getWorkItemLabels(row.work_item_id).map(({ id, name }) => ({ id, name })),
        autoStart: todoAutoStartAllowed(initDb(), row.work_item_id),
        live: current ? { assignee: current.assignee, parentId: current.parentId, status: current.status } : null,
      },
    };
  } catch {
    return null;
  }
}

export function createWorkflowTodoEventFeed(opts: WorkflowTodoEventFeedOptions = {}): WorkflowTodoEventFeed {
  const owner = opts.ownerId ?? CLAIM_OWNER;
  const now = opts.now ?? (() => new Date());
  const leaseMs = Math.max(1, opts.leaseMs ?? DEFAULT_CLAIM_LEASE_MS);
  return {
    claimEvent(eventId, definitionIds) {
      const db = ensureClaimsTable();
      return db.transaction((): WorkflowTodoEventClaim => {
        const existing = db.prepare(
          `SELECT state, owner, definition_ids, outcomes, claimed_at FROM ${CLAIMS_TABLE} WHERE event_id = ?`,
        ).get(eventId) as TodoEventClaimRow | undefined;
        if (!existing) {
          db.prepare(
            `INSERT INTO ${CLAIMS_TABLE}
              (event_id, state, owner, definition_ids, outcomes, claimed_at, processed_at)
             VALUES (?, 'processing', ?, ?, NULL, ?, NULL)`,
          ).run(eventId, owner, JSON.stringify(definitionIds), now().toISOString());
          return { state: 'acquired', definitionIds };
        }
        if (existing.state === 'processed') {
          return { state: 'processed', outcomes: parseOutcomes(existing.outcomes) };
        }
        if (existing.owner === owner) return { state: 'busy' };
        const claimedAt = Date.parse(existing.claimed_at);
        if (Number.isFinite(claimedAt) && now().getTime() - claimedAt <= leaseMs) return { state: 'busy' };
        const takeover = db.prepare(
          `UPDATE ${CLAIMS_TABLE} SET owner = ?, claimed_at = ?
           WHERE event_id = ? AND state = 'processing' AND owner = ? AND claimed_at = ?`,
        ).run(owner, now().toISOString(), eventId, existing.owner, existing.claimed_at);
        if (takeover.changes !== 1) return { state: 'busy' };
        return { state: 'acquired', definitionIds: parseStringArray(existing.definition_ids),
          deferred: existing.owner.startsWith('deferred:') };
      }).immediate();
    },

    completeEvent(eventId, outcomes) {
      ensureClaimsTable().prepare(
        `UPDATE ${CLAIMS_TABLE}
         SET state = 'processed', outcomes = ?, processed_at = ?
         WHERE event_id = ? AND state = 'processing' AND owner = ?`,
      ).run(JSON.stringify(outcomes), now().toISOString(), eventId, owner);
    },

    /**
     * Put a claimed event back in the queue. It was not refused on the merits —
     * a filter read something that can still change — so the outcomes recorded
     * here are provisional, and whatever settles the event overwrites them.
     * `definitionIds` replaces the claim's own list, because the point of
     * deferring is that the next drain re-decides which definitions match.
     */
    deferEvent(eventId, definitionIds, outcomes) {
      ensureClaimsTable().prepare(
        `UPDATE ${CLAIMS_TABLE}
         SET owner = ?, claimed_at = ?, definition_ids = ?, outcomes = ?
         WHERE event_id = ? AND state = 'processing' AND owner = ?`,
      ).run(`deferred:${randomUUID()}`, new Date(0).toISOString(), JSON.stringify(definitionIds),
        JSON.stringify(outcomes), eventId, owner);
    },

    releaseEvent(eventId) {
      ensureClaimsTable().prepare(
        `UPDATE ${CLAIMS_TABLE}
         SET owner = ?, claimed_at = ?
         WHERE event_id = ? AND state = 'processing' AND owner = ?`,
      ).run(`released:${randomUUID()}`, new Date(0).toISOString(), eventId, owner);
    },

    listPendingEvents(limit) {
      const db = ensureClaimsTable();
      const rows = db.prepare(
        `SELECT e.id, e.work_item_id, e.from_status, e.to_status, e.actor, e.detail
         FROM work_item_events e
         LEFT JOIN ${CLAIMS_TABLE} c ON c.event_id = e.id
         WHERE e.from_status IS NOT NULL
           AND e.to_status IS NOT NULL
           AND e.kind IN ('status_change', 'escalated')
           AND (c.state IS NULL OR c.state = 'processing')
         ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
      ).all(replayLimit(limit)).reverse() as TodoEventRow[];
      return db.transaction(() => rows.flatMap((row): WorkflowTodoStatusEvent[] => {
        const event = eventFromImmutableSnapshot(row);
        if (event) return [event];
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO ${CLAIMS_TABLE}
            (event_id, state, owner, definition_ids, outcomes, claimed_at, processed_at)
           VALUES (?, 'processed', 'legacy-incomplete-provenance', '[]', '[]', ?, ?)`,
        ).run(row.id, now, now);
        return [];
      }))();
    },
  };
}
