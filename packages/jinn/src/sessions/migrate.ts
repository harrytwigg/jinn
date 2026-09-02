// Sessions-owned storage schema: the DDL for every table this module writes, the
// idempotent upgrade migrations that keep an existing home in step, and the
// callback_deliveries row model those migrations validate against. `shared/db.ts`
// sequences these; `registry.ts` runs the queries.
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { SessionDelivery, SessionDeliveryIdentity, SessionDeliveryPayload } from '../shared/types.js';

export const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  engine_session_id TEXT,
  engine_sessions TEXT,
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  connector TEXT,
  session_key TEXT,
  reply_context TEXT,
  message_id TEXT,
  transport_meta TEXT,
  employee TEXT,
  model TEXT,
  title TEXT,
  prompt_excerpt TEXT,
  parent_session_id TEXT,
  workflow_kind TEXT,
  workflow_id TEXT,
  workflow_name TEXT,
  workflow_run_id TEXT,
  workflow_trigger_source TEXT,
  workflow_phase_node_id TEXT,
  workflow_phase_name TEXT,
  workflow_phase_index INTEGER,
  workflow_phase_round INTEGER,
  workflow_phase_attempt INTEGER,
  user_id TEXT,
  status TEXT DEFAULT 'idle',
  attempt_outcome TEXT,
  attempt_token TEXT,
  attempt_terminal_version INTEGER NOT NULL DEFAULT 0,
  attempt_turn INTEGER NOT NULL DEFAULT 0,
  attempt_interruption_cause TEXT,
  attempt_interruption_turn INTEGER,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  last_error TEXT
)`;

export const CREATE_MESSAGES_TABLE = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL
)`;

export const CREATE_MESSAGES_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, timestamp)
`;

export const CREATE_MESSAGES_ORDER_INDEX = `
CREATE INDEX IF NOT EXISTS idx_messages_session_order ON messages (session_id, timestamp, seq)
`;

export const CREATE_SESSION_KEY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_session_key ON sessions (session_key, last_activity)
`;

/** Caller-supplied delegation idempotency keys map to one durable session. The
 * key stored in session_key is a scoped hash, so the unique index is both
 * restart-safe and safe to add to existing databases. */
export const CREATE_DELEGATION_IDEMPOTENCY_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_delegation_idempotency
  ON sessions (session_key) WHERE session_key LIKE 'delegation-idempotency:%'
`;

// Backs `ORDER BY last_activity DESC` in the session list (was a full scan + sort).
export const CREATE_LAST_ACTIVITY_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions (last_activity DESC)
`;

// Backs the children lookup (was a full-table deserialization + JS filter).
export const CREATE_PARENT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (parent_session_id)
`;

// Backs provenance filters and workflow-run grouping lookups without parsing the
// deterministic sourceRef. Partial because ordinary chats never carry a run id.
export const CREATE_WORKFLOW_RUN_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_workflow_run ON sessions (workflow_run_id)
  WHERE workflow_run_id IS NOT NULL
`;

// Backs the highly-selective status filter (running ~6 of 2.5k rows) used on
// every boot (recoverStaleSessions / getInterruptedSessions) and every
// status-reconciler tick (listSessions({status:'running'})) — all of which were
// SCANning the full sessions table. Composite with last_activity DESC so the
// status-filtered list read also gets its ORDER BY from the index.
export const CREATE_STATUS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status, last_activity DESC)
`;

// Backs the `WHERE partial = 1` hot path — the boot sweep (clearAllPartialMessages)
// and every turn-settle (deletePartialMessages / finalizePartialMessages /
// getPartialMessages), which were full-SCANning the (largest) messages table to
// touch a handful of live mid-turn rows. Partial index: only the tiny set of
// currently-partial rows is indexed, so it stays cheap regardless of history size.
export const CREATE_MESSAGES_PARTIAL_INDEX = `
DROP INDEX IF EXISTS idx_messages_partial;
CREATE INDEX IF NOT EXISTS idx_messages_partial_order
  ON messages (session_id, timestamp, COALESCE(seq, 0)) WHERE partial = 1
`;

export const CREATE_FILES_TABLE = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  mimetype TEXT,
  path TEXT,
  created_at TEXT NOT NULL
)
`;

// Generic key/value store for one-off migration progress flags (e.g. the FTS
// backfill watermark). Keep entries tiny — this is not a config table.
export const CREATE_META_TABLE = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
)
`;

export const CREATE_CHAT_PINS_TABLE = `
CREATE TABLE IF NOT EXISTS chat_pins (
  pin_key TEXT PRIMARY KEY,
  pinned_at TEXT NOT NULL
)
`;

function callbackDeliveriesTableSql(tableName = 'callback_deliveries'): string {
  return `
CREATE TABLE ${tableName} (
  id TEXT PRIMARY KEY,
  target_session_id TEXT NOT NULL CHECK (length(target_session_id) > 0 AND target_session_id = jinn_callback_identity(target_session_id)),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('session', 'workflow-run', 'heartbeat', 'work-item')),
  source_id TEXT NOT NULL CHECK (length(source_id) > 0 AND source_id = jinn_callback_identity(source_id)),
  source_attempt TEXT NOT NULL CHECK (length(source_attempt) > 0 AND source_attempt = jinn_callback_identity(source_attempt)),
  source_outcome TEXT NOT NULL CHECK (length(source_outcome) > 0 AND source_outcome = jinn_callback_identity(source_outcome)),
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  delivery_kind TEXT NOT NULL CHECK (length(delivery_kind) > 0 AND delivery_kind = jinn_callback_identity(delivery_kind)),
  payload TEXT NOT NULL CHECK (
    json_valid(payload)
    AND json_type(payload) = 'object'
    AND json_type(payload, '$.message') IS 'text'
    AND json_type(payload, '$.displayMessage') IS 'text'
  ),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dead_letter')),
  message_id TEXT,
  queue_item_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  last_error TEXT,
  dead_lettered_at INTEGER,
  created_at TEXT NOT NULL,
  accepted_at TEXT
)
`;
}

const CREATE_CALLBACK_DELIVERIES_TABLE = callbackDeliveriesTableSql();

const CALLBACK_DELIVERY_REQUIRED_COLUMNS = [
  'id',
  'target_session_id',
  'source_kind',
  'source_id',
  'source_attempt',
  'source_outcome',
  'source_version',
  'delivery_kind',
  'payload',
  'status',
  'message_id',
  'queue_item_id',
  'attempt_count',
  'next_attempt_at',
  'last_attempt_at',
  'last_error',
  'dead_lettered_at',
  'created_at',
  'accepted_at',
] as const;

export { CREATE_QUEUE_ITEMS_TABLE, migrateQueueItemsSchema } from './queue-items-schema.js';

// Backs listSessionsByWorkItem (the GRS-002 read-back path) and any future
// per-item session lookup. Partial: only sessions actually linked to an item.
export const CREATE_WORK_ITEM_SESSION_INDEX = `
CREATE INDEX IF NOT EXISTS idx_sessions_work_item ON sessions (work_item_id) WHERE work_item_id IS NOT NULL
`;

// Full-text search over message bodies. External-content FTS5 table (the index
// lives here; `content` is read back from `messages` via rowid for snippets), so
// it stays in lockstep with `messages` through the AI/AD/AU triggers below. Only
// user/assistant rows are indexed — notification/tool rows are deliberately
// excluded (they're machine chatter, not conversation). Pre-existing rows are
// seeded by a yielded backfill after listen(). While that backfill is in flight,
// the AD/AU triggers only issue an FTS delete for rowids known to be indexed:
// already-drained legacy rows or post-watermark rows owned by the AI trigger.
// This keeps legacy updates/deletes safe without blocking gateway boot.
const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages
WHEN new.role IN ('user','assistant') AND (
  COALESCE((SELECT value = '1' FROM meta WHERE key = 'fts_backfill_done'), 0)
  OR new.rowid <= COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_rowid') AS INTEGER), 0)
  OR new.rowid > COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_max') AS INTEGER), 0)
) BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages
WHEN old.role IN ('user','assistant') AND (
  COALESCE((SELECT value = '1' FROM meta WHERE key = 'fts_backfill_done'), 0)
  OR old.rowid <= COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_rowid') AS INTEGER), 0)
  OR old.rowid > COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_max') AS INTEGER), 0)
) BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content)
  SELECT 'delete', old.rowid, old.content
  WHERE old.role IN ('user','assistant') AND (
    COALESCE((SELECT value = '1' FROM meta WHERE key = 'fts_backfill_done'), 0)
    OR old.rowid <= COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_rowid') AS INTEGER), 0)
    OR old.rowid > COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_max') AS INTEGER), 0)
  );
  INSERT INTO messages_fts(rowid, content)
  SELECT new.rowid, new.content
  WHERE new.role IN ('user','assistant') AND (
    COALESCE((SELECT value = '1' FROM meta WHERE key = 'fts_backfill_done'), 0)
    OR new.rowid <= COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_rowid') AS INTEGER), 0)
    OR new.rowid > COALESCE(CAST((SELECT value FROM meta WHERE key = 'fts_backfill_max') AS INTEGER), 0)
  );
END;
`;

/**
 * Additive, nullable migration: add the `media` column to an existing messages
 * table. Safe to run repeatedly and on legacy DBs created before media support.
 */
export function migrateMessagesSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('media')) {
    database.exec('ALTER TABLE messages ADD COLUMN media TEXT');
  }
  // Mid-turn streaming: `partial=1` rows are the live blocks (text segments + tool
  // calls) persisted DURING a turn so a refresh restores in-progress output. They
  // are deleted at turn end and replaced by the single consolidated final message
  // (same end-state as before). `seq` orders blocks within a turn (timestamp ms
  // collides across blocks); `tool_call` carries the tool name so a reloaded tool
  // block renders as a tool card, matching the live stream. All additive/nullable.
  if (!colNames.has('partial')) {
    database.exec('ALTER TABLE messages ADD COLUMN partial INTEGER');
  }
  if (!colNames.has('seq')) {
    database.exec('ALTER TABLE messages ADD COLUMN seq INTEGER');
  }
  if (!colNames.has('tool_call')) {
    database.exec('ALTER TABLE messages ADD COLUMN tool_call TEXT');
  }
  if (!colNames.has('tool_id')) {
    database.exec('ALTER TABLE messages ADD COLUMN tool_id TEXT');
  }
  if (!colNames.has('blocks')) {
    database.exec('ALTER TABLE messages ADD COLUMN blocks TEXT');
  }
  if (!colNames.has('meta')) {
    database.exec('ALTER TABLE messages ADD COLUMN meta TEXT');
  }
}

export function migrateSessionsSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  const missingColumns: Array<[string, string, string?]> = [
    ['title', 'TEXT'],
    ['parent_session_id', 'TEXT'],
    ['workflow_kind', 'TEXT'],
    ['workflow_id', 'TEXT'],
    ['workflow_name', 'TEXT'],
    ['workflow_run_id', 'TEXT'],
    ['workflow_trigger_source', 'TEXT'],
    ['workflow_phase_node_id', 'TEXT'],
    ['workflow_phase_name', 'TEXT'],
    ['workflow_phase_index', 'INTEGER'],
    ['workflow_phase_round', 'INTEGER'],
    ['workflow_phase_attempt', 'INTEGER'],
    ['connector', 'TEXT'],
    ['session_key', 'TEXT'],
    ['reply_context', 'TEXT'],
    ['message_id', 'TEXT'],
    ['transport_meta', 'TEXT'],
    ['engine_sessions', 'TEXT'],
    ['total_cost', 'REAL', '0'],
    ['total_turns', 'INTEGER', '0'],
    ['effort_level', 'TEXT'],
    ['last_context_tokens', 'INTEGER'],
    ['user_id', 'TEXT'],
    // No backfill: pre-existing sessions stay NULL (no excerpt); only new sessions populate it.
    ['prompt_excerpt', 'TEXT'],
    // Work-item link (GRS-002). Nullable; NULL = unchanged legacy behavior. The
    // partial index idx_sessions_work_item is created in initDb.
    ['work_item_id', 'TEXT'],
    // WHY the session is linked to that Todo: 'execute' (the producer) or
    // 'review' (a reviewer delegated onto it). NULL is 'execute', so every
    // pre-existing link keeps exactly the meaning it had. Read by the
    // self-review ban and the status derivation — see work-items/link-role.ts.
    ['work_item_role', 'TEXT'],
    // Explicit latest-attempt receipt. NULL means no successful/failed terminal
    // engine result has been recorded; `idle` by itself is not completion proof.
    ['attempt_outcome', 'TEXT'],
    // Per-dispatch generation used for compare-and-set terminal writes.
    ['attempt_token', 'TEXT'],
    ['attempt_terminal_version', 'INTEGER NOT NULL', '0'],
    ['attempt_turn', 'INTEGER NOT NULL', '0'],
    ['attempt_interruption_cause', 'TEXT'],
    ['attempt_interruption_turn', 'INTEGER'],
    // Archive is reversible: retain the durable chat and only hide it from
    // normal list queries. NULL keeps all pre-existing sessions visible.
    ['archived_at', 'TEXT'],
  ];

  for (const [name, type, defaultVal] of missingColumns) {
    if (!colNames.has(name)) {
      const defaultClause = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
      database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}${defaultClause}`);
    }
  }

  const refreshedCols = database.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const refreshedNames = new Set(refreshedCols.map((c) => c.name));
  if (refreshedNames.has('session_key')) {
    database.exec(`UPDATE sessions SET session_key = COALESCE(session_key, source_ref) WHERE session_key IS NULL OR session_key = ''`);
  }
  if (refreshedNames.has('connector')) {
    database.exec(`UPDATE sessions SET connector = COALESCE(connector, source) WHERE connector IS NULL OR connector = ''`);
  }
}

export function getMeta(database: Database.Database, key: string): string | null {
  const row = database.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(database: Database.Database, key: string, value: string): void {
  database
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/**
 * Create the FTS5 search index + sync triggers, and record the backfill watermark.
 *
 * The triggers keep the index current for every message written from now on. Rows
 * that already existed before this table did are NOT seen by the triggers, so they
 * are seeded separately by the chunked backfill (`scheduleFtsBackfill`). To stop
 * the backfill from double-indexing rows the triggers also handle, we snapshot the
 * current MAX(rowid) here — synchronously, before any new insert can race in — and
 * the backfill only ever touches `rowid <= fts_backfill_max`. Anything above that
 * watermark is a brand-new row and belongs to the triggers.
 *
 * Idempotent: safe to run on every boot. On a DB where the backfill already
 * completed it is a no-op.
 */
export function migrateFtsSchema(database: Database.Database): void {
  database.exec(CREATE_META_TABLE);
  // Trigger definitions changed when the boot drain became asynchronous. Rebuild
  // them idempotently so upgraded databases get the guarded AD/AU behavior too;
  // CREATE TRIGGER IF NOT EXISTS alone would preserve the unsafe legacy bodies.
  database.exec(`
    DROP TRIGGER IF EXISTS messages_fts_ai;
    DROP TRIGGER IF EXISTS messages_fts_ad;
    DROP TRIGGER IF EXISTS messages_fts_au;
  `);
  database.exec(CREATE_FTS);
  // First time we see this DB and the backfill hasn't run: pin the watermark.
  if (getMeta(database, 'fts_backfill_done') !== '1' && getMeta(database, 'fts_backfill_max') === null) {
    const row = database.prepare('SELECT MAX(rowid) AS m FROM messages').get() as { m: number | null };
    setMeta(database, 'fts_backfill_max', String(row.m ?? 0));
    setMeta(database, 'fts_backfill_rowid', '0');
  }
}

export interface SessionDeliveryRow {
  id: string;
  targetSessionId: string;
  sourceKind: SessionDeliveryIdentity['sourceKind'];
  sourceId: string;
  sourceAttempt: string;
  sourceOutcome: string;
  sourceVersion: number;
  deliveryKind: string;
  payload: string;
  status: SessionDelivery['status'];
  messageId: string | null;
  queueItemId: string | null;
  attemptCount: number;
  nextAttemptAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  deadLetteredAt: number | null;
  createdAt: string;
  acceptedAt: string | null;
}

function hasSessionDeliveryConstraints(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, ' ').toLowerCase();
  const canonicalColumns = [
    'target_session_id',
    'source_id',
    'source_attempt',
    'source_outcome',
    'delivery_kind',
  ];
  return canonicalColumns.every((column) =>
    normalized.includes(`length(${column}) > 0 and ${column} = jinn_callback_identity(${column})`),
  )
    && normalized.includes("source_kind in ('session', 'workflow-run', 'heartbeat', 'work-item')")
    && normalized.includes('source_version >= 1')
    && normalized.includes('json_valid(payload)')
    && normalized.includes("json_type(payload) = 'object'")
    && normalized.includes("json_type(payload, '$.message') is 'text'")
    && normalized.includes("json_type(payload, '$.displaymessage') is 'text'")
    && normalized.includes("status in ('pending', 'accepted', 'dead_letter')")
    && normalized.includes('attempt_count >= 0');
}

/** Install the callback outbox atomically. A malformed pre-existing table is
 * never silently indexed: validation throws inside the transaction so any DDL
 * from this migration is rolled back as one unit. */
export function migrateCallbackDeliveriesSchema(database: Database.Database): void {
  database.pragma('busy_timeout = 10000');
  database.function('jinn_callback_identity', { deterministic: true }, canonicalCallbackIdentityText);
  const migrate = database.transaction(() => {
    const existing = database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'callback_deliveries'
    `).get() as { sql: string } | undefined;
    if (!existing) {
      database.exec(CREATE_CALLBACK_DELIVERIES_TABLE);
    } else {
      const columns = database.prepare('PRAGMA table_info(callback_deliveries)').all() as Array<{ name: string }>;
      const names = new Set(columns.map((column) => column.name));
      const legacyIdentity = [
        'parent_session_id',
        'child_session_id',
        'attempt_token',
        'terminal_outcome',
        'terminal_version',
        'callback_kind',
      ];
      const lifecycleRequired = [
        'id',
        'payload',
        'status',
        'message_id',
        'queue_item_id',
        'created_at',
        'accepted_at',
      ];
      const missingLifecycle = lifecycleRequired.filter((column) => !names.has(column));
      const hasLegacyIdentity = legacyIdentity.every((column) => names.has(column));
      const hasGenericIdentity = CALLBACK_DELIVERY_REQUIRED_COLUMNS.every((column) => names.has(column));
      if (missingLifecycle.length > 0 || (!hasLegacyIdentity && !hasGenericIdentity)) {
        throw new Error(`Incompatible callback_deliveries schema: missing ${missingLifecycle.join(', ') || 'delivery identity columns'}`);
      }
      if (hasLegacyIdentity || !hasSessionDeliveryConstraints(existing.sql)) {
        rebuildCallbackDeliveriesTable(database, names, hasLegacyIdentity ? 'legacy-session' : 'generic');
      }
    }
    const columns = database.prepare('PRAGMA table_info(callback_deliveries)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    const missing = CALLBACK_DELIVERY_REQUIRED_COLUMNS.filter((column) => !names.has(column));
    if (missing.length > 0) {
      throw new Error(`Incompatible callback_deliveries schema: missing ${missing.join(', ')}`);
    }
    ensureCallbackDeliveryIndexes(database);
    const identityColumns = database.prepare('PRAGMA index_info(uq_callback_delivery_identity)').all() as Array<{ name: string }>;
    const expectedIdentity = [
      'target_session_id',
      'source_kind',
      'source_id',
      'source_attempt',
      'source_outcome',
      'source_version',
      'delivery_kind',
    ];
    if (identityColumns.map((column) => column.name).join('|') !== expectedIdentity.join('|')) {
      throw new Error('Incompatible callback delivery identity index');
    }
    const indexList = database.prepare('PRAGMA index_list(callback_deliveries)').all() as Array<{ name: string; unique: number }>;
    if (indexList.find((index) => index.name === 'uq_callback_delivery_identity')?.unique !== 1) {
      throw new Error('Incompatible callback delivery identity uniqueness');
    }
    const pendingColumns = database.prepare('PRAGMA index_info(idx_callback_deliveries_pending)').all() as Array<{ name: string }>;
    const pendingSql = (database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_callback_deliveries_pending'
    `).get() as { sql: string } | undefined)?.sql.replace(/\s+/g, ' ').toLowerCase() ?? '';
    if (
      pendingColumns.map((column) => column.name).join('|') !== 'status|next_attempt_at|created_at'
      || !pendingSql.includes("where status = 'pending'")
    ) {
      throw new Error('Incompatible callback delivery pending index');
    }
    const installedSql = (database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'callback_deliveries'
    `).get() as { sql: string }).sql;
    if (!hasSessionDeliveryConstraints(installedSql)) {
      throw new Error('Incompatible callback_deliveries constraints');
    }
  });
  runImmediateMigrationWithRetry(migrate);
}

function ensureCallbackDeliveryIndexes(database: Database.Database): void {
  const expectedIdentity = [
    'target_session_id',
    'source_kind',
    'source_id',
    'source_attempt',
    'source_outcome',
    'source_version',
    'delivery_kind',
  ];
  const indexes = database.prepare('PRAGMA index_list(callback_deliveries)').all() as Array<{ name: string; unique: number }>;
  const identity = indexes.find((index) => index.name === 'uq_callback_delivery_identity');
  const identityColumns = identity
    ? database.prepare('PRAGMA index_info(uq_callback_delivery_identity)').all() as Array<{ name: string }>
    : [];
  if (
    identity
    && (identity.unique !== 1 || identityColumns.map((column) => column.name).join('|') !== expectedIdentity.join('|'))
  ) {
    database.exec('DROP INDEX uq_callback_delivery_identity');
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_callback_delivery_identity
      ON callback_deliveries (
        target_session_id,
        source_kind,
        source_id,
        source_attempt,
        source_outcome,
        source_version,
        delivery_kind
      )
  `);

  const refreshedIndexes = database.prepare('PRAGMA index_list(callback_deliveries)').all() as Array<{ name: string; unique: number }>;
  const pending = refreshedIndexes.find((index) => index.name === 'idx_callback_deliveries_pending');
  const pendingColumns = pending
    ? database.prepare('PRAGMA index_info(idx_callback_deliveries_pending)').all() as Array<{ name: string }>
    : [];
  const pendingSql = pending
    ? (database.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_callback_deliveries_pending'
      `).get() as { sql: string } | undefined)?.sql.replace(/\s+/g, ' ').toLowerCase() ?? ''
    : '';
  if (
    pending
    && (
      pending.unique !== 0
      || pendingColumns.map((column) => column.name).join('|') !== 'status|next_attempt_at|created_at'
      || !pendingSql.includes("where status = 'pending'")
    )
  ) {
    database.exec('DROP INDEX idx_callback_deliveries_pending');
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_callback_deliveries_pending
      ON callback_deliveries (status, next_attempt_at, created_at)
      WHERE status = 'pending'
  `);
}

export function canonicalCallbackIdentityText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFC').replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
    : '';
}

function rebuildCallbackDeliveriesTable(
  database: Database.Database,
  columns: Set<string>,
  shape: 'legacy-session' | 'generic',
): void {
  const rows = database.prepare('SELECT * FROM callback_deliveries ORDER BY created_at ASC, id ASC').all() as Array<Record<string, unknown>>;
  database.exec('DROP TABLE IF EXISTS callback_deliveries_v2');
  database.exec(callbackDeliveriesTableSql('callback_deliveries_v2'));
  const insert = database.prepare(`
    INSERT INTO callback_deliveries_v2 (
      id, target_session_id, source_kind, source_id, source_attempt, source_outcome,
      source_version, delivery_kind, payload, status, message_id, queue_item_id,
      attempt_count, next_attempt_at, last_attempt_at, last_error, dead_lettered_at,
      created_at, accepted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : String(row.id ?? randomUUID());
    const targetSessionId = canonicalCallbackIdentityText(
      shape === 'legacy-session' ? row.parent_session_id : row.target_session_id,
    );
    const sourceKind = shape === 'legacy-session' ? 'session' : canonicalCallbackIdentityText(row.source_kind);
    const sourceId = canonicalCallbackIdentityText(shape === 'legacy-session' ? row.child_session_id : row.source_id);
    const sourceAttempt = canonicalCallbackIdentityText(shape === 'legacy-session' ? row.attempt_token : row.source_attempt);
    const sourceOutcome = canonicalCallbackIdentityText(shape === 'legacy-session' ? row.terminal_outcome : row.source_outcome);
    const deliveryKind = canonicalCallbackIdentityText(shape === 'legacy-session' ? row.callback_kind : row.delivery_kind);
    const sourceVersion = Number(shape === 'legacy-session' ? row.terminal_version : row.source_version);
    const candidate: SessionDeliveryRow = {
      id,
      targetSessionId,
      sourceKind: sourceKind as SessionDeliveryIdentity['sourceKind'],
      sourceId,
      sourceAttempt,
      sourceOutcome,
      sourceVersion,
      deliveryKind,
      payload: typeof row.payload === 'string' ? row.payload : '',
      status: row.status as SessionDelivery['status'],
      messageId: (row.message_id ?? null) as string | null,
      queueItemId: (row.queue_item_id ?? null) as string | null,
      attemptCount: columns.has('attempt_count') ? Number(row.attempt_count ?? 0) : 0,
      nextAttemptAt: (columns.has('next_attempt_at') ? row.next_attempt_at ?? null : null) as number | null,
      lastAttemptAt: (columns.has('last_attempt_at') ? row.last_attempt_at ?? null : null) as number | null,
      lastError: (columns.has('last_error') ? row.last_error ?? null : null) as string | null,
      deadLetteredAt: (columns.has('dead_lettered_at') ? row.dead_lettered_at ?? null : null) as number | null,
      createdAt: row.created_at as string,
      acceptedAt: (row.accepted_at ?? null) as string | null,
    };
    let persisted = candidate;
    try {
      sessionDeliveryFromRow(candidate);
    } catch (error) {
      persisted = quarantinedMigrationDelivery(candidate, error instanceof Error ? error.message : String(error));
    }
    let values = sessionDeliveryInsertValues(persisted);
    try {
      insert.run(...values);
    } catch (error) {
      if (!(error instanceof Error) || !/unique constraint/i.test(error.message)) throw error;
      persisted = quarantinedMigrationDelivery(candidate, 'duplicate canonical session delivery identity during migration');
      values = sessionDeliveryInsertValues(persisted);
      insert.run(...values);
    }
  }
  database.exec(`
    DROP TABLE callback_deliveries;
    ALTER TABLE callback_deliveries_v2 RENAME TO callback_deliveries;
  `);
}

function sessionDeliveryInsertValues(row: SessionDeliveryRow): unknown[] {
  return [
    row.id,
    row.targetSessionId,
    row.sourceKind,
    row.sourceId,
    row.sourceAttempt,
    row.sourceOutcome,
    row.sourceVersion,
    row.deliveryKind,
    row.payload,
    row.status,
    row.messageId,
    row.queueItemId,
    row.attemptCount,
    row.nextAttemptAt,
    row.lastAttemptAt,
    row.lastError,
    row.deadLetteredAt,
    row.createdAt,
    row.acceptedAt,
  ];
}

function quarantinedMigrationDelivery(row: SessionDeliveryRow, diagnostic: string): SessionDeliveryRow {
  const safeId = canonicalCallbackIdentityText(row.id) || randomUUID();
  return {
    id: row.id,
    targetSessionId: `quarantined-target:${safeId}`,
    sourceKind: 'session',
    sourceId: `quarantined-source:${safeId}`,
    sourceAttempt: `quarantined-attempt:${safeId}`,
    sourceOutcome: 'quarantined',
    sourceVersion: 1,
    deliveryKind: 'quarantined',
    payload: JSON.stringify({ message: '', displayMessage: '' }),
    status: 'dead_letter',
    messageId: null,
    queueItemId: null,
    attemptCount: 0,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastError: `migration quarantine: ${diagnostic}`,
    deadLetteredAt: Date.now(),
    createdAt: typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt))
      ? row.createdAt
      : new Date().toISOString(),
    acceptedAt: null,
  };
}

export function sessionDeliveryFromRow(row: SessionDeliveryRow): SessionDelivery {
  if (row.deliveryKind === 'quarantined' || row.sourceOutcome === 'quarantined') {
    throw new Error(`Session delivery ${row.id} is quarantined${row.lastError ? `: ${row.lastError}` : ''}`);
  }
  const canonicalIdentity = canonicalSessionDeliveryIdentity(row);
  validateSessionDeliveryIdentity(canonicalIdentity);
  for (const field of [
    'targetSessionId',
    'sourceId',
    'sourceAttempt',
    'sourceOutcome',
    'deliveryKind',
  ] as const) {
    if (row[field] !== canonicalIdentity[field]) {
      throw new Error(`Callback delivery ${row.id} has noncanonical ${field}`);
    }
  }
  if (!Number.isInteger(row.sourceVersion) || row.sourceVersion < 1) {
    throw new Error(`Session delivery ${row.id} has an invalid source version`);
  }
  if (!['session', 'workflow-run', 'heartbeat', 'work-item'].includes(row.sourceKind)) {
    throw new Error(`Session delivery ${row.id} has an invalid source kind`);
  }
  if (!['pending', 'accepted', 'dead_letter'].includes(row.status)) {
    throw new Error(`Callback delivery ${row.id} has an invalid lifecycle status`);
  }
  if (!Number.isInteger(row.attemptCount) || row.attemptCount < 0) {
    throw new Error(`Callback delivery ${row.id} has an invalid attempt count`);
  }
  for (const [field, value] of Object.entries({
    nextAttemptAt: row.nextAttemptAt,
    lastAttemptAt: row.lastAttemptAt,
    deadLetteredAt: row.deadLetteredAt,
  })) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`Callback delivery ${row.id} has an invalid ${field}`);
    }
  }
  if (typeof row.createdAt !== 'string' || !row.createdAt || !Number.isFinite(Date.parse(row.createdAt))) {
    throw new Error(`Callback delivery ${row.id} has an invalid createdAt`);
  }
  for (const [field, value] of Object.entries({
    messageId: row.messageId,
    queueItemId: row.queueItemId,
    acceptedAt: row.acceptedAt,
    lastError: row.lastError,
  })) {
    if (value !== null && (typeof value !== 'string' || value.length === 0)) {
      throw new Error(`Callback delivery ${row.id} has an invalid ${field}`);
    }
  }
  if (row.acceptedAt !== null && !Number.isFinite(Date.parse(row.acceptedAt))) {
    throw new Error(`Callback delivery ${row.id} has an invalid acceptedAt`);
  }
  const createdAtMs = Date.parse(row.createdAt);
  const acceptedAtMs = row.acceptedAt === null ? null : Date.parse(row.acceptedAt);
  if (acceptedAtMs !== null && acceptedAtMs < createdAtMs) {
    throw new Error(`Callback delivery ${row.id} has acceptedAt before createdAt`);
  }
  if (row.deadLetteredAt !== null && row.deadLetteredAt < createdAtMs) {
    throw new Error(`Callback delivery ${row.id} has deadLetteredAt before createdAt`);
  }
  if (row.lastError !== null && row.lastError.trim() === '') {
    throw new Error(`Callback delivery ${row.id} has an empty lastError`);
  }
  if (row.attemptCount === 0 && (row.nextAttemptAt !== null || row.lastAttemptAt !== null || row.lastError !== null)) {
    throw new Error(`Callback delivery ${row.id} has attempt state without an attempt`);
  }
  if (row.attemptCount > 0 && row.lastAttemptAt === null) {
    throw new Error(`Callback delivery ${row.id} has an attempt without lastAttemptAt`);
  }
  if (row.status === 'pending' && row.attemptCount > 0 && row.nextAttemptAt === null) {
    throw new Error(`Callback delivery ${row.id} has a pending attempt without nextAttemptAt`);
  }
  if (row.lastAttemptAt !== null && row.lastAttemptAt < createdAtMs) {
    throw new Error(`Callback delivery ${row.id} has lastAttemptAt before createdAt`);
  }
  if (row.nextAttemptAt !== null && row.lastAttemptAt === null) {
    throw new Error(`Callback delivery ${row.id} has nextAttemptAt without lastAttemptAt`);
  }
  if (row.nextAttemptAt !== null && row.lastAttemptAt !== null && row.nextAttemptAt < row.lastAttemptAt) {
    throw new Error(`Callback delivery ${row.id} has nextAttemptAt before lastAttemptAt`);
  }
  if (row.status === 'accepted') {
    if (
      !row.messageId
      || !row.queueItemId
      || !row.acceptedAt
      || row.nextAttemptAt !== null
      || row.lastError !== null
      || row.deadLetteredAt !== null
    ) {
      throw new Error(`Callback delivery ${row.id} has an invalid accepted lifecycle`);
    }
    if (acceptedAtMs !== null && row.lastAttemptAt !== null && acceptedAtMs < row.lastAttemptAt) {
      throw new Error(`Callback delivery ${row.id} has acceptedAt before lastAttemptAt`);
    }
  } else if (row.messageId !== null || row.queueItemId !== null || row.acceptedAt !== null) {
    throw new Error(`Callback delivery ${row.id} has callback acceptance state before acceptance`);
  }
  if (row.status === 'dead_letter') {
    if (row.deadLetteredAt === null || row.nextAttemptAt !== null || !row.lastError) {
      throw new Error(`Callback delivery ${row.id} has an invalid dead-letter lifecycle`);
    }
    if (row.lastAttemptAt !== null && row.deadLetteredAt < row.lastAttemptAt) {
      throw new Error(`Callback delivery ${row.id} has deadLetteredAt before lastAttemptAt`);
    }
  }
  if (row.status === 'pending' && row.deadLetteredAt !== null) {
    throw new Error(`Callback delivery ${row.id} has dead-letter state while pending`);
  }
  if (row.status === 'pending' && row.lastError !== null && row.nextAttemptAt === null) {
    throw new Error(`Callback delivery ${row.id} has retry error without nextAttemptAt`);
  }
  let payload: SessionDeliveryPayload;
  try {
    payload = JSON.parse(row.payload) as SessionDeliveryPayload;
  } catch {
    throw new Error(`Callback delivery ${row.id} has invalid payload JSON`);
  }
  if (
    !payload
    || typeof payload !== 'object'
    || typeof payload.message !== 'string'
    || typeof payload.displayMessage !== 'string'
  ) {
    throw new Error(`Callback delivery ${row.id} has an invalid payload`);
  }
  return { ...row, payload };
}

export function canonicalSessionDeliveryIdentity(identity: SessionDeliveryIdentity): SessionDeliveryIdentity {
  return {
    targetSessionId: canonicalCallbackIdentityText(identity.targetSessionId),
    sourceKind: identity.sourceKind,
    sourceId: canonicalCallbackIdentityText(identity.sourceId),
    sourceAttempt: canonicalCallbackIdentityText(identity.sourceAttempt),
    sourceOutcome: canonicalCallbackIdentityText(identity.sourceOutcome),
    sourceVersion: identity.sourceVersion,
    deliveryKind: canonicalCallbackIdentityText(identity.deliveryKind),
  };
}

export function validateSessionDeliveryIdentity(identity: SessionDeliveryIdentity): void {
  for (const [name, value] of Object.entries({
    targetSessionId: identity.targetSessionId,
    sourceId: identity.sourceId,
    sourceAttempt: identity.sourceAttempt,
    sourceOutcome: identity.sourceOutcome,
    deliveryKind: identity.deliveryKind,
  })) {
    if (typeof value !== 'string' || !canonicalCallbackIdentityText(value)) throw new Error(`${name} is required for session delivery`);
  }
  if (!['session', 'workflow-run', 'heartbeat', 'work-item'].includes(identity.sourceKind)) {
    throw new Error('sourceKind is invalid for session delivery');
  }
  if (!Number.isInteger(identity.sourceVersion) || identity.sourceVersion < 1) {
    throw new Error('sourceVersion must be a positive integer for session delivery');
  }
}

export function runImmediateMigrationWithRetry<T>(migration: Database.Transaction<() => T>): T {
  return runSqliteBusyRetry(() => migration.immediate());
}

/** Error classes worth waiting out when several processes open one database.
 *
 *  SQLITE_BUSY is the obvious one. SQLITE_READONLY belongs here too, and only
 *  Windows shows why: `journal_mode = WAL` has to take a brief exclusive lock to
 *  rewrite the header, and when a peer holds the file at that instant SQLite
 *  reports "attempt to write a readonly database" rather than BUSY. Sixteen
 *  processes racing to initialize produced it roughly one run in five.
 *
 *  Retrying a database that is genuinely read-only — bad permissions, a
 *  read-only mount — costs the same bounded wait and then throws the identical
 *  error, so nothing is masked by including it. */
function isTransientSqliteError(code: string): boolean {
  return code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_READONLY');
}

/** How long to keep retrying transient contention before giving up.
 *
 *  A time budget rather than an attempt count, because the thing being waited
 *  out is a window of contention whose length has nothing to do with how many
 *  times we have asked. The previous fixed ladder spent ~1.76s on Windows and
 *  then threw; sixteen processes initializing one database on a CI runner held
 *  the lock for longer than that, so the ladder ran out mid-race.
 *
 *  Matched to the `busy_timeout` already set on the connection: SQLite waits ten
 *  seconds for a BUSY lock, so waiting a comparable span for the same class of
 *  contention is consistent rather than arbitrary. Only ever reached on an error
 *  path — a database that is genuinely read-only pays this once at boot and then
 *  fails with the same message it would have before.
 *
 *  This raises a ceiling; it does not remove one. Instrumented at six times CI's
 *  concurrency the loop still exhausts the full budget and throws, because no
 *  bounded wait can be sufficient for unbounded contention. Serializing
 *  initialization across processes is the fix that would not have a ceiling, and
 *  it is a larger change than this one. */
const SQLITE_RETRY_BUDGET_MS = process.platform === 'win32' ? 15_000 : 5_000;

export function runSqliteBusyRetry<T>(operation: () => T): T {
  // performance.now(), not Date.now(): this runs at process start and the sleep
  // below blocks the thread outright, so a backward wall-clock step during the
  // wait (w32time resyncing at boot, an NTP correction, a VM snapshot restore)
  // would extend a synchronous block by the size of the step, unbounded and
  // unlogged — the gateway would simply appear hung. A forward step would
  // silently truncate the budget instead. performance.now() is monotonic from
  // process start and immune to both.
  const deadline = performance.now() + SQLITE_RETRY_BUDGET_MS;
  let delayMs = 10;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
      const remainingMs = deadline - performance.now();
      if (!isTransientSqliteError(code) || remainingMs <= 0) throw error;
      // Jittered exponential backoff. Without the jitter, peers that collided
      // once back off by the same amount and collide again on every subsequent
      // attempt, which is how a ladder that looks generous still exhausts itself.
      const jittered = delayMs * (0.5 + Math.random());
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, Math.min(jittered, remainingMs)));
      delayMs = Math.min(delayMs * 2, 500);
    }
  }
}
