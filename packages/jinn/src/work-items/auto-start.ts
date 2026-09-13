import type { Database as DatabaseType } from 'better-sqlite3';

/** GEN-67: the per-Todo auto-start opt-out, as rows. The table is declared in
 *  `dispatch-schema.ts` and the flag is surfaced through the Todo's dispatch
 *  config; this module is the one reader and writer of the rows, kept free of
 *  the dispatch module's heavier imports so the workflow event feed can ask
 *  the question without pulling the model registry along. */

export interface AutoStartRow {
  auto_start: 0 | 1;
  updated_at: string;
}

export function readAutoStartRow(db: DatabaseType, workItemId: string): AutoStartRow | undefined {
  return db
    .prepare('SELECT auto_start, updated_at FROM work_item_auto_start WHERE work_item_id = ?')
    .get(workItemId) as AutoStartRow | undefined;
}

/** Whether a `todo-status` trigger may auto-start this Todo: false only when
 *  the Todo has explicitly opted out. A Todo with no row, or one that no longer
 *  exists, reads as allowed — the trigger service has its own answer for a
 *  vanished Todo and must not mistake absence for an opt-out. */
export function todoAutoStartAllowed(db: DatabaseType, workItemId: string): boolean {
  return readAutoStartRow(db, workItemId)?.auto_start !== 0;
}

export function writeAutoStartRow(db: DatabaseType, workItemId: string, autoStart: boolean, updatedAt: string): void {
  db.prepare(
    `INSERT INTO work_item_auto_start (work_item_id, auto_start, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET auto_start = excluded.auto_start, updated_at = excluded.updated_at`,
  ).run(workItemId, autoStart ? 1 : 0, updatedAt);
}
