import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The ledger freezes its path from JINN_HOME at import; give this suite its own.
const TEST_HOME = path.join(os.tmpdir(), "jinn-claude-auth-outage-test");
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  JINN_HOME: path.join(os.tmpdir(), "jinn-claude-auth-outage-test"),
}));

import {
  CLAUDE_AUTH_RECHECK_MS,
  CLAUDE_REFRESH_EXPIRY_WARNING_MS,
  LOCAL_CLAUDE_AUTH_SCOPE,
  activeClaudeAuthOutage,
  claimClaudeAuthAlert,
  claimRefreshExpiryWarning,
  claudeLaunchBlocked,
  markClaudeAuthAlerted,
  noteClaudeAuthFailure,
  noteClaudeAuthOk,
  noteClaudeAuthSkipped,
  releaseClaudeAuthAlert,
  releaseRefreshExpiryWarning,
} from "../claude-auth-outage.js";
import {
  claudeAuthFailureAlert,
  claudeAuthRecoveredNotice,
  claudeRefreshExpiryWarning,
} from "../claude-auth-messages.js";
import type { ClaudeCredentialStatus } from "../claude-auth.js";

const STATE_PATH = path.join(TEST_HOME, "tmp", "claude-auth-outage.json");
const NOW = new Date("2026-09-11T02:00:00.000Z");
const HOUR = 60 * 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const LOCAL = LOCAL_CLAUDE_AUTH_SCOPE;
const HOST = "gateway-host";

const expired: ClaudeCredentialStatus = {
  state: "access-expired",
  path: "/home/h/.claude/.credentials.json",
  accessExpiresAt: NOW.getTime() - HOUR,
  refreshExpiresAt: NOW.getTime() + 20 * 24 * HOUR,
  fingerprint: "pair-A",
};

beforeEach(() => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.rmSync(STATE_PATH, { force: true });
});
afterEach(() => fs.rmSync(TEST_HOME, { recursive: true, force: true }));

describe("noteClaudeAuthFailure", () => {
  it("opens an outage on the first failure and only counts the rest", () => {
    const first = noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);
    expect(first.opened).toBe(true);
    expect(first.outage).toMatchObject({ since: NOW.toISOString(), failures: 1, skipped: 0, credentialFingerprint: "pair-A" });

    const second = noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", at(HOUR));
    expect(second.opened).toBe(false);
    expect(second.outage).toMatchObject({ since: NOW.toISOString(), failures: 2, lastFailureAt: at(HOUR).toISOString() });
  });

  it("survives a restart: the ledger is on disk, not in memory", () => {
    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);
    expect(JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")).outages[LOCAL].failures).toBe(1);
    expect(activeClaudeAuthOutage(LOCAL)?.since).toBe(NOW.toISOString());
  });

  it("opens a NEW outage when the credentials changed and it still fails — the operator needs to hear that", () => {
    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);
    const relogged = noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-B", at(HOUR));
    expect(relogged.opened).toBe(true);
    expect(relogged.outage).toMatchObject({ since: at(HOUR).toISOString(), failures: 1, credentialFingerprint: "pair-B" });
  });

  it("extends the outage when neither side knows the fingerprint (a remote scope)", () => {
    noteClaudeAuthFailure("dev@buildbox", "authentication_failed", undefined, NOW);
    expect(noteClaudeAuthFailure("dev@buildbox", "authentication_failed", undefined, at(HOUR)).opened).toBe(false);
  });

  it("keeps scopes apart", () => {
    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);
    expect(noteClaudeAuthFailure("dev@buildbox", "authentication_failed", undefined, NOW).opened).toBe(true);
    expect(activeClaudeAuthOutage(LOCAL)?.failures).toBe(1);
  });
});

describe("noteClaudeAuthOk / noteClaudeAuthSkipped / markClaudeAuthAlerted", () => {
  it("closes the outage once, returning it with what it cost", () => {
    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);
    noteClaudeAuthSkipped(LOCAL, "refused", "pair-A", at(60_000));
    noteClaudeAuthSkipped(LOCAL, "refused", "pair-A", at(120_000));
    markClaudeAuthAlerted(LOCAL, at(1000));

    const closed = noteClaudeAuthOk(LOCAL);
    expect(closed).toMatchObject({ failures: 1, skipped: 2, alertedAt: at(1000).toISOString() });
    expect(noteClaudeAuthOk(LOCAL)).toBeUndefined();
    expect(activeClaudeAuthOutage(LOCAL)).toBeUndefined();
  });

  it("is free when there is nothing to close or alert on", () => {
    expect(noteClaudeAuthOk(LOCAL)).toBeUndefined();
    markClaudeAuthAlerted(LOCAL);
    expect(claimClaudeAuthAlert(LOCAL, NOW)).toBe(false);
    expect(fs.existsSync(STATE_PATH)).toBe(false);
  });

  // GEN-53 review: a disk verdict — no credentials file, a refresh token past
  // its own expiry — is refused in preflight from the very first turn, so no
  // launch ever reaches Claude Code to fail. The refusal has to be able to
  // open the outage, or those two states are refused forever in silence.
  it("opens the outage on a refusal when no launch ever got through to fail", () => {
    const first = noteClaudeAuthSkipped(LOCAL, "no credentials file", undefined, NOW);
    expect(first.opened).toBe(true);
    expect(first.outage).toMatchObject({ since: NOW.toISOString(), failures: 0, skipped: 1 });

    const second = noteClaudeAuthSkipped(LOCAL, "no credentials file", undefined, at(60_000));
    expect(second.opened).toBe(false);
    expect(second.outage).toMatchObject({ failures: 0, skipped: 2 });
  });

  it("does not let a refusal push out the recheck window it is measured from", () => {
    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);
    noteClaudeAuthSkipped(LOCAL, "refused", "pair-A", at(30 * 60_000));
    // Still the failure's own timestamp: a skip is not a re-probe, and letting
    // it move the clock would make the block self-perpetuating.
    expect(activeClaudeAuthOutage(LOCAL)?.lastFailureAt).toBe(NOW.toISOString());
    expect(claudeLaunchBlocked(expired, LOCAL, HOST, at(CLAUDE_AUTH_RECHECK_MS))).toBeUndefined();
  });
});

// GEN-53 review: delivery is async, so several turns can fail inside one
// in-flight alert. The claim is the debounce; `alertedAt` only records that it
// landed, and by then the storm has already been sent.
describe("claimClaudeAuthAlert / releaseClaudeAuthAlert", () => {
  it("gives the alert to exactly one of a burst of concurrent failures", () => {
    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);
    const claims = [0, 1, 2, 3, 4, 5].map((i) => {
      noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", at(i));
      return claimClaudeAuthAlert(LOCAL, at(i));
    });
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(activeClaudeAuthOutage(LOCAL)?.failures).toBe(7);
  });

  it("hands the alert back when it did not land, and holds it once it did", () => {
    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);
    expect(claimClaudeAuthAlert(LOCAL, NOW)).toBe(true);
    releaseClaudeAuthAlert(LOCAL);

    expect(claimClaudeAuthAlert(LOCAL, at(60_000))).toBe(true);
    markClaudeAuthAlerted(LOCAL, at(60_000));
    expect(claimClaudeAuthAlert(LOCAL, at(120_000))).toBe(false);
  });

  it("re-arms for a new outage, so a login that still fails is announced again", () => {
    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);
    claimClaudeAuthAlert(LOCAL, NOW);
    markClaudeAuthAlerted(LOCAL, NOW);

    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-B", at(HOUR));
    expect(claimClaudeAuthAlert(LOCAL, at(HOUR))).toBe(true);
  });
});

describe("claudeLaunchBlocked", () => {
  it("never refuses on a live token, an env token, or a verdict the disk cannot give", () => {
    for (const state of ["ok", "env", "unknown"] as const) {
      expect(claudeLaunchBlocked({ ...expired, state }, LOCAL, HOST, NOW)).toBeUndefined();
    }
  });

  it("refuses outright when there are no credentials or the refresh token itself has expired", () => {
    expect(claudeLaunchBlocked({ state: "missing", path: "/x/.credentials.json" }, LOCAL, HOST, NOW))
      .toBe("Claude is not logged in on gateway-host (/x/.credentials.json) — run `claude auth login` there as the gateway user.");
    const refused = claudeLaunchBlocked({ ...expired, state: "refresh-expired", refreshExpiresAt: NOW.getTime() - 1 }, LOCAL, HOST, NOW);
    expect(refused).toContain("expired on 2026-09-11T01:59:59.999Z and cannot be refreshed");
    expect(refused).toContain("claude auth login");
  });

  it("lets an expired access token through until a launch proves it cannot be refreshed", () => {
    expect(claudeLaunchBlocked(expired, LOCAL, HOST, NOW)).toBeUndefined();
  });

  it("refuses after a failure on the same pair, until the recheck window passes", () => {
    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);

    const refused = claudeLaunchBlocked(expired, LOCAL, HOST, at(5 * 60_000));
    expect(refused).toContain("could not refresh its expired login at 2026-09-11T02:00:00.000Z (authentication_failed)");
    expect(refused).toContain(`next automatic re-probe is at ${at(CLAUDE_AUTH_RECHECK_MS).toISOString()}`);

    expect(claudeLaunchBlocked(expired, LOCAL, HOST, at(CLAUDE_AUTH_RECHECK_MS))).toBeUndefined();
  });

  it("lets a launch through the moment the pair on disk is a different one", () => {
    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);
    expect(claudeLaunchBlocked({ ...expired, fingerprint: "pair-B" }, LOCAL, HOST, at(60_000))).toBeUndefined();
  });

  it("does not refuse on one scope's outage for another", () => {
    noteClaudeAuthFailure("dev@buildbox", "authentication_failed", undefined, NOW);
    expect(claudeLaunchBlocked(expired, LOCAL, HOST, at(60_000))).toBeUndefined();
  });
});

describe("claimRefreshExpiryWarning", () => {
  const soon: ClaudeCredentialStatus = { ...expired, state: "ok", refreshExpiresAt: NOW.getTime() + CLAUDE_REFRESH_EXPIRY_WARNING_MS - 1 };

  it("warns once per expiry, and again for a new one", () => {
    expect(claimRefreshExpiryWarning(soon, NOW)).toBe(true);
    expect(claimRefreshExpiryWarning(soon, at(HOUR))).toBe(false);
    expect(claimRefreshExpiryWarning({ ...soon, refreshExpiresAt: soon.refreshExpiresAt! + HOUR }, at(2 * HOUR))).toBe(true);
  });

  it("stays quiet when the expiry is far off, unstated, or irrelevant", () => {
    expect(claimRefreshExpiryWarning({ ...soon, refreshExpiresAt: NOW.getTime() + CLAUDE_REFRESH_EXPIRY_WARNING_MS + 1 }, NOW)).toBe(false);
    expect(claimRefreshExpiryWarning({ ...soon, state: "refresh-expired" }, NOW)).toBe(false);
    expect(claimRefreshExpiryWarning({ state: "env" }, NOW)).toBe(false);
    expect(claimRefreshExpiryWarning({ state: "missing" }, NOW)).toBe(false);
  });

  // GEN-53 review: this expiry gets ONE warning. Burning it on an alert the
  // notification layer dropped — the incident instance resolved no operator
  // channel at all — spends the only heads-up on nobody.
  it("hands the warning back when it did not land", () => {
    expect(claimRefreshExpiryWarning(soon, NOW)).toBe(true);
    releaseRefreshExpiryWarning(soon);
    expect(claimRefreshExpiryWarning(soon, at(15 * 60_000))).toBe(true);
  });

  it("does not hand back a warning for some other expiry", () => {
    expect(claimRefreshExpiryWarning(soon, NOW)).toBe(true);
    releaseRefreshExpiryWarning({ ...soon, refreshExpiresAt: soon.refreshExpiresAt! + HOUR });
    expect(claimRefreshExpiryWarning(soon, at(15 * 60_000))).toBe(false);
  });
});

describe("the messages", () => {
  it("the alert says what broke, why, and the exact fix", () => {
    const { outage } = noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);
    const text = claudeAuthFailureAlert(LOCAL, outage, expired, HOST);
    expect(text).toContain("🔐 Claude authentication failed on the gateway host (gateway-host): authentication_failed.");
    expect(text).toContain("cron jobs included");
    expect(text).toContain("The access token expired at 2026-09-11T01:00:00.000Z and Claude Code could not refresh it");
    expect(text).toContain("so it was refused, not expired");
    expect(text).toContain("run `claude auth login` on gateway-host as the gateway user");
    expect(text).toContain("one message follows when it recovers");
    expect(text).not.toContain("sk-ant");
  });

  it("the alert for a remote scope names the remote host, not the gateway", () => {
    const { outage } = noteClaudeAuthFailure("dev@buildbox", "authentication_failed", undefined, NOW);
    const text = claudeAuthFailureAlert("dev@buildbox", outage, undefined, HOST);
    expect(text).toContain("failed on dev@buildbox");
    expect(text).toContain("run `claude auth login` on dev@buildbox");
    expect(text).not.toContain("gateway-host");
  });

  it("the recovery notice says how long it lasted and what it cost", () => {
    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", NOW);
    noteClaudeAuthFailure(LOCAL, "authentication_failed", "pair-A", at(HOUR));
    noteClaudeAuthSkipped(LOCAL, "refused", "pair-A", at(HOUR));
    const closed = noteClaudeAuthOk(LOCAL)!;
    expect(claudeAuthRecoveredNotice(LOCAL, closed, HOST, at(5 * HOUR + 19 * 60_000)))
      .toBe("✅ Claude authentication recovered on the gateway host (gateway-host) after 5 h 19 min (since 2026-09-11T02:00:00.000Z): 2 turns failed, 1 launch skipped.");
  });

  it("the recovery notice reads sensibly for an outage no turn ever reached", () => {
    noteClaudeAuthSkipped(LOCAL, "no credentials file", undefined, NOW);
    noteClaudeAuthSkipped(LOCAL, "no credentials file", undefined, at(60_000));
    const closed = noteClaudeAuthOk(LOCAL)!;
    expect(claudeAuthRecoveredNotice(LOCAL, closed, HOST, at(HOUR))).toContain("2 launches skipped.");
    expect(claudeAuthRecoveredNotice(LOCAL, closed, HOST, at(HOUR))).not.toContain("0 turns failed");
  });

  it("the expiry warning gives the deadline and the fix", () => {
    const text = claudeRefreshExpiryWarning({ state: "ok", refreshExpiresAt: NOW.getTime() + 36 * HOUR }, HOST, NOW);
    expect(text).toBe("⚠️ The Claude login on gateway-host expires in 36 h (2026-09-12T14:00:00.000Z). Run `claude auth login` there as the gateway user before then, or every Claude turn and cron job will fail.");
  });

  // GEN-53 review: reachable whenever the access token outlives the refresh
  // token — `credentialState` reports "ok" on a live access token whatever the
  // refresh expiry says, so the warning fired with a negative span and read
  // "expires in 1 min" off a timestamp already in the past.
  it("the expiry warning says a lapsed deadline has gone, not that it is a minute away", () => {
    const text = claudeRefreshExpiryWarning({ state: "ok", refreshExpiresAt: NOW.getTime() - 3 * HOUR }, HOST, NOW);
    expect(text).toContain("expired 3 h ago and cannot be renewed");
    expect(text).toContain("as the gateway user now, or every Claude turn");
    expect(text).not.toContain("expires in");
  });
});
