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
  ProjectInfo,
  SearchParams,
  StatsResult,
  StorageBackend,
  StorageTransaction,
} from '../../../types/index.js';

import { decodeEmbeddingBlob, encodeEmbeddingBlob } from '../../embedding/blob.js';

import { createFts5Sanitizer, escapeLikePattern } from './fts5.js';
import { MIGRATIONS, runMigrations } from './migrations/index.js';
import {
  prepareStatements,
  type CountByLabelRow,
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
  let sanitize: (query: string) => string;
  try {
    runMigrations(db, MIGRATIONS);

    // Lazily declare the fts5vocab virtual table so the term-ranker's
    // prepared statements (which reference `memory_records_fts_vocab`)
    // compile against an existing table. `IF NOT EXISTS` makes re-open a
    // no-op. This is not a migration — fts5vocab is a stateless view over
    // `memory_records_fts` with no data of its own (design § Migration
    // Concerns).
    //
    // @see Requirements 4.2, 9.1
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts_vocab
       USING fts5vocab(memory_records_fts, 'row')`,
    );

    stmts = prepareStatements(db);
    sanitize = createFts5Sanitizer(stmts);
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

  const searchMemoryRecordsLexical = async (
    params: SearchParams,
  ): Promise<Array<{ record: MemoryRecord; rank: number }>> => {
    assertOpen();
    const { namespace, query, limit } = params;

    // Short-circuit: if the sanitizer returns '' (empty/whitespace-only input),
    // skip both MATCH and LIKE and return immediately. Mirrors the existing
    // behaviour of `searchMemoryRecords` (Requirements 2.3, 13.3).
    const match = sanitize(query);
    if (match === '') return [];

    try {
      // Primary path: ranked FTS5 MATCH with the tokenized OR-of-phrases
      // expression produced by the handle-bound sanitizer. The SQL
      // `ROW_NUMBER() OVER (ORDER BY fts.rank)` produces a stable
      // 1-based integer rank suitable for RRF fusion (`1 / (k + rank)`).
      // Namespace isolation rides on `mr.namespace LIKE ? || '%'`.
      const rows = stmts.selectMemoryRecordsFtsMatchRanked.all(match, namespace, limit);
      return rows.map((row) => ({ record: rowToMemoryRecord(row), rank: row.rank }));
    } catch {
      // Fallback path: FTS5 rejected the query (or some other SQLite
      // error bubbled out of the MATCH pipeline). The contract is
      // "availability over rank quality" — we'd rather return
      // creation-date-ordered substring hits than fail the enrichment
      // request over a query-format issue. The LIKE fallback is fed
      // from the original unsanitised query string (Requirement 8.3).
      // No rank is available from the underlying statement, so we
      // synthesise a 1-based position rank to preserve the tuple shape
      // the fusion layer expects.
      const escaped = escapeLikePattern(query);
      const pattern = `%${escaped}%`;
      const rows = stmts.selectMemoryRecordsLike.all(namespace, pattern, pattern, limit);
      return rows.map((row, idx) => ({ record: rowToMemoryRecord(row), rank: idx + 1 }));
    }
  };

  const searchMemoryRecords = async (params: SearchParams): Promise<MemoryRecord[]> => {
    // Thin wrapper: reuse the ranked lexical path and unwrap the tuples.
    // The existing external contract (records, in rank order) is unchanged.
    const ranked = await searchMemoryRecordsLexical(params);
    return ranked.map(({ record }) => record);
  };

  /**
   * Convert an array of {@link CountByLabelRow} into a `Record<string, number>`.
   *
   * Each row's `label` becomes a key and `count` becomes the value.
   */
  const countByLabelToRecord = (rows: CountByLabelRow[]): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.label] = row.count;
    }
    return result;
  };

  const getStats = async (namespace?: string): Promise<StatsResult> => {
    assertOpen();

    if (namespace !== undefined) {
      // Scoped mode: counts filtered to a single namespace.
      const statsRow = stmts.selectStatsScoped.get(namespace, namespace);
      const totalEvents = statsRow?.total_events ?? 0;
      const totalMemories = statsRow?.total_memories ?? 0;

      const observationTypeRows = stmts.selectObservationTypeCountsScoped.all(namespace);
      const eventKindRows = stmts.selectEventKindCountsScoped.all(namespace);
      const conceptsRow = stmts.selectDistinctConceptsScoped.get(namespace);

      // Embedding coverage for the scoped namespace. SUM over 0 rows is
      // NULL in SQLite, so coerce to 0. Per Requirement 14.4, the SQLite
      // backend always computes these — they are emitted as concrete
      // numbers (never `undefined`) under `exactOptionalPropertyTypes`.
      const embRow = stmts.selectEmbeddingStatsScoped.get(namespace);
      const embeddingsPresent = embRow?.present ?? 0;
      const embeddingsMissing = embRow?.missing ?? 0;

      return {
        total_events: totalEvents,
        total_memories: totalMemories,
        total_projects: 1,
        total_concepts: conceptsRow?.total_concepts ?? 0,
        observation_types: countByLabelToRecord(observationTypeRows),
        event_kinds: countByLabelToRecord(eventKindRows),
        embeddings_present: embeddingsPresent,
        embeddings_missing: embeddingsMissing,
      };
    }

    // Global mode: counts across all namespaces.
    const statsRow = stmts.selectStats.get();
    const totalEvents = statsRow?.total_events ?? 0;
    const totalMemories = statsRow?.total_memories ?? 0;
    const totalProjects = statsRow?.total_projects ?? 0;

    const observationTypeRows = stmts.selectObservationTypeCounts.all();
    const eventKindRows = stmts.selectEventKindCounts.all();
    const conceptsRow = stmts.selectDistinctConcepts.get();

    // Global embedding coverage. Same NULL→0 coercion as the scoped
    // branch above.
    const embRow = stmts.selectEmbeddingStatsGlobal.get();
    const embeddingsPresent = embRow?.present ?? 0;
    const embeddingsMissing = embRow?.missing ?? 0;

    return {
      total_events: totalEvents,
      total_memories: totalMemories,
      total_projects: totalProjects,
      total_concepts: conceptsRow?.total_concepts ?? 0,
      observation_types: countByLabelToRecord(observationTypeRows),
      event_kinds: countByLabelToRecord(eventKindRows),
      embeddings_present: embeddingsPresent,
      embeddings_missing: embeddingsMissing,
    };
  };

  const listProjects = async (): Promise<ProjectInfo[]> => {
    assertOpen();
    const rows = stmts.selectProjects.all();
    return rows.map((row) => ({
      namespace: row.namespace,
      project_path: row.project_path,
      event_count: row.event_count,
      memory_count: row.memory_count,
    }));
  };

  const listMemoryRecords = async (params: {
    namespace?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: MemoryRecord[]; total: number }> => {
    assertOpen();
    const { namespace, limit, offset } = params;

    if (namespace !== undefined) {
      // Scoped: use namespace query with LIMIT/OFFSET.
      const rows = stmts.selectMemoryRecordsByNamespace.all(namespace, limit, offset);
      const countRow = stmts.selectMemoryRecordCountByNamespace.get(namespace);
      const total = countRow?.total ?? 0;
      return { items: rows.map(rowToMemoryRecord), total };
    }

    // Global: no namespace filter.
    const rows = stmts.selectMemoryRecordsAll.all(limit, offset);
    const countRow = stmts.selectMemoryRecordCountAll.get();
    const total = countRow?.total ?? 0;
    return { items: rows.map(rowToMemoryRecord), total };
  };

  const listEvents = async (params: {
    namespace?: string;
    limit: number;
  }): Promise<{ items: KiroMemEvent[]; total: number }> => {
    assertOpen();
    const { namespace, limit } = params;

    if (namespace !== undefined) {
      // Scoped path — existing behaviour.
      const rows = stmts.selectEventsByNamespace.all(namespace, limit);
      const countRow = stmts.selectEventCountByNamespace.get(namespace);
      const total = countRow?.total ?? 0;
      return { items: rows.map(rowToEvent), total };
    }

    // Global path — all namespaces.
    const rows = stmts.selectEventsAll.all(limit);
    const countRow = stmts.selectEventCountAll.get();
    const total = countRow?.total ?? 0;
    return { items: rows.map(rowToEvent), total };
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    db.close();
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Embedding surface.
  //
  // Implements the new `StorageBackend` methods added by the
  // local-embeddings-and-hybrid-search spec. BLOB encode/decode lives in the
  // pure `src/collector/embedding/blob.ts` module; this backend only
  // consumes it. Length-mismatch errors thrown by `decodeEmbeddingBlob`
  // are caught below and re-thrown annotated with the offending
  // `record_id` (Req 15.3).
  // ─────────────────────────────────────────────────────────────────────────

  const putEmbedding = async (
    recordId: string,
    embedding: Float32Array,
  ): Promise<void> => {
    assertOpen();
    // `encodeEmbeddingBlob` throws on length mismatch; that is a caller bug
    // (vector model produced the wrong dimension) and we let it propagate.
    const blob = encodeEmbeddingBlob(embedding);
    // UPDATE by primary key. `RunResult.changes === 0` when `recordId`
    // does not exist — design § No-op error paths: treat as silent no-op.
    //
    // @see Requirements 3.3, 4.1, 4.2, 8.6, 19.2
    stmts.updateMemoryRecordEmbedding.run(blob, recordId);
  };

  const getEmbedding = async (recordId: string): Promise<Float32Array | null> => {
    assertOpen();
    const row = stmts.selectMemoryRecordEmbedding.get(recordId);
    if (row === undefined) return null;
    if (row.embedding === null) return null;
    try {
      return decodeEmbeddingBlob(row.embedding);
    } catch (err) {
      const origMsg = err instanceof Error ? err.message : String(err);
      // Requirement 15.3: surface the offending record_id to aid
      // identification of the bad row.
      throw new Error(
        `embedding blob for record ${recordId} is corrupt: ${origMsg}`,
      );
    }
  };

  const listEmbeddings = async (
    namespace: string,
  ): Promise<Array<{ record_id: string; embedding: Float32Array; created_at: string }>> => {
    assertOpen();
    const rows = stmts.selectEmbeddingsByNamespace.all(namespace);
    const out: Array<{ record_id: string; embedding: Float32Array; created_at: string }> = [];
    for (const row of rows) {
      try {
        const embedding = decodeEmbeddingBlob(row.embedding);
        out.push({
          record_id: row.record_id,
          embedding,
          created_at: row.created_at,
        });
      } catch (err) {
        // Design § Corrupt BLOB on read: `listEmbeddings` logs and skips
        // the row so one bad BLOB does not poison the whole index build.
        // `console.warn` matches existing project convention.
        const origMsg = err instanceof Error ? err.message : String(err);
        console.warn(
          `sqlite storage: skipping corrupt embedding for record ${row.record_id} in namespace ${namespace}: ${origMsg}`,
        );
      }
    }
    return out;
  };

  const listRecordsWithoutEmbedding = async (
    namespace: string | null,
    limit: number,
  ): Promise<MemoryRecord[]> => {
    assertOpen();
    // Single statement handles both global and scoped back-fill via
    // `(? IS NULL OR namespace = ?)`; the namespace value is bound
    // twice. `null` → global backlog; string → scoped.
    const rows = stmts.selectMemoryRecordsWithoutEmbedding.all(namespace, namespace, limit);
    return rows.map(rowToMemoryRecord);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Reconciliation surface — deleteMemoryRecord + withTransaction.
  //
  // Both methods wrap `db.transaction(...)` from `better-sqlite3`, which
  // runs its callback synchronously inside BEGIN/COMMIT and rolls back
  // automatically on any thrown error. The synchronous callback is the
  // whole point: attempting to `await` inside the body would yield to
  // the microtask queue and defeat the transaction boundary, so we
  // reject any `fn` that returns a Promise.
  //
  // The delete cascade is driven by three prepared statements in a
  // fixed order: FTS5 row → embedding column (nulled) → primary row.
  // See the comment on the statements in `statements.ts` for why each
  // step is needed and why the order matters.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Apply the three-step delete cascade for a single record id inside
   * whatever transaction is currently active on `db`. Call sites MUST
   * wrap this in a `db.transaction(...)` body; it does not open one
   * itself.
   *
   * Order mirrors the "child rows deleted before parent" invariant:
   * FTS5 companion first, embedding column nulled next, primary row
   * last. Each step is a zero-row no-op on a miss, so the cascade is
   * idempotent on unknown ids (Requirement 9.5).
   */
  const deleteOneRecordInTxn = (id: string): void => {
    stmts.deleteMemoryRecordFtsById.run(id);
    stmts.deleteEmbeddingByRecordId.run(id);
    stmts.deleteMemoryRecordById.run(id);
  };

  const deleteMemoryRecord = async (recordIds: readonly string[]): Promise<void> => {
    assertOpen();
    // Zero-length input is a trivially valid no-op — don't even open a
    // transaction. Keeps the path identical to the "every id misses"
    // case in terms of observable effect.
    if (recordIds.length === 0) return;

    // `db.transaction(fn)` returns a wrapper; invoking it runs `fn`
    // inside BEGIN/COMMIT and rolls back on any thrown error. Looping
    // inside the wrapper keeps the whole batch atomic — either every
    // listed id's cascade lands or none do.
    //
    // @see Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 8.1
    const tx = db.transaction((ids: readonly string[]) => {
      for (const id of ids) {
        deleteOneRecordInTxn(id);
      }
    });
    tx(recordIds);
  };

  const withTransaction = async <T>(
    fn: (tx: StorageTransaction) => Promise<T> | T,
  ): Promise<T> => {
    assertOpen();

    // Build the synchronous handle once per call. All three methods
    // delegate to the same prepared statements as the async backend
    // surface, but they return `void` — callers must not `await` them.
    //
    // `better-sqlite3` transactions are synchronous; attempting to
    // yield to the microtask queue inside the body would silently
    // escape the BEGIN/COMMIT and defeat atomicity. We guard against
    // that below by rejecting any `fn` that returns a Promise.
    const txHandle: StorageTransaction = {
      putMemoryRecord: (record: MemoryRecord): void => {
        const factsText = record.facts.join(' ');
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
      },
      putEmbedding: (recordId: string, embedding: Float32Array): void => {
        // Same contract as the async `putEmbedding`: encode to BLOB,
        // UPDATE by PK, silent no-op on a miss.
        const blob = encodeEmbeddingBlob(embedding);
        stmts.updateMemoryRecordEmbedding.run(blob, recordId);
      },
      deleteMemoryRecord: (recordIds: readonly string[]): void => {
        for (const id of recordIds) {
          deleteOneRecordInTxn(id);
        }
      },
    };

    // The transaction body is synchronous. We capture `fn`'s return
    // value in an outer binding and read it after `tx()` commits; if
    // the value is a Promise, the body throws and `better-sqlite3`
    // rolls back. Rejecting async bodies inside the transaction body
    // rather than after commit means a misuse never accidentally
    // half-commits.
    let result: T;
    const tx = db.transaction(() => {
      const returned = fn(txHandle);
      // `fn` may legitimately be declared `async` while still returning
      // a synchronous value shape; the check below guards against any
      // actual Promise leaking through, regardless of declaration.
      if (
        returned !== null &&
        typeof returned === 'object' &&
        'then' in (returned as object) &&
        typeof (returned as { then?: unknown }).then === 'function'
      ) {
        throw new Error(
          'withTransaction: callback returned a Promise; ' +
            'better-sqlite3 transactions are synchronous and cannot be awaited inside the body',
        );
      }
      result = returned as T;
    });
    tx();
    // `result` is definitely assigned on a successful commit; TypeScript
    // cannot prove it because the assignment happens inside a callback.
    return result!;
  };

  return {
    putEvent,
    getEventById,
    putMemoryRecord,
    searchMemoryRecords,
    close,
    getStats,
    listProjects,
    listMemoryRecords,
    listEvents,
    putEmbedding,
    getEmbedding,
    listEmbeddings,
    listRecordsWithoutEmbedding,
    searchMemoryRecordsLexical,
    deleteMemoryRecord,
    withTransaction,
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
