import fs from "node:fs";
import path from "node:path";
import type { McpServerStdioConfig, McpServerUrlConfig, ResolvedMcpConfig } from "../shared/types.js";
import { JINN_HOME } from "../shared/paths.js";

/**
 * The company toolset, as opencode takes it.
 *
 * opencode reads a real MCP config, which makes this the cheapest wiring of any
 * engine here: no generated extension module (pi), no `--mcp-config` dialect of
 * its own (claude) — just jinn's already-resolved server set projected into
 * opencode's `mcp` block and handed over through `OPENCODE_CONFIG`.
 *
 * `OPENCODE_CONFIG` MERGES with the operator's own config rather than replacing
 * it (verified against opencode 1.16.2), so this file carries only what jinn has
 * to add. In particular it does NOT carry a `permission` block: forcing
 * `allow` would quietly override an operator who deliberately denied `bash` on
 * that machine. Unattended approval comes from `--dangerously-skip-permissions`,
 * which auto-approves everything NOT explicitly denied — the operator's deny
 * still wins, exactly as it does when they run opencode themselves.
 */

/** A stdio server, as opencode's config names it: one argv array where jinn's
 *  resolved shape has `command` + `args`, and `environment` where jinn has `env`. */
export interface OpencodeLocalMcpServer {
  type: "local";
  command: string[];
  environment?: Record<string, string>;
  enabled: true;
}

/** A URL-backed server. jinn's resolver emits these for SSE endpoints; opencode
 *  calls the same thing `remote`. */
export interface OpencodeRemoteMcpServer {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  enabled: true;
}

export type OpencodeMcpServer = OpencodeLocalMcpServer | OpencodeRemoteMcpServer;

/** The config file jinn stages for one session. Only the keys jinn forces. */
export interface OpencodeSessionConfig {
  $schema: string;
  mcp: Record<string, OpencodeMcpServer>;
}

export type OpencodeConfigHandle =
  | { staged: false }
  | { staged: true; configPath: string; configDir: string; released?: boolean };

const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** A stdio server as opencode takes it, or null when the spec is not one. */
function projectStdioServer(spec: Record<string, unknown>): OpencodeLocalMcpServer | null {
  const stdio = spec as unknown as McpServerStdioConfig;
  if (typeof stdio.command !== "string" || !stdio.command) return null;
  const environment = stdio.env && Object.keys(stdio.env).length > 0 ? { ...stdio.env } : undefined;
  return {
    type: "local",
    command: [stdio.command, ...(stdio.args ?? [])],
    // The session's identity and capability ride here, in a 0600 file, for the
    // same reason they do for every other engine: a remote command line is
    // readable by every process on that host.
    ...(environment ? { environment } : {}),
    enabled: true,
  };
}

/** A URL-backed server as opencode takes it, or null when the spec is not one. */
function projectUrlServer(spec: Record<string, unknown>): OpencodeRemoteMcpServer | null {
  const url = spec as unknown as McpServerUrlConfig & { headers?: Record<string, string> };
  if (typeof url.url !== "string" || !url.url) return null;
  const headers = url.headers && Object.keys(url.headers).length > 0 ? { ...url.headers } : undefined;
  return { type: "remote", url: url.url, ...(headers ? { headers } : {}), enabled: true };
}

/**
 * Project one resolved MCP server into opencode's shape, or null when opencode
 * has no way to run it.
 *
 * Null rather than a best guess: a server jinn could not project is one the
 * model would be told about and then fail to call, and a half-wired toolset is
 * harder to diagnose than a missing one.
 */
export function projectOpencodeMcpServer(spec: unknown): OpencodeMcpServer | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const record = spec as Record<string, unknown>;
  return projectStdioServer(record) ?? projectUrlServer(record);
}

/** Every server in a resolved set that opencode can run. Pure, and shared by the
 *  local and the remote path so the two can never disagree about which tools a
 *  session carries. */
export function projectMcpForOpencode(resolvedMcp: ResolvedMcpConfig | undefined): Record<string, OpencodeMcpServer> {
  const out: Record<string, OpencodeMcpServer> = {};
  for (const [name, spec] of Object.entries(resolvedMcp?.mcpServers ?? {})) {
    const projected = projectOpencodeMcpServer(spec);
    if (projected) out[name] = projected;
  }
  return out;
}

/** The config file's contents for a session, or undefined when it carries no
 *  servers — opencode's own config is then left entirely alone. */
export function buildOpencodeSessionConfig(resolvedMcp: ResolvedMcpConfig | undefined): OpencodeSessionConfig | undefined {
  const mcp = projectMcpForOpencode(resolvedMcp);
  if (Object.keys(mcp).length === 0) return undefined;
  return { $schema: OPENCODE_CONFIG_SCHEMA, mcp };
}

/** Serialize the staged config exactly as both transports write it. */
export function serializeOpencodeSessionConfig(config: OpencodeSessionConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Write this session's config under the gateway's own home (local turns). */
export function writeOpencodeSessionConfig(
  resolvedMcp: ResolvedMcpConfig | undefined,
  sessionId: string,
): OpencodeConfigHandle {
  const config = buildOpencodeSessionConfig(resolvedMcp);
  if (!config) return { staged: false };

  const configDir = path.join(JINN_HOME, "tmp", "opencode", safeSessionId(sessionId));
  const configPath = path.join(configDir, "opencode.json");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, serializeOpencodeSessionConfig(config), { mode: 0o600 });
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return { staged: true, configPath, configDir };
}

export function cleanupOpencodeSessionConfig(handle: OpencodeConfigHandle | undefined): void {
  if (!handle || !handle.staged || handle.released) return;
  handle.released = true;
  try {
    fs.rmSync(handle.configDir, { recursive: true, force: true });
  } catch {
    /* best effort temp cleanup */
  }
}
