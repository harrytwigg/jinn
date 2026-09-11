import { describe, expect, it } from "vitest";
import { resolveOperatorNotificationTarget } from "../operator-notification-target.js";
import type { JinnConfig } from "../types.js";

const base = { engines: { default: "claude" }, connectors: {}, logging: { file: false, stdout: false, level: "info" } };
const cfg = (extra: Record<string, unknown>): JinnConfig => ({ ...base, ...extra } as unknown as JinnConfig);

describe("resolveOperatorNotificationTarget", () => {
  it("prefers the explicit notifications setting, defaulting its connector to discord", () => {
    expect(resolveOperatorNotificationTarget(cfg({ notifications: { channel: "123" } })))
      .toEqual({ connector: "discord", channel: "123", via: "notifications" });
    expect(resolveOperatorNotificationTarget(cfg({
      notifications: { connector: "slack", channel: "#ops" },
      cron: { alertConnector: "telegram", alertChannel: "1" },
    }))).toMatchObject({ connector: "slack", channel: "#ops" });
  });

  it("falls back to the cron alert channel", () => {
    expect(resolveOperatorNotificationTarget(cfg({ cron: { alertConnector: "telegram", alertChannel: "42" } })))
      .toEqual({ connector: "telegram", channel: "42", via: "cron.alert" });
  });

  it("falls back to a Telegram connector that allowlists exactly one user", () => {
    expect(resolveOperatorNotificationTarget(cfg({ connectors: { telegram: { botToken: "t", allowFrom: [700000001] } } })))
      .toEqual({ connector: "telegram", channel: "700000001", via: "telegram.allowFrom" });
  });

  it("does not guess between several allowed users, an open allowlist, or a connector with no token", () => {
    expect(resolveOperatorNotificationTarget(cfg({ connectors: { telegram: { botToken: "t", allowFrom: [1, 2] } } }))).toBeUndefined();
    expect(resolveOperatorNotificationTarget(cfg({ connectors: { telegram: { botToken: "t" } } }))).toBeUndefined();
    expect(resolveOperatorNotificationTarget(cfg({ connectors: { telegram: { allowFrom: [1] } } }))).toBeUndefined();
  });

  it("resolves nothing when nothing is configured", () => {
    expect(resolveOperatorNotificationTarget(cfg({}))).toBeUndefined();
    expect(resolveOperatorNotificationTarget(cfg({ notifications: { connector: "discord" } }))).toBeUndefined();
  });
});
