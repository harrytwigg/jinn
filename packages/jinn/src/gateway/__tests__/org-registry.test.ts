import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { JinnConfig } from "../../shared/types.js";

// Same seam as org.test.ts: org.ts resolves its org dir at CALL time from
// resolveJinnHome(), so the home is what the fixtures swap.
let tmpHome: string;

vi.mock("../../shared/paths.js", () => ({
  resolveJinnHome: () => tmpHome,
}));

vi.mock("../../shared/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// The scan is spied on, not replaced: the read-after-write cases need the real
// walk, and the cache cases need to count how often it happens.
vi.mock("../org.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../org.js")>();
  return { ...actual, scanOrg: vi.fn(actual.scanOrg) };
});

import { scanOrg } from "../org.js";
import { orgRegistry, readOrg, refreshOrg, resetOrgRegistryForTests } from "../org-registry.js";

const scan = vi.mocked(scanOrg);

function writeEmployee(name: string, department = "platform"): void {
  const dir = path.join(tmpHome, "org", department);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.yaml`),
    `name: ${name}\ndepartment: ${department}\npersona: You run the ${department} work.\n`,
    "utf-8",
  );
}

function configFor(engine: string, model: string): JinnConfig {
  return { engines: { default: engine, [engine]: { model } } } as unknown as JinnConfig;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "org-registry-test-"));
  fs.mkdirSync(path.join(tmpHome, "org"), { recursive: true });
  resetOrgRegistryForTests();
  scan.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("readOrg — caching", () => {
  it("serves the second read from cache and rescans only on refresh", () => {
    writeEmployee("alpha");

    expect(readOrg().registry.has("alpha")).toBe(true);
    expect(scan).toHaveBeenCalledTimes(1);

    readOrg();
    orgRegistry();
    expect(scan).toHaveBeenCalledTimes(1);

    refreshOrg();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("rescans when the config reference changes so system employees match it", () => {
    const claude = configFor("claude", "opus");
    const codex = configFor("codex", "gpt-custom");

    expect(readOrg(claude).registry.get("todo-dispatcher")).toMatchObject({
      engine: "claude",
      model: "opus",
    });
    expect(readOrg(codex).registry.get("todo-dispatcher")).toMatchObject({
      engine: "codex",
      model: "gpt-custom",
    });
    // A caller with no config of its own asks for "the roster", not for "the
    // roster of an instance with no configuration": it is served the last
    // config's answer, and costs no rescan.
    expect(readOrg().registry.get("todo-dispatcher")).toMatchObject({
      engine: "codex",
      model: "gpt-custom",
    });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  // DAH-214 item 2. `scanOrg` DROPS a remote employee it cannot validate
  // against `config.remote`, so scanning with `undefined` deleted every remote
  // employee from the roster — and the Todo authority check reads the roster
  // without a config. A delegated reviewer running on another machine was
  // therefore told they were "not in the org roster" by `assign_work_item`,
  // while delegation (which passes the config) resolved them fine.
  it("keeps remote employees on a config-less read", () => {
    const dir = path.join(tmpHome, "org", "platform");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "remote-reviewer.yaml"),
      "name: remote-reviewer\ndepartment: platform\npersona: You review on another machine.\n"
      + "remoteHost: 192.168.0.201\nremoteUser: harry\nremoteCwd: /srv/jinn-work/bluetel\n",
      "utf-8",
    );
    const config = {
      ...configFor("claude", "opus"),
      remote: { root: "/srv/jinn-work", mount: "/mnt/jinn-home" },
    } as unknown as JinnConfig;

    expect(readOrg(config).registry.has("remote-reviewer")).toBe(true);
    expect(orgRegistry().has("remote-reviewer")).toBe(true);
    expect(refreshOrg().registry.has("remote-reviewer")).toBe(true);
  });
});

describe("readOrg — a failing scan", () => {
  it("keeps the last known good roster and names the reason", () => {
    writeEmployee("alpha");
    const good = readOrg();
    expect(good.registry.has("alpha")).toBe(true);
    expect(good.error).toBeUndefined();

    scan.mockImplementationOnce(() => {
      throw new Error("org dir unreadable");
    });
    const degraded = refreshOrg();

    expect(degraded.error).toBe("org dir unreadable");
    expect(degraded.registry.has("alpha")).toBe(true);
    expect(degraded.registry).toBe(good.registry);
  });

  it("retries on the next read rather than serving the degraded cache forever", () => {
    writeEmployee("alpha");
    readOrg();

    scan.mockImplementationOnce(() => {
      throw new Error("transient");
    });
    expect(refreshOrg().error).toBe("transient");

    scan.mockClear();
    const recovered = readOrg();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(recovered.error).toBeUndefined();
    expect(recovered.registry.has("alpha")).toBe(true);
  });
});

describe("readOrg — read after write", () => {
  it("sees an employee written after the first read once the owner is refreshed", () => {
    writeEmployee("alpha");
    expect(readOrg().registry.has("beta")).toBe(false);

    writeEmployee("beta", "growth");
    // Still the cached answer — the write has to be announced.
    expect(readOrg().registry.has("beta")).toBe(false);

    refreshOrg();
    expect(readOrg().registry.get("beta")).toMatchObject({ department: "growth" });
  });
});
