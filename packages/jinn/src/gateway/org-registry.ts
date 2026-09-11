import { logger } from "../shared/logger.js";
import type { Employee, JinnConfig } from "../shared/types.js";
import { scanOrg } from "./org.js";

/**
 * The one place production code asks "who is in the org". `scanOrg` walks the
 * whole org tree off disk on every call; this module caches that walk and is
 * the only production caller of it.
 *
 * Invalidation is the chokidar org watcher (`onOrgChange` → `reloadOrg`) plus
 * the synchronous refresh the employee-update API does right after a write, so
 * a read never trails a write.
 */
export interface OrgRead {
  registry: Map<string, Employee>;
  /** Why the roster is degraded. Set only when the last scan threw. */
  error?: string;
}

/**
 * `config` is held by reference, not by value: `resolveSystemEmployees` derives
 * the system employees' engine/model from it, so a caller that arrives with a
 * different config must not be served a roster built from another one.
 */
let cache: { registry: Map<string, Employee>; config?: JinnConfig; error?: string } | undefined;

/**
 * The last config a caller actually supplied, used whenever one arrives without.
 *
 * A config-less read means "the roster, as this instance is configured" — never
 * "the roster of an instance with no configuration". The difference is not
 * cosmetic: `scanOrg` validates every remote employee against `config.remote`
 * and DROPS the ones it cannot vouch for, so scanning with `undefined` deletes
 * every remote employee from the roster. That is how a delegated reviewer who
 * spawns sessions and comments on Todos was told, by `assign_work_item`, that
 * they were "not in the org roster" — the authority check reads the roster
 * without a config, and the reviewer runs on another machine (DAH-214 item 2).
 */
let lastConfig: JinnConfig | undefined;

/** Re-walk the org tree and cache the result. */
export function refreshOrg(config?: JinnConfig): OrgRead {
  const resolved = config ?? lastConfig;
  if (config) lastConfig = config;
  try {
    cache = { registry: scanOrg(resolved), config: resolved };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Keep the last known good roster. Handing back an empty map here would
    // read downstream as "the company has no employees", which is a different
    // and much more damaging claim than "the roster could not be read".
    cache = { registry: cache?.registry ?? new Map(), config: resolved, error };
    logger.error(`Org scan failed — serving the last known roster of ${cache.registry.size} employee(s): ${error}`);
  }
  return { registry: cache.registry, error: cache.error };
}

/** The cached roster, scanning only if nothing good was cached for this config. */
export function readOrg(config?: JinnConfig): OrgRead {
  // A degraded cache is not a valid one: retry the scan so a transient failure
  // costs one turn's roster rather than every turn until org/ next changes.
  // A caller with no config of its own asks for whatever the cache holds; only
  // a DIFFERENT explicit config is a reason to re-walk.
  if (!cache || cache.error || (config !== undefined && cache.config !== config)) return refreshOrg(config);
  return { registry: cache.registry };
}

/** The roster alone, for the many callers that have no use for the failure. */
export function orgRegistry(config?: JinnConfig): Map<string, Employee> {
  return readOrg(config).registry;
}

export function resetOrgRegistryForTests(): void {
  cache = undefined;
  lastConfig = undefined;
}
