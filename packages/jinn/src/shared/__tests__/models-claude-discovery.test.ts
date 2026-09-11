import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JinnConfig } from "../types.js";
import type { ClaudeCredentialStatus } from "../claude-auth.js";

/**
 * GEN-53: "0 models — no usable OAuth token; run `claude login`" fired every
 * six hours for a month on a healthy gateway, because an access token that
 * expired between launches (the file's normal state — the CLI refreshes it on
 * the next launch) was reported the same way as a login that was actually
 * gone. A warning that is usually wrong is not a signal; and the catalog the
 * gateway had already discovered was thrown away each time it fired.
 */

const hoisted = vi.hoisted(() => ({
  discovered: { models: [] as { id: string; label: string; supportsEffort: boolean; effortLevels: string[] }[] },
  status: { state: "access-expired" } as ClaudeCredentialStatus,
}));

vi.mock("../logger.js", () => ({ logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../resolve-bin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../resolve-bin.js")>()),
  resolveBin: vi.fn(() => "claude"),
  isInstalled: vi.fn(() => true),
}));
vi.mock("../claude-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude-models.js")>()),
  discoverClaudeEffortLevels: vi.fn(async () => []),
  discoverClaudeModels: vi.fn(async () => hoisted.discovered),
}));
vi.mock("../claude-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../claude-auth.js")>()),
  readClaudeCredentialStatus: vi.fn(() => hoisted.status),
}));

import { logger } from "../logger.js";
import { getModelRegistry, refreshClaudeModels, setDiscoveredClaudeModelsForTest } from "../models.js";
import { discoverClaudeModels } from "../claude-models.js";
import { ClaudeCatalogRequestError, describeRefusedCatalog, describeZeroModels } from "../claude-auth.js";

const config = {
  gateway: { port: 7777, host: "127.0.0.1" },
  engines: { default: "claude", claude: { bin: "claude", model: "opus" } },
  connectors: {},
} as unknown as JinnConfig;

const sonnet5 = { id: "claude-sonnet-5", label: "Sonnet 5", supportsEffort: true, effortLevels: ["low", "high"] };

beforeEach(() => {
  setDiscoveredClaudeModelsForTest(null);
  hoisted.discovered = { models: [] };
  hoisted.status = { state: "access-expired" };
  vi.mocked(logger.info).mockClear();
  vi.mocked(logger.warn).mockClear();
});

describe("refreshClaudeModels", () => {
  it("reports an authenticated catalog and serves it", async () => {
    hoisted.discovered = { models: [sonnet5] };
    await expect(refreshClaudeModels(config)).resolves.toBe(true);
    expect(getModelRegistry(config).claude.models.some((m) => m.id === "claude-sonnet-5")).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps the last catalog and says the CLI will refresh when only the access token has lapsed", async () => {
    hoisted.discovered = { models: [sonnet5] };
    await refreshClaudeModels(config);

    hoisted.discovered = { models: [] };
    await expect(refreshClaudeModels(config)).resolves.toBe(false);

    expect(getModelRegistry(config).claude.models.some((m) => m.id === "claude-sonnet-5")).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(vi.mocked(logger.info).mock.calls.at(-1)?.[0])
      .toBe("Claude model discovery returned 0 models — the access token on disk has expired; Claude Code refreshes it on its next launch; keeping the last discovered catalog.");
  });

  it("warns, with the fix, when the login is actually gone", async () => {
    hoisted.status = { state: "missing", path: "/home/h/.claude/.credentials.json" };
    await expect(refreshClaudeModels(config)).resolves.toBe(false);
    expect(vi.mocked(logger.warn).mock.calls.at(-1)?.[0])
      .toBe("Claude model discovery returned 0 models — no Claude credentials at /home/h/.claude/.credentials.json. Run `claude auth login` on this host; falling back to the offline alias catalog.");
  });

  // GEN-53 review: the token reader never sends an access token the file says
  // has expired, so a 401 is a revoked login — a fact about the credentials,
  // not about the catalog. Throwing it into the generic catch dropped the
  // catalog and said nothing useful, which is the degradation this set out to stop.
  it("keeps the catalog and names the cause when Anthropic refuses the token", async () => {
    hoisted.discovered = { models: [sonnet5] };
    await refreshClaudeModels(config);

    hoisted.status = { state: "ok", path: "/home/h/.claude/.credentials.json" };
    vi.mocked(discoverClaudeModels).mockRejectedValueOnce(new ClaudeCatalogRequestError(401, "Unauthorized"));
    await expect(refreshClaudeModels(config)).resolves.toBe(false);

    expect(getModelRegistry(config).claude.models.some((m) => m.id === "claude-sonnet-5")).toBe(true);
    expect(vi.mocked(logger.warn).mock.calls.at(-1)?.[0])
      .toBe("Claude model discovery was refused — Anthropic refused the token on disk (/home/h/.claude/.credentials.json) with HTTP 401"
        + " — the login has been revoked, or the account cannot reach the API. Run `claude auth login` on this host; keeping the last discovered catalog.");
  });

  it("still drops the catalog when the failure is not about the credentials", async () => {
    hoisted.discovered = { models: [sonnet5] };
    await refreshClaudeModels(config);

    vi.mocked(discoverClaudeModels).mockRejectedValueOnce(new ClaudeCatalogRequestError(503, "Service Unavailable"));
    await expect(refreshClaudeModels(config)).resolves.toBe(false);
    expect(vi.mocked(logger.warn).mock.calls.at(-1)?.[0]).toContain("Claude model discovery failed: Anthropic model catalog request failed: 503");
  });
});

describe("describeZeroModels", () => {
  it("only tells the operator to log in when logging in is the fix", () => {
    expect(describeZeroModels({ state: "access-expired" })).toMatchObject({ level: "info" });
    expect(describeZeroModels({ state: "refresh-expired" })).toMatchObject({ level: "warn", text: expect.stringContaining("claude auth login") });
    expect(describeZeroModels({ state: "unknown" })).toMatchObject({ level: "warn", text: expect.stringContaining("claude auth login") });
    expect(describeZeroModels({ state: "ok" }).text).not.toContain("auth login");
    expect(describeZeroModels({ state: "env" }).text).not.toContain("auth login");
  });

  it("names where the refused token came from", () => {
    expect(describeRefusedCatalog({ state: "env" }, 403).text).toContain("the token in the environment");
    expect(describeRefusedCatalog({ state: "ok", path: "/x/.credentials.json" }, 401).text)
      .toContain("the token on disk (/x/.credentials.json)");
  });
});
