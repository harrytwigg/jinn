import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkflowTodoEventFeed, WorkflowTodoStatusEvent }
  from "../../work-items/workflow-event-feed.js";
import type { WorkflowDefinition, WorkflowNode } from "../model.js";
import type { WorkflowRepository } from "../repository.js";
import type { WorkflowRunner } from "../runner.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-owning-rearm-"));
process.env.JINN_HOME = home;

type Store = typeof import("../../work-items/store.js");
type Labels = typeof import("../../work-items/labels.js");
type Triggers = typeof import("../trigger-service.js");

let store: Store;
let labels: Labels;
let triggers: Triggers;

const started: Array<{ workflowId: string; todoId?: string }> = [];

function definition(id: string, config: { label?: string; actor?: string } = {}): WorkflowDefinition {
  const trigger: WorkflowNode = {
    id: "start", type: "trigger", name: "Todo",
    config: { kind: "todo-status", status: "assigned", ...config },
  };
  return { id, title: id, revision: 1, enabled: true, nodes: [trigger], edges: [] } as unknown as WorkflowDefinition;
}

const intake = definition("intake");
const category = definition("category", { label: "category" });
const byId = new Map([[intake.id, intake], [category.id, category]]);

const repository = {
  listDefinitions: () => ({ items: [...byId.keys()].map((id) => ({ id })), nextCursor: null }),
  getDefinition: (id: string) => byId.get(id) ?? null,
  createRun: ({ workflowId, trigger }: { workflowId: string; trigger: { todoId?: string } }) => {
    started.push({ workflowId, todoId: trigger.todoId });
    return { id: `run-${started.length}` };
  },
  getRun: (_workflowId: string, runId: string) => ({ id: runId, status: "completed" }),
} as unknown as WorkflowRepository;

const runner = { start: async (runId: string) => ({ id: runId, status: "completed" }) } as unknown as WorkflowRunner;

const feed: WorkflowTodoEventFeed = {
  claimEvent: (_id, definitionIds) => ({ state: "acquired", definitionIds }),
  completeEvent: () => {},
  deferEvent: () => {},
  releaseEvent: () => {},
  listPendingEvents: () => pending,
};

let pending: WorkflowTodoStatusEvent[] = [];

function event(id: string, workItemId: string, actor = "operator", extra: Partial<WorkflowTodoStatusEvent> = {}): WorkflowTodoStatusEvent {
  const item = store.getWorkItem(workItemId);
  return {
    id, workItemId, fromStatus: "blocked", toStatus: "assigned", actor, actorEmployee: null, armedAsDelegate: null,
    quotaWindowDecided: false,
    item: {
      source: "session", department: "platform", assignee: item?.assignee ?? "platform-worker",
      labels: labels.getWorkItemLabels(workItemId).map(({ id: labelId, name }) => ({ id: labelId, name })), autoStart: true,
      live: item ? { assignee: item.assignee, parentId: item.parentId, status: item.status } : null,
    },
    ...extra,
  };
}

beforeAll(async () => {
  store = await import("../../work-items/store.js");
  labels = await import("../../work-items/labels.js");
  triggers = await import("../trigger-service.js");
  labels.createLabel({ name: "category" });
});

beforeEach(() => { started.length = 0; pending = []; });

describe("re-arming a Todo that already belongs to a pipeline", () => {
  it("starts only the owning workflow, not a sibling that also matches the status", async () => {
    const item = store.createWorkItem({
      title: "category work re-armed", status: "assigned", assignee: "platform-worker", department: "platform",
    });
    labels.setWorkItemLabels(item.id, ["category"], "operator");
    store.appendWorkItemEvent({
      workItemId: item.id, kind: "status_change", fromStatus: "assigned", toStatus: "executing",
      actor: "workflow:run", detail: { workflowId: "category", runId: "run_prior" }, versionEffect: "audit",
    });
    pending = [event("rearm-1", item.id)];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    expect(started).toEqual([{ workflowId: "category", todoId: item.id }]);
  });

  it("still starts every match when no Workflow has ever driven the Todo", async () => {
    const item = store.createWorkItem({
      title: "fresh assigned work", status: "assigned", assignee: "platform-worker", department: "platform",
    });
    labels.setWorkItemLabels(item.id, ["category"], "operator");
    pending = [event("fresh-1", item.id)];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    expect(started.map((row) => row.workflowId).sort()).toEqual(["category", "intake"]);
  });

  it("fires an operator-filtered trigger for an availability resume without impersonating the operator", async () => {
    byId.set("build", definition("build", { actor: "operator", label: "category" }));
    const item = store.createWorkItem({
      title: "quota parked build", status: "assigned", assignee: "platform-worker", department: "platform",
    });
    labels.setWorkItemLabels(item.id, ["category"], "operator");
    store.appendWorkItemEvent({
      workItemId: item.id, kind: "status_change", fromStatus: "assigned", toStatus: "executing",
      actor: "workflow:run", detail: { workflowId: "build", runId: "run_prior" }, versionEffect: "audit",
    });
    pending = [event("resume-1", item.id, "availability-resume", { quotaWindowDecided: true })];

    const service = new triggers.WorkflowTriggerService(repository, runner, () => "now", feed);
    await service.recoverTodoEvents();

    expect(started).toEqual([{ workflowId: "build", todoId: item.id }]);
    byId.delete("build");
  });
});
