import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Throwaway registry (SESSIONS_DB resolves from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-transitions-"));
process.env.JINN_HOME = tmp;

type Store = typeof import("../store.js");
type Transitions = typeof import("../transitions.js");
type Registry = typeof import("../../sessions/registry.js");

let store: Store;
let tr: Transitions;
let registry: Registry;
let db: import("better-sqlite3").Database;

beforeAll(async () => {
  store = await import("../store.js");
  tr = await import("../transitions.js");
  registry = await import("../../sessions/registry.js");
  db = (await import("../../shared/db.js")).initDb();
});

const mk = (status: Store["createWorkItem"] extends (i: infer I) => unknown ? (I extends { status?: infer S } ? S : never) : never, extra: Partial<Parameters<Store["createWorkItem"]>[0]> = {}) =>
  store.createWorkItem({ title: `t-${Math.random().toString(36).slice(2, 8)}`, status, ...extra });

describe("transition — the guarded edge map", () => {
  it.each(["backlog", "assigned"] as const)("allows an operator to manually start %s work", (status) => {
    const wi = mk(status);
    const { item } = tr.transition(wi.id, "executing", "operator", { human: true, manual: true });

    expect(item.status).toBe("executing");
    expect(store.listWorkItemEvents(wi.id).at(-1)).toMatchObject({
      kind: "status_change",
      fromStatus: status,
      toStatus: "executing",
      actor: "operator",
    });
  });

  it.each(["done", "cancelled", "in_review"] as const)("rejects a manual start from %s", (status) => {
    const wi = mk(status);

    expect(() => tr.transition(wi.id, "executing", "operator", { human: true, manual: true })).toThrowError(
      new RegExp(`illegal manual transition ${status} → executing`),
    );
    expect(store.getWorkItem(wi.id)?.status).toBe(status);
  });

  it.each([
    ["blocked", "executing"],
    ["in_review", "executing"],
    ["executing", "assigned"],
  ] as const)("lets the agent lane walk %s → %s, which the edge map does not declare", (from, to) => {
    const wi = mk(from);

    expect(tr.transition(wi.id, to, "session:agent-1", { manual: true, agent: true }).item.status).toBe(to);
  });

  it.each(["done", "cancelled", "escalated"] as const)("still refuses the agent lane an exit from %s", (status) => {
    const wi = mk(status);

    expect(() => tr.transition(wi.id, "executing", "session:agent-1", { manual: true, agent: true })).toThrowError(
      /leaving a sticky terminal is a human decision/,
    );
    expect(store.getWorkItem(wi.id)?.status).toBe(status);
  });

  it.each(["in_review", "done", "blocked"] as const)("keeps manual executing → %s legal", (status) => {
    const wi = mk("backlog");
    tr.transition(wi.id, "executing", "operator", { human: true, manual: true });

    expect(tr.transition(wi.id, status, "operator", { human: true, manual: true }).item.status).toBe(status);
  });

  it("moves along declared edges and appends a status_change event with actor + detail", () => {
    const wi = mk("backlog");
    const { item, escalated } = tr.transition(wi.id, "assigned", "coo", { detail: { assignee: "ana" } });
    expect(item.status).toBe("assigned");
    expect(escalated).toBe(false);
    const events = store.listWorkItemEvents(wi.id);
    expect(events.at(-1)).toMatchObject({
      kind: "status_change",
      fromStatus: "backlog",
      toStatus: "assigned",
      actor: "coo",
      detail: { assignee: "ana" },
    });
  });

  it("THROWS on an undeclared edge and writes nothing (illegal transition rejected)", () => {
    const wi = mk("executing");
    expect(() => tr.transition(wi.id, "assigned", "anyone")).toThrowError(/illegal transition executing → assigned/);
    expect(store.getWorkItem(wi.id)?.status).toBe("executing");
    // No status_change event was appended for the refused edge.
    expect(store.listWorkItemEvents(wi.id).filter((e) => e.kind === "status_change")).toHaveLength(0);
  });

  it("throws not-found for an unknown item and is a silent no-op for same-status", () => {
    expect(() => tr.transition("JIN-999", "done", "x")).toThrowError(/not found/);
    const wi = mk("blocked");
    const before = store.listWorkItemEvents(wi.id).length;
    const { item } = tr.transition(wi.id, "blocked", "x");
    expect(item.status).toBe("blocked");
    expect(store.listWorkItemEvents(wi.id)).toHaveLength(before); // no event for a no-op
  });

  it("sticky terminals (done/cancelled/escalated) are left only under human authority", () => {
    for (const sticky of ["done", "cancelled", "escalated"] as const) {
      const wi = mk(sticky);
      expect(() => tr.transition(wi.id, "backlog", "reconciler")).toThrowError(/human decision/);
      expect(store.getWorkItem(wi.id)?.status).toBe(sticky);
      const { item } = tr.transition(wi.id, "backlog", "operator", { human: true });
      expect(item.status).toBe("backlog");
      expect(item.closedAt).toBeNull(); // reopening clears closed_at
    }
  });

  it("stamps closed_at when entering done and preserves an existing one (COALESCE)", () => {
    const wi = mk("in_review");
    const { item } = tr.transition(wi.id, "done", "reviewer");
    expect(item.closedAt).not.toBeNull();
  });

  it("SELF-REVIEW BAN: a linked execution attempt cannot mark its own item done; a linked workflow phase can", () => {
    const wi = mk("in_review");
    const executor = registry.createSession({ engine: "claude", source: "web", sourceRef: "execution-attempt" });
    store.linkSession(wi.id, executor.id);

    expect(() => tr.transition(wi.id, "done", "employee", { callerSessionId: executor.id })).toThrowError(
      /self-review ban/,
    );
    expect(store.getWorkItem(wi.id)?.status).toBe("in_review");

    const phaseItem = mk("in_review");
    const phase = registry.createSession({
      engine: "codex",
      source: "workflow",
      sourceRef: "workflow:review-flow:run-1:verify:1",
      workflowProvenance: {
        kind: "phase",
        workflowId: "review-flow",
        workflowName: "Review flow",
        runId: "run-1",
        triggerSource: "todo-status",
        phase: { nodeId: "verify", name: "Verify", index: 2, round: 1, attempt: 1 },
      },
    });
    store.linkSession(phaseItem.id, phase.id);

    const { item } = tr.transition(phaseItem.id, "done", "reviewer", { callerSessionId: phase.id });
    expect(item.status).toBe("done");

    // DAH-214 item 1: so can a session linked for REVIEW. It was delegated the
    // review of work it did not produce, and closing that work is the whole
    // point of it being there.
    const reviewedItem = mk("in_review");
    const reviewer = registry.createSession({ engine: "claude", source: "web", sourceRef: "review-attempt" });
    store.linkSession(reviewedItem.id, reviewer.id, null, "review");

    const reviewed = tr.transition(reviewedItem.id, "done", "reviewer", { callerSessionId: reviewer.id });
    expect(reviewed.item.status).toBe("done");
  });

  it("fires the registered todo-status-change listener with the committed event id after a status change", () => {
    const wi = mk("executing", { source: "human", department: "platform", assignee: "reviewer" });
    const seen: unknown[] = [];
    tr.setTodoStatusChangeListener((event) => {
      seen.push(event);
    });
    try {
      const { event } = tr.transition(wi.id, "in_review", "reviewer");
      expect(event?.id).toMatch(/^wie_/);
      expect(seen).toEqual([
        expect.objectContaining({
          id: event?.id,
          workItemId: wi.id,
          fromStatus: "executing",
          toStatus: "in_review",
          item: expect.objectContaining({ id: wi.id, status: "in_review", source: "human" }),
        }),
      ]);
    } finally {
      tr.setTodoStatusChangeListener(null);
    }
  });

  it("assignment backlog → assigned fires the registered todo-status-change listener live", () => {
    const wi = mk("backlog");
    const seen: unknown[] = [];
    tr.setTodoStatusChangeListener((event) => {
      seen.push(event);
    });
    try {
      const assigned = tr.assignWorkItem(wi.id, "platform-worker", "platform", "platform-manager");
      expect(assigned?.status).toBe("assigned");
      expect(assigned?.assignee).toBe("platform-worker");
      expect(seen).toEqual([
        expect.objectContaining({
          workItemId: wi.id,
          fromStatus: "backlog",
          toStatus: "assigned",
          actor: "platform-manager",
          item: expect.objectContaining({ id: wi.id, status: "assigned", assignee: "platform-worker" }),
        }),
      ]);
    } finally {
      tr.setTodoStatusChangeListener(null);
    }
  });

  it("atomically snapshots post-assignment provenance into an assignment-caused status event", () => {
    const wi = mk("backlog", { source: "delegation", department: "old", assignee: "old-owner" });

    tr.assignWorkItem(wi.id, "platform-worker", "platform", "platform-manager");

    expect(store.listWorkItemEvents(wi.id).at(-1)).toMatchObject({
      kind: "status_change",
      fromStatus: "backlog",
      toStatus: "assigned",
      detail: {
        todoProvenance: {
          source: "delegation",
          department: "platform",
          assignee: "platform-worker",
        },
      },
    });
  });

  it("keeps the transition and event committed when the listener throws (best-effort fire hook)", () => {
    const wi = mk("executing");
    tr.setTodoStatusChangeListener(() => {
      throw new Error("workflow engine unavailable");
    });
    try {
      const { event } = tr.transition(wi.id, "in_review", "reviewer");
      expect(store.getWorkItem(wi.id)?.status).toBe("in_review");
      expect(store.listWorkItemEvents(wi.id).at(-1)?.id).toBe(event?.id);
    } finally {
      tr.setTodoStatusChangeListener(null);
    }
  });
});

describe("transition — the bounce rule (rounds + max-rounds escalation)", () => {
  it("a bounce increments rounds and returns to executing below the ceiling", () => {
    const wi = store.createWorkItem({
      title: "bounced",
      status: "in_review",
      verifyPolicy: { mode: "verify", maxRounds: 3 },
    });
    const r1 = tr.transition(wi.id, "executing", "reviewer", { bounce: true, detail: { critique: "fix X" } });
    expect(r1.item.status).toBe("executing");
    expect(r1.item.rounds).toBe(1);
    expect(r1.escalated).toBe(false);
    const last = store.listWorkItemEvents(wi.id).at(-1)!;
    expect(last).toMatchObject({ kind: "status_change", detail: { bounce: true, rounds: 1, critique: "fix X" } });
  });

  it("the bounce that reaches maxRounds ESCALATES instead of looping, with an 'escalated' event", () => {
    const wi = store.createWorkItem({
      title: "loop killer",
      status: "in_review",
      verifyPolicy: { mode: "verify", maxRounds: 2 },
    });
    db.prepare("UPDATE work_items SET rounds = 1 WHERE id = ?").run(wi.id); // one bounce already burned
    const r = tr.transition(wi.id, "executing", "reviewer", { bounce: true });
    expect(r.escalated).toBe(true);
    expect(r.item.status).toBe("escalated");
    expect(r.item.rounds).toBe(2);
    const last = store.listWorkItemEvents(wi.id).at(-1)!;
    expect(last).toMatchObject({
      kind: "escalated",
      fromStatus: "in_review",
      toStatus: "escalated",
      detail: { reason: "max-rounds-exhausted", maxRounds: 2 },
    });
  });

  it("a plain (non-bounce) in_review → executing does NOT touch rounds", () => {
    const wi = mk("in_review");
    const { item } = tr.transition(wi.id, "executing", "reconciler");
    expect(item.rounds).toBe(0);
  });

  it("provenance default maxRounds applies when the policy sets none (delegation → 2)", () => {
    const wi = store.createWorkItem({ title: "default rounds", status: "in_review", source: "delegation", sourceRef: "delegate:t:1" });
    tr.transition(wi.id, "executing", "reviewer", { bounce: true });
    tr.transition(wi.id, "in_review", "worker");
    const r2 = tr.transition(wi.id, "executing", "reviewer", { bounce: true });
    expect(r2.escalated).toBe(true);
    expect(r2.item.status).toBe("escalated");
  });
});

describe("transitionDerived — the reconciler's best-effort wrapper", () => {
  it("returns the item on success and undefined on a sticky/illegal race instead of throwing", () => {
    const wi = mk("backlog");
    expect(tr.transitionDerived(wi.id, "executing", "reconciler")?.status).toBe("executing");
    const sticky = mk("escalated");
    expect(tr.transitionDerived(sticky.id, "executing", "reconciler")).toBeUndefined();
    expect(store.getWorkItem(sticky.id)?.status).toBe("escalated");
  });
});
