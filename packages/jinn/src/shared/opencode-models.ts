import { spawn, type ChildProcess } from "node:child_process";
import type { ModelInfo } from "./types.js";
import { logger } from "./logger.js";

/**
 * Dynamic model discovery for the opencode engine.
 *
 * `opencode models` prints one `provider/model` per line — every model the
 * INSTALLED CLI can actually reach, which is whichever providers the operator
 * authenticated (`opencode auth login`) plus whatever their config adds. Asking
 * opencode rather than any provider directly is what keeps the catalog honest:
 * a model never appears here for credentials this host does not hold.
 *
 * Nothing is claimed about capability. The output carries no columns — no
 * reasoning flag, no context window, no tool support — and `--variant` (the
 * reasoning-effort flag) is provider-specific with no list to validate against.
 * So no model here declares effort support: an effort picker that silently
 * changes nothing is worse than no picker, and a bad variant is an error the
 * turn discovers at the provider.
 */

/** One `provider/model` line. The model half may itself contain slashes
 *  (`openrouter/meta-llama/llama-4`), so only the FIRST slash is structural —
 *  the same split the engine does when handing `-m` back to opencode. */
const MODEL_LINE = /^([A-Za-z0-9_.-]+)\/(\S+)$/;

/**
 * Parse `opencode models` output.
 *
 * Deliberately strict about what counts as a model line. Anything opencode
 * prints alongside the list — an update notice, a provider warning, a stray
 * absolute path — either carries whitespace or does not start with a bare
 * provider segment, and is dropped rather than surfaced to the model picker as
 * a model nobody can select.
 */
export function parseOpencodeModels(output: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
    const match = MODEL_LINE.exec(line);
    if (!match) continue;

    const id = line;
    if (seen.has(id)) continue;
    seen.add(id);

    models.push({ id, label: match[2], supportsEffort: false, effortLevels: [] });
  }
  return models;
}

/** Discovery must never take the gateway with it: it runs on a timer, and an
 *  opencode that hangs is a reason to have no catalog, not a reason to stall. */
const DISCOVERY_TIMEOUT_MS = 14_000;

/** SIGTERM now, SIGKILL a second later if that was not enough. Returns the
 *  pending kill so a close that arrives first can cancel it. */
function killGracefully(proc: ChildProcess): NodeJS.Timeout {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  return setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }, 1000);
}

/** Everything `opencode models` printed, on either stream, or "" on any failure.
 *  The best-effort shape every other discovery in this directory uses. */
function captureOpencodeModels(bin: string): Promise<string> {
  return new Promise<string>((resolve) => {
    let out = "";
    let done = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (s: string) => {
      if (done) return;
      done = true;
      resolve(s);
    };
    const stopTimers = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    try {
      const proc = spawn(bin, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (out += d.toString()));
      timer = setTimeout(() => {
        killTimer = killGracefully(proc);
        finish(out);
      }, DISCOVERY_TIMEOUT_MS);
      proc.on("close", () => {
        stopTimers();
        finish(out);
      });
      proc.on("error", (e) => {
        stopTimers();
        logger.warn(`opencode models failed: ${e.message}`);
        finish("");
      });
    } catch (e) {
      stopTimers();
      logger.warn(`opencode models spawn failed: ${e instanceof Error ? e.message : e}`);
      finish("");
    }
  });
}

/** Run `opencode models` and return what the installed CLI exposes. */
export async function discoverOpencodeModels(bin: string): Promise<ModelInfo[]> {
  return parseOpencodeModels(await captureOpencodeModels(bin));
}
