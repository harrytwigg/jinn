import type { JinnConfig } from "./types.js";

/** Where a fixed, LLM-free operator alert is delivered. */
export interface OperatorNotificationTarget {
  connector: string;
  channel: string;
  /** Which rule produced it, for the boot log. */
  via: "notifications" | "cron.alert" | "telegram.allowFrom";
}

/**
 * Resolve the channel operator alerts go to, in precedence order:
 *
 *   1. `notifications.{connector,channel}` — the explicit setting.
 *   2. `cron.{alertConnector,alertChannel}` — a channel the operator already
 *      chose to hear failures on; an auth outage is a failure of every cron.
 *   3. A Telegram connector allowlisting exactly one user: a private chat's
 *      id is that user's id, and a single allowed user is the operator.
 *
 * The fallbacks exist because the outage this was written for happened on an
 * instance with a working Telegram connector and neither of the first two set:
 * every alert the gateway tried to send was dropped at debug level, which is
 * indistinguishable from not alerting at all.
 */
export function resolveOperatorNotificationTarget(config: JinnConfig): OperatorNotificationTarget | undefined {
  const explicit = config.notifications;
  if (explicit?.channel) return { connector: explicit.connector || "discord", channel: explicit.channel, via: "notifications" };

  const cron = config.cron;
  if (cron?.alertConnector && cron.alertChannel) {
    return { connector: cron.alertConnector, channel: cron.alertChannel, via: "cron.alert" };
  }

  return telegramSoleUserTarget(config);
}

function telegramSoleUserTarget(config: JinnConfig): OperatorNotificationTarget | undefined {
  const telegram = config.connectors?.telegram;
  if (!telegram?.botToken || !Array.isArray(telegram.allowFrom)) return undefined;
  const allowFrom = telegram.allowFrom.filter((id) => Number.isInteger(id) && id > 0);
  if (allowFrom.length !== 1) return undefined;
  return { connector: "telegram", channel: String(allowFrom[0]), via: "telegram.allowFrom" };
}
