import { hostname } from "node:os";
import { resolveFallbackEngine } from "./engine-fallback.js";
import {
  isSpent,
  readEngineHealth,
  readStore,
  writeStore,
  type EngineHealth,
  type EngineHealthReading,
} from "./engine-health-store.js";
import type { EngineName } from "./models.js";
import { isRemoteTarget } from "./remote-target.js";
import type { EngineLimitWindow, JinnConfig, ModelRegistry, RemoteTarget } from "./types.js";

// Re-exported so the store split is invisible to callers: every consumer of this
// module reads a record and asks a question about it in the same breath.
export { readEngineHealth };
export type { EngineHealth, EngineHealthReading, EngineHealthState } from "./engine-health-store.js";

/**
 * Whether an engine can actually serve a turn, beside the installed-availability
 * the model registry reports.
 *
 * Advisory by construction, and every part of that is deliberate: reads and
 * writes swallow their own errors, every record carries the moment it stops
 * being true, and both dispatchers walk their chain again without health when
 * health would have left them nothing. The worst a wrong record can do is order
 * a chain differently — it can never refuse a turn.
 */

/**
 * The reading as a session bound for `target` should read it.
 *
 * A record that names a host describes that machine's login, not the account's
 * allowance, so it says nothing about a turn that will run somewhere else — and
 * the two dispatchers below read the same global store for local and remote
 * sessions alike. Without this, a dead `claude` login ON THE GATEWAY reroutes a
 * remote Claude employee whose own host is signed in perfectly well: a turn
 * moved onto a substitute for a reason that was never about it.
 *
 * Records with no host are about the account and survive untouched, which is
 * every quota record — those really do hold wherever the turn runs.
 *
 * Dropped rather than rewritten to `ok`: the record has nothing to say here,
 * and an entry saying "healthy" would be a claim this function cannot make.
 *
 * The comparison is against the LIVE hostname while the record is on disk, so a
 * gateway whose hostname changes under it — a container recreated against the
 * same home volume — stops recognising its own records. That fails open, which
 * is the direction this whole store fails in: the record is ignored, the session
 * starts where it preferred, and a dead local Claude login is still refused by
 * preflight, which reads the credentials file rather than this.
 */
export function engineHealthForTarget(
  health: EngineHealthReading,
  target: RemoteTarget | undefined,
): EngineHealthReading {
  const host = isRemoteTarget(target) ? target.remoteHost : hostname();
  const out: EngineHealthReading = {};
  for (const [engine, record] of Object.entries(health)) {
    if (record.host !== undefined && record.host !== host) continue;
    out[engine] = record;
  }
  return out;
}

/** The one question a dispatcher asks, and the only reader of `recheckAt`: past
 *  the re-probe the engine is offered a turn again even though the record still
 *  reads — and still displays — as out until its stated reset.
 *
 *  `degraded` is deliberately not an answer to it: an engine that named no
 *  reopening is a preference, never a reason to hold a turn back. A record from
 *  before re-probes existed carries no `recheckAt` and blocks until `until`,
 *  which is what it meant when it was written. */
export function isEngineExhausted(health: EngineHealthReading, engine: string, now: Date = new Date()): boolean {
  const record = health[engine];
  if (record?.state !== "exhausted") return false;
  if (record.recheckAt === undefined) return true;
  const recheckAt = Date.parse(record.recheckAt);
  return Number.isFinite(recheckAt) && recheckAt > now.getTime();
}

/** How long a stated reopening is taken on trust before the engine is offered a
 *  probing turn regardless. A weekly window is real and is displayed as stated;
 *  a misparse that reads as one still self-corrects inside this. */
const REPROBE_INTERVAL_MS = 12 * 60 * 60_000;

/** How long a failure that stated no reopening stays on the record. It says the
 *  provider just refused a turn, which is worth a brief preference away and is
 *  not worth believing for an afternoon. */
const DEGRADED_WINDOW_MS = 15 * 60_000;

/** The record still inside the window it stated, if there is one. What a failed
 *  re-probe is allowed to keep, rather than replace with a vaguer claim. */
function liveRecord(store: EngineHealthReading, engine: string, now: Date): EngineHealth | undefined {
  const record = store[engine];
  return record && !isSpent(record, now) ? record : undefined;
}

/** When the engine may be probed again: its stated reopening when that is
 *  nearer, otherwise the re-probe interval. */
function recheckFrom(statedMs: number | undefined, now: Date): string {
  const reprobeAt = now.getTime() + REPROBE_INTERVAL_MS;
  return new Date(statedMs === undefined ? reprobeAt : Math.min(statedMs, reprobeAt)).toISOString();
}

/** The stated parts of `about`, so an absent one is absent from the record
 *  rather than present-and-undefined — which `JSON.stringify` would drop from
 *  the file anyway, leaving the two shapes silently different in memory. */
function definedOnly(about: { window?: string; host?: string }): { window?: string; host?: string } {
  return {
    ...(about.window === undefined ? {} : { window: about.window }),
    ...(about.host === undefined ? {} : { host: about.host }),
  };
}

/**
 * Note that an engine could not serve a turn, given whatever it said about when
 * it can again.
 *
 * A stated reopening is stored verbatim and is `exhausted` until then. Silence
 * is `degraded`, because a failure that named no end says nothing about when to
 * stop believing it — but silence from an engine already out until a stated
 * reset is a failed re-probe, and that replaces neither the state nor the
 * reopening it already stated. A re-probe only ever moves the next re-probe.
 */
export function recordEngineUnavailable(
  engine: string,
  reason: string,
  resetsAtSeconds?: number,
  now: Date = new Date(),
  about: { window?: string; host?: string } = {},
): void {
  const stated = resetsAtSeconds !== undefined && Number.isFinite(resetsAtSeconds)
    ? resetsAtSeconds * 1000
    : undefined;
  const store = readStore();
  const standing = liveRecord(store, engine, now);
  // One machine's problem must not displace an account-wide one. There is a
  // single record per engine, and an allowance NO host can serve outranks a
  // login only this host cannot use — dropping the allowance would leave the
  // engine reading healthy to every remote session, which is the exact failure
  // {@link engineHealthForTarget} exists to prevent, arriving through the
  // mechanism meant to prevent it.
  if (about.host !== undefined && standing?.state === "exhausted" && standing.host === undefined) return;

  const observed = { reason, observedAt: now.toISOString(), ...definedOnly(about) };
  const live = stated === undefined ? standing : undefined;
  const record = nextRecord(stated, live, now);
  writeStore({ ...store, [engine]: { ...record, ...observed } });
}

/** The window part of the next record: what a re-probe keeps, and what a stated
 *  reopening replaces outright. */
function nextRecord(stated: number | undefined, live: EngineHealth | undefined, now: Date): EngineHealth {
  if (stated !== undefined) {
    return { state: "exhausted", until: new Date(stated).toISOString(), recheckAt: recheckFrom(stated, now) };
  }
  if (live?.state !== "exhausted") {
    return { state: "degraded", until: new Date(now.getTime() + DEGRADED_WINDOW_MS).toISOString() };
  }
  // `host` is deliberately NOT carried across: it describes the OBSERVATION, and
  // the caller's own `about` re-supplies it when this observation names a host
  // too. Carried, a gateway-scoped login would quietly scope the account-wide
  // window it was re-probing, hiding a real limit from every remote session.
  return {
    state: "exhausted",
    ...(live.until === undefined ? {} : { until: live.until }),
    ...(live.window === undefined ? {} : { window: live.window }),
    recheckAt: recheckFrom(live.until === undefined ? undefined : Date.parse(live.until), now),
  };
}

/**
 * The same fact a failed turn would have carried, minus the failed turn: a quota
 * window the provider itself reports as fully spent. When several are spent the
 * engine is back only once the last of them reopens.
 */
export function recordExhaustedWindows(
  engine: string,
  windows: readonly EngineLimitWindow[] | undefined,
  now: Date = new Date(),
): void {
  let binding: EngineLimitWindow | undefined;
  let reopensAt = 0;
  for (const window of windows ?? []) {
    if ((window.usedPercent ?? 0) < 100) continue;
    const resetsAt = window.resetsAt ?? 0;
    if (resetsAt * 1000 <= now.getTime() || resetsAt <= reopensAt) continue;
    reopensAt = resetsAt;
    binding = window;
  }
  if (binding) recordEngineUnavailable(engine, "quota window spent", binding.resetsAt, now, { window: binding.name });
}

/**
 * The first engine in `from`'s chain that can take the turn: one the caller
 * accepts AND whose allowance has not run out.
 *
 * A chain the health filter empties is walked again without it. Installed
 * availability stays the only hard gate, so a record that has gone stale can
 * reorder a chain but can never empty one the caller would have accepted.
 */
export function resolveHealthyFallbackEngine(
  config: JinnConfig,
  from: string,
  isUsable: (engine: EngineName) => boolean,
  health: EngineHealthReading,
): EngineName | null {
  return resolveFallbackEngine(config, from, (engine) => isUsable(engine) && !isEngineExhausted(health, engine))
    ?? resolveFallbackEngine(config, from, isUsable);
}

/**
 * The engine a NEW session should start on, given the one it prefers.
 *
 * Only ever asked about a preference the caller did not state outright — an
 * engine named in the request runs, spent allowance or not. Ordering, never
 * refusal: when nothing left in the chain can serve either, the preference is
 * handed straight back and the session starts exactly where it would have.
 */
export function preferHealthySessionEngine(
  config: JinnConfig,
  preferred: EngineName,
  isUsable: (engine: EngineName) => boolean,
  health: EngineHealthReading,
): EngineName {
  if (!isEngineExhausted(health, preferred)) return preferred;
  return resolveFallbackEngine(config, preferred, (engine) => isUsable(engine) && !isEngineExhausted(health, engine))
    ?? preferred;
}

/** The registry as an API consumer reads it: installed availability from the
 *  registry, the live reading beside it. */
export function withEngineHealth(
  registry: ModelRegistry,
): Record<string, ModelRegistry[string] & { health: EngineHealth }> {
  const health = readEngineHealth();
  return Object.fromEntries(Object.entries(registry).map(([name, entry]) => [
    name,
    { ...entry, health: health[name] ?? { state: "ok" as const } },
  ]));
}
