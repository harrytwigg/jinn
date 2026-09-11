import { describe, it, expect, vi, beforeEach } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { isDeadSessionError, detectRateLimit } from "../../shared/rateLimit.js";

/**
 * What the opencode engine makes of opencode's own JSON event stream.
 *
 * The fixtures are real output from opencode 1.16.2 — a plain answer, a turn
 * that called a tool, and a failure — because the two things most likely to go
 * wrong here are invisible in a passing turn. A turn is several STEPS, so
 * `step_finish` arrives more than once and its accounting is per step; and a
 * failure arrives as a JSON `error` event on STDOUT rather than on stderr, so
 * an engine that only reads exit codes and stderr reports a turn that produced
 * nothing, with no reason attached.
 */

const hoisted = vi.hoisted(() => ({
  spawns: [] as { bin: string; args: string[]; opts: Record<string, unknown> }[],
  stdinWrites: [] as string[],
  /** The lines the fake opencode prints, and the code it exits with. */
  lines: [] as unknown[],
  exitCode: 0,
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
      pid: 5151,
      exitCode: null as number | null,
      killed: false,
      stdout,
      stderr,
      stdin,
      kill: () => true,
      on(event: string, cb: (arg: number | Error) => void) {
        if (event === "close") {
          setTimeout(() => {
            for (const line of hoisted.lines) stdout.write(`${JSON.stringify(line)}\n`);
            stdout.end();
            proc.exitCode = hoisted.exitCode;
            cb(hoisted.exitCode);
          }, 0);
        }
        return proc;
      },
    };
    return proc;
  }),
}));

vi.mock("../../shared/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { OpencodeEngine } from "../opencode.js";
import { JINN_HOME } from "../../shared/paths.js";
import type { EngineRunOpts, StreamDelta } from "../../shared/types.js";

const SESSION = "ses_f6ffebbfeffeHN9Se05FZ1BGHV";

function step(tokens: Record<string, unknown>, cost: number, reason = "stop") {
  return { type: "step_finish", sessionID: SESSION, part: { type: "step-finish", reason, tokens, cost } };
}

function text(value: string) {
  return { type: "text", sessionID: SESSION, part: { type: "text", text: value } };
}

function runOpts(over: Partial<EngineRunOpts> = {}): EngineRunOpts {
  return { prompt: "build it", cwd: JINN_HOME, sessionId: "sess-1", model: "opencode/big-pickle", ...over };
}

beforeEach(() => {
  hoisted.spawns = [];
  hoisted.stdinWrites = [];
  hoisted.exitCode = 0;
  hoisted.lines = [
    { type: "step_start", sessionID: SESSION, part: { type: "step-start" } },
    text("pong"),
    step({ total: 9141, input: 9126, output: 15, reasoning: 0, cache: { write: 0, read: 0 } }, 0),
  ];
});

describe("OpencodeEngine — reading opencode's event stream", () => {
  it("answers with the last text part and the session opencode assigned", async () => {
    const result = await new OpencodeEngine().run(runOpts());

    expect(result.result).toBe("pong");
    expect(result.error).toBeUndefined();
    // opencode names the session, not jinn. Losing this id means the next turn
    // silently starts a new conversation with no memory of this one.
    expect(result.sessionId).toBe(SESSION);
  });

  it("sends the prompt on stdin and keeps it off argv", async () => {
    await new OpencodeEngine().run(runOpts({ prompt: "--not-a-flag" }));

    expect(hoisted.stdinWrites.join("")).toBe("--not-a-flag");
    expect(hoisted.spawns[0]!.args).not.toContain("--not-a-flag");
  });

  it("prepends the system prompt on a first turn only", async () => {
    await new OpencodeEngine().run(runOpts({ systemPrompt: "You are Ada." }));
    expect(hoisted.stdinWrites.join("")).toBe("You are Ada.\n\n---\n\nbuild it");

    hoisted.stdinWrites = [];
    await new OpencodeEngine().run(runOpts({ systemPrompt: "You are Ada.", resumeSessionId: SESSION }));
    expect(hoisted.stdinWrites.join("")).toBe("build it");
  });

  it("names attachments in the prompt rather than dropping them", async () => {
    // opencode has a `-f` flag this does not use yet. Until it does, the paths
    // have to reach the model somehow: silently discarding them would leave the
    // turn answering a question about files it was never shown.
    await new OpencodeEngine().run(runOpts({ attachments: ["/proj/a.png", "/proj/b.csv"] }));

    expect(hoisted.stdinWrites.join("")).toBe("build it\n\nAttached files:\n- /proj/a.png\n- /proj/b.csv");
  });

  it("resumes by the id opencode gave us", async () => {
    await new OpencodeEngine().run(runOpts({ resumeSessionId: SESSION }));

    const args = hoisted.spawns[0]!.args;
    expect(args.slice(0, 4)).toEqual(["run", "--format", "json", "--dangerously-skip-permissions"]);
    expect(args).toContain("-s");
    expect(args[args.indexOf("-s") + 1]).toBe(SESSION);
  });

  it("sums the accounting across every step of the turn", async () => {
    // Real two-step output: a tool call, then the answer. Taking the LAST
    // step_finish instead of the sum would under-report a tool-using turn's
    // cost by however many round trips it took to get there.
    hoisted.lines = [
      step({ input: 49, output: 180, cache: { write: 0, read: 9088 } }, 0.004, "tool-calls"),
      text("It prints `hi`."),
      step({ input: 7567, output: 7, cache: { write: 0, read: 1792 } }, 0.002),
    ];

    const result = await new OpencodeEngine().run(runOpts());

    expect(result.result).toBe("It prints `hi`.");
    expect(result.numTurns).toBe(2);
    expect(result.cost).toBeCloseTo(0.006, 6);
    // The context reading is how full the window is NOW, so it is the last
    // step's input + both cache halves — not a sum across steps.
    expect(result.contextTokens).toBe(7567 + 1792);
  });

  it("reports an `error` event as the turn's error, not as an empty answer", async () => {
    // opencode puts failures on STDOUT as JSON and exits 1. Reading only stderr
    // would leave the operator with "exited with code 1:" and nothing after it.
    hoisted.exitCode = 1;
    hoisted.lines = [{
      type: "error",
      sessionID: SESSION,
      error: { name: "UnknownError", data: { message: "Unexpected server error.", ref: "err_6bd268c2" } },
    }];

    const result = await new OpencodeEngine().run(runOpts());

    expect(result.error).toBe("UnknownError: Unexpected server error.");
    expect(result.result).toBe("");
    // Even a turn that failed before producing anything reports its session.
    expect(result.sessionId).toBe(SESSION);
  });

  it("marks a usage limit as one, so it is not mistaken for a stale session id", async () => {
    // The order matters: the turn runner asks isDeadSessionError FIRST, and a
    // limit that lands before the first step leaves zero cost and zero turns —
    // exactly the shape it reads as a dead resume id. Without the rateLimit
    // marker the session id is wiped and the engine chain is never walked, so
    // the fallback the operator configured never runs.
    hoisted.exitCode = 1;
    hoisted.lines = [{
      type: "error",
      sessionID: SESSION,
      error: { name: "ProviderError", data: { message: "rate limit exceeded, please try again later" } },
    }];

    const result = await new OpencodeEngine().run(runOpts());

    expect(detectRateLimit(result).limited).toBe(true);
    expect(isDeadSessionError(result)).toBe(false);
  });

  it("leaves an ordinary zero-work failure readable as a dead session", async () => {
    // The counterpart to the case above: nothing is being blanket-marked.
    hoisted.exitCode = 1;
    hoisted.lines = [{
      type: "error",
      sessionID: SESSION,
      error: { name: "NotFound", data: { message: "session not found" } },
    }];

    const result = await new OpencodeEngine().run(runOpts());

    expect(result.rateLimit).toBeUndefined();
    expect(isDeadSessionError(result)).toBe(true);
  });

  it("says so when opencode exits cleanly having answered nothing", async () => {
    hoisted.lines = [{ type: "step_start", sessionID: SESSION, part: { type: "step-start" } }];

    const result = await new OpencodeEngine().run(runOpts());

    expect(result.error).toBe("opencode exited successfully without a final assistant response");
  });

  it("streams a tool call and its result", async () => {
    hoisted.lines = [
      {
        type: "tool_use",
        sessionID: SESSION,
        part: {
          type: "tool",
          tool: "read",
          callID: "call_0e1cf7fa",
          state: { status: "completed", input: { filePath: "/proj/main.py" }, output: "print('hi')" },
        },
      },
      text("It prints `hi`."),
      step({ input: 1, output: 1 }, 0),
    ];
    const deltas: StreamDelta[] = [];

    await new OpencodeEngine().run(runOpts({ onStream: (d) => deltas.push(d) }));

    expect(deltas).toEqual([
      { type: "tool_use", content: "read: /proj/main.py", toolName: "read", toolId: "call_0e1cf7fa" },
      { type: "tool_result", content: "print('hi')", toolName: "read", toolId: "call_0e1cf7fa" },
      { type: "text", content: "It prints `hi`." },
    ]);
  });

  it("emits no result for a tool that has not finished", async () => {
    // `pending` and `running` carry no output; reporting an empty result for
    // them would show the call as finished while it is still going.
    hoisted.lines = [
      { type: "tool_use", sessionID: SESSION, part: { type: "tool", tool: "bash", callID: "c1", state: { status: "running", input: { command: "pnpm test" } } } },
      text("done"),
      step({ input: 1, output: 1 }, 0),
    ];
    const deltas: StreamDelta[] = [];

    await new OpencodeEngine().run(runOpts({ onStream: (d) => deltas.push(d) }));

    expect(deltas.filter((d) => d.type === "tool_result")).toEqual([]);
    expect(deltas[0]).toMatchObject({ type: "tool_use", content: "bash: pnpm test" });
  });

  it("ignores a line that is not JSON rather than failing the turn", async () => {
    // A CLI notice printed into the stream must not take the answer with it.
    hoisted.lines = [];
    const engine = new OpencodeEngine();
    hoisted.lines = ["not json at all" as unknown, text("pong"), step({ input: 1, output: 1 }, 0)];

    const result = await engine.run(runOpts());
    expect(result.result).toBe("pong");
  });

  it("does not set OPENCODE_CONFIG for a session with no MCP servers", async () => {
    // No servers → no staged file → opencode's own config is left entirely alone.
    await new OpencodeEngine().run(runOpts());

    const env = hoisted.spawns[0]!.opts.env as Record<string, string>;
    expect(env.OPENCODE_CONFIG).toBeUndefined();
    // A self-upgrade between two turns would swap the binary under a session
    // opencode is still holding in its own store.
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
  });
});
