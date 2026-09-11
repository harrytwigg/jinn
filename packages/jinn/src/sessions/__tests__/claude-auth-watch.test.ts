import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeCredentialStatus } from "../../shared/claude-auth.js";
import type { Employee } from "../../shared/types.js";

const TEST_HOME = path.join(os.tmpdir(), "jinn-claude-auth-watch-test");
vi.mock("../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/paths.js")>()),
  JINN_HOME: path.join(os.tmpdir(), "jinn-claude-auth-watch-test"),
}));

const hoisted = vi.hoisted(() => ({
  sent: [] as string[],
  deliver: true,
  /** Delivery callbacks not yet run — `settle()` drains them. */
  pending: [] as (() => void)[],
  status: { state: "access-expired", fingerprint: "pair-A", accessExpiresAt: 1, refreshExpiresAt: 2 } as ClaudeCredentialStatus,
  config: { connectors: {} } as Record<string, unknown>,
}));

// Delivery is a promise in production, so `onResult` lands on a later tick.
// The suite keeps that shape: a mock that confirms synchronously hides the
// window in which a burst of failures all see "nobody has alerted yet".
vi.mock("../callbacks.js", () => ({
  notifyOperatorChannel: vi.fn((message: string, onResult?: (sent: boolean) => void) => {
    hoisted.sent.push(message);
    hoisted.pending.push(() => onResult?.(hoisted.deliver));
  }),
}));
vi.mock("../../shared/engine-health.js", () => ({ recordEngineUnavailable: vi.fn() }));
vi.mock("../../shared/config.js", () => ({ loadConfig: vi.fn(() => hoisted.config) }));
vi.mock("../../shared/claude-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/claude-auth.js")>()),
  readClaudeCredentialStatus: vi.fn(() => hoisted.status),
}));
vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { recordEngineUnavailable } from "../../shared/engine-health.js";
import { activeClaudeAuthOutage, CLAUDE_AUTH_RECHECK_MS, LOCAL_CLAUDE_AUTH_SCOPE } from "../../shared/claude-auth-outage.js";
import {
  checkClaudeRefreshExpiry,
  claudeAuthScope,
  isClaudeAuthFailure,
  observeClaudeCredentialsValid,
  observeClaudeTurnOutcome,
  refuseClaudeLaunch,
} from "../claude-auth-watch.js";

const NOW = new Date("2026-09-11T02:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const AUTH_FAILED = "Interactive turn failed: authentication_failed";

const remoteDev: Employee = {
  name: "senior-developer", displayName: "Senior Developer", department: "general", rank: "senior",
  engine: "claude", model: "opus", persona: "", remoteHost: "buildbox", remoteUser: "dev", remoteCwd: "/srv/jinn-work/main",
};

/** Run the delivery callbacks the operator channel still owes us. */
const settle = () => {
  const due = hoisted.pending.splice(0);
  for (const run of due) run();
};

beforeEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  hoisted.sent.length = 0;
  hoisted.pending.length = 0;
  hoisted.deliver = true;
  hoisted.status = { state: "access-expired", fingerprint: "pair-A", accessExpiresAt: 1, refreshExpiresAt: 2 };
  hoisted.config = { connectors: {} };
  vi.mocked(recordEngineUnavailable).mockClear();
});
afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe("isClaudeAuthFailure / claudeAuthScope", () => {
  it("recognises the two account-level refusals and nothing else", () => {
    expect(isClaudeAuthFailure(AUTH_FAILED)).toBe(true);
    expect(isClaudeAuthFailure("Interactive turn failed: oauth_org_not_allowed")).toBe(true);
    expect(isClaudeAuthFailure("Interactive turn failed: rate_limit")).toBe(false);
    expect(isClaudeAuthFailure("Interactive turn failed: server_error")).toBe(false);
    expect(isClaudeAuthFailure(null)).toBe(false);
  });

  it("scopes a local employee to the gateway and a remote one to its host and profile", () => {
    expect(claudeAuthScope(undefined)).toBe(LOCAL_CLAUDE_AUTH_SCOPE);
    expect(claudeAuthScope({ ...remoteDev, remoteHost: undefined })).toBe(LOCAL_CLAUDE_AUTH_SCOPE);
    expect(claudeAuthScope(remoteDev)).toBe("dev@buildbox");
    expect(claudeAuthScope({ ...remoteDev, remoteClaudeConfigDir: "/home/dev/.claude-work" }))
      .toBe("dev@buildbox:/home/dev/.claude-work");
  });
});

describe("observeClaudeTurnOutcome", () => {
  // GEN-53 review: none of these 42 settle their delivery, so every one of
  // them is a turn that failed while the first alert was still in flight —
  // six cron jobs firing at 02:00 is exactly this shape.
  it("alerts once for an outage of many failures, then once on recovery", () => {
    for (let i = 0; i < 42; i++) observeClaudeTurnOutcome(undefined, AUTH_FAILED, at(i * 60_000));

    expect(hoisted.sent).toHaveLength(1);
    settle();
    expect(hoisted.sent[0]).toContain("🔐 Claude authentication failed on the gateway host");
    expect(hoisted.sent[0]).toContain("claude auth login");
    expect(activeClaudeAuthOutage(LOCAL_CLAUDE_AUTH_SCOPE)).toMatchObject({ failures: 42, credentialFingerprint: "pair-A" });

    observeClaudeTurnOutcome(undefined, null, at(6 * 60 * 60_000));
    expect(hoisted.sent).toHaveLength(2);
    expect(hoisted.sent[1]).toContain("✅ Claude authentication recovered on the gateway host");
    expect(hoisted.sent[1]).toContain("42 turns failed");
    expect(activeClaudeAuthOutage(LOCAL_CLAUDE_AUTH_SCOPE)).toBeUndefined();
  });

  it("offers the Telegram login route only when the connector's provider login is enabled", () => {
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, NOW);
    expect(hoisted.sent[0]).not.toContain("/auth claude");

    fs.rmSync(TEST_HOME, { recursive: true, force: true });
    hoisted.config = { connectors: { telegram: { botToken: "t", allowFrom: [1], telegramAuth: { enabled: true, ownerUserIds: [1] } } } };
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, NOW);
    expect(hoisted.sent[1]).toContain("or send `/auth claude` to this bot");
  });

  it("marks the engine unhealthy so new sessions prefer a fallback, with the fix in the reason", () => {
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, NOW);
    expect(recordEngineUnavailable).toHaveBeenCalledWith(
      "claude",
      expect.stringContaining("claude auth login"),
      Math.floor((NOW.getTime() + CLAUDE_AUTH_RECHECK_MS) / 1000),
      NOW,
      // Stamped with THIS machine: a remote employee's Claude Code is signed in
      // on its own host, so a record that did not say whose login had died
      // would steer its sessions off an engine that was working.
      { host: os.hostname() },
    );
  });

  it("retries the alert on the next failure when the first did not deliver", () => {
    hoisted.deliver = false;
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, NOW);
    settle();
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, at(60_000));
    settle();
    expect(hoisted.sent).toHaveLength(2);

    hoisted.deliver = true;
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, at(120_000));
    settle();
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, at(180_000));
    settle();
    expect(hoisted.sent).toHaveLength(3);
  });

  it("says nothing on a healthy turn with no outage open, and nothing on errors that are not about the login", () => {
    observeClaudeTurnOutcome(undefined, null, NOW);
    observeClaudeTurnOutcome(undefined, "Interactive turn failed: server_error", NOW);
    expect(hoisted.sent).toHaveLength(0);
    expect(fs.existsSync(path.join(TEST_HOME, "tmp", "claude-auth-outage.json"))).toBe(false);
  });

  it("keeps a remote host's outage separate and never touches the gateway's engine health for it", () => {
    observeClaudeTurnOutcome(remoteDev, AUTH_FAILED, NOW);
    expect(hoisted.sent[0]).toContain("failed on dev@buildbox");
    expect(recordEngineUnavailable).not.toHaveBeenCalled();
    expect(activeClaudeAuthOutage(LOCAL_CLAUDE_AUTH_SCOPE)).toBeUndefined();
    expect(activeClaudeAuthOutage("dev@buildbox")?.failures).toBe(1);
  });
});

describe("refuseClaudeLaunch", () => {
  it("lets the first launch through, then refuses on the same dead pair", () => {
    expect(refuseClaudeLaunch(undefined, NOW)).toBeUndefined();
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, NOW);

    const refused = refuseClaudeLaunch(undefined, at(60_000));
    expect(refused).toContain("could not refresh its expired login");
    expect(refused).toContain("claude auth login");
    expect(activeClaudeAuthOutage(LOCAL_CLAUDE_AUTH_SCOPE)?.skipped).toBe(1);
  });

  it("closes the outage and lets the launch through as soon as a live pair from a login is on disk", () => {
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, NOW);
    hoisted.status = { state: "ok", fingerprint: "pair-B", accessExpiresAt: 3, refreshExpiresAt: 4 };

    expect(refuseClaudeLaunch(undefined, at(60_000))).toBeUndefined();
    expect(activeClaudeAuthOutage(LOCAL_CLAUDE_AUTH_SCOPE)).toBeUndefined();
    expect(hoisted.sent).toHaveLength(2);
    expect(hoisted.sent[1]).toContain("✅ Claude authentication recovered");
  });

  it("refuses when the disk says no login at all, outage or not", () => {
    hoisted.status = { state: "missing", path: "/home/h/.claude/.credentials.json" };
    expect(refuseClaudeLaunch(undefined, NOW)).toContain("not logged in");
  });

  // GEN-53 review: a disk verdict is refused from the very first turn, so no
  // launch ever reaches Claude Code to fail. Alerting only from the failure
  // path left this state refused forever and never announced.
  it("opens the outage and alerts on a disk verdict no launch could ever report", () => {
    hoisted.status = { state: "missing", path: "/home/h/.claude/.credentials.json" };

    refuseClaudeLaunch(undefined, NOW);
    settle();

    expect(hoisted.sent).toHaveLength(1);
    expect(hoisted.sent[0]).toContain("🔐 Claude authentication failed on the gateway host");
    expect(hoisted.sent[0]).toContain("There is no credentials file at /home/h/.claude/.credentials.json");
    expect(hoisted.sent[0]).toContain("claude auth login");
    // And new sessions are steered off Claude, which only the failure path did.
    expect(recordEngineUnavailable)
      .toHaveBeenCalledWith("claude", expect.stringContaining("claude auth login"), expect.any(Number), NOW, { host: os.hostname() });

    // Every later refusal is counted, and stays quiet.
    refuseClaudeLaunch(undefined, at(60_000));
    refuseClaudeLaunch(undefined, at(120_000));
    settle();
    expect(hoisted.sent).toHaveLength(1);
    expect(activeClaudeAuthOutage(LOCAL_CLAUDE_AUTH_SCOPE)).toMatchObject({ failures: 0, skipped: 3 });
  });

  it("closes a disk-verdict outage and says what it cost once a login lands", () => {
    hoisted.status = { state: "missing", path: "/home/h/.claude/.credentials.json" };
    refuseClaudeLaunch(undefined, NOW);
    settle();

    hoisted.status = { state: "ok", fingerprint: "pair-B", accessExpiresAt: 3, refreshExpiresAt: 4 };
    expect(refuseClaudeLaunch(undefined, at(60 * 60_000))).toBeUndefined();

    expect(hoisted.sent.at(-1)).toContain("✅ Claude authentication recovered");
    expect(hoisted.sent.at(-1)).toContain("1 launch skipped");
    expect(activeClaudeAuthOutage(LOCAL_CLAUDE_AUTH_SCOPE)).toBeUndefined();
  });

  it("never refuses a remote employee: its credentials are on a host this one cannot read", () => {
    hoisted.status = { state: "missing" };
    observeClaudeTurnOutcome(remoteDev, AUTH_FAILED, NOW);
    expect(refuseClaudeLaunch(remoteDev, at(60_000))).toBeUndefined();
  });
});

describe("observeClaudeCredentialsValid", () => {
  it("closes an outage only when the pair the catalog authenticated with is not the pair that failed", () => {
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, NOW);
    observeClaudeCredentialsValid(at(60_000));
    expect(activeClaudeAuthOutage(LOCAL_CLAUDE_AUTH_SCOPE)).toBeDefined();

    hoisted.status = { state: "ok", fingerprint: "pair-B" };
    observeClaudeCredentialsValid(at(120_000));
    expect(activeClaudeAuthOutage(LOCAL_CLAUDE_AUTH_SCOPE)).toBeUndefined();
    expect(hoisted.sent.at(-1)).toContain("✅ Claude authentication recovered");
  });
});

describe("checkClaudeRefreshExpiry", () => {
  it("warns once, ahead of the refresh token's expiry", () => {
    hoisted.status = { state: "ok", fingerprint: "pair-A", refreshExpiresAt: NOW.getTime() + 24 * 60 * 60_000 };
    checkClaudeRefreshExpiry(NOW);
    settle();
    checkClaudeRefreshExpiry(at(60_000));
    expect(hoisted.sent).toHaveLength(1);
    expect(hoisted.sent[0]).toContain("⚠️ The Claude login on");
    expect(hoisted.sent[0]).toContain("expires in 24 h");
  });

  // GEN-53 review: the marker has to be written before the send (the tick
  // would otherwise re-announce while the first is in flight), so a dropped
  // alert must hand it back — this expiry gets one warning and an instance
  // with no operator channel was spending it on nobody.
  it("announces the expiry again when the warning did not land", () => {
    hoisted.status = { state: "ok", fingerprint: "pair-A", refreshExpiresAt: NOW.getTime() + 24 * 60 * 60_000 };
    hoisted.deliver = false;

    checkClaudeRefreshExpiry(NOW);
    settle();
    expect(hoisted.sent).toHaveLength(1);

    hoisted.deliver = true;
    checkClaudeRefreshExpiry(at(15 * 60_000));
    settle();
    expect(hoisted.sent).toHaveLength(2);

    // And once it lands, it is spent again.
    checkClaudeRefreshExpiry(at(30 * 60_000));
    expect(hoisted.sent).toHaveLength(2);
  });
});
