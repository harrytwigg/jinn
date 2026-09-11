import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnRun, TurnSurface } from "../turn/types.js";
import type { EngineAttempt } from "../turn/engine-run.js";

/**
 * GEN-53: an outage of `authentication_failed` turns read in the gateway log
 * as a run of "Session … completed" lines, because the settle path logged
 * completion regardless of the receipt it had just written. The receipt was
 * right (status `error`, attemptOutcome `failed`); the log line was the only
 * thing anyone reads at 2am, and it lied.
 */

vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-settle-failed-log-"));
process.env.JINN_HOME = tmp;
const reg = await import("../registry.js");
const { settleAnsweredTurn } = await import("../turn/settle.js");
const { logger } = await import("../../shared/logger.js");

const silentSurface: TurnSurface = {
  started: async () => {},
  delta: () => {},
  notice: async () => {},
  reply: async () => {},
  waiting: async () => {},
  settled: async () => {},
};

function runFor(error: string | undefined): { run: TurnRun; attempt: EngineAttempt } {
  const created = reg.createSession({ engine: "claude", source: "cron", sourceRef: `cron:test:${Math.random()}`, model: "sonnet" });
  const session = reg.beginSessionAttempt(created.id)!;
  const run = {
    input: { session, attemptToken: session.attemptToken!, prompt: "do the thing", attachments: [], config: { engines: {} } },
    plan: { ok: true, engineName: "claude" },
    surface: silentSurface,
    heartbeat: { stop: () => {} },
    partialStream: { write: () => {} },
    turnStartedAt: Date.now(),
    terminalFields: () => ({}),
  } as unknown as TurnRun;
  const attempt = {
    result: { sessionId: "native-1", result: "", durationMs: 3766, ...(error ? { error } : {}) },
    fingerprint: "fp",
    contextRefresh: undefined,
    systemPrompt: "",
  } as EngineAttempt;
  return { run, attempt };
}

const verdict = { quietPreempted: false, streamedThrough: 0, superseded: false, enginePromptRead: true };

describe("settleAnsweredTurn's log line agrees with its receipt", () => {
  beforeEach(async () => {
    const db = (await import("../../shared/db.js")).initDb();
    db.exec("DELETE FROM messages; DELETE FROM queue_items; DELETE FROM sessions;");
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it("logs a failed turn as failed, with the error, at error level", async () => {
    const { run, attempt } = runFor("Interactive turn failed: authentication_failed");
    await settleAnsweredTurn(run, attempt, "sonnet", verdict);

    expect(reg.getSession(run.input.session.id)).toMatchObject({ status: "error", attemptOutcome: "failed" });
    expect(logger.error).toHaveBeenCalledWith(
      `Session ${run.input.session.id} failed in 3766ms: Interactive turn failed: authentication_failed`,
    );
    expect(vi.mocked(logger.info).mock.calls.flat().join("\n")).not.toContain("completed");
  });

  it("still logs a turn that succeeded as completed", async () => {
    const { run, attempt } = runFor(undefined);
    attempt.result.result = "done";
    await settleAnsweredTurn(run, attempt, "sonnet", verdict);

    expect(reg.getSession(run.input.session.id)?.attemptOutcome).toBe("succeeded");
    expect(logger.info).toHaveBeenCalledWith(`Session ${run.input.session.id} completed in 3766ms`);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("logs a preempted turn as interrupted", async () => {
    const { run, attempt } = runFor(undefined);
    await settleAnsweredTurn(run, attempt, "sonnet", { ...verdict, quietPreempted: true });

    expect(logger.info).toHaveBeenCalledWith(`Session ${run.input.session.id} interrupted in 3766ms`);
  });
});
