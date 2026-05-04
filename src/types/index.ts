/**
 * Canonical types for kiro-learn.
 *
 * The `Event` schema is the one-way-door contract. See AGENTS.md for the
 * architectural narrative and
 * `.kiro/specs/event-schema-and-storage/design.md` for field-level details.
 *
 * Runtime shapes and validators live in `./schemas.js`; this module derives
 * TypeScript types from those schemas and re-exports them alongside the
 * interfaces used by the collector pipeline and storage layer.
 *
 * Additions to the `Event` or `MemoryRecord` shape MUST be additive; any
 * breaking change bumps `schema_version`.
 */

import type { KiroMemEvent, MemoryRecord } from './schemas.js';

export {
  EventBodySchema,
  EventSchema,
  EventSourceSchema,
  MemoryRecordSchema,
  CandidateMemorySchema,
  JudgeMergeResponseSchema,
  JudgeKeepSeparateResponseSchema,
  JudgeResponseSchema,
  OBSERVATION_TYPES,
  ULID_RE,
  RECORD_ID_RE,
  NAMESPACE_RE,
  CONTENT_HASH_RE,
  parseEvent,
  parseMemoryRecord,
} from './schemas.js';

export type {
  KiroMemEvent,
  MemoryRecord,
  ObservationType,
  CandidateMemory,
  JudgeResponse,
  JudgeMergeResponse,
  JudgeKeepSeparateResponse,
} from './schemas.js';

/**
 * The discrete kinds of events a client may emit.
 *
 * - `prompt` — a user prompt to the agent
 * - `tool_use` — a single tool invocation within a prompt turn
 * - `session_summary` — a session-closing summary
 * - `note` — a manually recorded note (future use)
 *
 * Derived from {@link KiroMemEvent} so it stays in lockstep with the Zod
 * schema.
 *
 * @see Requirements 1.2
 */
export type EventKind = KiroMemEvent['kind'];

/**
 * Discriminated body. The `type` tells the collector how to interpret the
 * payload (text content, message turns, or arbitrary JSON data).
 *
 * @see Requirements 1.3
 */
export type EventBody = KiroMemEvent['body'];

/**
 * Provenance block — who emitted the event and from which client surface.
 *
 * @see Requirements 1.4
 */
export type EventSource = KiroMemEvent['source'];

/**
 * Parameters accepted by {@link StorageBackend.searchMemoryRecords}. The
 * `namespace` is treated as a prefix (trailing-slash convention); `query` is
 * a user-supplied string and is sanitized by the storage layer before being
 * passed to FTS5.
 *
 * @see Requirements 4.5, 8.3, 8.4
 */
export interface SearchParams {
  namespace: string;
  query: string;
  limit: number;
}

/**
 * Result returned to the shim in response to a `POST /v1/events` call. When
 * the shim requested synchronous retrieval, `retrieval` is populated.
 *
 * Not directly a requirement in this spec; part of the collector API
 * surface consumed by downstream receiver / retrieval specs.
 *
 * @see Requirements 1.5 (re-exported on the package entry point)
 */
export interface EventIngestResponse {
  event_id: string;
  stored: boolean;
  retrieval?: RetrievalResult;
}

/**
 * Context assembled by the retrieval subsystem for a single prompt-time
 * lookup. Returned inline in the ingest response.
 *
 * Not directly a requirement in this spec; part of the collector API
 * surface consumed by downstream retrieval specs.
 *
 * @see Requirements 1.5 (re-exported on the package entry point)
 */
export interface RetrievalResult {
  context: string;
  records: string[];
  latency_ms: number;
}

/**
 * Aggregate stats returned by `GET /v1/stats`. Contains global or
 * namespace-scoped counts plus breakdowns by observation type and event kind.
 *
 * Optional coverage fields (`embeddings_present`, `embeddings_missing`)
 * are additive and surfaced by backends that track memory-record
 * embedding coverage. Consumers MUST treat them as optional — a backend
 * that does not compute them omits the keys entirely (not `undefined`,
 * under `exactOptionalPropertyTypes`).
 *
 * @see Requirements 6.2 (visualizer-read-api)
 * @see Requirements 14.4 (local-embeddings-and-hybrid-search)
 */
export interface StatsResult {
  total_events: number;
  total_memories: number;
  total_projects: number;
  total_concepts: number;
  observation_types: Record<string, number>;
  event_kinds: Record<string, number>;
  /** Count of memory_records where embedding IS NOT NULL. */
  embeddings_present?: number;
  /** Count of memory_records where embedding IS NULL. */
  embeddings_missing?: number;
}

/**
 * Project info returned as part of the stats response. Carries the raw
 * `project_path` from storage; the receiver handler derives `project_id`
 * and `display_name` from it — storage stays platform-agnostic.
 *
 * @see Requirements 6.2 (visualizer-read-api)
 */
export interface ProjectInfo {
  namespace: string;
  project_path: string | null;
  event_count: number;
  memory_count: number;
}

/**
 * Storage backend interface. Any backend (SQLite, pgvector, AgentCore) must
 * implement this identically. v1 ships only the SQLite implementation.
 *
 * Behavioral contracts (see design.md § Key Functions):
 * - `putEvent` is idempotent on `event_id`; duplicate calls are a no-op and
 *   do not re-stamp `transaction_time`.
 * - `getEventById` returns `null` for unknown ids; it does not throw.
 * - `putMemoryRecord` rejects on `record_id` collision.
 * - `searchMemoryRecords` returns at most `limit` records, all of whose
 *   namespaces start with the supplied `namespace` prefix.
 * - `close` is safe to call more than once.
 *
 * Read methods (added by visualizer-read-api spec):
 * - `getStats` returns aggregate counts, optionally scoped to a namespace.
 * - `listProjects` returns distinct namespaces with counts and most recent
 *   `project_path`.
 * - `listMemoryRecords` returns all memory records for a namespace, newest
 *   first.
 * - `listEvents` returns the last N events for a namespace plus total count.
 *
 * @see Requirements 4.1–4.6, 6.1, 6.4 (visualizer-read-api)
 */
export interface StorageBackend {
  putEvent(event: KiroMemEvent): Promise<void>;
  getEventById(eventId: string): Promise<KiroMemEvent | null>;
  putMemoryRecord(record: MemoryRecord): Promise<void>;
  searchMemoryRecords(params: SearchParams): Promise<MemoryRecord[]>;
  close(): Promise<void>;

  /** Aggregate counts, optionally scoped to a namespace. @see Requirements 6.1 */
  getStats(namespace?: string): Promise<StatsResult>;

  /** Distinct namespaces with counts and most recent project_path. @see Requirements 6.1 */
  listProjects(): Promise<ProjectInfo[]>;

  /** Memory records, optionally scoped to a namespace, newest first. @see Requirements 6.1, 9.1 */
  listMemoryRecords(params: {
    namespace?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: MemoryRecord[]; total: number }>;

  /** Last N events, optionally scoped to a namespace, newest first, plus total count. @see Requirements 6.1, 6.4, 9.2 */
  listEvents(params: {
    namespace?: string;
    limit: number;
  }): Promise<{ items: KiroMemEvent[]; total: number }>;

  // ─────────────────────────────────────────────────────────────────────────
  // Embedding surface — added by local-embeddings-and-hybrid-search spec.
  //
  // These methods are orthogonal to the existing event/record surface and
  // back the two new write paths (`ExtractionWorker` synchronous embed and
  // `BackfillWorker` asynchronous embed) plus the hybrid search read path.
  //
  // Backends that do not support embeddings are expected to either
  // - implement them with durable storage of the raw Float32Array (the
  //   default SQLite backend does this via a 1536-byte little-endian BLOB
  //   column on `memory_records`), or
  // - reject with a clear error at daemon startup before any caller invokes
  //   them (no partial support).
  //
  // `searchMemoryRecords` intentionally keeps its signature. The new
  // `searchMemoryRecordsLexical` variant returns the same records paired
  // with their 1-based FTS5 rank so the hybrid fusion layer can compute
  // Reciprocal Rank Fusion without reconstructing rank from ordering.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Write the embedding for an existing memory record. Idempotent:
   * repeated writes overwrite. Called by ExtractionWorker immediately
   * after `putMemoryRecord` and by BackfillWorker for pre-existing
   * records.
   *
   * If `recordId` does not exist, this is a no-op (the underlying
   * UPDATE matches zero rows). Returns `void` in either case.
   *
   * `embedding` MUST be a 384-dimensional `Float32Array`. Passing a
   * vector of a different length is a caller bug; backends MAY throw.
   *
   * @see Requirements 3.3, 4.1, 4.2, 8.6, 19.2
   */
  putEmbedding(recordId: string, embedding: Float32Array): Promise<void>;

  /**
   * Read a single embedding. Returns `null` if the record has no
   * embedding stored, or if the record does not exist.
   *
   * Exposed for tests and future reconciliation flows; the hybrid search
   * read path uses {@link listEmbeddings} for bulk access.
   *
   * @throws If the stored blob is not exactly 1536 bytes; the error
   *         message includes the offending `recordId` to ease
   *         identification.
   *
   * @see Requirements 4.1, 15.3
   */
  getEmbedding(recordId: string): Promise<Float32Array | null>;

  /**
   * Bulk-load all non-null embeddings for records whose namespace
   * equals the given `namespace` (exact match, not prefix — the hybrid
   * search read path scopes to a single concrete namespace).
   *
   * Returns embeddings as raw `Float32Array`; normalisation and cosine
   * math live in the embedding module, not the storage backend.
   *
   * `created_at` is returned alongside the vector because the fusion
   * layer uses it as a deterministic tie-break when two records have
   * identical fused scores.
   *
   * @see Requirements 4.7, 5.8
   */
  listEmbeddings(namespace: string): Promise<
    Array<{
      record_id: string;
      embedding: Float32Array;
      created_at: string;
    }>
  >;

  /**
   * Return up to `limit` memory records whose embedding is NULL,
   * optionally scoped to a namespace. When `namespace` is `null`, the
   * scan is global across all namespaces.
   *
   * Order: `created_at ASC` — oldest records first, so the
   * BackfillWorker progresses deterministically and crash-resumes
   * cleanly (every iteration re-queries `embedding IS NULL`; already-
   * embedded rows are skipped on restart).
   *
   * @see Requirements 8.4, 8.6, 19.2
   */
  listRecordsWithoutEmbedding(
    namespace: string | null,
    limit: number,
  ): Promise<MemoryRecord[]>;

  /**
   * Lexical-only search surface for the hybrid layer. Returns FTS5-
   * ranked records paired with their 1-based rank so the fusion layer
   * does not have to reconstruct rank from ordering.
   *
   * Behaviour is otherwise identical to {@link searchMemoryRecords} —
   * same `SearchParams` shape, same namespace-prefix isolation, same
   * sanitisation and LIKE fallback. The existing `searchMemoryRecords`
   * method is retained unchanged for backward compatibility; callers
   * that do not need the rank MUST keep using it.
   *
   * @see Requirements 5.1, 8.1 (local-embeddings-and-hybrid-search)
   */
  searchMemoryRecordsLexical(
    params: SearchParams,
  ): Promise<Array<{ record: MemoryRecord; rank: number }>>;

  // ─────────────────────────────────────────────────────────────────────────
  // Reconciliation surface — added by the reconciliation-engine spec.
  //
  // The Reconciliation Stage emits either a Summary Record (with its
  // merged originals deleted) or the candidates as-is. Both commit paths
  // touch multiple rows — memory record, embedding (nullable column on
  // the same row), and the FTS5 companion — and must land atomically
  // per Requirement 8.1. `deleteMemoryRecord` covers the unit-of-work
  // expressed as a single-method call; `withTransaction` covers the
  // merge path that mixes puts and deletes in one BEGIN/COMMIT.
  //
  // Both methods are additive and do not alter the existing read or
  // write surface.
  //
  // @see .kiro/specs/reconciliation-engine/design.md § StorageBackend
  //       interface extensions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Delete one or more memory records by id. A single call is treated
   * as a single logical unit of work: every listed id is removed from
   * `memory_records`, its embedding column is nulled, and its FTS5
   * companion row is removed — all inside one transaction so the three
   * deletes land atomically.
   *
   * Idempotent: ids that do not exist in `memory_records` are a silent
   * no-op (no throw, no writes). Callers can retry a partially-applied
   * merge without having to track which ids already went through
   * (Requirement 9.5).
   *
   * The caller-supplied list is treated as a set; duplicate ids are
   * processed once per occurrence but the net effect is idempotent.
   *
   * @see Requirements 9.1, 9.2, 9.3, 9.4, 9.5
   */
  deleteMemoryRecord(recordIds: readonly string[]): Promise<void>;

  /**
   * Run `fn` inside a single SQLite transaction. The callback receives
   * a {@link StorageTransaction} handle exposing the subset of write
   * operations the reconciler needs (put a memory record, put an
   * embedding, delete memory records). All three handle methods are
   * **synchronous** because `better-sqlite3` transactions are
   * synchronous: awaiting inside the transaction body would lose the
   * BEGIN/COMMIT boundary and defeat the atomicity contract.
   *
   * `fn` itself may be sync or async in shape, but its body MUST NOT
   * return a Promise — every operation performed through the
   * {@link StorageTransaction} handle must complete before `fn`
   * returns. Implementations MAY reject with a clear error when `fn`
   * returns a Promise (the SQLite backend does so).
   *
   * On throw from `fn`, the transaction is rolled back in full: no
   * partial writes remain visible. On clean return, the transaction
   * commits and `withTransaction` resolves with `fn`'s return value.
   *
   * @see Requirements 8.1, 9.1, 9.2, 9.3
   */
  withTransaction<T>(fn: (tx: StorageTransaction) => Promise<T> | T): Promise<T>;
}

/**
 * Synchronous write handle surfaced inside a
 * {@link StorageBackend.withTransaction} callback.
 *
 * The three methods mirror their async counterparts on {@link
 * StorageBackend} but return `void` — callers must not `await` them.
 * `better-sqlite3` transactions run synchronously, so the callback body
 * must complete without yielding to the microtask queue; otherwise the
 * BEGIN/COMMIT boundary is broken and atomicity is lost.
 *
 * There is intentionally no `close` method and no nested
 * `withTransaction`: the handle is bound to the enclosing transaction
 * and is not valid outside that scope.
 *
 * @see Requirements 8.1, 9.1, 9.2, 9.3, 9.4
 */
export interface StorageTransaction {
  /**
   * Insert a memory record inside the enclosing transaction. Same
   * schema-level contract as {@link StorageBackend.putMemoryRecord} —
   * a `record_id` collision raises and rolls the transaction back.
   */
  putMemoryRecord(record: MemoryRecord): void;

  /**
   * Write (or overwrite) the embedding for an existing memory record
   * inside the enclosing transaction. Same contract as
   * {@link StorageBackend.putEmbedding}: no-op when `recordId` does
   * not exist.
   */
  putEmbedding(recordId: string, embedding: Float32Array): void;

  /**
   * Delete memory records by id inside the enclosing transaction.
   * Same contract as {@link StorageBackend.deleteMemoryRecord},
   * including idempotency on unknown ids.
   */
  deleteMemoryRecord(recordIds: readonly string[]): void;
}
