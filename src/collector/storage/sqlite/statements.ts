/**
 * Prepared SQL statements for the SQLite storage backend.
 *
 * This module centralises every parameterised query used by the backend so
 * that:
 *
 * 1. **All SQL is in one place.** Reviewing the storage layer's SQL surface
 *    is a single-file read; `grep`-ing for a query shape never loses.
 * 2. **Every statement is parameterised.** Values are bound positionally
 *    (`?`), never spliced via string interpolation. This is the primary
 *    defence against SQL injection when handling user-controlled values
 *    (e.g. an FTS5 query string). See Requirement 12.1.
 * 3. **Preparation cost is paid once per backend instance.** `better-sqlite3`
 *    compiles a prepared statement against a specific `Database` handle, so
 *    the returned {@link Statements} object is bound to the handle passed
 *    to {@link prepareStatements}. A new handle needs its own call.
 *
 * ## Lazy preparation
 *
 * Statements are prepared lazily *at the module level*: nothing happens when
 * this file is imported. Preparation is triggered the first time the backend
 * calls {@link prepareStatements} — typically inside `openSqliteStorage` —
 * and runs exactly once per `Database` instance. Individual statement
 * objects are then reused across every method invocation for the lifetime
 * of that handle. Re-preparing on every call would be wasteful; re-preparing
 * on every *method* would add a cache lookup with no payoff.
 *
 * ## Row shapes
 *
 * The row-shape interfaces ({@link EventRow}, {@link MemoryRecordRow})
 * describe the tuple a `SELECT *` against the respective table produces, in
 * the column order declared by migration 0001. They are the internal
 * representation the backend decodes into `KiroMemEvent` / `MemoryRecord`
 * wire shapes; they are not exported beyond the storage layer.
 *
 * ## Parameter ordering
 *
 * Each statement's TSDoc notes the exact `?` parameter order required at
 * bind time so callers don't have to cross-reference the SQL. `better-
 * sqlite3` binds positionally; passing parameters in the wrong order is a
 * silent correctness bug that no type checker will catch.
 *
 * See:
 * - `.kiro/specs/event-schema-and-storage/design.md` § SQLite DDL
 *   (migration 0001) — the schema these statements target.
 * - `.kiro/specs/event-schema-and-storage/design.md` § searchMemoryRecords
 *   — the FTS5 and LIKE-fallback query shapes.
 * - Requirements 6.1–6.3, 7.1–7.2, 8.1, 8.3–8.5, 11.1, 11.2, 12.1, 12.2.
 *
 * @module
 */

// `better-sqlite3`'s default export is the `Database` *constructor*; the
// instance type and the `Statement` type live on the merged `BetterSqlite3`
// namespace. Importing the default as a type alias gives access to the
// namespace types without pulling the runtime module into the type graph.
import type BetterSqliteDatabase from 'better-sqlite3';

/** A live `better-sqlite3` database handle (instance type). */
type Database = BetterSqliteDatabase.Database;

/**
 * Typed alias over `better-sqlite3`'s `Statement`.
 *
 * The two type parameters mirror the upstream declaration:
 * - `BindParameters` — a tuple of the positional parameter types, in order.
 * - `Result` — the row shape produced by `get`/`all`/`iterate`; defaults to
 *   `unknown` for write statements (`INSERT`/`UPDATE`/`DELETE`) where the
 *   result type is irrelevant.
 */
type Statement<
  BindParameters extends unknown[],
  Result = unknown,
> = BetterSqliteDatabase.Statement<BindParameters, Result>;

/**
 * Raw row shape returned by any `SELECT` against the `events` table that
 * lists every column in the order declared in migration 0001.
 *
 * The `*_json` and `transaction_time` columns are stored opaquely at this
 * layer; the backend decodes them back into {@link
 * import('../../../types/schemas.js').KiroMemEvent} at the public seam
 * (`getEventById`). `transaction_time` is internal — it is persisted for
 * bi-temporal queries (v5+) but never surfaced on the public wire type.
 *
 * @see Requirements 6.1, 7.1, 11.1, 11.2
 */
// project_path column exists in the events table (migration 0003) but is intentionally absent from this row shape — the read path reconstitutes source.project_path from source_json. See Requirement 9.5.
export interface EventRow {
  event_id: string;
  parent_event_id: string | null;
  session_id: string;
  actor_id: string;
  namespace: string;
  schema_version: number;
  kind: string;
  body_json: string;
  valid_time: string;
  transaction_time: string;
  source_json: string;
  content_hash: string | null;
}

/**
 * Raw row shape returned by any `SELECT` against the `memory_records`
 * table that lists every column in the order declared in migrations 0001
 * and 0002.
 *
 * `facts_json`, `source_event_ids_json`, `concepts_json`, and
 * `files_touched_json` are JSON-encoded TEXT columns that the backend
 * decodes into `string[]` arrays on read. `observation_type` is a
 * TEXT column constrained by a `CHECK` to one of five enum values; see
 * migration 0002.
 *
 * @see Requirements 8.1, 8.3, 8.4
 */
export interface MemoryRecordRow {
  record_id: string;
  namespace: string;
  strategy: string;
  title: string;
  summary: string;
  facts_json: string;
  source_event_ids_json: string;
  created_at: string;
  concepts_json: string;
  files_touched_json: string;
  observation_type: string;
}

/**
 * Positional parameters bound to {@link Statements.insertEvent}, in SQL
 * order. Matches the column list in migration 0001's `events` table
 * plus migration 0003's `project_path` column.
 *
 * Tuple positions:
 * 1. `event_id`           — ULID primary key.
 * 2. `parent_event_id`    — optional ULID or `null`.
 * 3. `session_id`
 * 4. `actor_id`
 * 5. `namespace`          — trailing-slash form enforced upstream.
 * 6. `schema_version`     — `1` in v1.
 * 7. `kind`               — one of `prompt | tool_use | session_summary | note`.
 * 8. `body_json`          — `JSON.stringify(event.body)`.
 * 9. `valid_time`         — ISO 8601 UTC.
 * 10. `transaction_time`  — ISO 8601 UTC, stamped by the backend.
 * 11. `source_json`       — `JSON.stringify(event.source)`.
 * 12. `content_hash`      — optional `sha256:<hex>` digest, or `null`.
 * 13. `project_path`      — optional resolved project root, or `null`.
 *                            Denormalised projection of `source.project_path`
 *                            for indexed aggregation; read path reads from
 *                            `source_json`, not this column.
 */
type InsertEventParams = [
  eventId: string,
  parentEventId: string | null,
  sessionId: string,
  actorId: string,
  namespace: string,
  schemaVersion: number,
  kind: string,
  bodyJson: string,
  validTime: string,
  transactionTime: string,
  sourceJson: string,
  contentHash: string | null,
  projectPath: string | null,
];

/**
 * Positional parameters bound to {@link Statements.insertMemoryRecord}, in
 * SQL order. Matches the column list in migrations 0001 + 0002 (the
 * primary row; the FTS row is written by a separate statement).
 */
type InsertMemoryRecordParams = [
  recordId: string,
  namespace: string,
  strategy: string,
  title: string,
  summary: string,
  factsJson: string,
  sourceEventIdsJson: string,
  createdAt: string,
  conceptsJson: string,
  filesTouchedJson: string,
  observationType: string,
];

/**
 * Positional parameters bound to {@link Statements.insertMemoryRecordFts}.
 *
 * The FTS5 virtual table carries `record_id` and `namespace` as
 * `UNINDEXED` columns (for join-back and prefix filtering) alongside the
 * indexed `title`, `summary`, and `facts_text` columns.
 *
 * Tuple positions:
 * 1. `record_id`  — same value as the primary row; join key.
 * 2. `namespace`  — carried for prefix filtering in `MATCH` queries.
 * 3. `title`
 * 4. `summary`
 * 5. `facts_text` — the memory record's `facts` array joined into a single
 *                   searchable blob (e.g. `facts.join(' ')`).
 */
type InsertMemoryRecordFtsParams = [
  recordId: string,
  namespace: string,
  title: string,
  summary: string,
  factsText: string,
];

/**
 * Positional parameters for {@link Statements.selectMemoryRecordsFtsMatch}.
 *
 * The bound values are, in order:
 * 1. The sanitised FTS5 query string — already quoted and escaped by
 *    `sanitizeForFts5`. Passed through the `MATCH` operator; must never
 *    be spliced into SQL as raw syntax.
 * 2. The namespace prefix — used with `LIKE ? || '%'` to enforce
 *    isolation. `|| '%'` here is a *SQL string concatenation*, not a
 *    dangerous string build: the value side of the `LIKE` remains a bound
 *    parameter.
 * 3. The result limit (> 0, enforced upstream).
 *
 * @see Requirements 8.3, 8.4, 12.1, 12.2
 */
type SelectMemoryRecordsFtsMatchParams = [
  escapedQuery: string,
  namespacePrefix: string,
  limit: number,
];

/**
 * Positional parameters for {@link Statements.selectMemoryRecordsLike}.
 *
 * Tuple positions:
 * 1. The namespace prefix — paired with `LIKE ? || '%'` as in the FTS
 *    path; guarantees isolation even on the fallback.
 * 2. The title pattern — typically `'%' + escaped_query + '%'` (caller is
 *    responsible for applying LIKE wildcards + escaping, since LIKE's
 *    special chars — `%`, `_`, `\` — differ from FTS5's).
 * 3. The summary pattern — same shape as the title pattern.
 * 4. The result limit (> 0, enforced upstream).
 *
 * @see Requirements 8.5, 12.1
 */
type SelectMemoryRecordsLikeParams = [
  namespacePrefix: string,
  titlePattern: string,
  summaryPattern: string,
  limit: number,
];

/**
 * The complete set of prepared statements used by the SQLite backend. One
 * instance is produced per open `Database` via {@link prepareStatements}.
 *
 * Every field is the result of a single `db.prepare(...)` call. Writes
 * (`INSERT`) return plain `unknown` results — the backend inspects
 * `RunResult.changes` from `stmt.run(...)` when it needs to distinguish a
 * fresh insert from an `INSERT OR IGNORE` no-op.
 *
 * @see Requirements 6.1, 6.2, 6.3, 7.1, 7.2, 8.1, 8.3, 8.4, 8.5, 11.1, 11.2
 */
export interface Statements {
  /**
   * Insert a new event row. Uses `INSERT OR IGNORE` as the idempotency
   * primitive — a collision on the `event_id` primary key is silently
   * dropped so the caller's retry is a safe no-op. `RunResult.changes`
   * reports `0` in that case and `1` on a fresh insert.
   *
   * @see Requirements 6.1, 6.2, 6.3, 9.1, 9.2, 9.3, 11.1, 11.2, 12.1
   */
  insertEvent: Statement<InsertEventParams>;

  /**
   * Fetch a single event row by primary key. Returns `undefined` via
   * `stmt.get(...)` when no row matches; the backend maps that to `null`
   * on the public return type.
   *
   * @see Requirements 7.1, 7.2
   */
  selectEventById: Statement<[eventId: string], EventRow>;

  /**
   * Insert the primary row of a memory record. Paired with
   * {@link insertMemoryRecordFts} inside a single transaction at the
   * backend layer so both rows land atomically (requirement 8.1).
   *
   * No `OR IGNORE`: a collision on `record_id` is a bug upstream, not
   * something to silently swallow, so the backend lets the
   * `SQLITE_CONSTRAINT_PRIMARYKEY` error propagate.
   *
   * @see Requirements 8.1, 8.2, 12.1
   */
  insertMemoryRecord: Statement<InsertMemoryRecordParams>;

  /**
   * Insert the companion FTS5 index row for a memory record. Always run in
   * the same transaction as {@link insertMemoryRecord}.
   *
   * @see Requirements 8.1, 12.1
   */
  insertMemoryRecordFts: Statement<InsertMemoryRecordFtsParams>;

  /**
   * FTS5-powered search: returns rows whose `memory_records_fts` entry
   * `MATCH`-es the (sanitised) query and whose namespace starts with the
   * given prefix, ordered by FTS5 rank (best match first).
   *
   * The `memory_records_fts MATCH ?` form uses the virtual table name
   * directly — FTS5 requires the table name on the left of `MATCH`, and
   * an alias is not accepted. Parameters are still fully bound.
   *
   * @see Requirements 8.3, 8.4, 12.1, 12.2
   */
  selectMemoryRecordsFtsMatch: Statement<SelectMemoryRecordsFtsMatchParams, MemoryRecordRow>;

  /**
   * LIKE-based fallback search. Invoked by the backend only when the FTS5
   * path throws (e.g. FTS5 rejects a malformed query). Ordered by
   * `created_at DESC` since rank is unavailable — the contract is
   * "availability over rank quality" (Requirement 8.5).
   *
   * Namespace prefix isolation is preserved via the same `LIKE ? || '%'`
   * shape as the FTS path.
   *
   * @see Requirements 8.5, 12.1
   */
  selectMemoryRecordsLike: Statement<SelectMemoryRecordsLikeParams, MemoryRecordRow>;
}

/**
 * Prepare every statement in {@link Statements} against a single `Database`
 * handle.
 *
 * The returned object is bound to `db`: passing it to another handle will
 * fail at call time. Re-running `prepareStatements` on the same handle
 * produces a fresh set of statements — usually not what you want, since
 * each prepared statement holds a compiled byte-code form that `better-
 * sqlite3` would have to re-compile.
 *
 * **Preconditions.**
 * - `db` is open.
 * - Migrations have been applied so the `events`, `memory_records`, and
 *   `memory_records_fts` tables exist.
 *
 * **Postconditions.**
 * - Every field on the returned object is a ready-to-use prepared statement.
 * - No statement has been *executed*; preparation alone does not touch rows.
 *
 * @see Requirements 6.1, 7.1, 8.1, 8.3, 8.5, 12.1
 */
export function prepareStatements(db: Database): Statements {
  // Insert an event, idempotent on `event_id` collision. Column order
  // mirrors migration 0001 + 0003 (project_path appended). Updating one
  // without the other will bind values to the wrong columns silently.
  //
  // @see Requirements 6.1, 6.2, 6.3, 9.1, 9.2, 9.3, 11.1, 11.2, 12.1
  const insertEvent = db.prepare<InsertEventParams>(
    `INSERT OR IGNORE INTO events (
       event_id, parent_event_id, session_id, actor_id,
       namespace, schema_version, kind, body_json,
       valid_time, transaction_time, source_json, content_hash,
       project_path
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Point lookup by primary key. The column list is spelled out (rather
  // than `SELECT *`) so the `EventRow` row shape is stable against any
  // future additive migrations that reorder or append columns.
  //
  // project_path is intentionally NOT in this SELECT list — source.project_path round-trips via source_json. See design § Storage — Read Path (Requirement 9.5).
  //
  // @see Requirements 7.1, 7.2, 9.5
  const selectEventById = db.prepare<[eventId: string], EventRow>(
    `SELECT
       event_id, parent_event_id, session_id, actor_id,
       namespace, schema_version, kind, body_json,
       valid_time, transaction_time, source_json, content_hash
     FROM events
     WHERE event_id = ?`,
  );

  // Primary-row insert for a memory record. The backend wraps this in a
  // transaction together with the FTS row insert below.
  //
  // @see Requirements 8.1, 8.2, 12.1
  const insertMemoryRecord = db.prepare<InsertMemoryRecordParams>(
    `INSERT INTO memory_records (
       record_id, namespace, strategy, title, summary,
       facts_json, source_event_ids_json, created_at,
       concepts_json, files_touched_json, observation_type
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  // Companion FTS5 row insert. `record_id` + `namespace` are UNINDEXED in
  // the virtual table definition; they are carried so the backend can join
  // back to `memory_records` and apply the namespace-prefix filter without
  // an additional round trip.
  //
  // @see Requirements 8.1, 12.1
  const insertMemoryRecordFts = db.prepare<InsertMemoryRecordFtsParams>(
    `INSERT INTO memory_records_fts (
       record_id, namespace, title, summary, facts_text
     ) VALUES (?, ?, ?, ?, ?)`,
  );

  // Primary retrieval path. `memory_records_fts MATCH ?` must reference
  // the virtual table by name (FTS5 does not accept a table alias on the
  // left of `MATCH`); every user-controlled value is still bound.
  // Namespace isolation rides on `mr.namespace LIKE ? || '%'` where `||`
  // is a SQL string concat of the bound prefix with the literal `'%'`
  // wildcard. Ordered by FTS5 rank so the best match appears first.
  //
  // @see Requirements 8.3, 8.4, 12.1, 12.2
  const selectMemoryRecordsFtsMatch = db.prepare<
    SelectMemoryRecordsFtsMatchParams,
    MemoryRecordRow
  >(
    `SELECT
       mr.record_id, mr.namespace, mr.strategy, mr.title, mr.summary,
       mr.facts_json, mr.source_event_ids_json, mr.created_at,
       mr.concepts_json, mr.files_touched_json, mr.observation_type
     FROM memory_records_fts fts
     JOIN memory_records mr ON mr.record_id = fts.record_id
     WHERE memory_records_fts MATCH ?
       AND mr.namespace LIKE ? || '%'
     ORDER BY fts.rank
     LIMIT ?`,
  );

  // Fallback retrieval path, used when FTS5 rejects a malformed query
  // string. No rank available, so results are ordered by `created_at
  // DESC` to approximate "most relevant by recency". The backend
  // pre-escapes LIKE wildcards in the query and wraps the result in
  // `%...%` before binding to the title/summary positions.
  //
  // @see Requirements 8.5, 12.1
  const selectMemoryRecordsLike = db.prepare<SelectMemoryRecordsLikeParams, MemoryRecordRow>(
    `SELECT
       record_id, namespace, strategy, title, summary,
       facts_json, source_event_ids_json, created_at,
       concepts_json, files_touched_json, observation_type
     FROM memory_records
     WHERE namespace LIKE ? || '%'
       AND (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')
     ORDER BY created_at DESC
     LIMIT ?`,
  );

  return {
    insertEvent,
    selectEventById,
    insertMemoryRecord,
    insertMemoryRecordFts,
    selectMemoryRecordsFtsMatch,
    selectMemoryRecordsLike,
  };
}
