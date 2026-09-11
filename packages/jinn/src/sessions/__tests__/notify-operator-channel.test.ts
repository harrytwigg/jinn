import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GEN-53: operator alerts used to be dropped at debug level whenever
 * `notifications.channel` was unset — on the instance that lost six hours of
 * cron to a silent auth outage, with a Telegram connector up the whole time.
 * The channel now resolves through the fallbacks, a dropped alert is a
 * warning, and a caller can learn that its alert actually landed.
 */

const hoisted = vi.hoisted(() => ({ config: {} as Record<string, unknown> }));

vi.mock("../callback-connection.js", () => ({
  internalGatewayConnection: () => ({ baseUrl: "http://gateway.test", token: "tok" }),
  internalGatewayHeaders: () => ({ "Content-Type": "application/json" }),
}));
vi.mock("../../shared/config.js", () => ({ loadConfig: vi.fn(() => hoisted.config) }));
vi.mock("../../shared/logger.js", () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { logger } from "../../shared/logger.js";
import { notifyOperatorChannel } from "../callbacks.js";

const originalFetch = globalThis.fetch;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  hoisted.config = {};
  vi.mocked(logger.warn).mockClear();
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe("notifyOperatorChannel", () => {
  it("sends to the resolved fallback channel and confirms delivery", async () => {
    hoisted.config = { connectors: { telegram: { botToken: "t", allowFrom: [700000001] } } };
    const fetchSpy = vi.fn(async () => ({ ok: true }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const onSent = vi.fn();

    notifyOperatorChannel("🔐 something broke", onSent);
    await flush();

    expect(fetchSpy).toHaveBeenCalledWith("http://gateway.test/api/connectors/telegram/send", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ channel: "700000001", text: "🔐 something broke" }),
    }));
    expect(onSent).toHaveBeenCalledExactlyOnceWith(true);
  });

  // GEN-53 review: a caller holding a one-shot marker — "this outage has been
  // announced", "this expiry has had its warning" — needs the false as much as
  // the true, or the marker is burnt on an alert nobody received.
  it("warns, names the fix, and reports the drop when no channel resolves", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const onResult = vi.fn();

    notifyOperatorChannel("🔐 something broke\nsecond line", onResult);
    await flush();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledExactlyOnceWith(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("set notifications.connector/channel"));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("alert dropped: 🔐 something broke"));
  });

  it("reports a send the connector refused as not delivered", async () => {
    hoisted.config = { notifications: { connector: "telegram", channel: "1" } };
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 502 })) as unknown as typeof fetch;
    const onResult = vi.fn();

    notifyOperatorChannel("x", onResult);
    await flush();

    expect(onResult).toHaveBeenCalledExactlyOnceWith(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("connector notification failed (502)"));
  });

  it("reports a transport failure as not delivered", async () => {
    hoisted.config = { notifications: { connector: "telegram", channel: "1" } };
    globalThis.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const onResult = vi.fn();

    notifyOperatorChannel("x", onResult);
    await flush();

    expect(onResult).toHaveBeenCalledExactlyOnceWith(false);
  });
});
