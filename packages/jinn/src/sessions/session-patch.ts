import type { JinnConfig } from "../shared/types.js";
import { getModelRegistry, effortLevelsForModel, isKnownEngine } from "../shared/models.js";
import { preferHealthySessionEngine, readEngineHealth } from "../shared/engine-health.js";
import { logger } from "../shared/logger.js";

/**
 * Validate a mid-chat model/effort change for an existing session.
 *
 * Engine is NOT switchable mid-chat (new-chat only), so this only handles
 * `model` and `effortLevel`, validated against the registry for the session's
 * (fixed) engine. The change applies from the NEXT turn — the SessionManager
 * reads session.model / session.effortLevel fresh on every turn and passes them
 * (with resumeSessionId) to the engine, which our spike confirmed honors a
 * changed --model in place (no fork needed). Antigravity supports --model; if
 * its CLI is already warm, the new model applies on the next cold spawn/resume.
 */

export interface SessionPatchResult {
  ok: boolean;
  updates?: { model?: string; effortLevel?: string };
  error?: string;
}

export interface NewSessionSelectionResult {
  ok: boolean;
  engine?: string;
  model?: string;
  effortLevel?: string;
  error?: string;
}

export interface SessionPatchContext {
  engineSessionId?: string | null;
  defaultModel?: string | null;
}

export function validateNewSessionSelection(
  config: JinnConfig,
  body: { engine?: unknown; model?: unknown; effortLevel?: unknown },
  defaults: { engine?: string; model?: string; effortLevel?: string; employee?: string } = {},
): NewSessionSelectionResult {
  const registry = getModelRegistry(config);
  let engine: string = defaults.engine?.trim() || config.engines.default;

  if (body.engine !== undefined) {
    if (typeof body.engine !== "string" || !body.engine.trim()) {
      return { ok: false, error: "engine must be a non-empty string" };
    }
    engine = body.engine.trim();
  }

  if (!registry[engine]) return { ok: false, error: `unknown engine "${engine}"` };

  // Nothing named this engine outright — it came from the config default or an
  // employee's YAML — so an engine whose allowance is spent may be reordered out
  // of the way. A named engine wins, and so does a named model, which belongs to
  // exactly one engine. Advisory only: a chain with nothing healthy left in it
  // hands the preference back and the session starts where it would have.
  let defaultModel = defaults.model;
  let defaultEffortLevel = defaults.effortLevel;
  if (body.engine === undefined && body.model === undefined && isKnownEngine(engine)) {
    // NOT scoped by host, unlike the other two engine-choosing paths: `defaults`
    // carries the employee's NAME, not its record, so this cannot tell whether
    // the session runs here or on another machine. Until the Employee is
    // threaded through this path's four callers it also cannot apply the
    // remote-capability filter `newSessionEngineSelection` has — the same
    // missing argument, and the same fix.
    const healthy = preferHealthySessionEngine(
      config,
      engine,
      (candidate) => registry[candidate]?.available === true,
      readEngineHealth(),
    );
    if (healthy !== engine) {
      logger.info(`Engine "${engine}" is out of allowance — starting this session on "${healthy}" instead`);
      engine = healthy;
      // The model and effort level came with the engine we just moved off and
      // mean nothing on this one; the substitute runs on its own configured
      // defaults, the same way a mid-turn fallback already does.
      defaultModel = undefined;
      defaultEffortLevel = undefined;
    }
  }

  const entry = registry[engine]!;

  let model: string | undefined;
  // Track whether the model came from an explicit caller override (body) or an
  // employee's configured default — the error phrasing differs (GRS-017f).
  const modelFromBody = body.model !== undefined;
  const requestedModel = modelFromBody ? body.model : defaultModel;
  if (requestedModel !== undefined) {
    if (typeof requestedModel !== "string" || !requestedModel.trim()) {
      return { ok: false, error: "model must be a non-empty string" };
    }
    model = requestedModel.trim();
    if (!entry.models.some((m) => m.id === model)) {
      if (engine === "pi") {
        // Pi models are discovered dynamically; tolerate an id the snapshot hasn't
        // caught yet (e.g. just after a restart, before discovery completes).
        logger.warn(`pi model "${model}" not in discovered set yet — allowing`);
      } else {
        const known = entry.models.map((m) => m.id).join(", ");
        // GRS-017f: when the unknown model is an EMPLOYEE'S CONFIGURED DEFAULT
        // (not an explicit caller override), the bare engine string ("unknown
        // model X for engine Y") gives the agent no hint the culprit is the
        // employee YAML. Name the employee, its configured model, the known set,
        // AND the two-way fix — so delegate/spawn/workflow all fail actionably
        // instead of silently running a different model or emitting a cryptic
        // engine error.
        if (!modelFromBody && defaults.employee) {
          const suggested = entry.models[0]?.id;
          return {
            ok: false,
            error:
              `employee "${defaults.employee}" is configured with model "${model}", which engine "${engine}" does not know ` +
              `(known: ${known || "none"}). Fix: set a known model${suggested ? ` (e.g. model: ${suggested})` : ""} in the employee's ` +
              `org YAML (org/${defaults.employee}.yaml), or register "${model}" for engine "${engine}" in config.yaml.`,
          };
        }
        return { ok: false, error: `unknown model "${model}" for engine "${engine}" (known: ${known || "none"})` };
      }
    }
  }

  let effortLevel: string | undefined;
  const effortFromBody = body.effortLevel !== undefined;
  const requestedEffortLevel = effortFromBody ? body.effortLevel : defaultEffortLevel;
  if (requestedEffortLevel !== undefined) {
    if (typeof requestedEffortLevel !== "string" || !requestedEffortLevel.trim()) {
      return { ok: false, error: "effortLevel must be a non-empty string" };
    }
    effortLevel = requestedEffortLevel.trim();
    const effectiveModel = model ?? undefined;
    const valid = effortLevelsForModel(config, engine, effectiveModel);
    if (valid.length === 0) {
      if (!effortFromBody) {
        logger.warn(
          `Ignoring employee default effortLevel "${effortLevel}" for engine "${engine}"` +
          `${effectiveModel ? ` model "${effectiveModel}"` : ""}` +
          `${defaults.employee ? ` on employee "${defaults.employee}"` : ""}: model does not support effort levels`,
        );
        effortLevel = undefined;
      } else {
        return { ok: false, error: `engine "${engine}"${effectiveModel ? ` model "${effectiveModel}"` : ""} does not support effort levels` };
      }
    }
    if (effortLevel !== undefined && !valid.includes(effortLevel)) {
      if (!effortFromBody) {
        logger.warn(
          `Ignoring invalid employee default effortLevel "${effortLevel}" for engine "${engine}"` +
          `${effectiveModel ? ` model "${effectiveModel}"` : ""}` +
          `${defaults.employee ? ` on employee "${defaults.employee}"` : ""} (valid: ${valid.join(", ")})`,
        );
        effortLevel = undefined;
      } else {
        return { ok: false, error: `invalid effortLevel "${effortLevel}" (valid: ${valid.join(", ")})` };
      }
    }
  }

  return { ok: true, engine, model, effortLevel };
}

export function validateSessionPatch(
  config: JinnConfig,
  engine: string,
  currentModel: string | null | undefined,
  body: { model?: unknown; effortLevel?: unknown },
  context: SessionPatchContext = {},
): SessionPatchResult {
  const updates: { model?: string; effortLevel?: string } = {};

  const entry = getModelRegistry(config)[engine];

  // --- model ---
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || !body.model.trim()) {
      return { ok: false, error: "model must be a non-empty string" };
    }
    const modelId = body.model.trim();
    if (entry && !entry.models.some((m) => m.id === modelId)) {
      if (engine === "pi") {
        // Pi models are discovered dynamically; tolerate an id the snapshot hasn't
        // caught yet (e.g. just after a restart, before discovery completes).
        logger.warn(`pi model "${modelId}" not in discovered set yet — allowing`);
      } else {
        const known = entry.models.map((m) => m.id).join(", ");
        return { ok: false, error: `unknown model "${modelId}" for engine "${engine}" (known: ${known || "none"})` };
      }
    }
    const effectiveCurrentModel = currentModel ?? context.defaultModel ?? undefined;
    if (engine === "grok" && context.engineSessionId && effectiveCurrentModel && modelId !== effectiveCurrentModel) {
      return {
        ok: false,
        error: "Grok model changes require a new session because Grok binds existing transcripts to a model-specific agent.",
      };
    }
    updates.model = modelId;
  }

  // --- effortLevel (validated against the *resulting* model) ---
  if (body.effortLevel !== undefined) {
    if (typeof body.effortLevel !== "string" || !body.effortLevel.trim()) {
      return { ok: false, error: "effortLevel must be a non-empty string" };
    }
    const level = body.effortLevel.trim();
    const effectiveModel = updates.model ?? currentModel ?? undefined;
    const valid = effortLevelsForModel(config, engine, effectiveModel);
    if (valid.length === 0) {
      return { ok: false, error: `engine "${engine}"${effectiveModel ? ` model "${effectiveModel}"` : ""} does not support effort levels` };
    }
    if (!valid.includes(level)) {
      return { ok: false, error: `invalid effortLevel "${level}" (valid: ${valid.join(", ")})` };
    }
    updates.effortLevel = level;
  }

  if (updates.model === undefined && updates.effortLevel === undefined) {
    return { ok: false, error: "no valid fields to update (expected model and/or effortLevel)" };
  }
  return { ok: true, updates };
}
