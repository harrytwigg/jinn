import { LOCAL_CLAUDE_AUTH_SCOPE, type ClaudeAuthOutage } from "./claude-auth-outage.js";
import type { ClaudeCredentialStatus } from "./claude-auth.js";

/**
 * What an operator is told about a Claude authentication outage, as text.
 *
 * Split from the ledger so the state machine and the wording can be read — and
 * tested — apart: the ledger decides whether to speak, this decides what is
 * said. Nothing here reads state or sends anything; every input is an argument.
 */

/** A span in minutes and hours. Negative spans are the caller's to phrase —
 *  this only ever describes how long something is or was, never a direction. */
function describeDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
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
  // An outage opened by a disk verdict has no failed turns to report — every
  // launch was refused before it cost anything, which is the point.
  const cost = [
    ...(outage.failures ? [`${outage.failures} turn${outage.failures === 1 ? "" : "s"} failed`] : []),
    ...(outage.skipped ? [`${outage.skipped} launch${outage.skipped === 1 ? "" : "es"} skipped`] : []),
  ].join(", ") || "no turns reached it";
  return `✅ Claude authentication recovered on ${describeScope(scope, hostname)} after ${lasted} (since ${outage.since}): ${cost}.`;
}

/** The heads-up before the refresh token lapses — the one expiry that is
 *  predictable from the file and that no launch can fix. */
export function claudeRefreshExpiryWarning(status: ClaudeCredentialStatus, hostname: string, now: Date = new Date()): string {
  const expiresAt = status.refreshExpiresAt ?? now.getTime();
  const remaining = expiresAt - now.getTime();
  // Already past, while the access token on disk still happens to be live: the
  // login works this minute and cannot be renewed, so it is a deadline that has
  // gone, not one approaching. Saying "expires in 1 min" for it read as a clock
  // still running.
  const when = remaining > 0
    ? `expires in ${describeDuration(remaining)}`
    : `expired ${describeDuration(remaining)} ago and cannot be renewed`;
  const deadline = remaining > 0 ? " before then," : " now,";
  return `⚠️ The Claude login on ${hostname} ${when}`
    + ` (${new Date(expiresAt).toISOString()}). Run \`claude auth login\` there as the gateway user${deadline}`
    + " or every Claude turn and cron job will fail.";
}
