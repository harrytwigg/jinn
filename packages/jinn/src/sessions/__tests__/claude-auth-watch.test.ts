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
  status: { state: "access-expired", fingerprint: "pair-A", accessExpiresAt: 1, refreshExpiresAt: 2 } as ClaudeCredentialStatus,
  config: { connectors: {} } as Record<string, unknown>,
}));

vi.mock("../callbacks.js", () => ({
  notifyOperatorChannel: vi.fn((message: string, onSent?: () => void) => {
    hoisted.sent.push(message);
    if (hoisted.deliver) onSent?.();
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

beforeEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
  hoisted.sent.length = 0;
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
  it("alerts once for an outage of many failures, then once on recovery", () => {
    for (let i = 0; i < 42; i++) observeClaudeTurnOutcome(undefined, AUTH_FAILED, at(i * 60_000));

    expect(hoisted.sent).toHaveLength(1);
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
    );
  });

  it("retries the alert on the next failure when the first did not deliver", () => {
    hoisted.deliver = false;
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, NOW);
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, at(60_000));
    expect(hoisted.sent).toHaveLength(2);
    hoisted.deliver = true;
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, at(120_000));
    observeClaudeTurnOutcome(undefined, AUTH_FAILED, at(180_000));
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
    checkClaudeRefreshExpiry(at(60_000));
    expect(hoisted.sent).toHaveLength(1);
    expect(hoisted.sent[0]).toContain("⚠️ The Claude login on");
    expect(hoisted.sent[0]).toContain("expires in 24 h");
  });
});
