import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-dispatch-tools-home-"));

const { workItemDispatchTools } = await import("../work-item-dispatch-tools.js");

interface SeenCall {
  url: string;
  method: string;
  body?: unknown;
}

function stub(responder: (call: SeenCall) => { status: number; body: unknown }) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const call: SeenCall = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const { status, body } = responder(call);
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as unknown as Response;
  }) as unknown as typeof fetch;
  return {
    calls,
    ctx: {
      gatewayUrl: "http://gateway.test",
      fetchFn,
      callerSessionId: "session-test",
      sessionCapability: "cap-test",
    } satisfies JinnMcpContext,
  };
}

function tool(name: string): JinnMcpTool {
  const tools = workItemDispatchTools();
  const found = [tools.dispatch, tools.dispatchConfig, tools.landOn].find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe("dispatch_work_item", () => {
  it("posts to the Todo's dispatch route with no body of its own", async () => {
    const { calls, ctx } = stub(() => ({ status: 201, body: { workItemId: "JIN-9", sessionId: "s-1", status: "running", reused: false } }));

    const result = await tool("dispatch_work_item").handler({ id: "JIN-9" }, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/api/work-items/JIN-9/dispatch");
    expect(calls[0].body).toEqual({});
    expect(result).toMatchObject({ workItemId: "JIN-9", sessionId: "s-1" });
  });

  // The honesty contract's server half. A Todo a todo-status trigger already
  // claimed refuses this with a reason the Shaper is meant to report and stop
  // on, so the reason has to survive the tool boundary word for word — a
  // generic "dispatch failed" is an invitation to retry around a claim.
  it("propagates the route's 409 body verbatim as the tool error", async () => {
    const reason = "Todo JIN-9 is already being dispatched by session s-earlier; wait for it or cancel that attempt";
    const { ctx } = stub(() => ({ status: 409, body: { error: reason } }));

    await expect(tool("dispatch_work_item").handler({ id: "JIN-9" }, ctx)).rejects.toThrow(reason);
    await expect(tool("dispatch_work_item").handler({ id: "JIN-9" }, ctx)).rejects.toThrow(/conflicted \(409\)/);
  });

  it("propagates a 403 from the authority check with the route's own words", async () => {
    const reason = 'employee "todo-shaper" does not own Todo JIN-9 and is not its authorized manager/root; cannot dispatch';
    const { ctx } = stub(() => ({ status: 403, body: { error: reason } }));

    await expect(tool("dispatch_work_item").handler({ id: "JIN-9" }, ctx)).rejects.toThrow(reason);
  });

  it("refuses an id that is not a canonical Todo ID before reaching the gateway", async () => {
    const { calls, ctx } = stub(() => ({ status: 201, body: {} }));

    await expect(tool("dispatch_work_item").handler({ id: "not-an-id" }, ctx)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("set_work_item_dispatch", () => {
  it("puts only the fields the caller named", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { workItemId: "JIN-9", engine: "codex" } }));

    await tool("set_work_item_dispatch").handler({ id: "JIN-9", engine: "codex" }, ctx);

    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/api/work-items/JIN-9/dispatch-config");
    expect(calls[0].body).toEqual({ engine: "codex" });
  });

  it("refuses an empty call rather than sending a no-op", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));

    await expect(tool("set_work_item_dispatch").handler({ id: "JIN-9" }, ctx)).rejects.toThrow(/at least one/);
    expect(calls).toHaveLength(0);
  });

  it("sends an explicit null to clear an override", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));

    await tool("set_work_item_dispatch").handler({ id: "JIN-9", engine: null, model: null }, ctx);

    expect(calls[0].body).toEqual({ engine: null, model: null });
  });

  it("sends autoStart on its own, and refuses a non-boolean before reaching the gateway", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));

    await tool("set_work_item_dispatch").handler({ id: "JIN-9", autoStart: false }, ctx);
    expect(calls[0].body).toEqual({ autoStart: false });

    await expect(tool("set_work_item_dispatch").handler({ id: "JIN-9", autoStart: "no" }, ctx)).rejects.toThrow(/autoStart/);
    expect(calls).toHaveLength(1);
  });
});

describe("land_on_work_item", () => {
  it("posts to the Todo's capture-landing route with no body of its own", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: { workItemId: "JIN-4", workItemTitle: "Rail scrolls", sessionId: "session-test" } }));

    const result = await tool("land_on_work_item").handler({ id: "JIN-4" }, ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/api/work-items/JIN-4/capture-landing");
    expect(calls[0].body).toEqual({});
    expect(result).toMatchObject({ workItemId: "JIN-4", sessionId: "session-test" });
  });

  // Same contract as the dispatch verb: the gateway's refusal reaches the agent
  // word for word, so a Todo that is gone reads as gone rather than as a
  // generic failure it might retry around.
  it("surfaces the gateway's own words when the Todo is not there", async () => {
    const { ctx } = stub(() => ({ status: 404, body: { error: "Todo JIN-9 not found" } }));

    await expect(tool("land_on_work_item").handler({ id: "JIN-9" }, ctx)).rejects.toThrow(/Todo JIN-9 not found/);
  });

  it("refuses a Todo id that is not one", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));

    await expect(tool("land_on_work_item").handler({ id: "nope" }, ctx)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
