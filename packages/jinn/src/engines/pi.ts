import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { JINN_HOME } from "../shared/paths.js";
import { buildEngineChildEnv } from "../shared/child-env.js";
import { cleanupPiJinnMcpExtension, piJinnSessionEnv, writePiJinnMcpExtension, type PiMcpExtensionHandle } from "./pi-mcp.js";
import { extractActivityReceiptId } from "../shared/activity-receipts.js";
import { assertRemoteTarget, isRemoteTarget } from "../shared/remote-target.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import {
  buildSshSpawnArgs,
  ensureRemoteReady,
  prepareRemoteSession,
  remoteNodeDir,
  remoteSessionBinDir,
  requireRemoteEngineBin,
} from "./remote-stage.js";

interface LiveProcess {
  proc: ChildProcess;
  rl: readline.Interface;
  terminationReason: string | null;
  resultText: string;
  turnError: string | null;
  stderr: string;
  settled: boolean;
  resolve: (res: EngineResult) => void;
  sessionIdOut: string;
  hardTimeout?: NodeJS.Timeout;
  agentEndExitTimer?: NodeJS.Timeout;
  mcpExtension?: PiMcpExtensionHandle;
}

const STDERR_MAX = 10 * 1024; // 10KB rolling window for error reporting
const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const AGENT_END_EXIT_GRACE_MS = 5000;

/** The prompt as pi will receive it on stdin: the system prompt on a first turn,
 *  and any attachment paths appended. Shared by both transports so a remote turn
 *  cannot drift into being prompted differently from a local one. */
function buildPiPrompt(opts: EngineRunOpts): string {
  let prompt = opts.prompt;
  if (opts.systemPrompt && !opts.resumeSessionId) {
    prompt = opts.systemPrompt + "\n\n---\n\n" + prompt;
  }
  if (opts.attachments?.length) {
    prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
  }
  return prompt;
}

/** Registry model ids are `provider/id`; split on the FIRST slash, since the
 *  provider-native id may itself contain slashes (e.g. "ollama/hf.co/org/m:Q4"). */
function splitProviderModel(rawModel: string): { provider?: string; model: string } {
  const slash = rawModel.indexOf("/");
  if (slash <= 0) return { model: rawModel };
  return { provider: rawModel.slice(0, slash), model: rawModel.slice(slash + 1) };
}

function piModel(opts: EngineRunOpts): { provider?: string; model: string } {
  return splitProviderModel(opts.model || "ollama/gemma4:12b");
}

/**
 * pi's argv, minus the prompt.
 *
 * The two paths differ only in which machine's paths `sessionDir` and
 * `extensionPath` name, which is why they are parameters rather than being
 * resolved in here: everything else about a remote turn — provider, model,
 * thinking level, the session id that makes `--resume` work — is identical to a
 * local one, and a second copy of this list is how that would stop being true.
 */
function buildPiArgs(
  opts: EngineRunOpts,
  paths: { piSessionId: string; sessionDir: string; extensionPath?: string },
): string[] {
  const { provider, model } = piModel(opts);
  const args: string[] = [];
  if (provider) args.push("--provider", provider);
  args.push("--model", model, "-p", "--mode", "json");
  // Effort → Pi thinking level. Only reasoning-capable models ever carry an
  // effort level (the registry exposes effortLevels for those models only), so
  // passing it through verbatim is safe — mirrors codex/claude.
  if (opts.effortLevel && opts.effortLevel !== "default") {
    args.push("--thinking", opts.effortLevel);
  }
  args.push("--session-id", paths.piSessionId, "--session-dir", paths.sessionDir);
  if (paths.extensionPath) args.push("--extension", paths.extensionPath);
  if (opts.cliFlags?.length) args.push(...opts.cliFlags);
  // The prompt goes over stdin, never argv: pi reads any dash-leading token as an
  // option ("Unknown option: -") and has no `--` separator to escape it, so a
  // prompt like "- " would kill the turn before the model saw it.
  return args;
}

/** The provider/model/thinking triple, for a log line. */
function describePiLaunch(opts: EngineRunOpts): string {
  const { provider, model } = piModel(opts);
  return `--provider ${provider ?? "(default)"} --model ${model}`
    + `${opts.effortLevel && opts.effortLevel !== "default" ? ` --thinking ${opts.effortLevel}` : ""}`;
}

/**
 * Pi coding agent (https://pi.dev) run headlessly against a local model.
 *
 * Invocation: `pi --provider <p> --model <id> -p --mode json [--thinking <lvl>] \
 *   --session-id <id> --session-dir <dir> "<prompt>"`.
 *
 * Pi emits one JSON event per stdout line and exits when the run ends. The final
 * assistant answer is the last `text` block of the last assistant message in the
 * terminating `agent_end` event — reasoning models (e.g. Gemma 4) also emit
 * `thinking` blocks, which we skip. Errors surface as an assistant message with
 * `stopReason === "error"` and an `errorMessage`; we propagate that as
 * EngineResult.error rather than swallowing it.
 *
 * Resume: Pi's session is keyed on the Jinn session id (`--session-id` + an
 * isolated `--session-dir`), so re-running with the same id continues the same
 * Pi conversation — no need to capture Pi's own session id.
 *
 * Provider/model: registry model ids are `provider/id` (e.g. "ollama/gemma4:12b").
 * The provider is whatever the user configured in their Pi `~/.pi/agent/models.json`
 * — the gateway never assumes Ollama or any specific backend.
 *
 * Remote: an employee carrying a `remoteHost` runs the same contract on another
 * machine, with an `ssh` client standing in for the local process — the model,
 * the providers and the repository are all that host's (see {@link runRemote}).
 * This and the interactive Claude engine are the two adapters that can do that,
 * which is what `REMOTE_ENGINE_NAMES` in shared/models.ts names.
 */
export class PiEngine implements InterruptibleEngine {
  name = "pi" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  /** Live readers rather than captured values: config.yaml hot-reloads, and a
   *  `remote` block edited while the daemon runs must take effect on the next
   *  turn rather than at the next restart. Mirrors the interactive engine. */
  private readRemoteConfig: () => RemoteExecutionConfig | undefined;
  private readGatewayPort: () => number;

  constructor(opts: { remote?: () => RemoteExecutionConfig | undefined; gatewayPort?: () => number } = {}) {
    this.readRemoteConfig = opts.remote ?? (() => undefined);
    this.readGatewayPort = opts.gatewayPort ?? (() => 0);
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    live.terminationReason = reason;
    logger.info(`Killing Pi process for session ${sessionId}`);

    try {
      live.rl.close();
    } catch {
      /* ignore */
    }

    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) {
        this.signalProcess(live.proc, "SIGKILL");
      }
    }, 2000);
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) {
      this.kill(sessionId, "Interrupted: gateway shutting down");
    }
  }

  /** Batch engine: no warm-PTY reuse, every live process is an in-flight turn.
   *  Nothing idle to recycle on org-reload — no-op. */
  killIdle(): void {
    /* no-op */
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  /**
   * Variables the REMOTE login environment must not carry into `pi`.
   *
   * Deliberately much shorter than the Claude engine's list, and the difference
   * is not an oversight. Claude Code runs on subscription auth, so an inherited
   * `ANTHROPIC_API_KEY` there would silently move the session onto metered
   * billing — the one thing the PTY architecture exists to prevent. Pi has no
   * subscription to fall off: it drives whatever provider the operator
   * configured on that host, and for an `anthropic` provider an inherited key
   * is how it works at all. Stripping it would break a working setup to protect
   * a property Pi never had. What is stripped is exactly what
   * `buildCleanEnv` strips locally: the markers that tell a nested CLI it is
   * running inside another agent.
   */
  private static readonly REMOTE_ENV_DENY = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "JINN_HOME_IDENTITY", "JINN_TAKE_PORT"];

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const trackingId = opts.sessionId || `pi-${Date.now()}`;
    // A Pi session id keyed on the Jinn session → resuming reuses the same id and
    // continues the same Pi conversation.
    const piSessionId = opts.resumeSessionId || trackingId;

    if (isRemoteTarget(opts)) return await this.runRemote(opts, trackingId, piSessionId);

    const prompt = buildPiPrompt(opts);
    const bin = resolveBin("pi", opts.bin);

    // Isolate each session's Pi state so resumes are deterministic and concurrent
    // sessions never clobber each other.
    const sessionDir = path.join(JINN_HOME, "sessions", trackingId, "pi-session");
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
    } catch (err) {
      logger.error(`PiEngine failed to create session dir ${sessionDir}: ${err instanceof Error ? err.message : err}`);
    }

    const mcpExtension = writePiJinnMcpExtension(opts.resolvedMcp, trackingId);
    const args = buildPiArgs(opts, {
      piSessionId,
      sessionDir,
      ...(mcpExtension.attached ? { extensionPath: mcpExtension.extensionPath } : {}),
    });

    logger.info(`Pi engine starting: ${bin} ${describePiLaunch(opts)} (resume: ${opts.resumeSessionId || "none"})`);

    const cleanEnv = { ...this.buildCleanEnv(trackingId), ...piJinnSessionEnv(opts.resolvedMcp) };

    return await this.launch({
      trackingId,
      sessionIdOut: piSessionId,
      bin,
      args,
      env: cleanEnv,
      cwd: opts.cwd,
      prompt,
      mcpExtension,
      onStream: opts.onStream || null,
    });
  }

  /**
   * Run the turn on another machine: the same `pi -p --mode json` contract, with
   * an `ssh` client standing in for the local process.
   *
   * What the substitution costs is nothing the parser can see. Pi's protocol is
   * a prompt on stdin and newline-delimited JSON on stdout, and ssh carries both
   * verbatim — which is exactly why the transport is worth reusing here rather
   * than degrading a remote Pi employee into something less than a local one.
   * The one flag that matters is `allocateTty: false`: with a tty the remote
   * stderr would be folded into that JSON stream.
   *
   * The gateway-side process this engine owns, kills and times out is the local
   * ssh client. When it dies the channel closes and sshd hangs up the remote
   * command, so `kill()` still ends the turn on the other host.
   */
  private async runRemote(opts: EngineRunOpts, trackingId: string, piSessionId: string): Promise<EngineResult> {
    if (opts.attachments?.length) {
      // The paths buildPiPrompt would append are the GATEWAY's, and they name
      // nothing on the other machine. A turn that silently references files the
      // model cannot open is worse than one that refuses — same call the
      // interactive engine makes for a remote Claude session.
      return {
        sessionId: piSessionId,
        result: "",
        error: "Attachments are not supported for remote employees — the file paths are local to the gateway",
      };
    }

    const remote = this.readRemoteConfig();
    assertRemoteTarget(opts, remote);
    // Without a real gateway port the reverse forward would be built as
    // `-R <n>:127.0.0.1:0`, and the jinn toolset would answer every call into
    // nothing while the turn ran on regardless.
    if (!this.readGatewayPort()) {
      throw new Error("remote spawn needs the gateway's port for the reverse tunnel, and none was provided");
    }
    const readiness = await ensureRemoteReady(opts, remote, { engine: "pi", allowWake: false });
    if (!readiness.ready) throw new Error(`remote host not ready: ${readiness.reason}`);
    const facts = readiness.facts;

    const staging = await prepareRemoteSession({
      target: opts,
      remote: remote!,
      facts,
      engine: "pi",
      jinnSessionId: trackingId,
      gatewayPort: this.readGatewayPort(),
      ...(opts.resolvedMcp ? { resolvedMcp: opts.resolvedMcp } : {}),
    });

    const args = buildPiArgs(opts, {
      piSessionId,
      sessionDir: staging.piSessionDir,
      ...(staging.piExtensionPath ? { extensionPath: staging.piExtensionPath } : {}),
    });

    const sshArgs = buildSshSpawnArgs({
      destination: staging.destination,
      tunnelPort: staging.tunnelPort,
      gatewayPort: this.readGatewayPort(),
      remoteCwd: opts.remoteCwd!,
      remoteEnv: {
        // Points the extension's in-process jinn server at THIS session's staged
        // home — its own symlink farm over the mount, and its own gateway.json.
        JINN_HOME: staging.sessionHome,
        JINN_SESSION_ID: trackingId,
      },
      // The bearer, the gateway URL and this session's CAPABILITY, as a sourced
      // 0600 file rather than argv: a remote command line is readable by every
      // process on that host, and the capability authorizes acting as this
      // session. Staged by prepareRemoteSession, which reads the same
      // piJinnSessionEnv the local path passes straight into the child.
      envFile: staging.envFilePath,
      unsetRemoteEnv: PiEngine.REMOTE_ENV_DENY,
      // `pi` is an npm-installed CLI, so its shebang resolves `node` through
      // PATH — and a non-interactive ssh on a version-manager host has none.
      // Without this the spawn dies with `env: node: No such file or directory`
      // before pi prints a single line.
      // Then the instance's own bin/, so the tools the operating instructions
      // name bare — `mem` above all — resolve for a pi session exactly as they
      // do for a Claude one.
      pathPrepend: [remoteNodeDir(facts), remoteSessionBinDir(staging.sessionHome)],
      bin: requireRemoteEngineBin(staging.destination, facts, "pi"),
      args,
      // No remote tty: pi's stdout is a JSON stream the engine parses line by
      // line, and a tty would interleave the remote stderr into it.
      allocateTty: false,
    });

    logger.info(
      `Pi engine starting REMOTE on ${staging.destination}:${opts.remoteCwd} — ${describePiLaunch(opts)} `
      + `(resume: ${opts.resumeSessionId || "none"}, tunnel: ${staging.tunnelPort}→${this.readGatewayPort()}, `
      + `jinn tools: ${staging.piExtensionPath ? "on" : "off"})`,
    );

    return await this.launch({
      trackingId,
      sessionIdOut: piSessionId,
      bin: resolveBin("ssh"),
      args: sshArgs,
      // The environment of the LOCAL ssh client. Everything the remote pi needs
      // is inlined into the remote command instead — `env` never crosses a
      // connection.
      env: this.buildCleanEnv(trackingId),
      // The ssh client's own cwd, irrelevant to the session: the remote command
      // opens with a `cd` into remoteCwd.
      cwd: JINN_HOME,
      prompt: buildPiPrompt(opts),
      onStream: opts.onStream || null,
    });
  }

  /** Spawn one pi run — local or over ssh — and resolve when it settles.
   *  Everything below this line is transport-agnostic: it reads the same JSON
   *  event stream either way. */
  private launch(params: {
    trackingId: string;
    sessionIdOut: string;
    bin: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
    prompt: string;
    mcpExtension?: PiMcpExtensionHandle;
    onStream: ((delta: StreamDelta) => void) | null;
  }): Promise<EngineResult> {
    const { trackingId, bin, args, prompt, onStream } = params;
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: params.cwd,
        env: params.env,
        stdio: ["pipe", "pipe", "pipe"],
        // Own the whole group so a kill reaches every child. For a remote run
        // the group is the local ssh client's; sshd hangs up the remote command
        // when its channel closes.
        detached: process.platform !== "win32",
      });

      if (proc.stdin) {
        // A prompt written to a pi that has already died raises EPIPE here; the
        // close handler below reports the real failure, so surface it and move on.
        proc.stdin.on("error", (err: Error) => {
          logger.warn(`Pi engine could not write the prompt to stdin for session ${trackingId}: ${err.message}`);
        });
        proc.stdin.write(prompt);
        proc.stdin.end();
      } else {
        logger.error(`Pi engine spawned without a stdin pipe for session ${trackingId}; the prompt cannot be delivered`);
      }

      const rl = readline.createInterface({ input: proc.stdout, terminal: false });

      const live: LiveProcess = {
        proc,
        rl,
        terminationReason: null,
        resultText: "",
        turnError: null,
        stderr: "",
        settled: false,
        resolve,
        sessionIdOut: params.sessionIdOut,
        ...(params.mcpExtension ? { mcpExtension: params.mcpExtension } : {}),
      };
      this.liveProcesses.set(trackingId, live);
      live.hardTimeout = setTimeout(() => {
        const l = this.liveProcesses.get(trackingId);
        if (!l || l.settled) return;
        l.terminationReason = "Pi turn timed out";
        logger.warn(`Pi turn timed out for session ${trackingId}; terminating process`);
        this.signalProcess(l.proc, "SIGTERM");
        setTimeout(() => {
          if (l.proc.exitCode === null) this.signalProcess(l.proc, "SIGKILL");
        }, 2000).unref?.();
      }, TURN_TIMEOUT_MS);
      live.hardTimeout.unref?.();

      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          logger.debug(`[pi stream] unparseable line: ${trimmed.slice(0, 100)}`);
          return;
        }
        if (!parsed || typeof parsed !== "object") return;

        switch (parsed.type) {
          case "message_update": {
            // Best-effort live delta for the UI; the authoritative answer comes
            // from agent_end below.
            const delta = this.extractDelta(parsed);
            if (delta && onStream) onStream({ type: "text", content: delta });
            break;
          }
          case "tool_execution_start": {
            if (onStream) {
              onStream({
                type: "tool_use",
                content: this.describeTool(parsed),
                toolName: typeof parsed.toolName === "string" ? parsed.toolName : undefined,
                toolId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
              });
            }
            break;
          }
          case "tool_execution_end": {
            if (onStream) {
              const result = parsed.result && typeof parsed.result === "object" && !Array.isArray(parsed.result)
                ? parsed.result as Record<string, unknown>
                : undefined;
              const text = this.toolResultText(parsed);
              const activityReceiptId = extractActivityReceiptId(text, {
                isError: parsed.isError === true || result?.isError === true || result?.is_error === true,
              });
              onStream({
                type: "tool_result",
                content: text,
                toolName: typeof parsed.toolName === "string" ? parsed.toolName : undefined,
                toolId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : undefined,
                ...(activityReceiptId ? { activityReceiptId } : {}),
              });
            }
            break;
          }
          case "auto_retry_start": {
            logger.debug(
              `[pi] auto-retry ${parsed.attempt}/${parsed.maxAttempts}: ${String(parsed.errorMessage ?? "").slice(0, 200)}`,
            );
            break;
          }
          case "agent_end": {
            const { text, error } = this.extractFromMessages(parsed.messages);
            if (text) live.resultText = text;
            if (error) live.turnError = error;
            if (live.agentEndExitTimer) clearTimeout(live.agentEndExitTimer);
            live.agentEndExitTimer = setTimeout(() => {
              const l = this.liveProcesses.get(trackingId);
              if (!l || l.settled || l.proc.exitCode !== null) return;
              logger.warn(`Pi emitted agent_end for session ${trackingId} but did not exit; terminating process`);
              this.signalProcess(l.proc, "SIGTERM");
              setTimeout(() => {
                if (l.proc.exitCode === null) this.signalProcess(l.proc, "SIGKILL");
              }, 2000).unref?.();
            }, AGENT_END_EXIT_GRACE_MS);
            live.agentEndExitTimer.unref?.();
            break;
          }
        }
      });

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        live.stderr = (live.stderr + chunk).slice(-STDERR_MAX);
        for (const l of chunk.trim().split("\n").filter(Boolean)) logger.debug(`[pi stderr] ${l}`);
      });

      proc.on("close", (code) => this.settle(trackingId, code));

      proc.on("error", (err) => {
        const l = this.liveProcesses.get(trackingId);
        if (!l || l.settled) return;
        l.settled = true;
        this.clearTimers(l);
        cleanupPiJinnMcpExtension(l.mcpExtension);
        this.liveProcesses.delete(trackingId);
        reject(new Error(`Failed to spawn Pi agent CLI: ${err.message}`));
      });
    });
  }

  /** Resolve a live run exactly once, mirroring Codex's close semantics. */
  private settle(trackingId: string, code: number | null): void {
    const live = this.liveProcesses.get(trackingId);
    if (!live || live.settled) return;
    live.settled = true;
    this.clearTimers(live);
    cleanupPiJinnMcpExtension(live.mcpExtension);

    try {
      live.rl.close();
    } catch {
      /* ignore */
    }
    // `close` should mean the child is gone, but keep this defensive guard for
    // abnormal streams/errors where settle() is called before exit accounting lands.
    if (live.proc.exitCode === null) {
      try {
        live.proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.liveProcesses.delete(trackingId);

    const result = live.resultText;

    if (live.terminationReason) {
      live.resolve({ sessionId: live.sessionIdOut, result: "", error: live.terminationReason });
      return;
    }
    // A non-empty answer means the turn succeeded even if a benign error item
    // also appeared — don't surface it as a failure.
    if (result.trim()) {
      live.resolve({
        sessionId: live.sessionIdOut,
        result,
        error: undefined,
      });
      return;
    }

    const errMsg = live.turnError
      || (code === 0
        ? "Pi process exited successfully without a final assistant response"
        : `Pi process exited with code ${code}: ${live.stderr.slice(0, 500)}`);
    logger.error(errMsg);
    live.resolve({ sessionId: live.sessionIdOut, result, error: errMsg });
  }

  private clearTimers(live: LiveProcess): void {
    if (live.hardTimeout) clearTimeout(live.hardTimeout);
    if (live.agentEndExitTimer) clearTimeout(live.agentEndExitTimer);
    live.hardTimeout = undefined;
    live.agentEndExitTimer = undefined;
  }

  /**
   * Extract the final assistant answer + any error from an `agent_end` messages[]
   * array. The answer is the last non-empty `text` content block across assistant
   * messages (reasoning `thinking` blocks are ignored).
   */
  private extractFromMessages(messages: unknown): { text: string; error: string | null } {
    let text = "";
    let error: string | null = null;
    if (!Array.isArray(messages)) return { text, error };

    for (const m of messages) {
      if (!m || typeof m !== "object") continue;
      const msg = m as Record<string, unknown>;
      if (msg.role !== "assistant") continue;

      if (msg.stopReason === "error" && typeof msg.errorMessage === "string") {
        error = msg.errorMessage;
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
            const t = (block as Record<string, unknown>).text;
            if (typeof t === "string" && t) text = t; // last non-empty text block wins
          }
        }
      }
    }
    return { text, error };
  }

  /** Pull a streaming text delta out of a json-mode message_update (tolerant of shape). */
  private extractDelta(parsed: Record<string, unknown>): string {
    const d = parsed.delta;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && typeof (d as Record<string, unknown>).text === "string") {
      return (d as Record<string, unknown>).text as string;
    }
    const ev = parsed.event;
    if (ev && typeof ev === "object" && typeof (ev as Record<string, unknown>).delta === "string") {
      return (ev as Record<string, unknown>).delta as string;
    }
    return "";
  }

  /** Human-readable summary of a tool_execution_start event for live streaming. */
  private describeTool(parsed: Record<string, unknown>): string {
    const name = typeof parsed.toolName === "string" ? parsed.toolName : "tool";
    const args = parsed.args;
    if (args && typeof args === "object") {
      const a = args as Record<string, unknown>;
      const detail = a.command ?? a.path ?? a.file_path;
      if (typeof detail === "string") return `${name}: ${detail}`;
    }
    return `Running ${name}`;
  }

  /** Extract a short text summary from a tool_execution_end result payload. */
  private toolResultText(parsed: Record<string, unknown>): string {
    const r = parsed.result;
    if (r && typeof r === "object" && Array.isArray((r as Record<string, unknown>).content)) {
      const content = (r as Record<string, unknown>).content as unknown[];
      const t = content.find((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text");
      if (t && typeof (t as Record<string, unknown>).text === "string") {
        return ((t as Record<string, unknown>).text as string).slice(0, 500);
      }
    }
    return "";
  }

  private buildCleanEnv(sessionId?: string): Record<string, string> {
    const cleanEnv = buildEngineChildEnv(process.env, { scrubClaudeCode: true, scrubCodex: true });
    if (sessionId) cleanEnv.JINN_SESSION_ID = sessionId;
    return cleanEnv;
  }

  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid) {
        process.kill(-proc.pid, signal);
      } else {
        proc.kill(signal);
      }
    } catch (err) {
      logger.debug(`Failed to send ${signal} to Pi process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
