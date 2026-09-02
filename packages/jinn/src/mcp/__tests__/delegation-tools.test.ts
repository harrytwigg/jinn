import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import { buildDelegationTools } from "../delegation-tools.js";
import { buildTools } from "../server.js";
import { CALLER_SESSION_HEADER, TOOL_CALL_HEADER, TOOL_CALL_HEADER_VALUE, ensureSessionCapability } from "../identity.js";
import type { JinnMcpContext, JinnMcpTool } from "../toolkit.js";

/**
 * GRS-017d — `delegate_task`, the company verb: one MCP call delegates
 * TRACKED work (work item minted + session spawned + linked, atomically, in the
 * gateway's POST /api/delegations — never composed client-side).
 *
 * Tiers, matching the 017a suite:
 *   1. REGISTRY + SCHEMA — on the belt, flat schema, teaching description.
 *   2. UNIT (stub gateway) — fail-closed identity, local param validation,
 *      exact route/body/headers, decision-shaped output + hint, readable
 *      error mapping including the preserved-intent 502.
 *   3. INTEGRATION — the tool drives the REAL route + registry + work-item
 *      store: delegate → mint + spawn + link + caller-parented, in one call;
 *      then the collect loop (read_session poll fallback) on the child.
 */

// Isolated registry DB for the integration tier. Set BEFORE the dynamic api import.
process.env.JINN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-mcp-delegate-home-"));

/* ── Unit-tier stub fetch (session-tools pattern) ───────────────────────────── */

interface SeenCall {
  url: string;
  method: string;
  body?: unknown;
  headers: Record<string, string>;
}

function stub(responder: (call: SeenCall) => { status: number; body: unknown }, callerSessionId?: string) {
  const calls: SeenCall[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const call: SeenCall = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    const { status, body } = responder(call);
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) } as unknown as Response;
  }) as unknown as typeof fetch;
  const ctx: JinnMcpContext = { gatewayUrl: "http://127.0.0.1:7777", fetchFn, callerSessionId };
  return { calls, ctx };
}

function delegateTool(): JinnMcpTool {
  const t = buildDelegationTools().find((t) => t.name === "delegate_task");
  if (!t) throw new Error("no delegate_task");
  return t;
}

describe("delegate_task — registry + schema", () => {
  it("is on the belt exactly once, next to spawn (the tracked/untracked pair)", () => {
    const names = buildTools().map((t) => t.name);
    expect(names.filter((n) => n === "delegate_task")).toHaveLength(1);
    expect(names).toContain("spawn_session");
  });

  it("accepts canonical Todo, idempotency, and managed-attachment context while keeping task required", () => {
    const t = delegateTool();
    expect(t.inputSchema.required).toEqual(["task"]);
    const props = t.inputSchema.properties as Record<string, { type: string; items?: { type: string } }>;
    expect(props.attachments).toMatchObject({ type: "array", items: { type: "string" } });
    for (const [name, prop] of Object.entries(props)) {
      if (name !== "attachments") expect(prop.type).toBe("string");
    }
    expect(Object.keys(t.inputSchema.properties).sort()).toEqual(
      ["attachments", "effortLevel", "employee", "engine", "idempotencyKey", "intent", "model", "task", "title", "workItemId"].sort(),
    );
  });

  it("teaches the division of labor and the end-turn protocol in its description", () => {
    const d = delegateTool().description;
    expect(d).toMatch(/TRACKED company work/);
    expect(d).toMatch(/Todo/);
    expect(d).toMatch(/END YOUR TURN/);
    expect(d).toMatch(/never poll/i);
    expect(d).toMatch(/role\/persona fit/);
  });

  it("teaches employee selection in the compact employee schema field", () => {
    const props = delegateTool().inputSchema.properties as Record<string, { description?: string }>;
    expect(props.employee.description).toBe(
      "Employee slug; choose by role/persona fit from list_employees/find_employees. Provide this or engine.",
    );
  });
});

describe("delegate_task — unit (stub gateway)", () => {
  it("FAILS CLOSED with no caller identity: refuses locally, zero round trips", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }));
    await expect(delegateTool().handler({ task: "t", employee: "e" }, ctx)).rejects.toThrow(
      /caller identity unavailable/i,
    );
    expect(calls).toHaveLength(0);
  });

  it("requires task, and one of employee/engine — locally, naming the discovery tool", async () => {
    const { calls, ctx } = stub(() => ({ status: 200, body: {} }), "caller-1");
    await expect(delegateTool().handler({ employee: "e" }, ctx)).rejects.toThrow(/task/i);
    await expect(delegateTool().handler({ task: "t" }, ctx)).rejects.toThrow(/list_employees/);
    expect(calls).toHaveLength(0);
  });

  it("POSTs /api/delegations with canonical Todo, idempotency, attachments, and identity headers", async () => {
    const { calls, ctx } = stub(
      () => ({
        status: 201,
        body: { workItemId: "wi_abc", sessionId: "sess-1", employee: "qa-emp", engine: "codex", model: null, status: "running" },
      }),
      "caller-1",
    );
    const out = (await delegateTool().handler(
      {
        task: "Do the thing",
        employee: "qa-emp",
        title: "The thing",
        workItemId: "wi_existing",
        idempotencyKey: "request-42",
        attachments: ["file-a", "file-b"],
      },
      ctx,
    )) as Record<string, unknown>;

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://127.0.0.1:7777/api/delegations");
    expect(calls[0].headers[CALLER_SESSION_HEADER]).toBe("caller-1");
    expect(calls[0].headers[TOOL_CALL_HEADER]).toBe(TOOL_CALL_HEADER_VALUE);
    expect(calls[0].body).toEqual({
      task: "Do the thing",
      employee: "qa-emp",
      title: "The thing",
      workItemId: "wi_existing",
      idempotencyKey: "request-42",
      attachments: ["file-a", "file-b"],
    });

    expect(out.workItemId).toBe("wi_abc");
    expect(out.sessionId).toBe("sess-1");
    const hint = String(out.hint);
    expect(hint).toContain("wi_abc");
    expect(hint).toContain("sess-1");
    expect(hint).toMatch(/END YOUR TURN/);
    expect(hint).toMatch(/read_session/);
  });

  it("maps a structured 400 readably (self-correction) and surfaces the preserved intent on a 502", async () => {
    const bad = stub(() => ({ status: 400, body: { error: 'unknown employee "ghost" — GET /api/org lists employees' } }), "c");
    await expect(delegateTool().handler({ task: "t", employee: "ghost" }, bad.ctx)).rejects.toThrow(
      /rejected \(400\).*unknown employee/i,
    );

    const spawnFail = stub(
      () => ({ status: 502, body: { error: 'engine "codex" not available', workItemId: "wi_kept" } }),
      "c",
    );
    await expect(delegateTool().handler({ task: "t", engine: "codex" }, spawnFail.ctx)).rejects.toThrow(/wi_kept/);
  });
});

/* ── Integration: the tool drives the REAL route + registry + store ────────── */

type Api = typeof import("../../gateway/api.js");
let api: Api;
type Registry = typeof import("../../sessions/registry.js");
let registry: Registry;
type Store = typeof import("../../work-items/store.js");
let store: Store;

function makeRes() {
  let status = 200;
  const chunks: Buffer[] = [];
  const res = {
    writeHead(s: number) {
      status = s;
      return this;
    },
    setHeader() {
      return this;
    },
    end(buf?: Buffer | string) {
      if (buf) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    },
  } as unknown as ServerResponse;
  return {
    res,
    get status() {
      return status;
    },
    get text() {
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

const queueStub = {
  enqueue: async () => {},
  clearCancelled: () => {},
  clearQueue: () => {},
  pauseQueue: () => {},
  resumeQueue: () => {},
  getPendingCount: () => 0,
  getTransportState: (_key: string, status: string) => status,
};
const engineStub = {
  name: "stub",
  run: async () => ({ result: "ok" }),
  isAlive: () => false,
  kill: () => {},
  killAll: () => {},
};
const apiCtx = {
  getConfig: () => ({ gateway: {}, engines: { default: "codex" }, sessions: {} }),
  connectors: new Map(),
  startTime: Date.now(),
  gatewayAuthToken: "test-token",
  emit: () => {},
  sessionManager: {
    getEngines: () => new Map(),
    getEngine: () => engineStub,
    getQueue: () => queueStub,
  },
} as unknown as import("../../gateway/api.js").ApiContext;

/** A fetch that dispatches into handleApiRequest with HEADERS FORWARDED. */
function apiFetch(): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const body = typeof init?.body === "string" ? [Buffer.from(init.body)] : [];
    const headers: Record<string, string> = { host: url.host, authorization: "Bearer test-token" };
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    const req = Object.assign(Readable.from(body), {
      method: init?.method ?? "GET",
      url: url.pathname + url.search,
      headers,
    });
    const cap = makeRes();
    await api.handleApiRequest(req as unknown as Parameters<Api["handleApiRequest"]>[0], cap.res, apiCtx);
    return { status: cap.status, text: async () => cap.text } as unknown as Response;
  }) as unknown as typeof fetch;
}

function ctxFor(callerSessionId?: string): JinnMcpContext {
  return {
    gatewayUrl: "http://gateway.test",
    fetchFn: apiFetch(),
    callerSessionId,
    sessionCapability: callerSessionId ? ensureSessionCapability(callerSessionId) : undefined,
  };
}

async function createOperatorSession(prompt: string): Promise<string> {
  const resp = await apiFetch()("http://gateway.test/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, engine: "codex" }),
  });
  expect(resp.status).toBe(201);
  return (JSON.parse(await resp.text()) as { id: string }).id;
}

function sessionTool(name: string): JinnMcpTool {
  const t = buildTools().find((t) => t.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

beforeAll(async () => {
  api = await import("../../gateway/api.js");
  registry = await import("../../sessions/registry.js");
  store = await import("../../work-items/store.js");
});

describe("delegate_task — integration against the real route + stores", () => {
  it("the delegate-and-collect loop: one call mints + spawns + links + parents; the poll fallback reads the result", async () => {
    const cooId = await createOperatorSession("I am the COO");
    const ctx = ctxFor(cooId);

    // ONE tool call = the whole transaction.
    const out = (await delegateTool().handler(
      { task: "Summarize the sprint state in one line.", engine: "codex", title: "Sprint one-liner" },
      ctx,
    )) as { workItemId: string; sessionId: string; hint: string };

    // Work item: durable, delegation-shaped, DERIVED executing (linked running session).
    const item = store.getWorkItem(out.workItemId)!;
    expect(item.status).toBe("executing");
    expect(item.title).toBe("Sprint one-liner");
    expect(item.body).toBe("Summarize the sprint state in one line.");
    expect(item.sourceRef).toMatch(new RegExp(`^delegate:${cooId}:`));

    // Session: caller-parented via the identity seam, linked to the item.
    const child = registry.getSession(out.sessionId)!;
    expect(child.parentSessionId).toBe(cooId);
    expect(registry.listSessionsByWorkItem(out.workItemId).map((s) => s.id)).toContain(out.sessionId);

    // The hint teaches the callback-wake + poll protocol, naming both ids.
    expect(out.hint).toMatch(/END YOUR TURN/);
    expect(out.hint).toContain(out.workItemId);

    // Collect via the poll fallback: the child settles with a reply; the caller
    // reads it with read_session (the callback wake itself is engine-side,
    // covered by the live QA beat — GRS-015 pattern: engines stay stubbed here).
    registry.insertMessage(out.sessionId, "assistant", "Sprint is green.");
    registry.updateSession(out.sessionId, { status: "idle" });
    const read = (await sessionTool("read_session").handler({ sessionId: out.sessionId }, ctx)) as {
      status: string;
      messages: Array<{ role?: string; content: string }>;
    };
    expect(read.status).toBe("idle");
    expect(read.messages.some((m) => m.content === "Sprint is green.")).toBe(true);
  });

  it("a tool delegation that LOST identity is refused at the route too (marker without identity → 403)", async () => {
    const resp = await apiFetch()("http://gateway.test/api/delegations", {
      method: "POST",
      headers: { "content-type": "application/json", [TOOL_CALL_HEADER]: TOOL_CALL_HEADER_VALUE },
      body: JSON.stringify({ task: "t", engine: "codex" }),
    });
    expect(resp.status).toBe(403);
    expect(await resp.text()).toMatch(/caller identity unavailable/i);
  });
});
