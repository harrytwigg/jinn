import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  buildOpencodeSessionConfig,
  cleanupOpencodeSessionConfig,
  projectMcpForOpencode,
  projectOpencodeMcpServer,
  writeOpencodeSessionConfig,
} from "../opencode-mcp.js";

/**
 * jinn's resolved MCP set, as opencode's config takes it.
 *
 * The projection is where the company toolset either reaches the model or
 * silently does not, so the cases below are about the two ways that goes wrong:
 * a server dropped on the floor (the model is told nothing and improvises), and
 * a server projected into a shape opencode accepts but launches WRONG — an argv
 * split the wrong way, or an `env` that did not become `environment` and so
 * took this session's capability with it.
 */
describe("projectOpencodeMcpServer", () => {
  it("folds command + args into opencode's single argv array", () => {
    expect(projectOpencodeMcpServer({
      command: "/usr/bin/node",
      args: ["/opt/jinn/server.js", "--home", "/home/me/.jinn"],
    })).toEqual({
      type: "local",
      command: ["/usr/bin/node", "/opt/jinn/server.js", "--home", "/home/me/.jinn"],
      enabled: true,
    });
  });

  it("carries env across as `environment`", () => {
    // The capability authorizes acting as this session. If it does not survive
    // the rename, every jinn tool call the model makes is rejected — and the
    // turn still runs, so nothing fails loudly enough to notice.
    const projected = projectOpencodeMcpServer({
      command: "node",
      args: ["server.js"],
      env: { JINN_SESSION_ID: "sess-1", JINN_SESSION_CAPABILITY: "cap-abc" },
    });

    expect(projected).toMatchObject({
      environment: { JINN_SESSION_ID: "sess-1", JINN_SESSION_CAPABILITY: "cap-abc" },
    });
  });

  it("omits `environment` entirely when the server carries none", () => {
    expect(projectOpencodeMcpServer({ command: "node", args: [] })).not.toHaveProperty("environment");
    expect(projectOpencodeMcpServer({ command: "node", env: {} })).not.toHaveProperty("environment");
  });

  it("projects a URL server as opencode's `remote` type", () => {
    expect(projectOpencodeMcpServer({ type: "sse", url: "https://tools.example/sse", headers: { "X-Key": "v" } }))
      .toEqual({ type: "remote", url: "https://tools.example/sse", headers: { "X-Key": "v" }, enabled: true });
  });

  it("returns null for a spec that is neither", () => {
    // Null, not a guess: a half-wired server is harder to diagnose than a
    // missing one, because the model is told the tool exists.
    expect(projectOpencodeMcpServer({ command: "" })).toBeNull();
    expect(projectOpencodeMcpServer({ url: "" })).toBeNull();
    expect(projectOpencodeMcpServer({})).toBeNull();
    expect(projectOpencodeMcpServer(null)).toBeNull();
    expect(projectOpencodeMcpServer(["node"])).toBeNull();
  });
});

describe("projectMcpForOpencode", () => {
  it("keeps the servers it can run and drops the ones it cannot", () => {
    const projected = projectMcpForOpencode({
      mcpServers: {
        jinn: { command: "node", args: ["server.js"] },
        broken: { } as never,
        web: { type: "sse", url: "https://tools.example/sse" },
      },
    });

    expect(Object.keys(projected).sort()).toEqual(["jinn", "web"]);
  });

  it("is empty for a session with no MCP at all", () => {
    expect(projectMcpForOpencode(undefined)).toEqual({});
    expect(projectMcpForOpencode({ mcpServers: {} })).toEqual({});
  });
});

describe("buildOpencodeSessionConfig", () => {
  it("writes only `mcp`, so the operator's own config survives the merge", () => {
    // OPENCODE_CONFIG merges rather than replaces, so anything jinn adds here it
    // also takes away from the operator. In particular there is no `permission`
    // block: an operator who denied `bash` on that machine keeps that deny, and
    // unattended approval comes from --dangerously-skip-permissions instead.
    const config = buildOpencodeSessionConfig({ mcpServers: { jinn: { command: "node", args: ["server.js"] } } });

    expect(Object.keys(config!).sort()).toEqual(["$schema", "mcp"]);
    expect(config).not.toHaveProperty("permission");
  });

  it("is undefined when the session carries no servers opencode can run", () => {
    // No file staged, no OPENCODE_CONFIG set, opencode's own config untouched.
    expect(buildOpencodeSessionConfig(undefined)).toBeUndefined();
    expect(buildOpencodeSessionConfig({ mcpServers: {} })).toBeUndefined();
    expect(buildOpencodeSessionConfig({ mcpServers: { broken: {} as never } })).toBeUndefined();
  });
});

/**
 * opencode's attach artifact, for the per-engine wiring seam that
 * mcp/__tests__/engine-wiring.test.ts keeps complete.
 *
 * Unlike pi, opencode launches the jinn server as a real subprocess and hands it
 * the `environment` map from this file — so the capability lives IN the file,
 * the way Claude's staged mcp.json carries it, rather than being passed
 * separately through the child env. The gateway bearer still never appears: the
 * server resolves that from <JINN_HOME>/gateway.json.
 */
describe("writeOpencodeSessionConfig — the staged attach artifact", () => {
  const SID = "sess-wiring-1";
  const CAPABILITY = "cap-wiring-abc";
  const BEARER = "wiring-test-secret-token";

  const resolved = {
    mcpServers: {
      jinn: {
        command: "/usr/bin/node",
        args: ["/opt/jinn/server.js"],
        env: { JINN_SESSION_ID: SID, JINN_SESSION_CAPABILITY: CAPABILITY },
      },
    },
  };

  it("writes a 0600 config carrying the jinn server, identity and all, but never the bearer", () => {
    const handle = writeOpencodeSessionConfig(resolved, SID);
    expect(handle.staged).toBe(true);
    try {
      if (!handle.staged) throw new Error("expected the opencode config to be staged");
      if (process.platform !== "win32") {
        expect(fs.statSync(handle.configPath).mode & 0o777).toBe(0o600);
      }
      const raw = fs.readFileSync(handle.configPath, "utf-8");
      const onDisk = JSON.parse(raw);
      expect(onDisk.mcp.jinn.type).toBe("local");
      expect(onDisk.mcp.jinn.command).toEqual(["/usr/bin/node", "/opt/jinn/server.js"]);
      expect(onDisk.mcp.jinn.environment.JINN_SESSION_ID).toBe(SID);
      expect(onDisk.mcp.jinn.environment.JINN_SESSION_CAPABILITY).toBe(CAPABILITY);
      expect(raw).not.toContain(BEARER);
    } finally {
      cleanupOpencodeSessionConfig(handle);
    }
    expect(handle.staged && fs.existsSync(handle.configPath)).toBe(false);
  });

  it("stages nothing at all for a session with no servers", () => {
    // No file, no OPENCODE_CONFIG, opencode's own config left untouched.
    expect(writeOpencodeSessionConfig(undefined, SID)).toEqual({ staged: false });
  });
});
