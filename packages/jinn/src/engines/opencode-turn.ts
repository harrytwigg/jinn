import type { EngineResult, StreamDelta } from "../shared/types.js";
import { isRateLimitMessage } from "../shared/rateLimit.js";
import { extractActivityReceiptId } from "../shared/activity-receipts.js";
import {
  asRecord,
  contextTokensFromStep,
  describeToolCall,
  numberOr,
  opencodeErrorText,
  parseEventLine,
  toolIdentity,
  trimmedString,
  type StepTokens,
} from "./opencode-protocol.js";

/**
 * One opencode turn, accumulated from its event stream.
 *
 * Separate from the engine because it is the half that can be tested without a
 * process: feed it the lines opencode actually prints and ask what the turn
 * became. The engine owns spawning, killing and timing out; this owns what the
 * turn MEANS, and the two meet at `readLine` and `result`.
 *
 * Transport-agnostic by construction — a local run and one carried over ssh
 * produce the same lines, so neither is special-cased here.
 */
export class OpencodeTurn {
  /** The answer: the last non-empty text part wins. */
  private resultText = "";
  private turnError: string | null = null;
  /** Model round trips. A turn that called tools has more than one. */
  private steps = 0;
  private cost = 0;
  private contextTokens: number | undefined;
  /** opencode assigns this; until it speaks, the id we asked it to resume. */
  private sessionId: string;

  constructor(resumeSessionId: string) {
    this.sessionId = resumeSessionId;
  }

  /** One stdout line of the JSON event stream. */
  readLine(line: string, onStream: ((delta: StreamDelta) => void) | null): void {
    const event = parseEventLine(line);
    if (!event) return;

    // Every event carries it, including the `error` one — so a turn that failed
    // before producing anything still reports the session it failed in, and the
    // next turn resumes rather than silently starting a new conversation.
    const sessionId = trimmedString(event.sessionID);
    if (sessionId) this.sessionId = sessionId;

    const part = asRecord(event.part) ?? {};
    switch (event.type) {
      case "text":
        this.readText(part, onStream);
        break;
      case "tool_use":
        this.readToolUse(part, onStream);
        break;
      case "step_finish":
        this.readStepFinish(part);
        break;
      case "error":
        this.turnError = opencodeErrorText(event) ?? "opencode reported an error with no message";
        break;
    }
  }

  private readText(part: Record<string, unknown>, onStream: ((delta: StreamDelta) => void) | null): void {
    const text = typeof part.text === "string" ? part.text : "";
    if (!text) return;
    // A turn that called tools emits one text part per step, and the answer is
    // the one after the last tool round trip.
    this.resultText = text;
    if (onStream) onStream({ type: "text", content: text });
  }

  private readToolUse(part: Record<string, unknown>, onStream: ((delta: StreamDelta) => void) | null): void {
    if (!onStream) return;
    const identity = toolIdentity(part);
    const state = asRecord(part.state) ?? {};

    onStream({
      type: "tool_use",
      content: describeToolCall(identity.toolName, asRecord(state.input)),
      ...identity,
    });

    // A tool part is reported at whatever state it reached. `pending` and
    // `running` have no output yet, so only the two terminal states produce a
    // result — verified against opencode's own status union.
    const status = trimmedString(state.status);
    if (status !== "completed" && status !== "error") return;
    const output = typeof state.output === "string" ? state.output : "";
    const activityReceiptId = extractActivityReceiptId(output, { isError: status === "error" });
    onStream({
      type: "tool_result",
      content: output.slice(0, 500),
      ...identity,
      ...(activityReceiptId ? { activityReceiptId } : {}),
    });
  }

  /** One model round trip finished. A turn is several of these, so cost
   *  ACCUMULATES and the context reading is whichever step spoke last. */
  private readStepFinish(part: Record<string, unknown>): void {
    this.steps += 1;
    this.cost += numberOr(part.cost, 0);
    const context = contextTokensFromStep(asRecord(part.tokens) as StepTokens | undefined);
    if (context !== undefined) this.contextTokens = context;
  }

  /** What this turn became, once the process is gone. */
  result(outcome: { code: number | null; terminationReason: string | null; stderr: string }): EngineResult {
    const accounting = {
      ...(this.steps > 0 ? { numTurns: this.steps } : {}),
      ...(this.cost > 0 ? { cost: this.cost } : {}),
      ...(this.contextTokens === undefined ? {} : { contextTokens: this.contextTokens }),
    };

    if (outcome.terminationReason) {
      return { sessionId: this.sessionId, result: "", error: outcome.terminationReason, ...accounting };
    }
    // A non-empty answer means the turn succeeded even if a benign error item
    // also appeared — don't surface it as a failure.
    if (this.resultText.trim()) {
      return { sessionId: this.sessionId, result: this.resultText, ...accounting };
    }

    const error = this.turnError
      || (outcome.code === 0
        ? "opencode exited successfully without a final assistant response"
        : `opencode exited with code ${outcome.code}: ${outcome.stderr.slice(0, 500)}`);
    return {
      sessionId: this.sessionId,
      result: "",
      error,
      ...accounting,
      // Said outright rather than left to be inferred from the text. A usage
      // limit that lands before the first step leaves zero cost and zero turns,
      // which is exactly the shape `isDeadSessionError` reads as a stale resume
      // id — and it is consulted BEFORE `detectRateLimit`, so without this the
      // session id would be wiped and the engine chain never walked.
      ...(isRateLimitMessage(error) ? { rateLimit: { status: "rejected" } } : {}),
    };
  }
}
