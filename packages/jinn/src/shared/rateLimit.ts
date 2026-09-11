import type { EngineResult } from "./types.js";
import { classifyEngineFailureText, hasEngineFailureClass } from "./engine-failure.js";

/** Whether error text reads as a quota window rather than a fault. Engine
 *  results are one caller; a settled attempt's stored error is the other, and
 *  both have to reach the same verdict or the same outage reads two ways.
 *
 *  Throttling and allowance are one verdict here: the caller waits either way. */
export function isRateLimitMessage(text: string | null | undefined): boolean {
  return hasEngineFailureClass(classifyEngineFailureText(text), "rate-limit", "quota");
}

export interface RateLimitDetection {
  limited: boolean;
  /** Unix timestamp in seconds */
  resetsAt?: number;
}

const RATE_LIMIT_ENGINE_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  grok: "Grok",
  pi: "Pi",
  hermes: "Hermes",
  // Lowercase on purpose: it is how the project spells its own name.
  opencode: "opencode",
};

/** Human-facing provider/engine name for rate-limit state and notifications. */
export function rateLimitEngineLabel(engine: string): string {
  const normalized = engine.trim().toLowerCase();
  return RATE_LIMIT_ENGINE_LABELS[normalized]
    ?? (normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : "Engine");
}

/** Patterns that indicate the engine session is dead (expired, not found, etc.) */
const DEAD_SESSION_PATTERNS = [
  /error.during.execution/i,
  /session.not.found/i,
  /invalid.session/i,
  /session.*expired/i,
];

/**
 * Detect whether an engine result indicates a dead/expired session rather than
 * a transient or rate-limit error. A dead session is one where the engine exited
 * with an error but did zero work (no cost, no turns) and there is no rate-limit
 * signal — meaning the --resume ID is stale and should not be retried.
 */
export function isDeadSessionError(result: EngineResult): boolean {
  if (!result.error) return false;

  // If rate limit info is present, this is a rate limit, not a dead session
  if (result.rateLimit?.status) return false;

  const zeroCost = result.cost === undefined || result.cost === 0;
  const zeroTurns = result.numTurns === undefined || result.numTurns === 0;

  // Primary: error with zero work done and no rate limit
  if (zeroCost && zeroTurns) return true;

  // Secondary: known dead-session patterns in error text, but only when no real
  // work was done (zeroCost) — avoids wiping IDs after a real session that
  // happened to include a matching substring in its error message.
  if (zeroCost && DEAD_SESSION_PATTERNS.some((p) => p.test(result.error!))) return true;

  return false;
}

export function detectRateLimit(result: EngineResult): RateLimitDetection {
  const resetsAt = typeof result.rateLimit?.resetsAt === "number"
    ? result.rateLimit.resetsAt
    : undefined;

  if (result.rateLimit?.status === "rejected") {
    return { limited: true, resetsAt };
  }

  if (isRateLimitMessage(result.error)) {
    return { limited: true, resetsAt };
  }

  return { limited: false };
}

export function computeRateLimitDeadlineMs(resetsAtSeconds?: number, extraMs = 30 * 60_000): number {
  if (typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)) {
    return resetsAtSeconds * 1000 + extraMs;
  }
  return Date.now() + extraMs;
}

export function computeNextRetryDelayMs(resetsAtSeconds?: number): { delayMs: number; resumeAt?: Date } {
  if (typeof resetsAtSeconds === "number" && Number.isFinite(resetsAtSeconds)) {
    const resumeAt = new Date(resetsAtSeconds * 1000);
    // Add a small buffer to avoid retrying a few ms before the reset boundary.
    const bufferMs = 10_000;
    const delayMs = Math.max(10_000, resumeAt.getTime() - Date.now() + bufferMs);
    return { delayMs, resumeAt };
  }
  return { delayMs: 60_000 };
}

/**
 * A limit that named no reset gives a parked session nothing to sleep to, so
 * every retry against it is a guess. These two bound the guessing: the wait
 * doubles until it settles at half an hour, and the park gives up well before
 * the six-hour deadline would have let it poke the engine ~360 times.
 *
 * A limit that later does name a reset leaves this path entirely — the stated
 * reset is slept to, exactly as before.
 */
export const MAX_UNSTATED_PARK_DELAY_MS = 30 * 60_000;
export const MAX_UNSTATED_PARK_ATTEMPTS = 12;

/** The next guess: never shorter than the last one, never past the cap. */
export function nextUnstatedParkDelayMs(previousDelayMs: number): number {
  return Math.min(Math.max(previousDelayMs, 0) * 2, MAX_UNSTATED_PARK_DELAY_MS);
}
