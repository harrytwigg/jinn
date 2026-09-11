import type { Employee, Engine, JinnConfig } from "../shared/types.js";
import { engineAvailable, engineSupportsRemote, type EngineName } from "../shared/models.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import { preferHealthySessionEngine, readEngineHealth } from "../shared/engine-health.js";

/** What a routed turn brought with it about where the session should run. */
export interface NewSessionEnginePreference {
  engine?: string;
  model?: string;
  effortLevel?: string;
  employee?: Employee;
}

/**
 * The model and effort level the session starts with. A reroute moved off the
 * engine the employee's pair was configured for, so on that path only what the
 * caller named survives and the substitute runs on its own configured defaults,
 * the way a mid-turn fallback already does.
 */
function inheritedDefaults(
  preference: NewSessionEnginePreference,
  rerouted: boolean,
): { model?: string; effortLevel?: string } {
  const employee = rerouted ? undefined : preference.employee;
  return {
    model: preference.model ?? employee?.model ?? undefined,
    effortLevel: preference.effortLevel ?? employee?.effortLevel ?? undefined,
  };
}

/**
 * The engine, model and effort level a NEW routed session starts on.
 *
 * An engine the caller named wins, and so does a named model — a model belongs
 * to exactly one engine. Anything else is a preference, so an engine whose
 * allowance is spent gives way to the first member of its chain that can serve
 * the turn.
 */
export function newSessionEngineSelection(
  config: JinnConfig,
  engines: Map<string, Engine>,
  preference: NewSessionEnginePreference,
): { engine: EngineName; model?: string; effortLevel?: string } {
  const preferred = (preference.engine ?? preference.employee?.engine ?? config.engines.default) as EngineName;
  const named = preference.engine !== undefined || preference.model !== undefined;
  // A remote employee's preference may only be reordered within the engines that
  // can actually run on its host. Rerouting it onto one that ignores
  // `remoteHost` would start the session on an engine whose every turn the
  // remote gate then refuses — a session that looks started and can never run.
  const remote = isRemoteTarget(preference.employee);
  const engine = named
    ? preferred
    : preferHealthySessionEngine(
      config,
      preferred,
      (candidate) => engines.has(candidate) && engineAvailable(config, candidate)
        && (!remote || engineSupportsRemote(candidate)),
      readEngineHealth(),
    );
  return { engine, ...inheritedDefaults(preference, engine !== preferred) };
}
