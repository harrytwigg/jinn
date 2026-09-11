import fs from "node:fs";
import path from "node:path";
import { resolveClaudeConfigDir } from "./home.js";
import { logger } from "./logger.js";

/**
 * What the Claude Code credentials on THIS host say about whether a `claude`
 * launch can authenticate — read from disk, never by spending a turn.
 *
 * Claude Code owns the OAuth pair: it refreshes the access token itself when a
 * process starts or gets a 401, using the refresh token, and rotates both on
 * success. The gateway deliberately never calls the refresh endpoint — a
 * second refresher racing the CLI's own is the exact way a refresh token gets
 * consumed by one process and lost by the file, which is the outage this
 * module exists to detect. So the only hard verdicts here are the ones the
 * file states outright: no OAuth at all, or a refresh token past its own
 * expiry. An expired ACCESS token is routine (its lifetime is hours) and is
 * not a failure — the CLI will refresh it on the next launch — until a launch
 * proves it cannot (see claude-auth-outage.ts).
 */
export type ClaudeCredentialState =
  /** `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is set; nothing on disk is consulted. */
  | "env"
  /** An access token that has not expired. */
  | "ok"
  /** The access token has expired but the refresh token has not: the CLI refreshes on launch. */
  | "access-expired"
  /** The refresh token itself has expired — only `claude auth login` can fix this. */
  | "refresh-expired"
  /** No credentials file on a host that keeps one. */
  | "missing"
  /** A file exists but carries no OAuth pair (API-key auth, or a shape we do not read). */
  | "unknown";

export interface ClaudeCredentialStatus {
  state: ClaudeCredentialState;
  /** Where the verdict came from, for an operator-facing message. */
  path?: string;
  /** Unix ms, when the file states them. */
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
  /**
   * Identity of the on-disk pair WITHOUT any secret material: a login or a
   * successful refresh changes both expiries, so this changes exactly when the
   * credentials do. Used to tell "same credentials that already failed" from
   * "someone has logged in since".
   */
  fingerprint?: string;
}

export interface ParsedClaudeCredentials {
  accessToken?: string;
  refreshToken?: string;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
}

function expiryMs(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 && Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

/**
 * The OAuth pair inside a Claude Code credentials blob. The same JSON shape is
 * stored in the macOS Keychain and in the plaintext credentials file, so both
 * sources share this parser. Returns undefined when the blob carries no
 * `claudeAiOauth` object at all (API-key auth, or not a credentials blob).
 */
export function parseClaudeCredentials(raw: string): ParsedClaudeCredentials | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = parsed?.claudeAiOauth;
    if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return undefined;
    const obj = oauth as Record<string, unknown>;
    const accessToken = typeof obj.accessToken === "string" ? obj.accessToken.trim() : "";
    const refreshToken = typeof obj.refreshToken === "string" ? obj.refreshToken.trim() : "";
    return {
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      accessExpiresAt: expiryMs(obj.expiresAt),
      refreshExpiresAt: expiryMs(obj.refreshTokenExpiresAt),
    };
  } catch {
    return undefined;
  }
}

function expiryDetail(creds: ParsedClaudeCredentials): Omit<ClaudeCredentialStatus, "path" | "state"> {
  return {
    ...(creds.accessExpiresAt !== undefined ? { accessExpiresAt: creds.accessExpiresAt } : {}),
    ...(creds.refreshExpiresAt !== undefined ? { refreshExpiresAt: creds.refreshExpiresAt } : {}),
    fingerprint: `${creds.accessExpiresAt ?? "?"}:${creds.refreshExpiresAt ?? "?"}`,
  };
}

function credentialState(creds: ParsedClaudeCredentials, now: number): ClaudeCredentialState {
  const accessLive = Boolean(creds.accessToken) && (creds.accessExpiresAt === undefined || creds.accessExpiresAt > now);
  if (accessLive) return "ok";
  if (!creds.refreshToken) return "refresh-expired";
  if (creds.refreshExpiresAt !== undefined && creds.refreshExpiresAt <= now) return "refresh-expired";
  return "access-expired";
}

/** The verdict for one parsed pair. Pure, so the Keychain path can share it. */
export function classifyClaudeCredentials(
  creds: ParsedClaudeCredentials | undefined,
  now: number = Date.now(),
): Omit<ClaudeCredentialStatus, "path"> {
  if (!creds || (!creds.accessToken && !creds.refreshToken)) return { state: "unknown" };
  return { state: credentialState(creds, now), ...expiryDetail(creds) };
}

export interface ReadClaudeCredentialStatusOptions {
  now?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Overrides the CLAUDE_CONFIG_DIR resolution — a test seam and the remote-profile seam. */
  configDir?: string;
}

/**
 * Read the credential verdict for this host synchronously — preflight runs
 * before anything async, and a credentials file is one small read.
 *
 * Fails open everywhere the file cannot speak for itself: an env token, a
 * darwin host (where Claude Code keeps the pair in the Keychain and writes no
 * file), an unreadable or OAuth-less file. Only a Linux/Windows host with no
 * file, or a file whose refresh token is past its own expiry, is a hard "no".
 */
export function readClaudeCredentialStatus(options: ReadClaudeCredentialStatusOptions = {}): ClaudeCredentialStatus {
  const env = options.env ?? process.env;
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || env.ANTHROPIC_API_KEY?.trim()) return { state: "env" };
  const file = path.join(options.configDir ?? resolveClaudeConfigDir(), ".credentials.json");
  return { ...readCredentialsFile(file, options.platform ?? process.platform, options.now), path: file };
}

function readCredentialsFile(file: string, platform: NodeJS.Platform, now: number | undefined): Omit<ClaudeCredentialStatus, "path"> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    return { state: missing && platform !== "darwin" ? "missing" : "unknown" };
  }
  return classifyClaudeCredentials(parseClaudeCredentials(raw), now);
}

/** The `claude auth login` instruction, phrased for the host it must run on. */
export function claudeLoginHint(hostname: string, configDir?: string): string {
  const dirNote = configDir ? ` with CLAUDE_CONFIG_DIR=${configDir}` : "";
  return `run \`claude auth login\` on ${hostname}${dirNote} as the gateway user`;
}

/**
 * The operator-facing reading of a model discovery that got no models: only
 * tells the operator to log in when logging in is the fix. An access token
 * expired between launches is the file's normal state and the CLI refreshes
 * it, so saying "run `claude login`" for that was noise that hid the two cases
 * where it is the only remedy.
 */
export function describeZeroModels(status: ClaudeCredentialStatus): { level: "info" | "warn"; text: string } {
  switch (status.state) {
    case "access-expired":
      return { level: "info", text: "the access token on disk has expired; Claude Code refreshes it on its next launch" };
    case "refresh-expired":
      return { level: "warn", text: "the Claude login has expired and cannot be refreshed. Run `claude auth login` on this host" };
    case "missing":
      return { level: "warn", text: `no Claude credentials${status.path ? ` at ${status.path}` : ""}. Run \`claude auth login\` on this host` };
    case "env":
      return { level: "warn", text: "the token in the environment was not accepted for the catalog request" };
    case "ok":
      return { level: "warn", text: "the catalog request returned no Claude models for a live token" };
    default:
      return { level: "warn", text: "no usable OAuth token was found. Run `claude auth login` on this host" };
  }
}

/** Log a zero-model discovery at the level its cause deserves. */
export function logZeroClaudeModels(status: ClaudeCredentialStatus, keepingCatalog: boolean): void {
  const reading = describeZeroModels(status);
  logger[reading.level](
    `Claude model discovery returned 0 models — ${reading.text}`
      + (keepingCatalog ? "; keeping the last discovered catalog." : "; falling back to the offline alias catalog."),
  );
}
