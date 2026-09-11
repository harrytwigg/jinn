import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough, Writable } from "node:stream";

/**
 * The Pi engine's remote branch.
 *
 * The guarantee is the same negative one the interactive engine's remote tests
 * hold, and it matters for the same reason: for a remote employee NOTHING runs
 * on the gateway. A local `pi` and a remote one are indistinguishable in the UI
 * — same events, same answer — so a regression here would quietly run a
 * desktop's model workload on a Raspberry Pi orchestrator, or (worse) read and
 * write a repository the operator deliberately never cloned there.
 *
 * The second guarantee is about the transport itself. Pi's protocol is a prompt
 * on stdin and newline-delimited JSON on stdout, and both halves have to survive
 * the ssh hop: hence the assertions on the absence of a remote tty and on what
 * the child's stdin actually receives.
 */

// Per session AND per engine: a substituted session must not restage the home
// the engine it was substituted FROM is still reading gateway.json out of.
const REMOTE_HOME = "/home/builder/.jinn-remote-stage/sessions/sess-1__pi";

const hoisted = vi.hoisted(() => ({
  spawns: [] as { bin: string; args: string[]; opts: Record<string, unknown> }[],
  /** Everything written to the spawned child's stdin — i.e. the prompt. */
  stdinWrites: [] as string[],
  prepareCalls: [] as Record<string, unknown>[],
  ensureCalls: [] as Record<string, unknown>[],
  /** Flipped by one case to prove an unready host never reaches spawn. */
  ready: true,
  /** Flipped by one case to drop the staged pi extension. */
  withExtension: true,
}));

// ── child_process ────────────────────────────────────────────────────────────
// The fake answers exactly what pi's parser consumes: one `agent_end` line with
// the final assistant text, then close. Nothing here mocks the parser itself.
vi.mock("node:child_process", () => ({
  spawn: vi.fn((bin: string, args: string[], opts: Record<string, unknown>) => {
    hoisted.spawns.push({ bin, args, opts });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({
      write(chunk, _enc, cb) { hoisted.stdinWrites.push(String(chunk)); cb(); },
    });
    const proc = {
      pid: 4242,
      exitCode: null as number | null,
      killed: false,
      stdout,
      stderr,
      stdin,
      kill: () => true,
      on(event: string, cb: (arg: number | Error) => void) {
        if (event === "close") {
          setTimeout(() => {
            stdout.write(JSON.stringify({
              type: "agent_end",
              messages: [{ role: "assistant", content: [{ type: "text", text: "done on the desktop" }] }],
            }) + "\n");
            stdout.end();
            proc.exitCode = 0;
            cb(0);
          }, 0);
        }
        return proc;
      },
    };
    return proc;
  }),
}));

// ── remote-stage ─────────────────────────────────────────────────────────────
// Only the two functions that would talk to a real host are replaced. The argv
// builder and its shell quoting stay REAL, so every assertion below is made
// against the command that would genuinely be sent.
vi.mock("../remote-stage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../remote-stage.js")>();
  return {
    ...actual,
    ensureRemoteReady: vi.fn(async (target: unknown, remote: unknown, opts: Record<string, unknown>) => {
      hoisted.ensureCalls.push({ target, remote, opts });
      if (!hoisted.ready) return { ready: false, reason: "build-box is not reachable" };
      return {
        ready: true,
        facts: {
          home: "/home/builder",
          stageDir: "/home/builder/.jinn-remote-stage",
          nodeBin: "/home/builder/.nvm/versions/node/v22.22.3/bin/node",
          piBin: "/home/builder/.nvm/versions/node/v22.22.3/bin/pi",
          jinnVersion: "0.32.0",
          entryDir: "/home/builder/.nvm/versions/node/v22.22.3/lib/node_modules/jinn-cli/dist/src/mcp",
        },
      };
    }),
    prepareRemoteSession: vi.fn(async (opts: Record<string, unknown>) => {
      hoisted.prepareCalls.push(opts);
      return {
        engine: "pi",
        destination: "builder@build-box",
        tunnelPort: 44321,
        sessionHome: REMOTE_HOME,
        envFilePath: `${REMOTE_HOME}/tmp/session-env.sh`,
        piSessionDir: `${REMOTE_HOME}/pi-session`,
        ...(hoisted.withExtension ? { piExtensionPath: `${REMOTE_HOME}/tmp/pi-mcp/jinn-mcp-extension.ts` } : {}),
      };
    }),
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PiEngine } from "../pi.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineRunOpts } from "../../shared/types.js";

const REMOTE_CONFIG = { root: "/srv/jinn-work", mount: "/mnt/jinn-home" };
const GATEWAY_PORT = 8722;

function engine(gatewayPort = GATEWAY_PORT): PiEngine {
  return new PiEngine({ remote: () => REMOTE_CONFIG, gatewayPort: () => gatewayPort });
}

function runOpts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return {
    prompt: "build it",
    cwd: JINN_HOME,
    sessionId: "sess-1",
    model: "ollama/gemma4:12b",
    remoteHost: "build-box",
    remoteUser: "builder",
    remoteCwd: "/srv/jinn-work/proj",
    ...over,
  };
}

/** The remote command is the last argv element of the ssh invocation. */
function remoteCommand(): string {
  return hoisted.spawns[0]!.args.at(-1)!;
}

beforeEach(() => {
  hoisted.spawns = [];
  hoisted.stdinWrites = [];
  hoisted.prepareCalls = [];
  hoisted.ensureCalls = [];
  hoisted.ready = true;
  hoisted.withExtension = true;
});

describe("PiEngine — a remote employee's turn runs on the other machine", () => {
  it("spawns ssh, never the gateway's own pi", async () => {
    const result = await engine().run(runOpts());

    expect(result.result).toBe("done on the desktop");
    expect(hoisted.spawns).toHaveLength(1);
    expect(hoisted.spawns[0]!.bin).toMatch(/(^|[\\/])ssh(\.exe)?$/);
    // The pi that runs is the REMOTE install's, found on that host's PATH —
    // the gateway's own `pi` (if it even has one) appears nowhere.
    expect(remoteCommand()).toContain("/home/builder/.nvm/versions/node/v22.22.3/bin/pi");
    expect(remoteCommand()).toContain("cd '/srv/jinn-work/proj'");
  });

  it("asks the host about pi's CLI, not Claude Code's", async () => {
    await engine().run(runOpts());
    expect(hoisted.ensureCalls[0]!.opts).toMatchObject({ engine: "pi", allowWake: false });
    expect(hoisted.prepareCalls[0]).toMatchObject({ engine: "pi", jinnSessionId: "sess-1" });
  });

  it("allocates no remote tty, so pi's JSON stdout is not interleaved with its stderr", async () => {
    // With `-tt` the remote process gets ONE stream: stderr lands in the middle
    // of the newline-delimited JSON this engine parses, and a run's real error
    // reads as an unparseable line and is dropped.
    await engine().run(runOpts());
    expect(hoisted.spawns[0]!.args).toContain("-T");
    expect(hoisted.spawns[0]!.args).not.toContain("-tt");
  });

  it("delivers the prompt over stdin rather than argv", async () => {
    // pi reads any dash-leading token as an option and has no `--` escape, so a
    // prompt on the command line is a turn that dies before the model sees it.
    await engine().run(runOpts({ prompt: "- check the build" }));
    expect(hoisted.stdinWrites.join("")).toBe("- check the build");
    expect(remoteCommand()).not.toContain("- check the build");
  });

  it("points --session-dir and --extension at the remote stage, not the gateway's home", async () => {
    await engine().run(runOpts());
    const cmd = remoteCommand();
    // Every argv token is shell-quoted individually by buildSshSpawnArgs.
    expect(cmd).toContain(`'--session-dir' '${REMOTE_HOME}/pi-session'`);
    expect(cmd).toContain(`'--extension' '${REMOTE_HOME}/tmp/pi-mcp/jinn-mcp-extension.ts'`);
    // Both of those live under JINN_HOME on the local path. A gateway path here
    // would name a directory that does not exist on the other machine — and pi
    // would start a fresh conversation every turn rather than resuming.
    expect(cmd).not.toContain(JINN_HOME);
  });

  it("runs without an extension when the session carries no jinn toolset", async () => {
    hoisted.withExtension = false;
    await engine().run(runOpts());
    expect(remoteCommand()).not.toContain("--extension");
  });

  it("carries the same session id across turns, so --resume continues the conversation", async () => {
    await engine().run(runOpts({ resumeSessionId: "sess-1" }));
    expect(remoteCommand()).toContain("'--session-id' 'sess-1'");
  });

  it("opens the reverse tunnel to the gateway's port, so the jinn toolset can answer", async () => {
    await engine().run(runOpts());
    const args = hoisted.spawns[0]!.args;
    expect(args[args.indexOf("-R") + 1]).toBe(`44321:127.0.0.1:${GATEWAY_PORT}`);
    // The session's own staged home, so the in-process jinn server reads this
    // session's gateway.json and not another's.
    expect(remoteCommand()).toContain(`JINN_HOME='${REMOTE_HOME}'`);
  });

  it("puts the gateway bearer in a sourced file, never on the remote command line", async () => {
    await engine().run(runOpts());
    // Every remote command line is readable in that host's process table.
    expect(remoteCommand()).toContain(`. '${REMOTE_HOME}/tmp/session-env.sh'`);
    expect(remoteCommand()).not.toContain("JINN_GATEWAY_TOKEN=");
  });

  it("keeps this session's capability off the command line too", async () => {
    // JINN_SESSION_CAPABILITY authorizes acting AS this session against the
    // gateway API, so it belongs in the same 0600 file as the bearer — the
    // remote Claude path carries its copy inside the staged mcp.json for the
    // same reason. Inlined into `remoteEnv` it would be readable by every
    // process on that host via ps.
    const resolvedMcp = {
      mcpServers: {
        jinn: {
          command: "/gateway/node",
          args: ["/gateway/dist/src/mcp/server-entry.js"],
          env: { JINN_SESSION_ID: "sess-1", JINN_SESSION_CAPABILITY: "cap-token-abc" },
        },
      },
    } as unknown as EngineRunOpts["resolvedMcp"];

    await engine().run(runOpts({ resolvedMcp }));

    expect(remoteCommand()).not.toContain("cap-token-abc");
    expect(remoteCommand()).not.toContain("JINN_SESSION_CAPABILITY");
    // …and staging is handed the set it needs to put it in the file instead.
    expect(hoisted.prepareCalls[0]!.resolvedMcp).toBe(resolvedMcp);
  });

  it("prepends the remote node directory, then the instance's own bin/", async () => {
    // `pi` is npm-installed, so its shebang resolves node through PATH — and a
    // non-interactive ssh on an nvm host has none. The instance bin/ follows so
    // the tools the operating instructions name bare — `mem` above all —
    // resolve for a pi session exactly as they do for a Claude one; it is this
    // session's OWN farm entry, so it carries the engine in its path.
    expect(hoisted.spawns.length).toBe(0);
    await engine().run(runOpts());
    expect(remoteCommand()).toContain(
      "PATH='/home/builder/.nvm/versions/node/v22.22.3/bin':"
      + `'${REMOTE_HOME}/bin':"$PATH"`,
    );
  });

  it("refuses attachments instead of naming gateway paths the model cannot open", async () => {
    const result = await engine().run(runOpts({ attachments: ["/home/pi/.jinn/tmp/spec.pdf"] }));

    expect(result.error).toContain("Attachments are not supported for remote employees");
    expect(hoisted.spawns).toHaveLength(0);
  });

  it("refuses to spawn when the host is not ready", async () => {
    hoisted.ready = false;
    await expect(engine().run(runOpts())).rejects.toThrow(/not reachable/);
    expect(hoisted.spawns).toHaveLength(0);
  });

  it("refuses to spawn with no gateway port, rather than tunnelling to nowhere", async () => {
    // `-R <n>:127.0.0.1:0` is a session whose every jinn tool call answers into
    // nothing while the turn runs on regardless.
    await expect(engine(0).run(runOpts())).rejects.toThrow(/reverse tunnel/);
    expect(hoisted.spawns).toHaveLength(0);
  });

  it("leaves a local employee entirely alone", async () => {
    const result = await engine().run({ prompt: "hi", cwd: JINN_HOME, sessionId: "local-1" });

    expect(result.result).toBe("done on the desktop");
    expect(hoisted.spawns[0]!.bin).not.toMatch(/ssh/);
    expect(hoisted.ensureCalls).toHaveLength(0);
  });
});
