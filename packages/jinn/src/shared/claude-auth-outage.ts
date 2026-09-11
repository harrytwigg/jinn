import { readStore, writeStore, type ClaudeAuthOutage } from "./claude-auth-ledger.js";
import type { ClaudeCredentialStatus } from "./claude-auth.js";

/**
 * The ledger of a Claude authentication outage, and the two questions asked of
 * it: "is this the first failure, or the forty-second?" and "should a launch
 * even be attempted?"
 *
 * Policy over the record in claude-auth-ledger.ts; no notifications and no
 * network live here. The side effects — the operator message, the engine-health
 * record — belong to sessions/claude-auth-watch.ts, and the wording to
 * claude-auth-messages.ts, so each can be read and tested on its own.
 */

export type { ClaudeAuthOutage } from "./claude-auth-ledger.js";

/** Credentials on the gateway host itself. Remote hosts get their own scope. */
export const LOCAL_CLAUDE_AUTH_SCOPE = "local";

/**
 * How long a launch is refused after a failure on unchanged credentials before
 * one is let through to re-probe. Claude Code's refresh can fail transiently
 * (token endpoint unreachable) as well as terminally (refresh token consumed
 * or revoked), and only a launch can tell the two apart — so the block is a
 * cooldown, not a lock, and the one thing that lifts it early is a login.
 */
export const CLAUDE_AUTH_RECHECK_MS = 60 * 60_000;

/** Warn this far ahead of the refresh token's own expiry. Its lifetime is
 *  weeks; two days is enough notice to log in before it bites. */
export const CLAUDE_REFRESH_EXPIRY_WARNING_MS = 48 * 60 * 60_000;

/** The outage in progress for a scope, if any. */
export function activeClaudeAuthOutage(scope: string): ClaudeAuthOutage | undefined {
  return readStore().outages[scope];
}

export interface AuthFailureNote {
  outage: ClaudeAuthOutage;
  /** True exactly when this failure opened the outage — the one time to alert. */
  opened: boolean;
}

/**
 * Open the outage for a scope, or extend the one already open.
 *
 * A failure reached Claude Code and came back refused; a skip is a launch
 * preflight never made. Both are evidence the login is down and both can OPEN
 * the outage — the disk can condemn a login without any launch reaching the API.
 *
 * An event on credentials DIFFERENT from the ones on record opens a NEW outage:
 * someone logged in since and it still fails, which the operator must hear again.
 */
function openOrExtendOutage(
  scope: string,
  reason: string,
  fingerprint: string | undefined,
  counts: "failure" | "skip",
  now: Date,
): AuthFailureNote {
  const store = readStore();
  const existing = store.outages[scope];
  const at = now.toISOString();
  const failed = counts === "failure";
  const extend = extendsOutage(existing, fingerprint);
  const outage = extend && existing
    ? extendedOutage(existing, reason, failed, at)
    : freshOutage(reason, fingerprint, failed, at);
  writeStore({ ...store, outages: { ...store.outages, [scope]: outage } });
  return { outage, opened: !extend };
}

/** Whether an event on this pair belongs to the outage on record. An unknown
 *  fingerprint on either side counts as the same: a remote scope never has one. */
function extendsOutage(existing: ClaudeAuthOutage | undefined, fingerprint: string | undefined): boolean {
  if (existing === undefined) return false;
  return existing.credentialFingerprint === undefined
    || fingerprint === undefined
    || existing.credentialFingerprint === fingerprint;
}

/** Only a failure moves `lastFailureAt`/`lastReason` — see noteClaudeAuthSkipped. */
function extendedOutage(existing: ClaudeAuthOutage, reason: string, failed: boolean, at: string): ClaudeAuthOutage {
  return {
    ...existing,
    failures: existing.failures + (failed ? 1 : 0),
    skipped: existing.skipped + (failed ? 0 : 1),
    ...(failed ? { lastFailureAt: at, lastReason: reason } : {}),
  };
}

function freshOutage(reason: string, fingerprint: string | undefined, failed: boolean, at: string): ClaudeAuthOutage {
  return {
    since: at,
    failures: failed ? 1 : 0,
    skipped: failed ? 0 : 1,
    lastFailureAt: at,
    lastReason: reason,
    ...(fingerprint ? { credentialFingerprint: fingerprint } : {}),
  };
}

/** Record a launch that reached Claude Code and was refused as unauthenticated. */
export function noteClaudeAuthFailure(
  scope: string,
  reason: string,
  fingerprint: string | undefined,
  now: Date = new Date(),
): AuthFailureNote {
  return openOrExtendOutage(scope, reason, fingerprint, "failure", now);
}

/**
 * Record a launch preflight refused. Opens the outage when none is open — the
 * only way a disk verdict (no credentials file, a refresh token past its own
 * expiry) is ever announced, since preflight refuses those from the first turn
 * and no launch ever reaches Claude Code to fail.
 *
 * `lastFailureAt` deliberately does NOT move: the recheck window is measured
 * from it, and a refusal is not a re-probe. Letting a skip push it out would
 * make the block self-perpetuating.
 */
export function noteClaudeAuthSkipped(
  scope: string,
  reason: string,
  fingerprint: string | undefined,
  now: Date = new Date(),
): AuthFailureNote {
  return openOrExtendOutage(scope, reason, fingerprint, "skip", now);
}

/**
 * Take responsibility for alerting on this scope's outage, once. True for
 * exactly one caller: the stamp is written synchronously, before any send
 * begins, so turns failing while an alert is in flight see it and stay quiet.
 * Delivery then calls `markClaudeAuthAlerted` or `releaseClaudeAuthAlert`.
 */
export function claimClaudeAuthAlert(scope: string, now: Date = new Date()): boolean {
  const store = readStore();
  const outage = store.outages[scope];
  if (!outage || outage.alertedAt || outage.alertClaimedAt) return false;
  writeStore({ ...store, outages: { ...store.outages, [scope]: { ...outage, alertClaimedAt: now.toISOString() } } });
  return true;
}

/** The alert did not land: let the next failure on this outage try again. */
export function releaseClaudeAuthAlert(scope: string): void {
  const store = readStore();
  const outage = store.outages[scope];
  if (!outage) return;
  const { alertClaimedAt: _dropped, ...rest } = outage;
  writeStore({ ...store, outages: { ...store.outages, [scope]: rest } });
}

/** The operator has been told about the outage that is open for this scope. */
export function markClaudeAuthAlerted(scope: string, now: Date = new Date()): void {
  const store = readStore();
  const outage = store.outages[scope];
  if (!outage) return;
  writeStore({ ...store, outages: { ...store.outages, [scope]: { ...outage, alertedAt: now.toISOString() } } });
}

/**
 * A launch on this scope authenticated. Closes the outage, returning it so the
 * caller can say how long it lasted and what it cost — undefined when there was
 * nothing to close, which is every healthy turn and must stay free.
 */
export function noteClaudeAuthOk(scope: string): ClaudeAuthOutage | undefined {
  const store = readStore();
  const outage = store.outages[scope];
  if (!outage) return undefined;
  const { [scope]: _closed, ...rest } = store.outages;
  writeStore({ ...store, outages: rest });
  return outage;
}

/**
 * Why a Claude launch on this host should not be attempted right now, or
 * undefined when it should. Phrased for the session it refuses.
 *
 * Refuses only on a verdict the disk states outright (no file, refresh token
 * past its own expiry) or on one a launch already proved and nothing has
 * changed since (access token expired, the same pair failed inside the last
 * recheck window). An expired access token by itself is never a refusal: that
 * is the normal state of the file between launches, and the CLI refreshes it.
 */
export function claudeLaunchBlocked(
  status: ClaudeCredentialStatus,
  scope: string,
  hostname: string,
  now: Date = new Date(),
): string | undefined {
  return diskVerdict(status, hostname) ?? provenDeadVerdict(status, scope, hostname, now);
}

/** What the file states outright, with no launch needed. */
function diskVerdict(status: ClaudeCredentialStatus, hostname: string): string | undefined {
  if (status.state === "missing") {
    const where = status.path ? ` (${status.path})` : "";
    return `Claude is not logged in on ${hostname}${where} — run \`claude auth login\` there as the gateway user.`;
  }
  if (status.state === "refresh-expired") {
    const when = status.refreshExpiresAt ? ` on ${new Date(status.refreshExpiresAt).toISOString()}` : "";
    return `The Claude login on ${hostname} expired${when} and cannot be refreshed — run \`claude auth login\` there as the gateway user.`;
  }
  return undefined;
}

/** What a launch already proved about this exact pair, inside the recheck window. */
function provenDeadVerdict(status: ClaudeCredentialStatus, scope: string, hostname: string, now: Date): string | undefined {
  if (status.state !== "access-expired") return undefined;
  const outage = activeClaudeAuthOutage(scope);
  if (!outage) return undefined;
  if (outage.credentialFingerprint !== undefined && outage.credentialFingerprint !== status.fingerprint) return undefined;
  const lastFailure = Date.parse(outage.lastFailureAt);
  if (!Number.isFinite(lastFailure) || now.getTime() - lastFailure >= CLAUDE_AUTH_RECHECK_MS) return undefined;
  const recheckAt = new Date(lastFailure + CLAUDE_AUTH_RECHECK_MS).toISOString();
  return `Claude Code on ${hostname} could not refresh its expired login at ${outage.lastFailureAt} (${outage.lastReason})`
    + ` and the credentials have not changed since — run \`claude auth login\` there as the gateway user.`
    + ` Launches are skipped until then; the next automatic re-probe is at ${recheckAt}.`;
}

/**
 * Take the one warning this refresh-token expiry gets. A later login moves the
 * expiry, which re-arms the warning for the new one.
 *
 * Claimed rather than merely asked: the marker must be written before delivery
 * (the 15-minute tick would otherwise re-send while the first is in flight),
 * but burning it on a dropped alert spends the only heads-up on nobody — so a
 * failed send releases it.
 */
export function claimRefreshExpiryWarning(status: ClaudeCredentialStatus, now: Date = new Date()): boolean {
  const expiresAt = status.refreshExpiresAt;
  if (expiresAt === undefined || status.state === "refresh-expired" || status.state === "env") return false;
  if (expiresAt - now.getTime() > CLAUDE_REFRESH_EXPIRY_WARNING_MS) return false;
  const store = readStore();
  if (store.refreshExpiryWarnedFor === expiresAt) return false;
  writeStore({ ...store, refreshExpiryWarnedFor: expiresAt });
  return true;
}

/** The warning did not land: let the next tick announce this expiry again. */
export function releaseRefreshExpiryWarning(status: ClaudeCredentialStatus): void {
  const store = readStore();
  if (store.refreshExpiryWarnedFor !== status.refreshExpiresAt) return;
  const { refreshExpiryWarnedFor: _dropped, ...rest } = store;
  writeStore(rest);
}
