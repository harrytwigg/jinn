import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyClaudeCredentials,
  claudeLoginHint,
  parseClaudeCredentials,
  readClaudeCredentialStatus,
} from "../claude-auth.js";

const NOW = Date.parse("2026-09-11T02:00:00.000Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function blob(oauth: Record<string, unknown> | undefined): string {
  return JSON.stringify(oauth === undefined ? { somethingElse: true } : { claudeAiOauth: oauth });
}

const LIVE = { accessToken: "sk-ant-oat01-access", refreshToken: "sk-ant-ort01-refresh", expiresAt: NOW + 6 * HOUR, refreshTokenExpiresAt: NOW + 28 * DAY };

describe("parseClaudeCredentials", () => {
  it("reads the pair and both expiries", () => {
    expect(parseClaudeCredentials(blob(LIVE))).toEqual({
      accessToken: "sk-ant-oat01-access",
      refreshToken: "sk-ant-ort01-refresh",
      accessExpiresAt: NOW + 6 * HOUR,
      refreshExpiresAt: NOW + 28 * DAY,
    });
  });

  it("accepts ISO expiries and drops blank tokens", () => {
    const parsed = parseClaudeCredentials(blob({ accessToken: "  ", refreshToken: "r", expiresAt: "2026-09-11T08:00:00Z" }));
    expect(parsed).toEqual({ refreshToken: "r", accessExpiresAt: Date.parse("2026-09-11T08:00:00Z"), refreshExpiresAt: undefined });
  });

  it("returns undefined for a blob with no OAuth object, and for junk", () => {
    expect(parseClaudeCredentials(blob(undefined))).toBeUndefined();
    expect(parseClaudeCredentials("not json")).toBeUndefined();
    expect(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: [] }))).toBeUndefined();
  });
});

describe("classifyClaudeCredentials", () => {
  it("is ok while the access token is live, with a fingerprint free of secrets", () => {
    const status = classifyClaudeCredentials(parseClaudeCredentials(blob(LIVE)), NOW);
    expect(status.state).toBe("ok");
    expect(status.fingerprint).toBe(`${NOW + 6 * HOUR}:${NOW + 28 * DAY}`);
    expect(JSON.stringify(status)).not.toContain("sk-ant");
  });

  it("is access-expired — routine, the CLI refreshes — once the access token lapses on a live refresh token", () => {
    const status = classifyClaudeCredentials(parseClaudeCredentials(blob({ ...LIVE, expiresAt: NOW - 1 })), NOW);
    expect(status.state).toBe("access-expired");
    expect(status.accessExpiresAt).toBe(NOW - 1);
  });

  it("is refresh-expired when the refresh token is past its own expiry", () => {
    const status = classifyClaudeCredentials(
      parseClaudeCredentials(blob({ ...LIVE, expiresAt: NOW - 1, refreshTokenExpiresAt: NOW - DAY })), NOW);
    expect(status.state).toBe("refresh-expired");
  });

  it("is refresh-expired when the access token lapsed and there is no refresh token at all", () => {
    const status = classifyClaudeCredentials(parseClaudeCredentials(blob({ accessToken: "a", expiresAt: NOW - 1 })), NOW);
    expect(status.state).toBe("refresh-expired");
  });

  it("treats an access token with no stated expiry as live", () => {
    expect(classifyClaudeCredentials({ accessToken: "a" }, NOW).state).toBe("ok");
  });

  it("is unknown for no pair", () => {
    expect(classifyClaudeCredentials(undefined, NOW).state).toBe("unknown");
    expect(classifyClaudeCredentials({}, NOW).state).toBe("unknown");
  });

  it("does not let a stale on-disk refresh expiry outrank a live access token", () => {
    // A refresh expiry in the past with a live access token is a file mid-rotation, not an outage.
    const status = classifyClaudeCredentials(parseClaudeCredentials(blob({ ...LIVE, refreshTokenExpiresAt: NOW - 1 })), NOW);
    expect(status.state).toBe("ok");
  });
});

describe("readClaudeCredentialStatus", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-auth-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("is env when a token is in the environment, without touching the disk", () => {
    expect(readClaudeCredentialStatus({ env: { CLAUDE_CODE_OAUTH_TOKEN: "x" }, configDir: "/nowhere", now: NOW })).toEqual({ state: "env" });
    expect(readClaudeCredentialStatus({ env: { ANTHROPIC_API_KEY: "x" }, configDir: "/nowhere", now: NOW })).toEqual({ state: "env" });
  });

  it("is missing on a Linux host with no credentials file, naming the path", () => {
    const status = readClaudeCredentialStatus({ env: {}, configDir: dir, platform: "linux", now: NOW });
    expect(status.state).toBe("missing");
    expect(status.path).toBe(path.join(dir, ".credentials.json"));
  });

  it("is unknown — never a refusal — on darwin, where the pair lives in the Keychain", () => {
    expect(readClaudeCredentialStatus({ env: {}, configDir: dir, platform: "darwin", now: NOW }).state).toBe("unknown");
  });

  it("classifies the file it finds", () => {
    fs.writeFileSync(path.join(dir, ".credentials.json"), blob({ ...LIVE, expiresAt: NOW - 1 }));
    const status = readClaudeCredentialStatus({ env: {}, configDir: dir, platform: "linux", now: NOW });
    expect(status.state).toBe("access-expired");
    expect(status.refreshExpiresAt).toBe(NOW + 28 * DAY);
  });

  it("is unknown for a file it cannot parse or that carries no OAuth", () => {
    fs.writeFileSync(path.join(dir, ".credentials.json"), "{");
    expect(readClaudeCredentialStatus({ env: {}, configDir: dir, platform: "linux", now: NOW }).state).toBe("unknown");
    fs.writeFileSync(path.join(dir, ".credentials.json"), blob(undefined));
    expect(readClaudeCredentialStatus({ env: {}, configDir: dir, platform: "linux", now: NOW }).state).toBe("unknown");
  });
});

describe("claudeLoginHint", () => {
  it("names the host and the profile", () => {
    expect(claudeLoginHint("gateway-host")).toBe("run `claude auth login` on gateway-host as the gateway user");
    expect(claudeLoginHint("gateway-host", "/home/x/.claude-work")).toContain("CLAUDE_CONFIG_DIR=/home/x/.claude-work");
  });
});
