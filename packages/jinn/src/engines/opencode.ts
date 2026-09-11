import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { isRemoteTarget } from "../shared/remote-target.js";
import type { RemoteExecutionConfig } from "../shared/config-types.js";
import { cleanupOpencodeSessionConfig, type OpencodeConfigHandle } from "./opencode-mcp.js";
import { OpencodeTurn } from "./opencode-turn.js";
import {
  localOpencodeLaunch,
  remoteOpencodeLaunch,
  REMOTE_ATTACHMENT_REFUSAL,
  type OpencodeLaunchPlan,
} from "./opencode-launch.js";

interface LiveProcess {
  proc: ChildProcess;
  rl: readline.Interface;
  terminationReason: string | null;
  stderr: string;
  settled: boolean;
  resolve: (res: EngineResult) => void;
  /** What the event stream has said so far. Everything about what the turn
   *  MEANS lives there; this interface is only the process around it. */
  turn: OpencodeTurn;
  hardTimeout?: NodeJS.Timeout;
  configHandle?: OpencodeConfigHandle;
}

const STDERR_MAX = 10 * 1024; // 10KB rolling window for error reporting
const TURN_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The opencode CLI (https://opencode.ai) run headlessly.
 *
 * Invocation: `opencode run --format json --dangerously-skip-permissions \
 *   [-m provider/model] [-s <session>]`, with the prompt on stdin.
 *
 * This class owns exactly one thing: the PROCESS — spawning it, writing the
 * prompt to it, killing it, timing it out, and settling the turn exactly once.
 * What the turn MEANS lives in `opencode-turn.ts`, what it is spawned WITH lives
 * in `opencode-launch.ts`, and opencode's own wire contract in
 * `opencode-protocol.ts`. So a local turn and one carried over ssh reach this
 * file as the same thing and are run the same way.
 *
 * Resume: opencode assigns the session id (`ses_…`), reports it on every event
 * and continues it with `-s`. So unlike pi — whose session id is ours — the id
 * has to be captured from the stream and handed back as `EngineResult.sessionId`,
 * which is the same contract codex already uses.
 *
 * Remote: an employee carrying a `remoteHost` runs the same contract on another
 * machine, with an `ssh` client standing in for the local process.
 * `REMOTE_ENGINE_NAMES` in shared/models.ts names the adapters that can do that.
 */
export class OpencodeEngine implements InterruptibleEngine {
  name = "opencode" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  /** Live readers rather than captured values: config.yaml hot-reloads, and a
   *  `remote` block edited while the daemon runs must take effect on the next
   *  turn rather than at the next restart. Mirrors the other engines. */
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
    logger.info(`Killing opencode process for session ${sessionId}`);

    try {
      live.rl.close();
    } catch {
      /* ignore */
    }

    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) this.signalProcess(live.proc, "SIGKILL");
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

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const trackingId = opts.sessionId || `opencode-${Date.now()}`;
    const onStream = opts.onStream || null;

    if (!isRemoteTarget(opts)) {
      return await this.launch(localOpencodeLaunch(opts, trackingId), trackingId, onStream);
    }
    if (opts.attachments?.length) {
      return { sessionId: opts.resumeSessionId || "", result: "", error: REMOTE_ATTACHMENT_REFUSAL };
    }
    const plan = await remoteOpencodeLaunch(opts, trackingId, {
      remote: this.readRemoteConfig(),
      gatewayPort: this.readGatewayPort(),
    });
    return await this.launch(plan, trackingId, onStream);
  }

  /** Spawn one opencode run — local or over ssh — and resolve when it settles.
   *  Everything below this line is transport-agnostic: it reads the same JSON
   *  event stream either way. */
  private launch(
    plan: OpencodeLaunchPlan,
    trackingId: string,
    onStream: ((delta: StreamDelta) => void) | null,
  ): Promise<EngineResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(plan.bin, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ["pipe", "pipe", "pipe"],
        // Own the whole group so a kill reaches every child. For a remote run
        // the group is the local ssh client's; sshd hangs up the remote command
        // when its channel closes.
        detached: process.platform !== "win32",
      });

      this.writePrompt(proc, trackingId, plan.prompt);
      const live = this.track(proc, plan, trackingId, resolve);
      this.attachStreams(proc, live, trackingId, onStream, reject);
    });
  }

  /** Register the run so `kill`, `isAlive` and the timeout can reach it. */
  private track(
    proc: ChildProcess,
    plan: OpencodeLaunchPlan,
    trackingId: string,
    resolve: (res: EngineResult) => void,
  ): LiveProcess {
    const live: LiveProcess = {
      proc,
      rl: readline.createInterface({ input: proc.stdout!, terminal: false }),
      terminationReason: null,
      stderr: "",
      settled: false,
      resolve,
      turn: new OpencodeTurn(plan.sessionIdOut),
      ...(plan.configHandle ? { configHandle: plan.configHandle } : {}),
    };
    this.liveProcesses.set(trackingId, live);
    this.armTurnTimeout(trackingId, live);
    return live;
  }

  private attachStreams(
    proc: ChildProcess,
    live: LiveProcess,
    trackingId: string,
    onStream: ((delta: StreamDelta) => void) | null,
    reject: (err: Error) => void,
  ): void {
    live.rl.on("line", (line) => live.turn.readLine(line, onStream));

    proc.stderr?.on("data", (d: Buffer) => {
      const chunk = d.toString();
      live.stderr = (live.stderr + chunk).slice(-STDERR_MAX);
      for (const l of chunk.trim().split("\n").filter(Boolean)) logger.debug(`[opencode stderr] ${l}`);
    });

    proc.on("close", (code) => this.settle(trackingId, code));

    proc.on("error", (err) => {
      const l = this.liveProcesses.get(trackingId);
      if (!l || l.settled) return;
      l.settled = true;
      this.clearTimers(l);
      cleanupOpencodeSessionConfig(l.configHandle);
      this.liveProcesses.delete(trackingId);
      reject(new Error(`Failed to spawn opencode CLI: ${err.message}`));
    });
  }

  private writePrompt(proc: ChildProcess, trackingId: string, prompt: string): void {
    if (!proc.stdin) {
      logger.error(`opencode engine spawned without a stdin pipe for session ${trackingId}; the prompt cannot be delivered`);
      return;
    }
    // A prompt written to an opencode that has already died raises EPIPE here;
    // the close handler reports the real failure, so surface it and move on.
    proc.stdin.on("error", (err: Error) => {
      logger.warn(`opencode engine could not write the prompt to stdin for session ${trackingId}: ${err.message}`);
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  }

  private armTurnTimeout(trackingId: string, live: LiveProcess): void {
    live.hardTimeout = setTimeout(() => {
      const l = this.liveProcesses.get(trackingId);
      if (!l || l.settled) return;
      l.terminationReason = "opencode turn timed out";
      logger.warn(`opencode turn timed out for session ${trackingId}; terminating process`);
      this.signalProcess(l.proc, "SIGTERM");
      setTimeout(() => {
        if (l.proc.exitCode === null) this.signalProcess(l.proc, "SIGKILL");
      }, 2000).unref?.();
    }, TURN_TIMEOUT_MS);
    live.hardTimeout.unref?.();
  }

  /** Resolve a live run exactly once, mirroring the other batch engines. */
  private settle(trackingId: string, code: number | null): void {
    const live = this.liveProcesses.get(trackingId);
    if (!live || live.settled) return;
    live.settled = true;
    this.clearTimers(live);
    cleanupOpencodeSessionConfig(live.configHandle);

    try {
      live.rl.close();
    } catch {
      /* ignore */
    }
    // `close` should mean the child is gone, but keep this defensive guard for
    // abnormal streams where settle() runs before exit accounting lands.
    if (live.proc.exitCode === null) {
      try {
        live.proc.kill();
      } catch {
        /* ignore */
      }
    }
    this.liveProcesses.delete(trackingId);
    const result = live.turn.result({ code, terminationReason: live.terminationReason, stderr: live.stderr });
    if (result.error) logger.error(result.error);
    live.resolve(result);
  }

  private clearTimers(live: LiveProcess): void {
    if (live.hardTimeout) clearTimeout(live.hardTimeout);
    live.hardTimeout = undefined;
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
      logger.debug(`Failed to send ${signal} to opencode process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
