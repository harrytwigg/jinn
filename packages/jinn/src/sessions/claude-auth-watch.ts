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
  claudeAuthFailureAlert,
  claudeAuthRecoveredNotice,
  claudeLaunchBlocked,
  claudeRefreshExpiryWarning,
  markClaudeAuthAlerted,
  noteClaudeAuthFailure,
  noteClaudeAuthOk,
  noteClaudeAuthSkipped,
  shouldWarnRefreshExpiry,
  type ClaudeAuthOutage,
} from "../shared/claude-auth-outage.js";
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

/** Ask the operator channel; a failure to deliver is logged, never raised. */
function tell(message: string, onSent?: () => void): void {
  try {
    notifyOperatorChannel(message, onSent);
  } catch (err) {
    logger.warn(`Claude auth alert not sent: ${err instanceof Error ? err.message : String(err)}`);
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

function reportClaudeAuthFailure(scope: string, reason: string, now: Date): void {
  const local = scope === LOCAL_CLAUDE_AUTH_SCOPE;
  const status = local ? localStatus() : undefined;
  const { outage, opened } = noteClaudeAuthFailure(scope, reason, status?.fingerprint, now);
  if (local) {
    // Advisory: new sessions prefer a healthy fallback engine while this
    // stands, and the dashboard shows why. Preflight, not this record, is
    // what actually refuses a launch.
    recordEngineUnavailable("claude", `authentication failed — run \`claude auth login\` on ${hostname()}`,
      Math.floor((now.getTime() + CLAUDE_AUTH_RECHECK_MS) / 1000), now);
  }
  const host = hostname();
  if (opened || !outage.alertedAt) {
    logger.error(`Claude authentication failed on ${scope}: ${reason} — alerting the operator`
      + (opened ? "" : " (earlier alert did not send)"));
    tell(claudeAuthFailureAlert(scope, outage, status, host, { telegramLogin: telegramLoginAvailable() }),
      () => markClaudeAuthAlerted(scope, now));
  } else {
    logger.warn(`Claude authentication still failing on ${scope} (${outage.failures} failures since ${outage.since}): ${reason}`);
  }
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
    if (blocked) noteClaudeAuthSkipped(scope);
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
    if (!status || !shouldWarnRefreshExpiry(status, now)) return;
    const message = claudeRefreshExpiryWarning(status, hostname(), now);
    logger.warn(message);
    tell(message);
  } catch (err) {
    logger.warn(`Claude refresh-expiry check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
