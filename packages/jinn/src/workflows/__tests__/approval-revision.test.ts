import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Employee,
  ModelRegistry,
  WorkflowAttemptCommand,
  WorkflowAttemptCompletion,
  WorkflowAttemptCompletionListener,
} from "../../shared/types.js";
import type {
  WorkflowTodoEventClaim,
  WorkflowTodoEventClaimOutcome,
  WorkflowTodoEventFeed,
  WorkflowTodoStatusEvent,
} from "../../work-items/workflow-event-feed.js";
import type { JsonValue, TriggerNode, WorkflowDefinition, WorkflowNode } from "../model.js";
import { openWorkflowDatabase } from "../repository-migrations.js";
import { WorkflowRepository } from "../repository.js";
import type { WorkflowSessionExecutor } from "../session-executor.js";
import { WorkflowService } from "../service.js";
import type { WorkflowRevisionRequest, WorkflowTodoLifecycle } from "../runner.js";

/* Rejecting a run-bound gate WITH a note means "do it again with this"; rejecting
 * with no note means stop. Before this, a note went onto the approval record where
 * nothing read it, so the only way to get another round was to describe the problem
 * somewhere and re-arm the Todo by hand.
 *
 * This file covers the run side: what the runner does to the run, and what it hands
 * the Todo surface. Where the Todo itself ends up (the cycle bound, the report paths)
 * is gateway/__tests__/workflow-todo-revision.test.ts. */

const employee: Employee = {
  name: "worker", displayName: "Worker", department: "operations", rank: "employee",
  engine: "test-engine", model: "test-model", effortLevel: "high", persona: "Complete the task.",
};
const models: ModelRegistry = {
  "test-engine": {
    name: "test-engine", available: true, defaultModel: "test-model", effortMechanism: "codex-config",
    models: [{ id: "test-model", label: "Test", supportsEffort: true, effortLevels: ["high"] }],
  },
};

class FakeExecutor {
  readonly commands: WorkflowAttemptCommand[] = [];
  private readonly listeners = new Set<WorkflowAttemptCompletionListener>();

  async startAttempt(command: WorkflowAttemptCommand): Promise<{ sessionId: string }> {
    this.commands.push(command);
    return { sessionId: `session:${command.owner.nodeId}:${command.owner.attempt}` };
  }
  async stopAttempt(): Promise<void> {}
  subscribe(listener: WorkflowAttemptCompletionListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  readTerminalCompletion(): WorkflowAttemptCompletion | null { return null; }
  attemptState(): { idle: boolean; runningChildren: number } { return { idle: true, runningChildren: 0 }; }

  async succeed(nodeId: string, fields: Record<string, JsonValue> = {}): Promise<void> {
    const command = this.commands.filter((item) => item.owner.nodeId === nodeId).at(-1)!;
    await Promise.all([...this.listeners].map((listener) => listener({
      sessionId: `session:${nodeId}:${command.owner.attempt}`, owner: command.owner,
      terminalVersion: 1, turn: 1, completedAt: now.toISOString(), outcome: "succeeded",
      finalText: `Done.\n\`\`\`jinn-output\n${JSON.stringify(fields)}\n\`\`\``,
    } as WorkflowAttemptCompletion)));
  }
}

/** Feeds Todo status events straight to the trigger service, so a run can be bound
 *  to a Todo by the trigger that really binds them without a work-items database. */
class FakeFeed implements WorkflowTodoEventFeed {
  pending: WorkflowTodoStatusEvent[] = [];
  claimEvent(_eventId: string, definitionIds: string[]): WorkflowTodoEventClaim {
    return { state: "acquired", definitionIds };
  }
  completeEvent(eventId: string, _outcomes: WorkflowTodoEventClaimOutcome[]): void {
    this.pending = this.pending.filter((event) => event.id !== eventId);
  }
  deferEvent(): void {} releaseEvent(): void {}
  listPendingEvents(): WorkflowTodoStatusEvent[] { return this.pending; }
}

class RecordingLifecycle implements WorkflowTodoLifecycle {
  readonly reflections: Array<{ todoId: string; status: string; nodeId: string }> = [];
  readonly failures: Array<{ todoId: string; code: string }> = [];
  readonly revisions: WorkflowRevisionRequest[] = [];
  readonly decisions: Array<Parameters<WorkflowTodoLifecycle["recordApprovalDecision"]>[0]> = [];
  readonly completions: Array<Parameters<WorkflowTodoLifecycle["complete"]>[0]> = [];
  reflect(input: Parameters<WorkflowTodoLifecycle["reflect"]>[0]): void {
    this.reflections.push({ todoId: input.todoId, status: input.status, nodeId: input.nodeId });
  }
  recordFailure(input: Parameters<WorkflowTodoLifecycle["recordFailure"]>[0]): void {
    this.failures.push({ todoId: input.todoId, code: input.error.code });
  }
  recordApprovalDecision(input: Parameters<WorkflowTodoLifecycle["recordApprovalDecision"]>[0]): void {
    this.decisions.push(input);
  }
  complete(input: Parameters<WorkflowTodoLifecycle["complete"]>[0]): void { this.completions.push(input); }
  requestRevision(input: WorkflowRevisionRequest): void { this.revisions.push(input); }
}

let root: string;
let database: Database.Database;
let repository: WorkflowRepository;
let executor: FakeExecutor;
let feed: FakeFeed;
let lifecycle: RecordingLifecycle;
let service: WorkflowService;
let events = 0;
const now = new Date("2026-07-30T10:00:00.000Z");

function edge(id: string, from: string, port: string, to: string) {
  return { id, from: { nodeId: from, port }, to: { nodeId: to, port: "input" as const } };
}
function worker(id: string): WorkflowNode {
  return {
    id, type: "employee", name: id, config: {
      employee: { source: "fixed", value: "worker" }, prompt: `Run ${id}.`,
      output: { fields: {}, allowAdditionalFields: true },
    },
  };
}
/** Through the SERVICE, not the repository: enabling is what (re)builds the
 *  trigger index a Todo event is matched against. */
function save(id: string, nodes: WorkflowNode[], edges: ReturnType<typeof edge>[]): WorkflowDefinition {
  const created = service.createDefinition({ id, title: id });
  const saved = service.saveDefinition({ ...created, inputs: [], nodes, edges }, created.revision);
  return service.setEnabled({ id: saved.id, enabled: true, expectedRevision: saved.revision });
}

/**
 * trigger → plan → gate → land, with the gate's `rejected` port routed to a
 * failure End — the shape jinn-build has, and the shape that made a rejection
 * terminal. `trigger` is the Todo trigger, so the re-arm target is read from it.
 */
function todoPipeline(id: string, trigger: TriggerNode["config"]): WorkflowDefinition {
  return save(id, [
    { id: "start", type: "trigger", name: "Start", config: trigger },
    worker("plan"),
    { id: "gate", type: "approval", name: "Gate", config: { description: "Approving merges this branch into main." } },
    worker("land"),
    { id: "done", type: "end", name: "Done", config: { result: "success" } },
    { id: "not-merged", type: "end", name: "Not merged", config: { result: "failure" } },
  ], [
    edge("start-plan", "start", "success", "plan"),
    edge("plan-gate", "plan", "success", "gate"),
    edge("gate-land", "gate", "approved", "land"),
    edge("gate-stop", "gate", "rejected", "not-merged"),
    edge("land-done", "land", "success", "done"),
  ]);
}

/** Fire a Todo status event through the real trigger service and park on the gate. */
async function runToGate(definition: WorkflowDefinition, todoId: string,
  toStatus: WorkflowTodoStatusEvent["toStatus"], actor: string) {
  events += 1;
  feed.pending.push({
    id: `wie_${events}`, workItemId: todoId, fromStatus: "backlog", toStatus, actor, actorEmployee: null, armedAsDelegate: null, quotaWindowDecided: false,
    item: { source: "human", department: null, assignee: null, labels: [{ id: "lbl_0000000000ab", name: "build" }], autoStart: true, live: { assignee: null, parentId: null, status: toStatus } },
  });
  await service.recover(now.toISOString());
  const run = service.listRuns(definition.id, { limit: 10 }).items.at(-1)!;
  await executor.succeed("plan");
  return service.getRun(definition.id, run.id)!;
}

async function decide(definition: WorkflowDefinition, runId: string, decision: "approve" | "reject",
  opts: { reason?: string; decidedBy?: string } = {}) {
  return service.decideApproval({ workflowId: definition.id, runId, nodeId: "gate", decision,
    decidedBy: opts.decidedBy ?? "operator", ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    expectedRevision: service.getRun(definition.id, runId)!.revision });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-workflow-revise-"));
  database = openWorkflowDatabase(path.join(root, "workflows.db"));
  repository = new WorkflowRepository(database);
  executor = new FakeExecutor();
  feed = new FakeFeed();
  lifecycle = new RecordingLifecycle();
  service = new WorkflowService({
    repository, executor: executor as unknown as WorkflowSessionExecutor,
    employees: () => new Map([[employee.name, employee]]), models: () => models, now: () => now.toISOString(),
    todoLifecycle: lifecycle, todoApprovals: { request: () => {}, notifyParked: () => {} },
    todoEventFeed: feed,
  });
});

afterEach(() => {
  service.dispose();
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a rejection carrying feedback sends the work round again", () => {
  it("stops the run and asks for a revision at the status the Todo trigger fires on", async () => {
    const definition = todoPipeline("revise-happy", { kind: "todo-status", status: "assigned", actor: "operator" });
    const run = await runToGate(definition, "OPS-1", "assigned", "operator");

    await decide(definition, run.id, "reject", { reason: "The empty state still reads as an error." });

    // Cancelled, not failed: a human stopped this on purpose, and a failed run
    // would reflect `blocked` onto the very Todo being re-armed.
    const settled = service.getRun(definition.id, run.id)!;
    expect(settled.status).toBe("cancelled");
    expect(settled.error?.code).toBe("workflow-revision-requested");
    expect(lifecycle.failures).toEqual([]);
    expect(lifecycle.reflections.map((entry) => entry.status)).toEqual(["executing", "in_review"]);

    expect(lifecycle.revisions).toEqual([{
      todoId: "OPS-1", workflowId: definition.id, runId: run.id, nodeId: "gate",
      feedback: "The empty state still reads as an error.", decidedBy: "operator",
      rearm: { status: "assigned", actor: "operator" },
    }]);
    expect(lifecycle.decisions).toEqual([{
      todoId: "OPS-1", workflowId: definition.id, runId: run.id, nodeId: "gate",
      decision: "reject", decidedBy: "operator", note: "The empty state still reads as an error.",
    }]);
    expect(lifecycle.completions).toEqual([]);
  });

  it("does NOT take the authored rejected route — feedback is a different decision", async () => {
    const definition = todoPipeline("revise-skips-route", { kind: "todo-status", status: "assigned" });
    const run = await runToGate(definition, "OPS-2", "assigned", "operator");

    await decide(definition, run.id, "reject", { reason: "Try again with tabular numbers." });

    // `not-merged` is the graph's answer to "no". This was "not yet".
    const settled = service.getRun(definition.id, run.id)!;
    expect(settled.nodeRuns.find((node) => node.nodeId === "not-merged")!.status).toBe("pending");
    expect(settled.nodeRuns.find((node) => node.nodeId === "gate")!.status).toBe("completed");
    expect(settled.approvals.find((approval) => approval.nodeId === "gate"))
      .toMatchObject({ status: "rejected", reason: "Try again with tabular numbers." });
  });

  it("treats a whitespace-only note as silence", async () => {
    const definition = todoPipeline("revise-blank-note", { kind: "todo-status", status: "assigned" });
    const run = await runToGate(definition, "OPS-3", "assigned", "operator");

    await decide(definition, run.id, "reject", { reason: "   \n  " });

    expect(lifecycle.revisions).toEqual([]);
    expect(lifecycle.decisions).toEqual([{
      todoId: "OPS-3", workflowId: definition.id, runId: run.id, nodeId: "gate",
      decision: "reject", decidedBy: "operator",
    }]);
    expect(service.getRun(definition.id, run.id)!.status).toBe("failed");
    expect(lifecycle.reflections.at(-1)).toMatchObject({ status: "blocked", nodeId: "not-merged" });
  });

  it("carries the trigger's own filters into the re-arm, and reports a NON-operator actor", async () => {
    // The actor is whoever rejected, so a mismatch is fatal; the label is carried because a phase may have taken it off and the re-arm has to put it back.
    const definition = todoPipeline("revise-actor-filter", {
      kind: "todo-status", status: "assigned", actor: "reconciler", label: "build",
    });
    const run = await runToGate(definition, "OPS-4", "assigned", "reconciler");

    await decide(definition, run.id, "reject", { reason: "Wrong shade of blue." });

    expect(lifecycle.revisions.at(-1)!.rearm).toEqual({ status: "assigned", actor: "reconciler", label: "build" });
    expect(lifecycle.revisions.at(-1)!.decidedBy).toBe("operator");
  });

  it("says a disabled definition cannot fire, rather than leaving the Todo looking queued", async () => {
    const definition = todoPipeline("revise-disabled", { kind: "todo-status", status: "assigned" });
    const run = await runToGate(definition, "OPS-5", "assigned", "operator");

    const current = service.getDefinition(definition.id)!;
    service.setEnabled({ id: definition.id, enabled: false, expectedRevision: current.revision });
    await decide(definition, run.id, "reject", { reason: "Needs a second pass." });

    expect(lifecycle.revisions.at(-1)!.rearm).toEqual({ unavailable: `workflow \`${definition.id}\` is disabled` });
  });

  it("says a retired definition cannot fire", async () => {
    const definition = todoPipeline("revise-retired", { kind: "todo-status", status: "assigned" });
    const run = await runToGate(definition, "OPS-6", "assigned", "operator");

    const current = service.getDefinition(definition.id)!;
    service.setRetired({ id: definition.id, retired: true, expectedRevision: current.revision });
    await decide(definition, run.id, "reject", { reason: "Needs a second pass." });

    expect(lifecycle.revisions.at(-1)!.rearm).toEqual({ unavailable: `workflow \`${definition.id}\` is retired` });
  });

  it("reads the re-arm target from the CURRENT definition, not the run's snapshot", async () => {
    const definition = todoPipeline("revise-retargeted", { kind: "todo-status", status: "assigned" });
    const run = await runToGate(definition, "OPS-7", "assigned", "operator");

    // The trigger moves to a different entry status while the run is parked.
    const current = service.getDefinition(definition.id)!;
    service.saveDefinition({
      ...current,
      nodes: current.nodes.map((node): WorkflowNode => node.id === "start"
        ? { id: "start", type: "trigger", name: "Start", config: { kind: "todo-status", status: "backlog" } }
        : node),
    }, current.revision);
    await decide(definition, run.id, "reject", { reason: "Start over from the top." });

    expect(lifecycle.revisions.at(-1)!.rearm).toEqual({ status: "backlog" });
  });

  it("cannot re-arm a definition with no Todo trigger", async () => {
    const definition = todoPipeline("revise-no-todo-trigger", { kind: "manual" });
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-8" });
    await executor.succeed("plan");

    await decide(definition, run.id, "reject", { reason: "Not what I meant." });

    expect(lifecycle.revisions.at(-1)!.rearm)
      .toEqual({ unavailable: `workflow \`${definition.id}\` has no Todo trigger to re-arm` });
  });

  it("leaves an unbound run's rejection entirely alone", async () => {
    const definition = todoPipeline("revise-unbound", { kind: "manual" });
    const run = await service.startManual({ workflowId: definition.id, input: {} });
    await executor.succeed("plan");

    await decide(definition, run.id, "reject", { reason: "Not what I meant." });

    expect(lifecycle.revisions).toEqual([]);
    expect(lifecycle.decisions).toEqual([]);
    expect(service.getRun(definition.id, run.id)!.status).toBe("failed");
  });

  it("blocks the Todo when a rejection has nowhere to go at all", async () => {
    // No `rejected` edge: the decision ends the run, and until now the bound Todo
    // kept reading `in_review` behind a run that was already dead.
    const definition = save("revise-unrouted", [
      { id: "start", type: "trigger", name: "Start", config: { kind: "manual" } },
      worker("plan"),
      { id: "gate", type: "approval", name: "Gate", config: { description: "Ship it?" } },
      { id: "done", type: "end", name: "Done", config: { result: "success" } },
    ], [
      edge("start-plan", "start", "success", "plan"),
      edge("plan-gate", "plan", "success", "gate"),
      edge("gate-done", "gate", "approved", "done"),
    ]);
    const run = await service.startManual({ workflowId: definition.id, input: {}, todoId: "OPS-9" });
    await executor.succeed("plan");

    await decide(definition, run.id, "reject");

    expect(service.getRun(definition.id, run.id)!.status).toBe("failed");
    expect(lifecycle.reflections.at(-1)).toEqual({ todoId: "OPS-9", status: "blocked", nodeId: "gate" });
    expect(lifecycle.failures.at(-1)).toEqual({ todoId: "OPS-9", code: "workflow-approval-route-missing" });
  });
});
