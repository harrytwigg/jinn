import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-create-idempotency-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Idempotency = typeof import("../create-idempotency.js");
let store: Store;
let idempotency: Idempotency;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  db = (await import("../../shared/db.js")).initDb();
  store = await import("../store.js");
  idempotency = await import("../create-idempotency.js");
});

function rowsTitled(title: string): number {
  return Number(db.prepare("SELECT COUNT(*) FROM work_items WHERE title = ?").pluck().get(title));
}

function createdEvents(id: string): number {
  return Number(db.prepare("SELECT COUNT(*) FROM work_item_events WHERE work_item_id = ? AND kind = 'created'").pluck().get(id));
}

describe("createWorkItemIdempotent", () => {
  it("returns the first Todo on a repeat of the same key, and writes nothing the second time", () => {
    const input = { title: "cron fire 09:00", body: "the same intent", source: "cron" as const };

    const first = idempotency.createWorkItemIdempotent(input, "cron:nightly:2026-08-13T09:00");
    const second = idempotency.createWorkItemIdempotent(input, "cron:nightly:2026-08-13T09:00");

    expect(second.item.id).toBe(first.item.id);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(rowsTitled("cron fire 09:00")).toBe(1);
    // A replay is not a second create, so it does not re-append the event either.
    expect(createdEvents(first.item.id)).toBe(1);
  });

  it("creates a second Todo for a different key, same payload", () => {
    const input = { title: "cron fire 10:00", source: "cron" as const };

    const first = idempotency.createWorkItemIdempotent(input, "cron:nightly:2026-08-13T10:00");
    const second = idempotency.createWorkItemIdempotent(input, "cron:nightly:2026-08-13T11:00");

    expect(second.item.id).not.toBe(first.item.id);
    expect(rowsTitled("cron fire 10:00")).toBe(2);
  });

  it("raises a conflict when the same key carries a materially different create", () => {
    const key = "connector:slack:msg-9001";
    const first = idempotency.createWorkItemIdempotent({ title: "handle the refund", source: "connector" }, key);

    expect(() => idempotency.createWorkItemIdempotent({ title: "something else entirely", source: "connector" }, key))
      .toThrow(idempotency.WorkItemCreateIdempotencyConflictError);

    // The conflict names the Todo the key already made, so the caller can look
    // at it rather than guess, and no second row was written.
    try {
      idempotency.createWorkItemIdempotent({ title: "something else entirely", source: "connector" }, key);
    } catch (error) {
      expect((error as InstanceType<Idempotency["WorkItemCreateIdempotencyConflictError"]>).workItemId).toBe(first.item.id);
    }
    expect(rowsTitled("something else entirely")).toBe(0);
  });

  it("treats any material field as material, not just the title", () => {
    const key = "connector:slack:msg-9002";
    idempotency.createWorkItemIdempotent({ title: "same title", assignee: "a-lead", source: "connector" }, key);

    expect(() => idempotency.createWorkItemIdempotent({ title: "same title", assignee: "b-lead", source: "connector" }, key))
      .toThrow(idempotency.WorkItemCreateIdempotencyConflictError);
  });

  it("counts the labels a create asked for, but not the order they arrived in", () => {
    const key = "connector:slack:msg-9003";
    const input = { title: "tagged create", source: "connector" as const };
    const first = idempotency.createWorkItemIdempotent(input, key, { labels: ["urgent", "billing"] });

    expect(() => idempotency.createWorkItemIdempotent(input, key, { labels: ["billing"] }))
      .toThrow(idempotency.WorkItemCreateIdempotencyConflictError);
    // A label set is a set: the same names in another order is the same create.
    const reordered = idempotency.createWorkItemIdempotent(input, key, { labels: ["billing", "urgent"] });
    expect(reordered.replayed).toBe(true);
    expect(reordered.item.id).toBe(first.item.id);
  });

  it("counts the auto-start opt-out, and only the opt-out, so pre-existing receipts still replay", () => {
    const key = "connector:slack:msg-9004";
    const input = { title: "opt-out create", source: "connector" as const };
    const first = idempotency.createWorkItemIdempotent(input, key);

    // A retry that flips the flag would leave the Todo auto-starting with no
    // sign anything was asked for; it has to be refused like a flipped label set.
    expect(() => idempotency.createWorkItemIdempotent(input, key, { autoStart: false }))
      .toThrow(idempotency.WorkItemCreateIdempotencyConflictError);
    // `true` is what absence means, so saying it is not a different create.
    const explicit = idempotency.createWorkItemIdempotent(input, key, { autoStart: true });
    expect(explicit.replayed).toBe(true);
    expect(explicit.item.id).toBe(first.item.id);
  });

  it("leaves keyless creates alone: two identical ones are two Todos", () => {
    store.createWorkItem({ title: "no key here", source: "human" });
    store.createWorkItem({ title: "no key here", source: "human" });
    expect(rowsTitled("no key here")).toBe(2);
  });

  it("does not burn a Todo ID on a replay", () => {
    const key = "cron:nightly:2026-08-13T12:00";
    idempotency.createWorkItemIdempotent({ title: "id burn check", source: "cron" }, key);
    const burnedAfterFirst = Number(db.prepare("SELECT COUNT(*) FROM work_item_id_burns").pluck().get());

    idempotency.createWorkItemIdempotent({ title: "id burn check", source: "cron" }, key);

    expect(Number(db.prepare("SELECT COUNT(*) FROM work_item_id_burns").pluck().get())).toBe(burnedAfterFirst);
  });
});
