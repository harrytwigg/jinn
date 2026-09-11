import fs from "node:fs";
import path from "node:path";
import { JINN_HOME } from "./paths.js";

/**
 * Where a Claude authentication outage is written down, and nothing else.
 *
 * One small JSON file under $JINN_HOME/tmp, split from the policy that reads
 * it so the record and the rules about it can be read apart. Why a file at
 * all: an outage outlives gateway restarts (the one that prompted this ran six
 * hours across a `jinn restart`), and re-alerting after every restart is the
 * spam the debounce exists to prevent.
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
  /** ISO. A caller has taken the alert and the send is in flight — stamped
   *  BEFORE it starts, because several turns can fail inside one request.
   *  Cleared again if the alert does not land. */
  alertClaimedAt?: string;
}

export interface OutageStore {
  outages: Record<string, ClaudeAuthOutage>;
  /** The `refreshTokenExpiresAt` the operator was last warned about. */
  refreshExpiryWarnedFor?: number;
}

const STATE_PATH = path.join(JINN_HOME, "tmp", "claude-auth-outage.json");

function parseOutages(raw: unknown): Record<string, ClaudeAuthOutage> {
  const outages: Record<string, ClaudeAuthOutage> = {};
  if (!raw || typeof raw !== "object") return outages;
  for (const [scope, record] of Object.entries(raw as Record<string, ClaudeAuthOutage | null>)) {
    if (record && typeof record === "object" && typeof record.since === "string") outages[scope] = record;
  }
  return outages;
}

export function readStore(): OutageStore {
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

export function writeStore(store: OutageStore): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
    fs.renameSync(tmp, STATE_PATH);
  } catch {
    // Advisory state: losing it costs at most one duplicate alert.
  }
}
