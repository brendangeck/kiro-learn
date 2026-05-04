# Implementation Plan: Reconciliation Engine

## Overview

Replace today's single-stage `ExtractionWorker` with a two-stage **Ingestion Pipeline**: an Extraction Stage that emits in-memory Candidate Memories, followed by a Reconciliation Stage that clusters intra-batch duplicates, queries the per-namespace vector index for neighbors, invokes a new `kiro-learn-reconciler` judge via ACP, and either commits a merged Summary Record (deleting the merged originals in the same transaction) or commits the candidates as-is.

Implementation order is dependency-aware. Types land first (Zod schemas for `CandidateMemory` and the judge surface — the `MemoryRecord` schema is unchanged), then the `StorageBackend` extensions (`deleteMemoryRecord`, `withTransaction`), then the query-layer extensions (`getVectorIndex`, `lookupNeighbors`). Only after those land do we create the new `src/collector/ingestion/` folder — its leaf modules (`candidate`, `clustering`, `judge-xml`, `circuit-breaker`) are independent, but all feed into `reconciler.ts`, which feeds into the `IngestionPipeline` in `index.ts`. Finally we refactor `ExtractionWorker` to a thin shim over `IngestionPipeline`, update collector wiring + buffer-watcher defaults, ship the installer agent config, then guard tests and docs.

All code is TypeScript (ESM-only, Node ≥ 22, `.js` import extensions, `import type` for type-only imports, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). New modules live at `src/collector/ingestion/` and receive `StorageBackend`, `Embedder`, `QueryLayer`, and `BufferStore` via DI — they must NOT import from `src/collector/storage/sqlite/`.

Property numbering below matches `design.md` § Correctness Properties (Properties 1–24). Requirement references cite requirement sub-clauses (`N.M`) from `requirements.md`.

## Tasks

- [x] 1. Schema additions and test generators
  - [x] 1.1 Add `CandidateMemorySchema` to wire schemas
    - In `src/types/schemas.ts` add `CandidateMemorySchema` mirroring `MemoryRecordSchema` fields (`record_id`, `namespace`, `strategy`, `title`, `summary`, `facts`, `concepts`, `files_touched`, `observation_type`, `source_event_ids`) with identical regexes and length caps
    - Export `type CandidateMemory = z.infer<typeof CandidateMemorySchema> & { embedding: Float32Array | null }` — the `embedding` field is intersected on the TypeScript type only
    - The `MemoryRecordSchema` itself is unchanged — no new fields, no migration
    - _Requirements: 3.2, 3.5_
    - _Design: Data Models § Wire schema additions_

  - [x] 1.2 Add judge-response schemas (discriminated union)
    - In `src/types/schemas.ts` add `JudgeMergeResponseSchema`, `JudgeKeepSeparateResponseSchema`, and `JudgeResponseSchema = z.discriminatedUnion('kind', […])`
    - `JudgeMergeResponseSchema` fields: `kind: 'merge'`, `merged_record_ids: z.array(...).min(1)`, `title`, `summary`, `facts`, `concepts`, `files_touched`, `observation_type?` (optional)
    - Export `type JudgeResponse = z.infer<typeof JudgeResponseSchema>`
    - _Requirements: 6.3, 6.4, 6.5_
    - _Design: Data Models § Wire schema additions_

  - [x] 1.3 Extend fast-check generators in `test/helpers/arbitrary.ts`
    - Add `arbitraryCandidateMemory()` — valid `CandidateMemory` including a `Float32Array(384)` or `null` embedding (mix of both)
    - Add `arbitraryJudgeResponse()` — generates both `{kind: 'merge', ...}` and `{kind: 'keep_separate'}` variants
    - The existing `arbitraryMemoryRecord` generator is unchanged
    - _Requirements: supports Properties 1, 5, 7, 11, 12, 13, 15_
    - _Design: Testing Strategy § Mocks for property tests_

  - [x] 1.4 Unit tests for schema changes
    - Test `CandidateMemorySchema` accepts every field the existing `MemoryRecordSchema` accepts and does NOT validate an `embedding` field
    - Test `JudgeResponseSchema` discriminates correctly on `kind` and rejects merge bodies missing `merged_record_ids`
    - Test file: `test/unit/schemas-reconciliation.test.ts`
    - _Requirements: 3.2, 6.3, 6.4_

- [x] 2. `StorageBackend` interface and SQLite extensions
  - [x] 2.1 Extend `StorageBackend` interface with `deleteMemoryRecord` and `withTransaction`
    - Edit `src/types/index.ts` to add to `StorageBackend`: `deleteMemoryRecord(recordIds: readonly string[]): Promise<void>` and `withTransaction<T>(fn: (tx: StorageTransaction) => Promise<T> | T): Promise<T>`
    - Add new exported interface `StorageTransaction` exposing `putMemoryRecord`, `putEmbedding`, and `deleteMemoryRecord` (no `close`, no nested `withTransaction`)
    - Read signatures are unchanged — no new parameters, no new defaults
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 13.1_
    - _Design: Components and Interfaces § `StorageBackend` interface extensions_

  - [x] 2.2 Add prepared statements for `deleteMemoryRecord` + FTS5 cascade
    - **FTS5 integration check**: the existing FTS5 table is populated by explicit `INSERT INTO memory_records_fts (...)` statements in `src/collector/storage/sqlite/statements.ts` (`insertMemoryRecordFts`). Migration 0001 creates `memory_records_fts` as a plain (non-content-linked) FTS5 virtual table with no triggers. Therefore deletions must also be explicit — add a corresponding `DELETE FROM memory_records_fts WHERE record_id = ?` statement
    - Edit `src/collector/storage/sqlite/statements.ts` to add three new prepared statements:
      - `deleteMemoryRecordById`: `DELETE FROM memory_records WHERE record_id = ?`
      - `deleteMemoryRecordFtsById`: `DELETE FROM memory_records_fts WHERE record_id = ?`
      - `deleteEmbeddingByRecordId`: `DELETE FROM embeddings WHERE record_id = ?`
    - Existing read statements are untouched — reads return whatever rows exist
    - _Requirements: 9.1, 9.2, 9.3, 9.4_
    - _Design: Data Models § SQLite statement updates_

  - [x] 2.3 Implement `deleteMemoryRecord` and `withTransaction` in SQLite backend
    - Edit `src/collector/storage/sqlite/index.ts` to implement `deleteMemoryRecord(recordIds)`: wrap in `db.transaction((ids) => { for (const id of ids) { deleteMemoryRecordFtsById.run(id); deleteEmbeddingByRecordId.run(id); deleteMemoryRecordById.run(id); } })`. Since `DELETE` on a nonexistent row is a zero-row no-op, idempotency (Requirement 9.5) is built in — unknown ids don't raise
    - Implement `withTransaction(fn)`: builds a `StorageTransaction` handle exposing `putMemoryRecord`, `putEmbedding`, and `deleteMemoryRecord`, all binding into the same `db.transaction(() => { ... })` body; awaits the callback (better-sqlite3 is synchronous but the callback may still be async — resolve synchronously when possible, else rethrow from inside the tx body so it rolls back)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 8.1_
    - _Design: Components and Interfaces § `StorageBackend` interface extensions_

  - [x] 2.4 Unit tests for `deleteMemoryRecord` and `withTransaction`
    - Test `deleteMemoryRecord` happy path: deleting a record removes the row from `memory_records`, the matching embedding from `embeddings`, and the matching FTS5 entry from `memory_records_fts`, all atomically
    - Test `deleteMemoryRecord` idempotent on nonexistent ids: calling with an id that isn't in `memory_records` is a silent no-op (no throw, no writes)
    - Test `deleteMemoryRecord` batch: deleting multiple ids in one call removes exactly those rows and leaves all others intact
    - Test `withTransaction` happy path: a `putMemoryRecord + deleteMemoryRecord + putEmbedding` body commits atomically
    - Test `withTransaction` rollback: a body that throws leaves the database unchanged — no partial writes visible afterward, and any rows that would have been deleted are still present
    - Test file: `test/unit/sqlite-backend-delete-memory-record.test.ts`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 8.1_

  - [x] 2.5 Property tests for merge commit semantics (Properties 15, 18)
    - **Property 15: Merge commit semantics** — after a `<merge>` commit, every merged id is absent from `storage.getMemoryRecord` and absent from `storage.listEmbeddings`; the summary record is readable by its own `record_id`; no row outside the merged set is mutated or deleted
    - **Property 18: Summary-commit atomicity** — an injected failure inside `withTransaction` rolls back `putMemoryRecord + deleteMemoryRecord + putEmbedding` atomically (summary absent, merged rows still present, embeddings still present)
    - Test file: `test/unit/sqlite-backend-delete-memory-record.property.test.ts`
    - 50 runs each
    - **Validates: Requirements 6.4, 7.1, 7.4, 7.5, 8.1, 9.1, 9.2, 9.3, 9.4, 9.5, 13.4**

- [x] 3. `QueryLayer` extensions — `getVectorIndex` and `lookupNeighbors`
  - [x] 3.1 Extend `QueryLayer` interface with reconciler-only read helpers
    - Edit `src/collector/query/index.ts` to add `getVectorIndex(namespace: string): Promise<NamespaceVectorIndex>` (returns the same shape the cache produces today) and `lookupNeighbors(namespace: string, centroid: Float32Array, threshold: number, cap: number): Promise<Array<{ record: MemoryRecord; similarity: number }>>`
    - `lookupNeighbors` walks `getVectorIndex(ns).entries`, scores each with `cosine(centroid, entry.vec_normalised)`, filters `similarity >= threshold`, sorts descending, truncates to `cap`
    - Standard namespace lookup returns the post-delete row set — merged rows are deleted from `memory_records` by construction
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
    - _Design: Components and Interfaces § `src/collector/query/index.ts` — tiny extension_

  - [x] 3.2 Unit tests for `lookupNeighbors`
    - Test threshold: records with similarity strictly below `threshold` are excluded
    - Test cap: with 20 records above threshold and cap=10, exactly 10 are returned — the top-10 by similarity
    - Test sort order: output is sorted by similarity descending
    - Test namespace scoping: records in other namespaces are never returned
    - Test file: `test/unit/embedding-query-layer-lookup-neighbors.test.ts`
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 3.3 Property test for neighbor lookup (Property 9)
    - **Property 9: Neighbor lookup filters correctly**
    - For any set of existing memory records and any centroid + threshold + cap, the output of `lookupNeighbors(ns, centroid, τ, cap)` satisfies: every returned record has `namespace === ns`, cosine similarity ≥ τ; output length is ≤ cap; output is sorted by similarity descending
    - Test file: `test/unit/ingestion-neighbor-lookup.property.test.ts`
    - 100 runs
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

- [x] 4. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Ingestion module — `candidate.ts` (Extraction Stage output)
  - [x] 5.1 Create `src/collector/ingestion/candidate.ts`
    - Export `CandidateMemory` type (re-export from `src/types/schemas.ts`)
    - Export `extractCandidates(entries, config, deps): Promise<CandidateMemory[]>` — lifts `frameBatchXml` + `invokeBatchCompressor` verbatim from today's `src/collector/buffer/extraction.ts`; attaches the embedder output to each candidate instead of calling `putEmbedding`
    - On `embedder === null` or `!embedder.isReady()` or a per-record embed failure: emit the candidate with `embedding: null` and write the existing stderr warning containing the candidate's `record_id`
    - Assign each candidate a fresh `record_id` of the form `mr_<ULID>` using the existing ULID generator
    - Export `toMemoryRecord(c: CandidateMemory): MemoryRecord` — stamps `created_at = new Date().toISOString()` and strips the transient `embedding` field
    - NEVER call `storage.putMemoryRecord` or `storage.putEmbedding` from this module
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
    - _Design: Components and Interfaces § `candidate.ts` — Candidate Memory_

  - [x] 5.2 Unit tests for `extractCandidates`
    - Test zero writes: extract a batch against a spy `StorageBackend` and assert `putMemoryRecord` and `putEmbedding` are never called
    - Test candidate shape: every emitted candidate has valid `record_id`, `namespace`, `source_event_ids`, and either `Float32Array(384)` or `null` for `embedding`
    - Test embedder failure path: with a failing embedder stub, every candidate has `embedding === null` and a stderr warning was emitted per record
    - Test `toMemoryRecord` stamps `created_at` and does not include an `embedding` field on the output
    - Test file: `test/unit/ingestion-candidate.test.ts`
    - _Requirements: 3.1, 3.3, 3.4, 3.5_

  - [x] 5.3 Property tests for candidate construction (Properties 3, 10, 11, 12)
    - **Property 3: Extraction never writes** — a run of `extractCandidates` makes zero `putMemoryRecord` / `putEmbedding` / `deleteMemoryRecord` calls
    - **Property 10: Candidate embedding input parity** — the argument to `embedder.embed(...)` equals `composeEmbeddingInput(toMemoryRecord(candidate))`
    - **Property 11: Null-embedding propagation on embedder failure** — with a failing embedder, every candidate has `embedding === null` and the full candidate list is returned (no drops)
    - **Property 12: Record ID format and uniqueness** — every candidate `record_id` matches `/^mr_[0-9A-HJKMNP-TV-Z]{26}$/` and no two collide within a run
    - Test file: `test/unit/ingestion-candidate.property.test.ts`
    - 100 runs each
    - **Validates: Requirements 3.1, 3.3, 3.4, 3.5, 7.2**

- [x] 6. Ingestion module — `clustering.ts` (intra-batch union-find)
  - [x] 6.1 Create `src/collector/ingestion/clustering.ts`
    - Pure function, no I/O, no imports from `storage/sqlite`
    - Export `Cluster = { members: readonly number[]; centroid: Float32Array | null }`
    - Export `intraBatchCluster(candidates: readonly CandidateMemory[], threshold: number): readonly Cluster[]`
    - Algorithm: union-find over `[0, candidates.length)`; null-embedding candidates stay singletons (never unioned); for each non-null pair `(i, j)` with `i < j`, compute `cosine(...)` and `union(i, j)` when `>= threshold`; emit clusters in order of first appearance
    - Centroid: `normalize(mean(member.embedding))` when every member has non-null embedding, else `null`
    - Use `cosine` + `normalize` from `src/collector/embedding/cosine.ts` via the barrel
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6_
    - _Design: Components and Interfaces § `clustering.ts` — pure intra-batch clustering_

  - [x] 6.2 Unit tests for intra-batch clustering
    - Test empty input returns `[]`
    - Test single-candidate input returns one singleton cluster with `centroid === normalize(candidate.embedding)`
    - Test known-similar pair at cosine 0.90 with threshold 0.85 merges into one cluster
    - Test known-distinct pair at cosine 0.30 with threshold 0.85 stays in separate clusters
    - Test threshold edge case: cosine `=== threshold` merges (inclusive `>=`)
    - Test determinism: same input produces same cluster ordering
    - Test file: `test/unit/ingestion-clustering.test.ts`
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6_

  - [x] 6.3 Property tests for clustering (Properties 5, 6, 7, 8)
    - **Property 5: Clustering partitions the input** — union of all `cluster.members` equals `[0, n)`, every index appears in exactly one cluster
    - **Property 6: Clustering respects the similarity threshold (monotonic)** — raising threshold never merges clusters that weren't merged at a lower threshold
    - **Property 7: Null-embedding candidates are singletons** — any candidate with `embedding === null` is in its own singleton cluster
    - **Property 8: Cluster centroid is a unit vector** — for clusters with all non-null embeddings, `||centroid|| === 1.0` within 1e-5; clusters containing any null-embedding member have `centroid === null`
    - Test file: `test/unit/ingestion-clustering.property.test.ts`
    - 200 runs each
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6**

- [x] 7. Ingestion module — `judge-xml.ts` (prompt framing + response parsing)
  - [x] 7.1 Create `src/collector/ingestion/judge-xml.ts`
    - Export `JudgeRequest`, `JudgeResponse` types (the latter aligned with the Zod `JudgeResponseSchema` from task 1.2)
    - Export `frameJudgePrompt(req: JudgeRequest): string` — emits a `<reconciliation_request>` XML block with `<candidate_cluster>` and `<neighbor_pool>` children; reuses `escapeXml` from `src/collector/pipeline/xml-framer.ts`
    - Export `parseJudgeResponse(xml: string): JudgeResponse | null` — returns `null` on non-XML / garbage / neither `<merge>` nor `<keep_separate/>`; reuses `unescapeXml` from `src/collector/pipeline/xml-parser.ts`
    - Prompt and response grammar exactly as specified in the design (see snippets under "Response shape")
    - Must NOT import from `src/collector/storage/` or `src/collector/ingestion/reconciler.ts`
    - _Requirements: 6.2, 6.3_
    - _Design: Components and Interfaces § `judge-xml.ts` — prompt framing and response parsing_

  - [x] 7.2 Unit tests for judge XML framing and parsing
    - Test `frameJudgePrompt` XML-escapes `<`, `&`, `"` in titles, summaries, facts
    - Test `parseJudgeResponse` accepts a minimal `<merge>...</merge>` block and returns `{kind: 'merge', merged_record_ids, title, summary, facts, concepts, files_touched}`
    - Test `parseJudgeResponse` accepts `<keep_separate/>` and returns `{kind: 'keep_separate'}`
    - Test `parseJudgeResponse` returns `null` for: empty string, garbage text, well-formed XML with neither tag, `<merge>` missing `merged_record_ids`
    - Test file: `test/unit/ingestion-judge-xml.test.ts`
    - _Requirements: 6.2, 6.3, 6.7_

  - [x] 7.3 Property test for judge XML round-trip (Property 13)
    - **Property 13: Judge XML round-trip preserves content**
    - For any `JudgeRequest`, a `parseJudgePrompt(frameJudgePrompt(req))` helper round-trips cluster record_ids, neighbor record_ids, all string fields after XML unescaping
    - For any `JudgeResponse`, `parseJudgeResponse(serializeJudgeResponse(resp))` returns a structurally-equal discriminated union
    - Test file: `test/unit/ingestion-judge-xml.property.test.ts`
    - 200 runs
    - **Validates: Requirements 6.2, 6.3**

- [x] 8. Ingestion module — `circuit-breaker.ts` (per-project judge circuit breaker)
  - [x] 8.1 Create `src/collector/ingestion/circuit-breaker.ts`
    - Export `ReconciliationCircuitBreaker` interface: `isOpen(projectId): boolean`, `record(projectId, outcome: 'success' | 'failure'): void`, `onRunComplete(projectId, anyJudgeFailure: boolean): void`, `_state(projectId)` (test-only)
    - Export `createReconciliationCircuitBreaker(maxConsecutiveFailures?: number): ReconciliationCircuitBreaker` — default `maxConsecutiveFailures = 3`
    - State: closed at start; opens when `consecutiveFailures >= 3`; resets to closed when `onRunComplete(pid, anyJudgeFailure: false)` is called (including trivially zero-judge-invocation runs, so a tripped breaker self-recovers after the next direct-commit run)
    - State is independent per `projectId` — a `Map<string, { consecutiveFailures: number; open: boolean }>`
    - _Requirements: 12.1, 12.2, 12.3_
    - _Design: Components and Interfaces § `circuit-breaker.ts` — per-project reconciliation circuit breaker_

  - [x] 8.2 Unit tests for circuit breaker state machine
    - Test starts closed: fresh breaker has `isOpen('p1') === false`
    - Test opens after 3 consecutive failures: `record('p1', 'failure')` × 3 → `isOpen('p1') === true`
    - Test `record('p1', 'success')` mid-sequence resets `consecutiveFailures` to 0
    - Test `onRunComplete('p1', false)` closes the breaker (including the direct-commit-path case with zero judge invocations)
    - Test per-project isolation: failures on `'p1'` never open the breaker for `'p2'`
    - Test file: `test/unit/ingestion-circuit-breaker.test.ts`
    - _Requirements: 12.1, 12.2, 12.3_

  - [x] 8.3 Property test for circuit breaker (Property 24)
    - **Property 24: Reconciliation circuit breaker state machine**
    - For any sequence of judge outcomes on a given `projectId`: (a) starts closed; (b) opens after the 3rd consecutive failure; (c) re-closes after the next ingestion run completes with zero judge failures; (d) state is independent per `projectId`
    - Test file: `test/unit/ingestion-circuit-breaker.property.test.ts`
    - 200 runs
    - **Validates: Requirements 12.1, 12.2, 12.3**

- [x] 9. Ingestion module — `reconciler.ts` (neighbor lookup + judge + commit)
  - [x] 9.1 Create `src/collector/ingestion/reconciler.ts`
    - Export `ReconciliationContext`, `ReconciliationOutcome` interfaces (exactly as specified in the design)
    - Export `reconcile(candidates, ctx): Promise<ReconciliationOutcome>` implementing the design's step-by-step flow
    - Per-cluster steps:
      1. If `cluster.centroid === null`: commit each member as a new record (+ `putEmbedding` iff the member has a non-null embedding); no judge invocation
      2. Otherwise: `query.lookupNeighbors(ns, centroid, τ_neighbor, cap)` → if empty, commit members as new records; else frame + send judge prompt via ACP with `kiro-learn-reconciler`
      3. Judge timeout → record failure, fall back to keep-separate (no retry — timeout burned the full budget)
      4. Judge non-XML / unparseable → retry up to 2 total attempts with a fresh session; on second failure fall back to keep-separate
      5. Judge `<merge>`: build summary record, embed its `composeEmbeddingInput` output, commit within `storage.withTransaction`: `putMemoryRecord(summary) + deleteMemoryRecord(mergedIds) + putEmbedding(summary.record_id, vec)`
      6. Judge `<keep_separate/>`: commit each cluster member as a new record in one transaction
      7. After any commit, call `query.invalidateNamespace(ns)`
    - Per-cluster failures are caught and logged; loop continues with the next cluster (Requirement 8.2)
    - Every ACP session follows the single-use pattern: `createAcpSession('kiro-learn-reconciler', ...)` → `sendPrompt` → `destroy()` in a `finally` block
    - Every judge outcome feeds `ctx.circuitBreaker.record(projectId, 'success' | 'failure')`
    - Ignore unknown `record_id`s in the judge response; if the known subset is empty, fall back to keep-separate
    - Summary record construction: `strategy: 'llm-reconciled'`, fresh `record_id = 'mr_' + ulid()`, `source_event_ids = dedupedFirstSeenUnion(...)`, `observation_type = judge.observation_type ?? highestSimilarityMember.observation_type`, `created_at = new Date().toISOString()`, `namespace = cluster.namespace`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3, 11.2, 12.1, 12.2_
    - _Design: Components and Interfaces § `reconciler.ts` — neighbor lookup, judge invocation, commit_

  - [x] 9.2 Unit tests for reconciler — empty neighbor pool
    - Test with an empty storage, a single cluster, and a representative centroid → no judge session is created, members are committed as new records
    - Test with `centroid === null` cluster → no neighbor lookup, no judge, members committed as-is with `putEmbedding` skipped for null-embedding members
    - Use a `ScriptedJudgeSession` to assert it was never instantiated
    - Test file: `test/unit/ingestion-reconciler-no-judge.test.ts`
    - _Requirements: 5.5, 6.1_

  - [x] 9.3 Unit tests for reconciler — merge path
    - Test with two candidates + one existing neighbor above threshold, scripted judge returns `<merge>` citing both candidates and the neighbor → one summary record committed with `strategy === 'llm-reconciled'`
    - Expected DB state post-merge: the neighbor row is ABSENT from `storage.getMemoryRecord`; its embedding is ABSENT from `storage.listEmbeddings`; its FTS5 entry is ABSENT from `memory_records_fts`; the summary record is readable by its own `record_id`
    - Candidates in a merge are NOT written as standalone rows; only the summary is written (the judge's `merged_record_ids` covers both the neighbor(s) and any candidates it wants rolled into the summary — the reconciler does not also persist those candidates separately)
    - Test `source_event_ids` = deduped first-seen union
    - Test file: `test/unit/ingestion-reconciler-merge.test.ts`
    - _Requirements: 6.4, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 9.1, 9.2, 9.3_

  - [x] 9.4 Unit tests for reconciler — keep-separate path
    - Test with scripted judge returning `<keep_separate/>` → all cluster members committed as new records, no `deleteMemoryRecord` calls
    - Test judge timeout → fall back to keep-separate, circuit breaker records a failure
    - Test judge non-XML response → retried once with a fresh session; on second failure falls back to keep-separate, circuit breaker records 2 failures
    - Test judge references an unknown `record_id` → ignored with warning; if known subset is empty, fall back to keep-separate
    - Test file: `test/unit/ingestion-reconciler-keep-separate.test.ts`
    - _Requirements: 6.5, 6.6, 6.7, 12.1, 12.2_

  - [x] 9.5 Unit test for ACP session lifecycle
    - Spy on `createAcpSession` + session `destroy()`: for any judge invocation (success, timeout, non-XML retry, merge, keep-separate), exactly one session is created and its `destroy()` is called exactly once before control returns for that cluster
    - Test file: `test/unit/ingestion-reconciler-acp-lifecycle.test.ts`
    - _Requirements: 6.8_

  - [x] 9.6 Property tests for reconciler commit semantics (Properties 14, 15, 16, 17, 19, 20)
    - **Property 14: Judge invocation gated on non-empty neighbor pool** — number of `kiro-learn-reconciler` ACP sessions equals the number of clusters with ≥1 neighbor
    - **Property 15: Merge commit semantics** — after a `<merge>` commit, every merged id is absent from storage and its embedding; the summary is readable; no row outside the merged set is mutated or deleted (uses the rewritten statement targeting `deleteMemoryRecord`)
    - **Property 16: Keep-separate commit semantics** — zero `deleteMemoryRecord` calls; exactly one `memory_record` written per cluster member
    - **Property 17: `source_event_ids` is deduped first-seen union** — summary `source_event_ids` equals the first-seen-order deduplication of the concatenation of member and merged-neighbor `source_event_ids`
    - **Property 19: Judge ACP session lifecycle** — exactly one `createAcpSession('kiro-learn-reconciler', ...)` and exactly one `destroy()` per judge invocation
    - **Property 20: Per-cluster failure isolation** — an injected failure on cluster N's commit does not prevent other clusters from committing
    - Test file: `test/unit/ingestion-reconciler.property.test.ts`
    - 100 runs each
    - **Validates: Requirements 5.5, 6.1, 6.4, 6.5, 6.7, 6.8, 7.1, 7.3, 7.4, 7.5, 7.6, 8.2, 9.1, 9.2, 9.3, 13.4**

- [x] 9.5 Implementation-time dry-run checkpoint
  - [x] 9.5.1 Write a throwaway harness script at `scripts/reconcile-dry-run.mjs`
    - ESM script, Node ≥ 22, no new dependencies beyond what's already in `package.json` (uses the existing `better-sqlite3`)
    - Lives under `scripts/` — explicitly outside the `src/` tree, so it's not subject to guard tests, not shipped in the npm package, and not exercised by the test suite
    - Header comment: note the script is an implementation aid only, opens the user's live DB in **read-only mode** (`new Database(path, { readonly: true })`), performs zero writes, does NOT invoke the judge, and can be deleted after Task 20
    - Add a `// TODO: delete after reconciliation-engine lands` line near the top
    - Imports: `intraBatchCluster` from `../src/collector/ingestion/clustering.js` (built via `npm run build:node` first, or imported from `src/` when running with tsx — since this is a throwaway, shelling out to the already-built `dist/` is fine), and a direct `better-sqlite3` open of `~/.kiro-learn/kiro-learn.db` with `{ readonly: true, fileMustExist: true }`
    - CLI flag parsing: accept `--intra-batch <x>` (default `0.85`) and `--neighbor <x>` (default `0.80`); validate `x ∈ [0, 1]`; reject with exit code 1 and a descriptive stderr message otherwise
    - Resolve the DB path via `path.join(os.homedir(), '.kiro-learn', 'kiro-learn.db')` — the same scheme the installer uses
    - Page through `memory_records` per namespace using `SELECT * FROM memory_records WHERE namespace = ?` (reconciliation is destructive, so every row in the table is a real row)
    - For each namespace:
      - Build pseudo-candidates by reading each row and loading its embedding blob from the `embeddings` table; decode the BLOB to `Float32Array(384)` using the same scheme as `src/collector/embedding/blob.ts`
      - Run `intraBatchCluster(pseudoCandidates, intraBatchThreshold)` to produce clusters
      - For each cluster whose centroid is non-null, scan the namespace's embeddings and compute cosine similarity against the centroid; keep entries with similarity ≥ `neighborThreshold`; sort descending; cap at 10
    - Print a markdown-ish report to stdout per namespace:
      - Header line with namespace, total records, clusters formed, clusters with neighbors
      - For each cluster with at least one neighbor: list cluster members by `record_id` + `title`, then list neighbors by `record_id` + `title` + similarity score
    - Print a top-of-output note explaining: this is a calibration checkpoint run during implementation; the DB is opened read-only; the judge is not invoked; the output is similarity-only, so false positives are expected — the threshold pass is *tighter* than the real pipeline, which filters further via the judge
    - Idempotent: running it twice produces identical output modulo a timestamp in the header
    - _Requirements: none (dev aid, not a user-facing feature)_
    - _Design: none — ad-hoc implementation-time harness_

  - [x] 9.5.2 Manual verification checklist (human-in-the-loop gate)
    - Document the procedure as a short checklist inside this task:
      1. Run `node scripts/reconcile-dry-run.mjs` against the current live DB with default thresholds
      2. Eyeball the merge candidates surfaced per cluster — are the pairs actually duplicates to your reading, or is the similarity threshold too aggressive?
      3. Optionally sweep thresholds: `node scripts/reconcile-dry-run.mjs --intra-batch 0.90 --neighbor 0.85` to see what a stricter pass yields
      4. If the defaults look wrong, adjust `intraBatchSimilarityThreshold` and `neighborSimilarityThreshold` defaults in `src/collector/ingestion/index.ts` (task 10.1) and `src/collector/index.ts` (task 13.3) before proceeding to Task 10
      5. If the defaults look reasonable, proceed to Task 10 (IngestionPipeline orchestration)
    - No automated assertions — this is a deliberate human-in-the-loop checkpoint intended to catch obvious miscalibration before the reconciler is wired into the live ingestion path
    - Strongly recommended before Tasks 10, 13 (ExtractionWorker refactor + collector wiring), and onward, given the risk that aggressive defaults over-merge and irrecoverably delete rows on first run — merges are destructive (no undo)
    - _Requirements: none (dev aid)_
    - _Design: none_

  - [x] 9.5.3 Post-implementation cleanup
    - After Task 20 ships, either (a) delete `scripts/reconcile-dry-run.mjs` entirely, or (b) keep it under `scripts/` with an updated header noting it's retained as a future threshold re-calibration aid (no longer an implementation aid)
    - Either choice is fine — the script is not part of the public contract
    - _Requirements: none (dev aid)_
    - _Design: none_

- [x] 10. Ingestion module — `index.ts` (IngestionPipeline orchestration)
  - [x] 10.1 Create `src/collector/ingestion/index.ts`
    - Export `IngestionPipelineConfig`, `IngestionPipelineDeps`, `IngestionResult`, `IngestionPipeline` interfaces (exactly as specified in the design)
    - Export `createIngestionPipeline(deps): IngestionPipeline`
    - `run(projectId)` control flow:
      1. Acquire semaphore slot (reuse the existing extraction semaphore, default concurrency 2 — Requirement 1.5)
      2. `bufferStore.snapshot(projectId)`; empty → clear buffer, notify success
      3. `candidates = await extractCandidates(entries, config, { storage, embedder })`
      4. On extraction failure → `watcher.notifyExtractionResult(projectId, false)`, buffer untouched, circuit breaker NOT incremented (judge-specific only)
      5. `candidates.length === 0` → clear buffer, notify success
      6. `!config.reconciliationEnabled || circuitBreaker.isOpen(projectId)` → direct-commit fallback: for each candidate, `storage.putMemoryRecord(toMemoryRecord(c))` + `storage.putEmbedding(c.record_id, c.embedding)` when `c.embedding !== null` + `query.invalidateNamespace(ns)`; use the SAME write sequence as legacy `ExtractionWorker` byte-for-byte (Property 4 test proves this)
      7. Otherwise → `outcome = await reconcile(candidates, ctx)`
      8. Clear buffer, notify success, emit the ingestion-run log (task 14.1), return populated `IngestionResult`
    - `circuitBreaker.onRunComplete(projectId, anyJudgeFailure)` called at the end of every successful run (including direct-commit path, which has `anyJudgeFailure === false` trivially — re-closes a tripped breaker per Requirement 12.3)
    - If every cluster failed to commit, notify `watcher.notifyExtractionResult(projectId, false)` (buffer retained)
    - `drain(timeoutMs)` and `active` pass through to the existing semaphore
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 8.4, 12.3, 12.4_
    - _Design: Components and Interfaces § `index.ts` — `IngestionPipeline`; Ingestion pipeline sequence (happy path)_

  - [x] 10.2 Unit tests for `IngestionPipeline` control flow
    - Test zero-candidate snapshot → buffer cleared, no reconcile call
    - Test extraction failure → buffer retained, watcher notified `false`, circuit breaker NOT incremented
    - Test feature-flag-off path → direct-commit to storage, buffer cleared, reconciler never invoked
    - Test circuit-breaker-open path → direct-commit to storage, `onRunComplete(pid, false)` closes breaker
    - Test happy path → reconcile called, buffer cleared only after every cluster terminal
    - Test all-clusters-failed case → watcher notified `false`, buffer retained
    - Test semaphore: concurrent `run(projectId)` calls respect `extractionConcurrency`
    - Test file: `test/unit/ingestion-pipeline.test.ts`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 8.4, 12.3, 12.4_

  - [x] 10.3 Property tests for pipeline stage composition (Properties 1, 2)
    - **Property 1: Pipeline stage composition** — list of candidates passed into reconciliation equals what extraction returned (same elements, same order, no mutation)
    - **Property 2: Buffer-clear discipline** — buffer cleared iff extraction succeeded AND every cluster reached a terminal state; cleared zero times when extraction threw or when every cluster failed
    - Test file: `test/unit/ingestion-pipeline.property.test.ts`
    - 100 runs each
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 8.4**

- [x] 11. Dedicated property test for feature-flag-off byte equivalence (Property 4)
  - [x] 11.1 Property test for P4 — the load-bearing rollback property
    - **Property 4: Feature-flag-off byte equivalence**
    - For any buffer snapshot and for any fixed seed of the `record_id` ULID generator, running `IngestionPipeline` with `reconciliationEnabled: false` produces exactly the same sequence of `StorageBackend` writes — same method, same argument shape, same order — as the legacy `ExtractionWorker` would produce for the identical input
    - Also covers circuit-breaker-open → direct-commit path (Requirement 12.4)
    - Uses a record-matching harness against a shadow in-memory backend — wraps both pipelines, records their calls, compares call sequences for equality
    - Test file: `test/unit/ingestion-feature-flag-equivalence.property.test.ts`
    - 100 runs
    - **Validates: Requirements 1.6, 12.4**

- [x] 12. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Refactors — `ExtractionWorker` thin shim + `BufferWatcher` default + collector wiring
  - [x] 13.1 Refactor `src/collector/buffer/extraction.ts` to a thin shim
    - Replace the current ~300-line `ExtractionWorker` with a ~40-line wrapper that accepts `{ pipeline: IngestionPipeline, watcher: BufferWatcher }` and delegates `extract(projectId)` to `pipeline.run(projectId)`
    - Map the `IngestionResult` to the existing `ExtractionResult` shape: `memoriesCreated = summaryRecordsCommitted + keepSeparateCommitted + directCommittedRecords`
    - `active` and `drain(timeoutMs)` pass through to the pipeline
    - Preserve the public interface used by `BufferWatcher.onExtraction(...)` exactly so no call site in the collector needs to change beyond wiring
    - _Requirements: 1.1, 1.5_
    - _Design: Components and Interfaces § `src/collector/buffer/extraction.ts` — thin wrapper_

  - [x] 13.2 Change `BufferWatcher` + `DEFAULT_COLLECTOR_CONFIG` idle defaults
    - Edit `src/collector/buffer/watcher.ts` `DEFAULT_CONFIG`: `idleMs: 5_000` → `idleMs: 30_000`
    - Edit `src/collector/index.ts` `DEFAULT_COLLECTOR_CONFIG`: `bufferIdleMs: 5_000` → `bufferIdleMs: 30_000`; fix the inline fallback `cfg.bufferIdleMs ?? 5_000` → `cfg.bufferIdleMs ?? 30_000` at the watcher construction site
    - The 256 KiB `bufferExtractionThreshold` and 1 MiB `bufferMaxBytes` / compaction threshold are unchanged
    - Update the JSDoc comment on `bufferIdleMs` to reflect the new default
    - _Requirements: 2.1, 2.3, 2.4_
    - _Design: Components and Interfaces § `src/collector/buffer/watcher.ts` — idle-flush default_

  - [x] 13.3 Extend `CollectorConfig` with reconciliation fields
    - Edit `src/collector/index.ts` to add to `CollectorConfig`: `reconciliationEnabled?: boolean` (default `true`), `intraBatchSimilarityThreshold?: number` (default 0.85), `neighborSimilarityThreshold?: number` (default 0.80), `neighborPoolMaxSize?: number` (default 10), `judgeModelTimeoutMs?: number` (default 30_000), `reconciliationDebug?: boolean` (default `false`)
    - Update `DEFAULT_COLLECTOR_CONFIG` accordingly
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_
    - _Design: Collector wiring — `src/collector/index.ts`_

  - [x] 13.4 Implement `validateCollectorConfig` and call from `startCollector`
    - Add `validateCollectorConfig(cfg: CollectorConfig): void` (exported from `src/collector/index.ts`) that checks each new numeric field against its documented range: `bufferIdleMs ∈ [5000, 300000]`, `intraBatchSimilarityThreshold ∈ [0, 1]`, `neighborSimilarityThreshold ∈ [0, 1]`, `neighborPoolMaxSize ∈ [1, 100]`, `judgeModelTimeoutMs ∈ [5000, 300000]`
    - Throw a descriptive `Error` whose message names the offending field and the observed value
    - Call `validateCollectorConfig(cfg)` at the top of `startCollector`; on throw, the CLI entry point writes the message to stderr and exits with code 1
    - Do NOT validate pre-existing config knobs — scope the new validation strictly to the six new fields to avoid breaking existing deployments
    - _Requirements: 10.7_
    - _Design: Collector wiring § Config validation_

  - [x] 13.5 Wire `IngestionPipeline` in `startCollector`
    - Extend the wiring in `src/collector/index.ts`:
      1. After creating storage / embedder / query layer, instantiate `createReconciliationCircuitBreaker()`
      2. `pipeline = createIngestionPipeline({ bufferStore, watcher, storage, embedder, query, circuitBreaker, config })` — passing the new reconciliation config fields
      3. `extractionWorker = createExtractionWorker({ pipeline, watcher })` — now a shim
      4. Keep `bufferWatcher.onExtraction((pid) => extractionWorker.extract(pid).catch(logErr))` unchanged
      5. On shutdown, drain the pipeline (which drains extraction + in-flight judge calls) instead of calling `extractionWorker.drain` directly; timeout identical to today's `DRAIN_TIMEOUT_MS`
    - _Requirements: 1.1, 1.5, 10.1_
    - _Design: Collector wiring — `src/collector/index.ts`_

  - [x] 13.6 Unit tests for collector wiring
    - Mirrors `test/unit/buffer-collector-wiring.test.ts`: `startCollector` instantiates the ingestion pipeline with the expected config defaults; the same `IngestionPipeline` reference is passed to `ExtractionWorker`
    - Test feature flag off: `reconciliationEnabled: false` → direct-commit path wired, the `ReconciliationCircuitBreaker` exists but no judge ACP sessions are ever opened in a smoke run
    - Test shutdown order: `pipeline.drain` completes before `storage.close`
    - Test file: `test/unit/ingestion-collector-wiring.test.ts`
    - _Requirements: 1.1, 1.5, 10.1_

  - [x] 13.7 Unit tests for config validation
    - For each new numeric field, test one in-range value (accepted) and one out-of-range value (rejected with a message that names the field + value)
    - Test the CLI exit code 1 and stderr message on invalid config
    - Test file: `test/unit/ingestion-config-validation.test.ts`
    - _Requirements: 10.1–10.7_

  - [x] 13.8 Property test for config validation (Property 21)
    - **Property 21: Configuration validation**
    - For any `CollectorConfig` object, `startCollector` accepts it iff every new reconciliation field lies within its documented range; out-of-range values cause rejection with a message naming the field + observed value
    - Test file: `test/unit/ingestion-config-validation.property.test.ts`
    - 200 runs
    - **Validates: Requirements 10.1–10.7**

- [x] 14. Observability — structured ingestion-pipeline-run log
  - [x] 14.1 Emit the `ingestion-pipeline-run` structured log
    - Inside `IngestionPipeline.run(projectId)` (task 10.1), after the run completes (success OR all-clusters-failed), emit exactly one `process.stderr.write(JSON.stringify({...}) + '\n')` line with the fields specified in the design: `event: 'ingestion-pipeline-run'`, `project_id`, `namespace`, `events_processed`, `candidates_produced`, `clusters_formed`, `judge_invocations`, `merge_decisions`, `keep_separate_decisions`, `summary_records_committed`, `records_deleted`, `direct_committed_records`, `circuit_breaker_open`, `reconciliation_enabled`, `duration_ms`, `phase_latency_ms: { extraction, clustering, neighbor_lookup, judge, commit }`
    - Each phase timer wraps its corresponding stage; `duration_ms` = the total `run` wall time
    - `duration_ms` ≥ sum of `phase_latency_ms` values (additional bookkeeping overhead lives in the difference)
    - _Requirements: 11.1, 11.2_
    - _Design: Observability § Structured log (one line per ingestion run)_

  - [x] 14.2 Emit per-cluster `ingestion-cluster-debug` log when `config.reconciliationDebug === true`
    - For every cluster, emit `{ event: 'ingestion-cluster-debug', project_id, cluster_members, neighbor_pool: [{record_id, similarity}...], judge_request_xml_sha256, judge_response_xml }`
    - Log raw judge response XML in full; log judge request as SHA-256 only (avoid candidate-content PII leakage)
    - Gate via the `reconciliationDebug` config flag from task 13.3 (or a `RECONCILER_DEBUG` env var if the flag is unset)
    - _Requirements: 11.4_
    - _Design: Observability § Debug payload_

  - [x] 14.3 Unit test for ingestion-run log shape
    - Run the pipeline against fake storage / embedder / judge; capture stderr; parse the single emitted line; assert every required key exists, is the right type, and `duration_ms` ≥ sum of `phase_latency_ms` values
    - Test the debug payload: with `reconciliationDebug: true`, one `ingestion-cluster-debug` line per cluster is emitted; request XML is logged as a hash, response XML is logged in full
    - Test file: `test/unit/ingestion-observability.test.ts`
    - _Requirements: 11.1, 11.2, 11.4_

  - [x] 14.4 Property test for ingestion-run log structural conformance (Property 22)
    - **Property 22: Ingestion-run log structural conformance**
    - For any ingestion run, exactly one JSON-Lines log record is written whose parsed object is a superset of the required keys (including `records_deleted`); every listed numeric field is a non-negative integer; `duration_ms` ≥ sum of phase latencies
    - Test file: `test/unit/ingestion-observability.property.test.ts`
    - 100 runs
    - **Validates: Requirements 11.1, 11.2**

- [x] 15. Installer — `writeReconcilerAgent` + uninstall cleanup
  - [x] 15.1 Implement `writeReconcilerAgent(agentsDir: string): void`
    - Add a new helper in `src/installer/index.ts` alongside `writeCompressorAgent` and `writeCompactorAgent`
    - Prompt content: XML-only contract instructing the model to return either a `<merge>…</merge>` block (listing `merged_record_id`s and new `title` / `summary` / `facts` / `concepts` / `files` / `observation_type`) or a single `<keep_separate/>` tag
    - Prompt body must reference the request grammar `<reconciliation_request><candidate_cluster>…<neighbor_pool>…</reconciliation_request>` and the response grammar exactly as defined in `src/collector/ingestion/judge-xml.ts` (cross-check after task 7.1 lands)
    - Config shape: `{ name: 'kiro-learn-reconciler', description, prompt, tools: [], allowedTools: [] }`
    - Idempotent: unconditional `writeFileSync` — same pattern as compressor/compactor
    - Call it from `writeAgentConfigs` after `writeCompactorAgent(globalAgentsDir)`
    - Add `'kiro-learn-reconciler.json'` to the agent-cleanup list in the `uninstall` function
    - _Requirements: 6.1, 6.8_
    - _Design: Components and Interfaces § `src/installer/index.ts` — `writeReconcilerAgent`_

  - [x] 15.2 Unit tests for installer
    - Test `writeReconcilerAgent` creates `kiro-learn-reconciler.json` at the global agents dir with the expected `name`, `description`, `tools: []`, `allowedTools: []`
    - Test the prompt body references `<reconciliation_request>`, `<merge>`, and `<keep_separate/>` verbatim
    - Test `uninstall` removes the file on cleanup
    - Test file: `test/unit/installer-write-reconciler-agent.test.ts`
    - _Requirements: 6.1_

- [x] 16. Guard tests — enforce new modularity boundaries
  - [x] 16.1 Guard test: ingestion module must not import from `storage/sqlite/`
    - Pattern from `test/unit/no-sqlite-in-pipeline.test.ts`: scan all `.ts` files under `src/collector/ingestion/`, strip comments, assert no `storage/sqlite` import
    - Test file: `test/unit/no-sqlite-in-ingestion.test.ts`
    - _Requirements: modularity invariant (AGENTS.md)_

  - [x] 16.2 Guard test: ingestion module must not contain `<private>`
    - Scan all `.ts` files under `src/collector/ingestion/`, assert the literal string `<private>` does not appear (privacy scrubbing belongs to the pipeline, not ingestion)
    - Pattern from `test/unit/no-private-in-buffer.test.ts`
    - Test file: `test/unit/no-private-in-ingestion.test.ts`
    - _Requirements: privacy-scrub ownership invariant (AGENTS.md)_

  - [x] 16.3 Guard test: XML pipeline modules must not import from ingestion
    - Scan `src/collector/pipeline/{acp-client,xml-framer,xml-parser}.ts` for any import of `collector/ingestion/` — assert none exist (XML pipeline stays a leaf)
    - Test file: `test/unit/no-ingestion-in-xml-modules.test.ts`
    - _Requirements: modularity invariant (AGENTS.md)_

- [x] 17. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 18. Integration tests — extend existing + add reconciliation-pipeline
  - [x] 18.1 Extend `test/integ/buffer-extraction-pipeline.test.ts`
    - Add one test case that runs the pipeline with `reconciliationEnabled: false` and asserts the old behaviour holds byte-for-byte: every candidate becomes a standalone `memory_record`, same call sequence as pre-reconciliation
    - _Requirements: 1.6, 13.2_

  - [x] 18.2 Extend `test/integ/extraction-pipeline.test.ts`
    - Add a parallel case with `reconciliationEnabled: true`: seed two batches in sequence where the second batch contains a near-duplicate of a record from the first. Assert: first batch's records go straight through (no neighbors at the time); second batch's identical-content candidate is merged into one summary record; the first-batch near-duplicate row is absent from storage after the merge (`getMemoryRecord(oldId)` returns undefined)
    - _Requirements: 4.1, 5.1, 6.1, 6.4, 7.1, 9.1_

  - [x] 18.3 New `test/integ/reconciliation-pipeline.test.ts`
    - End-to-end with real `kiro-cli` + Bedrock: skip via `skipIfNoKiroCli` when unavailable
    - Seed two near-duplicate buffer batches across two simulated sessions; run the daemon; assert the second run collapses into one summary record; the first-batch record is absent from storage after the merge (`getMemoryRecord(oldId)` returns undefined); `retrieval.search(...)` returns only the summary
    - Assert the `ingestion-pipeline-run` stderr log is emitted once per ingestion cycle with all required fields (including `records_deleted`)
    - _Requirements: 4.1, 5.1, 6.1, 6.4, 7.1, 9.1, 9.2, 9.3, 11.1_

- [x] 19. Documentation
  - [x] 19.1 Create `docs/architecture/ingestion.mdx`
    - End-to-end walkthrough: Extraction Stage emits Candidate Memories, Reconciliation Stage clusters / looks up neighbors / invokes judge / commits with merge-deletion
    - Include both diagrams from `design.md` § Architecture (ingestion pipeline component diagram + where-new-code-lives diagram)
    - Document the config surface: `reconciliationEnabled`, `bufferIdleMs`, `intraBatchSimilarityThreshold`, `neighborSimilarityThreshold`, `neighborPoolMaxSize`, `judgeModelTimeoutMs` — with their defaults and validated ranges
    - Document the per-project reconciliation circuit breaker and the direct-commit fallback
    - Register the page in `docs/docs.json` navigation under the `architecture` group
    - _Requirements: 14.1_

  - [x] 19.2 Update `docs/architecture/extraction.mdx`
    - Reframe as "Extraction Stage" of the Ingestion Pipeline
    - Emphasize that it emits Candidate Memories into the pipeline, not records into storage
    - Cross-link to `ingestion.mdx`
    - _Requirements: 14.2_

  - [x] 19.3 Update `docs/architecture/compaction.mdx`
    - Replace any wording that references the 5-second extraction cadence with the new 30-second default
    - Note that compaction's 1 MiB trigger is unchanged
    - _Requirements: 14.3_

  - [x] 19.4 Update `docs/architecture/database.mdx`
    - Document the new `deleteMemoryRecord(recordIds)` method on `StorageBackend`
    - Document the in-transaction cascade: a delete drops the row from `memory_records`, its embedding from the `embeddings` table, and its FTS5 entry from `memory_records_fts` — all atomically
    - Explain that reconciliation merges are destructive — there is no undo. The merged originals are gone.
    - No schema migration is introduced for this feature — `memory_records` gains no columns
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 14.4_

  - [x] 19.5 Update `docs/concepts/event-buffer.mdx`
    - Update the default idle-flush interval to 30 s
    - Rename the flush trigger from "extraction trigger" to "ingestion trigger"
    - Note the 5–300 s configurable range
    - _Requirements: 2.1, 2.2, 14.5_

  - [x] 19.6 Update `docs/architecture/retrieval.mdx`
    - One-line note that retrieval reads `memory_records` unchanged from today; merged rows are deleted by reconciliation rather than hidden
    - Cross-link to `database.mdx` for the `deleteMemoryRecord` behavior
    - _Requirements: 11.3_

- [x] 20. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP. They cover property tests, unit tests, and integration tests. Core implementation tasks (unmarked) are mandatory — skipping them breaks the wiring.
- Each task references specific sub-requirements (`N.M`) using `requirements.md` as authoritative.
- Property tests are first-class: Properties 1–24 from `design.md` § Correctness Properties each map to a sub-task, annotated with the property number and the requirement clauses they validate. Every property-test file tags the property with the feature name per the repo's existing convention.
- Property 4 (feature-flag-off byte equivalence) is load-bearing for the rollback story — it proves the direct-commit path is byte-equivalent to today's extraction. Task 11 owns that property and must pass before tasks 13 onward ship.
- Guard tests (16.1–16.3) enforce the modularity boundaries declared in AGENTS.md: `src/collector/ingestion/` is a sibling of `pipeline/`, `query/`, etc., and must not import from `storage/sqlite/` or leak privacy-sensitive strings.
- Merges are destructive. A `<merge>` decision deletes the original rows outright. Task 9.5 (dry-run harness) is the calibration checkpoint that gates Task 10 onward — over-aggressive thresholds will silently delete rows that shouldn't have been merged, and there is no undo.
- Ordering rationale: Task 1 (types) → Task 2 (StorageBackend + SQLite `deleteMemoryRecord`) → Task 3 (QueryLayer) → Task 4 (checkpoint) → Tasks 5–9 (independent ingestion modules feeding `reconciler.ts`) → Task 9.5 (dry-run gate) → Task 10 (IngestionPipeline) → Task 11 (P4 byte-equivalence) → Task 12 (checkpoint) → Task 13 (collector wiring + watcher defaults) → Task 14 (observability) → Task 15 (installer) → Task 16 (guard tests) → Task 17 (checkpoint) → Task 18 (integration tests) → Task 19 (docs) → Task 20 (final checkpoint).
