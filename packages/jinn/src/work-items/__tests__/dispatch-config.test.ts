import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import type { JinnConfig } from "../../shared/types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-wi-dispatch-config-"));
process.env.JINN_HOME = tmp;
const skillsDir = path.join(tmp, "skills");
for (const name of ["dev-workflow", "browser-use"]) {
  fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n`);
}

type Store = typeof import("../store.js");
type DispatchConfig = typeof import("../dispatch-config.js");
let store: Store;
let dispatch: DispatchConfig;
let logger: typeof import("../../shared/logger.js").logger;

beforeAll(async () => {
  (await import("../../shared/db.js")).initDb();
  store = await import("../store.js");
  dispatch = await import("../dispatch-config.js");
  logger = (await import("../../shared/logger.js")).logger;
});

function config(): JinnConfig {
  return {
    engines: {
      default: "codex",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.6-sol" },
      pi: { bin: "pi", model: "ollama/gemma3:12b" },
    },
    models: {
      claude: { default: "opus", models: [{ id: "opus", supportsEffort: false }] },
      codex: { default: "gpt-5.6-sol", models: [{ id: "gpt-5.6-sol", supportsEffort: true, effortLevels: ["low", "high"] }] },
      pi: { default: "ollama/gemma3:12b", models: [{ id: "ollama/gemma3:12b", supportsEffort: false }] },
    },
  } as unknown as JinnConfig;
}

function todo(title: string, status?: "executing"): string {
  return store.createWorkItem({ title, source: "human", ...(status ? { status } : {}) }).id;
}

describe("skills are validated against the installed set when they are SET", () => {
  it("rejects a name no skills/ directory holds, names it, and writes nothing", () => {
    const id = todo("skills unknown");
    const result = dispatch.setTodoDispatchConfig(id, { skills: ["dev-workflow", "not-a-real-skill"] }, config());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("not-a-real-skill");
    // The valid entry is not named as a problem, and nothing was persisted.
    expect(result.ok === false && result.error).not.toContain("dev-workflow,");
    expect(dispatch.getTodoDispatchConfig(id)).toBeUndefined();
  });

  it("tells a caller that passed an MCP tool id that skills are not tools", () => {
    const id = todo("skills mcp tool");
    const result = dispatch.setTodoDispatchConfig(id, { skills: ["mcp__jinn__get_work_item"] }, config());

    expect(result.ok).toBe(false);
    const error = result.ok === false ? result.error : "";
    expect(error).toContain("mcp__jinn__get_work_item");
    expect(error).toMatch(/MCP tool/i);
    expect(error).toContain("SKILL.md");
    // Distinct from the unknown-name error: that one would say "unknown skill".
    expect(error).not.toMatch(/unknown skill/i);
    expect(dispatch.getTodoDispatchConfig(id)).toBeUndefined();
  });

  it("rejects a bare double-underscore name too — the mcp__ prefix is not the only spelling", () => {
    const id = todo("skills bare tool");
    const result = dispatch.setTodoDispatchConfig(id, { skills: ["jinn__get_work_item"] }, config());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/MCP tool/i);
  });

  it("persists a valid list and reads it back", () => {
    const id = todo("skills valid");
    const set = dispatch.setTodoDispatchConfig(id, { skills: ["dev-workflow", "browser-use"] }, config());

    expect(set.ok).toBe(true);
    expect(set.ok && set.config.skills).toEqual(["dev-workflow", "browser-use"]);
    expect(dispatch.getTodoDispatchConfig(id)?.skills).toEqual(["dev-workflow", "browser-use"]);
  });

  it("rejects a non-array and an over-long list without writing", () => {
    const id = todo("skills shape");
    expect(dispatch.setTodoDispatchConfig(id, { skills: "dev-workflow" }, config()).ok).toBe(false);
    expect(dispatch.setTodoDispatchConfig(id, { skills: Array(11).fill("dev-workflow") }, config()).ok).toBe(false);
    expect(dispatch.getTodoDispatchConfig(id)).toBeUndefined();
  });
});

describe("the engine/model override is validated when it is SET", () => {
  it("refuses a model the named engine's registry does not know", () => {
    const id = todo("override bad model");
    const result = dispatch.setTodoDispatchConfig(id, { engine: "claude", model: "gpt-5.6-sol" }, config());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("gpt-5.6-sol");
    expect(result.ok === false && result.error).toContain("claude");
    expect(dispatch.getTodoDispatchConfig(id)).toBeUndefined();
  });

  it("refuses an unknown engine, and a model with no engine to belong to", () => {
    const id = todo("override bad engine");
    expect(dispatch.setTodoDispatchConfig(id, { engine: "nonesuch", model: "opus" }, config()).ok).toBe(false);
    const modelOnly = dispatch.setTodoDispatchConfig(id, { model: "opus" }, config());
    expect(modelOnly.ok).toBe(false);
    expect(modelOnly.ok === false && modelOnly.error).toMatch(/needs an engine/);
    expect(dispatch.getTodoDispatchConfig(id)).toBeUndefined();
  });

  it("refuses a Pi model no registry knows, even though a new session would tolerate it", () => {
    const id = todo("override undiscovered pi model");
    const result = dispatch.setTodoDispatchConfig(id, { engine: "pi", model: "ollama/never-pulled" }, config());

    // A session starting this second can afford to wait for discovery; a stored
    // override cannot — its next attempt is hours away and nobody reads the log.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("ollama/never-pulled");
    expect(dispatch.getTodoDispatchConfig(id)).toBeUndefined();
  });

  it("accepts a Pi model the registry does know", () => {
    const id = todo("override discovered pi model");
    expect(dispatch.setTodoDispatchConfig(id, { engine: "pi", model: "ollama/gemma3:12b" }, config()).ok).toBe(true);
  });

  it("accepts an engine with a model that engine knows", () => {
    const id = todo("override good");
    const result = dispatch.setTodoDispatchConfig(id, { engine: "claude", model: "opus" }, config());

    expect(result.ok).toBe(true);
    expect(dispatch.getTodoDispatchConfig(id)).toMatchObject({ engine: "claude", model: "opus" });
  });

  it("is settable while the Todo is executing, and clears the old model when the engine changes", () => {
    const id = todo("override while executing", "executing");
    expect(dispatch.setTodoDispatchConfig(id, { engine: "codex", model: "gpt-5.6-sol" }, config()).ok).toBe(true);
    expect(store.getWorkItem(id)?.status).toBe("executing");

    // Moving to another engine must not carry gpt-5.6-sol across, which claude
    // does not know — the next attempt takes claude's default instead.
    const moved = dispatch.setTodoDispatchConfig(id, { engine: "claude" }, config());
    expect(moved.ok).toBe(true);
    expect(dispatch.getTodoDispatchConfig(id)).toMatchObject({ engine: "claude", model: null });
    expect(store.getWorkItem(id)?.status).toBe("executing");
  });

  it("clears the override when engine is set back to null", () => {
    const id = todo("override cleared");
    dispatch.setTodoDispatchConfig(id, { engine: "claude", model: "opus" }, config());
    expect(dispatch.setTodoDispatchConfig(id, { engine: null, model: null }, config()).ok).toBe(true);
    expect(dispatch.getTodoDispatchConfig(id)).toMatchObject({ engine: null, model: null });
  });
});

describe("autoStart is the Todo's opt-out of being auto-started on assignment (GEN-67)", () => {
  it("is absent until set, reads true by default, and false once opted out", async () => {
    const id = todo("auto-start default");
    expect(dispatch.getTodoDispatchConfig(id)).toBeUndefined();

    const set = dispatch.setTodoDispatchConfig(id, { autoStart: false }, config());
    expect(set.ok).toBe(true);
    expect(set.ok && set.config).toMatchObject({ skills: [], engine: null, model: null, autoStart: false });
    expect(dispatch.getTodoDispatchConfig(id)).toMatchObject({ autoStart: false });
    // Only the flag was set, so no dispatch row was minted for it.
    expect(store.getWorkItem(id)).toBeDefined();
    expect((await import("../../shared/db.js")).initDb()
      .prepare("SELECT COUNT(*) FROM work_item_dispatch WHERE work_item_id = ?").pluck().get(id)).toBe(0);
  });

  it("survives a later engine/skills patch, and an engine patch leaves it alone", () => {
    const id = todo("auto-start patch");
    dispatch.setTodoDispatchConfig(id, { autoStart: false }, config());
    const patched = dispatch.setTodoDispatchConfig(id, { skills: ["dev-workflow"], engine: "claude" }, config());
    expect(patched.ok && patched.config).toMatchObject({ skills: ["dev-workflow"], engine: "claude", autoStart: false });

    const restored = dispatch.setTodoDispatchConfig(id, { autoStart: true }, config());
    expect(restored.ok && restored.config).toMatchObject({ skills: ["dev-workflow"], engine: "claude", autoStart: true });
    expect(dispatch.getTodoDispatchConfig(id)).toMatchObject({ autoStart: true });
  });

  it("reads as a no-op dispatch preamble when the Todo has only opted out", () => {
    const id = todo("auto-start only");
    dispatch.setTodoDispatchConfig(id, { autoStart: false }, config());
    expect(dispatch.resolveTodoDispatch(id)).toEqual({ ok: true, preamble: { prefix: "", engine: null, model: null } });
  });
});

describe("skills are re-resolved at DISPATCH, against the workspace as it is then", () => {
  it("fails the dispatch when every requested skill has since been uninstalled, naming them", () => {
    const id = todo("dispatch all gone");
    expect(dispatch.setTodoDispatchConfig(id, { skills: ["dev-workflow", "browser-use"] }, config()).ok).toBe(true);

    fs.renameSync(path.join(skillsDir, "dev-workflow"), path.join(tmp, "moved-dev-workflow"));
    fs.renameSync(path.join(skillsDir, "browser-use"), path.join(tmp, "moved-browser-use"));
    try {
      const resolved = dispatch.resolveTodoDispatch(id);
      expect(resolved.ok).toBe(false);
      const error = resolved.ok === false ? resolved.error : "";
      expect(error).toContain("dev-workflow");
      expect(error).toContain("browser-use");
    } finally {
      fs.renameSync(path.join(tmp, "moved-dev-workflow"), path.join(skillsDir, "dev-workflow"));
      fs.renameSync(path.join(tmp, "moved-browser-use"), path.join(skillsDir, "browser-use"));
    }
  });

  it("proceeds with the survivors when only some are gone, and warns naming the ones that went", () => {
    const id = todo("dispatch some gone");
    expect(dispatch.setTodoDispatchConfig(id, { skills: ["dev-workflow", "browser-use"] }, config()).ok).toBe(true);

    fs.renameSync(path.join(skillsDir, "browser-use"), path.join(tmp, "gone-browser-use"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const resolved = dispatch.resolveTodoDispatch(id);
      expect(resolved.ok).toBe(true);
      const prefix = resolved.ok ? resolved.preamble.prefix : "";
      expect(prefix).toContain("skills/dev-workflow/SKILL.md");
      expect(prefix).not.toContain("browser-use");
      // A silently thinner prompt is how an attempt fails for a reason nobody
      // can see, so the missing name has to reach the log.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("browser-use");
      expect(warn.mock.calls[0]?.[0]).toContain(id);
    } finally {
      warn.mockRestore();
      fs.renameSync(path.join(tmp, "gone-browser-use"), path.join(skillsDir, "browser-use"));
    }
  });

  it("does not warn when every requested skill is still installed", () => {
    const id = todo("dispatch none gone");
    expect(dispatch.setTodoDispatchConfig(id, { skills: ["dev-workflow", "browser-use"] }, config()).ok).toBe(true);

    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(dispatch.resolveTodoDispatch(id).ok).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("carries every present skill into the prompt, and the override alongside it", () => {
    const id = todo("dispatch all present");
    dispatch.setTodoDispatchConfig(id, { skills: ["dev-workflow", "browser-use"], engine: "claude", model: "opus" }, config());

    const resolved = dispatch.resolveTodoDispatch(id);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.preamble.prefix).toContain("skills/dev-workflow/SKILL.md");
    expect(resolved.preamble.prefix).toContain("skills/browser-use/SKILL.md");
    expect(resolved.preamble).toMatchObject({ engine: "claude", model: "opus" });
  });

  it("is a no-op preamble for a Todo that has no dispatch config at all", () => {
    const resolved = dispatch.resolveTodoDispatch(todo("dispatch none"));
    expect(resolved).toEqual({ ok: true, preamble: { prefix: "", engine: null, model: null } });
  });
});
