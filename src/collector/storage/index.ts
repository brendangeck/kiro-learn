/**
 * Storage — the pluggable persistence layer.
 *
 * Every storage backend (v1 SQLite + FTS5; v4 pgvector; v4 Bedrock AgentCore
 * Memory) implements the same {@link StorageBackend} interface. The pipeline
 * never reaches past this module into a specific implementation: swapping
 * backends is a matter of choosing a different opener (e.g.
 * `openSqliteStorage`) at collector bootstrap time.
 *
 * This module re-exports the interface plus its parameter types from
 * `src/types/index.ts` so downstream code can import everything it needs
 * from a single path (`.../collector/storage/index.js`) and so `go-to-
 * definition` lands here as the canonical storage entry point.
 *
 * ## Method contracts (authoritative)
 *
 * Below is the exhaustive behavioral contract every backend must satisfy.
 * These mirror design.md §
 * [Key Functions with Formal Specifications](../../../.kiro/specs/event-schema-and-storage/design.md#key-functions-with-formal-specifications)
 * and the corresponding acceptance criteria in requirements.md
 * (§ Requirement 4, plus storage-semantics requirements 6–8, 11).
 *
 * Backends may be stricter than the contract but MUST NOT be looser.
 *
 * ### `putEvent(event: KiroMemEvent): Promise<void>`
 *
 * Idempotent insert keyed on `event_id`.
 *
 * - **Preconditions.**
 *   - `event` has been validated by the pipeline (normally via
 *     `parseEvent`); shape and field-level invariants hold.
 *   - `event.body` has been privacy-scrubbed; no `<private>…</private>`
 *     spans remain. Storage does not check this; the pipeline owns the
 *     contract (see requirements.md § 10).
 *   - The backend is open and migrations have been applied.
 * - **Postconditions.**
 *   - If no row exists with `event_id = event.event_id`, a new row is
 *     inserted and `transaction_time` is stamped at insert time (ISO 8601
 *     UTC) on first insert.
 *   - If a row already exists, the call is a no-op: the existing row —
 *     including its original `transaction_time` — is not mutated.
 *   - Resolves with `void` on either path.
 * - **Errors.**
 *   - Rejects on underlying I/O failures or constraint violations beyond
 *     the primary-key conflict (which is handled as the idempotency
 *     no-op).
 *
 * @see Requirements 4.1, 4.2, 6.1, 6.2, 6.3, 6.4, 11.1, 11.2
 *
 * ### `getEventById(eventId: string): Promise<KiroMemEvent | null>`
 *
 * Point lookup by primary key.
 *
 * - **Preconditions.**
 *   - `eventId` is a string. ULID format is not enforced at the storage
 *     boundary; a non-ULID simply will not match any row.
 *   - The backend is open.
 * - **Postconditions.**
 *   - Returns the full `KiroMemEvent` reassembled from storage when a row
 *     exists. The internal `transaction_time` is not surfaced on the
 *     public type.
 *   - Returns `null` when no row matches.
 *   - Never throws for the not-found case.
 * - **Errors.**
 *   - Rejects only on genuine I/O / decode failures against a row that
 *     does exist.
 *
 * @see Requirements 4.1, 4.3, 7.1, 7.2
 *
 * ### `putMemoryRecord(record: MemoryRecord): Promise<void>`
 *
 * Insert a memory record and its FTS index row atomically.
 *
 * - **Preconditions.**
 *   - `record` has been validated (normally via `parseMemoryRecord`).
 *   - `record.record_id` is globally unique in this store.
 *   - The backend is open.
 * - **Postconditions.**
 *   - Inserts into `memory_records` and `memory_records_fts` in a single
 *     transaction; either both rows land or neither does.
 *   - Resolves with `void`.
 * - **Errors.**
 *   - Rejects on `record_id` collision. Records are not deduplicated at
 *     this layer; a collision is an upstream bug.
 *   - Rejects on underlying I/O / constraint failures.
 *
 * @see Requirements 4.1, 4.4, 8.1, 8.2
 *
 * ### `searchMemoryRecords(params: SearchParams): Promise<MemoryRecord[]>`
 *
 * Namespace-scoped full-text search over memory records.
 *
 * - **Preconditions.**
 *   - `params.namespace` matches the namespace regex
 *     `/^\/actor\/[^/]+\/project\/[^/]+\/$/` (enforced upstream).
 *   - `params.query` is a non-empty string.
 *   - `params.limit > 0`.
 *   - The backend is open.
 * - **Postconditions.**
 *   - Returns at most `params.limit` records.
 *   - Every returned record's `namespace` starts with `params.namespace`
 *     (prefix match; guarantees isolation across actors and projects).
 *   - Results are ordered by FTS5 rank, best match first.
 * - **Errors.**
 *   - On an FTS5-malformed query, the backend falls back to a LIKE-based
 *     match ordered by `created_at DESC` rather than failing the call
 *     (availability over rank quality). User-controlled text MUST NOT be
 *     spliced as raw FTS5 syntax.
 *
 * @see Requirements 4.1, 4.5, 8.3, 8.4, 8.5, 11.3, 12.1, 12.2
 *
 * ### `close(): Promise<void>`
 *
 * Release underlying resources.
 *
 * - **Preconditions.** None beyond a previously constructed backend.
 * - **Postconditions.**
 *   - The underlying handle (SQLite file, connection pool, etc.) is
 *     released.
 *   - The call is idempotent; a second `close()` on an already-closed
 *     backend is a no-op and does not throw.
 * - **Errors.**
 *   - Rejects only on a genuine failure to release resources on the first
 *     close. Subsequent closes never reject.
 *
 * @see Requirements 4.1, 4.6, N4
 *
 * @module
 */

/**
 * Parameters accepted by {@link StorageBackend.searchMemoryRecords}. The
 * `namespace` is treated as a prefix (trailing-slash convention); `query`
 * is a user-supplied string and the backend is responsible for quoting it
 * safely before handing it to FTS5. `limit` must be strictly positive.
 *
 * @see Requirements 4.5, 8.3, 8.4, 12.2
 */
export type { SearchParams } from '../../types/index.js';

/**
 * Pluggable storage interface. Every backend (SQLite v1; pgvector v4;
 * Bedrock AgentCore Memory v4) implements this identically. See the
 * module-level TSDoc above for the per-method contract, or design.md §
 * Key Functions for the authoritative spec.
 *
 * @see Requirements 4.1–4.6
 */
export type { StorageBackend } from '../../types/index.js';

/**
 * Aggregate stats and project info types used by the visualizer read API.
 *
 * @see Requirements 6.2 (visualizer-read-api)
 */
export type { StatsResult, ProjectInfo } from '../../types/index.js';
