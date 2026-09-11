import os from "node:os";
import { logger } from "../shared/logger.js";
import { loadConfig } from "../shared/config.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import { recordEngineUnavailable } from "../shared/engine-health.js";
import { readClaudeCredentialStatus, type ClaudeCredentialStatus } from "../shared/claude-auth.js";
import {
  CLAUDE_AUTH_RECHECK_MS,
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
  type AuthFailureNote,
  type ClaudeAuthOutage,
} from "../shared/claude-auth-outage.js";
import {
  claudeAuthFailureAlert,
  claudeAuthRecoveredNotice,
  claudeRefreshExpiryWarning,
} from "../shared/claude-auth-messages.js";
import type { Employee } from "../shared/types.js";
import { notifyOperatorChannel } from "./callbacks.js";

/**
 * Where the Claude auth ledger meets the gateway: turns report what Claude Code
 * said about its login, preflight asks whether a launch is worth it, and the
 * background tick watches the one expiry that is predictable. All side effects
 * of an outage — the operator message, the engine-health record — happen here
 * and nowhere else, and none of them may throw into a turn.
 */

/** Errors Claude Code returns when the account, not the request, is refused. */
const CLAUDE_AUTH_FAILURE_RE = /\b(authentication_failed|oauth_org_not_allowed)\b/;

export function isClaudeAuthFailure(error: string | null | undefined): boolean {
  return typeof error === "string" && CLAUDE_AUTH_FAILURE_RE.test(error);
}

/**
 * Which credentials a session's Claude launches use. A remote employee runs
 * `claude` on its own host with that host's login, so its failures are a
 * different outage from the gateway's — and one this host cannot inspect.
 */
export function claudeAuthScope(employee: Employee | undefined): string {
  if (!isRemoteTarget(employee)) return LOCAL_CLAUDE_AUTH_SCOPE;
  const user = employee.remoteUser ? `${employee.remoteUser}@` : "";
  const profile = employee.remoteClaudeConfigDir ? `:${employee.remoteClaudeConfigDir}` : "";
  return `${user}${employee.remoteHost}${profile}`;
}

function hostname(): string {
  try {
    return os.hostname();
  } catch {
    return "the gateway host";
  }
}

/** Whether the operator can re-login from Telegram (`/auth claude`) instead of a shell. */
function telegramLoginAvailable(): boolean {
  try {
    return loadConfig().connectors?.telegram?.telegramAuth?.enabled === true;
  } catch {
    return false;
  }
}

function localStatus(): ClaudeCredentialStatus | undefined {
  try {
    return readClaudeCredentialStatus();
  } catch {
    return undefined;
  }
}

/**
 * Ask the operator channel; a failure to deliver is logged, never raised.
 * `onResult` sees whether the message landed — a synchronous throw counts as
 * not landing, so a caller holding a one-shot claim always gets to release it.
 */
function tell(message: string, onResult?: (sent: boolean) => void): void {
  try {
    notifyOperatorChannel(message, onResult);
  } catch (err) {
    logger.warn(`Claude auth alert not sent: ${err instanceof Error ? err.message : String(err)}`);
    onResult?.(false);
  }
}

/**
 * A Claude turn ended. An auth refusal opens (or extends) the outage for the
 * session's scope; a turn that authenticated closes it. Every other outcome —
 * rate limits, server errors, interruptions — says nothing about the login and
 * is ignored.
 */
export function observeClaudeTurnOutcome(employee: Employee | undefined, error: string | null | undefined, now: Date = new Date()): void {
  try {
    const scope = claudeAuthScope(employee);
    if (isClaudeAuthFailure(error)) {
      reportClaudeAuthFailure(scope, error as string, now);
    } else if (!error) {
      reportClaudeAuthOk(scope, now);
    }
  } catch (err) {
    logger.warn(`Claude auth observation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Everything an outage event does beyond its ledger write: steer new sessions
 * off the engine, and get the one operator message out.
 *
 * Shared by the two ways an outage is learned — a launch that came back
 * refused, and a launch preflight would not make — because a disk verdict (no
 * credentials file, a refresh token past its own expiry) is refused from the
 * very first turn, so it is the ONLY evidence that outage will ever produce.
 * Alerting only from the failure path left those two states permanently
 * refused and permanently silent.
 */
interface ClaudeAuthOutageEvent {
  scope: string;
  note: AuthFailureNote;
  /** The credentials this host can read, when it is this host's login. */
  status: ClaudeCredentialStatus | undefined;
  reason: string;
  /** A launch that came back refused, or one preflight would not make. */
  kind: "failure" | "refusal";
}

function raiseClaudeAuthOutage({ scope, note, status, reason, kind }: ClaudeAuthOutageEvent, now: Date): void {
  if (scope === LOCAL_CLAUDE_AUTH_SCOPE) {
    // Advisory: new sessions prefer a healthy fallback engine while this
    // stands, and the dashboard shows why. Preflight, not this record, is
    // what actually refuses a launch. Re-stamped on a refusal too, so the
    // record cannot lapse into "ok" while every launch is still being refused.
    recordEngineUnavailable("claude", `authentication failed — run \`claude auth login\` on ${hostname()}`,
      Math.floor((now.getTime() + CLAUDE_AUTH_RECHECK_MS) / 1000), now);
  }
  if (!claimClaudeAuthAlert(scope, now)) {
    const tally = `${note.outage.failures} failed, ${note.outage.skipped} skipped since ${note.outage.since}`;
    if (kind === "failure") logger.warn(`Claude authentication still failing on ${scope} (${tally}): ${reason}`);
    else logger.debug(`Claude launch refused on ${scope} (${tally})`);
    return;
  }
  logger.error(`Claude authentication is down on ${scope}: ${reason} — alerting the operator`);
  tell(
    claudeAuthFailureAlert(scope, note.outage, status, hostname(), { telegramLogin: telegramLoginAvailable() }),
    (sent) => (sent ? markClaudeAuthAlerted(scope, now) : releaseClaudeAuthAlert(scope)),
  );
}

function reportClaudeAuthFailure(scope: string, reason: string, now: Date): void {
  const status = scope === LOCAL_CLAUDE_AUTH_SCOPE ? localStatus() : undefined;
  const note = noteClaudeAuthFailure(scope, reason, status?.fingerprint, now);
  raiseClaudeAuthOutage({ scope, note, status, reason, kind: "failure" }, now);
}

function reportClaudeAuthOk(scope: string, now: Date): void {
  const closed = noteClaudeAuthOk(scope);
  if (!closed) return;
  const host = hostname();
  logger.info(`Claude authentication recovered on ${scope} after ${closed.failures} failure(s) since ${closed.since}`);
  tell(claudeAuthRecoveredNotice(scope, closed, host, now));
}

/** A live access token on a pair other than the one that failed: someone logged in. */
function loggedInSince(outage: ClaudeAuthOutage | undefined, status: ClaudeCredentialStatus): boolean {
  return outage !== undefined && status.state === "ok" && Boolean(status.fingerprint)
    && outage.credentialFingerprint !== status.fingerprint;
}

/**
 * Preflight: why a local Claude launch should not be attempted, or undefined.
 *
 * Also the earliest point recovery can be seen: a live access token on a pair
 * different from the one that failed means someone logged in, and that closes
 * the outage before the turn even runs.
 */
export function refuseClaudeLaunch(employee: Employee | undefined, now: Date = new Date()): string | undefined {
  try {
    const scope = claudeAuthScope(employee);
    if (scope !== LOCAL_CLAUDE_AUTH_SCOPE) return undefined;
    const status = localStatus();
    if (!status) return undefined;
    if (loggedInSince(activeClaudeAuthOutage(scope), status)) {
      reportClaudeAuthOk(scope, now);
      return undefined;
    }
    const blocked = claudeLaunchBlocked(status, scope, hostname(), now);
    // A refusal is evidence in its own right, not just a tally on someone
    // else's outage: when the disk condemns the login outright no launch ever
    // reaches Claude Code, so this is what opens the outage and alerts.
    if (blocked) {
      const note = noteClaudeAuthSkipped(scope, blocked, status.fingerprint, now);
      raiseClaudeAuthOutage({ scope, note, status, reason: blocked, kind: "refusal" }, now);
    }
    return blocked;
  } catch (err) {
    logger.warn(`Claude auth preflight skipped: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Discovery reached the Anthropic API with the token on disk. That is proof
 * the ACCESS token works, which closes an outage only if the pair has changed
 * since it failed — the same pair cannot have both failed a launch and passed
 * a catalog GET, so an unchanged fingerprint means the failure was not about
 * the token at all (an org refusal, say) and the outage stands.
 */
export function observeClaudeCredentialsValid(now: Date = new Date()): void {
  try {
    const outage = activeClaudeAuthOutage(LOCAL_CLAUDE_AUTH_SCOPE);
    if (!outage) return;
    const status = localStatus();
    if (!status?.fingerprint || status.fingerprint === outage.credentialFingerprint) return;
    reportClaudeAuthOk(LOCAL_CLAUDE_AUTH_SCOPE, now);
  } catch (err) {
    logger.warn(`Claude auth observation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The periodic look at the one expiry the file predicts. The access token's
 * is routine and the CLI handles it; the refresh token's is weeks out, is
 * fatal when it lands, and is announced once per expiry.
 */
export function checkClaudeRefreshExpiry(now: Date = new Date()): void {
  try {
    const status = localStatus();
    if (!status || !claimRefreshExpiryWarning(status, now)) return;
    const message = claudeRefreshExpiryWarning(status, hostname(), now);
    logger.warn(message);
    // This expiry gets one warning. If it does not land, hand it back so the
    // next tick can try again rather than spending it on a dropped alert.
    tell(message, (sent) => { if (!sent) releaseRefreshExpiryWarning(status); });
  } catch (err) {
    logger.warn(`Claude refresh-expiry check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
