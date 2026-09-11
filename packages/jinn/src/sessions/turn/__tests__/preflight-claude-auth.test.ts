import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Employee, JinnConfig, Session } from "../../../shared/types.js";
import type { TurnInput } from "../types.js";

/**
 * GEN-53: a Claude launch on credentials a launch has already proved dead is
 * refused in preflight — a cron fire then records a failed run with the fix
 * in it, instead of a spawned CLI, a four-second `authentication_failed`, and
 * a work item minted for nothing. The verdict itself lives in the auth watch;
 * this checks preflight asks it exactly when it should.
 */

vi.mock("../../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../claude-auth-watch.js", () => ({ refuseClaudeLaunch: vi.fn() }));
vi.mock("../../../gateway/budgets.js", () => ({ isBudgetExhausted: vi.fn(() => false) }));
vi.mock("../../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/models.js")>()),
  engineAvailable: vi.fn(() => true),
  effortLevelsForModel: vi.fn(() => []),
}));

import { refuseClaudeLaunch } from "../../claude-auth-watch.js";
import { preflightTurn } from "../preflight.js";

const config = { engines: { default: "claude", claude: {}, codex: {} } } as unknown as JinnConfig;
const engines = new Map([["claude", {} as never], ["codex", {} as never]]);

const dev: Employee = {
  name: "assistant", displayName: "Assistant", department: "general", rank: "senior", engine: "claude", model: "sonnet", persona: "",
};

function input(engine: string, extra: Partial<TurnInput> = {}): TurnInput {
  const session = { id: "s1", engine, source: "cron", status: "running", attemptToken: "t" } as unknown as Session;
  return {
    session, attemptToken: "t", prompt: "go", attachments: [], config, engines, gatewayBootId: "boot",
    connectorNames: [], channel: "cron", user: "system", employee: dev, ...extra,
  } as TurnInput;
}

beforeEach(() => vi.mocked(refuseClaudeLaunch).mockReset());

describe("preflightTurn and the Claude auth watch", () => {
  it("refuses a Claude turn with the watch's reason", () => {
    vi.mocked(refuseClaudeLaunch).mockReturnValue("Claude is not logged in on gateway-host — run `claude auth login` there as the gateway user.");

    const plan = preflightTurn(input("claude"));

    expect(plan).toEqual({ ok: false, error: expect.stringContaining("claude auth login") });
    expect(refuseClaudeLaunch).toHaveBeenCalledWith(dev);
  });

  it("runs a Claude turn the watch has no objection to", () => {
    vi.mocked(refuseClaudeLaunch).mockReturnValue(undefined);
    expect(preflightTurn(input("claude")).ok).toBe(true);
  });

  it("does not ask for a turn on another engine, or for the PTY view's own engine", () => {
    preflightTurn(input("codex"));
    preflightTurn(input("claude", { engineOverride: {} as never }));
    expect(refuseClaudeLaunch).not.toHaveBeenCalled();
  });
});
