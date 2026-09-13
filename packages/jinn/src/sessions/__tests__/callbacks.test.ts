import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const callbackDeliveryMockState = vi.hoisted(() => {
  const state = {
    deliveries: new Map<string, any>(),
    nextId: 1,
  };
  const get = vi.fn((id: string) =>
    [...state.deliveries.values()].find((delivery) => delivery.id === id),
  );
  const claim = vi.fn((input: any) => {
    const key = [
      input.targetSessionId,
      input.sourceKind,
      input.sourceId,
      input.sourceAttempt,
      input.sourceOutcome,
      input.sourceVersion,
      input.deliveryKind,
    ].join("|");
    const existing = state.deliveries.get(key);
    if (existing) return { delivery: existing, claimed: false };
    const delivery = {
      id: `callback-delivery-${state.nextId++}`,
      ...input,
      status: "pending",
      messageId: null,
      queueItemId: null,
      attemptCount: 0,
      nextAttemptAt: null,
      lastAttemptAt: null,
      lastError: null,
      deadLetteredAt: null,
      createdAt: new Date().toISOString(),
      acceptedAt: null,
    };
    state.deliveries.set(key, delivery);
    return { delivery, claimed: true };
  });
  const claimAttempt = vi.fn((id: string, now: number, leaseMs: number) => {
    const delivery = [...state.deliveries.values()].find((candidate) => candidate.id === id);
    if (!delivery || delivery.status !== "pending" || (delivery.nextAttemptAt !== null && delivery.nextAttemptAt > now)) {
      return undefined;
    }
    delivery.attemptCount++;
    delivery.lastAttemptAt = now;
    delivery.nextAttemptAt = now + leaseMs;
    delivery.lastError = null;
    return delivery;
  });
  const recordFailure = vi.fn((id: string, error: string, options: { now: number; nextAttemptAt: number; maxAttempts: number }) => {
    const delivery = [...state.deliveries.values()].find((candidate) => candidate.id === id);
    if (!delivery || delivery.status !== "pending") return delivery;
    delivery.lastError = error;
    if (delivery.attemptCount >= options.maxAttempts) {
      delivery.status = "dead_letter";
      delivery.nextAttemptAt = null;
      delivery.deadLetteredAt = options.now;
    } else {
      delivery.nextAttemptAt = options.nextAttemptAt;
    }
    return delivery;
  });
  const listPending = vi.fn(() =>
    [...state.deliveries.values()].filter((delivery) => delivery.status === "pending"),
  );
  return Object.assign(state, { get, claim, claimAttempt, recordFailure, listPending });
});

// Mock dependencies before importing the module under test
vi.mock("../registry.js", () => ({
  getSession: vi.fn(),
  getSessionDelivery: callbackDeliveryMockState.get,
  updateSession: vi.fn((id: string, updates: Partial<Session>) => ({ ...makeSession({ id }), ...updates })),
  claimDelegationCompletionNudge: vi.fn((id: string, workItemId: string) => makeSession({
    id,
    workItemId,
    transportMeta: { delegationCompletionContract: { workItemId, state: "nudged" } },
  })),
  markDelegationCompletionSurfaced: vi.fn((id: string, workItemId: string) => makeSession({
    id,
    workItemId,
    transportMeta: { delegationCompletionContract: { workItemId, state: "surfaced" } },
  })),
  releaseDelegationCompletionNudge: vi.fn(),
  clearDelegationCompletionGuard: vi.fn(),
  listDelegationCompletionNudgedSessions: vi.fn(() => []),
  claimSessionDelivery: callbackDeliveryMockState.claim,
  claimSessionDeliveryAttempt: callbackDeliveryMockState.claimAttempt,
  recordSessionDeliveryFailure: callbackDeliveryMockState.recordFailure,
  listPendingSessionDeliveries: callbackDeliveryMockState.listPending,
  ensureCallbackAttemptToken: vi.fn(() => "legacy-attempt-token"),
  consumeChildReportedToParent: vi.fn(() => true),
}));

vi.mock("../../work-items/store.js", () => ({
  getWorkItem: vi.fn(),
}));

vi.mock("../../shared/config.js", () => ({
  loadConfig: vi.fn(() => ({ gateway: { port: 7777 } })),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { __resetCallbackRetrySweepForTest, notifyManagerVisibility, notifyParentOfExternalTurn, notifyParentSession, notifyRateLimitResumed, recoverOrphanedDelegationCompletionClaims, recoverPendingSessionDeliveries } from "../callbacks.js";
import { claimSessionDelivery, consumeChildReportedToParent, getSession, listDelegationCompletionNudgedSessions, markDelegationCompletionSurfaced } from "../registry.js";
import { getWorkItem } from "../../work-items/store.js";
import type { Session } from "../../shared/types.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "child-001",
    engine: "claude",
    engineSessionId: null,
    source: "api",
    sourceRef: "api:test",
    connector: null,
    sessionKey: "test-key",
    replyContext: null,
    messageId: null,
    transportMeta: null,
    employee: "test-employee",
    model: "opus",
    title: null,
    parentSessionId: "parent-001",
    status: "idle",
    attemptOutcome: "succeeded",
    attemptToken: "attempt-001",
    attemptTerminalVersion: 1,
    effortLevel: null,
    totalCost: 0,
    totalTurns: 0,
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastError: null,
    ...overrides,
  } as Session;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  callbackDeliveryMockState.deliveries.clear();
  callbackDeliveryMockState.nextId = 1;
  vi.mocked(claimSessionDelivery).mockClear();
});

afterEach(() => {
  __resetCallbackRetrySweepForTest();
});

describe("notifyManagerVisibility", () => {
  it("posts one structured notification through the durable session-message route", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    notifyManagerVisibility("manager-session", {
      manager: "team-lead",
      managerDisplay: "Team Lead",
      delegator: "org-root",
      delegatorDisplay: "Org Root",
      employee: "worker",
      employeeDisplay: "Worker",
      childSessionId: "worker-child",
      workItemId: "wi_visibility",
      title: "Inspect a bounded incident",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7777/api/sessions/manager-session/message");
    const body = JSON.parse(opts.body);
    expect(body.role).toBe("notification");
    expect(body.message).toContain("Org Root delegated directly to Worker");
    expect(body.message).toContain("Inspect a bounded incident");
    expect(body.message).toContain("wi_visibility");
    expect(body.displayMessage).toContain("Skip-level visibility");
    expect(body.meta).toEqual({
      kind: "manager-visibility",
      manager: "team-lead",
      delegator: "org-root",
      employee: "worker",
      childSessionId: "worker-child",
      workItemId: "wi_visibility",
    });

    globalThis.fetch = originalFetch;
  });

  it("uses one stable durable receipt when the same visibility input is replayed", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const details = {
      manager: "team-lead",
      managerDisplay: "Team Lead",
      delegator: "org-root",
      delegatorDisplay: "Org Root",
      employee: "worker",
      employeeDisplay: "Worker",
      childSessionId: "worker-child",
      workItemId: "wi_visibility_replay",
      title: "Inspect one replayed incident",
    };

    for (let index = 0; index < 6; index++) {
      notifyManagerVisibility("manager-session", details);
    }

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(claimSessionDelivery).toHaveBeenCalledTimes(6);
    expect(vi.mocked(claimSessionDelivery).mock.calls[0][0]).toMatchObject({
      targetSessionId: "manager-session",
      sourceKind: "session",
      sourceId: "worker-child",
      sourceAttempt: "manager-visibility:wi_visibility_replay",
      sourceOutcome: "manager-visibility",
      sourceVersion: 1,
      deliveryKind: "manager-visibility",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toMatchObject({
      callbackDeliveryId: "callback-delivery-1",
      meta: { kind: "manager-visibility", workItemId: "wi_visibility_replay" },
    });

    globalThis.fetch = originalFetch;
  });
});

describe("notifyParentSession — no parent", () => {
  it("does nothing if child has no parentSessionId", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = spy as unknown as typeof fetch;

    const child = makeSession({ parentSessionId: null });
    notifyParentSession(child, { result: "done" });

    await new Promise((r) => setTimeout(r, 150));
    expect(spy).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });
});

describe("delegation completion startup recovery", () => {
  it("surfaces an orphaned nudged claim to its parent before marking it surfaced", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const child = makeSession({
      workItemId: "wi-orphan",
      transportMeta: {
        delegationCompletionTracked: true,
        delegationCompletionContract: { workItemId: "wi-orphan", state: "nudged" },
      },
    });
    vi.mocked(listDelegationCompletionNudgedSessions).mockReturnValue([child]);
    vi.mocked(getSession).mockReturnValue(makeSession({ id: "parent-001", parentSessionId: null }));

    await expect(recoverOrphanedDelegationCompletionClaims()).resolves.toBe(1);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:7777/api/sessions/parent-001/message");
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).message).toContain("restart");
    expect(markDelegationCompletionSurfaced).toHaveBeenCalledWith("child-001", "wi-orphan");
    globalThis.fetch = originalFetch;
  });
});

describe("notifyParentSession", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    callbackDeliveryMockState.deliveries.clear();
    callbackDeliveryMockState.nextId = 1;
    vi.mocked(claimSessionDelivery).mockClear();
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );
    vi.mocked(getWorkItem).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it.each([
    ["empty", ""],
    ["whitespace", " \n\t "],
    ["zero-width space", "\u200B"],
    ["zero-width non-joiner", "\u200C"],
    ["zero-width joiner", "\u200D"],
    ["word joiner", "\u2060"],
    ["zero-width no-break space", "\uFEFF"],
    ["mixed invisible content", " \u200B\u200C\u200D\u2060\uFEFF\n"],
  ])("does not create a child-reply callback for a %s assistant result", async (_label, result) => {
    notifyParentSession(makeSession(), { result });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(claimSessionDelivery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("routes a qualifying progress-only child back to itself and suppresses the parent callback", async () => {
    vi.mocked(getWorkItem).mockReturnValue({ id: "wi-open", status: "executing", source: "delegation" } as never);
    const child = makeSession({ workItemId: "wi-open", transportMeta: { delegationCompletionTracked: true } });

    notifyParentSession(child, {
      result: "Progress update: the implementation is still in progress. I will continue with the test run.",
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7777/api/sessions/child-001/message");
    const body = JSON.parse(opts.body);
    expect(body.role).toBe("notification");
    expect(body.message).toContain("Continue the work now");
  });

  it("enforces the completion contract even when ordinary parent replies are suppressed", async () => {
    vi.mocked(getWorkItem).mockReturnValue({ id: "wi-open", status: "executing", source: "delegation" } as never);
    const child = makeSession({ workItemId: "wi-open", transportMeta: { delegationCompletionTracked: true } });

    notifyParentSession(
      child,
      { result: "Progress update: I will continue with the remaining implementation." },
      { alwaysNotify: false },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:7777/api/sessions/child-001/message");
  });

  it("retries a completion-contract nudge under one durable receipt after response loss", async () => {
    vi.mocked(getWorkItem).mockReturnValue({ id: "wi-open", status: "executing", source: "delegation" } as never);
    const child = makeSession({ workItemId: "wi-open", transportMeta: { delegationCompletionTracked: true } });
    fetchSpy.mockRejectedValueOnce(new Error("accepted response lost")).mockResolvedValue({ ok: true });

    notifyParentSession(child, {
      result: "Progress update: I will continue with the remaining implementation.",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    notifyParentSession(child, {
      result: "Progress update: I will continue with the remaining implementation.",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));

    const nudgeClaims = vi.mocked(claimSessionDelivery).mock.calls
      .map(([input]) => input)
      .filter((input) => input.deliveryKind === "delegation-completion-nudge");
    expect(nudgeClaims).toHaveLength(2);
    expect(nudgeClaims[0]).toMatchObject({
      targetSessionId: "child-001",
      sourceId: "child-001",
      sourceAttempt: "attempt-001",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
    });
    const childPosts = fetchSpy.mock.calls
      .filter(([url]) => url === "http://127.0.0.1:7777/api/sessions/child-001/message")
      .map(([, opts]) => JSON.parse(opts.body));
    expect(childPosts).toHaveLength(1);
    expect(new Set(childPosts.map((body) => body.callbackDeliveryId))).toEqual(
      new Set([expect.any(String)]),
    );
  });

  it("sends a full LLM message plus a clean display banner on success", async () => {
    const child = makeSession({
      workItemId: "wi_123",
      transportMeta: { delegationEmployeeDisplay: "Test Employee" },
    });

    notifyParentSession(child, { result: "Some result" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:7777/api/sessions/parent-001/message");

    const body = JSON.parse(opts.body);
    expect(body.role).toBe("notification");
    // LLM-facing message: full context + MCP-native pointers for following up.
    expect(body.message).toContain("replied in child session child-001");
    expect(body.message).toContain('read_session { sessionId: "child-001", last: N }');
    expect(body.message).toContain('send_to_session { sessionId: "child-001"');
    expect(body.message).not.toContain("/api/sessions");
    expect(body.message).toContain("Some result");
    // Human-facing banner: clean, no API noise
    expect(body.displayMessage).toContain("test-employee replied");
    expect(body.displayMessage).toContain("Some result");
    expect(body.displayMessage).not.toContain("GET /api/sessions");
    expect(body.meta).toMatchObject({
      kind: "child-reply",
      employee: "test-employee",
      employeeDisplay: "Test Employee",
      childSessionId: "child-001",
      fullMessage: "Some result",
    });
    expect(body.block).toMatchObject({
      op: "patch",
      block: {
        id: "dg-wi_123",
        type: "delegation",
        status: "done",
      },
    });
    expect(typeof body.block.block.payload.repliedAt).toBe("number");
  });

  it("delivers a 600-character reply whole to the parent engine", async () => {
    const result = "x".repeat(600);
    const child = makeSession();

    notifyParentSession(child, { result });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain(`Reply:\n${result}\n\n`);
    expect(body.message).not.toContain("preview");
    expect(body.message).not.toContain("clipped");
    expect(body.message).not.toContain("…");
  });

  it("delivers a 4,001-character reply whole to the parent engine", async () => {
    const result = `${"x".repeat(4_000)}z`;
    const child = makeSession();

    notifyParentSession(child, { result });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain(`Reply:\n${result}\n\n`);
    expect(body.message).not.toContain("preview");
    expect(body.message).not.toContain("clipped");
    expect(body.message).not.toContain("…");
  });

  it("delivers a 20,000-character reply whole to the parent engine", async () => {
    const result = `${"x".repeat(19_999)}z`;
    const child = makeSession();

    notifyParentSession(child, { result });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain(`Reply:\n${result}\n\n`);
    expect(body.message).not.toContain("preview");
    expect(body.message).not.toContain("clipped");
    expect(body.message).not.toContain("…");
  });

  it("delivers an exact 128,000-character reply whole to the parent engine", async () => {
    const result = `${"x".repeat(127_999)}z`;
    const child = makeSession();

    notifyParentSession(child, { result });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain(`Reply:\n${result}\n\n`);
    expect(body.message).not.toContain("preview");
    expect(body.message).not.toContain("clipped");
    expect(body.message).not.toContain("…");
  });

  it("clips replies over 128,000 characters with an honest recovery instruction", async () => {
    const result = `${"x".repeat(128_000)}z`;
    const child = makeSession();

    notifyParentSession(child, { result });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain(
      `Reply (clipped to first 128,000 of 128,001 characters):\n${"x".repeat(128_000)}…\n\n`,
    );
    expect(body.message).not.toContain(result);
    expect(body.message).toContain("The full reply is intact in child session child-001; nothing was lost.");
    expect(body.message).toContain(
      'Read it with read_session { sessionId: "child-001", last: N } rather than asking the child to resend, shorten, or compress it.',
    );
  });

  it("caps durable full callback messages at 16k without changing the 220-char display preview", async () => {
    const longResult = "x".repeat(17_000);
    const child = makeSession();

    notifyParentSession(child, { result: longResult });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.meta.fullMessage).toBe("x".repeat(16_000));
    expect(body.meta.fullMessage).toHaveLength(16_000);
    expect(body.displayMessage).toBe(`📩 test-employee replied\n${"x".repeat(220)}…`);
  });

  it("includes full preview for short results", async () => {
    const shortResult = "Task done successfully";
    const child = makeSession();

    notifyParentSession(child, { result: shortResult });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain(shortResult);
    expect(body.message).not.toContain("...");
  });

  it("error notifications contain the error message", async () => {
    const child = makeSession({ workItemId: "wi_123" });

    notifyParentSession(child, { error: "Something broke" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain("Something broke");
    expect(body.message).toContain("⚠️");
    expect(body.displayMessage).toBe("⚠️ test-employee couldn't finish\nSomething broke");
    expect(body.meta).toMatchObject({ kind: "child-error", childSessionId: "child-001" });
    expect(body.block).toMatchObject({
      op: "patch",
      block: { id: "dg-wi_123", type: "delegation", status: "error" },
    });
  });

  it('sends with "notification" role', async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.role).toBe("notification");
  });

  it("claims one durable identity for six duplicate completion callbacks before posting", async () => {
    const child = makeSession();

    for (let index = 0; index < 6; index++) {
      notifyParentSession(child, { result: "same terminal result" });
    }
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(claimSessionDelivery).toHaveBeenCalledTimes(6);
    expect(vi.mocked(claimSessionDelivery).mock.calls[0][0]).toMatchObject({
      targetSessionId: "parent-001",
      sourceId: "child-001",
      sourceAttempt: "attempt-001",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(new Set(fetchSpy.mock.calls.map((call) => JSON.parse(call[1].body).callbackDeliveryId)))
      .toEqual(new Set(["callback-delivery-1"]));
    expect(vi.mocked(claimSessionDelivery).mock.invocationCallOrder[0])
      .toBeLessThan(fetchSpy.mock.invocationCallOrder[0]);
  });

  it("suppresses the auto callback when the child already reported to its parent this attempt", async () => {
    // The child sent to its parent via send_to_session during attempt-001, which
    // recorded the marker. The automatic parent-completion callback for the SAME
    // attempt is a duplicate and must not create a second parent wake.
    const child = makeSession({ transportMeta: { reportedToParentAttempt: "attempt-001" } });
    vi.mocked(getSession).mockImplementation((id: string) =>
      id === child.id ? child : makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );

    notifyParentSession(child, { result: "already relayed this to the parent" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(claimSessionDelivery).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    // One relay suppresses one callback: the marker is consumed, not left to
    // swallow every later reply of the attempt.
    expect(consumeChildReportedToParent).toHaveBeenCalledWith("child-001", "attempt-001");
  });

  it("still fires the auto callback when the marker is from a stale (earlier) attempt", async () => {
    // A new turn minted attempt-002; the attempt-001 marker no longer matches, so
    // genuinely new work still surfaces to the parent.
    const child = makeSession({ attemptToken: "attempt-002", transportMeta: { reportedToParentAttempt: "attempt-001" } });
    vi.mocked(getSession).mockImplementation((id: string) =>
      id === child.id ? child : makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );

    notifyParentSession(child, { result: "fresh work from the re-invoked turn" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(claimSessionDelivery).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("still surfaces an ERROR even if the child reported to its parent this attempt", async () => {
    // Errors always surface — the explicit report may predate the failure.
    const child = makeSession({ transportMeta: { reportedToParentAttempt: "attempt-001" } });
    vi.mocked(getSession).mockImplementation((id: string) =>
      id === child.id ? child : makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );

    notifyParentSession(child, { error: "it broke after reporting" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not post an already accepted callback receipt", async () => {
    const child = makeSession();
    const claimed = vi.mocked(claimSessionDelivery).getMockImplementation()!({
      targetSessionId: "parent-001",
      sourceKind: "session",
      sourceId: "child-001",
      sourceAttempt: "attempt-001",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: { message: "stored", displayMessage: "stored" },
    } as never);
    claimed.delivery.status = "accepted";

    notifyParentSession(child, { result: "same terminal result" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("honors persisted backoff when the callback is re-emitted after response loss", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce({ ok: true });
    const child = makeSession();

    notifyParentSession(child, { result: "done" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    notifyParentSession(child, { result: "done" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect([...callbackDeliveryMockState.deliveries.values()][0]).toMatchObject({
      status: "pending",
      attemptCount: 1,
      lastError: "response lost",
    });
  });

  it("uses a new receipt for a resumed attempt generation", async () => {
    notifyParentSession(makeSession(), { result: "first completion" });
    notifyParentSession(makeSession({ attemptToken: "attempt-002" }), { result: "resumed completion" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new Set(fetchSpy.mock.calls.map((call) => JSON.parse(call[1].body).callbackDeliveryId)).size).toBe(2);
  });
});

describe("callback outbox startup recovery", () => {
  beforeEach(() => {
    callbackDeliveryMockState.deliveries.clear();
    callbackDeliveryMockState.nextId = 1;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("reposts a claimed-but-unaccepted delivery after restart", async () => {
    vi.mocked(claimSessionDelivery).getMockImplementation()!({
      targetSessionId: "parent-001",
      sourceKind: "session",
      sourceId: "child-001",
      sourceAttempt: "attempt-001",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-completion",
      payload: { message: "stored engine prompt", displayMessage: "stored display" },
    } as never);

    await expect(recoverPendingSessionDeliveries()).resolves.toBe(1);

    const fetchSpy = vi.mocked(globalThis.fetch);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)).toMatchObject({
      callbackDeliveryId: "callback-delivery-1",
    });
  });
});

describe("notifyParentSession — non-talk parent (regression)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("non-talk parent receives MCP-native read and follow-up guidance", async () => {
    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle", source: "api" }),
    );
    const child = makeSession({ title: "My task", employee: "test-employee" });
    notifyParentSession(child, { result: "Some result" });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const childId = "child-001";
    const employeeName = "test-employee";
    const raw = "Some result";
    const expectedMessage =
      `📩 Employee "${employeeName}" replied in child session ${childId}.\n\n` +
      `Reply:\n${raw}\n\n` +
      `To read the reply in context: read_session { sessionId: "${childId}", last: N } · ` +
      `to follow up: send_to_session { sessionId: "${childId}", message: "<message>" }`;
    expect(body.message).toBe(expectedMessage);
    expect(body.message).not.toContain("/api/sessions");
  });

  it("non-talk parent error keeps byte-identical message format (regression)", async () => {
    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle", source: "api" }),
    );
    const child = makeSession({ employee: "test-employee" });
    notifyParentSession(child, { error: "Something broke" });
    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const expectedMessage = `⚠️ Employee "test-employee" (child session child-001) hit an error and could not finish: Something broke`;
    expect(body.message).toBe(expectedMessage);
    expect(body.displayMessage).toBe(`⚠️ test-employee couldn't finish\nSomething broke`);
  });

  it("non-talk parent keeps byte-identical format (regression)", async () => {
    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle", source: "api" }),
    );
    const child = makeSession({ employee: "test-employee" });
    notifyRateLimitResumed(child);
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toBe(
      `🔄 Employee "test-employee" (session child-001) has resumed after rate limit cleared.`,
    );
  });
});

describe("notifyParentSession — alwaysNotify suppression", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    vi.mocked(getSession).mockReturnValue(
      makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("skips notification when alwaysNotify is false (success)", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" }, { alwaysNotify: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips notification when alwaysNotify is false (error)", async () => {
    const child = makeSession();

    notifyParentSession(child, { error: "Something broke" }, { alwaysNotify: false });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends notification when alwaysNotify is true", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" }, { alwaysNotify: true });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("sends notification when options is undefined (backward compat)", async () => {
    const child = makeSession();

    notifyParentSession(child, { result: "done" });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe("notifyParentOfExternalTurn", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    vi.mocked(consumeChildReportedToParent).mockReset().mockImplementation(() => true);
    vi.mocked(getSession).mockImplementation((id: string) =>
      id === "child-001" ? makeSession() : makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );
    vi.mocked(getWorkItem).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("wakes the parent with the reply text, keyed apart from the settle callback of the same attempt", async () => {
    // The settle callback for attempt-001 already went out; the child's PTY then
    // produced another Stop (background subagent finished, model re-invoked).
    const child = makeSession();
    notifyParentSession(child, { result: "Own findings are drafted; persona reviewers still running." });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await notifyParentOfExternalTurn(child, "# Round 5 — Changes required\n\nP1: …", "2026-09-13T11:12:16.217Z");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const identities = vi.mocked(claimSessionDelivery).mock.calls.map((call) => call[0]);
    expect(identities[0]).toMatchObject({ sourceAttempt: "attempt-001", deliveryKind: "parent-completion" });
    expect(identities[1]).toMatchObject({
      targetSessionId: "parent-001",
      sourceId: "child-001",
      sourceAttempt: "attempt-001:external:2026-09-13T11:12:16.217Z",
      sourceOutcome: "succeeded",
      sourceVersion: 1,
      deliveryKind: "parent-external-turn",
    });
    const body = JSON.parse(fetchSpy.mock.calls[1][1].body);
    expect(fetchSpy.mock.calls[1][0]).toBe("http://127.0.0.1:7777/api/sessions/parent-001/message");
    expect(body.role).toBe("notification");
    expect(body.message).toContain('Employee "test-employee" replied in child session child-001');
    expect(body.message).toContain("# Round 5 — Changes required");
    expect(body.displayMessage).toBe("📩 test-employee replied\n# Round 5 — Changes required P1: …");
    expect(body.meta).toMatchObject({ kind: "child-reply", employee: "test-employee", childSessionId: "child-001" });
  });

  it("gives each external reply its own durable receipt, and a redelivered Stop none", async () => {
    const child = makeSession();
    await notifyParentOfExternalTurn(child, "Waiting on maintainability and adversarial.", "2026-09-13T11:05:46.031Z");
    await notifyParentOfExternalTurn(child, "Waiting on maintainability and adversarial.", "2026-09-13T11:05:46.031Z");
    await notifyParentOfExternalTurn(child, "Adversarial reviewer still running.", "2026-09-13T11:08:37.180Z");

    expect(claimSessionDelivery).toHaveBeenCalledTimes(3);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(new Set(fetchSpy.mock.calls.map((call) => JSON.parse(call[1].body).callbackDeliveryId)).size).toBe(2);
  });

  it("skips a child with no parent, an empty reply, and a parent in error", async () => {
    await notifyParentOfExternalTurn(makeSession({ parentSessionId: null }), "orphan reply", "k1");
    await notifyParentOfExternalTurn(makeSession(), "  \u200b ", "k2");
    vi.mocked(getSession).mockImplementation((id: string) =>
      id === "child-001" ? makeSession() : makeSession({ id: "parent-001", parentSessionId: null, status: "error" }),
    );
    await notifyParentOfExternalTurn(makeSession(), "parent is gone", "k3");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("honours alwaysNotify: false the way the settle callback does", async () => {
    await notifyParentOfExternalTurn(makeSession(), "quiet employee reply", "k1", { alwaysNotify: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is suppressed once by an explicit relay in the same attempt, then fires again for the next reply", async () => {
    // Round-6 shape: the child relayed its findings with send_to_session, and the
    // Stop that ends that model turn carries a summary — a duplicate. But the
    // marker must not also swallow a later reply of the same attempt.
    let marker: string | undefined = "attempt-001";
    vi.mocked(getSession).mockImplementation((id: string) =>
      id === "child-001"
        ? makeSession({ transportMeta: marker ? { reportedToParentAttempt: marker } : null })
        : makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );
    vi.mocked(consumeChildReportedToParent).mockImplementation(() => { marker = undefined; return true; });

    await notifyParentOfExternalTurn(makeSession(), "Findings sent to senior-developer.", "k1");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(consumeChildReportedToParent).toHaveBeenCalledWith("child-001", "attempt-001");

    await notifyParentOfExternalTurn(makeSession(), "Post-pass verification of 4bea763b: pass stands.", "k2");
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it.each([
    ["an empty settle", { result: "" }],
    ["a failed settle", { error: "engine error after the relay" }],
  ])("consumes the relay marker at %s so the next external reply still fires (QA F1)", async (_label, settle) => {
    // The child relayed with send_to_session, then its gateway turn settled
    // without a sendable success reply while the CLI kept working. The marker
    // must not survive that settle to swallow the real report that follows.
    let marker: string | undefined = "attempt-001";
    vi.mocked(getSession).mockImplementation((id: string) =>
      id === "child-001"
        ? makeSession({ transportMeta: marker ? { reportedToParentAttempt: marker } : null })
        : makeSession({ id: "parent-001", parentSessionId: null, status: "idle" }),
    );
    vi.mocked(consumeChildReportedToParent).mockImplementation(() => { marker = undefined; return true; });

    notifyParentSession(makeSession(), settle);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(consumeChildReportedToParent).toHaveBeenCalledWith("child-001", "attempt-001");
    // An error always surfaces; an empty success sends nothing.
    expect(fetchSpy).toHaveBeenCalledTimes("error" in settle ? 1 : 0);

    await notifyParentOfExternalTurn(makeSession(), "# Findings\n\nP1 …", "k1");
    expect(fetchSpy).toHaveBeenCalledTimes("error" in settle ? 2 : 1);
    expect(JSON.parse(fetchSpy.mock.calls.at(-1)![1].body).message).toContain("# Findings");
  });

  it("does not apply the delegation completion contract to an external reply", async () => {
    // A progress-only reply from a Todo child at SETTLE earns one nudge; the
    // same words in a post-settle continuation are a follow-up, not a second
    // settle, and must reach the parent as-is.
    vi.mocked(getWorkItem).mockReturnValue({ id: "GEN-64", status: "executing" } as never);
    const child = makeSession({ workItemId: "GEN-64" } as Partial<Session>);
    await notifyParentOfExternalTurn(child, "Still waiting on two reviewers.", "k1");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toContain("Still waiting on two reviewers.");
    expect(body.message).not.toContain("Delegation completion contract");
    expect(body.block).toMatchObject({ op: "patch", block: { id: "dg-GEN-64", type: "delegation", status: "done" } });
  });
});
