import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough, Writable } from "node:stream";

/**
 * The opencode engine's remote branch.
 *
 * The guarantee is the same negative one the Pi and interactive Claude remote
 * tests hold: for a remote employee NOTHING runs on the gateway. A local
 * opencode and a remote one are indistinguishable in the UI — same events, same
 * answer — so a regression here would quietly run the workload on the
 * orchestrator, against a repository that is not there.
 *
 * The second guarantee is about the transport. opencode's protocol is a prompt
 * on stdin and newline-delimited JSON on stdout, and both halves have to survive
 * the ssh hop — hence the assertions on the absence of a remote tty and on what
 * the child's stdin actually receives. The third is about the secret: this
 * session's capability travels in a 0600 file, and must not appear on a command
 * line that every process on that host can read.
 */

// Per session AND per engine: a substituted session must not restage the home
// the engine it was substituted FROM is still reading gateway.json out of.
const REMOTE_HOME = "/home/builder/.jinn-remote-stage/sessions/sess-1__opencode";
const REMOTE_BIN = "/home/builder/.local/bin/opencode";

const hoisted = vi.hoisted(() => ({
  spawns: [] as { bin: string; args: string[]; opts: Record<string, unknown> }[],
  stdinWrites: [] as string[],
  prepareCalls: [] as Record<string, unknown>[],
  ensureCalls: [] as Record<string, unknown>[],
  /** Flipped by one case to prove an unready host never reaches spawn. */
  ready: true,
  /** Flipped by one case to drop the staged opencode config. */
  withConfig: true,
}));

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
            stdout.write(`${JSON.stringify({
              type: "text",
              sessionID: "ses_remote1",
              part: { type: "text", text: "done on the desktop" },
            })}\n`);
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
          opencodeBin: REMOTE_BIN,
          jinnVersion: "0.32.0",
          entryDir: "/home/builder/.nvm/versions/node/v22.22.3/lib/node_modules/jinn-cli/dist/src/mcp",
        },
      };
    }),
    prepareRemoteSession: vi.fn(async (opts: Record<string, unknown>) => {
      hoisted.prepareCalls.push(opts);
      return {
        engine: "opencode",
        destination: "builder@build-box",
        tunnelPort: 44321,
        sessionHome: REMOTE_HOME,
        envFilePath: `${REMOTE_HOME}/tmp/session-env.sh`,
        ...(hoisted.withConfig ? { opencodeConfigPath: `${REMOTE_HOME}/tmp/opencode.json` } : {}),
      };
    }),
  };
});

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpencodeEngine } from "../opencode.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineRunOpts } from "../../shared/types.js";

const REMOTE_CONFIG = { root: "/srv/jinn-work", mount: "/mnt/jinn-home" };
const GATEWAY_PORT = 8722;

function engine(gatewayPort = GATEWAY_PORT): OpencodeEngine {
  return new OpencodeEngine({ remote: () => REMOTE_CONFIG, gatewayPort: () => gatewayPort });
}

function runOpts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return {
    prompt: "build it",
    cwd: JINN_HOME,
    sessionId: "sess-1",
    model: "anthropic/claude-sonnet-5",
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
  hoisted.withConfig = true;
});

describe("OpencodeEngine — a remote employee's turn runs on the other machine", () => {
  it("spawns ssh, never the gateway's own opencode", async () => {
    const result = await engine().run(runOpts());

    expect(result.result).toBe("done on the desktop");
    expect(hoisted.spawns).toHaveLength(1);
    expect(hoisted.spawns[0]!.bin).toMatch(/(^|[\\/])ssh(\.exe)?$/);
    // The opencode that runs is the REMOTE install's, found on that host's PATH.
    expect(remoteCommand()).toContain(REMOTE_BIN);
    expect(remoteCommand()).toContain("cd '/srv/jinn-work/proj'");
  });

  it("asks the host about opencode's CLI, not another engine's", async () => {
    await engine().run(runOpts());

    expect(hoisted.ensureCalls[0]!.opts).toMatchObject({ engine: "opencode", allowWake: false });
    expect(hoisted.prepareCalls[0]).toMatchObject({ engine: "opencode", jinnSessionId: "sess-1" });
  });

  it("allocates no remote tty, so the JSON stdout is not interleaved with stderr", async () => {
    // With `-tt` the remote process gets ONE stream: stderr lands in the middle
    // of the newline-delimited JSON this engine parses, and a run's real error
    // reads as an unparseable line and is dropped.
    await engine().run(runOpts());

    expect(hoisted.spawns[0]!.args).toContain("-T");
    expect(hoisted.spawns[0]!.args).not.toContain("-tt");
  });

  it("sends the prompt over stdin, so it never reaches that host's process table", async () => {
    await engine().run(runOpts({ prompt: "rewrite the secret handler" }));

    expect(hoisted.stdinWrites.join("")).toBe("rewrite the secret handler");
    expect(remoteCommand()).not.toContain("rewrite the secret handler");
  });

  it("runs the same argv a local turn would", async () => {
    await engine().run(runOpts({ resumeSessionId: "ses_earlier" }));

    const command = remoteCommand();
    expect(command).toContain("'run' '--format' 'json' '--dangerously-skip-permissions'");
    expect(command).toContain("'-m' 'anthropic/claude-sonnet-5'");
    expect(command).toContain("'-s' 'ses_earlier'");
  });

  it("points opencode at the staged config and this session's home", async () => {
    await engine().run(runOpts());

    const command = remoteCommand();
    expect(command).toContain(`OPENCODE_CONFIG='${REMOTE_HOME}/tmp/opencode.json'`);
    expect(command).toContain(`JINN_HOME='${REMOTE_HOME}'`);
    // A self-upgrade mid-session would swap the binary under a conversation
    // opencode is still holding in its own store on that host.
    expect(command).toContain("OPENCODE_DISABLE_AUTOUPDATE='1'");
  });

  it("sets no OPENCODE_CONFIG when the session staged none", async () => {
    // Nothing staged → opencode's own config on that host is left alone, rather
    // than pointed at a file that does not exist.
    hoisted.withConfig = false;

    await engine().run(runOpts());

    expect(remoteCommand()).not.toContain("OPENCODE_CONFIG");
  });

  it("sources the 0600 env file instead of putting secrets on the command line", async () => {
    await engine().run(runOpts());

    const command = remoteCommand();
    expect(command).toContain(`. '${REMOTE_HOME}/tmp/session-env.sh' &&`);
    // The bearer and the capability live in that file and in the staged config.
    // Everything on a remote command line is readable by every process on that
    // host, so neither may ever be inlined here.
    expect(command).not.toContain("JINN_GATEWAY_TOKEN");
    expect(command).not.toContain("JINN_SESSION_CAPABILITY");
  });

  it("leaves the operator's provider keys alone", async () => {
    // Deliberate, and the opposite of the Claude engine's rule: opencode drives
    // whichever provider the operator authenticated on that machine, and for a
    // key-authenticated provider an inherited key is how it works at all.
    // Claude Code strips them because it runs on subscription auth, where an
    // inherited key would silently move the session onto metered billing.
    await engine().run(runOpts());

    const command = remoteCommand();
    expect(command).not.toContain("'-u' 'ANTHROPIC_API_KEY'");
    expect(command).not.toContain("'-u' 'OPENAI_API_KEY'");
    // What IS stripped: the markers that tell a nested CLI it is inside another agent.
    expect(command).toContain("'-u' 'CLAUDECODE'");
  });

  it("puts the remote node and the instance bin on PATH", async () => {
    // An MCP server launched as bare `node` has none on a version-manager host,
    // and the tools the operating instructions name bare live in the farm.
    await engine().run(runOpts());

    const command = remoteCommand();
    expect(command).toContain("/home/builder/.nvm/versions/node/v22.22.3/bin");
    expect(command).toContain(`${REMOTE_HOME}/bin`);
  });

  it("forwards the reverse tunnel to the gateway's real port", async () => {
    await engine().run(runOpts());

    expect(hoisted.spawns[0]!.args).toContain("-R");
    expect(hoisted.spawns[0]!.args).toContain(`44321:127.0.0.1:${GATEWAY_PORT}`);
  });

  it("refuses to spawn without a gateway port", async () => {
    // The forward would be built as `-R n:127.0.0.1:0`, and every jinn tool call
    // would answer into nothing while the turn ran on regardless.
    await expect(engine(0).run(runOpts())).rejects.toThrow(/gateway's port/);
    expect(hoisted.spawns).toHaveLength(0);
  });

  it("never spawns for a host that is not ready", async () => {
    hoisted.ready = false;

    await expect(engine().run(runOpts())).rejects.toThrow(/build-box is not reachable/);
    expect(hoisted.spawns).toHaveLength(0);
  });

  it("refuses attachments rather than naming files the other machine does not have", async () => {
    const result = await engine().run(runOpts({ attachments: ["/srv/gateway/diagram.png"] }));

    expect(result.error).toMatch(/Attachments are not supported for remote employees/);
    expect(hoisted.spawns).toHaveLength(0);
  });
});
