import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os, { hostname } from "node:os";
import path from "node:path";
import type { Employee, Engine, JinnConfig } from "../../shared/types.js";

/**
 * Where a NEW session starts, when the gateway's own Claude login has died.
 *
 * The unit test beside `engineHealthForTarget` proves the filter; this proves it
 * is actually wired into the decision. Both halves matter, and the second is the
 * one that rots: the scoping could be perfectly correct and simply not consulted
 * here, and nothing about a rerouted session looks wrong from the outside — it
 * starts, it answers, it just answers on an engine and a model nobody chose.
 */

const TEST_HOME = path.join(os.tmpdir(), "jinn-new-session-host-scope-test");
vi.mock("../../shared/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/paths.js")>()),
  JINN_HOME: path.join(os.tmpdir(), "jinn-new-session-host-scope-test"),
}));

// Only installed-availability is faked: the gateway running these tests has
// neither CLI. Everything that decides WHICH engines may follow a remote session
// — REMOTE_ENGINE_NAMES, engineSupportsRemote — stays real, because that is half
// of what is under test.
vi.mock("../../shared/models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/models.js")>()),
  engineAvailable: () => true,
}));

import { recordEngineUnavailable } from "../../shared/engine-health.js";
import { newSessionEngineSelection } from "../new-session-engine.js";

const STATE_PATH = path.join(TEST_HOME, "tmp", "engine-health.json");
// Real time, not a frozen instant: the selection under test reads the clock
// itself, and a record stamped in a fixed past would simply have lapsed.
const NOW = new Date();
const RESETS_AT = (NOW.getTime() + 90 * 60_000) / 1000;

const config = {
  engines: { default: "claude", claude: { bin: "claude", model: "opus", fallback: ["pi"] }, pi: { model: "ollama/gemma4:12b" } },
} as unknown as JinnConfig;

const engines = new Map<string, Engine>([
  ["claude", { name: "claude", run: vi.fn() }],
  ["pi", { name: "pi", run: vi.fn() }],
]);

const local: Employee = { name: "ada", engine: "claude" } as Employee;
const remote: Employee = {
  name: "hound",
  engine: "claude",
  remoteHost: "build-box",
  remoteUser: "jinn",
  remoteCwd: "/srv/jinn-work/main",
} as Employee;

beforeEach(() => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.rmSync(STATE_PATH, { force: true });
});

afterEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("newSessionEngineSelection — a dead login on the gateway", () => {
  it("moves a LOCAL employee's new session onto the chain", () => {
    // The behaviour the auth-outage record exists for, unchanged.
    recordEngineUnavailable("claude", "authentication failed", RESETS_AT, NOW, { host: hostname() });

    expect(newSessionEngineSelection(config, engines, { employee: local }).engine).toBe("pi");
  });

  it("leaves a REMOTE employee's new session on Claude", () => {
    // That employee's Claude Code is signed in on build-box, which the gateway
    // can neither read nor speak for. Rerouting it would swap a working engine —
    // and with it the model the employee was configured for — over a login it
    // was never going to use.
    recordEngineUnavailable("claude", "authentication failed", RESETS_AT, NOW, { host: hostname() });

    expect(newSessionEngineSelection(config, engines, { employee: remote }).engine).toBe("claude");
  });

  it("still moves a remote employee off a spent ACCOUNT allowance", () => {
    // The guard is about hosts, not about remoteness: a usage limit names no
    // host because it holds wherever the turn runs, and a remote session must
    // still give way to it.
    recordEngineUnavailable("claude", "usage limit", RESETS_AT, NOW);

    expect(newSessionEngineSelection(config, engines, { employee: remote }).engine).toBe("pi");
  });
});
