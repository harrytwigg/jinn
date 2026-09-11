import fs from "node:fs";
import path from "node:path";
import type { McpServerStdioConfig, ResolvedMcpConfig } from "../shared/types.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

const JINN_BUILTIN_SERVER = "jinn";
const JINN_MCP_SERVER_MODULE_URL = new URL("../mcp/server.js", import.meta.url).href;
const JINN_PI_MCP_MODULE_URL = new URL("./pi-mcp.js", import.meta.url).href;

export type PiMcpExtensionHandle =
  | { attached: false }
  | { attached: true; extensionPath: string; extensionDir: string; released?: boolean };

export function projectPiTool(tool: { name: string; description: string; inputSchema: unknown }) {
  return { name: tool.name, label: `Jinn ${tool.name}`, description: tool.description, parameters: tool.inputSchema };
}

export function projectPiToolManifest(tools: Array<{ name: string; description: string; inputSchema: unknown }>) {
  return tools.map(projectPiTool);
}

function jinnServer(resolvedMcp: ResolvedMcpConfig | undefined): McpServerStdioConfig | null {
  const spec = resolvedMcp?.mcpServers?.[JINN_BUILTIN_SERVER] as (McpServerStdioConfig & { url?: unknown }) | undefined;
  if (spec && typeof spec.command === "string" && spec.command && spec.url === undefined) return spec;
  return null;
}

/**
 * Why pi could not wire a `jinn` server the resolver DID attach, or null when the
 * session was never meant to carry the belt. Pi registers the company tools from a
 * generated extension module that runs the built-in stdio server in-process, so a
 * `jinn` entry in any other shape is one pi has no way to run.
 */
function unattachableJinnReason(resolvedMcp: ResolvedMcpConfig | undefined): string | null {
  const spec = resolvedMcp?.mcpServers?.[JINN_BUILTIN_SERVER] as (McpServerStdioConfig & { url?: unknown }) | undefined;
  if (!spec || jinnServer(resolvedMcp)) return null;
  const shape = spec.url !== undefined ? "is URL-based" : "carries no command";
  return `the resolved "jinn" server ${shape}, and pi can only wire the built-in stdio server as a generated extension`;
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

export function piJinnSessionEnv(resolvedMcp: ResolvedMcpConfig | undefined): Record<string, string> {
  const spec = jinnServer(resolvedMcp);
  const sessionId = spec?.env?.JINN_SESSION_ID;
  const capability = spec?.env?.JINN_SESSION_CAPABILITY;
  const workflowAttempt = spec?.env?.JINN_WORKFLOW_ATTEMPT;
  return sessionId && capability ? {
    JINN_SESSION_ID: sessionId,
    JINN_SESSION_CAPABILITY: capability,
    ...(workflowAttempt === "1" ? { JINN_WORKFLOW_ATTEMPT: workflowAttempt } : {}),
  } : {};
}

/**
 * Whether this session's `jinn` server can be wired as a pi extension, warning
 * once when the resolver attached one that pi cannot run.
 *
 * Shared by the local and the remote path so the two can never disagree about
 * whether a session carries the belt — a remote session that quietly wrote no
 * extension while the local one did would be a capability difference nobody
 * could see in the UI.
 */
export function piJinnMcpAttachable(
  resolvedMcp: ResolvedMcpConfig | undefined,
  sessionId: string,
): boolean {
  if (jinnServer(resolvedMcp)) return true;
  // A belt the resolver attached but pi cannot wire has to be said out loud: the
  // turn still runs, the model just silently improvises around the missing tools.
  const reason = unattachableJinnReason(resolvedMcp);
  if (reason) logger.warn(`Pi engine is starting session ${sessionId} WITHOUT the jinn toolset: ${reason}`);
  return false;
}

export function writePiJinnMcpExtension(
  resolvedMcp: ResolvedMcpConfig | undefined,
  sessionId: string,
): PiMcpExtensionHandle {
  if (!piJinnMcpAttachable(resolvedMcp, sessionId)) return { attached: false };

  const extensionDir = path.join(JINN_HOME, "tmp", "pi-mcp", safeSessionId(sessionId));
  const extensionPath = path.join(extensionDir, "jinn-mcp-extension.ts");
  fs.mkdirSync(extensionDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    extensionPath,
    piExtensionSource(JINN_MCP_SERVER_MODULE_URL, JINN_PI_MCP_MODULE_URL),
    { mode: 0o600 },
  );
  try {
    fs.chmodSync(extensionPath, 0o600);
  } catch {
    /* best effort on platforms without chmod */
  }
  return { attached: true, extensionPath, extensionDir };
}

export function cleanupPiJinnMcpExtension(handle: PiMcpExtensionHandle | undefined): void {
  if (!handle || !handle.attached || handle.released) return;
  handle.released = true;
  try {
    fs.rmSync(handle.extensionDir, { recursive: true, force: true });
  } catch {
    /* best effort temp cleanup */
  }
}

/**
 * The remote counterpart of the two module URLs above.
 *
 * The extension runs INSIDE pi on the other machine, so both imports have to
 * name that host's own jinn-cli install — the gateway's `dist` is not on it, and
 * the mount deliberately carries the instance home rather than the package.
 * `entryDir` is `<install>/dist/src/mcp` (probed by the facts script from the
 * real path of that host's `jinn` bin), which is what makes both siblings
 * derivable from it. The version is pinned equal to the gateway's at spawn, so
 * these two modules are the same build the gateway is running.
 *
 * Pure, and POSIX by construction: the path being written is the remote host's.
 */
export function remotePiExtensionSource(entryDir: string): string {
  const posixFileUrl = (p: string) => `file://${p}`;
  return piExtensionSource(
    posixFileUrl(path.posix.join(entryDir, "server.js")),
    posixFileUrl(path.posix.join(entryDir, "..", "engines", "pi-mcp.js")),
  );
}

function piExtensionSource(serverModuleUrl: string, piMcpModuleUrl: string): string {
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildTools, notesEnabledFromConfig } from ${JSON.stringify(serverModuleUrl)};
import { projectPiTool } from ${JSON.stringify(piMcpModuleUrl)};

export default function jinnMcpExtension(pi: ExtensionAPI): void {
  for (const tool of buildTools({
    notesEnabled: notesEnabledFromConfig(),
    workflowAttempt: process.env.JINN_WORKFLOW_ATTEMPT === "1",
  })) {
    pi.registerTool({
      ...projectPiTool(tool),
      async execute(_toolCallId: string, params: Record<string, unknown> | undefined) {
        const result = await tool.handler(params ?? {}, {
          gatewayUrl: process.env.JINN_GATEWAY_URL ?? "http://127.0.0.1:7777",
          token: process.env.JINN_GATEWAY_TOKEN,
          callerSessionId: process.env.JINN_SESSION_ID,
          sessionCapability: process.env.JINN_SESSION_CAPABILITY,
        });
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }
}
`;
}
