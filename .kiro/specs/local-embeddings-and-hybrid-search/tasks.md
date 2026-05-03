# Implementation Plan: Local Embeddings and Hybrid Search

## Overview

Add local semantic embeddings (`all-MiniLM-L6-v2` via `@huggingface/transformers`, 384-dim, CPU-only) and hybrid (FTS5 + vector via RRF) retrieval to kiro-learn, while preserving every existing modularity boundary, the wire schema, and the never-degrade-below-FTS5 guarantee.

Implementation order is dependency-aware: storage primitives and pure embedding functions come first (no runtime dependency on the ONNX model, cheap to property-test), then the concrete `OnnxEmbedder`, then the vector index cache, then integration into `ExtractionWorker` and `QueryLayer`, then the `BackfillWorker`, then collector wiring, then guard tests, docs, and performance benchmarks.

All code is TypeScript (ESM-only, Node ≥ 22, `.js` import extensions, `import type` for type-only imports, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). New modules live at `src/collector/embedding/` and `src/collector/backfill/` and receive `StorageBackend` and `Embedder` via DI — they must NOT import from `src/collector/storage/sqlite/`.

Property numbering below matches design.md § Correctness Properties (Properties 1–15). Requirement references use the Requirements Traceability table in design.md as authoritative.

## Tasks

- [x] 1. Migration and storage primitives
  - [x] 1.1 Create migration `0005_memory_record_embedding`
    - Add `src/collector/storage/sqlite/migrations/0005_memory_record_embedding.ts` exporting `migration0005: Migration` with `version: 5`, `name: '0005_memory_record_embedding'`, and `up(db)` that runs `ALTER TABLE memory_records ADD COLUMN embedding BLOB DEFAULT NULL;`
    - Register `migration0005` in `src/collector/storage/sqlite/migrations/index.ts` `MIGRATIONS` array, preserving monotonic order
    - _Requirements: 4.1, 4.5, 4.6, 8.3_
    - _Design: Migration and Rollout § Migration; Data Models § SQLite schema diff_

  - [x] 1.2 Extend `StorageBackend` interface with embedding methods
    - Edit `src/types/index.ts` to add to `StorageBackend`: `putEmbedding(recordId, embedding): Promise<void>`, `getEmbedding(recordId): Promise<Float32Array | null>`, `listEmbeddings(namespace): Promise<Array<{record_id, embedding, created_at}>>`, `listRecordsWithoutEmbedding(namespace | null, limit): Promise<MemoryRecord[]>`, `searchMemoryRecordsLexical(params): Promise<Array<{record, rank}>>`
    - Extend `StatsResult` with optional `embeddings_present?: number` and `embeddings_missing?: number`
    - Keep `searchMemoryRecords` signature unchanged for backward compatibility
    - _Requirements: 3.3, 4.1, 4.2, 4.7, 5.1, 8.4, 8.6, 14.4, 15.3, 19.2_
    - _Design: Components and Interfaces § `StorageBackend` — new methods_

  - [x] 1.3 Add prepared statements and row handling for embeddings in sqlite backend
    - Edit `src/collector/storage/sqlite/statements.ts` to add: `updateMemoryRecordEmbedding`, `selectMemoryRecordEmbedding`, `selectEmbeddingsByNamespace`, `selectMemoryRecordsWithoutEmbedding`, `selectMemoryRecordsFtsMatchRanked` (FTS5 MATCH with 1-based rank via `ROW_NUMBER() OVER (ORDER BY fts.rank)`), `selectEmbeddingStatsGlobal`, `selectEmbeddingStatsScoped`
    - All statements use positional binding — no string interpolation
    - `rowToMemoryRecord` continues NOT to read the `embedding` column (keep it off the existing `SELECT` lists); the embedding stays a storage-internal detail
    - _Requirements: 4.7, 5.1, 8.6, 14.4_
    - _Design: Components and Interfaces § Prepared statements added to `statements.ts`_

  - [x] 1.4 Implement new `StorageBackend` methods in sqlite backend
    - Edit `src/collector/storage/sqlite/index.ts` to implement: `putEmbedding` (UPDATE by `record_id`, no-op on zero rows matched), `getEmbedding` (returns `null` for missing or NULL blob), `listEmbeddings` (filters `embedding IS NOT NULL`, returns decoded `Float32Array` + `created_at`, ordered by `created_at DESC`), `listRecordsWithoutEmbedding` (filters `embedding IS NULL`, optional namespace scope, ordered by `created_at ASC`), `searchMemoryRecordsLexical` (returns `{record, rank}` via the new ranked FTS statement)
    - Extend `getStats` to populate `embeddings_present` / `embeddings_missing` using the two new stats statements (global or namespace-scoped)
    - Throw with offending `record_id` context on `decodeEmbeddingBlob` errors from `getEmbedding` and `listEmbeddings`; `listEmbeddings` logs and skips the corrupt row so one bad BLOB does not poison the whole index build
    - `searchMemoryRecords` (existing method) becomes a thin wrapper: `records.map(({record}) => record)` over the ranked result
    - _Requirements: 3.3, 4.1, 4.2, 4.4, 4.7, 5.1, 8.6, 14.4, 15.3, 19.2_
    - _Design: Components and Interfaces § `StorageBackend` — new methods_

  - [x] 1.5 Write unit tests for migration 0005
    - Test migration adds `embedding` column with type `BLOB` and `DEFAULT NULL`
    - Test migration does not rewrite pre-existing rows (insert a row at schema v4 fixture, apply 0005, assert same `rowid` and same other column values, `embedding` reads as `null`)
    - Test migration is additive: idempotent re-run is blocked by the migrations runner version tracking
    - Test file: `test/unit/embedding-migration-0005.test.ts`
    - _Requirements: 4.5, 4.6, 8.3_

  - [x] 1.6 Write unit tests for new storage methods
    - Test `putEmbedding` updates the row and is idempotent on repeat
    - Test `putEmbedding` is a no-op for a non-existent `record_id`
    - Test `getEmbedding` round-trips a `Float32Array(384)` bit-for-bit and returns `null` for missing/NULL
    - Test `listEmbeddings` filters by namespace and excludes NULL
    - Test `listRecordsWithoutEmbedding` returns correct ordering (`created_at ASC`) and respects namespace scope
    - Test `searchMemoryRecordsLexical` returns 1-based rank matching FTS5 order
    - Test `getStats` populates `embeddings_present` / `embeddings_missing` at global and namespace scope
    - Test `getEmbedding` throws with `record_id` context when the stored BLOB has wrong length
    - Test file: `test/unit/embedding-storage-methods.test.ts`
    - _Requirements: 3.3, 4.1, 4.2, 4.4, 4.7, 8.6, 14.4, 15.3_

- [x] 2. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Pure embedding module — blob codec, cosine, input composition, RRF
  - [x] 3.1 Create `src/collector/embedding/blob.ts` with `encodeEmbeddingBlob` / `decodeEmbeddingBlob`
    - `encodeEmbeddingBlob(vec: Float32Array): Buffer` — asserts `vec.length === 384`, writes 1536 bytes via explicit `DataView.setFloat32(offset, value, /* littleEndian */ true)`
    - `decodeEmbeddingBlob(blob: Buffer): Float32Array` — asserts `blob.length === 1536`, reads via `DataView.getFloat32(offset, true)`, returns a fresh `Float32Array(384)`
    - On length mismatch, throw an `Error` that includes the offending length in the message; the storage layer annotates with `record_id`
    - _Requirements: 4.2, 4.4, 11.1, 15.2, 15.3_
    - _Design: Components and Interfaces § `encodeEmbeddingBlob / decodeEmbeddingBlob`; Data Models § BLOB encoding format_

  - [x] 3.2 Write property test for BLOB round-trip (Property 1)
    - **Property 1: BLOB round-trip preserves every bit**
    - For any `Float32Array(384)`, `decodeEmbeddingBlob(encodeEmbeddingBlob(v))` is bitwise-equal to `v`, including NaN, ±Infinity, ±0, subnormals
    - Compare via `new Uint32Array(out.buffer, out.byteOffset, 384)` vs `new Uint32Array(in.buffer, in.byteOffset, 384)` so NaN bit patterns are actually compared
    - Use new `arbitraryFloat32Array(384)` generator (task 12.1)
    - Test file: `test/unit/embedding-blob-roundtrip.property.test.ts`
    - 500 runs
    - **Validates: Requirements 4.2, 4.4, 11.1, 15.1, 15.2**

  - [x] 3.3 Create `src/collector/embedding/cosine.ts` with `cosine` and `normalize`
    - `cosine(a: Float32Array, b: Float32Array): number` — assumes equal length, returns `0` when either norm is zero, otherwise `dot(a,b) / (||a|| * ||b||)`
    - `normalize(a: Float32Array): Float32Array` — returns a fresh pre-normalised vector so hot-path cosine reduces to a dot product; preserves zero-norm input as a zero vector
    - Export `topKByCosine(q, index, k)` helper used by the query layer: iterates `NamespaceVectorIndex.entries`, skips any entry whose `vec_normalised` is the zero vector (treat as cosine 0), returns sorted top-`k`
    - _Requirements: 7.1, 7.2, 7.3, 7.6, 17.4_
    - _Design: Components and Interfaces § `cosine(a, b)`_

  - [x] 3.4 Write property test for cosine similarity (Property 3)
    - **Property 3: Cosine similarity is well-defined and bounded**
    - Zero-norm inputs on either side yield exactly `0`
    - Non-zero inputs yield a value in `[-1, 1]` up to floating-point tolerance
    - `cosine(a, a) === 1` within tolerance for any non-zero `a`
    - Test file: `test/unit/embedding-cosine.property.test.ts`
    - 500 runs
    - **Validates: Requirements 7.6, 17.4**

  - [x] 3.5 Write property test for cosine ranking helper (Property 7)
    - **Property 7: Cosine ranking is sorted and excludes missing embeddings**
    - For any query and a mixed index (some entries with embeddings, some with NULL stubs), `topKByCosine` returns at most `k` entries, sorted by descending similarity, with no entry whose underlying record had a NULL embedding
    - Test file: `test/unit/embedding-cosine-rank.property.test.ts`
    - 200 runs
    - **Validates: Requirements 7.1, 7.2, 7.3**

  - [x] 3.6 Create `src/collector/embedding/input-composition.ts`
    - `composeEmbeddingInput(record: MemoryRecord): string` — pure, deterministic: `title + "\n\n" + summary + "\n\n" + facts.join("\n") + "\n\n" + concepts.join(", ")`, truncated to `maxInputChars` (default 10 000)
    - Export `DEFAULT_MAX_INPUT_CHARS = 10_000`
    - _Requirements: 1.1, 3.2_
    - _Design: Components and Interfaces § `composeEmbeddingInput`_

  - [x] 3.7 Write property test for `composeEmbeddingInput` (Property 2)
    - **Property 2: `composeEmbeddingInput` is deterministic and content-preserving**
    - Repeated calls return the identical string
    - Output contains `title`, `summary`, every fact, every concept — except for any suffix removed by the 10 000-char truncation cap (check containment before the cap; check length ≤ cap after)
    - Use an `arbitraryMemoryRecord()` helper (construct from existing generators, or add one under `test/helpers/arbitrary.ts` if missing)
    - Test file: `test/unit/embedding-input-composition.property.test.ts`
    - 200 runs
    - **Validates: Requirements 3.2**

  - [x] 3.8 Create `src/collector/embedding/rrf.ts` with `rrfFuse`
    - Define `Ranked = { record_id: string; rank: number }` and `Fused = { record_id; fused_score; lex_rank: number | null; vec_rank: number | null }`
    - `rrfFuse(lexical, vector, k, limit): readonly Fused[]` — accumulates `1 / (k + rank)` per list per id, treats absence as contribution `0`
    - Sort by `(fused_score DESC, record_id ASC)` for deterministic tie-break at this layer; richer tie-break (by `created_at`) is applied by the caller
    - Return first `limit` entries
    - _Requirements: 5.2, 5.3, 5.4, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6_
    - _Design: Components and Interfaces § `rrfFuse`_

  - [x] 3.9 Write property test for RRF fusion (Property 6)
    - **Property 6: RRF fusion satisfies its algebraic contract**
    - Assert all seven clauses: size ≤ `min(limit, |L ∪ V|)`; score formula equality for every id in result; monotonically non-increasing `fused_score`; rank monotonicity (same `rank_L`, strictly worse `rank_V` → strictly smaller fused score); agreement preservation (identical permutations); lexical-only fallback (`V = []` returns `L` truncated); vector-only fallback (`L = []` returns `V` truncated)
    - Use a new `arbitraryRankedList(ids)` generator (task 12.1)
    - Test file: `test/unit/embedding-rrf-fusion.property.test.ts`
    - 500 runs
    - **Validates: Requirements 5.2, 5.4, 16.5, 16.6, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6**

  - [x] 3.10 Create `src/collector/embedding/index.ts` barrel export
    - Re-export: `Embedder` (type), `EmbedderConfig` (type), `createOnnxEmbedder` (from task 4.1), `cosine`, `normalize`, `topKByCosine`, `composeEmbeddingInput`, `DEFAULT_MAX_INPUT_CHARS`, `encodeEmbeddingBlob`, `decodeEmbeddingBlob`, `rrfFuse`, `Ranked`, `Fused`
    - Import only from `src/types/` and sibling embedding files. No imports from `src/collector/storage/sqlite/`, `src/shim/`, `src/installer/`, or `src/mcp/`.
    - _Requirements: 13.1, 13.2, 13.3_
    - _Design: Components and Interfaces § `src/collector/embedding/`_

- [x] 4. `OnnxEmbedder` — concrete embedder with model lifecycle
  - [x] 4.1 Create `src/collector/embedding/onnx-embedder.ts`
    - Define `Embedder` interface: `ready(): Promise<void>`, `isReady(): boolean`, `embed(input: string): Promise<Float32Array>`, `readonly dim: 384`
    - Define `EmbedderConfig`: `modelName: 'Xenova/all-MiniLM-L6-v2'`, `modelCacheDir: string` (default `~/.kiro-learn/models/`), `perCallTimeoutMs: number` (default 2000), `maxInputChars: number` (default 10 000)
    - `createOnnxEmbedder(cfg)` returns immediately; first `embed()` awaits `ready()` internally; `ready()` kicks off a single memoised load of the `@huggingface/transformers` feature-extraction pipeline pointing at `modelCacheDir`
    - `embed(input)` truncates input to `maxInputChars`, runs the pipeline with `{ pooling: 'mean', normalize: false }`, returns a fresh `Float32Array(384)`; wraps the pipeline call in a `Promise.race` with an `AbortController`-driven timeout
    - `ready()` failure transitions to a terminal not-ready state — `isReady()` returns `false` permanently; subsequent `embed()` calls reject immediately without retrying the load
    - Add `dispose()` (optional) that releases the ONNX session if the pipeline exposes one; otherwise no-op
    - `@huggingface/transformers` must be added as a runtime dependency in `package.json`
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 2.1, 2.4, 10.3, 10.4, 17.1, 17.2_
    - _Design: Components and Interfaces § `Embedder` interface; Degraded-mode state machine_

  - [x] 4.2 Write unit tests for `OnnxEmbedder` lifecycle
    - Stub `@huggingface/transformers` with a fake pipeline for fast tests
    - Test `ready()` is idempotent (second call returns the same memoised promise; load runs once)
    - Test `isReady()` transitions: `false` before load resolves, `true` after success, `false` permanently after load rejection
    - Test per-call timeout: a hanging stub pipeline causes `embed()` to reject with a timeout error within ~`perCallTimeoutMs`
    - Test `embed()` truncates input longer than `maxInputChars` before passing to the pipeline
    - Test `dim === 384`
    - Test file: `test/unit/embedding-onnx-embedder.test.ts`
    - _Requirements: 1.1, 1.2, 2.1, 2.4, 10.3, 10.4_

  - [x] 4.3 Write property test for embedder output shape (Property 4)
    - **Property 4: Embedder output shape is invariant**
    - For any non-empty string of length 1–10 000, `embedder.embed(s)` returns a `Float32Array(384)` whose every element is `Number.isFinite`, and whose L2 norm is strictly greater than zero
    - Uses the real `@huggingface/transformers` pipeline — run at most 100 iterations (~20 ms each = 2 s)
    - Gate the test on first-run model availability; document that first CI run downloads the model to the CI cache
    - Test file: `test/unit/embedding-embedder-shape.property.test.ts`
    - 100 runs
    - **Validates: Requirements 1.1, 1.2, 17.1, 17.2, 17.4**

  - [x] 4.4 Write property test for embedder determinism (Property 5)
    - **Property 5: Embedder is deterministic within a process**
    - For any input `s`, two sequential `embed(s)` calls return `Float32Array` values whose underlying `Uint32Array` views are bitwise-equal
    - Uses the real pipeline; 50 iterations
    - Test file: `test/unit/embedding-embedder-determinism.property.test.ts`
    - 50 runs
    - **Validates: Requirements 1.3, 17.3**

- [x] 5. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Vector index cache — per-namespace cache with epoch invalidation
  - [x] 6.1 Create `NamespaceVectorCache` inside `src/collector/query/`
    - Add `src/collector/query/vector-cache.ts` defining `NamespaceVectorIndex = { namespace; epoch; entries: ReadonlyArray<{record_id; record: MemoryRecord; vec_normalised: Float32Array}> }` and `NamespaceVectorCache = { getOrLoad(ns); invalidate(ns) }`
    - `getOrLoad` on miss: call `storage.listEmbeddings(ns)` and join-back the `MemoryRecord` metadata from a single bulk `searchMemoryRecordsLexical` call or a new helper; normalise each vector via `normalize`; store the resulting `NamespaceVectorIndex`
    - `invalidate(ns)` drops the cached index for `ns` and bumps a per-namespace epoch counter so in-flight reads do not persist a stale index
    - Emit a single warning when total cached vector-index bytes crosses 500 MB; do not evict in this spec
    - No imports from `src/collector/storage/sqlite/`; uses `StorageBackend` interface and the pure cosine module only
    - _Requirements: 7.4, 7.5_
    - _Design: Components and Interfaces § Vector index cache shape; Error Handling § Cache memory pressure_

  - [x] 6.2 Write unit tests for vector cache
    - Test cache miss triggers `listEmbeddings`; second call on same namespace is a cache hit (no extra storage call)
    - Test `invalidate(ns)` forces a reload on the next `getOrLoad(ns)`
    - Test entries exclude records with NULL embedding (relies on `listEmbeddings` filter)
    - Test stored vectors are L2-normalised (norm ≈ 1, or exactly 0 for degenerate input)
    - Test the 500 MB warning fires once when crossed and does not re-fire
    - Test file: `test/unit/embedding-vector-cache.test.ts`
    - _Requirements: 7.4, 7.5_

- [x] 7. `ExtractionWorker` integration — embed-after-insert with failure isolation
  - [x] 7.1 Add `embedder` dependency to `ExtractionWorker`
    - Edit `src/collector/buffer/extraction.ts` to add `embedder: Embedder | null` to `ExtractionWorkerDeps`
    - After the existing `storage.putMemoryRecord(record)` call, if `embedder !== null && embedder.isReady()`: compute `input = composeEmbeddingInput(record)`, call `await embedder.embed(input)`, call `await storage.putEmbedding(record.record_id, vec)`
    - Wrap the embed + put-embedding block in try/catch. On any error, log a warning containing `record_id` and the error message. Do NOT re-throw. The memory record is already stored.
    - Import order matters: `Embedder`, `composeEmbeddingInput` come from `../embedding/index.js`. Still no import from `src/collector/storage/sqlite/`.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 10.2, 13.4, 14.1_
    - _Design: Components and Interfaces § `ExtractionWorker` — modified; Sequence: embedding on write_

  - [x] 7.2 Write unit tests for `ExtractionWorker` embedding integration
    - Test embed is called after `putMemoryRecord` (record call order via mocks)
    - Test `putEmbedding` is called with the vec returned from `embedder.embed`
    - Test when `embedder.embed` throws, the record is still stored (no re-throw), a warning is logged with `record_id`, and `putEmbedding` is never called
    - Test when `embedder.embed` times out (simulate via slow stub + real or fake timeout), same behavior as the throw case
    - Test when `embedder` is `null`, worker runs identically to pre-spec behaviour (no embed calls)
    - Test when `embedder.isReady()` is `false`, worker skips embed and warns
    - Mock `StorageBackend` and `Embedder`. Mock ACP as established in `buffer-extraction-worker.test.ts`.
    - Test file: `test/unit/embedding-extraction-worker.test.ts`
    - _Requirements: 3.1, 3.3, 3.4, 3.5, 14.1_

  - [x] 7.3 Write property test for write-path safety (Property 15)
    - **Property 15: Write-path safety**
    - For any memory record, using a slow/failing fake embedder, in a trace of worker operations `putMemoryRecord` completion precedes any dependency on the `embed` result. Equivalently: record is stored within a tight bound even when the embedder hangs until timeout.
    - Uses a fake embedder with a real 500 ms delay to keep wall time bounded; 30 runs
    - Test file: `test/unit/embedding-write-path-safety.property.test.ts`
    - **Validates: Requirements 3.4, 3.5**

- [x] 8. `QueryLayer` hybrid search — fetch depth, RRF fusion, tie-breaks, fallback
  - [x] 8.1 Extend `QueryLayer` with embedder and cache dependencies
    - Edit `src/collector/query/index.ts` so `createQueryLayer({ storage, embedder: Embedder | null, config })` accepts the embedder and optional config (`rrfK` default 60, `fetchDepthMultiplier` default 4)
    - Internal `NamespaceVectorCache` is constructed from `{ storage }`; cache lifetime is the `QueryLayer` instance
    - _Requirements: 5.3, 5.7, 12.1_
    - _Design: Components and Interfaces § `QueryLayer` — modified_

  - [x] 8.2 Implement hybrid search algorithm in `QueryLayer.search`
    - Step 1: `fetchDepth = limit * fetchDepthMultiplier` (default 40 at `limit = 10`); call `storage.searchMemoryRecordsLexical({namespace, query, limit: fetchDepth})`
    - Step 2: If `lexRanked.length === 0` AND `tokenizeForQuery(query).length === 0`, return `[]` without embedding (empty-query short-circuit)
    - Step 3: If `embedder === null || !embedder.isReady()`, return lexical-only top-`limit` records
    - Step 4: Try `embedder.embed(query)`; on any error, log warning and return lexical-only top-`limit`
    - Step 5: `index = await cache.getOrLoad(namespace)`; `vecRanked = topKByCosine(queryVec, index, fetchDepth)`
    - Step 6: `fused = rrfFuse(lexRankedAsRanked, vecRankedAsRanked, rrfK, limit * 2)` (over-fetch for tie-break)
    - Step 7: Join back `MemoryRecord` — use the lex set first, then the cache's `record` field for vec-only hits; drop anything not found
    - Step 8: Sort by `(fused_score DESC, created_at DESC, record_id ASC)` and return top-`limit` records
    - `tokenizeForQuery` is the existing FTS5 tokeniser used in `src/collector/storage/sqlite/fts5.ts`; since the query layer may not import sqlite, expose the tokeniser via a pure helper injected alongside storage, OR move the pure tokeniser to a shared location under `src/collector/query/` — implementer picks the least-invasive path that respects the modularity guard
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 5.7, 5.8, 6.1, 6.2, 6.3, 6.4, 9.4, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7_
    - _Design: Components and Interfaces § `QueryLayer` — modified; Sequence: hybrid search on read_

  - [x] 8.3 Wire cache invalidation into the write path
    - Add `invalidateNamespace(ns: string)` method on the `QueryLayer` instance (or expose the cache's `invalidate` directly)
    - `src/collector/index.ts` wires ExtractionWorker and BackfillWorker so that after every successful `putMemoryRecord` and `putEmbedding` in namespace `ns`, `queryLayer.invalidateNamespace(ns)` is called
    - This keeps cache invalidation concerns out of the storage layer; see design note about alternative `onEmbeddingChanged` callback — pick the explicit-wiring path to avoid leaking callback surface onto `StorageBackend`
    - _Requirements: 7.5_
    - _Design: Components and Interfaces § Vector index cache shape, Cache invalidation protocol_

  - [x] 8.4 Write unit tests for `QueryLayer` hybrid wiring
    - Test with a small seeded corpus: assert `embed(query)` is called exactly once per `search`
    - Test that fusion includes a vec-only hit (record that did not appear in lexical top-`fetchDepth` but did appear in vector top-`fetchDepth`)
    - Test that `embedder === null` path exactly equals lexical-only behaviour
    - Test that `embedder.embed` throwing falls back to lexical-only
    - Test that empty-token query returns `[]` without calling `embed`
    - Mock `Embedder` and use the real sqlite backend against an in-memory DB
    - Test file: `test/unit/embedding-query-layer.test.ts`
    - _Requirements: 5.1, 6.1, 6.2, 6.3, 6.4_

  - [x] 8.5 Write property test for hybrid lexical-only equivalence (Property 8)
    - **Property 8: Hybrid degrades cleanly to lexical**
    - For any corpus and query: if the embedder is unavailable (feature flag off, degraded, `embed(query)` throws, or every record in namespace has NULL embedding), `QueryLayer.search(ns, q, limit)` returns exactly the same ordered list as pure FTS5 retrieval
    - Use `arbitraryMixedCorpus` (task 12.1) and a fake embedder that can be switched into each failure mode
    - Test file: `test/unit/embedding-hybrid-lexical-equivalence.property.test.ts`
    - 50 runs
    - **Validates: Requirements 2.3, 6.3, 8.1, 8.2, 12.4, 16.3**

  - [x] 8.6 Write property test for namespace isolation and size invariant (Property 9)
    - **Property 9: Hybrid preserves namespace isolation and size invariant**
    - For any multi-namespace corpus, `QueryLayer.search(ns, q, limit)` returns ≤ `limit` records and every record has `record.namespace === ns`
    - Test file: `test/unit/embedding-hybrid-namespace-isolation.property.test.ts`
    - 50 runs
    - **Validates: Requirements 5.4, 5.5, 16.1, 16.4**

  - [x] 8.7 Write property test for hybrid determinism (Property 10)
    - **Property 10: Hybrid is deterministic**
    - For any corpus, query, limit: two sequential `search` calls return the same ordered list (relies on the tie-break `fused_score DESC, created_at DESC, record_id ASC`)
    - Test file: `test/unit/embedding-hybrid-determinism.property.test.ts`
    - 50 runs
    - **Validates: Requirements 5.8, 16.2**

  - [x] 8.8 Write property test for empty-query short-circuit (Property 11)
    - **Property 11: Empty-query short-circuit skips the embedder**
    - For any query whose FTS5 tokenisation is empty (empty string, whitespace-only), `search` returns `[]` and `embed` is not called (spy on the embedder)
    - Test file: `test/unit/embedding-hybrid-empty-query.property.test.ts`
    - 100 runs
    - **Validates: Requirements 6.4, 16.7**

  - [x] 8.9 Write property test for cache invalidation visibility (Property 12)
    - **Property 12: Writes in a namespace are visible to the next search**
    - For any initial corpus, namespace, and new record: after `putMemoryRecord(r)` then `putEmbedding(r.record_id, v)`, the next `search(ns, q, limit)` for a `q` lexically matching `r` includes `r`
    - Test file: `test/unit/embedding-hybrid-cache-invalidation.property.test.ts`
    - 50 runs
    - **Validates: Requirements 7.5**

- [x] 9. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. `BackfillWorker` — idle-priority, circuit breaker, resumable, idempotent
  - [x] 10.1 Create `src/collector/backfill/worker.ts`
    - Define `BackfillWorker = { start(); stop(timeoutMs): Promise<void>; status() }` and `BackfillWorkerConfig = { batchSize: 32, idleMs: 1000, circuitBreakerFailures: 5, circuitBreakerPauseMs: 60_000 }`
    - `createBackfillWorker({storage, embedder, config?})` returns an instance that does not start automatically
    - `start()` kicks off an async loop: while not stopped and `embedder.isReady()`, fetch `listRecordsWithoutEmbedding(null, batchSize)`; if empty, finish the loop cleanly; for each record, compute `composeEmbeddingInput(record)`, call `embedder.embed`, call `storage.putEmbedding`, track consecutive failures
    - On `circuitBreakerFailures` consecutive failures, transition to `paused`, sleep `circuitBreakerPauseMs`, reset counter, resume
    - `stop(timeoutMs)` sets a cancellation flag and awaits the current batch to drain, bounded by `timeoutMs`
    - `status()` exposes `state` (`'idle' | 'running' | 'paused' | 'stopped'`), `processed` count, and `lastError`
    - `idleMs` sleep between batches yields CPU under active load
    - After each successful `putEmbedding`, notify cache invalidation via a callback provided in deps (or re-fetch from `StorageBackend` — implementer picks per the wiring decision in task 8.3)
    - No imports from `src/collector/storage/sqlite/`, `src/shim/`, `src/installer/`, or `src/mcp/`
    - _Requirements: 8.4, 8.5, 8.6, 19.1, 19.2, 19.3_
    - _Design: Components and Interfaces § `src/collector/backfill/`_

  - [x] 10.2 Create `src/collector/backfill/index.ts` barrel
    - Re-export `BackfillWorker` (type), `BackfillWorkerConfig` (type), `BackfillWorkerDeps` (type), `createBackfillWorker`
    - _Requirements: 13.1_

  - [x] 10.3 Write unit tests for `BackfillWorker` lifecycle
    - Test `start` → processes all NULL-embedding records → `status().state === 'idle'` when batch is empty
    - Test `stop(timeout)` interrupts mid-batch and resolves within the timeout
    - Test degraded-mode guard: `embedder.isReady()` returning `false` causes the worker to stop without processing
    - Test circuit breaker: 5 consecutive embed failures trigger `paused` state; after pause, state returns to `running`
    - Test `status().processed` monotonically increases
    - Mock `Embedder` and use real sqlite backend
    - Test file: `test/unit/embedding-backfill-worker.test.ts`
    - _Requirements: 8.4, 8.5, 8.6_

  - [x] 10.4 Write property test for backfill idempotence (Property 13)
    - **Property 13: Backfill is idempotent and does no redundant work**
    - For any corpus, running backfill to completion once vs twice produces the same set of stored embeddings. In the second run, `embedder.embed` is invoked zero times (spy count).
    - Test file: `test/unit/embedding-backfill-idempotence.property.test.ts`
    - 50 runs
    - **Validates: Requirements 19.1, 19.2, 8.6**

  - [x] 10.5 Write property test for backfill crash safety (Property 14)
    - **Property 14: Backfill is crash-safe**
    - For any corpus and any interrupt point `i` (number of `putEmbedding` calls completed before `stop`): records with completed backfill have their correct embedding; all others have NULL; resuming reaches the terminal state of a single uninterrupted run
    - Interrupt by stopping the worker after a counted number of `putEmbedding` calls via a storage wrapper
    - Test file: `test/unit/embedding-backfill-crash-safety.property.test.ts`
    - 50 runs
    - **Validates: Requirements 19.3, 8.6**

- [x] 11. Collector wiring — `startCollector` changes, config fields, env var fallback
  - [x] 11.1 Extend `CollectorConfig` with embedding fields
    - Edit `src/collector/index.ts` to add optional fields: `embeddingEnabled?: boolean` (default `true`), `modelCacheDir?: string` (default `~/.kiro-learn/models/`), `embeddingTimeoutMs?: number` (default 2000), `rrfK?: number` (default 60), `hybridFetchDepthMultiplier?: number` (default 4), `backfillBatchSize?: number` (default 32)
    - Update `DEFAULT_COLLECTOR_CONFIG` accordingly
    - Respect `KIRO_LEARN_MODEL_DIR` env var as a fallback when `modelCacheDir` is unset
    - _Requirements: 12.1, 12.2, 12.3, 12.4_
    - _Design: Components and Interfaces § `src/collector/index.ts` — wiring changes_

  - [x] 11.2 Wire embedder, cache, and backfill worker in `startCollector`
    - If `embeddingEnabled === false`, set `embedder = null` and do NOT load the model (Req 12.5)
    - Otherwise call `createOnnxEmbedder({modelCacheDir, perCallTimeoutMs: embeddingTimeoutMs})`, then `await embedder.ready()` before binding the HTTP listener; on load failure, log an error and keep the embedder handle (it will report `isReady() === false` forever, i.e. degraded mode)
    - Pass `embedder` to both `createExtractionWorker` and `createQueryLayer`
    - If `embedder !== null && embedder.isReady()`, instantiate `createBackfillWorker({storage, embedder, onEmbeddingWritten: ns => queryLayer.invalidateNamespace(ns)})` and call `backfillWorker.start()`
    - Wire namespace invalidation: `ExtractionWorker` and `BackfillWorker` call `queryLayer.invalidateNamespace(ns)` after each successful embed write (use explicit callback dependency, not a storage-layer hook, to keep `StorageBackend` clean)
    - Extend `handle.close()` shutdown: `await backfillWorker?.stop(5000)` before `storage.close()`; call `embedder?.dispose?.()` if present
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 12.1, 12.2, 12.3, 12.4, 12.5, 13.6_
    - _Design: Components and Interfaces § `src/collector/index.ts` — wiring changes_

  - [x] 11.3 Write unit tests for collector wiring
    - Test that with `embeddingEnabled: true` and a successful embedder, `ExtractionWorker`, `QueryLayer`, and `BackfillWorker` all receive the same `Embedder` reference (identity assertion for Req 2.4)
    - Test that with `embeddingEnabled: false`, the embedder is never constructed, extractions write NULL, searches are pure lexical, and no `BackfillWorker` is started
    - Test degraded-mode startup: a failing embedder load logs an error and the collector still starts; `ExtractionWorker` and `QueryLayer` see `isReady() === false`
    - Test shutdown order: `backfillWorker.stop` completes before `storage.close`
    - Test file: `test/unit/embedding-collector-wiring.test.ts`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 12.1–12.5, 13.6_

  - [x] 11.4 Write unit tests for degraded mode and feature flag
    - Test the full degraded-mode path: startup with a failing embedder stub → subsequent writes store records with NULL embedding and log warnings → subsequent searches are lexical-only and log a warning once per query that attempts hybrid
    - Test the full feature-flag-off path: `embeddingEnabled: false` → model never loaded (assert no pipeline instantiation), extractions write NULL, searches are lexical-only (and therefore identical to pre-spec behaviour)
    - Test files: `test/unit/embedding-degraded-mode.test.ts`, `test/unit/embedding-feature-flag.test.ts`
    - _Requirements: 2.2, 2.3, 12.4, 12.5, 14.2, 14.3_

  - [x] 11.5 Write unit test for stats surface
    - Test that `storage.getStats()` returns correct `embeddings_present` and `embeddings_missing` at both global and namespace scope on a seeded fixture
    - Test file: `test/unit/embedding-stats.test.ts`
    - _Requirements: 14.4_

- [x] 12. Test helpers — new fast-check generators
  - [x] 12.1 Add new arbitraries to `test/helpers/arbitrary.ts`
    - `arbitraryFloat32Array(len: number): fc.Arbitrary<Float32Array>` — finite-or-non-finite floats (tune `noNaN: false, noDefaultInfinity: false`)
    - `arbitraryRankedList(ids: string[]): fc.Arbitrary<Ranked[]>` — permutation with 1-based ranks, optionally a random subset
    - `arbitraryMemoryRecord(): fc.Arbitrary<MemoryRecord>` — if not already present; otherwise reuse the existing generator
    - `arbitraryMixedCorpus(namespace: string): fc.Arbitrary<Array<{record: MemoryRecord; embedding: Float32Array | null}>>` — corpus with a realistic mix of embedded and non-embedded records
    - _Requirements: supports Properties 1, 6, 8, 9, 10, 11, 12, 13, 14_

- [x] 13. Guard tests — enforce new modularity boundaries
  - [x] 13.1 Guard test: embedding module must not import from `storage/sqlite/`
    - Pattern from `test/unit/no-sqlite-in-pipeline.test.ts`: scan all `.ts` files under `src/collector/embedding/`, strip comments, assert no `storage/sqlite` import
    - Test file: `test/unit/no-storage-sqlite-in-embedding.test.ts`
    - _Requirements: 13.1, 13.2_

  - [x] 13.2 Guard test: backfill module must not import from `storage/sqlite/`
    - Same pattern for `src/collector/backfill/`
    - Test file: `test/unit/no-storage-sqlite-in-backfill.test.ts`
    - _Requirements: 13.1, 13.2_

  - [x] 13.3 Guard test: embedding module must not import from `src/shim/`, `src/installer/`, or `src/mcp/`
    - Scan `src/collector/embedding/` and `src/collector/backfill/` for forbidden imports
    - Test file: `test/unit/no-shim-installer-mcp-in-embedding.test.ts`
    - _Requirements: 13.3_

  - [x] 13.4 Guard test: shim and MCP must not import from embedding or backfill modules
    - Scan `src/shim/**` and `src/mcp/**` for any import of `collector/embedding` or `collector/backfill`
    - Test file: `test/unit/no-embedding-in-shim.test.ts`
    - _Requirements: 13.3_

  - [x] 13.5 Guard test: HTTP receiver must not invoke `embedder.embed` directly
    - Scan `src/collector/receiver/**` for `embedder.embed` / `.embed(` call sites; assert none exist (embedding must run only inside the async extraction worker or in the query layer). Complement with a wiring test that spies on the embedder during receiver tests and asserts zero calls on the write path before extraction fires.
    - Test file: `test/unit/no-embedding-in-receiver.test.ts`
    - _Requirements: 10.2_

- [x] 14. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Documentation — retrieval, database, AGENTS.md
  - [x] 15.1 Update `docs/architecture/retrieval.mdx`
    - Add a section describing hybrid search: FTS5 lexical path, vector cosine path, RRF fusion, `k = 60`, fetch depth `limit × C`
    - Describe the lexical-only fallback for degraded mode, query-embed failure, and NULL-embedding records
    - Include a `sequenceDiagram` matching the design's "Sequence: hybrid search on read"
    - _Requirements: 20.1_

  - [x] 15.2 Update `docs/architecture/database.mdx`
    - Document the new `embedding BLOB DEFAULT NULL` column on `memory_records`
    - Document migration `0005_memory_record_embedding` and its additive nature (no row rewrites)
    - Describe the 1536-byte little-endian IEEE-754 single-precision encoding
    - _Requirements: 20.2_

  - [x] 15.3 Update `AGENTS.md` North Star progress list
    - Mark "Hybrid search with local embeddings" as delivered (`[x]`)
    - Replace the "Titan Text Embeddings V2 + `sqlite-vec`" description with the actual delivered choices: "MiniLM-L6-v2 (local ONNX) + BLOB + RRF"
    - _Requirements: 20.3_

- [x] 16. Performance benchmarks
  - [x] 16.1 Embedding latency benchmark
    - `test/integ/embedding-embed-latency.test.ts`: run 100 embeds of a 4 000-char input through the real `OnnxEmbedder`; assert p95 < 100 ms after a discarded warm-up
    - Gate on model availability; skip gracefully in CI if the model cache is cold and network is disabled
    - _Requirements: 10.1_
    - _Design: Testing Strategy § Performance benchmarks_

  - [x] 16.2 Hybrid latency benchmark — 1k records
    - `test/integ/embedding-hybrid-latency-1k.test.ts`: seed an in-memory SQLite namespace with 1 000 embedded records; run 100 hybrid queries; assert p95 < 50 ms
    - _Requirements: 9.3_

  - [x] 16.3 Hybrid latency benchmark — 50k records
    - `test/integ/embedding-hybrid-latency-50k.test.ts`: seed a namespace with 50 000 embedded records; run 20 hybrid queries; assert p95 < 500 ms
    - _Requirements: 9.1_

- [x] 17. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP. They cover property tests, unit tests, and performance benchmarks. Core implementation tasks (unmarked) are mandatory.
- Each task references specific sub-requirements (not just user-story numbers) using the Requirements Traceability table in `design.md` as the authoritative mapping.
- Property tests are first-class: Properties 1–15 from `design.md` § Correctness Properties each have their own task. Each property test file tags properties with the feature name and property number per workflow convention.
- Guard tests (13.1–13.5) are non-optional because they enforce the project's hard modularity boundaries documented in `AGENTS.md`.
- All imports must use `.js` extensions (ESM resolution). Use `import type { ... }` for type-only imports.
- The embedding and backfill modules receive `StorageBackend` and `Embedder` via DI; only `src/collector/index.ts` knows the concrete implementations.
- Embeddings are internal to storage. `MemoryRecordSchema` and `KiroMemEvent` do not change; `schema_version` stays at `1`.
- Never-degrade guarantee (verified by Property 8): no embedding failure mode makes search results worse than the pre-spec FTS5 baseline.
- **Unit and property tests must NEVER load the real ONNX model in the main `test/unit/` suite except where explicitly called out (tasks 4.3, 4.4).** Otherwise use a stubbed `Embedder`. Benchmarks in `test/integ/` may use the real model and gate on its availability.
