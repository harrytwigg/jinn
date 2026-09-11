import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "./paths.js";
import type { ClaudeCredentialStatus } from "./claude-auth.js";

/**
 * The ledger of a Claude authentication outage, and the two questions asked of
 * it: "is this the first failure, or the forty-second?" and "should a launch
 * even be attempted?"
 *
 * Pure state over one small JSON file; no notifications and no network live
 * here. The side effects — the operator message, the engine-health record —
 * belong to sessions/claude-auth-watch.ts, so this can be tested as a state
 * machine and the message wording as text.
 *
 * Why a file: an outage outlives gateway restarts (the one that prompted this
 * ran six hours across a `jinn restart`), and re-alerting after every restart
 * is the spam the debounce exists to prevent.
 */

export interface ClaudeAuthOutage {
  /** ISO. First failure of this outage. */
  since: string;
  /** Turns that reached Claude Code and came back `authentication_failed`. */
  failures: number;
  /** Launches preflight refused because the credentials already proved dead. */
  skipped: number;
  lastFailureAt: string;
  lastReason: string;
  /** The on-disk pair that failed. A launch on a DIFFERENT pair is worth trying. */
  credentialFingerprint?: string;
  /** ISO. When the operator was told. Absent means the alert could not be sent. */
  alertedAt?: string;
}

interface OutageStore {
  outages: Record<string, ClaudeAuthOutage>;
  /** The `refreshTokenExpiresAt` the operator was last warned about. */
  refreshExpiryWarnedFor?: number;
}

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

const STATE_PATH = path.join(JINN_HOME, "tmp", "claude-auth-outage.json");

function parseOutages(raw: unknown): Record<string, ClaudeAuthOutage> {
  const outages: Record<string, ClaudeAuthOutage> = {};
  if (!raw || typeof raw !== "object") return outages;
  for (const [scope, record] of Object.entries(raw as Record<string, ClaudeAuthOutage | null>)) {
    if (record && typeof record === "object" && typeof record.since === "string") outages[scope] = record;
  }
  return outages;
}

function readStore(): OutageStore {
  try {
    if (!fs.existsSync(STATE_PATH)) return { outages: {} };
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")) as Partial<OutageStore> | null;
    if (!parsed || typeof parsed !== "object") return { outages: {} };
    const warned = parsed.refreshExpiryWarnedFor;
    return { outages: parseOutages(parsed.outages), ...(typeof warned === "number" ? { refreshExpiryWarnedFor: warned } : {}) };
  } catch {
    return { outages: {} };
  }
}

function writeStore(store: OutageStore): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_PATH);
  } catch {
    // Advisory state: losing it costs at most one duplicate alert.
  }
}

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
 * Record a launch that reached Claude Code and was refused as unauthenticated.
 *
 * A failure on credentials DIFFERENT from the ones already on record opens a
 * new outage rather than extending the old one: it means someone logged in
 * since and it still does not work, which the operator needs to hear again.
 */
export function noteClaudeAuthFailure(
  scope: string,
  reason: string,
  fingerprint: string | undefined,
  now: Date = new Date(),
): AuthFailureNote {
  const store = readStore();
  const existing = store.outages[scope];
  const at = now.toISOString();
  const sameCredentials = existing !== undefined
    && (existing.credentialFingerprint === undefined || fingerprint === undefined || existing.credentialFingerprint === fingerprint);
  const outage: ClaudeAuthOutage = existing && sameCredentials
    ? { ...existing, failures: existing.failures + 1, lastFailureAt: at, lastReason: reason }
    : {
      since: at,
      failures: 1,
      skipped: 0,
      lastFailureAt: at,
      lastReason: reason,
      ...(fingerprint ? { credentialFingerprint: fingerprint } : {}),
    };
  writeStore({ ...store, outages: { ...store.outages, [scope]: outage } });
  return { outage, opened: !(existing && sameCredentials) };
}

/** The operator has been told about the outage that is open for this scope. */
export function markClaudeAuthAlerted(scope: string, now: Date = new Date()): void {
  const store = readStore();
  const outage = store.outages[scope];
  if (!outage) return;
  writeStore({ ...store, outages: { ...store.outages, [scope]: { ...outage, alertedAt: now.toISOString() } } });
}

/** A launch preflight refused because the outage already proved these credentials dead. */
export function noteClaudeAuthSkipped(scope: string): void {
  const store = readStore();
  const outage = store.outages[scope];
  if (!outage) return;
  writeStore({ ...store, outages: { ...store.outages, [scope]: { ...outage, skipped: outage.skipped + 1 } } });
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
 * Whether to warn that the refresh token is about to expire, recording the
 * warning so the same expiry is announced once. A later login moves the
 * expiry, which re-arms the warning for the new one.
 */
export function shouldWarnRefreshExpiry(status: ClaudeCredentialStatus, now: Date = new Date()): boolean {
  const expiresAt = status.refreshExpiresAt;
  if (expiresAt === undefined || status.state === "refresh-expired" || status.state === "env") return false;
  if (expiresAt - now.getTime() > CLAUDE_REFRESH_EXPIRY_WARNING_MS) return false;
  const store = readStore();
  if (store.refreshExpiryWarnedFor === expiresAt) return false;
  writeStore({ ...store, refreshExpiryWarnedFor: expiresAt });
  return true;
}

function describeDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function describeScope(scope: string, hostname: string): string {
  return scope === LOCAL_CLAUDE_AUTH_SCOPE ? `the gateway host (${hostname})` : scope;
}

/** The line of the alert that says what the file looked like when it failed. */
function describeCredentialFailure(status: ClaudeCredentialStatus | undefined): string | undefined {
  if (!status) return undefined;
  const iso = (ms: number) => new Date(ms).toISOString();
  if (status.state === "access-expired" && status.accessExpiresAt) {
    const refresh = status.refreshExpiresAt
      ? ` (the refresh token itself is valid until ${iso(status.refreshExpiresAt)}, so it was refused, not expired)`
      : "";
    return `The access token expired at ${iso(status.accessExpiresAt)} and Claude Code could not refresh it${refresh}.`;
  }
  if (status.state === "refresh-expired") {
    return `The login itself expired${status.refreshExpiresAt ? ` on ${iso(status.refreshExpiresAt)}` : ""}.`;
  }
  if (status.state === "missing") return `There is no credentials file${status.path ? ` at ${status.path}` : ""}.`;
  return undefined;
}

/** The line of the alert that says what to do. */
function describeFix(scope: string, hostname: string, telegramLogin: boolean): string {
  if (scope !== LOCAL_CLAUDE_AUTH_SCOPE) {
    return `Fix: run \`claude auth login\` on ${scope} as the user the remote sessions run as. One message follows when it recovers.`;
  }
  const viaTelegram = telegramLogin ? ", or send `/auth claude` to this bot" : "";
  return `Fix: run \`claude auth login\` on ${hostname} as the gateway user${viaTelegram}.`
    + " Claude launches are skipped until the credentials change (re-probed hourly); one message follows when it recovers.";
}

/** The one message an outage sends when it opens. Says what broke, what it
 *  costs, and the exact command that fixes it, because the log line it
 *  replaces said none of that to anyone. */
export function claudeAuthFailureAlert(
  scope: string,
  outage: ClaudeAuthOutage,
  status: ClaudeCredentialStatus | undefined,
  hostname: string,
  options: { telegramLogin?: boolean } = {},
): string {
  return [
    `🔐 Claude authentication failed on ${describeScope(scope, hostname)}: ${outage.lastReason}.`,
    "Every Claude turn there — cron jobs included — will fail until this is fixed; nothing else in the gateway can refresh it.",
    describeCredentialFailure(status),
    describeFix(scope, hostname, options.telegramLogin === true),
  ].filter((line): line is string => line !== undefined).join("\n");
}

/** The one message an outage sends when it closes. */
export function claudeAuthRecoveredNotice(scope: string, outage: ClaudeAuthOutage, hostname: string, now: Date = new Date()): string {
  const since = Date.parse(outage.since);
  const lasted = Number.isFinite(since) ? describeDuration(now.getTime() - since) : "an unknown time";
  const cost = [`${outage.failures} turn${outage.failures === 1 ? "" : "s"} failed`]
    .concat(outage.skipped ? [`${outage.skipped} launch${outage.skipped === 1 ? "" : "es"} skipped`] : [])
    .join(", ");
  return `✅ Claude authentication recovered on ${describeScope(scope, hostname)} after ${lasted} (since ${outage.since}): ${cost}.`;
}

/** The heads-up before the refresh token lapses — the one expiry that is
 *  predictable from the file and that no launch can fix. */
export function claudeRefreshExpiryWarning(status: ClaudeCredentialStatus, hostname: string, now: Date = new Date()): string {
  const expiresAt = status.refreshExpiresAt ?? now.getTime();
  return `⚠️ The Claude login on ${hostname} expires in ${describeDuration(expiresAt - now.getTime())}`
    + ` (${new Date(expiresAt).toISOString()}). Run \`claude auth login\` there as the gateway user before then,`
    + " or every Claude turn and cron job will fail.";
}
