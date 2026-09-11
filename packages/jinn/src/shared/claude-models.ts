import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import type { ModelInfo } from "./types.js";
import { resolveClaudeConfigDir } from "./home.js";
import { parseClaudeCredentials } from "./claude-auth.js";

export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
export const CLAUDE_ALIAS_IDS = ["opus", "sonnet", "fable"] as const;
const CLAUDE_ALIAS_LABELS: Record<(typeof CLAUDE_ALIAS_IDS)[number], string> = {
  opus: "Opus (Latest)",
  sonnet: "Sonnet (Latest)",
  fable: "Fable (Latest)",
};

export interface ClaudeModelDiscovery {
  defaultModel?: string;
  models: ModelInfo[];
}

interface ParsedClaudeModel {
  model: ModelInfo;
  family?: string;
  createdAtMs: number;
}

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

function cleanEffortLevels(levels: readonly string[] | undefined): string[] {
  if (!levels) return [];
  return Array.from(new Set(
    levels
      .map((level) => level.trim().toLowerCase())
      .filter((level) => /^[a-z][a-z0-9_-]*$/.test(level)),
  ));
}

export function normalizeClaudeEffortLevels(levels: readonly string[] | undefined): string[] {
  const clean = cleanEffortLevels(levels);
  return clean.length > 0 ? clean : [...CLAUDE_EFFORT_LEVELS];
}

export function knownClaudeModels(pinned?: string, effortLevels?: readonly string[]): ClaudeModelDiscovery {
  const levels = normalizeClaudeEffortLevels(effortLevels);
  const models = CLAUDE_ALIAS_IDS.map((id): ModelInfo => ({
    id,
    label: CLAUDE_ALIAS_LABELS[id],
    supportsEffort: true,
    effortLevels: [...levels],
  }));
  if (pinned && !models.some((m) => m.id === pinned)) {
    models.unshift({
      id: pinned,
      label: pinned,
      supportsEffort: true,
      effortLevels: [...levels],
    });
  }
  return { defaultModel: pinned || "opus", models };
}

function labelClaudeModel(displayName: string, id: string): string {
  const trimmed = displayName.trim() || id;
  return trimmed.replace(/^Claude\s+/i, "");
}

function claudeFamily(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v === "opus" || /\bopus\b/.test(v) || /-opus-/.test(v)) return "opus";
  if (v === "sonnet" || /\bsonnet\b/.test(v) || /-sonnet-/.test(v)) return "sonnet";
  if (v === "fable" || /\bfable\b/.test(v) || /-fable-/.test(v)) return "fable";
  if (v === "haiku" || /\bhaiku\b/.test(v) || /-haiku-/.test(v)) return "haiku";
  return undefined;
}

function effortValues(raw: unknown): string[] {
  const candidates: unknown[] = [];
  if (Array.isArray(raw)) candidates.push(raw);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    candidates.push(obj.values, obj.levels, obj.options, obj.allowed_values, obj.supported_values);
  }

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const values = cleanEffortLevels(candidate
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean));
    if (values.length) return Array.from(new Set(values));
  }
  return [];
}

function extractEffortLevels(capabilities: unknown): string[] {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return [];
  const obj = capabilities as Record<string, unknown>;
  return effortValues(obj.effort ?? obj.reasoning_effort ?? obj.reasoningEffort);
}

function parseCreatedAt(value: unknown): number {
  if (typeof value !== "string") return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function parseConcreteModels(payload: unknown, fallbackEffortLevels?: readonly string[]): ParsedClaudeModel[] {
  const data = (payload && typeof payload === "object" && !Array.isArray(payload))
    ? (payload as Record<string, unknown>).data
    : undefined;
  if (!Array.isArray(data)) return [];

  const parsed: ParsedClaudeModel[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id.trim() : "";
    if (!id.startsWith("claude-") || seen.has(id)) continue;
    seen.add(id);
    const label = labelClaudeModel(typeof obj.display_name === "string" ? obj.display_name : "", id);
    const apiEffortLevels = extractEffortLevels(obj.capabilities);
    const effortLevels = apiEffortLevels.length > 0
      ? apiEffortLevels
      : normalizeClaudeEffortLevels(fallbackEffortLevels);
    const contextWindow = typeof obj.max_input_tokens === "number" ? obj.max_input_tokens : undefined;
    parsed.push({
      family: claudeFamily(`${id} ${label}`),
      createdAtMs: parseCreatedAt(obj.created_at),
      model: {
        id,
        label,
        supportsEffort: true,
        effortLevels,
        ...(contextWindow ? { contextWindow } : {}),
      },
    });
  }

  return parsed.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

export function parseAnthropicModels(payload: unknown, options: { effortLevels?: readonly string[] } = {}): ClaudeModelDiscovery {
  const concrete = parseConcreteModels(payload, options.effortLevels);
  const latestByFamily = new Map<string, ParsedClaudeModel>();
  for (const item of concrete) {
    if (!item.family || latestByFamily.has(item.family)) continue;
    latestByFamily.set(item.family, item);
  }

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const add = (model: ModelInfo) => {
    if (seen.has(model.id)) return;
    seen.add(model.id);
    models.push(model);
  };

  for (const alias of CLAUDE_ALIAS_IDS) {
    const latest = latestByFamily.get(alias);
    add(latest
      ? { ...latest.model, id: alias, label: latest.model.label }
      : knownClaudeModels(undefined, options.effortLevels).models.find((m) => m.id === alias)!);
  }
  for (const item of concrete) add(item.model);

  return {
    defaultModel: "opus",
    models,
  };
}

export function claudeFallbackCandidates(models: ModelInfo[], failedModel: string | undefined): string[] {
  if (!failedModel || (CLAUDE_ALIAS_IDS as readonly string[]).includes(failedModel)) return [];
  const family = claudeFamily(failedModel);
  if (!family) return [];
  const sameFamilyConcrete = models.filter((m) => m.id.startsWith("claude-") && claudeFamily(`${m.id} ${m.label}`) === family);
  const idx = sameFamilyConcrete.findIndex((m) => m.id === failedModel);
  const candidates = idx >= 0 ? sameFamilyConcrete.slice(idx + 1).map((m) => m.id) : [];
  if ((CLAUDE_ALIAS_IDS as readonly string[]).includes(family)) candidates.push(family);
  return Array.from(new Set(candidates.filter((id) => id !== failedModel)));
}

export function parseClaudeEffortLevels(helpText: string): string[] {
  const effortIndex = helpText.search(/--effort\s+<level>/i);
  if (effortIndex < 0) return [];
  const effortChunk = helpText.slice(effortIndex, effortIndex + 500);
  const match = /\(([^()]+)\)/.exec(effortChunk);
  if (!match) return [];
  return cleanEffortLevels(match[1].split(","));
}

export async function discoverClaudeEffortLevels(bin: string): Promise<string[]> {
  const output = await new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    const finish = (s: string) => {
      if (done) return;
      done = true;
      resolve(s);
    };
    try {
      const proc = spawn(bin, ["--help"], { stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (out += d.toString()));
      let killTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        try { proc.kill("SIGTERM"); } catch {}
        killTimer = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
        }, 1000);
        finish(out);
      }, 5000);
      proc.on("close", () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        finish(out);
      });
      proc.on("error", () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        finish("");
      });
    } catch {
      finish("");
    }
  });
  return parseClaudeEffortLevels(output);
}

/**
 * Parse an unexpired access token out of a Claude Code credentials blob. The
 * same JSON shape is stored in the macOS Keychain and in the plaintext
 * credentials file, so both sources share this parser.
 */
export function claudeTokenFromCredentialsJson(raw: string): string | undefined {
  const creds = parseClaudeCredentials(raw);
  if (!creds?.accessToken) return undefined;
  if (creds.accessExpiresAt !== undefined && creds.accessExpiresAt <= Date.now()) return undefined;
  return creds.accessToken;
}

function tokenFromCredentialsFile(configDir: string): string | undefined {
  try {
    return claudeTokenFromCredentialsJson(
      fs.readFileSync(path.join(configDir, ".credentials.json"), "utf-8"),
    );
  } catch {
    return undefined;
  }
}

function readMacosKeychainCredentials(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { timeout: 3_000 },
      (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined),
    );
  });
}

export interface ReadClaudeOAuthTokenOptions {
  home?: string;
  /** Overridable so tests can exercise the darwin branch on any host. */
  platform?: NodeJS.Platform;
  /** Overridable so tests never shell out to the real Keychain. */
  readKeychain?: () => Promise<string | undefined>;
}

/**
 * Resolve the Claude Code OAuth token, in precedence order:
 *   1. $CLAUDE_CODE_OAUTH_TOKEN
 *   2. the macOS login Keychain (where Claude Code stores credentials on darwin)
 *   3. the plaintext ~/.claude/.credentials.json (Linux, and older installs)
 *
 * Step 2 is why this is async. Omitting it made every Claude model discovery
 * return zero models on a stock macOS install — Claude Code does not write the
 * credentials file there — which silently degraded the model catalog to the
 * hardcoded "<Name> (Latest)" offline labels. This is the single reader for
 * the whole codebase; engine-limits.ts previously kept a second, divergent copy.
 */
export async function readClaudeOAuthToken(
  options: ReadClaudeOAuthTokenOptions = {},
): Promise<string | undefined> {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) return envToken;

  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const raw = await (options.readKeychain ?? readMacosKeychainCredentials)();
    const token = raw ? claudeTokenFromCredentialsJson(raw) : undefined;
    if (token) return token;
  }

  // options.home is a test seam for the pre-CLAUDE_CONFIG_DIR layout.
  return tokenFromCredentialsFile(
    options.home ? path.join(options.home, ".claude") : resolveClaudeConfigDir(),
  );
}

export async function discoverClaudeModels(options: {
  token?: string;
  fetchImpl?: FetchLike;
  endpoint?: string;
  effortLevels?: readonly string[];
} = {}): Promise<ClaudeModelDiscovery> {
  const token = options.token ?? (await readClaudeOAuthToken());
  if (!token) return { models: [] };
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) return { models: [] };
  const endpoint = options.endpoint ?? "https://api.anthropic.com/v1/models";
  const res = await fetchImpl(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
    },
  });
  if (!res.ok) throw new Error(`Anthropic model catalog request failed: ${res.status} ${res.statusText}`);
  return parseAnthropicModels(await res.json(), { effortLevels: options.effortLevels });
}
