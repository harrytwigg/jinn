import { describe, it, expect } from "vitest";
import { api, ctx, makeReq, makeRes, operatorHeaders, reg, store, toolHeaders } from "./helpers/work-items-route-harness.js";

/* Status is the one Todo write open to every authenticated session: the
 * relationship graph that used to gate it (creator / assignee / assignee's
 * manager / bound workflow run) is gone, and only `done` and `cancelled` stay
 * closed. */
describe("POST /api/work-items/:id/status — open to any authenticated session", () => {
  /** No relation to the Todo under test: not its creator, assignee, assignee's
   *  manager, linked execution attempt, or the run of any workflow. */
  function strangerSession(sourceRef: string) {
    return reg.createSession({ engine: "codex", source: "web", sourceRef, employee: "solo-worker" });
  }

  async function post(itemId: string, body: unknown, headers: Record<string, string>) {
    const cap = makeRes();
    await api.handleApiRequest(makeReq("POST", `/api/work-items/${itemId}/status`, body, headers), cap.res, ctx);
    return cap;
  }

  // The edge map used to govern this lane too, so the agent that unstuck a
  // blocked Todo could not put it back to work, and `assigned` had no agent
  // lane at all. Within the target allowlist the graph now stops applying, and
  // the only body a stranger still has to supply is the note blocked and
  // escalated demand — plus, since PLA-157, the hint an escalation needs.
  it.each([
    ["assigned", "executing", { status: "executing", note: "reporting from elsewhere" }],
    ["assigned", "in_review", { status: "in_review", note: "reporting from elsewhere" }],
    ["assigned", "blocked", { status: "blocked", note: "reporting from elsewhere" }],
    ["assigned", "escalated", { status: "escalated", note: "reporting from elsewhere", unblockHint: { what: "decide the next move", who: "the operator" } }],
    ["blocked", "executing", { status: "executing" }],
    ["in_review", "executing", { status: "executing" }],
    ["executing", "assigned", { status: "assigned" }],
    ["in_review", "assigned", { status: "assigned" }],
  ] as const)("lets an unrelated employee session move a Todo %s → %s", async (from, target, body) => {
    const item = store.createWorkItem({ title: `Stranger moves ${from} to ${target}`, status: from, assignee: "platform-worker" });
    const cap = await post(item.id, body, toolHeaders(strangerSession(`stranger-${from}-${target}`).id));

    expect([cap.status, cap.body.workItem?.status]).toEqual([200, target]);
  });

  it("lets an unrelated session close an in-review Todo, while cancelled stays operator-only", async () => {
    const item = store.createWorkItem({ title: "Stranger can review", status: "in_review", assignee: "platform-worker" });
    const session = strangerSession("open-status-closed-targets");

    const done = await post(item.id, { status: "done" }, toolHeaders(session.id));
    expect([done.status, done.body.workItem?.status]).toEqual([200, "done"]);

    const live = store.createWorkItem({ title: "Stranger cannot cancel", status: "assigned", assignee: "platform-worker" });
    const cancelled = await post(live.id, { status: "cancelled" }, toolHeaders(session.id));
    expect(cancelled.status).toBe(403);
    expect(cancelled.body.error).toMatch(/human surface decision/i);
    expect(store.getWorkItem(live.id)?.status).toBe("assigned");
  });

  it("keeps the self-review ban for a linked execution attempt but excludes a linked workflow phase", async () => {
    const reviewer = reg.createSession({ engine: "codex", source: "web", sourceRef: "open-status-reviewer" });
    const executor = reg.createSession({ engine: "codex", source: "web", sourceRef: "open-status-executor", parentSessionId: reviewer.id });
    const item = store.createWorkItem({
      title: "Self-review still banned",
      status: "executing",
      source: "delegation",
      sourceRef: `delegate:${reviewer.id}:open-status`,
    });
    store.linkSession(item.id, executor.id);

    const handed = await post(item.id, { status: "in_review" }, toolHeaders(executor.id));
    expect(handed.status).toBe(200);

    const selfClose = await post(item.id, { status: "done" }, toolHeaders(executor.id));
    expect(selfClose.status).toBe(403);
    expect(selfClose.body.error).toMatch(/self-review ban/i);
    expect(store.getWorkItem(item.id)?.status).toBe("in_review");

    const phase = reg.createSession({
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
    const phaseItem = store.createWorkItem({ title: "Workflow phase reviews", status: "in_review" });
    store.linkSession(phaseItem.id, phase.id);

    const phaseClose = await post(phaseItem.id, { status: "done" }, toolHeaders(phase.id));
    expect([phaseClose.status, store.getWorkItem(phaseItem.id)?.status]).toEqual([200, "done"]);
  });

  // DAH-214 item 1. A reviewer delegated onto an `in_review` Todo is linked to
  // it — that is how their rounds are attributed and their comments route — and
  // the ban used to read any link as "you executed this", refusing the reviewer
  // the one transition they exist to make. The link now records WHY.
  it("lets a session linked for review close the Todo, while the producer stays banned", async () => {
    const producer = reg.createSession({ engine: "codex", source: "web", sourceRef: "review-link-producer" });
    const reviewer = reg.createSession({ engine: "codex", source: "web", sourceRef: "review-link-reviewer" });
    const item = store.createWorkItem({ title: "Reviewer closes", status: "in_review", assignee: "platform-worker" });
    store.linkSession(item.id, producer.id);
    store.linkSession(item.id, reviewer.id, null, "review");

    const selfClose = await post(item.id, { status: "done" }, toolHeaders(producer.id));
    expect(selfClose.status).toBe(403);
    expect(selfClose.body.error).toMatch(/self-review ban/i);

    const reviewClose = await post(item.id, { status: "done" }, toolHeaders(reviewer.id));
    expect([reviewClose.status, store.getWorkItem(item.id)?.status]).toEqual([200, "done"]);
  });

  it.each(["backlog", "assigned", "executing", "blocked"] as const)(
    "still refuses an unrelated session done from %s",
    async (status) => {
      const item = store.createWorkItem({ title: `No done shortcut from ${status}`, status });
      const session = strangerSession(`done-precondition-${status}`);

      const done = await post(item.id, { status: "done" }, toolHeaders(session.id));

      expect(done.status).toBe(403);
      expect(done.body.error).toMatch(/done is not an agent shortcut/i);
      expect(store.getWorkItem(item.id)?.status).toBe(status);
    },
  );

  it("leaves the operator lanes unaffected: POST done closes, PUT cancels", async () => {
    const reviewed = store.createWorkItem({ title: "Operator closes", status: "in_review" });
    const done = await post(reviewed.id, { status: "done" }, operatorHeaders);
    expect([done.status, done.body.workItem.status]).toEqual([200, "done"]);

    const live = store.createWorkItem({ title: "Operator cancels", status: "assigned" });
    const cancelled = makeRes();
    await api.handleApiRequest(
      makeReq("PUT", `/api/work-items/${live.id}/status`, { status: "cancelled" }, operatorHeaders),
      cancelled.res,
      ctx,
    );
    expect([cancelled.status, cancelled.body.workItem.status]).toEqual([200, "cancelled"]);
  });
});
