import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { WORK_ITEM_AUTO_START_DDL } from "../dispatch-schema.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-auto-start-schema-"));
process.env.JINN_HOME = tmp;

type Migrate = typeof import("../migrate.js");
let migrate: Migrate;

beforeAll(async () => {
  migrate = await import("../migrate.js");
});

const shape = (sql: string | undefined) =>
  (sql ?? "").replace(/\bIF\s+NOT\s+EXISTS\b/gi, "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();

function freshDatabase(name: string): { file: string; db: import("better-sqlite3").Database } {
  const file = path.join(tmp, name);
  const db = new Database(file);
  migrate.migrateWorkItemsSchema(db, "absent");
  return { file, db };
}

function storedSql(db: import("better-sqlite3").Database, table: string): string | undefined {
  return (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined)?.sql;
}

/* GEN-67 lands in a new table, never a column on `work_item_dispatch` or
 * `work_items`: `verifyCurrentWorkItemSchema` compares every stored table DDL
 * byte-for-byte, so a column would make every deployed database refuse to
 * boot. This is the deploy-risk test: a 0.33.3 database is exactly "fresh with
 * this table dropped". */
describe("work_item_auto_start is additive", () => {
  it("is created on a fresh database at its frozen shape, and verifies", () => {
    const { db } = freshDatabase("fresh.db");
    expect(shape(storedSql(db, "work_item_auto_start"))).toBe(shape(WORK_ITEM_AUTO_START_DDL));
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).not.toThrow();
    db.close();
  });

  it("heals a database that predates the table: classified current, table gained, work_items untouched", () => {
    const { file, db } = freshDatabase("heal.db");
    db.exec("DROP TABLE work_item_auto_start");
    const workItemsBefore = storedSql(db, "work_items");
    const dispatchBefore = storedSql(db, "work_item_dispatch");
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
    db.close();

    expect(migrate.preflightWorkItemsDatabase(file)).toBe("current");

    const healed = new Database(file);
    expect(migrate.migrateWorkItemsSchema(healed, "current").rebuilt).toBe(false);
    expect(storedSql(healed, "work_item_auto_start")).toBeTypeOf("string");
    expect(storedSql(healed, "work_items")).toBe(workItemsBefore);
    expect(storedSql(healed, "work_item_dispatch")).toBe(dispatchBefore);
    expect(() => migrate.verifyCurrentWorkItemSchema(healed)).not.toThrow();
    healed.close();
  });

  it("refuses at preflight when the table is present at a different shape", () => {
    const { file, db } = freshDatabase("drift.db");
    db.exec("DROP TABLE work_item_auto_start");
    db.exec("CREATE TABLE work_item_auto_start (work_item_id TEXT PRIMARY KEY)");
    db.close();
    expect(() => migrate.preflightWorkItemsDatabase(file)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
  });

  it("refuses a row that names no live Todo", () => {
    const { db } = freshDatabase("orphan.db");
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO work_item_auto_start (work_item_id, auto_start, updated_at) VALUES ('JIN-999', 0, '2026-01-01T00:00:00.000Z')").run();
    expect(() => migrate.verifyCurrentWorkItemSchema(db)).toThrow(migrate.UNSUPPORTED_PRERELEASE_TODO_DATA);
    db.close();
  });
});
