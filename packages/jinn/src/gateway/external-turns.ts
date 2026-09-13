import fs from "node:fs";
import { logger } from "../shared/logger.js";
import { getSession, getMessages, insertMessage, updateMessageContent, updateSession, type SessionMessage } from "../sessions/registry.js";
import { notifyParentOfExternalTurn } from "../sessions/callbacks.js";
import { initDb } from "../shared/db.js";
import { findTranscriptForSession } from "../engines/claude-interactive.js";
import type { HookPayload } from "./hook-registry.js";
import type { GatewayEmit } from "../shared/gateway-events.js";
import type { Employee, Session } from "../shared/types.js";

/**
 * External-turn sync: persist turns that happened OUTSIDE a gateway run() —
 * i.e. typed directly into the CLI/xterm PTY view — into the gateway messages
 * DB, so chat mode shows them.
 *
 * Anchor mechanism: `transportMeta.transcriptSyncedThrough` holds the ISO
 * timestamp of the newest transcript entry already persisted by this sync.
 * Each sync reads the Claude transcript tail (entries strictly newer than the
 * anchor), inserts the user+assistant messages in order, and advances the
 * anchor — so a repeated Stop (or a sync racing the on-load safety net) can
 * never double-insert. NOTE: this is deliberately NOT `claudeSyncSince` — that
 * key drives the opposite direction (DB messages → injected into Claude's
 * prompt after a rate-limit engine-override revert) and is consumed/deleted by
 * the next Claude run, so it can't serve as a durable transcript anchor.
 *
 * When the anchor is absent (first external turn for a session), the last DB
 * message's insert time is used instead: every transcript entry of an already-
 * persisted turn predates the DB insert of that turn's final assistant message,
 * so gateway-run history is never re-inserted.
 */
export const TRANSCRIPT_SYNC_META_KEY = "transcriptSyncedThrough";

/** One user/assistant text entry from the transcript tail. */
export interface TranscriptTailEntry {
  role: "user" | "assistant";
  content: string;
  /** Entry's transcript timestamp (epoch ms). */
  timestampMs: number;
  /** Same timestamp, original ISO form (becomes the new anchor). */
  timestampIso: string;
}

function isControlText(content: string): boolean {
  const t = content.trim();
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<local-command-") ||
    t.startsWith("<task-notification>") ||
    isInternalNotificationPrompt(t) ||
    t.startsWith("This session is being continued from a previous conversation")
  );
}

function isInternalNotificationPrompt(content: string): boolean {
  const t = content.trim();
  return (
    (
      t.startsWith("📩 Employee ") &&
      t.includes(" replied in child session ") &&
      t.includes("To read the full reply:")
    ) ||
    (
      t.startsWith("⚠️ Employee ") &&
      t.includes(" (child session ") &&
      t.includes(" hit an error and could not finish:")
    ) ||
    (
      t.startsWith("📩 Thread ") &&
      t.includes(" reported back.") &&
      t.includes("To follow up,")
    ) ||
    (
      t.startsWith("⚠️ Thread ") &&
      t.includes(" hit an error.") &&
      t.includes("Tell the operator plainly")
    )
  );
}

export function isPersistableClaudeTranscriptEntry(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;
  const type = obj?.type;
  if (type !== "user" && type !== "assistant") return false;
  if (obj.isSidechain === true || obj.isMeta === true) return false;
  if (obj.sourceToolAssistantUUID || obj.toolUseResult) return false;
  if (obj.promptSource === "system") return false;
  if (obj?.origin?.kind === "task-notification") return false;
  if (obj?.message?.model === "<synthetic>") return false;
  const raw = obj?.message?.content;
  if (typeof raw === "string" && isControlText(raw)) return false;
  return true;
}

export function transcriptEntryText(obj: any): { role: "user" | "assistant"; content: string } | null {
  if (!isPersistableClaudeTranscriptEntry(obj)) return null;
  let content = obj?.message?.content;
  if (Array.isArray(content)) {
    content = content
      .filter((b: Record<string, unknown>) => b?.type === "text")
      .map((b: Record<string, unknown>) => String(b.text ?? ""))
      .join("");
  }
  if (typeof content !== "string" || !content.trim()) return null;
  if (isControlText(content)) return null;
  return { role: obj.type, content: content.trim() };
}

/**
 * Parse the user/assistant text entries of a Claude transcript newer than
 * `sinceMs`. Sidechain (sub-agent) and meta entries are skipped; array content
 * is reduced to its text blocks (tool_use/tool_result blocks drop out, exactly
 * like the full-transcript backfill in api.ts). Returns `null` when the file
 * can't be read — callers distinguish "unreadable" from "nothing new".
 */
export function readTranscriptTail(transcriptPath: string, sinceMs: number): TranscriptTailEntry[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }
  const entries: TranscriptTailEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: any;
    try { obj = JSON.parse(t); } catch { continue; }
    const iso = obj.timestamp;
    if (typeof iso !== "string") continue;
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms <= sinceMs) continue;
    const text = transcriptEntryText(obj);
    if (!text) continue;
    entries.push({ ...text, timestampMs: ms, timestampIso: iso });
  }
  return entries;
}

/**
 * Collapse runs of byte-identical adjacent entries (same role + same content)
 * down to their first occurrence. A genuine conversation never contains two
 * identical adjacent turns with no differing turn between them; this shape is
 * produced only by the usage-limit wait-and-retry loop, which re-sends the
 * SAME prompt to the CLI on every probe (rate-limit-handler.ts) — each probe
 * appends another copy of the user turn to the transcript while the assistant
 * turn never lands, so the tail arrives here as N identical user entries.
 * Without this, the tail sync mirrors all N into the messages table in one
 * burst (observed: 355 identical rows). The kept entry retains the FIRST
 * timestamp; the anchor still advances to the last entry's timestamp via the
 * caller, so nothing is re-read on the next sync.
 */
function collapseAdjacentDuplicates(entries: TranscriptTailEntry[]): TranscriptTailEntry[] {
  const out: TranscriptTailEntry[] = [];
  for (const e of entries) {
    const prev = out[out.length - 1];
    if (prev && prev.role === e.role && prev.content === e.content) continue;
    out.push(e);
  }
  return out;
}

function anchorMsFor(session: { transportMeta: unknown }, sessionId: string): number {
  const meta = (session.transportMeta || {}) as Record<string, unknown>;
  const anchorIso = meta[TRANSCRIPT_SYNC_META_KEY];
  if (typeof anchorIso === "string") {
    const ms = new Date(anchorIso).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  // No anchor yet — fall back to the newest DB message's insert time (0 = empty
  // session, i.e. sync the whole transcript, equivalent to a backfill).
  const messages = getMessages(sessionId);
  return messages.length > 0 ? messages[messages.length - 1].timestamp : 0;
}

function setAnchor(sessionId: string, anchorIso: string): void {
  const live = getSession(sessionId);
  if (!live) return;
  const meta = (live.transportMeta && typeof live.transportMeta === "object" && !Array.isArray(live.transportMeta))
    ? { ...(live.transportMeta as Record<string, unknown>) }
    : {};
  meta[TRANSCRIPT_SYNC_META_KEY] = anchorIso;
  updateSession(sessionId, {
    transportMeta: meta as any,
    lastActivity: new Date().toISOString(),
  });
}

function latestTranscriptTimestampIso(transcriptPath: string): string | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return undefined;
  }
  let latestMs = 0;
  let latestIso: string | undefined;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj: any;
    try { obj = JSON.parse(t); } catch { continue; }
    const iso = obj?.timestamp;
    if (typeof iso !== "string") continue;
    const ms = new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms <= latestMs) continue;
    latestMs = ms;
    latestIso = iso;
  }
  return latestIso;
}

/** Mark a Claude transcript as already owned by the gateway completion path. */
export function markTranscriptSyncedThrough(sessionId: string, engineSessionId?: string, transcriptPathOverride?: string): void {
  const session = getSession(sessionId);
  if (!session || session.engine !== "claude") return;
  const sid = engineSessionId || session.engineSessionId || undefined;
  const transcriptPath = transcriptPathOverride || (sid ? findTranscriptForSession(sid) : undefined);
  const anchorIso = transcriptPath ? latestTranscriptTimestampIso(transcriptPath) : undefined;
  setAnchor(sessionId, anchorIso ?? new Date().toISOString());
}

function contentCompatible(persisted: string, transcript: string): boolean {
  return persisted === transcript || persisted.startsWith(transcript) || transcript.startsWith(persisted);
}

function rolesCompatible(message: SessionMessage, entry: TranscriptTailEntry): boolean {
  if (message.role === entry.role) return true;
  return message.role === "notification" && entry.role === "user" && isInternalNotificationPrompt(entry.content);
}

function findPersistedSequence(existing: SessionMessage[], entries: TranscriptTailEntry[]): SessionMessage[] | null {
  const recent = existing.filter((m) => !m.partial).slice(-Math.max(50, entries.length * 4));
  const matched: SessionMessage[] = [];
  let cursor = 0;
  for (const entry of entries) {
    let found: SessionMessage | undefined;
    for (; cursor < recent.length; cursor += 1) {
      const candidate = recent[cursor];
      if (rolesCompatible(candidate, entry) && contentCompatible(candidate.content, entry.content)) {
        found = candidate;
        cursor += 1;
        break;
      }
    }
    if (!found) return null;
    matched.push(found);
  }
  return matched;
}

/**
 * Longest run of TRAILING persisted rows mirroring the LEADING tail entries.
 * Covers the partial overlap `findPersistedSequence` rejects: when the anchor
 * lands older than the assistant entry run() already persisted, the next tail
 * arrives as [already-persisted message, genuinely new message] and the
 * all-or-nothing match returns null, so the insert writes the persisted message
 * a second time.
 *
 * The match must END at the last persisted row. A free-floating longest-prefix
 * match would fire mid-history too: with rows [user "continue", assistant
 * "old"] and a real new turn [user "continue", assistant "new"], it would treat
 * the repeated prompt as already persisted and insert only the reply, dropping
 * the operator's message. End-anchored, that case finds no overlap and takes
 * the normal insert.
 */
function trailingPersistedPrefix(existing: SessionMessage[], entries: TranscriptTailEntry[]): SessionMessage[] {
  const recent = existing.filter((m) => !m.partial);
  for (let length = Math.min(recent.length, entries.length); length > 0; length -= 1) {
    const candidate = recent.slice(-length);
    const mirrors = candidate.every(
      (m, i) => rolesCompatible(m, entries[i]) && contentCompatible(m.content, entries[i].content),
    );
    if (mirrors) return candidate;
  }
  return [];
}

/** Overwrite each persisted row truncated at an early Stop with its complete transcript text. */
function upgradeTruncatedRows(persisted: SessionMessage[], entries: TranscriptTailEntry[]): void {
  persisted.forEach((row, i) => {
    const entry = entries[i];
    if (row.role === entry.role && entry.content.length > row.content.length) {
      updateMessageContent(row.id, entry.content);
    }
  });
}

export interface SyncExternalTurnOptions {
  /** Employee lookup for the parent wake's `alwaysNotify` (the same switch the
   *  settle callback honours). Absent, or returning undefined, means notify. */
  resolveEmployee?: (slug: string) => Employee | undefined;
}

/**
 * A child session's reply that run() never saw is still a reply its parent is
 * waiting for. Wake the parent the way settleTurn would have, keyed on the sync
 * anchor so a redelivered Stop cannot wake it twice. Fire-and-forget: the sync
 * has already persisted the turn, and the callback module owns retry.
 */
function wakeParentForExternalReply(
  session: Session,
  newest: { role: "user" | "assistant"; content: string } | undefined,
  turnKey: string,
  options?: SyncExternalTurnOptions,
): void {
  if (!session.parentSessionId || newest?.role !== "assistant") return;
  const employee = session.employee ? options?.resolveEmployee?.(session.employee) : undefined;
  void notifyParentOfExternalTurn(session, newest.content, turnKey, { alwaysNotify: employee?.alwaysNotify });
}

/**
 * Persist any un-synced transcript tail for a session into the messages DB.
 * Primary trigger: an unclaimed Stop hook (PTY-native turn — no run() in
 * flight). Also callable without a payload as the on-load safety net.
 *
 * Returns the number of messages inserted. Emits `session:external-turn`
 * `{ sessionId }` when anything was persisted (the frontend refetches messages
 * on it). When the newest persisted message is an assistant reply and the
 * session has a parent, the parent is woken exactly as it would have been had
 * the reply settled a gateway turn — Claude Code re-invokes the model after a
 * background subagent finishes, and that continuation's Stop lands here, not in
 * settleTurn; before this the child's final report was persisted to its own
 * chat and the parent slept through it (GEN-66).
 */
export function syncExternalTurn(
  sessionId: string,
  emit: GatewayEmit,
  payload?: HookPayload,
  options?: SyncExternalTurnOptions,
): number {
  const session = getSession(sessionId);
  if (!session) {
    logger.info(`External-turn sync skipped: session ${sessionId} not found`);
    return 0;
  }
  // A run() owns the session — its completion path persists the turn.
  if (session.status === "running") return 0;
  // This sync is Claude-transcript-specific. Once the logical session has moved
  // to another engine, an unclaimed old Claude Stop must not append stale rows.
  if (session.engine !== "claude") return 0;

  const engineSessionId =
    (typeof payload?.session_id === "string" && payload.session_id) ||
    session.engineSessionId ||
    undefined;
  const transcriptPath =
    (typeof payload?.transcript_path === "string" && fs.existsSync(payload.transcript_path)
      ? payload.transcript_path
      : undefined) ?? (engineSessionId ? findTranscriptForSession(engineSessionId) : undefined);

  const anchorMs = anchorMsFor(session, sessionId);
  const entries = transcriptPath ? readTranscriptTail(transcriptPath, anchorMs) : null;

  if (entries === null) {
    // Transcript missing/unreadable. Better than dropping the turn: persist the
    // assistant text straight from the hook payload (no user prompt available)
    // and advance the anchor to now so a redelivered Stop can't duplicate it.
    const hookText = String(payload?.last_assistant_message ?? "").trim();
    if (!hookText) return 0;
    // Anchor can't dedup this path (no transcript timestamps) — guard against a
    // redelivered Stop by comparing against the newest persisted message.
    const existing = getMessages(sessionId);
    const newest = existing[existing.length - 1];
    if (newest && newest.role === "assistant" && newest.content === hookText) return 0;
    insertMessage(sessionId, "assistant", hookText);
    const anchorIso = new Date().toISOString();
    setAnchor(sessionId, anchorIso);
    emit("session:external-turn", { sessionId });
    logger.info(
      `External turn persisted for session ${sessionId} from hook payload (transcript unreadable: ${transcriptPath ?? "not found"})`,
    );
    wakeParentForExternalReply(session, { role: "assistant", content: hookText }, anchorIso, options);
    return 1;
  }
  if (entries.length === 0) return 0; // tail already synced — dedup no-op

  // The newest transcript entry is the anchor target regardless of the collapse
  // below: advancing the anchor to a dropped duplicate's (earlier) timestamp
  // would let the next sync re-read the very copies we just discarded.
  const tailAnchorIso = entries[entries.length - 1].timestampIso;
  // Collapse usage-limit retry storms — N byte-identical adjacent turns — to one.
  const tail = collapseAdjacentDuplicates(entries);

  // Reconcile against the trailing DB rows before inserting. The chat run()
  // completion path (manager.ts user prompt + settled assistant) may have
  // ALREADY persisted this exact turn — and, because the Claude harness keeps
  // writing continuation entries ("Continue from where you left off." + more
  // assistant text) with timestamps NEWER than that persist, those entries slip
  // past the timestamp anchor and this sync re-reads the same turn. The settled
  // assistant row is often truncated at an early Stop, so the re-read text is a
  // superset (prefix-compatible). When the trailing rows mirror the tail in role
  // order and are prefix-compatible, UPGRADE them in place (fixes the cutoff)
  // instead of inserting duplicates (fixes the duplication). Otherwise this is a
  // genuine CLI-native turn run() never saw — insert it, minus any leading
  // messages the trailing DB rows already hold.
  const db = initDb();
  const existing = getMessages(sessionId);
  const matchedPersistedTurn = findPersistedSequence(existing, tail);
  if (matchedPersistedTurn) {
    // run() already stored this turn — overwrite any truncated row with the
    // complete transcript text, write no new rows.
    const txn = db.transaction(() => {
      upgradeTruncatedRows(matchedPersistedTurn, tail);
    });
    txn();
    setAnchor(sessionId, tailAnchorIso);
    emit("session:external-turn", { sessionId });
    logger.info(
      `Reconciled ${tail.length} already-persisted turn message(s) in place for session ${sessionId} (anchor → ${tailAnchorIso}, no duplicates inserted)`,
    );
    return 0;
  }
  // The tail may still OPEN with rows run() already persisted and continue with
  // genuinely new ones. Reconcile that overlap in place and insert only the
  // remainder, or those rows get written a second time.
  const alreadyPersisted = trailingPersistedPrefix(existing, tail);
  const fresh = tail.slice(alreadyPersisted.length);
  // One transaction for the upgrades plus the inserts (mirrors the transcript backfill).
  const txn = db.transaction((items: TranscriptTailEntry[]) => {
    upgradeTruncatedRows(alreadyPersisted, tail);
    for (const e of items) insertMessage(sessionId, e.role, e.content);
  });
  txn(fresh);
  // A PTY-native first turn means the DB may not know the engine session yet —
  // adopt it so future resumes/backfills/syncs target the right transcript.
  if (!session.engineSessionId && engineSessionId) {
    updateSession(sessionId, { engineSessionId });
  }
  setAnchor(sessionId, tailAnchorIso);
  emit("session:external-turn", { sessionId });
  logger.info(
    `Synced ${fresh.length} external (CLI-native) message(s) for session ${sessionId} (anchor → ${tailAnchorIso}` +
      `${alreadyPersisted.length > 0 ? `, ${alreadyPersisted.length} already-persisted message(s) reconciled in place` : ""})`,
  );
  wakeParentForExternalReply(session, fresh[fresh.length - 1], tailAnchorIso, options);
  return fresh.length;
}

/** Sessions with an in-flight on-load tail sync (mirrors backfillInProgress). */
const onLoadSyncInProgress = new Set<string>();

/**
 * On-load safety net: when serving session detail, fire-and-forget a tail sync
 * so a PTY-native turn whose Stop was missed entirely still lands. Cheap in the
 * common case — the transcript's mtime is compared against the anchor BEFORE
 * any parsing, so an untouched transcript costs one stat(). The GET itself is
 * never delayed; the frontend refetches on `session:external-turn`.
 */
export function scheduleOnLoadTailSync(
  sessionId: string,
  emit: GatewayEmit,
  options?: SyncExternalTurnOptions,
): void {
  if (onLoadSyncInProgress.has(sessionId)) return;
  onLoadSyncInProgress.add(sessionId);
  setImmediate(() => {
    try {
      const session = getSession(sessionId);
      if (!session || session.engine !== "claude" || session.status === "running") return;
      if (!session.engineSessionId) return;
      const transcriptPath = findTranscriptForSession(session.engineSessionId);
      if (!transcriptPath) return;
      const anchorMs = anchorMsFor(session, sessionId);
      try {
        if (fs.statSync(transcriptPath).mtimeMs <= anchorMs) return; // nothing new
      } catch {
        return;
      }
      syncExternalTurn(sessionId, emit, undefined, options);
    } catch (err) {
      logger.warn(`On-load transcript tail sync failed for session ${sessionId}: ${err instanceof Error ? err.message : err}`);
    } finally {
      onLoadSyncInProgress.delete(sessionId);
    }
  });
}
