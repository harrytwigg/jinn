import { describe, it, expect } from "vitest";
import { parseOpencodeModels } from "../opencode-models.js";

/**
 * What `opencode models` actually prints, and what must not reach the picker.
 *
 * The fixtures are real output from opencode 1.16.2, plus the shapes a CLI puts
 * around a list when something else is going on — an update notice, a provider
 * warning, a path in an error. A model the picker offers but opencode cannot
 * select is worse than a short list: the session starts and the turn fails.
 */
describe("parseOpencodeModels", () => {
  it("reads one provider/model per line", () => {
    const models = parseOpencodeModels([
      "opencode/big-pickle",
      "opencode/mimo-v2.5-free",
      "anthropic/claude-sonnet-5",
    ].join("\n"));

    expect(models.map((m) => m.id)).toEqual([
      "opencode/big-pickle",
      "opencode/mimo-v2.5-free",
      "anthropic/claude-sonnet-5",
    ]);
    // The label is the model half: the provider is already the grouping.
    expect(models.map((m) => m.label)).toEqual(["big-pickle", "mimo-v2.5-free", "claude-sonnet-5"]);
  });

  it("keeps the whole id when the model half has its own slashes", () => {
    // Only the FIRST slash is structural — `openrouter/meta-llama/llama-4` is
    // one model, and handing back anything shorter would select a different one.
    const models = parseOpencodeModels("openrouter/meta-llama/llama-4\n");
    expect(models).toEqual([
      { id: "openrouter/meta-llama/llama-4", label: "meta-llama/llama-4", supportsEffort: false, effortLevels: [] },
    ]);
  });

  it("claims no effort support for any model", () => {
    // opencode reports no capability columns, and `--variant` is provider-
    // specific. An effort picker that silently changes nothing is worse than
    // none at all.
    const models = parseOpencodeModels("anthropic/claude-opus-5\n");
    expect(models[0]).toMatchObject({ supportsEffort: false, effortLevels: [] });
  });

  it("drops everything that is not a model line", () => {
    const models = parseOpencodeModels([
      "",
      "  ",
      "Update available: 1.17.0",
      "/var/lib/opencode/log/2026-09-11.log",
      "warning: provider anthropic is not authenticated",
      "opencode/big-pickle",
    ].join("\n"));

    expect(models.map((m) => m.id)).toEqual(["opencode/big-pickle"]);
  });

  it("strips ANSI colour before matching", () => {
    const models = parseOpencodeModels("\u001b[32mopencode/big-pickle\u001b[0m\n");
    expect(models.map((m) => m.id)).toEqual(["opencode/big-pickle"]);
  });

  it("keeps the first of a repeated id", () => {
    const models = parseOpencodeModels("opencode/big-pickle\nopencode/big-pickle\n");
    expect(models).toHaveLength(1);
  });

  it("returns nothing for output that named no models", () => {
    // What a CLI that is installed but not signed in prints. An empty catalog
    // keeps the registry on its configured/synthesized fallback rather than
    // replacing it with nonsense.
    expect(parseOpencodeModels("no providers configured\n")).toEqual([]);
    expect(parseOpencodeModels("")).toEqual([]);
  });
});
