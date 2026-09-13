import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowTodoEventClaimOutcome, WorkflowTodoEventFeed, WorkflowTodoStatusEvent }
  from "../../work-items/workflow-event-feed.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import type { WorkflowRepository } from "../repository.js";
import type { WorkflowRunner } from "../runner.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-event-coalescing-"));
process.env.JINN_HOME = home;

type Store = typeof import("../../work-items/store.js");
type Triggers = typeof import("../trigger-service.js");

let store: Store;
let triggers: Triggers;

function definitionWith(id: string, filter: { label?: string; department?: string } = {}): WorkflowDefinition {
  const trigger: WorkflowNode = {
    id: "start", type: "trigger", name: "Todo",
    config: { kind: "todo-status", status: "in_review", ...filter },
  };
  return { id, title: id, revision: 1, enabled: true, nodes: [trigger], edges: [] } as unknown as WorkflowDefinition;
}

let definitions: WorkflowDefinition[] = [];
let pending: WorkflowTodoStatusEvent[] = [];
const started: Array<{ workflowId: string; idempotencyKey: string; payload: unknown }> = [];
const completed: Array<{ eventId: string; outcomes: WorkflowTodoEventClaimOutcome[] }> = [];
const deferred = new Map<string, { definitionIds: string[]; outcomes: WorkflowTodoEventClaimOutcome[] }>();

const repository = {
  listDefinitions: () => ({ items: definitions.map((item) => ({ id: item.id })), nextCursor: null }),
  getDefinition: (id: string) => definitions.find((item) => item.id === id),
  createRun: ({ workflowId, idempotencyKey, trigger }: {
    workflowId: string; idempotencyKey: string; trigger: { payload: unknown };
  }) => {
    started.push({ workflowId, idempotencyKey, payload: trigger.payload });
    return { id: `run-${started.length}` };
  },
  getRun: (_workflowId: string, runId: string) => ({ id: runId, status: "completed" }),
} as unknown as WorkflowRepository;

const runner = { start: async (runId: string) => ({ id: runId, status: "completed" }) } as unknown as WorkflowRunner;

/** Every event is fresh to the feed unless a previous sweep deferred it, so
 *  nothing but the coalescing and the label deferral under test can stop one of
 *  them firing. `completeEvent` is the spy: it is where the outcome recorded
 *  against each declined event shows up. A deferred event keeps its claim, so
 *  re-claiming it hands back the definitions the deferral put back. */
const feed: WorkflowTodoEventFeed = {
  claimEvent: (eventId, definitionIds) => {
    const held = deferred.get(eventId);
    return held === undefined
      ? { state: "acquired", definitionIds }
      : { state: "acquired", definitionIds: held.definitionIds, deferred: true };
  },
  completeEvent: (eventId, outcomes) => { deferred.delete(eventId); completed.push({ eventId, outcomes }); },
  deferEvent: (eventId, definitionIds, outcomes) => { deferred.set(eventId, { definitionIds, outcomes }); },
  releaseEvent: () => {},
  listPendingEvents: () => pending,
};

function event(id: string, workItemId: string, labels: string[] = []): WorkflowTodoStatusEvent {
  return {
    id, workItemId, fromStatus: "executing", toStatus: "in_review", actor: "operator", actorEmployee: null, armedAsDelegate: null,
    quotaWindowDecided: false,
    item: {
      source: "human", department: null, assignee: null,
      labels: labels.map((name) => ({ id: `lbl_${name}`, name })), autoStart: true,
      live: { assignee: null, parentId: null, status: "in_review" },
    },
  };
}

function outcomesFor(eventId: string): WorkflowTodoEventClaimOutcome[] {
  return completed.filter((entry) => entry.eventId === eventId).flatMap((entry) => entry.outcomes);
}

function keys(): string[] { return started.map((run) => run.idempotencyKey); }

async function sweep(): Promise<number> {
  return new triggers.WorkflowTriggerService(repository, runner, () => "now", feed).recoverTodoEvents();
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  triggers = await import("../trigger-service.js");
});

beforeEach(() => {
  started.length = 0;
  completed.length = 0;
  deferred.clear();
  pending = [];
  definitions = [definitionWith("claim-flow")];
});

describe("coalescing a backlog of pending Todo events", () => {
  it("starts only the newest qualifying event's run", async () => {
    const item = store.createWorkItem({ title: "label restored" });
    pending = [event("event-1", item.id), event("event-2", item.id), event("event-3", item.id)];

    await sweep();

    expect(keys()).toEqual(["todo:event-3"]);
  });

  it("records the older events as superseded by the one that won", async () => {
    const item = store.createWorkItem({ title: "three moves" });
    pending = [event("event-1", item.id), event("event-2", item.id), event("event-3", item.id)];

    await sweep();

    for (const eventId of ["event-1", "event-2"]) {
      expect(outcomesFor(eventId)).toEqual([{
        workflowId: "claim-flow",
        outcome: "superseded",
        detail: `Todo event ${eventId} superseded by event-3, a newer in_review event on ${item.id}.`,
      }]);
    }
    expect(outcomesFor("event-3").map((outcome) => outcome.outcome)).toEqual(["started"]);
  });

  it("never coalesces one Todo's events against another's", async () => {
    const first = store.createWorkItem({ title: "one" });
    const second = store.createWorkItem({ title: "two" });
    pending = [event("event-1", first.id), event("event-2", second.id)];

    await sweep();

    expect(keys()).toEqual(["todo:event-1", "todo:event-2"]);
  });

  it("still starts an event superseded for one workflow when it is the newest for another", async () => {
    definitions = [definitionWith("unfiltered"), definitionWith("build-only", { label: "build" })];
    // A Todo whose row is gone cannot be double-worked, so the Todo-wide claim
    // never holds the second fire and the per-definition coalescing is what is
    // observed on its own. The test below is the same burst on a live Todo,
    // where that claim is what decides how much of it can run.
    pending = [event("event-1", "ICI-999999", ["build"]), event("event-2", "ICI-999999")];

    await sweep();

    expect(started).toEqual([
      { workflowId: "build-only", idempotencyKey: "todo:event-1", payload: expect.anything() },
      { workflowId: "unfiltered", idempotencyKey: "todo:event-2", payload: expect.anything() },
    ]);
    expect(outcomesFor("event-1").filter((outcome) => outcome.outcome === "superseded")).toEqual([{
      workflowId: "unfiltered",
      outcome: "superseded",
      detail: "Todo event event-1 superseded by event-2, a newer in_review event on ICI-999999.",
    }]);
  });

  it("lets the Todo-wide claim, not the coalescing, decide how much of a live burst runs", async () => {
    definitions = [definitionWith("unfiltered"), definitionWith("build-only", { label: "build" })];
    const item = store.createWorkItem({ title: "different winners" });
    pending = [event("event-1", item.id, ["build"]), event("event-2", item.id)];

    await sweep();

    // Only one event per Todo can ever produce runs: the first one to fire takes
    // the Todo-wide claim and every later event of that Todo is refused on it.
    expect(started).toEqual([
      { workflowId: "build-only", idempotencyKey: "todo:event-1", payload: expect.anything() },
    ]);
    expect(outcomesFor("event-2")).toEqual([
      {
        workflowId: "build-only",
        outcome: "suppressed",
        detail: "Todo event event-2 suppressed: label filter build does not match.",
      },
      {
        workflowId: "unfiltered",
        outcome: "suppressed",
        detail: `Todo event event-2 suppressed: ${item.id} is already being worked by workflow:event-1.`,
      },
    ]);
  });

  it("defers a label-refused event rather than declining it, and leaves the survivor's payload alone", async () => {
    definitions = [definitionWith("build-only", { label: "build" })];
    const item = store.createWorkItem({ title: "one labelled, one not" });
    pending = [event("event-1", item.id), event("event-2", item.id, ["build"])];

    await sweep();

    // event-2 is newer and qualifies, so supersession would have declined event-1
    // had the label not held it back first: deferral runs upstream of that gate.
    expect(completed.map((entry) => entry.eventId)).not.toContain("event-1");
    expect(deferred.get("event-1")).toEqual({
      definitionIds: ["build-only"],
      outcomes: [{
        workflowId: "build-only",
        outcome: "suppressed",
        detail: "Todo event event-1 suppressed: label filter build does not match.",
      }],
    });
    expect(started).toEqual([{
      workflowId: "build-only",
      idempotencyKey: "todo:event-2",
      payload: {
        todoId: item.id, fromStatus: "executing", toStatus: "in_review", actor: "operator", actorEmployee: null,
        source: "human", department: null, assignee: null, autoStart: true, labels: ["build"], labelList: "build",
      },
    }]);
  });

  it("seals an event a filter other than the label refused", async () => {
    definitions = [definitionWith("platform-only", { department: "platform" })];
    const item = store.createWorkItem({ title: "wrong department" });
    pending = [event("event-1", item.id), event("event-2", item.id)];

    await sweep();

    expect(deferred.has("event-1")).toBe(false);
    expect(outcomesFor("event-1")).toEqual([{
      workflowId: "platform-only",
      outcome: "suppressed",
      detail: "Todo event event-1 suppressed: department filter platform does not match.",
    }]);
    expect(started).toEqual([]);
  });

  it("starts a released event when it is still the newest that qualifies", async () => {
    definitions = [definitionWith("build-only", { label: "build" })];
    const item = store.createWorkItem({ title: "label lands late" });
    pending = [event("event-1", item.id)];
    await sweep();
    expect(deferred.has("event-1")).toBe(true);
    expect(started).toEqual([]);

    pending = [event("event-1", item.id, ["build"])];
    await sweep();

    expect(keys()).toEqual(["todo:event-1"]);
    expect(outcomesFor("event-1").map((outcome) => outcome.outcome)).toEqual(["started"]);
  });

  it("declines a released event a newer one beat, and says it had been waiting", async () => {
    definitions = [definitionWith("build-only", { label: "build" })];
    const item = store.createWorkItem({ title: "label lands too late" });
    pending = [event("event-1", item.id)];
    await sweep();

    pending = [event("event-1", item.id, ["build"]), event("event-2", item.id, ["build"])];
    await sweep();

    expect(keys()).toEqual(["todo:event-2"]);
    expect(outcomesFor("event-1")).toEqual([{
      workflowId: "build-only",
      outcome: "deferred-then-superseded",
      detail: "Todo event event-1 waited for its label, then was superseded by event-2,"
        + ` a newer in_review event on ${item.id}.`,
    }]);
  });

  it("leaves a single pending event exactly as it was", async () => {
    const item = store.createWorkItem({ title: "moved once" });
    pending = [event("event-1", item.id)];

    const count = await sweep();

    expect(count).toBe(1);
    expect(keys()).toEqual(["todo:event-1"]);
    expect(outcomesFor("event-1").map((outcome) => outcome.outcome)).toEqual(["started"]);
  });
});
