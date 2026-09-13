import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowTodoEventClaimOutcome, WorkflowTodoEventFeed, WorkflowTodoStatusEvent }
  from "../../work-items/workflow-event-feed.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import type { WorkflowRepository } from "../repository.js";
import type { WorkflowRunner } from "../runner.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-todo-claim-trigger-"));
process.env.JINN_HOME = home;

type Store = typeof import("../../work-items/store.js");
type Claims = typeof import("../../work-items/claims.js");
type Triggers = typeof import("../trigger-service.js");

let store: Store;
let claims: Claims;
let triggers: Triggers;

const trigger: WorkflowNode = {
  id: "start", type: "trigger", name: "Todo", config: { kind: "todo-status", status: "in_review" },
};
const definition = {
  id: "claim-flow", title: "Claim flow", revision: 1, enabled: true, nodes: [trigger], edges: [],
} as unknown as WorkflowDefinition;

const started: string[] = [];
/** Who held the Todo at the instant the run was created — the only place the
 *  ordering is observable, because after the fire both orders look alike. */
const heldWhenRunCreated: (string | null)[] = [];

const repository = {
  listDefinitions: () => ({ items: [{ id: definition.id }], nextCursor: null }),
  getDefinition: () => definition,
  createRun: ({ idempotencyKey, trigger }: { idempotencyKey: string; trigger: { todoId?: string } }) => {
    started.push(idempotencyKey);
    heldWhenRunCreated.push(claims.getWorkItemClaim(trigger.todoId ?? "")?.owner ?? null);
    return { id: `run-${started.length}` };
  },
  getRun: (_workflowId: string, runId: string) => ({ id: runId, status: "completed" }),
} as unknown as WorkflowRepository;

const runner = { start: async (runId: string) => ({ id: runId, status: "completed" }) } as unknown as WorkflowRunner;

/** Every event is fresh to the feed, so the only thing that can suppress the
 *  second fire is the Todo claim rather than the event claim. */
const feed: WorkflowTodoEventFeed = {
  claimEvent: (_id, definitionIds) => ({ state: "acquired", definitionIds }),
  completeEvent: (_id: string, _outcomes: WorkflowTodoEventClaimOutcome[]) => {},
  deferEvent: (_id: string, _definitionIds: string[], _outcomes: WorkflowTodoEventClaimOutcome[]) => {},
  releaseEvent: () => {},
  listPendingEvents: () => pending,
};

let pending: WorkflowTodoStatusEvent[] = [];

function event(id: string, workItemId: string): WorkflowTodoStatusEvent {
  return {
    id, workItemId, fromStatus: "executing", toStatus: "in_review", actor: "operator", actorEmployee: null, armedAsDelegate: null,
    quotaWindowDecided: false,
    item: { source: "human", department: null, assignee: null, labels: [], autoStart: true,
      live: { assignee: null, parentId: null, status: "in_review" } },
  };
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  claims = await import("../../work-items/claims.js");
  triggers = await import("../trigger-service.js");
});

beforeEach(() => { started.length = 0; heldWhenRunCreated.length = 0; pending = []; });

describe("the todo-status trigger and the Todo claim", () => {
  it("claims the Todo before starting a run", async () => {
    const item = store.createWorkItem({ title: "ready for review" });
    pending = [event("event-1", item.id)];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    expect(started).toEqual(["todo:event-1"]);
    expect(heldWhenRunCreated).toEqual(["workflow:event-1"]);
  });

  it("starts no second run for another event on a Todo it is already working", async () => {
    const item = store.createWorkItem({ title: "moved twice" });
    pending = [event("event-1", item.id)];
    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    pending = [event("event-2", item.id)];
    await service.recoverTodoEvents();

    expect(started).toEqual(["todo:event-1"]);
    expect(claims.getWorkItemClaim(item.id)?.owner).toBe("workflow:event-1");
  });

  it("still fires for a Todo whose row is gone, which nothing can double-work", async () => {
    pending = [event("event-3", "ICI-999999")];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    expect(started).toEqual(["todo:event-3"]);
  });
});
