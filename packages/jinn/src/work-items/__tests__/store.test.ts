import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { costOfUsage } from "../../shared/model-pricing.js";

// Point the registry DB at a throwaway dir BEFORE importing it (SESSIONS_DB is
// resolved from JINN_HOME at module load). This keeps the suite off the live DB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Reg = typeof import("../../sessions/registry.js");
let store: Store;
let reg: Reg;
let db: import("better-sqlite3").Database;

function insertSession(id: string, engine = "claude"): void {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity)
     VALUES (?, ?, 'cron', ?, 'idle', ?, ?)`,
  ).run(id, engine, `cron:${id}`, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
}

beforeAll(async () => {
  store = await import("../store.js");
  reg = await import("../../sessions/registry.js");
  db = (await import("../../shared/db.js")).initDb();
});

describe("work-item store — schema", () => {
  it("creates the work_items table and the sessions.work_item_id column in initDb", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'")
      .all();
    expect(tables.length).toBe(1);
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(new Set(cols.map((c) => c.name)).has("work_item_id")).toBe(true);
  });
});

describe("work-item store — create / get / list", () => {
  it("creates an item with sane defaults and reads it back", () => {
    const wi = store.createWorkItem({ title: "Design the dispatcher" });
    expect(wi.id).toMatch(/^JIN-[1-9][0-9]*$/);
    expect(wi.status).toBe("backlog");
    expect(wi.priority).toBe(2);
    expect(wi.source).toBe("human");
    expect(wi.version).toBe(1);
    expect(wi.closedAt).toBeNull();

    const fetched = store.getWorkItem(wi.id);
    expect(fetched).toMatchObject({ id: wi.id, title: "Design the dispatcher", status: "backlog", version: 1 });
  });

  it("filters listWorkItems by status / department / assignee", () => {
    store.createWorkItem({ title: "blocked one", status: "blocked", department: "alpha", assignee: "ana" });
    store.createWorkItem({ title: "other dept", status: "blocked", department: "beta", assignee: "bo" });

    const blocked = store.listWorkItems({ status: "blocked" });
    expect(blocked.length).toBeGreaterThanOrEqual(2);
    expect(blocked.every((w) => w.status === "blocked")).toBe(true);

    const alpha = store.listWorkItems({ department: "alpha" });
    expect(alpha.every((w) => w.department === "alpha")).toBe(true);
    expect(alpha.some((w) => w.title === "blocked one")).toBe(true);

    const ana = store.listWorkItems({ assignee: "ana" });
    expect(ana.every((w) => w.assignee === "ana")).toBe(true);
  });

  it("getWorkItem returns undefined for an unknown id", () => {
    expect(store.getWorkItem("JIN-999")).toBeUndefined();
  });
});

describe("work-item store — manual rank", () => {
  it("persists rank and orders ranked rows first within a filtered group", () => {
    const first = store.createWorkItem({ title: "rank first", status: "backlog", department: "rank-fixture" });
    const second = store.createWorkItem({ title: "rank second", status: "backlog", department: "rank-fixture" });
    const unranked = store.createWorkItem({ title: "rank unset", status: "backlog", department: "rank-fixture" });
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2032-01-01T00:00:00.000Z", unranked.id);

    expect(store.updateWorkItem(first.id, { rank: 10 }, "operator")?.rank).toBe(10);
    expect(store.updateWorkItem(second.id, { rank: 20 }, "operator")?.rank).toBe(20);

    const ordered = store.listWorkItems({ status: "backlog", department: "rank-fixture" });
    expect(ordered.map((item) => item.id)).toEqual([first.id, second.id, unranked.id]);
  });

  it("clearing rank returns a row to deterministic newest-first fallback ordering", () => {
    const older = store.createWorkItem({ title: "older unranked", status: "assigned", department: "rank-clear-fixture" });
    const newer = store.createWorkItem({ title: "newer unranked", status: "assigned", department: "rank-clear-fixture" });
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2030-01-01T00:00:00.000Z", older.id);
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2031-01-01T00:00:00.000Z", newer.id);

    store.updateWorkItem(older.id, { rank: 5 }, "operator");
    expect(store.listWorkItems({ status: "assigned", department: "rank-clear-fixture" })[0]?.id).toBe(older.id);

    store.updateWorkItem(older.id, { rank: null }, "operator");
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run("2030-01-01T00:00:00.000Z", older.id);
    const fallback = store.listWorkItems({ status: "assigned", department: "rank-clear-fixture" });
    expect(fallback.map((item) => item.id)).toEqual([newer.id, older.id]);
    expect(store.getWorkItem(older.id)?.rank).toBeNull();
  });
});

describe("work-item store — idempotent source_ref", () => {
  it("returns the existing row for a repeated (source, source_ref)", () => {
    const ref = "cron:job-x:1751328000000";
    const first = store.createWorkItem({ title: "fire 1", source: "cron", sourceRef: ref });
    const second = store.createWorkItem({ title: "fire 1 retry", source: "cron", sourceRef: ref });
    expect(second.id).toBe(first.id);
    // No duplicate row, and the title is the original (existing row returned as-is).
    const rows = db.prepare("SELECT * FROM work_items WHERE source = 'cron' AND source_ref = ?").all(ref);
    expect(rows.length).toBe(1);
    expect(second.title).toBe("fire 1");
  });

  it("allows many NULL source_ref items to coexist (partial unique index)", () => {
    const a = store.createWorkItem({ title: "manual a" });
    const b = store.createWorkItem({ title: "manual b" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("work-item store — CHECK constraints", () => {
  it("rejects an invalid status", () => {
    expect(() =>
      store.createWorkItem({ title: "bad", status: "open" as unknown as "backlog" }),
    ).toThrow();
  });

  it("rejects an out-of-range priority", () => {
    expect(() => store.createWorkItem({ title: "bad pri", priority: 9 })).toThrow();
  });

  it("rejects an invalid source", () => {
    expect(() =>
      store.createWorkItem({ title: "bad src", source: "manual" as unknown as "human" }),
    ).toThrow();
  });
});

describe("work-item store — linkSession + read-back (GRS-002 consumer path)", () => {
  it("links a session and lists it back via listSessionsByWorkItem", () => {
    insertSession("sess-link-1");
    const wi = store.createWorkItem({ title: "linked work", source: "cron", sourceRef: "cron:linkjob:1" });
    store.linkSession(wi.id, "sess-link-1");

    const sessions = reg.listSessionsByWorkItem(wi.id);
    expect(sessions.map((s) => s.id)).toContain("sess-link-1");

    const row = db.prepare("SELECT work_item_id FROM sessions WHERE id = 'sess-link-1'").get() as {
      work_item_id: string;
    };
    expect(row.work_item_id).toBe(wi.id);
  });

  it("is atomic: linking to a missing work item rolls back the session write", () => {
    insertSession("sess-link-2");
    expect(() => store.linkSession("JIN-999", "sess-link-2")).toThrow(/work item/);
    // The session update inside the same transaction must have rolled back.
    const row = db.prepare("SELECT work_item_id FROM sessions WHERE id = 'sess-link-2'").get() as {
      work_item_id: string | null;
    };
    expect(row.work_item_id).toBeNull();
  });

  it("throws when the session does not exist", () => {
    const wi = store.createWorkItem({ title: "no session" });
    expect(() => store.linkSession(wi.id, "sess-nope")).toThrow(/session/);
  });

  it("is idempotent-in-writes: re-linking the same pair does not bump updated_at (GRS-003b-2b)", () => {
    insertSession("sess-link-idem");
    const wi = store.createWorkItem({ title: "idem link", source: "cron", sourceRef: "cron:idemjob:1" });
    store.linkSession(wi.id, "sess-link-idem");

    // Stamp a sentinel updated_at that a real write could never reproduce, so the assertion
    // is deterministic (not vulnerable to a same-millisecond timestamp collision).
    const sentinel = "2020-01-01T00:00:00.000Z";
    db.prepare("UPDATE work_items SET updated_at = ? WHERE id = ?").run(sentinel, wi.id);

    // A redundant re-link (e.g. the guard-time bridge repair on a re-fire) must be a no-op write.
    store.linkSession(wi.id, "sess-link-idem");

    expect(store.getWorkItem(wi.id)!.updatedAt).toBe(sentinel);
    // The link itself is still intact.
    expect(reg.listSessionsByWorkItem(wi.id).map((s) => s.id)).toContain("sess-link-idem");
  });
});

describe("work-item store — raw status write door", () => {
  it("does not export updateStatus; lifecycle writes go through transitions", () => {
    expect("updateStatus" in store).toBe(false);
  });
});

describe("work-item store — GRS-021a Todo model fields", () => {
  it("round-trips acceptance, verifyPolicy, and budgetUsd; a fresh item carries NO approval", () => {
    const wi = store.createWorkItem({
      title: "elevated",
      acceptance: "- [ ] tests green",
      verifyPolicy: { mode: "thorough", verifier: { engine: "codex" }, maxRounds: 5 },
      budgetUsd: 12.5,
    });
    const fetched = store.getWorkItem(wi.id)!;
    expect(fetched.acceptance).toBe("- [ ] tests green");
    expect(fetched.verifyPolicy).toEqual({ mode: "thorough", verifier: { engine: "codex" }, maxRounds: 5 });
    expect(fetched.budgetUsd).toBe(12.5);
    expect(fetched.rounds).toBe(0);
    // The anti-bottleneck principle (design §1.3): approval is none, always, at create.
    expect(fetched.approvalState).toBeNull();
    expect(fetched.approvalRequest).toBeNull();
  });

  it("a corrupt stored verify_policy fails closed to VERIFY", () => {
    const wi = store.createWorkItem({ title: "corrupt policy" });
    db.prepare("UPDATE work_items SET verify_policy = 'not json{' WHERE id = ?").run(wi.id);
    expect(store.getWorkItem(wi.id)!.verifyPolicy).toEqual({ mode: "verify" });
    expect(store.effectiveVerifyMode(store.getWorkItem(wi.id)!)).toBe("verify");
  });

  it("effectiveVerifyMode / effectiveMaxRounds: explicit policy wins, else provenance defaults", () => {
    expect(store.effectiveVerifyMode({ verifyPolicy: null, source: "cron" })).toBe("trust");
    expect(store.effectiveVerifyMode({ verifyPolicy: null, source: "workflow" })).toBe("trust");
    expect(store.effectiveVerifyMode({ verifyPolicy: null, source: "delegation" })).toBe("verify");
    expect(store.effectiveVerifyMode({ verifyPolicy: null, source: "human" })).toBe("verify");
    expect(store.effectiveVerifyMode({ verifyPolicy: { mode: "thorough" }, source: "cron" })).toBe("thorough");
    expect(store.effectiveMaxRounds({ verifyPolicy: null, source: "delegation" })).toBe(2);
    expect(store.effectiveMaxRounds({ verifyPolicy: { mode: "thorough" }, source: "cron" })).toBe(3);
    expect(store.effectiveMaxRounds({ verifyPolicy: { mode: "verify", maxRounds: 7 }, source: "cron" })).toBe(7);
  });

  it("getWorkItemBySourceRef resolves machine-minted items by their stable key", () => {
    const wi = store.createWorkItem({ title: "run item", source: "workflow", sourceRef: "workflow:wf-1:run-9" });
    expect(store.getWorkItemBySourceRef("workflow", "workflow:wf-1:run-9")?.id).toBe(wi.id);
    expect(store.getWorkItemBySourceRef("workflow", "workflow:wf-1:run-none")).toBeUndefined();
  });

  it("listWorkItems filters by source", () => {
    store.createWorkItem({ title: "wf item", source: "workflow", sourceRef: "workflow:wf-2:run-1" });
    const byedSource = store.listWorkItems({ source: "workflow" });
    expect(byedSource.length).toBeGreaterThanOrEqual(1);
    expect(byedSource.every((w) => w.source === "workflow")).toBe(true);
  });

  it("getWorkItemSpend derives live spend from linked sessions' total_cost (never stored)", () => {
    const wi = store.createWorkItem({ title: "costed" });
    expect(store.getWorkItemSpend(wi.id)).toBe(0);
    for (const [id, cost] of [["sess-cost-1", 1.25], ["sess-cost-2", 0.5]] as const) {
      insertSession(id);
      db.prepare("UPDATE sessions SET total_cost = ? WHERE id = ?").run(cost, id);
      store.linkSession(wi.id, id);
    }
    expect(store.getWorkItemSpend(wi.id)).toBeCloseTo(1.75);
  });

  it("rolls two incremental Codex turn costs into a Codex-only Todo", () => {
    const wi = store.createWorkItem({ title: "Codex costed" });
    insertSession("sess-codex-cost", "codex");
    store.linkSession(wi.id, "sess-codex-cost");

    const first = costOfUsage("gpt-5.5", {
      inputTokens: 3_000,
      cachedInputTokens: 1_000,
      outputTokens: 500,
    })!;
    const second = costOfUsage("gpt-5.5", {
      inputTokens: 2_000,
      cachedInputTokens: 1_000,
      outputTokens: 400,
    })!;
    reg.recordTurnAccounting("sess-codex-cost", { cost: first, numTurns: 1 });
    reg.recordTurnAccounting("sess-codex-cost", { cost: second, numTurns: 1 });

    const expected = costOfUsage("gpt-5.5", {
      inputTokens: 5_000,
      cachedInputTokens: 2_000,
      outputTokens: 900,
    })!;
    expect(db.prepare("SELECT total_cost FROM sessions WHERE id = ?").pluck().get("sess-codex-cost")).toBe(expected);
    expect(store.getWorkItemSpend(wi.id)).toBe(expected);
  });

  it("the ifNotSticky guard also protects escalated (operator queue is never silently drained)", () => {
    const wi = store.createWorkItem({ title: "escalated sticky", status: "escalated" });
    expect(wi.status).toBe("escalated");
    expect(store.getWorkItem(wi.id)?.status).toBe("escalated");
  });
});

describe("work-item store — events (append-only audit)", () => {
  it("createWorkItem appends a 'created' event exactly once (idempotent repeat appends none)", () => {
    const ref = "cron:evt-job:1";
    const wi = store.createWorkItem({ title: "evented", source: "cron", sourceRef: ref });
    store.createWorkItem({ title: "evented retry", source: "cron", sourceRef: ref });
    const events = store.listWorkItemEvents(wi.id);
    expect(events.filter((e) => e.kind === "created")).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "created", toStatus: "backlog", actor: "cron", detail: { sourceRef: ref } });
  });

  it("linkSession appends 'session_linked' on a real write and none on the idempotent re-link", () => {
    insertSession("sess-evt-link");
    const wi = store.createWorkItem({ title: "link evented" });
    store.linkSession(wi.id, "sess-evt-link");
    store.linkSession(wi.id, "sess-evt-link"); // idempotent — no second event
    const linkEvents = store.listWorkItemEvents(wi.id).filter((e) => e.kind === "session_linked");
    expect(linkEvents).toHaveLength(1);
    expect(linkEvents[0].detail).toEqual({ sessionId: "sess-evt-link", role: "execute" });
  });

  it("listWorkItemEvents returns oldest-first and tolerates corrupt detail JSON", () => {
    const wi = store.createWorkItem({ title: "ordered events" });
    store.appendWorkItemEvent({ workItemId: wi.id, kind: "note", detail: { n: 1 } });
    store.appendWorkItemEvent({ workItemId: wi.id, kind: "note", detail: { n: 2 } });
    db.prepare("UPDATE work_item_events SET detail = 'broken{' WHERE work_item_id = ? AND detail LIKE '%\"n\":1%'").run(wi.id);
    const events = store.listWorkItemEvents(wi.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "note", "note"]);
    expect(events[1].detail).toBeNull(); // corrupt → null, never a crash
    expect(events[2].detail).toEqual({ n: 2 });
  });
});
