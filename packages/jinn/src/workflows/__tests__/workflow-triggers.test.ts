import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../shared/logger.js";
import type { Employee, ModelRegistry, WorkflowAttemptCommand, WorkflowAttemptCompletionListener } from "../../shared/types.js";
import type { WorkflowTodoEventClaimOutcome, WorkflowTodoEventFeed, WorkflowTodoStatusEvent } from "../../work-items/workflow-event-feed.js";
import type { TriggerNode, WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

const scheduled: Array<{ callback: () => void | Promise<void>; stop: ReturnType<typeof vi.fn> }> = [];
// The recorder exists only to fire the callback by hand; construction still goes
// through the real node-cron, so an invalid expression or timezone throws here
// exactly as it does in production.
vi.mock("node-cron", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-cron")>();
  return { default: { validate: actual.validate,
    schedule: vi.fn((expression: string, callback: () => void | Promise<void>, options?: { timezone?: string }) => {
      actual.schedule(expression, () => {}, { ...options, scheduled: false }).stop();
      const task = { callback, stop: vi.fn() }; scheduled.push(task); return task;
    }) } };
});

const employee: Employee = { name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete work." };
const models: ModelRegistry = { "test-engine": { name: "test-engine", available: true, defaultModel: "test-model",
  effortMechanism: "codex-config", models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }] } };
class Executor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();
  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command); return { sessionId: `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  readTerminalCompletion(): null { return null; }
}

class TodoFeed implements WorkflowTodoEventFeed {
  readonly pending: WorkflowTodoStatusEvent[] = [];
  readonly processed = new Map<string, WorkflowTodoEventClaimOutcome[]>();
  readonly deferred = new Map<string, WorkflowTodoEventClaimOutcome[]>();
  claimEvent(id: string, definitionIds: string[]) {
    const prior = this.processed.get(id); return prior ? { state: "processed" as const, outcomes: prior }
      : { state: "acquired" as const, definitionIds };
  }
  completeEvent(id: string, outcomes: WorkflowTodoEventClaimOutcome[]): void { this.processed.set(id, outcomes); }
  deferEvent(id: string, _definitionIds: string[], outcomes: WorkflowTodoEventClaimOutcome[]): void { this.deferred.set(id, outcomes); }
  releaseEvent(): void {}
  listPendingEvents(): WorkflowTodoStatusEvent[] { return this.pending.filter((event) => !this.processed.has(event.id)); }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: Executor;
let feed: TodoFeed;
let service: WorkflowService;
let now: string;

function edge(id: string, from: string, to: string) {
  return { id, from: { nodeId: from, port: "success" as const }, to: { nodeId: to, port: "input" as const } };
}
function todoEvent(id: string, item: Partial<WorkflowTodoStatusEvent["item"]> = {}, actor: string | null = "operator"): WorkflowTodoStatusEvent {
  return { id, workItemId: "ICI-1", fromStatus: "executing", toStatus: "in_review", actor, actorEmployee: null, armedAsDelegate: null, quotaWindowDecided: false,
    item: { source: "human", department: "platform", assignee: "worker", labels: [], autoStart: true,
      live: { assignee: "worker", parentId: null, status: "in_review" }, ...item } };
}
function todoTrigger(config: Omit<Extract<TriggerNode["config"], { kind: "todo-status" }>, "kind" | "status">): WorkflowNode {
  return { id: "start", type: "trigger", name: "Todo", config: { kind: "todo-status", status: "in_review", ...config } };
}
function save(id: string, trigger: WorkflowNode, enabled = true): WorkflowDefinition {
  const draft = service.createDefinition({ id, title: id });
  const worker: WorkflowNode = { id: "work", type: "employee", name: "Work", config: {
    employee: { source: "fixed", value: "worker" }, prompt: "Do work.",
    retry: { attempts: 1, delaySeconds: 0, backoff: "fixed" }, timeoutMinutes: 1 } };
  const end: WorkflowNode = { id: "finish", type: "end", name: "Finish", config: { result: "success" } };
  const saved = service.saveDefinition({ ...draft, nodes: [trigger, worker, end],
    edges: [edge("trigger-work", trigger.id, "work"), edge("work-end", "work", "finish")] }, draft.revision);
  return enabled ? service.setEnabled({ id, enabled: true, expectedRevision: saved.revision }) : saved;
}
function buildService(): WorkflowService {
  return new WorkflowService({ repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now, todoEventFeed: feed });
}

beforeEach(() => {
  scheduled.length = 0; root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-triggers-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db")); now = "2026-07-21T12:00:00.000Z";
  repository = new WorkflowRepository(database, () => now); executor = new Executor(); feed = new TodoFeed(); service = buildService();
});
afterEach(() => { service.dispose(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("Workflow trigger adapters", () => {
  it("arms and calls a definition with Todo and Workflow Call triggers", async () => {
    const draft = service.createDefinition({ id: "dual-trigger-flow", title: "Dual trigger flow" });
    const todo: WorkflowNode = { id: "todo-start", type: "trigger", name: "Todo",
      config: { kind: "todo-status", status: "in_review" } };
    const called: WorkflowNode = { id: "call-start", type: "trigger", name: "Called",
      config: { kind: "workflow-call" } };
    const todoEnd: WorkflowNode = { id: "todo-end", type: "end", name: "Todo end", config: { result: "success" } };
    const callEnd: WorkflowNode = { id: "call-end", type: "end", name: "Call end", config: { result: "success" } };
    const saved = service.saveDefinition({ ...draft, nodes: [todo, called, todoEnd, callEnd],
      edges: [edge("todo-finish", todo.id, todoEnd.id), edge("call-finish", called.id, callEnd.id)] }, draft.revision);
    const definition = service.setEnabled({ id: saved.id, enabled: true, expectedRevision: saved.revision });

    feed.pending.push(todoEvent("dual-trigger-event"));
    await service.recover(now);
    const todoRun = service.listRuns(definition.id, {}).items[0]!;
    expect(service.getRun(definition.id, todoRun.id)).toMatchObject({
      status: "completed",
      trigger: { nodeId: "todo-start", kind: "todo-status", todoId: "ICI-1" },
    });

    const callerDefinition = save("dual-trigger-caller", {
      id: "start", type: "trigger", name: "Manual", config: { kind: "manual" },
    });
    const callerRun = await service.startManual({ workflowId: callerDefinition.id, input: {} });
    const calledRun = await service.callWorkflow({
      workflowId: definition.id,
      caller: { workflowId: callerDefinition.id, runId: callerRun.id, nodeId: "work" },
      input: {},
      idempotencyKey: "dual-trigger-call",
    });

    expect(calledRun).toMatchObject({
      status: "completed",
      trigger: { nodeId: "call-start", kind: "workflow-call" },
    });
  });

  it("rebuilds only enabled Schedule definitions and fires each instant idempotently across restart and disable", async () => {
    const trigger: WorkflowNode = { id: "start", type: "trigger", name: "Schedule", config: { kind: "schedule", cron: "0 * * * *", timezone: "UTC" } };
    const definition = save("scheduled-flow", trigger, false);
    // An identical re-save is not an edit, so it keeps the revision the caller holds.
    const resaved = service.saveDefinition(repository.getDefinition(definition.id)!, definition.revision);
    expect(resaved.revision).toBe(definition.revision);
    expect(scheduled).toHaveLength(0);
    service.setEnabled({ id: definition.id, enabled: true, expectedRevision: definition.revision });
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!.callback(); await scheduled[0]!.callback();
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);

    const enabled = repository.getDefinition(definition.id)!;
    service.setEnabled({ id: definition.id, enabled: false, expectedRevision: enabled.revision });
    expect(scheduled[0]!.stop).toHaveBeenCalledOnce();
    now = "2026-07-21T13:00:00.000Z"; await scheduled[0]!.callback();
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);
    service.dispose(); service = buildService(); expect(scheduled).toHaveLength(1);
  });

  it("skips an already-enabled Schedule whose cron expression is invalid instead of failing to build", () => {
    const warnings: string[] = [];
    const warn = vi.spyOn(logger, "warn").mockImplementation((message: string) => { warnings.push(message); });
    const trigger: WorkflowNode = { id: "start", type: "trigger", name: "Schedule",
      config: { kind: "schedule", cron: "every weekday please", timezone: "UTC" } };
    const work: WorkflowNode = { id: "work", type: "employee", name: "Work", config: {
      employee: { source: "fixed", value: "worker" }, prompt: "Do work." } };
    const finish: WorkflowNode = { id: "finish", type: "end", name: "Finish", config: { result: "success" } };
    const draft = service.createDefinition({ id: "poison-schedule", title: "poison-schedule" });
    // Seeded past the service gate, as a row authored before it existed would be.
    const stored = repository.saveDefinition({ ...draft, nodes: [trigger, work, finish],
      edges: [edge("trigger-work", "start", "work"), edge("work-end", "work", "finish")] }, draft.revision);
    repository.setEnabled(stored.id, true, stored.revision);

    service.dispose(); service = buildService();

    expect(scheduled).toHaveLength(0);
    expect(warnings).toEqual([expect.stringContaining("poison-schedule")]);
    warn.mockRestore();
  });

  it("claims the existing Todo feed against its enabled in-memory index without duplicate fires", async () => {
    const trigger: WorkflowNode = { id: "start", type: "trigger", name: "Todo", config: { kind: "todo-status", status: "in_review" } };
    const definition = save("todo-flow", trigger);
    feed.pending.push(todoEvent("event-1"));
    await service.recover(now); await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);
    expect(feed.processed.get("event-1")).toMatchObject([{ workflowId: definition.id, outcome: "started" }]);

    const enabled = repository.getDefinition(definition.id)!;
    service.setEnabled({ id: definition.id, enabled: false, expectedRevision: enabled.revision });
    feed.pending.push({ ...feed.pending[0]!, id: "event-2" }); await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);
  });

  it("fires a filtered Todo trigger only when label, department, and assignee all match", async () => {
    const definition = save("todo-filtered", todoTrigger({ label: "Needs Review", department: "platform", assignee: "worker" }));
    const matching = [{ id: "lbl_0000000000ab", name: "needs-review" }];
    feed.pending.push(todoEvent("wrong-label", { labels: [{ id: "lbl_0000000000cd", name: "chore" }] }),
      todoEvent("wrong-department", { department: "growth", labels: matching }),
      todoEvent("wrong-assignee", { assignee: "other", labels: matching }));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(0);

    feed.pending.push(todoEvent("all-match", { labels: matching }));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);
  });

  it("keeps an unfiltered Todo trigger firing for every Todo reaching its status", async () => {
    const definition = save("todo-unfiltered", todoTrigger({}));
    feed.pending.push(todoEvent("event-1", { department: null, assignee: null }));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);
  });

  it("completes a Todo event that matches zero filtered definitions instead of leaving it pending", async () => {
    const definition = save("todo-excluding", todoTrigger({ department: "growth" }));
    feed.pending.push(todoEvent("event-1"));
    await service.recover(now);
    expect(feed.processed.get("event-1")).toMatchObject([
      { workflowId: definition.id, outcome: "suppressed", detail: expect.stringContaining("department") },
    ]);
    expect(feed.listPendingEvents()).toHaveLength(0);
  });

  it("fires an unlabelled, unassigned Todo and names the unlabeled filter when the same Todo carries a label", async () => {
    const definition = save("todo-intake", todoTrigger({ unlabeled: true, unassigned: true }));
    const bare = { assignee: null, live: { assignee: null, parentId: null, status: "in_review" as const } };
    feed.pending.push(todoEvent("bare-todo", bare));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);

    feed.pending.push(todoEvent("build-todo", { ...bare, labels: [{ id: "lbl_0000000000ab", name: "build" }] }));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);
    expect(feed.processed.get("build-todo")).toMatchObject([
      { workflowId: definition.id, outcome: "suppressed", detail: expect.stringContaining("unlabeled") },
    ]);
  });

  it("suppresses an unassigned filter against the live assignee even when the frozen snapshot has none", async () => {
    const definition = save("todo-unassigned", todoTrigger({ unassigned: true }));
    feed.pending.push(todoEvent("reassigned-todo", { assignee: null, live: { assignee: "other", parentId: null, status: "in_review" } }));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(0);
    expect(feed.processed.get("reassigned-todo")).toMatchObject([
      { workflowId: definition.id, outcome: "suppressed", detail: expect.stringContaining("unassigned") },
    ]);
  });

  it("fires a rootOnly Todo trigger for a root Todo and suppresses a child", async () => {
    const definition = save("todo-root-only", todoTrigger({ rootOnly: true }));
    feed.pending.push(todoEvent("child-todo", { live: { assignee: "worker", parentId: "ICI-9", status: "in_review" } }));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(0);
    expect(feed.processed.get("child-todo")).toMatchObject([
      { workflowId: definition.id, outcome: "suppressed", detail: expect.stringContaining("rootOnly") },
    ]);

    feed.pending.push(todoEvent("root-todo"));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);
  });

  it("refuses the live filters for a Todo whose row is gone instead of defaulting to a match", async () => {
    const definition = save("todo-vanished", todoTrigger({ unlabeled: true, unassigned: true, rootOnly: true }));
    feed.pending.push(todoEvent("deleted-todo", { assignee: null, live: null }));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(0);
    expect(feed.processed.get("deleted-todo")).toMatchObject([
      { workflowId: definition.id, outcome: "suppressed", detail: expect.stringContaining("no longer exists") },
    ]);
  });

  it("fires an actor-filtered Todo trigger for the operator's own transition and suppresses an employee's", async () => {
    const definition = save("todo-by-actor", todoTrigger({ label: "build", actor: "operator" }));
    const labels = [{ id: "lbl_0000000000ab", name: "build" }];
    feed.pending.push(todoEvent("employee-move", { labels }, "session:6f1b0f4c-1f0f-4f0f-8f0f-0f0f0f0f0f0f"));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(0);
    expect(feed.processed.get("employee-move")).toMatchObject([
      { workflowId: definition.id, outcome: "suppressed", detail: expect.stringContaining("actor") },
    ]);

    feed.pending.push(todoEvent("operator-move", { labels }, "operator"));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);
  });

  it("carries the transition actor into the Todo trigger payload", async () => {
    const definition = save("todo-actor-payload", todoTrigger({}));
    feed.pending.push(todoEvent("event-1", {}, "reconciler"));
    await service.recover(now);
    const run = service.listRuns(definition.id, {}).items[0]!;
    expect(repository.getRun(definition.id, run.id)!.trigger.payload).toMatchObject({ actor: "reconciler" });
  });

  it("carries the actor's employee and the Todo's auto-start opt-out into the trigger payload", async () => {
    const definition = save("todo-gen67-payload", todoTrigger({}));
    feed.pending.push({ ...todoEvent("event-1", { autoStart: false }, "session:6f1b0f4c-1f0f-4f0f-8f0f-0f0f0f0f0f0f"), actorEmployee: "worker" });
    await service.recover(now);
    const run = service.listRuns(definition.id, {}).items[0]!;
    expect(repository.getRun(definition.id, run.id)!.trigger.payload).toMatchObject({
      actor: "session:6f1b0f4c-1f0f-4f0f-8f0f-0f0f0f0f0f0f", actorEmployee: "worker", assignee: "worker", autoStart: false });
  });

  it("suppresses a selfAssigned: false trigger when the assignee moved the Todo themself, and fires for everyone else", async () => {
    const definition = save("todo-not-self", todoTrigger({ selfAssigned: false }));
    feed.pending.push({ ...todoEvent("self-claim", {}, "session:6f1b0f4c-1f0f-4f0f-8f0f-0f0f0f0f0f0f"), actorEmployee: "worker" });
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(0);
    expect(feed.processed.get("self-claim")).toMatchObject([
      { workflowId: definition.id, outcome: "suppressed", detail: expect.stringContaining("selfAssigned") },
    ]);

    // A manager's session, the operator, and a stampless legacy event all fire
    // (one Todo each, so nothing here is superseded as a newer move on the same lane).
    feed.pending.push({ ...todoEvent("manager-assign", {}, "session:7a2c1d5e-2a2a-4b4b-8c8c-1d1d1d1d1d1d"), actorEmployee: "manager", workItemId: "ICI-2" });
    feed.pending.push({ ...todoEvent("operator-assign", {}, "operator"), workItemId: "ICI-3" });
    feed.pending.push({ ...todoEvent("legacy-assign", {}, "session:8b3d2e6f-3b3b-4c4c-8d8d-2e2e2e2e2e2e"), workItemId: "ICI-4" });
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(3);
  });

  it("suppresses an autoStart: true trigger for a Todo that opted out, and fires for one that did not", async () => {
    const definition = save("todo-auto-start", todoTrigger({ autoStart: true }));
    feed.pending.push(todoEvent("opted-out", { autoStart: false }));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(0);
    expect(feed.processed.get("opted-out")).toMatchObject([
      { workflowId: definition.id, outcome: "suppressed", detail: expect.stringContaining("autoStart") },
    ]);

    feed.pending.push(todoEvent("allowed", { autoStart: true }));
    await service.recover(now);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(1);
  });

  it("carries the Todo labels into the trigger payload as an array and an interpolatable scalar", async () => {
    const definition = save("todo-payload", todoTrigger({}));
    feed.pending.push(todoEvent("event-1", { labels: [{ id: "lbl_0000000000ab", name: "needs-review" }, { id: "lbl_0000000000cd", name: "urgent" }] }));
    await service.recover(now);
    const run = service.listRuns(definition.id, {}).items[0]!;
    expect(repository.getRun(definition.id, run.id)!.trigger.payload).toMatchObject({
      todoId: "ICI-1", labels: ["needs-review", "urgent"], labelList: "needs-review, urgent" });
  });

  it("calls only a workflow-call target, freezes caller identity, and creates fresh Employee sessions", async () => {
    const trigger: WorkflowNode = { id: "start", type: "trigger", name: "Called", config: { kind: "workflow-call" } };
    const definition = save("called-flow", trigger);
    const other = save("called-other", trigger);
    const parent = save("parent-flow", { id: "start", type: "trigger", name: "Manual", config: { kind: "manual" } });
    const parentRun = await service.startManual({ workflowId: parent.id, input: {} });
    const alternateRun = await service.startManual({ workflowId: parent.id, input: {} });
    const caller = { workflowId: parent.id, runId: parentRun.id, nodeId: "work" };
    const alternateCaller = { workflowId: parent.id, runId: alternateRun.id, nodeId: "work" };
    executor.commands.length = 0;
    await expect(service.callWorkflow({ workflowId: definition.id, caller, input: {}, idempotencyKey: "x".repeat(129) }))
      .rejects.toThrow(/idempotency key/i);
    expect(service.listRuns(definition.id, {}).items).toHaveLength(0);
    const first = await service.callWorkflow({ workflowId: definition.id, caller, input: { topic: "release" }, idempotencyKey: "x".repeat(128) });
    const replay = await service.callWorkflow({ workflowId: definition.id, caller, input: { topic: "release" }, idempotencyKey: "x".repeat(128) });
    const second = await service.callWorkflow({ workflowId: definition.id, caller, input: { topic: "release" }, idempotencyKey: "call-2" });
    expect(replay.id).toBe(first.id); expect(second.id).not.toBe(first.id);
    expect(first.trigger).toMatchObject({ kind: "workflow-call", payload: { caller } });
    expect(new Set(executor.commands.map((command) => command.owner.runId))).toEqual(new Set([first.id, second.id]));
    await service.cancelRun({ workflowId: parent.id, runId: parentRun.id, reason: "Caller finished." });
    const terminalReplay = await service.callWorkflow({ workflowId: definition.id, caller,
      input: { topic: "release" }, idempotencyKey: "x".repeat(128) });
    expect(terminalReplay).toMatchObject({ id: first.id, status: "cancelled" });
    for (const changed of [
      { workflowId: definition.id, caller, input: { topic: "changed" } },
      { workflowId: definition.id, caller: alternateCaller, input: { topic: "release" } },
      { workflowId: other.id, caller: alternateCaller, input: { topic: "release" } },
    ]) await expect(service.callWorkflow({ ...changed, idempotencyKey: "x".repeat(128) })).rejects.toThrow(/idempotency/i);
    expect(executor.commands).toHaveLength(2);

    const manual: WorkflowNode = { id: "start", type: "trigger", name: "Manual", config: { kind: "manual" } };
    const wrong = save("manual-flow", manual);
    await expect(service.callWorkflow({ workflowId: wrong.id, caller, input: {}, idempotencyKey: "bad-call" }))
      .rejects.toThrow(/workflow-call/i);
  });

  it("rejects arbitrary Workflow Call identities, self-recursion, ancestry cycles, and oversized IDs", async () => {
    const callTrigger = (name: string): WorkflowNode => ({ id: "start", type: "trigger", name, config: { kind: "workflow-call" } });
    const parent = save("call-parent", { id: "start", type: "trigger", name: "Manual", config: { kind: "manual" } });
    const first = save("call-first", callTrigger("First"));
    const second = save("call-second", callTrigger("Second"));
    const parentRun = await service.startManual({ workflowId: parent.id, input: {} });
    const parentCaller = { workflowId: parent.id, runId: parentRun.id, nodeId: "work" };

    await expect(service.callWorkflow({ workflowId: first.id,
      caller: { ...parentCaller, runId: "run_missing" }, input: {}, idempotencyKey: "missing" }))
      .rejects.toThrow(/caller/i);
    await expect(service.callWorkflow({ workflowId: first.id,
      caller: { ...parentCaller, nodeId: "start" }, input: {}, idempotencyKey: "wrong-node" }))
      .rejects.toThrow(/caller/i);
    await expect(service.callWorkflow({ workflowId: first.id,
      caller: { ...parentCaller, workflowId: "x".repeat(129) }, input: {}, idempotencyKey: "oversized" }))
      .rejects.toThrow(/identity/i);

    const firstRun = await service.callWorkflow({ workflowId: first.id, caller: parentCaller, input: {}, idempotencyKey: "first" });
    const firstCaller = { workflowId: first.id, runId: firstRun.id, nodeId: "work" };
    await expect(service.callWorkflow({ workflowId: first.id, caller: firstCaller, input: {}, idempotencyKey: "self" }))
      .rejects.toThrow(/recursion/i);
    const secondRun = await service.callWorkflow({ workflowId: second.id, caller: firstCaller, input: {}, idempotencyKey: "second" });
    const secondCaller = { workflowId: second.id, runId: secondRun.id, nodeId: "work" };
    await expect(service.callWorkflow({ workflowId: first.id, caller: secondCaller, input: {}, idempotencyKey: "cycle" }))
      .rejects.toThrow(/recursion/i);
  });
});
