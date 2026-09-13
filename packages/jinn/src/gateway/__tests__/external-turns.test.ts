import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-external-turns-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../../sessions/registry.js");
type Ext = typeof import("../external-turns.js");
let reg: Reg;
let ext: Ext;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  ext = await import("../external-turns.js");
  (await import("../../shared/db.js")).initDb();
});

let seq = 0;
function makeSession(overrides: Partial<{ engineSessionId: string }> = {}): string {
  seq += 1;
  const s = reg.createSession({
    engine: "claude",
    source: "web",
    sourceRef: `web:ext-${seq}`,
    prompt: "test",
  });
  if (overrides.engineSessionId) reg.updateSession(s.id, { engineSessionId: overrides.engineSessionId });
  return s.id;
}

/** Write a transcript jsonl of [role, text, isoTs, extra] tuples. */
function writeTranscript(
  entries: Array<{
    type: string;
    text?: string;
    ts: string;
    sidechain?: boolean;
    meta?: boolean;
    toolResult?: boolean;
    promptSource?: string;
    sourceTool?: boolean;
    originKind?: string;
    synthetic?: boolean;
  }>,
): string {
  const file = path.join(tmp, `transcript-${++seq}.jsonl`);
  const lines = entries.map((e) =>
    JSON.stringify({
      type: e.type,
      timestamp: e.ts,
      isSidechain: e.sidechain ?? false,
      ...(e.meta ? { isMeta: true } : {}),
      ...(e.promptSource ? { promptSource: e.promptSource } : {}),
      ...(e.sourceTool ? { sourceToolAssistantUUID: "assistant-tool", toolUseResult: { ok: true } } : {}),
      ...(e.originKind ? { origin: { kind: e.originKind } } : {}),
      message: {
        role: e.type,
        ...(e.synthetic ? { model: "<synthetic>" } : {}),
        content: e.toolResult
          ? [{ type: "tool_result", content: "tool output" }]
          : [{ type: "text", text: e.text ?? "" }],
      },
    }),
  );
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe("readTranscriptTail", () => {
  it("returns user/assistant text entries newer than the anchor, skipping sidechain/meta/tool-result entries", () => {
    const file = writeTranscript([
      { type: "user", text: "old prompt", ts: iso(60_000) },
      { type: "user", text: "hello", ts: iso(10_000) },
      { type: "assistant", text: "sub-agent text", ts: iso(9_000), sidechain: true },
      { type: "user", ts: iso(8_000), toolResult: true },
      { type: "user", text: "meta entry", ts: iso(7_000), meta: true },
      { type: "assistant", text: "the answer", ts: iso(5_000) },
    ]);
    const tail = ext.readTranscriptTail(file, Date.now() - 30_000);
    expect(tail).not.toBeNull();
    expect(tail!.map((e) => [e.role, e.content])).toEqual([
      ["user", "hello"],
      ["assistant", "the answer"],
    ]);
  });

  it("skips Claude control, compaction, task-notification, and tool-result transcript entries", () => {
    const file = writeTranscript([
      { type: "user", text: "typed prompt", ts: iso(14_000), promptSource: "typed" },
      { type: "user", text: "This session is being continued from a previous conversation that ran out of context.", ts: iso(13_000) },
      { type: "user", text: "<command-name>/compact</command-name>", ts: iso(12_000) },
      { type: "user", text: "<local-command-stdout>Compacted</local-command-stdout>", ts: iso(11_000) },
      { type: "user", text: "<task-notification><result>done</result></task-notification>", ts: iso(10_000), originKind: "task-notification" },
      { type: "user", text: "📩 Employee \"worker\" replied in child session child-1.\n\nTo read the full reply: GET /api/sessions/child-1?last=20", ts: iso(9_500) },
      { type: "user", text: "⚠️ Employee \"worker\" (child session child-1) hit an error and could not finish: failed", ts: iso(9_400) },
      { type: "user", text: "📩 Thread \"worker\" reported back.\n\nReply preview:\ndone\n\nTo follow up, delegate to this thread via /api/talk/delegate.", ts: iso(9_300) },
      { type: "user", text: "tool result text", ts: iso(9_000), sourceTool: true },
      { type: "user", text: "system continuation", ts: iso(8_000), promptSource: "system" },
      { type: "assistant", text: "No response requested.", ts: iso(7_000), synthetic: true },
      { type: "assistant", text: "real answer", ts: iso(6_000) },
    ]);
    const tail = ext.readTranscriptTail(file, Date.now() - 30_000);
    expect(tail!.map((e) => [e.role, e.content])).toEqual([
      ["user", "typed prompt"],
      ["assistant", "real answer"],
    ]);
  });

  it("returns null (not []) when the file is unreadable", () => {
    expect(ext.readTranscriptTail(path.join(tmp, "nope.jsonl"), 0)).toBeNull();
  });
});

describe("syncExternalTurn", () => {
  let events: Array<{ event: string; payload: unknown }>;
  const emit = (event: string, payload: unknown) => events.push({ event, payload });
  beforeEach(() => { events = []; });

  it("persists the transcript tail in order, advances the anchor, adopts the engine session id, and emits", () => {
    const id = makeSession();
    const file = writeTranscript([
      { type: "user", text: "cli prompt", ts: iso(10_000) },
      { type: "assistant", text: "cli answer", ts: iso(5_000) },
    ]);
    const n = ext.syncExternalTurn(id, emit, {
      hook_event_name: "Stop",
      session_id: "eng-abc",
      transcript_path: file,
      last_assistant_message: "cli answer",
    });
    expect(n).toBe(2);
    expect(reg.getMessages(id).map((m) => [m.role, m.content])).toEqual([
      ["user", "cli prompt"],
      ["assistant", "cli answer"],
    ]);
    const session = reg.getSession(id)!;
    expect(session.engineSessionId).toBe("eng-abc");
    expect((session.transportMeta as any)?.[ext.TRANSCRIPT_SYNC_META_KEY]).toBeTruthy();
    expect(events).toEqual([{ event: "session:external-turn", payload: { sessionId: id } }]);
  });

  it("collapses a usage-limit retry storm — N identical adjacent user turns become one row, anchor still advances to the newest entry", () => {
    const id = makeSession();
    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    // The wait-and-retry loop re-sends the SAME prompt on every probe while the
    // limit never clears: the transcript accumulates identical user turns with
    // no assistant turn between them (the newest is the most recent probe).
    const file = writeTranscript([
      { type: "user", text: "BOUNDED review prompt", ts: at(50_000) },
      { type: "user", text: "BOUNDED review prompt", ts: at(40_000) },
      { type: "user", text: "BOUNDED review prompt", ts: at(30_000) },
      { type: "user", text: "BOUNDED review prompt", ts: at(20_000) },
      { type: "user", text: "BOUNDED review prompt", ts: at(10_000) },
    ]);
    const newest = at(10_000);
    const n = ext.syncExternalTurn(id, emit, {
      hook_event_name: "Stop",
      session_id: "eng-storm",
      transcript_path: file,
      last_assistant_message: "",
    });
    // One row, not five.
    expect(n).toBe(1);
    expect(reg.getMessages(id).map((m) => [m.role, m.content])).toEqual([
      ["user", "BOUNDED review prompt"],
    ]);
    // Anchor advanced to the NEWEST transcript entry (not the kept copy's older
    // timestamp) so the dropped duplicates are never re-read on the next sync.
    expect((reg.getSession(id)!.transportMeta as any)?.[ext.TRANSCRIPT_SYNC_META_KEY]).toBe(newest);
    // Re-running the same Stop inserts nothing.
    expect(ext.syncExternalTurn(id, emit, {
      hook_event_name: "Stop",
      session_id: "eng-storm",
      transcript_path: file,
      last_assistant_message: "",
    })).toBe(0);
    expect(reg.getMessages(id)).toHaveLength(1);
  });

  it("keeps distinct adjacent turns and a legitimately repeated question separated by a reply", () => {
    const id = makeSession();
    const file = writeTranscript([
      { type: "user", text: "what time is it?", ts: iso(40_000) },
      { type: "assistant", text: "3pm", ts: iso(35_000) },
      { type: "user", text: "what time is it?", ts: iso(30_000) },
      { type: "assistant", text: "3:01pm", ts: iso(25_000) },
    ]);
    const n = ext.syncExternalTurn(id, emit, {
      hook_event_name: "Stop",
      session_id: "eng-repeat",
      transcript_path: file,
      last_assistant_message: "3:01pm",
    });
    // The repeat is NOT collapsed — an assistant turn sits between the two.
    expect(n).toBe(4);
    expect(reg.getMessages(id).map((m) => [m.role, m.content])).toEqual([
      ["user", "what time is it?"],
      ["assistant", "3pm"],
      ["user", "what time is it?"],
      ["assistant", "3:01pm"],
    ]);
  });

  it("does not persist an unclaimed Claude transcript tail after the logical session switches engines", () => {
    const id = makeSession({ engineSessionId: "claude-old" });
    reg.switchSessionEngine(id, "codex", {
      model: "gpt-5.5",
      effortLevel: "medium",
    });
    const file = writeTranscript([
      { type: "user", text: "old claude prompt", ts: iso(10_000) },
      { type: "assistant", text: "old claude answer", ts: iso(5_000) },
    ]);

    const n = ext.syncExternalTurn(id, emit, {
      hook_event_name: "Stop",
      session_id: "claude-old",
      transcript_path: file,
      last_assistant_message: "old claude answer",
    });

    expect(n).toBe(0);
    expect(reg.getSession(id)?.engine).toBe("codex");
    expect(reg.getMessages(id)).toEqual([]);
    expect(events).toEqual([]);
  });

  it("is idempotent — a repeated Stop for the same turn inserts nothing (anchor dedup)", () => {
    const id = makeSession();
    const file = writeTranscript([
      { type: "user", text: "once", ts: iso(10_000) },
      { type: "assistant", text: "only once", ts: iso(5_000) },
    ]);
    const payload = { hook_event_name: "Stop", transcript_path: file, last_assistant_message: "only once" };
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(2);
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(0);
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(0);
    expect(reg.getMessages(id)).toHaveLength(2);
    expect(events).toHaveLength(1); // emitted only for the real insert
  });

  it("a later turn appended to the same transcript syncs incrementally", () => {
    const id = makeSession();
    const file = writeTranscript([
      { type: "user", text: "turn one", ts: iso(20_000) },
      { type: "assistant", text: "answer one", ts: iso(15_000) },
    ]);
    const payload = { hook_event_name: "Stop", transcript_path: file, last_assistant_message: "answer one" };
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(2);

    fs.appendFileSync(file, [
      JSON.stringify({ type: "user", timestamp: iso(8_000), isSidechain: false, message: { role: "user", content: [{ type: "text", text: "turn two" }] } }),
      JSON.stringify({ type: "assistant", timestamp: iso(4_000), isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "answer two" }] } }),
    ].join("\n") + "\n");
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(2);
    expect(reg.getMessages(id).map((m) => m.content)).toEqual(["turn one", "answer one", "turn two", "answer two"]);
  });

  it("without an anchor, entries older than the newest DB message are never re-inserted", () => {
    const id = makeSession();
    // A gateway-run turn already persisted its messages (DB insert time = now).
    reg.insertMessage(id, "user", "gateway prompt");
    reg.insertMessage(id, "assistant", "gateway answer");
    // The transcript holds that same (older) turn plus nothing new.
    const file = writeTranscript([
      { type: "user", text: "gateway prompt", ts: iso(10_000) },
      { type: "assistant", text: "gateway answer", ts: iso(5_000) },
    ]);
    const n = ext.syncExternalTurn(id, emit, { hook_event_name: "Stop", transcript_path: file, last_assistant_message: "gateway answer" });
    expect(n).toBe(0);
    expect(reg.getMessages(id)).toHaveLength(2);
  });

  it("skips a session whose run() is in flight (status running)", () => {
    const id = makeSession();
    reg.updateSession(id, { status: "running" });
    const file = writeTranscript([{ type: "assistant", text: "mid-turn", ts: iso(1_000) }]);
    expect(ext.syncExternalTurn(id, emit, { hook_event_name: "Stop", transcript_path: file, last_assistant_message: "mid-turn" })).toBe(0);
    expect(reg.getMessages(id)).toHaveLength(0);
  });

  it("falls back to the hook payload text when the transcript is unreadable — once", () => {
    const id = makeSession({ engineSessionId: "no-such-claude-session" });
    const payload = {
      hook_event_name: "Stop",
      transcript_path: path.join(tmp, "missing.jsonl"),
      last_assistant_message: "answer from hook",
    };
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(1);
    expect(reg.getMessages(id).map((m) => [m.role, m.content])).toEqual([["assistant", "answer from hook"]]);
    // Redelivered Stop with the same text → deduped against the newest message.
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(0);
    expect(reg.getMessages(id)).toHaveLength(1);
  });

  it("reconciles an already-persisted turn in place — newer continuation entries upgrade a truncated assistant row instead of duplicating (cutoff + dup fix)", () => {
    const id = makeSession();
    // run() completion already persisted this turn: user prompt + an assistant
    // row TRUNCATED at an early Stop (DB insert time = now).
    reg.insertMessage(id, "user", "hire token maxer");
    reg.insertMessage(id, "assistant", "On it.");
    // The Claude harness then wrote continuation entries for the SAME turn with
    // timestamps NEWER than the persist (so they slip past the timestamp anchor),
    // and the assistant text is now complete (a superset of the truncated row).
    const future = (ms: number) => new Date(Date.now() + ms).toISOString();
    const file = writeTranscript([
      { type: "user", text: "hire token maxer", ts: future(1_000) },
      { type: "assistant", text: "On it. Token Maxer hired — operations, reporting to chief-of-staff.", ts: future(2_000) },
    ]);
    const n = ext.syncExternalTurn(id, emit, {
      hook_event_name: "Stop",
      transcript_path: file,
      last_assistant_message: "On it. Token Maxer hired — operations, reporting to chief-of-staff.",
    });
    // No duplicate rows inserted...
    expect(n).toBe(0);
    const msgs = reg.getMessages(id);
    expect(msgs).toHaveLength(2);
    // ...and the truncated assistant row was upgraded to the complete text.
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ["user", "hire token maxer"],
      ["assistant", "On it. Token Maxer hired — operations, reporting to chief-of-staff."],
    ]);
    // Still emits so the chat view refetches the de-truncated content.
    expect(events).toEqual([{ event: "session:external-turn", payload: { sessionId: id } }]);
  });

  it("does not import an internal child callback prompt as a user message", () => {
    const id = makeSession();
    reg.insertMessage(id, "notification", "📩 worker replied in child session child-1");
    reg.insertMessage(id, "assistant", "I read the child reply and here is the summary.");
    const future = (ms: number) => new Date(Date.now() + ms).toISOString();
    const file = writeTranscript([
      { type: "user", text: "📩 Employee \"worker\" replied in child session child-1.\n\nTo read the full reply: GET /api/sessions/child-1?last=20", ts: future(1_000) },
      { type: "assistant", text: "I read the child reply and here is the summary.", ts: future(2_000) },
    ]);
    const n = ext.syncExternalTurn(id, emit, {
      hook_event_name: "Stop",
      transcript_path: file,
      last_assistant_message: "I read the child reply and here is the summary.",
    });
    expect(n).toBe(0);
    expect(reg.getMessages(id).map((m) => [m.role, m.content])).toEqual([
      ["notification", "📩 worker replied in child session child-1"],
      ["assistant", "I read the child reply and here is the summary."],
    ]);
  });

  it("reconciles already-persisted gateway turns even when a notification sits between the user and assistant rows", () => {
    const id = makeSession();
    reg.insertMessage(id, "user", "gateway prompt");
    reg.insertMessage(id, "notification", "background status");
    reg.insertMessage(id, "assistant", "gateway answer");
    const future = (ms: number) => new Date(Date.now() + ms).toISOString();
    const file = writeTranscript([
      { type: "user", text: "gateway prompt", ts: future(1_000) },
      { type: "assistant", text: "gateway answer", ts: future(2_000) },
    ]);
    const n = ext.syncExternalTurn(id, emit, {
      hook_event_name: "Stop",
      transcript_path: file,
      last_assistant_message: "gateway answer",
    });
    expect(n).toBe(0);
    expect(reg.getMessages(id).map((m) => [m.role, m.content])).toEqual([
      ["user", "gateway prompt"],
      ["notification", "background status"],
      ["assistant", "gateway answer"],
    ]);
  });

  it("can mark a gateway-owned Claude transcript as synced through its latest timestamp", () => {
    const engineSessionId = `eng-${++seq}`;
    const id = makeSession({ engineSessionId });
    const file = path.join(tmp, `${engineSessionId}.jsonl`);
    const latest = iso(1_000);
    fs.writeFileSync(file, [
      JSON.stringify({ type: "user", timestamp: iso(2_000), message: { role: "user", content: [{ type: "text", text: "prompt" }] } }),
      JSON.stringify({ type: "assistant", timestamp: latest, message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
    ].join("\n") + "\n");
    ext.markTranscriptSyncedThrough(id, engineSessionId, file);
    expect((reg.getSession(id)!.transportMeta as any)?.[ext.TRANSCRIPT_SYNC_META_KEY]).toBe(latest);
  });

  it("does not mistake a genuinely new CLI turn for an already-persisted one (different content → normal insert)", () => {
    const id = makeSession();
    reg.insertMessage(id, "user", "first prompt");
    reg.insertMessage(id, "assistant", "first answer");
    const future = (ms: number) => new Date(Date.now() + ms).toISOString();
    const file = writeTranscript([
      { type: "user", text: "second prompt", ts: future(1_000) },
      { type: "assistant", text: "second answer", ts: future(2_000) },
    ]);
    const n = ext.syncExternalTurn(id, emit, {
      hook_event_name: "Stop",
      transcript_path: file,
      last_assistant_message: "second answer",
    });
    expect(n).toBe(2);
    expect(reg.getMessages(id).map((m) => m.content)).toEqual([
      "first prompt", "first answer", "second prompt", "second answer",
    ]);
  });

  it("inserts only the new message when the tail carries an already-persisted one ahead of it (partial overlap)", () => {
    const id = makeSession();
    // run() persisted this turn, but the anchor landed older than its own
    // assistant entry — so the tail re-reads that entry AND the next turn's.
    reg.insertMessage(id, "user", "ship the autopilot");
    reg.insertMessage(id, "assistant", "Autopilot engaged.");
    const future = (ms: number) => new Date(Date.now() + ms).toISOString();
    const newestIso = future(2_000);
    const file = writeTranscript([
      { type: "assistant", text: "Autopilot engaged.", ts: future(1_000) },
      { type: "assistant", text: "Autopilot's first move done.", ts: newestIso },
    ]);
    const payload = {
      hook_event_name: "Stop",
      transcript_path: file,
      last_assistant_message: "Autopilot's first move done.",
    };
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(1);
    expect(reg.getMessages(id).map((m) => [m.role, m.content])).toEqual([
      ["user", "ship the autopilot"],
      ["assistant", "Autopilot engaged."],
      ["assistant", "Autopilot's first move done."],
    ]);
    // Anchor advanced past the new entry, so an immediate repeat is a no-op.
    expect((reg.getSession(id)!.transportMeta as any)?.[ext.TRANSCRIPT_SYNC_META_KEY]).toBe(newestIso);
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(0);
    expect(reg.getMessages(id)).toHaveLength(3);
  });

  it("upgrades a truncated row on the partial-overlap path and appends only the new message", () => {
    const id = makeSession();
    reg.insertMessage(id, "user", "hire a reviewer");
    reg.insertMessage(id, "assistant", "On it.");
    const future = (ms: number) => new Date(Date.now() + ms).toISOString();
    const file = writeTranscript([
      { type: "assistant", text: "On it. Reviewer hired.", ts: future(1_000) },
      { type: "assistant", text: "Reviewer is on the first queue item.", ts: future(2_000) },
    ]);
    const n = ext.syncExternalTurn(id, emit, {
      hook_event_name: "Stop",
      transcript_path: file,
      last_assistant_message: "Reviewer is on the first queue item.",
    });
    expect(n).toBe(1);
    expect(reg.getMessages(id).map((m) => [m.role, m.content])).toEqual([
      ["user", "hire a reviewer"],
      ["assistant", "On it. Reviewer hired."],
      ["assistant", "Reviewer is on the first queue item."],
    ]);
  });

  it("does not swallow a repeated prompt that matches mid-history — the new turn inserts both messages", () => {
    const id = makeSession();
    reg.insertMessage(id, "user", "continue");
    reg.insertMessage(id, "assistant", "old answer");
    const future = (ms: number) => new Date(Date.now() + ms).toISOString();
    const file = writeTranscript([
      { type: "user", text: "continue", ts: future(1_000) },
      { type: "assistant", text: "new answer", ts: future(2_000) },
    ]);
    const n = ext.syncExternalTurn(id, emit, {
      hook_event_name: "Stop",
      transcript_path: file,
      last_assistant_message: "new answer",
    });
    expect(n).toBe(2);
    expect(reg.getMessages(id).map((m) => [m.role, m.content])).toEqual([
      ["user", "continue"],
      ["assistant", "old answer"],
      ["user", "continue"],
      ["assistant", "new answer"],
    ]);
  });
});

describe("syncExternalTurn — waking the parent (GEN-66)", () => {
  // The production shape: a delegated child whose gateway turn settled (settle
  // callback sent), whose PTY then kept producing Stops because Claude Code
  // re-invoked the model each time a background subagent finished. Those Stops
  // are unclaimed and land here. The session ran on a remote build host, so the
  // gateway cannot read its transcript — the hook-payload fallback is the path
  // that lost senior-developer-qa's final report on 2026-09-13.
  let events: Array<{ event: string; payload: unknown }>;
  const emit = (event: string, payload: unknown) => events.push({ event, payload });
  const originalFetch = globalThis.fetch;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    events = [];
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** A settled child of `parent` with a live attempt token, as settleTurn leaves it. */
  function makeSettledChild(parentId: string, employee = "senior-developer-qa"): string {
    const child = reg.createSession({
      engine: "claude",
      source: "web",
      sourceRef: `web:child-${++seq}`,
      prompt: "review this",
      parentSessionId: parentId,
      employee,
    });
    reg.beginSessionAttempt(child.id);
    const token = reg.getSession(child.id)!.attemptToken!;
    reg.completeSessionAttempt(child.id, token, { status: "idle", attemptOutcome: "succeeded" });
    return child.id;
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

  it("wakes the parent from the hook-payload fallback path, once per distinct reply", async () => {
    const parentId = makeSession();
    const childId = makeSettledChild(parentId);
    const stop = (text: string) => ({
      hook_event_name: "Stop",
      transcript_path: path.join(tmp, "on-the-remote-host.jsonl"),
      last_assistant_message: text,
    });

    expect(ext.syncExternalTurn(childId, emit, stop("Adversarial reviewer still running; I'll merge and report when it lands."))).toBe(1);
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Redelivered Stop: nothing persisted, nobody woken.
    expect(ext.syncExternalTurn(childId, emit, stop("Adversarial reviewer still running; I'll merge and report when it lands."))).toBe(0);
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The final report.
    expect(ext.syncExternalTurn(childId, emit, stop("# GEN-64 round 5: Changes required\n\nP1 …"))).toBe(1);
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const calls = fetchSpy.mock.calls.map(([url, opts]) => ({ url, body: JSON.parse(opts.body) }));
    expect(calls.every((c) => c.url.endsWith(`/api/sessions/${parentId}/message`))).toBe(true);
    expect(calls.every((c) => c.body.role === "notification")).toBe(true);
    expect(calls[0].body.message).toContain("Adversarial reviewer still running");
    expect(calls[1].body.message).toContain("# GEN-64 round 5: Changes required");
    expect(calls[1].body.displayMessage).toMatch(/^📩 senior-developer-qa replied\n/);
    expect(calls[1].body.meta).toMatchObject({ kind: "child-reply", employee: "senior-developer-qa", childSessionId: childId });

    // Each wake has its own durable receipt, distinct from the settle callback's identity.
    const deliveries = reg.listPendingSessionDeliveries().concat(
      calls.map((c) => reg.getSessionDelivery(c.body.callbackDeliveryId)!),
    );
    const attempts = new Set(deliveries.map((d) => d.sourceAttempt));
    expect(attempts.size).toBe(2);
    const token = reg.getSession(childId)!.attemptToken!;
    for (const attempt of attempts) expect(attempt.startsWith(`${token}:external:`)).toBe(true);
    expect(deliveries.every((d) => d.deliveryKind === "parent-external-turn")).toBe(true);
  });

  it("wakes the parent from the transcript path with the newest assistant entry, and not for reconciled gateway turns", async () => {
    const parentId = makeSession();
    const childId = makeSettledChild(parentId);
    reg.updateSession(childId, { engineSessionId: "eng-child" });
    // What run() persisted at settle.
    reg.insertMessage(childId, "user", "review this");
    reg.insertMessage(childId, "assistant", "Own findings are drafted; persona reviewers still running.");
    const settledAt = Date.now();

    // The continuation: Claude Code's task notification (control text — skipped)
    // and the model's reply.
    const file = writeTranscript([
      { type: "user", text: "review this", ts: new Date(settledAt - 60_000).toISOString() },
      { type: "assistant", text: "Own findings are drafted; persona reviewers still running.", ts: new Date(settledAt - 50_000).toISOString() },
      { type: "user", text: "<task-notification>agent done</task-notification>", ts: new Date(settledAt + 1_000).toISOString(), originKind: "task-notification" },
      { type: "assistant", text: "Merged. Verdict: pass.", ts: new Date(settledAt + 2_000).toISOString() },
    ]);
    const n = ext.syncExternalTurn(childId, emit, { hook_event_name: "Stop", session_id: "eng-child", transcript_path: file, last_assistant_message: "Merged. Verdict: pass." });
    expect(n).toBe(1);
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).message).toContain("Merged. Verdict: pass.");

    // Same Stop again: anchor dedup, no second wake.
    expect(ext.syncExternalTurn(childId, emit, { hook_event_name: "Stop", session_id: "eng-child", transcript_path: file, last_assistant_message: "Merged. Verdict: pass." })).toBe(0);
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not wake anyone for a session without a parent, nor when the employee has alwaysNotify: false", async () => {
    const orphan = makeSession({ engineSessionId: "no-such-claude-session" });
    expect(ext.syncExternalTurn(orphan, emit, { hook_event_name: "Stop", transcript_path: path.join(tmp, "missing.jsonl"), last_assistant_message: "typed in the terminal" })).toBe(1);

    const parentId = makeSession();
    const quiet = makeSettledChild(parentId, "quiet-worker");
    expect(ext.syncExternalTurn(quiet, emit, { hook_event_name: "Stop", transcript_path: path.join(tmp, "missing.jsonl"), last_assistant_message: "quiet reply" }, {
      resolveEmployee: (slug) => (slug === "quiet-worker" ? { id: slug, name: slug, alwaysNotify: false } as any : undefined),
    })).toBe(1);

    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reg.getMessages(orphan)).toHaveLength(1);
    expect(reg.getMessages(quiet)).toHaveLength(1);
  });

  it("an explicit send_to_session relay suppresses exactly one later wake", async () => {
    const parentId = makeSession();
    const childId = makeSettledChild(parentId);
    const token = reg.getSession(childId)!.attemptToken!;
    reg.recordChildReportedToParent(childId, token);
    const stop = (text: string) => ({ hook_event_name: "Stop", transcript_path: path.join(tmp, "missing.jsonl"), last_assistant_message: text });

    expect(ext.syncExternalTurn(childId, emit, stop("Findings sent to senior-developer."))).toBe(1);
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((reg.getSession(childId)!.transportMeta as any)?.reportedToParentAttempt).toBeUndefined();

    expect(ext.syncExternalTurn(childId, emit, stop("Post-pass commit verified; pass stands."))).toBe(1);
    await flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
