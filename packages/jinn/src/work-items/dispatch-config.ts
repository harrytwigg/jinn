import { initDb } from '../shared/db.js';
import { installedSkillNames } from '../shared/skill-commands.js';
import { logger } from '../shared/logger.js';
import { getModelRegistry } from '../shared/models.js';
import { validateNewSessionSelection } from '../sessions/session-patch.js';
import type { JinnConfig } from '../shared/types.js';
import { parseTodoId } from './id.js';
import { parseSkillsJson } from './dispatch-schema.js';
import { readAutoStartRow, writeAutoStartRow, type AutoStartRow } from './auto-start.js';

/**
 * How a Todo is RUN (ICI-733): the skills its working session preloads and the
 * engine/model its NEXT attempt uses.
 *
 * Both are set-time validated and re-resolved at dispatch, because the two
 * moments are far apart: a skill can be deleted and an engine can be
 * reconfigured between the agent setting the field and the Todo being picked
 * up. Set-time validation is what makes the error actionable; dispatch-time
 * resolution is what keeps it honest.
 *
 * The override is deliberately read at dispatch and never pushed into a live
 * session — that is what makes it settable on an `executing` Todo without
 * disturbing the attempt already in flight.
 */

export const TODO_SKILLS_MAX = 10;
const SKILL_NAME_CHAR_CAP = 128;

export interface TodoDispatchConfig {
  /** Empty when nothing has been requested. */
  skills: string[];
  engine: string | null;
  model: string | null;
  /** GEN-67: false when the Todo has opted out of being auto-started by a
   *  `todo-status` Workflow trigger on assignment. Defaults to true. */
  autoStart: boolean;
  updatedAt: string;
}

export interface TodoDispatchConfigInput {
  /** Unknown because it arrives from an HTTP body or a tool call; `validateSkills`
   *  is the one place it becomes a list of installed skill names. */
  skills?: unknown;
  engine?: string | null;
  model?: string | null;
  autoStart?: boolean;
}

export type TodoDispatchConfigResult =
  | { ok: true; config: TodoDispatchConfig }
  | { ok: false; error: string };

/** A skills entry that names an MCP tool instead of a workspace playbook. MCP
 *  tools are namespaced `mcp__<server>__<tool>`, and the double underscore is
 *  the giveaway even when the `mcp__` prefix has been dropped. */
function looksLikeMcpToolName(name: string): boolean {
  return name.includes('__');
}

function validateSkills(raw: unknown): { ok: true; skills: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'skills must be an array of installed skill names' };
  if (raw.length > TODO_SKILLS_MAX) {
    return { ok: false, error: `skills accepts at most ${TODO_SKILLS_MAX} entries per Todo (got ${raw.length})` };
  }
  if (raw.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > SKILL_NAME_CHAR_CAP)) {
    return { ok: false, error: `skills entries must be non-empty strings of at most ${SKILL_NAME_CHAR_CAP} characters` };
  }
  const skills = (raw as string[]).map((entry) => entry.trim());

  const toolNames = skills.filter(looksLikeMcpToolName);
  if (toolNames.length > 0) {
    return {
      ok: false,
      error:
        `skills entries name workspace playbooks, not MCP tools: ${toolNames.join(', ')} ` +
        'looks like a tool id (mcp__<server>__<tool>). A skill is a directory under skills/ with a ' +
        'SKILL.md — pass its directory name. MCP tools are attached per engine and need no Todo field.',
    };
  }

  const installed = installedSkillNames();
  const unknown = skills.filter((name) => !installed.has(name));
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `unknown skill${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} — ` +
        'a skill is a directory under skills/ holding a SKILL.md. GET /api/skills lists the installed ones.',
    };
  }
  return { ok: true, skills };
}

/** The session choke point tolerates a Pi model its discovery snapshot has not
 *  caught up with yet. That is right for a session starting this second and
 *  wrong for a STORED override: the next attempt can be hours away, so an id no
 *  registry ever knew would fail then, on a warning nobody was there to read.
 *  Set time is the only moment the caller can be told. */
function unregisteredModelError(config: JinnConfig, engine: string | undefined, model: string | undefined): string | null {
  if (!engine || !model) return null;
  const known = (getModelRegistry(config)[engine]?.models ?? []).map((entry) => entry.id);
  if (known.includes(model)) return null;
  return `unknown model "${model}" for engine "${engine}" (known: ${known.join(', ') || 'none'})`;
}

/** Engine and model go through the same choke point every new session uses, so
 *  "engine implies a model that engine knows" and its error prose come for free
 *  rather than being re-derived here. */
function validateOverride(
  config: JinnConfig,
  engine: string | null | undefined,
  model: string | null | undefined,
): { ok: true; engine: string | null; model: string | null } | { ok: false; error: string } {
  if (!engine) {
    return model
      ? { ok: false, error: 'a model override needs an engine override — a model is only meaningful for one engine' }
      : { ok: true, engine: null, model: null };
  }
  const selection = validateNewSessionSelection(config, {
    engine,
    ...(model ? { model } : {}),
  });
  if (!selection.ok) return { ok: false, error: selection.error ?? 'invalid engine/model override' };
  const unregistered = unregisteredModelError(config, selection.engine, selection.model);
  if (unregistered) return { ok: false, error: unregistered };
  return { ok: true, engine: selection.engine ?? null, model: selection.model ?? null };
}

interface DispatchRow {
  skills: string | null;
  engine: string | null;
  model: string | null;
  updated_at: string;
}

/** The newest of the two tables' stamps: the config reads as one record, so it
 *  is "updated" whenever either half was. */
function latestUpdatedAt(...stamps: Array<string | undefined>): string {
  return stamps.filter((value): value is string => value !== undefined).sort().at(-1)!;
}

function rowsToConfig(row: DispatchRow | undefined, autoStart: AutoStartRow | undefined): TodoDispatchConfig {
  const base = row ? { skills: row.skills === null ? [] : parseSkillsJson(row.skills) ?? [], engine: row.engine, model: row.model }
    : { skills: [], engine: null, model: null };
  return {
    ...base,
    autoStart: autoStart === undefined || autoStart.auto_start === 1,
    updatedAt: latestUpdatedAt(row?.updated_at, autoStart?.updated_at),
  };
}

/** The Todo's dispatch preferences, or undefined when it has none. */
export function getTodoDispatchConfig(workItemId: string): TodoDispatchConfig | undefined {
  const id = parseTodoId(workItemId);
  const row = initDb()
    .prepare('SELECT skills, engine, model, updated_at FROM work_item_dispatch WHERE work_item_id = ?')
    .get(id) as DispatchRow | undefined;
  const autoStart = readAutoStartRow(initDb(), id);
  return row === undefined && autoStart === undefined ? undefined : rowsToConfig(row, autoStart);
}

/**
 * Replace a Todo's dispatch preferences. Patch semantics per field: an omitted
 * key keeps what is stored, an explicit `null` (or empty skills list) clears it.
 * Validation runs BEFORE any write, so a rejected request leaves no row behind.
 */
/** Patch semantics for the override pair. Changing the engine without naming a
 *  model clears the stored one rather than carrying another engine's model
 *  across — the next attempt then resolves the new engine's default, which is
 *  what the workflow resolver already does for a node-level engine. */
function patchedOverride(
  current: TodoDispatchConfig | undefined,
  input: TodoDispatchConfigInput,
): { engine: string | null; model: string | null } {
  const currentEngine = current?.engine ?? null;
  const engine = input.engine === undefined ? currentEngine : input.engine;
  const keptModel = engine === currentEngine ? current?.model ?? null : null;
  return { engine, model: input.model === undefined ? keptModel : input.model };
}

export function setTodoDispatchConfig(
  workItemId: string,
  input: TodoDispatchConfigInput,
  config: JinnConfig,
): TodoDispatchConfigResult {
  const id = parseTodoId(workItemId);
  const current = getTodoDispatchConfig(id);

  const validated = input.skills === undefined
    ? { ok: true as const, skills: current?.skills ?? [] }
    : validateSkills(input.skills);
  if (!validated.ok) return validated;
  const skills = validated.skills;

  const patched = patchedOverride(current, input);
  const override = validateOverride(config, patched.engine, patched.model);
  if (!override.ok) return override;
  const flag = patchedAutoStart(current, input);
  if (!flag.ok) return flag;
  const { autoStart } = flag;

  const updatedAt = new Date().toISOString();
  const db = initDb();
  db.transaction(() => {
    // The two tables are written independently, so a call that touches only the
    // flag never mints a blank dispatch row and vice versa.
    if (touchesDispatchRow(input)) {
      db.prepare(
        `INSERT INTO work_item_dispatch (work_item_id, skills, engine, model, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(work_item_id) DO UPDATE SET
           skills = excluded.skills, engine = excluded.engine, model = excluded.model, updated_at = excluded.updated_at`,
      ).run(id, skills.length > 0 ? JSON.stringify(skills) : null, override.engine, override.model, updatedAt);
    }
    if (input.autoStart !== undefined) writeAutoStartRow(db, id, autoStart, updatedAt);
  })();

  return { ok: true, config: { skills, engine: override.engine, model: override.model, autoStart, updatedAt } };
}

function patchedAutoStart(
  current: TodoDispatchConfig | undefined,
  input: TodoDispatchConfigInput,
): { ok: true; autoStart: boolean } | { ok: false; error: string } {
  if (input.autoStart !== undefined && typeof input.autoStart !== 'boolean') {
    return { ok: false, error: 'autoStart must be a boolean' };
  }
  return { ok: true, autoStart: input.autoStart ?? current?.autoStart ?? true };
}

function touchesDispatchRow(input: TodoDispatchConfigInput): boolean {
  return input.skills !== undefined || input.engine !== undefined || input.model !== undefined;
}

export interface TodoDispatchPreamble {
  /** Prepended to the prompt; empty when the Todo requested no skills. */
  prefix: string;
  engine: string | null;
  model: string | null;
}

/**
 * What a dispatch needs from the Todo's preferences, resolved against the
 * workspace as it is NOW.
 *
 * Skills are re-checked because the set can shrink between set time and
 * dispatch. A partial loss still runs — losing one playbook is not a reason to
 * refuse the work — but it is warned about, since a silently thinner prompt is
 * how an attempt fails for reasons nobody can see. Losing ALL of them is
 * different: the Todo asked to be worked with skills and none survived, so the
 * attempt would be something other than what was requested.
 */
export function resolveTodoDispatch(workItemId: string):
  | { ok: true; preamble: TodoDispatchPreamble }
  | { ok: false; error: string } {
  const stored = getTodoDispatchConfig(workItemId);
  if (!stored) return { ok: true, preamble: { prefix: '', engine: null, model: null } };

  const installed = installedSkillNames();
  const present = stored.skills.filter((name) => installed.has(name));
  const missing = stored.skills.filter((name) => !installed.has(name));

  if (stored.skills.length > 0 && present.length === 0) {
    return {
      ok: false,
      error:
        `Todo ${workItemId} requests skill${missing.length > 1 ? 's' : ''} ${missing.join(', ')}, ` +
        'and none of them are installed. Install them under skills/, or clear the Todo\'s skills before dispatching.',
    };
  }
  if (missing.length > 0) {
    logger.warn(
      `Todo ${workItemId} dispatching without missing skill${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ` +
      `(loading ${present.join(', ')})`,
    );
  }

  return { ok: true, preamble: { prefix: skillsPromptPrefix(present), engine: stored.engine, model: stored.model } };
}

function skillsPromptPrefix(skills: readonly string[]): string {
  if (skills.length === 0) return '';
  return `Read and follow ${skills.map((name) => `skills/${name}/SKILL.md`).join(', ')} before you start.\n\n`;
}
