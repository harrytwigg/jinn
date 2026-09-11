import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os, { hostname } from "node:os";
import path from "node:path";

// Its own home, not the sibling suite's: the store freezes its path from
// JINN_HOME at import, and two workers sharing one would clear each other's
// records mid-run.
const TEST_HOME = path.join(os.tmpdir(), "jinn-engine-health-host-scope-test");
vi.mock("../paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../paths.js")>()),
  JINN_HOME: path.join(os.tmpdir(), "jinn-engine-health-host-scope-test"),
}));

import { engineHealthForTarget, isEngineExhausted, readEngineHealth, recordEngineUnavailable } from "../engine-health.js";

const STATE_PATH = path.join(TEST_HOME, "tmp", "engine-health.json");
const NOW = new Date("2026-09-11T10:00:00.000Z");
const secondsAt = (minutes: number) => (NOW.getTime() + minutes * 60_000) / 1000;

beforeEach(() => {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.rmSync(STATE_PATH, { force: true });
});

afterEach(() => {
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

/**
 * Which machine a record is about.
 *
 * Almost everything recorded here is an allowance — a provider's quota window —
 * and that is the same fact wherever the turn runs. A LOGIN is not: a remote
 * employee signs its engine in on its own host, which the gateway can neither
 * read nor speak for. The store is global and both dispatchers read it for local
 * and remote sessions alike, so a record that does not say whose login died is
 * how a dead `claude` login on the orchestrator moves a remote employee's
 * sessions onto a substitute they never needed.
 */
describe("engineHealthForTarget", () => {
  const GATEWAY = hostname();
  const REMOTE = { remoteHost: "build-box", remoteUser: "jinn", remoteCwd: "/srv/jinn-work/main" };

  it("keeps a record about the gateway for a session that runs on the gateway", () => {
    recordEngineUnavailable("claude", "authentication failed", secondsAt(90), NOW, { host: GATEWAY });
    const health = readEngineHealth(NOW);

    expect(isEngineExhausted(engineHealthForTarget(health, undefined), "claude", NOW)).toBe(true);
  });

  it("drops it for a session that runs somewhere else", () => {
    // The whole point: that login is this machine's, and the remote employee's
    // Claude Code is signed in on its own box.
    recordEngineUnavailable("claude", "authentication failed", secondsAt(90), NOW, { host: GATEWAY });
    const health = readEngineHealth(NOW);

    expect(isEngineExhausted(engineHealthForTarget(health, REMOTE), "claude", NOW)).toBe(false);
  });

  it("keeps a record that names no host for every session", () => {
    // A spent quota window really does hold wherever the turn runs — this must
    // not become a blanket exemption for remote sessions.
    recordEngineUnavailable("claude", "usage limit", secondsAt(90), NOW);
    const health = readEngineHealth(NOW);

    expect(isEngineExhausted(engineHealthForTarget(health, REMOTE), "claude", NOW)).toBe(true);
    expect(isEngineExhausted(engineHealthForTarget(health, undefined), "claude", NOW)).toBe(true);
  });

  it("judges each engine's record on its own host", () => {
    recordEngineUnavailable("claude", "authentication failed", secondsAt(90), NOW, { host: GATEWAY });
    recordEngineUnavailable("pi", "usage limit", secondsAt(90), NOW);
    const scoped = engineHealthForTarget(readEngineHealth(NOW), REMOTE);

    expect(isEngineExhausted(scoped, "claude", NOW)).toBe(false);
    expect(isEngineExhausted(scoped, "pi", NOW)).toBe(true);
  });

  it("stores the host on the record itself, so a restart does not lose the scope", () => {
    recordEngineUnavailable("claude", "authentication failed", secondsAt(90), NOW, { host: GATEWAY });

    expect(JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")).claude.host).toBe(GATEWAY);
  });
});
