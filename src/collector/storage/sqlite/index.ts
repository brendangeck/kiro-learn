/**
 * SQLite storage backend (v1 default).
 *
 * Zero-dependency local store using `better-sqlite3` and FTS5. See
 * AGENTS.md for the rationale on why SQLite is the v1 baseline and
 * `.kiro/specs/event-schema-and-storage/design.md` § SQLite Backend for
 * the authoritative design.
 *
 * The module exports a single factory, {@link openSqliteStorage}, that
 * opens (or creates) a database file, runs pending migrations, prepares
 * statements once, and returns a {@link StorageBackend} whose methods
 * dispatch to those prepared statements. `better-sqlite3` is synchronous;
 * every public method wraps its work in an `async` function so the
 * returned backend is interchangeable with future async backends
 * (pgvector, AgentCore Memory) without changing any caller.
 *
 * Invariants the backend upholds (see design.md § Key Functions):
 *
 * - `putEvent` is idempotent on `event_id`. Duplicate inserts are a no-op;
 *   the first insert's `transaction_time` is never overwritten. This is
 *   implemented via `INSERT OR IGNORE` on the primary-key column.
 * - `getEventById` returns `null` — not an exception — when no row matches.
 * - `putMemoryRecord` inserts the primary row and its FTS5 companion row
 *   atomically via `db.transaction(...)`; either both land or neither does.
 *   A `record_id` collision surfaces as an error (upstream bug).
 * - `searchMemoryRecords` tries FTS5 first and falls back to LIKE on any
 *   FTS5 parse error. Both paths enforce namespace-prefix isolation and
 *   the caller-supplied limit.
 * - `close` is idempotent; the second call is a silent no-op.
 *
 * @see Requirements 4.1–4.6, 5.1–5.5, 6.1–6.4, 7.1–7.2, 8.1–8.5,
 *      11.1–11.3, 12.1, 12.2, N4
 * @module
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type {
  EventBody,
  EventSource,
  KiroMemEvent,
  MemoryRecord,
  SearchParams,
  StorageBackend,
} from '../../../types/index.js';

import { escapeLikePattern, sanitizeForFts5 } from './fts5.js';
import { MIGRATIONS, runMigrations } from './migrations/index.js';
import {
  prepareStatements,
  type EventRow,
  type MemoryRecordRow,
} from './statements.js';

/**
 * Options for {@link openSqliteStorage}.
 *
 * v1 intentionally exposes only `dbPath`. Advanced knobs (WAL mode,
 * busy timeout, cache size) ride on `better-sqlite3`'s defaults, which
 * are appropriate for a single-developer, single-process installation.
 *
 * @see Requirements 5.1, 13.4
 */
export interface SqliteStorageOptions {
  /**
   * Absolute path to the SQLite file, e.g.
   * `~/.kiro-learn/kiro-learn.db`. The backend creates any missing parent
   * directories with `mkdirSync(..., { recursive: true })` so first-time
   * opens on a fresh machine work without a separate install step.
   */
  dbPath: string;
}

/**
 * Open (or create) a SQLite-backed {@link StorageBackend} at `opts.dbPath`.
 *
 * Behaviour:
 * 1. Ensures the parent directory of `dbPath` exists (creates it
 *    recursively if not).
 * 2. Opens the SQLite handle via `better-sqlite3`.
 * 3. Runs every pending migration from {@link MIGRATIONS}. After this
 *    returns, the schema is at the latest version.
 * 4. Prepares every statement in {@link prepareStatements} once; the
 *    returned backend reuses them for the lifetime of the handle.
 *
 * The returned object satisfies {@link StorageBackend}. Methods are
 * `async` wrappers around synchronous `better-sqlite3` calls — callers
 * need not know the underlying driver is sync.
 *
 * @throws If the DB file cannot be opened, migrations fail, or a
 *         migration drift is detected (see `MigrationDriftError`).
 *
 * @see Requirements 4.1–4.6, 5.1–5.5
 */
export function openSqliteStorage(opts: SqliteStorageOptions): StorageBackend {
  // Ensure the containing directory exists. `recursive: true` makes this a
  // no-op when the directory is already present, which is the common case
  // after the first successful open.
  mkdirSync(dirname(opts.dbPath), { recursive: true });

  const db = new Database(opts.dbPath);

  // Apply pending DDL before preparing any statements — `prepareStatements`
  // compiles against tables that must already exist. If either step throws
  // (e.g. MigrationDriftError, corrupt DDL, missing table), close the
  // handle before rethrowing so the SQLite file is not left locked.
  let stmts;
  try {
    runMigrations(db, MIGRATIONS);
    stmts = prepareStatements(db);
  } catch (err) {
    db.close();
    throw err;
  }

  // Guards the `close` idempotency contract (Requirement 4.6 / N4). Once
  // the handle is closed further method calls would fail deep inside
  // `better-sqlite3` with a confusing "database is closed" error; the
  // guard turns that into an explicit, testable failure mode.
  let closed = false;
  const assertOpen = (): void => {
    if (closed) {
      throw new Error('sqlite storage backend is closed');
    }
  };

  const putEvent = async (event: KiroMemEvent): Promise<void> => {
    assertOpen();

    // Stamp transaction_time at insert time. `INSERT OR IGNORE` means this
    // value is only *used* on a fresh insert; on a collision the existing
    // row (including its original transaction_time) is preserved
    // untouched, satisfying Requirements 6.2 / 6.4.
    const transactionTime = new Date().toISOString();

    stmts.insertEvent.run(
      event.event_id,
      event.parent_event_id ?? null,
      event.session_id,
      event.actor_id,
      event.namespace,
      event.schema_version,
      event.kind,
      JSON.stringify(event.body),
      event.valid_time,
      transactionTime,
      JSON.stringify(event.source),
      event.content_hash ?? null,
      event.source.project_path ?? null,
    );
  };

  const getEventById = async (eventId: string): Promise<KiroMemEvent | null> => {
    assertOpen();
    const row = stmts.selectEventById.get(eventId);
    if (row === undefined) return null;
    return rowToEvent(row);
  };

  const putMemoryRecord = async (record: MemoryRecord): Promise<void> => {
    assertOpen();

    // FTS5 indexes a single blob per document; join the `facts` array into
    // a space-separated string so each fact is an independent searchable
    // token without introducing a separate row-per-fact schema.
    const factsText = record.facts.join(' ');

    // `db.transaction(fn)` returns a wrapper; invoking it with `()` runs
    // `fn` inside BEGIN/COMMIT and rolls back on any thrown error. A PK
    // collision on `memory_records.record_id` surfaces as a SQLite
    // constraint error, rolls the txn back (so the FTS row never lands),
    // and propagates to the caller — Requirement 8.2.
    const tx = db.transaction(() => {
      stmts.insertMemoryRecord.run(
        record.record_id,
        record.namespace,
        record.strategy,
        record.title,
        record.summary,
        JSON.stringify(record.facts),
        JSON.stringify(record.source_event_ids),
        record.created_at,
        JSON.stringify(record.concepts),
        JSON.stringify(record.files_touched),
        record.observation_type,
      );
      stmts.insertMemoryRecordFts.run(
        record.record_id,
        record.namespace,
        record.title,
        record.summary,
        factsText,
      );
    });
    tx();
  };

  const searchMemoryRecords = async (params: SearchParams): Promise<MemoryRecord[]> => {
    assertOpen();
    const { namespace, query, limit } = params;

    let rows: MemoryRecordRow[];
    try {
      // Primary path: FTS5 MATCH with the user query quoted as a single
      // phrase by `sanitizeForFts5`. Namespace isolation rides on
      // `mr.namespace LIKE ? || '%'` in the prepared statement.
      rows = stmts.selectMemoryRecordsFtsMatch.all(
        sanitizeForFts5(query),
        namespace,
        limit,
      );
    } catch {
      // Fallback path: FTS5 rejected the query (or some other SQLite
      // error bubbled out of the MATCH pipeline). The contract is
      // "availability over rank quality" — we'd rather return
      // creation-date-ordered substring hits than fail the enrichment
      // request over a query-format issue. The discriminator is
      // deliberately broad: design.md § Error Handling specifies the
      // fallback triggers on "malformed FTS5 query", and `better-sqlite3`
      // surfaces those as generic `SqliteError` with code
      // `SQLITE_ERROR`. Narrowing further (by code or message) would
      // risk papering over a real failure; we already rebind to a
      // different statement, so any underlying issue that also breaks
      // LIKE will surface from the fallback `.all(...)` below.
      const escaped = escapeLikePattern(query);
      const pattern = `%${escaped}%`;
      rows = stmts.selectMemoryRecordsLike.all(namespace, pattern, pattern, limit);
    }

    return rows.map(rowToMemoryRecord);
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    db.close();
  };

  return {
    putEvent,
    getEventById,
    putMemoryRecord,
    searchMemoryRecords,
    close,
  };
}

/**
 * Reassemble a {@link KiroMemEvent} from a raw {@link EventRow}.
 *
 * Deserialises the `body_json` / `source_json` columns, casts `kind` back
 * to its literal union, and normalises nullable columns (`parent_event_id`,
 * `content_hash`) to the wire type's optional fields. Under
 * `exactOptionalPropertyTypes`, an optional property set to `undefined` is
 * *not* the same as an absent property — the object produced here must
 * deep-equal the original event for Correctness Property P1 to hold, so
 * optional fields are added only when the stored column was non-null.
 *
 * The internal `transaction_time` column is intentionally not surfaced;
 * it is not part of the public wire type.
 *
 * @see Requirements 7.1, 11.1, 11.2, Correctness Property P1
 */
function rowToEvent(row: EventRow): KiroMemEvent {
  const body = JSON.parse(row.body_json) as EventBody;
  const source = JSON.parse(row.source_json) as EventSource;

  // `schema_version` is declared as INTEGER in the DDL. The wire schema
  // accepts only the literal `1` in v1; any stored row has been through
  // `parseEvent` upstream so this narrowing is sound.
  const schemaVersion = row.schema_version as 1;
  const kind = row.kind as KiroMemEvent['kind'];

  // Base object — all required fields, no optional fields.
  const base: KiroMemEvent = {
    event_id: row.event_id,
    session_id: row.session_id,
    actor_id: row.actor_id,
    namespace: row.namespace,
    schema_version: schemaVersion,
    kind,
    body,
    valid_time: row.valid_time,
    source,
  };

  // Attach optional fields only when the stored column held a real value.
  // Spreading each as its own conditional keeps the `exactOptionalPropertyTypes`
  // contract intact (absent key, not `key: undefined`).
  const withParent: KiroMemEvent =
    row.parent_event_id !== null ? { ...base, parent_event_id: row.parent_event_id } : base;

  const withHash: KiroMemEvent =
    row.content_hash !== null ? { ...withParent, content_hash: row.content_hash } : withParent;

  return withHash;
}

/**
 * Reassemble a {@link MemoryRecord} from a raw {@link MemoryRecordRow}.
 *
 * JSON-encoded TEXT columns (`facts_json`, `source_event_ids_json`,
 * `concepts_json`, `files_touched_json`) round-trip through
 * `JSON.stringify` on write and `JSON.parse` on read. The upstream
 * `parseMemoryRecord` guarantees each is an array of strings, so the
 * casts here are sound against validated input.
 *
 * `observation_type` is persisted as TEXT with a SQLite `CHECK`
 * constraint restricting it to the five allowed enum values
 * (see migration 0002), so the cast to `ObservationType` is sound
 * against any row that reached the database through `putMemoryRecord`.
 *
 * @see Requirements 8.1, 8.2, 8.3
 */
function rowToMemoryRecord(row: MemoryRecordRow): MemoryRecord {
  return {
    record_id: row.record_id,
    namespace: row.namespace,
    strategy: row.strategy,
    title: row.title,
    summary: row.summary,
    facts: JSON.parse(row.facts_json) as string[],
    source_event_ids: JSON.parse(row.source_event_ids_json) as string[],
    created_at: row.created_at,
    concepts: JSON.parse(row.concepts_json) as string[],
    files_touched: JSON.parse(row.files_touched_json) as string[],
    observation_type:
      row.observation_type as MemoryRecord['observation_type'],
  };
}
