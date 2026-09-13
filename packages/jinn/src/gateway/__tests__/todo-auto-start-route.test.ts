import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CALLER_SESSION_CAPABILITY_HEADER,
  CALLER_SESSION_HEADER,
  TOOL_CALL_HEADER,
  TOOL_CALL_HEADER_VALUE,
  ensureSessionCapability,
} from "../../mcp/identity.js";
import { call, startRouteHarness, stopRouteHarness, type Registry, type WorkItems } from "./todo-route-harness.js";

/**
 * GEN-67: the two facts a `todo-status` auto-start binding reads so it does not
 * spawn a second session on a Todo that already has one — the employee behind
 * the move (`actorEmployee`, stamped from the session's own identity) and the
 * Todo's explicit opt-out (`autoStart` on its dispatch config) — as the routes
 * write them.
 */

let registry: Registry;
let workItems: WorkItems;

function callerHeaders(sessionId: string): Record<string, string> {
  return {
    [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE,
    [CALLER_SESSION_HEADER]: sessionId,
    [CALLER_SESSION_CAPABILITY_HEADER]: ensureSessionCapability(sessionId),
  };
}

function workerSession(sourceRef: string) {
  return registry.createSession({
    engine: "codex", source: "web", sourceRef, connector: "web", employee: "route-worker", prompt: "work",
  });
}

async function pendingEvent(workItemId: string) {
  const feed = await import("../../work-items/workflow-event-feed.js");
  return feed.createWorkflowTodoEventFeed({ ownerId: `test-${workItemId}` }).listPendingEvents()
    .find((event) => event.workItemId === workItemId && event.toStatus === "assigned");
}

beforeAll(async () => { ({ registry, workItems } = await startRouteHarness()); });
afterAll(stopRouteHarness);

describe("actorEmployee on the assignment event", () => {
  it("names the session's employee when an employee claims a Todo for themself, and nobody for the operator", async () => {
    const session = workerSession("gen67-self-claim");
    const created = await call("POST", "/api/work-items", { title: "self-claimed" }, callerHeaders(session.id));
    expect(created.status).toBe(201);
    const id = created.body.workItem.id as string;

    const assigned = await call("POST", `/api/work-items/${id}/assign`, { assignee: "route-worker" }, callerHeaders(session.id));
    expect(assigned.status).toBe(200);
    expect(await pendingEvent(id)).toMatchObject({
      actor: `session:${session.id}`, actorEmployee: "route-worker", item: { assignee: "route-worker", autoStart: true },
    });

    const handed = workItems.createWorkItem({ title: "operator assigned", source: "human" });
    expect((await call("POST", `/api/work-items/${handed.id}/assign`, { assignee: "route-worker" })).status).toBe(200);
    expect(await pendingEvent(handed.id)).toMatchObject({ actor: "operator", actorEmployee: null });
  });

  it("stamps a session's plain status move to assigned the same way", async () => {
    const session = workerSession("gen67-status-move");
    const item = workItems.createWorkItem({ title: "status move", source: "human", assignee: "route-worker" });
    const moved = await call("POST", `/api/work-items/${item.id}/status`, { status: "assigned" }, callerHeaders(session.id));
    expect(moved.status).toBe(200);
    expect(await pendingEvent(item.id)).toMatchObject({ actor: `session:${session.id}`, actorEmployee: "route-worker" });
  });
});

describe("autoStart on the Todo's dispatch config", () => {
  it("is written at creation, read on the Todo and on the assignment event, and refuses a non-boolean", async () => {
    const session = workerSession("gen67-create-opt-out");
    const refused = await call("POST", "/api/work-items", { title: "bad flag", autoStart: "no" }, callerHeaders(session.id));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain("autoStart");

    const created = await call("POST", "/api/work-items", { title: "no auto-start", autoStart: false }, callerHeaders(session.id));
    expect(created.status).toBe(201);
    const id = created.body.workItem.id as string;
    expect((await call("GET", `/api/work-items/${id}`)).body.dispatchConfig).toMatchObject({ autoStart: false, skills: [] });

    expect((await call("POST", `/api/work-items/${id}/assign`, { assignee: "route-worker" })).status).toBe(200);
    expect(await pendingEvent(id)).toMatchObject({ actorEmployee: null, item: { autoStart: false } });
  });

  it("stores nothing for autoStart: true at creation, and is settable afterwards through dispatch-config", async () => {
    const created = await call("POST", "/api/work-items", { title: "default auto-start", autoStart: true });
    expect(created.status).toBe(201);
    const id = created.body.workItem.id as string;
    expect((await call("GET", `/api/work-items/${id}`)).body.dispatchConfig).toBeNull();

    expect((await call("PUT", `/api/work-items/${id}/dispatch-config`, { autoStart: "false" })).status).toBe(400);
    const optedOut = await call("PUT", `/api/work-items/${id}/dispatch-config`, { autoStart: false });
    expect(optedOut.status).toBe(200);
    expect(optedOut.body.dispatchConfig).toMatchObject({ autoStart: false });
    const restored = await call("PUT", `/api/work-items/${id}/dispatch-config`, { autoStart: true });
    expect(restored.body.dispatchConfig).toMatchObject({ autoStart: true });
  });
});
