import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ServerResponse } from "node:http";
import type { WorkflowTodoEventClaimOutcome, WorkflowTodoEventFeed, WorkflowTodoStatusEvent }
  from "../../work-items/workflow-event-feed.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import type { WorkflowRepository } from "../repository.js";
import type { WorkflowRunner } from "../runner.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-respawn-trigger-"));
process.env.JINN_HOME = home;

type Store = typeof import("../../work-items/store.js");
type Claims = typeof import("../../work-items/claims.js");
type Runs = typeof import("../../work-items/runs.js");
type RouteClaims = typeof import("../../gateway/todo-claim.js");
type Transitions = typeof import("../../work-items/transitions.js");
type Feeds = typeof import("../../work-items/workflow-event-feed.js");
type Resumes = typeof import("../../work-items/availability-resume.js");
type ResumePort = typeof import("../../gateway/availability-resume.js");
type Triggers = typeof import("../trigger-service.js");

let store: Store;
let claims: Claims;
let runs: Runs;
let routeClaims: RouteClaims;
let transitions: Transitions;
let feeds: Feeds;
let resumes: Resumes;
let resumePort: ResumePort;
let triggers: Triggers;

const trigger: WorkflowNode = {
  id: "start", type: "trigger", name: "Todo", config: { kind: "todo-status", status: "in_review" },
};
const definition = {
  id: "guarded-flow", title: "Guarded flow", revision: 1, enabled: true, nodes: [trigger], edges: [],
} as unknown as WorkflowDefinition;

const started: string[] = [];
let reported: WorkflowTodoEventClaimOutcome[] = [];

const repository = {
  listDefinitions: () => ({ items: [{ id: definition.id }], nextCursor: null }),
  getDefinition: () => definition,
  createRun: ({ idempotencyKey }: { idempotencyKey: string }) => {
    started.push(idempotencyKey);
    return { id: `run-${started.length}` };
  },
  getRun: (_workflowId: string, runId: string) => ({ id: runId, status: "completed" }),
} as unknown as WorkflowRepository;

const runner = { start: async (runId: string) => ({ id: runId, status: "completed" }) } as unknown as WorkflowRunner;

const feed: WorkflowTodoEventFeed = {
  claimEvent: (_id, definitionIds) => ({ state: "acquired", definitionIds }),
  completeEvent: (_id: string, outcomes: WorkflowTodoEventClaimOutcome[]) => { reported = outcomes; },
  deferEvent: (_id: string, _definitionIds: string[], outcomes: WorkflowTodoEventClaimOutcome[]) => { reported = outcomes; },
  releaseEvent: () => {},
  listPendingEvents: () => pending,
};

let pending: WorkflowTodoStatusEvent[] = [];

function event(id: string, workItemId: string, quotaWindowDecided = false): WorkflowTodoStatusEvent {
  return {
    id, workItemId, fromStatus: "executing", toStatus: "in_review", actor: "operator", actorEmployee: null, armedAsDelegate: null,
    quotaWindowDecided,
    item: { source: "human", department: null, assignee: null, labels: [], autoStart: true,
      live: { assignee: null, parentId: null, status: "in_review" } },
  };
}

/** A Todo the guards hold: it completed minutes ago and nobody has looked. */
function guardedTodo(title: string): string {
  const item = store.createWorkItem({ title });
  const run = runs.openWorkItemRun({ workItemId: item.id, sessionId: `s-${item.id}` });
  runs.closeWorkItemRun(run.id, { outcome: "completed", endedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  return item.id;
}

/** Enough of a response for the two route claim gates, which only touch it when
 *  they REFUSE — so a test that sees it touched has already found the bug. */
function response(): ServerResponse {
  return {
    writeHead: () => { throw new Error("the route answered instead of acquiring"); },
    setHeader: () => {},
    end: () => { throw new Error("the route answered instead of acquiring"); },
  } as unknown as ServerResponse;
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  claims = await import("../../work-items/claims.js");
  runs = await import("../../work-items/runs.js");
  routeClaims = await import("../../gateway/todo-claim.js");
  transitions = await import("../../work-items/transitions.js");
  feeds = await import("../../work-items/workflow-event-feed.js");
  resumes = await import("../../work-items/availability-resume.js");
  resumePort = await import("../../gateway/availability-resume.js");
  triggers = await import("../trigger-service.js");
});

beforeEach(() => { started.length = 0; reported = []; pending = []; });

describe("an automated Todo-status fire meets the respawn guards", () => {
  it("starts no run, takes no claim, and reports the hold as suppressed", async () => {
    const id = guardedTodo("just finished");
    pending = [event("event-guarded", id)];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    expect(await service.recoverTodoEvents()).toBe(0);

    expect(started).toEqual([]);
    expect(claims.getWorkItemClaim(id)).toBeUndefined();
    expect(reported).toEqual([{
      workflowId: definition.id,
      outcome: "suppressed",
      detail: expect.stringContaining("recent_success") as unknown as string,
    }]);
  });

  it("appends exactly one respawn_guard_held event naming the guard and its reason", async () => {
    const id = guardedTodo("audited hold");
    pending = [event("event-audited", id)];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    const holds = store.listWorkItemEvents(id).filter((entry) => entry.kind === "respawn_guard_held");
    expect(holds).toHaveLength(1);
    expect(holds[0].actor).toBe("workflow:event-audited");
    expect(holds[0].detail).toMatchObject({ guard: "recent_success" });
    expect(String(holds[0].detail?.reason)).toContain("no human has looked");
  });

  it("still starts the run for a Todo no guard holds", async () => {
    const item = store.createWorkItem({ title: "nothing behind it" });
    pending = [event("event-clear", item.id)];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    expect(await service.recoverTodoEvents()).toBe(1);

    expect(started).toEqual(["todo:event-clear"]);
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("workflow:event-clear");
  });
});

describe("human-initiated pickup is not guarded", () => {
  it("the operator's Dispatch still claims a Todo the guards hold", () => {
    const id = guardedTodo("operator says do it again");
    const claim = routeClaims.claimTodoForDispatch(response(), id);
    expect(claim).toBeDefined();
    expect(claims.getWorkItemClaim(id)?.owner).toBe(claim?.owner);
  });

  it("delegate_task still claims a Todo the guards hold", () => {
    const id = guardedTodo("delegated anyway");
    const claim = routeClaims.claimTodoForDelegation(response(), id);
    expect(claim).toBeDefined();
    expect(claims.getWorkItemClaim(id)?.owner).toBe(claim?.owner);
  });
});

/* The availability resume sweep and this trigger are one path (PLA-153): the
 * sweep decides a quota window has reopened and re-arms the Todo, and the status
 * event that re-arm writes is what actually starts the run. Both halves ask the
 * same guards, so a cooldown the sweep has already outranked must not refuse the
 * event a second time — and the three guards it did not answer still must. */
describe("a Todo the availability resume sweep re-armed", () => {
  const MINUTE_MS = 60_000;

  /** A quota window whose own text names a reopening five minutes ago. Both
   *  halves read the wall clock, so the window is built off it rather than off a
   *  fixed instant only one of them would be told about. */
  const reopenedQuota = () => `Usage limit exceeded; try again at ${new Date(Date.now() - 5 * MINUTE_MS).toISOString()}`;

  /** A Todo `guarded-flow` was driving when a provider window killed its attempt
   *  ten minutes ago — inside `rate_limit_cooldown`, past the reset it stated. */
  function parkedTodo(title: string, outcome: "rate_limited" | "crashed", error: string): string {
    const item = store.createWorkItem({ title, status: "executing" });
    const attempt = runs.openWorkItemRun({ workItemId: item.id, sessionId: `s-${item.id}` });
    runs.closeWorkItemRun(attempt.id, { outcome, error, endedAt: new Date(Date.now() - 10 * MINUTE_MS).toISOString() });
    store.appendWorkItemEvent({
      workItemId: item.id, kind: "status_change", fromStatus: "assigned", toStatus: "executing",
      actor: "workflow:run", detail: { workflowId: definition.id, runId: "run_1", nodeId: "plan" },
      versionEffect: "audit",
    });
    return item.id;
  }

  /** One sweep tick, re-arming through the same port the gateway wires up. */
  function sweepOnce(): void {
    resumes.sweepAvailabilityResumes({ rearm: (todoId) => resumePort.availabilityRearm(todoId, repository) });
  }

  const resumesOf = (id: string) => store.listWorkItemEvents(id).filter((entry) => entry.kind === "availability_resumed");
  const holdsOn = (id: string) => store.listWorkItemEvents(id)
    .filter((entry) => entry.kind === "respawn_guard_held").map((entry) => String(entry.detail?.guard));

  it("defers at its own guard check when one it cannot answer stands, burning no resume", () => {
    const id = parkedTodo("credentials, not a clock", "crashed", `${reopenedQuota()}; invalid api key`);

    sweepOnce();

    expect(resumesOf(id)).toHaveLength(0);
    expect(holdsOn(id)).toEqual(["blocker_auth"]);
    expect(store.getWorkItem(id)?.status).toBe("executing");
  });

  it("is still refused by the guards its decision does not answer", async () => {
    const id = parkedTodo("held on credentials anyway", "crashed", `${reopenedQuota()}; invalid api key`);
    pending = [event("event-resumed-auth", id, true)];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    expect(await service.recoverTodoEvents()).toBe(0);

    expect(started).toEqual([]);
    expect(reported).toEqual([{
      workflowId: definition.id,
      outcome: "suppressed",
      detail: expect.stringContaining("blocker_auth") as unknown as string,
    }]);
  });

  it("starts the run its stated reset says is due, inside the generic cooldown", async () => {
    const id = parkedTodo("quota window has reopened", "rate_limited", reopenedQuota());

    sweepOnce();
    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feeds.createWorkflowTodoEventFeed());
    expect(await service.recoverTodoEvents()).toBe(1);

    expect(started).toHaveLength(1);
    expect(store.getWorkItem(id)?.status).toBe("in_review");
    expect(resumesOf(id)).toHaveLength(1);
  });

  it("does not lend its bypass to an ordinary move made inside the same cooldown", async () => {
    const id = parkedTodo("moved by hand, not by the sweep", "rate_limited", reopenedQuota());
    transitions.transition(id, "in_review", "operator");

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feeds.createWorkflowTodoEventFeed());
    expect(await service.recoverTodoEvents()).toBe(0);

    expect(started).toEqual([]);
    expect(holdsOn(id)).toEqual(["rate_limit_cooldown"]);
  });
});
