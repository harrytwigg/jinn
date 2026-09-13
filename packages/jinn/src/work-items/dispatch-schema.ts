import type { Database as DatabaseType } from "better-sqlite3";

/** ICI-733: how a Todo is RUN, as opposed to what it says. Which skills its
 *  working session preloads, and which engine/model the NEXT attempt uses —
 *  the recovery lever that moves a rate-limited Todo to another engine without
 *  re-describing the work.
 *
 *  Additive, never columns on `work_items`: the exact-shape verifier refuses any
 *  drift in an existing table, so a new table is the only extension a deployed
 *  database can survive.
 *
 *  `skills` is a JSON array of skill names read through a fail-closed parser,
 *  like `work_item_approval_choices.options`. A row exists only once something
 *  has been set, so absence means "no dispatch preferences" and needs no
 *  sentinel value. */
export const WORK_ITEM_DISPATCH_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_dispatch (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  skills       TEXT,
  engine       TEXT,
  model        TEXT,
  updated_at   TEXT NOT NULL
)`;

export const WORK_ITEM_DISPATCH_DDL = `
${WORK_ITEM_DISPATCH_TABLE_DDL};
`;

/** GEN-67: whether a Todo may be auto-started by a `todo-status` Workflow
 *  trigger when it is assigned. The instance's auto-start Workflow spawns the
 *  assignee's session on backlog→assigned; a Todo an employee creates and
 *  self-assigns from a session that is already working it wants NO second
 *  session, and so does one the operator intends to hand over by message.
 *
 *  Its own table rather than a column on `work_item_dispatch`, for the same
 *  reason that table is not a column on `work_items`: the exact-shape verifier
 *  refuses drift in an existing table, so an additive table is the only shape a
 *  deployed database can grow into. A row exists only once something has been
 *  set; absence reads as auto-start allowed. It is surfaced as `autoStart` on
 *  the Todo's dispatch config, where the other "how this Todo runs" knobs live. */
export const WORK_ITEM_AUTO_START_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_auto_start (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  auto_start   INTEGER NOT NULL CHECK (auto_start IN (0, 1)),
  updated_at   TEXT NOT NULL
)`;

export const WORK_ITEM_AUTO_START_DDL = `
${WORK_ITEM_AUTO_START_TABLE_DDL};
`;

/** ICI-733: one row per caller-supplied create key, so a cron or connector that
 *  retries a create gets the Todo it already made instead of a duplicate.
 *  `(source, source_ref)` already dedupes machine mints, but it is server-minted
 *  and the trigger paths do not set it usefully — hence an explicit key.
 *
 *  `fingerprint` is what makes a replay honest: the same key carrying a
 *  materially different create is a caller bug, and answering it with the first
 *  Todo would silently drop the second. Mirrors `work_item_edit_receipts`. */
export const WORK_ITEM_CREATE_RECEIPTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS work_item_create_receipts (
  key_digest   TEXT PRIMARY KEY CHECK (length(key_digest) = 64),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  fingerprint  TEXT NOT NULL,
  created_at   TEXT NOT NULL
)`;

export const WORK_ITEM_CREATE_RECEIPTS_DDL = `
${WORK_ITEM_CREATE_RECEIPTS_TABLE_DDL};
`;

interface DispatchVerifyRow {
  work_item_id: string;
  skills: string | null;
  engine: string | null;
  model: string | null;
}

/**
 * Data-level re-proof of the dispatch rows at boot (the DDL pins the shape, this
 * pins the rows): every row belongs to a live Todo, a stored skills list still
 * parses as an array of non-empty strings, and an engine/model that is present
 * is not a blank string. Returns false rather than throwing so the caller keeps
 * the single curated refusal message.
 */
export function workItemDispatchRowsAreSound(db: DatabaseType, hasWorkItem: (id: string) => boolean): boolean {
  const rows = db.prepare("SELECT work_item_id, skills, engine, model FROM work_item_dispatch")
    .all() as DispatchVerifyRow[];
  for (const row of rows) {
    if (!hasWorkItem(row.work_item_id)) return false;
    if (row.skills !== null && parseSkillsJson(row.skills) === null) return false;
    for (const value of [row.engine, row.model]) {
      if (value !== null && value.trim() === "") return false;
    }
  }
  return true;
}

/** Data-level re-proof of the auto-start rows: every row belongs to a live Todo
 *  (the CHECK constraint already pins the flag itself). */
export function workItemAutoStartRowsAreSound(db: DatabaseType, hasWorkItem: (id: string) => boolean): boolean {
  const ids = db.prepare("SELECT work_item_id FROM work_item_auto_start").pluck().all() as string[];
  return ids.every((id) => hasWorkItem(id));
}

/**
 * Data-level re-proof of the create receipts: every receipt points at a Todo
 * that still exists, so a replay can never resolve to nothing.
 */
export function workItemCreateReceiptRowsAreSound(db: DatabaseType, hasWorkItem: (id: string) => boolean): boolean {
  const ids = db.prepare("SELECT work_item_id FROM work_item_create_receipts").pluck().all() as string[];
  return ids.every((id) => hasWorkItem(id));
}

/** The stored skills list, or null when the blob is unreadable — one parser for
 *  the boot verifier and the read path, so neither can accept what the other
 *  rejects. */
export function parseSkillsJson(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((value) => typeof value === "string" && value.trim() !== "")) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}
