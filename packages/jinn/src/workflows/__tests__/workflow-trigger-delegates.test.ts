import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Employee, ModelRegistry, WorkflowAttemptCommand } from "../../shared/types.js";
import type { WorkflowTodoEventClaimOutcome, WorkflowTodoEventFeed, WorkflowTodoStatusEvent } from "../../work-items/workflow-event-feed.js";
import type { TriggerNode, WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";

/**
 * What an `actor: operator` filter accepts once the operator has delegated
 * arming. The status route stamps `armedAsDelegate` on the event; this is the
 * reading half — the stamp stands in for the operator, for that filter only,
 * and only where the binding has not opted out with `delegates: false`.
 */

const DELEGATE_SESSION = "session:6f1b0f4c-1f0f-4f0f-8f0f-0f0f0f0f0f0f";

const employee: Employee = { name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete work." };
const models: ModelRegistry = { "test-engine": { name: "test-engine", available: true, defaultModel: "test-model",
  effortMechanism: "codex-config", models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }] } };

class Executor {
  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    return { sessionId: `session:${command.owner.runId}:${command.owner.nodeId}:${command.owner.attempt}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(): () => void { return () => undefined; }
  readTerminalCompletion(): null { return null; }
}

class TodoFeed implements WorkflowTodoEventFeed {
  readonly pending: WorkflowTodoStatusEvent[] = [];
  readonly processed = new Map<string, WorkflowTodoEventClaimOutcome[]>();
  claimEvent(id: string, definitionIds: string[]) {
    const prior = this.processed.get(id); return prior ? { state: "processed" as const, outcomes: prior }
      : { state: "acquired" as const, definitionIds };
  }
  completeEvent(id: string, outcomes: WorkflowTodoEventClaimOutcome[]): void { this.processed.set(id, outcomes); }
  deferEvent(id: string, _definitionIds: string[], outcomes: WorkflowTodoEventClaimOutcome[]): void { this.processed.set(id, outcomes); }
  releaseEvent(): void {}
  listPendingEvents(): WorkflowTodoStatusEvent[] { return this.pending.filter((event) => !this.processed.has(event.id)); }
}

let root: string;
let database: Database.Database;
let feed: TodoFeed;
let service: WorkflowService;
let now: string;

function todoEvent(id: string, actor: string, armedAsDelegate: string | null): WorkflowTodoStatusEvent {
  return { id, workItemId: "ICI-1", fromStatus: "backlog", toStatus: "assigned", actor, actorEmployee: null, armedAsDelegate,
    quotaWindowDecided: false,
    item: { source: "human", department: "platform", assignee: "worker", labels: [], autoStart: true,
      live: { assignee: "worker", parentId: null, status: "assigned" } } };
}
function save(id: string, config: Omit<Extract<TriggerNode["config"], { kind: "todo-status" }>, "kind" | "status">): WorkflowDefinition {
  const draft = service.createDefinition({ id, title: id });
  const trigger: WorkflowNode = { id: "start", type: "trigger", name: "Todo",
    config: { kind: "todo-status", status: "assigned", ...config } };
  const end: WorkflowNode = { id: "finish", type: "end", name: "Finish", config: { result: "success" } };
  const saved = service.saveDefinition({ ...draft, nodes: [trigger, end],
    edges: [{ id: "trigger-end", from: { nodeId: "start", port: "success" }, to: { nodeId: "finish", port: "input" } }] },
    draft.revision);
  return service.setEnabled({ id, enabled: true, expectedRevision: saved.revision });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-delegates-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db")); now = "2026-07-21T12:00:00.000Z";
  feed = new TodoFeed();
  service = new WorkflowService({ repository: new WorkflowRepository(database, () => now),
    executor: new Executor() as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now, todoEventFeed: feed });
});
afterEach(() => { service.dispose(); database.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("todo-status triggers and arming delegates", () => {
  it("fires an operator-filtered trigger for a delegate's own move, and widens no other actor filter", async () => {
    const armable = save("todo-by-delegate", { actor: "operator" });
    const reconciler = save("todo-by-reconciler", { actor: "reconciler" });

    feed.pending.push(todoEvent("delegate-move", DELEGATE_SESSION, "worker"));
    await service.recover(now);

    expect(service.listRuns(armable.id, {}).items).toHaveLength(1);
    // The stamp answers for the operator and nobody else: a trigger watching a
    // different actor still sees the session that actually made the move.
    expect(service.listRuns(reconciler.id, {}).items).toHaveLength(0);
  });

  it("still suppresses an unstamped session move", async () => {
    const definition = save("todo-unstamped", { actor: "operator" });

    feed.pending.push(todoEvent("employee-move", DELEGATE_SESSION, null));
    await service.recover(now);

    expect(service.listRuns(definition.id, {}).items).toHaveLength(0);
    expect(feed.processed.get("employee-move")).toMatchObject([
      { workflowId: definition.id, outcome: "suppressed", detail: expect.stringContaining("is not operator") },
    ]);
  });

  it("suppresses a stamped event for a trigger that opted out, while its sibling on the same event fires", async () => {
    const optedOut = save("todo-delegates-off", { actor: "operator", delegates: false });
    const open = save("todo-delegates-on", { actor: "operator" });

    feed.pending.push(todoEvent("delegate-move", DELEGATE_SESSION, "worker"));
    await service.recover(now);

    expect(service.listRuns(optedOut.id, {}).items).toHaveLength(0);
    expect(feed.processed.get("delegate-move")).toContainEqual(
      expect.objectContaining({ workflowId: optedOut.id, outcome: "suppressed", detail: expect.stringContaining("is not operator") }),
    );
    expect(service.listRuns(open.id, {}).items).toHaveLength(1);
  });
});
