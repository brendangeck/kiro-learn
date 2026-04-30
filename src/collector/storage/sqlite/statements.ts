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

// ---------------------------------------------------------------------------
// Row shapes for read-API queries (tasks 2.1–2.4)
// ---------------------------------------------------------------------------

/**
 * Row shape returned by `selectStats` — global aggregate counts.
 *
 * @see Requirements 1.1, 1.6
 */
export interface StatsRow {
  total_events: number;
  total_memories: number;
  total_projects: number;
}

/**
 * Row shape returned by `selectStatsScoped` — namespace-filtered counts.
 *
 * @see Requirements 1.1, 1.6
 */
export interface StatsScopedRow {
  total_events: number;
  total_memories: number;
}

/**
 * Row shape returned by observation-type and event-kind count queries.
 *
 * @see Requirements 1.2, 1.3
 */
export interface CountByLabelRow {
  label: string;
  count: number;
}

/**
 * Row shape returned by `selectDistinctConcepts` /
 * `selectDistinctConceptsScoped`.
 *
 * @see Requirement 1.1
 */
export interface DistinctConceptsRow {
  total_concepts: number;
}

/**
 * Row shape returned by `selectProjects`.
 *
 * @see Requirements 1.4, 1.5, 8.1
 */
export interface ProjectRow {
  namespace: string;
  project_path: string | null;
  event_count: number;
  memory_count: number;
}

/**
 * Row shape returned by `selectEventCountByNamespace`.
 *
 * @see Requirements 3.6
 */
export interface EventCountRow {
  total: number;
}

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

  // -----------------------------------------------------------------------
  // Read-API statements (tasks 2.1–2.4)
  // -----------------------------------------------------------------------

  /**
   * Global aggregate counts: total events, total memories, total distinct
   * namespaces (projects). No parameters.
   *
   * @see Requirements 1.1, 1.6, N5
   */
  selectStats: Statement<[], StatsRow>;

  /**
   * Namespace-scoped aggregate counts: total events and total memories for
   * a single namespace. The namespace is bound twice (once per scalar
   * subquery).
   *
   * Parameters: `[namespace, namespace]`.
   *
   * @see Requirements 1.1, 1.6, N5
   */
  selectStatsScoped: Statement<[namespace: string, namespace2: string], StatsScopedRow>;

  /**
   * Global observation-type breakdown: count of memory records grouped by
   * `observation_type`. No parameters.
   *
   * @see Requirements 1.2, N5
   */
  selectObservationTypeCounts: Statement<[], CountByLabelRow>;

  /**
   * Namespace-scoped observation-type breakdown.
   *
   * Parameters: `[namespace]`.
   *
   * @see Requirements 1.2, N5
   */
  selectObservationTypeCountsScoped: Statement<[namespace: string], CountByLabelRow>;

  /**
   * Global event-kind breakdown: count of events grouped by `kind`.
   * No parameters.
   *
   * @see Requirements 1.3, N5
   */
  selectEventKindCounts: Statement<[], CountByLabelRow>;

  /**
   * Namespace-scoped event-kind breakdown.
   *
   * Parameters: `[namespace]`.
   *
   * @see Requirements 1.3, N5
   */
  selectEventKindCountsScoped: Statement<[namespace: string], CountByLabelRow>;

  /**
   * Count of distinct concept strings across all memory records, using
   * `json_each(concepts_json)` to explode the JSON array column.
   * No parameters.
   *
   * @see Requirements 1.1, N5
   */
  selectDistinctConcepts: Statement<[], DistinctConceptsRow>;

  /**
   * Namespace-scoped count of distinct concept strings.
   *
   * Parameters: `[namespace]`.
   *
   * @see Requirements 1.1, N5
   */
  selectDistinctConceptsScoped: Statement<[namespace: string], DistinctConceptsRow>;

  /**
   * Distinct namespaces with event count, memory count, and the most
   * recent non-NULL `project_path`. Ordered by `event_count DESC`.
   *
   * No parameters.
   *
   * @see Requirements 1.4, 1.5, 8.1
   */
  selectProjects: Statement<[], ProjectRow>;

  /**
   * All memory records for a given namespace, ordered by `created_at DESC`,
   * with pagination via LIMIT and OFFSET.
   *
   * Parameters: `[namespace, limit, offset]`.
   *
   * @see Requirements 1.2, 2.1, 2.4, 2.6, 9.4
   */
  selectMemoryRecordsByNamespace: Statement<[namespace: string, limit: number, offset: number], MemoryRecordRow>;

  /**
   * All memory records across all namespaces, ordered by `created_at DESC`,
   * with pagination via LIMIT and OFFSET.
   *
   * Parameters: `[limit, offset]`.
   *
   * @see Requirements 1.2, 1.5, 9.4
   */
  selectMemoryRecordsAll: Statement<[limit: number, offset: number], MemoryRecordRow>;

  /**
   * Total count of memory records across all namespaces.
   *
   * No parameters.
   *
   * @see Requirements 1.2, 9.4
   */
  selectMemoryRecordCountAll: Statement<[], EventCountRow>;

  /**
   * Total count of memory records for a given namespace.
   *
   * Parameters: `[namespace]`.
   *
   * @see Requirements 1.2, 2.2, 9.4
   */
  selectMemoryRecordCountByNamespace: Statement<[namespace: string], EventCountRow>;

  /**
   * Events for a given namespace, ordered by `valid_time DESC`, with a
   * `LIMIT` parameter.
   *
   * Parameters: `[namespace, limit]`.
   *
   * @see Requirements 3.1, 3.3, 3.5, 3.6
   */
  selectEventsByNamespace: Statement<[namespace: string, limit: number], EventRow>;

  /**
   * Total count of events for a given namespace.
   *
   * Parameters: `[namespace]`.
   *
   * @see Requirements 3.6
   */
  selectEventCountByNamespace: Statement<[namespace: string], EventCountRow>;

  /**
   * All events across all namespaces, ordered by `valid_time DESC`, with a
   * `LIMIT` parameter.
   *
   * Parameters: `[limit]`.
   *
   * @see Requirements 2.2, 9.4
   */
  selectEventsAll: Statement<[limit: number], EventRow>;

  /**
   * Total count of events across all namespaces.
   *
   * No parameters.
   *
   * @see Requirements 2.2, 9.4
   */
  selectEventCountAll: Statement<[], EventCountRow>;

  // -----------------------------------------------------------------------
  // fts5vocab lookup statements (fts5-query-tokenization task 1)
  // -----------------------------------------------------------------------

  /**
   * Total document count in the `memory_records` table. Used by the term
   * ranker to compute IDF (`log(N / max(df, 1))`). No parameters.
   *
   * Row shape: `{ total: number }`.
   *
   * @see Requirements 4.3, 5.1, 9.3
   */
  selectFts5DocCount: Statement<[], { total: number }>;

  /**
   * Factory that returns an arity-specific prepared statement for querying
   * `memory_records_fts_vocab` with a variable-length `IN (?, ?, …)` clause.
   *
   * Each distinct arity is prepared at most once per handle (memoised in an
   * internal `Map<number, Statement>`). The returned statement accepts
   * `string[]` positional parameters and produces rows of
   * `{ term: string; doc: number }`.
   *
   * @param arity - A positive integer specifying the number of `?` placeholders.
   * @returns A prepared statement for the given arity.
   *
   * @see Requirements 4.2, 9.3
   */
  prepareSelectFts5VocabDocFreq: (arity: number) => Statement<string[], { term: string; doc: number }>;
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

  // -----------------------------------------------------------------------
  // Read-API statements (tasks 2.1–2.4)
  // -----------------------------------------------------------------------

  // Task 2.1 — Stats-related statements
  //
  // Global aggregate counts. Scalar subqueries keep this as a single-row
  // result regardless of table sizes.
  //
  // @see Requirements 1.1, 1.6, N5
  const selectStats = db.prepare<[], StatsRow>(
    `SELECT
       (SELECT COUNT(*) FROM events) AS total_events,
       (SELECT COUNT(*) FROM memory_records) AS total_memories,
       (SELECT COUNT(DISTINCT namespace) FROM events) AS total_projects`,
  );

  // Namespace-scoped aggregate counts. The namespace is bound twice — once
  // for each scalar subquery.
  //
  // @see Requirements 1.1, 1.6, N5
  const selectStatsScoped = db.prepare<[namespace: string, namespace2: string], StatsScopedRow>(
    `SELECT
       (SELECT COUNT(*) FROM events WHERE namespace = ?) AS total_events,
       (SELECT COUNT(*) FROM memory_records WHERE namespace = ?) AS total_memories`,
  );

  // Global observation-type breakdown.
  //
  // @see Requirements 1.2, N5
  const selectObservationTypeCounts = db.prepare<[], CountByLabelRow>(
    `SELECT observation_type AS label, COUNT(*) AS count
     FROM memory_records
     GROUP BY observation_type`,
  );

  // Namespace-scoped observation-type breakdown.
  //
  // @see Requirements 1.2, N5
  const selectObservationTypeCountsScoped = db.prepare<[namespace: string], CountByLabelRow>(
    `SELECT observation_type AS label, COUNT(*) AS count
     FROM memory_records
     WHERE namespace = ?
     GROUP BY observation_type`,
  );

  // Global event-kind breakdown.
  //
  // @see Requirements 1.3, N5
  const selectEventKindCounts = db.prepare<[], CountByLabelRow>(
    `SELECT kind AS label, COUNT(*) AS count
     FROM events
     GROUP BY kind`,
  );

  // Namespace-scoped event-kind breakdown.
  //
  // @see Requirements 1.3, N5
  const selectEventKindCountsScoped = db.prepare<[namespace: string], CountByLabelRow>(
    `SELECT kind AS label, COUNT(*) AS count
     FROM events
     WHERE namespace = ?
     GROUP BY kind`,
  );

  // Global distinct concept count. `json_each` explodes the JSON array
  // column so `COUNT(DISTINCT j.value)` counts unique concept strings
  // across all memory records.
  //
  // @see Requirements 1.1, N5
  const selectDistinctConcepts = db.prepare<[], DistinctConceptsRow>(
    `SELECT COUNT(DISTINCT j.value) AS total_concepts
     FROM memory_records, json_each(memory_records.concepts_json) AS j`,
  );

  // Namespace-scoped distinct concept count.
  //
  // @see Requirements 1.1, N5
  const selectDistinctConceptsScoped = db.prepare<[namespace: string], DistinctConceptsRow>(
    `SELECT COUNT(DISTINCT j.value) AS total_concepts
     FROM memory_records, json_each(memory_records.concepts_json) AS j
     WHERE memory_records.namespace = ?`,
  );

  // Task 2.2 — Project listing
  //
  // Distinct namespaces with event count, memory count, and the most
  // recent non-NULL project_path. The correlated subqueries for
  // project_path and memory_count are acceptable for v1 data volumes
  // (< 50 projects). Ordered by event_count DESC per Requirement 1.5.
  //
  // @see Requirements 1.4, 1.5, 8.1
  const selectProjects = db.prepare<[], ProjectRow>(
    `SELECT
       e.namespace,
       (SELECT project_path FROM events e2
        WHERE e2.namespace = e.namespace AND e2.project_path IS NOT NULL
        ORDER BY e2.valid_time DESC LIMIT 1) AS project_path,
       COUNT(*) AS event_count,
       (SELECT COUNT(*) FROM memory_records mr
        WHERE mr.namespace = e.namespace) AS memory_count
     FROM events e
     GROUP BY e.namespace
     ORDER BY event_count DESC`,
  );

  // Task 2.3 — Memory listing by namespace
  //
  // All memory records for a given namespace, ordered by created_at DESC,
  // with LIMIT and OFFSET for pagination.
  //
  // @see Requirements 1.2, 2.1, 2.4, 2.6, 9.4
  const selectMemoryRecordsByNamespace = db.prepare<
    [namespace: string, limit: number, offset: number],
    MemoryRecordRow
  >(
    `SELECT
       record_id, namespace, strategy, title, summary,
       facts_json, source_event_ids_json, created_at,
       concepts_json, files_touched_json, observation_type
     FROM memory_records
     WHERE namespace = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  );

  // Global memory listing — all namespaces, ordered by created_at DESC,
  // with LIMIT and OFFSET for pagination.
  //
  // @see Requirements 1.2, 1.5, 9.4
  const selectMemoryRecordsAll = db.prepare<[limit: number, offset: number], MemoryRecordRow>(
    `SELECT
       record_id, namespace, strategy, title, summary,
       facts_json, source_event_ids_json, created_at,
       concepts_json, files_touched_json, observation_type
     FROM memory_records
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
  );

  // Total count of memory records across all namespaces.
  //
  // @see Requirements 1.2, 9.4
  const selectMemoryRecordCountAll = db.prepare<[], EventCountRow>(
    `SELECT COUNT(*) AS total FROM memory_records`,
  );

  // Total count of memory records for a given namespace.
  //
  // @see Requirements 1.2, 2.2, 9.4
  const selectMemoryRecordCountByNamespace = db.prepare<[namespace: string], EventCountRow>(
    `SELECT COUNT(*) AS total FROM memory_records WHERE namespace = ?`,
  );

  // Task 2.4 — Event listing by namespace
  //
  // Events for a given namespace, ordered by valid_time DESC, with a
  // LIMIT parameter. The column list mirrors selectEventById (no
  // project_path — read path uses source_json).
  //
  // @see Requirements 3.1, 3.3, 3.5, 3.6
  const selectEventsByNamespace = db.prepare<[namespace: string, limit: number], EventRow>(
    `SELECT
       event_id, parent_event_id, session_id, actor_id,
       namespace, schema_version, kind, body_json,
       valid_time, transaction_time, source_json, content_hash
     FROM events
     WHERE namespace = ?
     ORDER BY valid_time DESC
     LIMIT ?`,
  );

  // Total event count for a namespace. Used alongside selectEventsByNamespace
  // to populate the `total` field in the response (the total reflects the
  // full count, not just the returned slice).
  //
  // @see Requirements 3.6
  const selectEventCountByNamespace = db.prepare<[namespace: string], EventCountRow>(
    `SELECT COUNT(*) AS total FROM events WHERE namespace = ?`,
  );

  // Global event listing — all namespaces, ordered by valid_time DESC,
  // with a LIMIT parameter.
  //
  // @see Requirements 2.2, 9.4
  const selectEventsAll = db.prepare<[limit: number], EventRow>(
    `SELECT
       event_id, parent_event_id, session_id, actor_id,
       namespace, schema_version, kind, body_json,
       valid_time, transaction_time, source_json, content_hash
     FROM events
     ORDER BY valid_time DESC
     LIMIT ?`,
  );

  // Total event count across all namespaces.
  //
  // @see Requirements 2.2, 9.4
  const selectEventCountAll = db.prepare<[], EventCountRow>(
    `SELECT COUNT(*) AS total FROM events`,
  );

  // -----------------------------------------------------------------------
  // fts5vocab lookup statements (fts5-query-tokenization task 1)
  // -----------------------------------------------------------------------

  // Total document count in memory_records. Used by the term ranker to
  // compute IDF. Fixed-arity, no parameters.
  //
  // @see Requirements 4.3, 5.1, 9.3
  const selectFts5DocCount = db.prepare<[], { total: number }>(
    `SELECT COUNT(*) AS total FROM memory_records`,
  );

  // Memoisation cache for variable-arity fts5vocab lookup statements.
  // Each distinct arity is prepared at most once per handle.
  const vocabStmtCache = new Map<number, Statement<string[], { term: string; doc: number }>>();

  // Factory that returns an arity-specific prepared statement for querying
  // memory_records_fts_vocab with a variable-length IN clause.
  //
  // @see Requirements 4.2, 9.3
  const prepareSelectFts5VocabDocFreq = (
    arity: number,
  ): Statement<string[], { term: string; doc: number }> => {
    const cached = vocabStmtCache.get(arity);
    if (cached !== undefined) return cached;

    const placeholders = Array.from({ length: arity }, () => '?').join(', ');
    const stmt = db.prepare<string[], { term: string; doc: number }>(
      `SELECT term, doc FROM memory_records_fts_vocab WHERE term IN (${placeholders})`,
    );
    vocabStmtCache.set(arity, stmt);
    return stmt;
  };

  return {
    insertEvent,
    selectEventById,
    insertMemoryRecord,
    insertMemoryRecordFts,
    selectMemoryRecordsFtsMatch,
    selectMemoryRecordsLike,
    selectStats,
    selectStatsScoped,
    selectObservationTypeCounts,
    selectObservationTypeCountsScoped,
    selectEventKindCounts,
    selectEventKindCountsScoped,
    selectDistinctConcepts,
    selectDistinctConceptsScoped,
    selectProjects,
    selectMemoryRecordsByNamespace,
    selectMemoryRecordsAll,
    selectMemoryRecordCountAll,
    selectMemoryRecordCountByNamespace,
    selectEventsByNamespace,
    selectEventCountByNamespace,
    selectEventsAll,
    selectEventCountAll,
    selectFts5DocCount,
    prepareSelectFts5VocabDocFreq,
  };
}
