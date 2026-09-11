import type { EngineRunOpts } from "../shared/types.js";
import { logger } from "../shared/logger.js";

/**
 * opencode's wire contract, as pure functions.
 *
 * The argv and the prompt live here rather than in the engine because BOTH
 * transports build them: a remote turn differs from a local one only in which
 * machine runs the command, and two copies of that list is how the two quietly
 * stop being the same turn. The event readers live here for the same reason the
 * grok engine keeps `grok-json.ts` beside it — pulling a value out of a
 * loosely-typed line is its own concern, separable from deciding what the line
 * MEANS.
 */

/** The prompt as opencode will receive it on stdin: the system prompt on a first
 *  turn, and any attachment paths appended. Shared by both transports so a remote
 *  turn cannot drift into being prompted differently from a local one.
 *
 *  Attachments are named in the text rather than passed to opencode's own `-f`,
 *  which is the same shape the Pi engine uses. Wiring `-f` is a later change;
 *  the remote path refuses attachments outright (see runRemote), because there
 *  the paths are the gateway's and name nothing on the other machine. */
export function buildOpencodePrompt(opts: EngineRunOpts): string {
  let prompt = opts.prompt;
  if (opts.systemPrompt && !opts.resumeSessionId) {
    prompt = `${opts.systemPrompt}\n\n---\n\n${prompt}`;
  }
  if (opts.attachments?.length) {
    prompt += `\n\nAttached files:\n${opts.attachments.map((a) => `- ${a}`).join("\n")}`;
  }
  return prompt;
}

/**
 * opencode's argv, minus the prompt.
 *
 * Identical on both transports — the only thing a remote turn changes is which
 * machine runs it — so this is one list rather than two that drift.
 *
 * `--dangerously-skip-permissions` is how an unattended turn gets approval, and
 * it is deliberately the ONLY approval lever jinn pulls: it auto-approves
 * everything not EXPLICITLY denied, so an operator who denied `bash` in their
 * own opencode config still has that honoured. Forcing a `permission` block in
 * the staged config would silently take that away.
 */
export function buildOpencodeArgs(opts: EngineRunOpts): string[] {
  const args = ["run", "--format", "json", "--dangerously-skip-permissions"];
  if (opts.model) args.push("-m", opts.model);
  // opencode assigns its own session ids, so a resume names one it gave us on a
  // previous turn — unlike pi, where the id is ours and the same on every turn.
  if (opts.resumeSessionId) args.push("-s", opts.resumeSessionId);
  if (opts.cliFlags?.length) args.push(...opts.cliFlags);
  // The prompt goes over stdin, never argv: `run` takes the message as trailing
  // positionals, so a prompt beginning with a dash would be read as a flag, and
  // a long one would run into ARG_MAX.
  return args;
}

/** The model, for a log line. */
export function describeOpencodeLaunch(opts: EngineRunOpts): string {
  return `-m ${opts.model || "(opencode default)"}`;
}

/** The `tokens` block of a `step_finish` part, as far as we rely on it. */
export interface StepTokens {
  input?: number;
  output?: number;
  cache?: { read?: number; write?: number };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * How full the context window is after this step: everything opencode counted
 * as INPUT, cached or not. Matches {@link EngineResult.contextTokens}, which is
 * defined as input + cache-read + cache-creation.
 */
export function contextTokensFromStep(tokens: StepTokens | undefined): number | undefined {
  if (!tokens) return undefined;
  const cache = tokens.cache ?? {};
  const total = numberOr(tokens.input, 0) + numberOr(cache.read, 0) + numberOr(cache.write, 0);
  return total > 0 ? total : undefined;
}

export function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** One stdout line as an event object, or undefined when it is not one. */
export function parseEventLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    logger.debug(`[opencode stream] unparseable line: ${trimmed.slice(0, 100)}`);
    return undefined;
  }
}

/** The tool name and call id a `tool_use` part carries, shaped for a StreamDelta
 *  spread so the start and the result cannot disagree about which call they are. */
export function toolIdentity(part: Record<string, unknown>): { toolName?: string; toolId?: string } {
  const toolName = trimmedString(part.tool);
  const toolId = trimmedString(part.callID);
  return { ...(toolName ? { toolName } : {}), ...(toolId ? { toolId } : {}) };
}

/** A one-line summary of a tool call for the live view. The three input keys are
 *  the ones opencode's own built-in tools use for the thing being acted on. */
export function describeToolCall(toolName: string | undefined, input: Record<string, unknown> | undefined): string {
  const detail = [input?.filePath, input?.command, input?.path].map(trimmedString).find(Boolean);
  return detail ? `${toolName ?? "tool"}: ${detail}` : `Running ${toolName ?? "tool"}`;
}

/** The message an `error` event carries, as a single line for EngineResult.error. */
export function opencodeErrorText(event: Record<string, unknown>): string | undefined {
  const error = asRecord(event.error);
  if (!error) return undefined;
  const message = trimmedString(asRecord(error.data)?.message);
  const name = trimmedString(error.name);
  if (message && name) return `${name}: ${message}`;
  return message ?? name;
}
