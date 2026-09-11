/**
 * The periodic refreshes a running gateway keeps doing after boot.
 *
 * Both read the live config at fire time rather than the boot snapshot, so a
 * reload between ticks is respected, and both are unref'd: a background refresh
 * must never be the reason the process stays up.
 */

import type { GatewayEmit } from "../shared/gateway-events.js";
import type { JinnConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { collectEngineLimits } from "../shared/engine-limits.js";
import { readEngineHealth } from "../shared/engine-health.js";
import { engineAvailable } from "../shared/models.js";
import { checkClaudeRefreshExpiry, observeClaudeCredentialsValid } from "../sessions/claude-auth-watch.js";
import {
  refreshAntigravityModels,
  refreshClaudeModels,
  refreshCodexModels,
  refreshGrokModels,
  refreshHermesModels,
  refreshPiModels,
} from "../shared/models.js";

/**
 * How often to re-run dynamic engine model discovery while the gateway is up.
 * Discovery otherwise only runs on boot, on config reload, and as a post-failure
 * fallback — so a gateway with multi-day uptime keeps serving a stale catalog and
 * never sees a model published after it booted. Six hours is cheap (a handful of
 * short-lived CLI spawns plus one Anthropic catalog GET) and bounds that staleness.
 */
export const MODEL_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * How often to re-read every engine's quota windows. Without it the health store
 * is written almost only by a turn that already failed, so each new session pays
 * one wasted turn to discover an engine is out of allowance. Fifteen minutes is
 * finer than any quota window resets and costs a few short-lived CLI spawns.
 */
export const ENGINE_HEALTH_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

export interface BackgroundRefreshes {
  /** Re-discover models now. The config-reload path asks for this directly,
   *  because engine bins and auth may have changed under it. */
  refreshModels: () => void;
  stop: () => void;
}

export function startBackgroundRefreshes(getConfig: () => JinnConfig, emit: GatewayEmit): BackgroundRefreshes {
  // Fire-and-forget: the registry serves known/synthesized fallbacks until the
  // snapshots land, then the web UI invalidates its cache via engines:updated.
  const refreshModels = (): void => {
    const config = getConfig();
    void Promise.all([
      refreshClaudeModels(config).then((authenticated) => { if (authenticated) observeClaudeCredentialsValid(); }),
      refreshCodexModels(config),
      refreshAntigravityModels(config),
      refreshPiModels(config),
      refreshGrokModels(config),
      refreshHermesModels(config),
    ])
      .finally(() => emit("engines:updated", {}));
  };

  // collectEngineLimits already writes a fully-spent quota window through to the
  // health store, so this needs no persistence of its own — it only makes the
  // reading exist before a session burns a turn discovering it.
  const refreshEngineHealth = (): void => {
    // The one credential expiry that is predictable and fatal: the refresh
    // token's. Announced once, well ahead, on this same cadence.
    if (engineAvailable(getConfig(), "claude")) checkClaudeRefreshExpiry();
    void collectEngineLimits(getConfig())
      .then(() => {
        const unhealthy = Object.entries(readEngineHealth())
          .filter(([, health]) => health.state !== "ok")
          .map(([name, health]) => `${name}=${health.state}${health.until ? ` until ${health.until}` : ""}`);
        if (unhealthy.length > 0) logger.info(`Engine health: ${unhealthy.join(", ")}`);
      })
      .catch((error) => logger.warn(`Engine health refresh failed: ${String(error)}`));
  };

  refreshModels();
  refreshEngineHealth();
  const timers = [
    setInterval(refreshModels, MODEL_REFRESH_INTERVAL_MS),
    setInterval(refreshEngineHealth, ENGINE_HEALTH_REFRESH_INTERVAL_MS),
  ];
  for (const timer of timers) timer.unref?.();

  return { refreshModels, stop: () => { for (const timer of timers) clearInterval(timer); } };
}
