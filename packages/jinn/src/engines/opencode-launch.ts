import type { EngineRunOpts } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { JINN_HOME } from "../shared/paths.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { assertRemoteTarget } from "../shared/remote-target.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { buildOpencodeArgs, buildOpencodePrompt, describeOpencodeLaunch } from "./opencode-protocol.js";
import {
  writeOpencodeSessionConfig,
  type OpencodeConfigHandle,
} from "./opencode-mcp.js";
import {
  buildSshSpawnArgs,
  ensureRemoteReady,
  prepareRemoteSession,
  remoteNodeDir,
  remoteSessionBinDir,
  requireRemoteEngineBin,
  type RemoteFacts,
  type RemoteOpencodeStaging,
} from "./remote-stage.js";

/**
 * Where one opencode turn runs, and what it is spawned with.
 *
 * The two transports are here side by side on purpose. They differ in exactly
 * three things — which binary is spawned, which argv reaches it, and which
 * machine's environment carries the session's identity — and having both plans
 * built in one file is what makes that comparable at a glance. Everything about
 * the turn ITSELF (the prompt, the opencode argv) comes from
 * `opencode-protocol.ts`, so neither transport can prompt differently from the
 * other.
 *
 * The engine takes a plan and runs it; it never asks which kind it got.
 */
export interface OpencodeLaunchPlan {
  bin: string;
  args: string[];
  /** The environment of the process the GATEWAY spawns. For a remote turn that
   *  is the local ssh client's, and everything the remote opencode needs is
   *  inlined into the remote command instead — `env` never crosses a connection. */
  env: Record<string, string>;
  cwd: string;
  prompt: string;
  /** The session to resume, until opencode's own stream names one. */
  sessionIdOut: string;
  /** The staged MCP config to delete when the turn settles, when there is one. */
  configHandle?: OpencodeConfigHandle;
}

/** Why a remote turn refuses attachments: the paths would be the GATEWAY's, and
 *  they name nothing on the other machine — the same call the Pi and interactive
 *  Claude engines make. */
export const REMOTE_ATTACHMENT_REFUSAL =
  "Attachments are not supported for remote employees — the file paths are local to the gateway";

/**
 * Variables the REMOTE login environment must not carry into `opencode`.
 *
 * Exactly what `buildEngineChildEnv` strips locally, and nothing more. The
 * provider keys an operator has in their remote shell profile are left alone on
 * purpose: opencode drives whatever provider they authenticated on that machine,
 * and for a key-authenticated provider an inherited key is how it works at all.
 * That is the same judgement the Pi engine makes, and the opposite of the Claude
 * engine's — Claude Code runs on subscription auth, where an inherited
 * `ANTHROPIC_API_KEY` would silently move the session onto metered billing.
 * opencode has no subscription to fall off.
 */
const REMOTE_ENV_DENY = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "JINN_HOME_IDENTITY", "JINN_TAKE_PORT"];

function cleanEnv(sessionId: string): Record<string, string> {
  const env = buildEngineChildEnv(process.env, { scrubClaudeCode: true, scrubCodex: true });
  env.JINN_SESSION_ID = sessionId;
  // A self-upgrade between two turns of one session would swap the binary under
  // a conversation opencode is still holding in its own store.
  env.OPENCODE_DISABLE_AUTOUPDATE = "1";
  return env;
}

/** A turn on the gateway's own machine. */
export function localOpencodeLaunch(opts: EngineRunOpts, trackingId: string): OpencodeLaunchPlan {
  const bin = resolveBin("opencode", opts.bin);
  const configHandle = writeOpencodeSessionConfig(opts.resolvedMcp, trackingId);

  logger.info(
    `opencode engine starting: ${bin} ${describeOpencodeLaunch(opts)} `
    + `(resume: ${opts.resumeSessionId || "none"}, jinn tools: ${configHandle.staged ? "on" : "off"})`,
  );

  return {
    bin,
    args: buildOpencodeArgs(opts),
    env: {
      ...cleanEnv(trackingId),
      ...(configHandle.staged ? { OPENCODE_CONFIG: configHandle.configPath } : {}),
    },
    cwd: opts.cwd,
    prompt: buildOpencodePrompt(opts),
    sessionIdOut: opts.resumeSessionId || "",
    configHandle,
  };
}

/** The argv for the `ssh` that carries this turn. Everything in it is
 *  load-bearing; see `buildSshSpawnArgs` for the flags themselves. */
function opencodeSshArgs(
  opts: EngineRunOpts,
  trackingId: string,
  gatewayPort: number,
  facts: RemoteFacts,
  staging: RemoteOpencodeStaging,
): string[] {
  return buildSshSpawnArgs({
    destination: staging.destination,
    tunnelPort: staging.tunnelPort,
    gatewayPort: gatewayPort,
    remoteCwd: opts.remoteCwd!,
    remoteEnv: {
      // Points the staged MCP servers at THIS session's home — its own symlink
      // farm over the mount, and its own gateway.json, which is where the
      // built-in jinn server resolves its bearer from.
      JINN_HOME: staging.sessionHome,
      JINN_SESSION_ID: trackingId,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      ...(staging.opencodeConfigPath ? { OPENCODE_CONFIG: staging.opencodeConfigPath } : {}),
    },
    // The bearer and the gateway URL, as a sourced 0600 file rather than argv:
    // a remote command line is readable by every process on that host.
    envFile: staging.envFilePath,
    unsetRemoteEnv: REMOTE_ENV_DENY,
    // The remote host's node, so an MCP server launched as bare `node` can run
    // at all on a version-manager host; then the instance's own bin/, so the
    // tools the operating instructions name bare resolve here exactly as they
    // do for a Claude or Pi session.
    pathPrepend: [remoteNodeDir(facts), remoteSessionBinDir(staging.sessionHome)],
    bin: requireRemoteEngineBin(staging.destination, facts, "opencode"),
    args: buildOpencodeArgs(opts),
    // No remote tty: opencode's stdout is a JSON stream the engine parses line
    // by line, and a tty would interleave the remote stderr into it.
    allocateTty: false,
  });
}

/**
 * A turn on another machine: the same `opencode run --format json` contract,
 * with an `ssh` client standing in for the local process.
 *
 * The substitution costs the parser nothing. opencode's protocol is a prompt on
 * stdin and newline-delimited JSON on stdout, and ssh carries both verbatim. The
 * one flag that matters is `allocateTty: false`: with a tty the remote stderr is
 * folded into that JSON stream.
 *
 * Nothing relocates opencode's own data directory. Its session store and its
 * `auth.json` live side by side under the REMOTE user's home, so a session dir
 * staged like pi's would take the login's directory with it and every turn would
 * start unauthenticated. opencode keys each session on an id it generates, so
 * concurrent sessions in that one store cannot collide anyway.
 */
export async function remoteOpencodeLaunch(
  opts: EngineRunOpts,
  trackingId: string,
  ctx: { remote: RemoteExecutionConfig | undefined; gatewayPort: number },
): Promise<OpencodeLaunchPlan> {
  assertRemoteTarget(opts, ctx.remote);
  // Without a real gateway port the reverse forward would be built as
  // `-R <n>:127.0.0.1:0`, and the jinn toolset would answer every call into
  // nothing while the turn ran on regardless.
  if (!ctx.gatewayPort) {
    throw new Error("remote spawn needs the gateway's port for the reverse tunnel, and none was provided");
  }
  const readiness = await ensureRemoteReady(opts, ctx.remote, { engine: "opencode", allowWake: false });
  if (!readiness.ready) throw new Error(`remote host not ready: ${readiness.reason}`);
  const facts = readiness.facts;

  const staging = await prepareRemoteSession({
    target: opts,
    remote: ctx.remote!,
    facts,
    engine: "opencode",
    jinnSessionId: trackingId,
    gatewayPort: ctx.gatewayPort,
    ...(opts.resolvedMcp ? { resolvedMcp: opts.resolvedMcp } : {}),
  });

  const args = opencodeSshArgs(opts, trackingId, ctx.gatewayPort, facts, staging);

  logger.info(
    `opencode engine starting REMOTE on ${staging.destination}:${opts.remoteCwd} — ${describeOpencodeLaunch(opts)} `
    + `(resume: ${opts.resumeSessionId || "none"}, tunnel: ${staging.tunnelPort}→${ctx.gatewayPort}, `
    + `jinn tools: ${staging.opencodeConfigPath ? "on" : "off"})`,
  );

  return {
    bin: resolveBin("ssh"),
    args,
    env: cleanEnv(trackingId),
    // The ssh client's own cwd, irrelevant to the session: the remote command
    // opens with a `cd` into remoteCwd.
    cwd: JINN_HOME,
    prompt: buildOpencodePrompt(opts),
    sessionIdOut: opts.resumeSessionId || "",
  };
}
