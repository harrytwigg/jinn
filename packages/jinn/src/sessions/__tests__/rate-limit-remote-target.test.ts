import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A rate limit is the one moment a turn is respawned rather than resumed, which
 * makes it the one moment a remote session can quietly come back on the gateway.
 * Both of handleRateLimit's branches are covered here:
 *
 *   Branch B (wait-and-retry) must re-state the remote target on the retry spawn.
 *   Branch A (engine substitution) must only ever hand the turn to an engine that
 *     can run on that host — one of REMOTE_ENGINE_NAMES, and actually installed
 *     there. A substitute that ignores `remoteHost` would relocate the work onto
 *     the gateway; a substitute missing from the remote host would fail the turn
 *     for a reason the operator cannot see from here.
 *
 * The regression guard runs through both: a local employee still substitutes on
 * the gateway's own availability, and a remote one still substitutes when the
 * chain names an engine that CAN go with it.
 */

// ── Mocks (must be declared before importing the module under test) ──────────

const engineAvailableMock = vi.fn<(...args: unknown[]) => boolean>();
vi.mock("../../shared/models.js", () => ({
  engineAvailable: (...args: unknown[]) => engineAvailableMock(...args),
  effortLevelsForModel: vi.fn(() => ["low", "medium", "high"]),
  getModelRegistry: vi.fn(() => ({})),
  // The chain walker's module reads both of these at load time.
  ENGINE_NAMES: ["claude", "codex", "antigravity", "grok", "pi", "hermes"],
  isKnownEngine: (name: string) => ["claude", "codex", "antigravity", "grok", "pi", "hermes"].includes(name),
  // NOT mocked away to a stub: which engines can relocate a turn is the fact
  // under test in the substitution cases below, so the real membership answers.
  REMOTE_ENGINE_NAMES: ["claude", "pi"],
  engineSupportsRemote: (name: string) => ["claude", "pi"].includes(name),
}));

/** What the gateway learned about the REMOTE host's PATH at the last spawn.
 *  Undefined means "never probed", which the handler must not read as absent. */
const remoteEngineAvailableMock = vi.fn<(...args: unknown[]) => boolean | undefined>();
vi.mock("../../engines/remote-stage.js", () => ({
  remoteEngineAvailable: (...args: unknown[]) => remoteEngineAvailableMock(...args),
}));

const getSessionMock = vi.fn<(...args: unknown[]) => Session | undefined>();
const updateSessionForAttemptMock = vi.fn(
  (_id: string, _token: string, updates: Partial<Session>) => makeSession(updates),
);
vi.mock("../registry.js", () => ({
  getSession: (...a: unknown[]) => getSessionMock(...a),
  getMessages: vi.fn(() => []),
  updateSessionForAttempt: (...a: Parameters<typeof updateSessionForAttemptMock>) => updateSessionForAttemptMock(...a),
  getEngineSessionRef: (session: Session, engine: string) => session.engineSessions?.[engine] ?? {},
  nextEngineSessionFields: (session: Session, engine: string, id: string) => ({
    engineSessions: { ...(session.engineSessions ?? {}), [engine]: { id } },
    ...(session.engine === engine ? { engineSessionId: id } : {}),
  }),
}));

vi.mock("../engine-run-mcp.js", () => ({ resolveEngineRunMcp: vi.fn(() => ({})) }));
vi.mock("../../shared/usageAwareness.js", () => ({ recordClaudeRateLimit: vi.fn() }));
vi.mock("../../shared/engine-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/engine-health.js")>()),
  // Nothing is exhausted in these cases: the substitute is as healthy as a
  // substitute ever gets, which is what makes its absence meaningful below.
  readEngineHealth: () => ({}),
  recordEngineUnavailable: vi.fn(),
}));
vi.mock("../../shared/effort.js", () => ({ resolveEffort: vi.fn(() => "medium") }));
vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Zero delay and a deadline well ahead, so Branch B reaches its retry spawn on
// the first pass without sleeping.
vi.mock("../../shared/rateLimit.js", () => ({
  computeNextRetryDelayMs: vi.fn(() => ({ delayMs: 0, resumeAt: undefined })),
  computeRateLimitDeadlineMs: vi.fn(() => Date.now() + 60_000),
  detectRateLimit: vi.fn(() => ({ limited: false })),
  rateLimitEngineLabel: (engine: string) => engine[0]!.toUpperCase() + engine.slice(1),
  nextUnstatedParkDelayMs: (ms: number) => ms,
  MAX_UNSTATED_PARK_ATTEMPTS: 5,
}));

import { makeSession } from "./helpers/session-fixture.js";
import { handleRateLimit, type RateLimitHandlerOpts } from "../rate-limit-handler.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { Employee, EngineResult, Session } from "../../shared/types.js";

const REMOTE = { remoteHost: "build-box", remoteUser: "jinn", remoteCwd: "/srv/jinn-work/repo" };

function employee(overrides: Partial<Employee> = {}): Employee {
  return { name: "ada", ...overrides } as Employee;
}

/**
 * A claude-primary session whose chain names codex. `substituteRun` is the codex
 * engine's run; `retryRun` is the limited engine's own, used by Branch B.
 */
function makeOpts(args: {
  substituteRun: ReturnType<typeof vi.fn>;
  retryRun: ReturnType<typeof vi.fn>;
  employee?: Employee;
  remote?: Partial<typeof REMOTE>;
  /** The engine claude's chain names. Defaults to codex — which cannot follow a
   *  session onto another machine, and is the reason most of these cases fall
   *  through to Branch B. */
  chain?: "codex" | "pi";
}): RateLimitHandlerOpts {
  const substitute = args.chain ?? "codex";
  return {
    session: makeSession(),
    attemptToken: "attempt-1",
    prompt: "hello",
    engineConfig: { bin: "claude", model: "opus" },
    config: {
      engines: {
        claude: { bin: "claude", model: "opus", fallback: [substitute] },
        codex: { bin: "codex", model: "gpt-5.6-sol" },
        pi: { bin: "pi", model: "ollama/gemma4:12b" },
      },
    } as unknown as RateLimitHandlerOpts["config"],
    engines: new Map([[substitute, { run: args.substituteRun } as unknown as RateLimitHandlerOpts["engine"]]]),
    engine: { run: args.retryRun } as unknown as RateLimitHandlerOpts["engine"],
    ...(args.employee ? { employee: args.employee } : {}),
    ...(args.remote ?? {}),
    rateLimit: { resetsAt: undefined },
    originalResult: { result: "", sessionId: "claude-thread-1" } as EngineResult,
    hooks: {},
  };
}

const answered = (result: string) => vi.fn(async (_opts: Record<string, unknown>) => ({ result, sessionId: "claude-thread-1" }) as EngineResult);

describe("handleRateLimit — the retry spawn keeps the session on its remote host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockImplementation(() => makeSession({ status: "waiting" }));
  });

  it("forwards the employee's remote target to the same-engine retry", async () => {
    // No substitute is installed, so Branch A is skipped for the ordinary reason
    // and this case measures the threading alone, not the suppression.
    engineAvailableMock.mockReturnValue(false);
    const retryRun = answered("retried");

    const outcome = await handleRateLimit(makeOpts({
      substituteRun: vi.fn(),
      retryRun,
      employee: employee(REMOTE),
    }));

    expect(outcome.kind).toBe("resumed");
    expect(retryRun).toHaveBeenCalledWith(expect.objectContaining(REMOTE));
  });

  it("keeps the employee's Claude profile on the retry, not the instance default", async () => {
    // Dropping it does not fall back to "no profile": resolveRemoteClaudeConfigDir
    // then returns the instance-wide remote.claudeConfigDir, so the respawn runs
    // as a DIFFERENT profile from the one the session was staged and
    // trust-seeded for — and the folder-trust dialog appears in front of a PTY
    // with nobody at the keyboard.
    engineAvailableMock.mockReturnValue(false);
    const retryRun = answered("retried");

    await handleRateLimit(makeOpts({
      substituteRun: vi.fn(),
      retryRun,
      employee: employee({ ...REMOTE, remoteClaudeConfigDir: "/home/u/.claude-profiles/work" }),
    }));

    expect(retryRun).toHaveBeenCalledWith(
      expect.objectContaining({ remoteClaudeConfigDir: "/home/u/.claude-profiles/work" }),
    );
  });

  it("forwards a remote target passed on the opts when no employee record carries one", async () => {
    engineAvailableMock.mockReturnValue(false);
    const retryRun = answered("retried");

    await handleRateLimit(makeOpts({ substituteRun: vi.fn(), retryRun, remote: REMOTE }));

    expect(retryRun).toHaveBeenCalledWith(expect.objectContaining(REMOTE));
  });

  it("names no host on a local employee's retry, so it stays on the gateway", async () => {
    engineAvailableMock.mockReturnValue(false);
    const retryRun = answered("retried");

    await handleRateLimit(makeOpts({ substituteRun: vi.fn(), retryRun, employee: employee() }));

    const runOpts = retryRun.mock.calls[0]![0];
    expect(runOpts.remoteHost).toBeUndefined();
    expect(runOpts.cwd).toBe(JINN_HOME);
  });
});

describe("handleRateLimit — a remote employee only substitutes onto an engine that can follow it", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionMock.mockImplementation(() => makeSession({ status: "waiting" }));
    // The substitute is configured, registered, installed and healthy — every
    // condition Branch A asks about is satisfied. Only its inability to run on
    // the other machine stops it.
    engineAvailableMock.mockReturnValue(true);
    // The host was probed at the last spawn and carries every agent, so nothing
    // below turns on a missing binary.
    remoteEngineAvailableMock.mockReturnValue(true);
  });

  it("never spawns a substitute that cannot run there, and waits the limit out on the remote host instead", async () => {
    const substituteRun = answered("from-codex");
    const retryRun = answered("retried-on-claude");

    const waitingStarts: unknown[] = [];
    const outcome = await handleRateLimit({
      ...makeOpts({ substituteRun, retryRun, employee: employee(REMOTE) }),
      hooks: { onWaitingStart: (info) => { waitingStarts.push(info); } },
    });

    // Branch A never ran: no substitute spawn, and no engine flip written.
    expect(substituteRun).not.toHaveBeenCalled();
    expect(updateSessionForAttemptMock).not.toHaveBeenCalledWith(
      "sess-1", "attempt-1", expect.objectContaining({ engine: "codex" }),
    );
    // Branch B did, on the original engine and still on the remote host.
    expect(waitingStarts).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: "resumed", result: { result: "retried-on-claude" } });
    expect(retryRun).toHaveBeenCalledWith(expect.objectContaining(REMOTE));
  });

  it("refuses the substitute on remoteHost alone, without a user or a cwd", async () => {
    const substituteRun = answered("from-codex");
    const retryRun = answered("retried-on-claude");

    const outcome = await handleRateLimit(makeOpts({
      substituteRun,
      retryRun,
      employee: employee({ remoteHost: "build-box" }),
    }));

    expect(substituteRun).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("resumed");
  });

  it("still substitutes for a local employee — the fallback is not disabled for everyone", async () => {
    const substituteRun = answered("from-codex");
    const retryRun = answered("retried-on-claude");

    const outcome = await handleRateLimit(makeOpts({ substituteRun, retryRun, employee: employee() }));

    expect(substituteRun).toHaveBeenCalledTimes(1);
    expect(retryRun).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "from-codex" } });
  });

  it("still substitutes when no employee record is attached to the turn", async () => {
    const substituteRun = answered("from-codex");

    const outcome = await handleRateLimit(makeOpts({ substituteRun, retryRun: vi.fn() }));

    expect(substituteRun).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("fallback");
  });

  it("treats a blank remoteHost as local, so a whitespace value cannot strand a turn", async () => {
    const substituteRun = answered("from-codex");

    const outcome = await handleRateLimit(makeOpts({
      substituteRun,
      retryRun: vi.fn(),
      employee: employee({ remoteHost: "   " }),
    }));

    expect(substituteRun).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("fallback");
  });

  // The point of the whole change: a Claude employee on a desktop that also has
  // Pi installed rides out an Anthropic limit on that desktop's own model,
  // instead of parking the turn until the window reopens.
  it("substitutes onto pi, on the same host, when the chain names it", async () => {
    const substituteRun = answered("from-pi");

    const outcome = await handleRateLimit(makeOpts({
      substituteRun,
      retryRun: vi.fn(),
      employee: employee(REMOTE),
      chain: "pi",
    }));

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "from-pi" } });
    // Substituting is only half of it: the substitute has to be told WHERE, or
    // the turn it takes over runs on the gateway — the failure the blanket
    // suppression existed to avoid, arriving through the engine that fixed it.
    expect(substituteRun).toHaveBeenCalledWith(expect.objectContaining(REMOTE));
  });

  it("asks the REMOTE host's PATH, not the gateway's, whether pi is installed", async () => {
    // The gateway is a Raspberry Pi with no `pi` CLI on it; the desktop has one.
    // Reading engineAvailable here would refuse the substitution over a binary
    // nothing was ever going to run locally.
    engineAvailableMock.mockReturnValue(false);
    const substituteRun = answered("from-pi");

    const outcome = await handleRateLimit(makeOpts({
      substituteRun,
      retryRun: vi.fn(),
      employee: employee(REMOTE),
      chain: "pi",
    }));

    expect(outcome.kind).toBe("fallback");
    expect(remoteEngineAvailableMock).toHaveBeenCalledWith("jinn@build-box", "pi");
  });

  it("does not hand the turn to an engine the remote host was seen not to have", async () => {
    remoteEngineAvailableMock.mockReturnValue(false);
    const substituteRun = answered("from-pi");
    const retryRun = answered("retried-on-claude");

    const outcome = await handleRateLimit(makeOpts({
      substituteRun,
      retryRun,
      employee: employee(REMOTE),
      chain: "pi",
    }));

    expect(substituteRun).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "resumed", result: { result: "retried-on-claude" } });
  });

  it("reports a substitute that fails to start, rather than stranding the session", async () => {
    // By this point beginEngineSubstitution has already written "pi" onto the
    // session, so a throw escaping handleRateLimit reaches the turn runner's
    // catch, where claimSettleableSession compares the live engine against the
    // plan's, finds them different, and drops the error as stale: no settle, no
    // reply, and a session pinned at `running` forever. Every remote spawn
    // throws on an unready host, so this is the ordinary case, not an exotic one.
    const substituteRun = vi.fn(async () => { throw new Error("remote host not ready: build-box is not reachable"); });
    const completions: EngineResult[] = [];

    const outcome = await handleRateLimit({
      ...makeOpts({ substituteRun, retryRun: vi.fn(), employee: employee(REMOTE), chain: "pi" }),
      hooks: { onFallbackComplete: (result) => { completions.push(result); } },
    });

    expect(outcome.kind).toBe("fallback");
    expect(completions).toHaveLength(1);
    expect(completions[0]!.error).toContain("build-box is not reachable");
  });

  it("still substitutes when the host has never been probed — unknown is not absent", async () => {
    // A host whose facts are not cached yet must not read as a host with nothing
    // installed on it; the spawn reports a genuinely missing binary, with the
    // PATH diagnosis this layer cannot give.
    remoteEngineAvailableMock.mockReturnValue(undefined);
    const substituteRun = answered("from-pi");

    const outcome = await handleRateLimit(makeOpts({
      substituteRun,
      retryRun: vi.fn(),
      employee: employee(REMOTE),
      chain: "pi",
    }));

    expect(outcome).toMatchObject({ kind: "fallback", result: { result: "from-pi" } });
  });
});
