# Requirements Document

## Introduction

This spec adds local semantic embeddings and hybrid (lexical + vector) search to kiro-learn.

Today, memory records are retrieved exclusively through SQLite FTS5 lexical matching. Queries like "IAM role assumption" and "STS federation" do not match each other, even though they describe the same concept. Near-duplicate records accumulate because there is no semantic notion of similarity.

This spec delivers three capabilities in a single, self-contained increment:

1. **Embedding computation on write.** Every newly created `MemoryRecord` is embedded using a local CPU model (`all-MiniLM-L6-v2`, 384-dim) at extraction time. The embedding is stored as a fixed-width `BLOB` on the memory record row.
2. **Hybrid retrieval on read.** The existing `QueryLayer.search` surface transparently combines FTS5 lexical rank and vector cosine rank via **Reciprocal Rank Fusion (RRF)**. No new public API is added — callers (`RetrievalAssembler`, MCP `search_memory`, viewer UI) see improved result quality without code change.
3. **Backward-compatible fallback.** Memory records that predate this spec, or whose embedding failed to compute, remain searchable via the lexical path. The system never degrades below FTS5-only quality.

The feature is foundational for a planned Spec 2 (reconciliation pipeline) that will use the same embeddings to identify merge candidates. This spec is designed to deliver value on its own even if Spec 2 is deferred indefinitely.

### Design decisions already fixed by the user

These are inputs to the requirements, not open questions:

- **Model.** `all-MiniLM-L6-v2`, 384-dim, local-first. No network calls per embedding. No Bedrock Titan, no hosted API. The model runs on CPU via ONNX runtime. The specific wrapper library (`onnxruntime-node`, `@huggingface/transformers`, `@xenova/transformers`) is a design-phase decision.
- **Storage.** Embeddings are stored as a `BLOB` column on the `memory_records` row. No `sqlite-vec`, no native vector index, no sidecar store. Brute-force cosine over a per-namespace `Float32Array` is acceptable at this scale (tens of thousands of records).
- **Hybrid algorithm.** Reciprocal Rank Fusion. Chosen because it requires no score normalisation between heterogeneous retrievers.
- **Scope.** Only `MemoryRecord` rows are embedded. Raw events, buffer entries, and concept strings are out of scope. Cross-namespace search is out of scope.

## Glossary

- **Embedder**: The service that turns a string into a 384-dimensional `Float32Array` using the configured local ONNX model.
- **Embedding_Store**: The storage-layer component responsible for persisting, reading, and enumerating per-record embedding BLOBs.
- **Hybrid_Search**: The read-path algorithm that combines FTS5 lexical rank and vector cosine rank into a single result list via Reciprocal Rank Fusion.
- **Vector_Index** (logical, not physical): The brute-force in-memory representation of all embeddings for a single namespace, built on demand from the `Embedding_Store`.
- **RRF** (Reciprocal Rank Fusion): The rank-aggregation algorithm `score(d) = Σ 1 / (k + rank_i(d))` over the retrievers in which document `d` appears, with a fixed constant `k` (default `60`).
- **MemoryRecord**: The long-term memory unit defined in `src/types/schemas.ts`. The unit of embedding in this spec.
- **Namespace**: The path `/actor/{actor}/project/{project}/` that scopes both storage and retrieval. Hybrid search never crosses namespaces.
- **System**: The kiro-learn collector daemon as a whole. Used when a requirement does not attribute behaviour to a named subcomponent.
- **Cold_Start**: The first call to the embedder after collector daemon startup. Includes any model-file download, ONNX session initialisation, and warm-up tokenisation.
- **Backfill**: The act of computing and storing embeddings for memory records that were created before this feature landed.

## Requirements

### Requirement 1: Local embedding computation

**User Story:** As an operator, I want embeddings computed locally on CPU without any network calls per embedding, so that my agent sessions stay offline-capable and have no per-record cost.

#### Acceptance Criteria

1. THE Embedder SHALL produce a 384-dimensional vector for any input string of length 1 to 10000 characters.
2. THE Embedder SHALL return the vector as a `Float32Array` of length 384.
3. WHEN the Embedder is invoked with the same input string twice in the same process, THE Embedder SHALL return byte-identical vectors.
4. THE Embedder SHALL NOT make any outbound network request on any call after the model has been loaded.
5. IF the model files are not present on disk on first collector startup, THEN THE Embedder SHALL download the model to a local cache directory before accepting embedding calls.
6. WHERE the model files are already present on disk, THE Embedder SHALL load them from the local cache without any network access.
7. THE Embedder SHALL use the `all-MiniLM-L6-v2` model.

### Requirement 2: Model lifecycle and cold start

**User Story:** As an operator, I want the embedding model loaded at daemon startup rather than on first write, so that the first event after a cold start does not spike write-path latency.

#### Acceptance Criteria

1. WHEN the collector daemon starts, THE System SHALL load the embedding model before declaring readiness on the HTTP receiver.
2. IF loading the embedding model fails at startup, THEN THE System SHALL log the error and start the daemon in a degraded mode where new memory records are stored without embeddings.
3. WHILE the daemon is in degraded mode, THE Hybrid_Search SHALL fall back to FTS5-only retrieval.
4. THE System SHALL expose the embedder through a single shared instance; the Embedder SHALL NOT be reloaded per call or per worker.
5. THE System SHALL complete cold-start model initialisation (including any first-run download) within a timeout that does not cause the installer's `kiro-learn start` command to time out at its existing budget.

### Requirement 3: Embedding on write

**User Story:** As a user of kiro-learn, I want every new memory record to carry an embedding from the moment it is stored, so that newly captured knowledge is immediately searchable semantically.

#### Acceptance Criteria

1. WHEN the ExtractionWorker produces a `MemoryRecord`, THE System SHALL persist the record via `storage.putMemoryRecord` first, then compute the embedding via the Embedder and persist it via `storage.putEmbedding` as a subsequent step, so that a slow or failing embedder cannot block, drop, or delay the record insert (Requirement 3.5).
2. THE System SHALL derive the Embedder input string from the record's `title`, `summary`, `facts`, and `concepts` fields, combined in a deterministic order defined in the design.
3. WHEN the embedding computation succeeds, THE Embedding_Store SHALL persist the vector on the same SQLite row as the memory record. The write is performed as two sequential `putMemoryRecord` + `putEmbedding` calls, not a single transaction (see design § Sequence: embedding on write); a reader that catches the sub-millisecond gap observes the record without its embedding and falls back to lexical-only for that record per Requirement 8.1, which is indistinguishable from normal degraded-mode behaviour.
4. IF the embedding computation fails for a record, THEN THE System SHALL store the memory record without an embedding and log a warning.
5. IF the embedding computation fails for a record, THEN THE System SHALL NOT block, drop, or delay the record insert.
6. THE System SHALL NOT compute embeddings for raw events, buffer entries, or concept strings.

### Requirement 4: Embedding storage

**User Story:** As a developer, I want embeddings persisted alongside memory records in SQLite, so that the storage layer remains a single source of truth and there is no sidecar file to synchronise.

#### Acceptance Criteria

1. THE Embedding_Store SHALL persist each embedding as a `BLOB` column on the `memory_records` row identified by `record_id`.
2. THE Embedding_Store SHALL encode each 384-dimensional `Float32Array` as 1536 bytes in little-endian IEEE-754 single-precision format.
3. WHEN a memory record has no embedding, THE Embedding_Store SHALL represent that absence as SQL `NULL` in the embedding column.
4. WHEN the Embedding_Store reads an embedding, THE Embedding_Store SHALL reconstruct a `Float32Array` whose contents are bitwise-equal to the `Float32Array` that was written.
5. THE Embedding_Store SHALL introduce the new column via a forward-only SQLite migration that follows the existing monotonic numeric-prefix convention under `src/collector/storage/sqlite/migrations/`.
6. THE migration SHALL add the embedding column as nullable so that existing rows remain valid without rewrite.
7. THE Embedding_Store SHALL expose a bulk-load method that returns one row per non-null embedding in a given namespace. The row shape SHALL include `record_id`, `embedding`, and `created_at` so the caller can build an in-memory `Vector_Index` and apply the deterministic `(fused_score DESC, created_at DESC, record_id ASC)` tie-break from Requirement 5.8 without a second round-trip. Namespace scoping SHALL be exact match, not prefix, so the hybrid read path never implicitly widens across sibling namespaces.

### Requirement 5: Hybrid search query

**User Story:** As a user of kiro-learn, I want a single search query to return results that are relevant both lexically and semantically, so that paraphrased queries still surface relevant prior memories.

#### Acceptance Criteria

1. WHEN `QueryLayer.search(namespace, query, limit)` is called, THE Hybrid_Search SHALL produce a result list that combines an FTS5 lexical ranking and a vector-cosine ranking of memory records within the given namespace.
2. THE Hybrid_Search SHALL combine the two rankings using Reciprocal Rank Fusion with fused score `score(d) = 1 / (k + rank_lex(d)) + 1 / (k + rank_vec(d))`, treating absence from a ranking as if the document ranked at infinity (contributing 0).
3. THE Hybrid_Search SHALL use a fixed RRF constant `k = 60` unless overridden in configuration.
4. THE Hybrid_Search SHALL return at most `limit` records, ordered by descending fused score.
5. THE Hybrid_Search SHALL return only memory records whose `namespace` equals the requested namespace; cross-namespace results SHALL NOT appear.
6. THE Hybrid_Search SHALL return an empty array when the namespace has zero memory records.
7. THE Hybrid_Search SHALL NOT change the public shape of `QueryLayer.search`; callers SHALL continue to receive `MemoryRecord[]` with no new fields required on the type.
8. THE Hybrid_Search SHALL tie-break records with equal fused score by descending `created_at`, then by ascending `record_id`, so the result order is deterministic for identical inputs.

### Requirement 6: Query-time embedding

**User Story:** As a user, I want my natural-language search query to be embedded on demand so it can be compared to stored record embeddings.

#### Acceptance Criteria

1. WHEN Hybrid_Search is invoked with a non-empty query string, THE System SHALL compute a 384-dimensional query embedding using the same Embedder configuration used at write time.
2. THE System SHALL compute the query embedding at most once per `QueryLayer.search` call.
3. IF the query embedding computation fails, THEN THE Hybrid_Search SHALL fall back to FTS5-only retrieval and log a warning.
4. WHEN the input query tokenises to zero FTS5 tokens (empty or whitespace-only), THE Hybrid_Search SHALL return an empty array without computing a query embedding.

### Requirement 7: Vector similarity

**User Story:** As a developer, I want cosine similarity computed over a simple in-memory index, so that we can ship without a native vector-index dependency.

#### Acceptance Criteria

1. THE Vector_Index SHALL compute cosine similarity between the query embedding and every stored embedding in the requested namespace.
2. THE Vector_Index SHALL rank records by descending cosine similarity.
3. THE Vector_Index SHALL exclude records with a `NULL` embedding from its ranking.
4. THE Vector_Index SHALL be computed from storage on demand and MAY be cached per namespace for the lifetime of a single daemon process.
5. WHERE an embedding cache is used, THE Vector_Index SHALL invalidate or incrementally update the cache when a new memory record is inserted into that namespace.
6. THE Vector_Index SHALL handle the degenerate zero-norm embedding case by treating its cosine similarity with any query vector as `0`.

### Requirement 8: Backward compatibility with pre-embedding records

**User Story:** As an existing user upgrading kiro-learn, I want memory records created before the embedding feature to remain searchable without a blocking migration.

#### Acceptance Criteria

1. IF a memory record has a `NULL` embedding, THEN THE Hybrid_Search SHALL still consider that record through the FTS5 lexical ranking.
2. IF every memory record in a namespace has a `NULL` embedding, THEN THE Hybrid_Search SHALL return the same result list that FTS5-only retrieval would have returned for the same query and limit.
3. THE migration that adds the embedding column SHALL NOT require reading or rewriting any pre-existing row.
4. THE System SHALL provide a mechanism to backfill embeddings for pre-existing memory records, executed either as a one-time migration or incrementally on a background schedule; the specific mechanism is a design-phase decision.
5. WHILE a backfill is in progress, THE Hybrid_Search SHALL continue to serve read traffic without blocking on backfill completion.
6. IF a backfill run is interrupted (daemon restart, process kill), THEN THE System SHALL be able to resume without re-embedding records that already have a non-null embedding.

### Requirement 9: Retrieval latency budget

**User Story:** As a user of kiro-learn, I want retrieval to stay within the same latency budget that FTS5-only retrieval currently honours, so that hybrid search does not regress prompt-time responsiveness.

#### Acceptance Criteria

1. THE Hybrid_Search SHALL complete within the existing retrieval budget of 500 ms at the p95 percentile for namespaces containing up to 50,000 memory records, measured end-to-end from `QueryLayer.search` entry to return.
2. WHEN the retrieval budget is exceeded, THE RetrievalAssembler SHALL return partial or empty results rather than error, preserving the existing timeout semantics documented in `src/collector/retrieval/index.ts`.
3. THE Hybrid_Search SHALL complete in under 100 ms at the p95 percentile for namespaces containing up to 1,000 memory records.
4. THE System SHALL NOT hold a blocking lock on memory-record inserts while a hybrid search is in flight, and SHALL NOT hold a blocking lock on hybrid search while a memory-record insert is in flight.

### Requirement 10: Write-path latency budget

**User Story:** As an agent interacting with kiro-learn, I want extraction write-path latency to stay bounded, so that enabling embeddings does not materially slow the ingest pipeline.

#### Acceptance Criteria

1. WHEN an ExtractionWorker stores a memory record of up to 4000 characters of combined `title` + `summary` + `facts`, THE Embedder SHALL return an embedding within 100 ms at the p95 percentile on CPU after cold start.
2. THE embedding computation SHALL NOT run on the HTTP-receiver hot path; the embedding step SHALL only run within the already-async extraction worker.
3. THE Embedder SHALL bound any single embedding call at a configurable timeout; the default timeout SHALL be 2 seconds.
4. IF the embedder exceeds its per-call timeout, THEN THE System SHALL treat the call as a failure per Requirement 3.4.

### Requirement 11: Storage overhead

**User Story:** As an operator, I want the storage cost of embeddings to stay predictable and bounded, so that long-lived collectors do not run out of disk unexpectedly.

#### Acceptance Criteria

1. THE Embedding_Store SHALL consume exactly 1536 bytes per embedded memory record in the embedding column, plus SQLite's row overhead.
2. THE Embedding_Store SHALL NOT replicate the embedding into any other table, index, or sidecar file.
3. THE Embedding_Store SHALL NOT store the raw input string that was embedded; only the resulting vector is persisted.

### Requirement 12: Configuration surface

**User Story:** As a developer, I want the embedding subsystem configurable but sensibly defaulted, so that operators rarely need to tune it.

#### Acceptance Criteria

1. THE System SHALL accept the RRF constant `k` as an optional configuration field, defaulting to `60`.
2. THE System SHALL accept an optional per-embedding-call timeout, defaulting to 2000 ms.
3. THE System SHALL accept an optional local model cache directory, defaulting to `~/.kiro-learn/models/`.
4. THE System SHALL accept an optional feature flag to disable embedding on write; when disabled, every new record is stored with a `NULL` embedding and hybrid search falls back to FTS5-only.
5. WHERE the feature flag is disabled, THE System SHALL NOT load the model at startup.

### Requirement 13: Modularity boundary for the embedder

**User Story:** As a developer, I want the embedder module to respect kiro-learn's existing modularity boundaries, so that we do not have to rewrite CI guard tests.

#### Acceptance Criteria

1. THE Embedder SHALL live in a new module under `src/collector/` that is accessible to both the `buffer/` (extraction worker) and `query/` layers.
2. THE Embedder module SHALL NOT import from `src/collector/storage/sqlite/`.
3. THE Embedder module SHALL NOT import from `src/shim/`, `src/installer/`, or `src/mcp/`.
4. THE ExtractionWorker SHALL receive the Embedder via dependency injection; the worker SHALL NOT instantiate the Embedder directly.
5. THE QueryLayer SHALL receive the Embedder (or a `search_with_embedding` seam) via dependency injection; the query layer SHALL NOT instantiate the Embedder directly.
6. Only `src/collector/index.ts` SHALL know the concrete Embedder implementation, consistent with the existing storage-backend injection pattern.

### Requirement 14: Observability

**User Story:** As an operator, I want visibility into embedding health, so that I can detect when the degraded mode is in effect.

#### Acceptance Criteria

1. WHEN a memory record is stored without an embedding due to embedder failure, THE System SHALL log a warning containing the `record_id` and an error reason.
2. WHEN the Hybrid_Search falls back to FTS5-only retrieval for a query due to query-embedding failure, THE System SHALL log a warning.
3. WHEN the collector starts in degraded mode due to model-load failure, THE System SHALL log an error at startup and continue to log a warning each time degraded mode affects a query or write.
4. THE System SHALL expose the count of memory records with and without embeddings, scoped per namespace, via the existing `StorageBackend.getStats` surface or an analogous read-API extension; the specific wire shape is a design-phase decision.

### Requirement 15: Parse/serialise round-trip for stored embeddings

**User Story:** As a developer, I want guarantees that embeddings survive the SQLite round-trip exactly, so that semantic similarity math is not silently corrupted by encoding bugs.

#### Acceptance Criteria

1. FOR ALL `Float32Array` values of length 384, encoding the value to a `BLOB` and decoding it back SHALL produce a `Float32Array` whose contents are bitwise-equal to the input, including for `NaN`, `+0`, `-0`, `+Infinity`, and `-Infinity` (round-trip property).
2. FOR ALL `Float32Array` values of length 384, the decoded `Float32Array` SHALL have length exactly 384 (invariant).
3. IF a BLOB of length other than 1536 bytes is encountered on read, THEN THE Embedding_Store SHALL raise an error identifying the offending `record_id`.

### Requirement 16: Hybrid-search correctness properties

**User Story:** As a developer, I want property-based guarantees about hybrid search behaviour, so that regressions in the fusion algorithm are caught before shipping.

#### Acceptance Criteria

1. FOR ALL namespaces containing at least one memory record, `Hybrid_Search(namespace, q, limit)` SHALL return at most `limit` records (size invariant).
2. FOR ALL calls with the same inputs and the same underlying corpus, `Hybrid_Search` SHALL return the same ordered result list (determinism, given the tie-breaker in Requirement 5.8).
3. FOR ALL namespaces where every memory record has a `NULL` embedding, `Hybrid_Search(namespace, q, limit)` SHALL return the same ordered result list as pure FTS5 retrieval with the same inputs (lexical-only equivalence).
4. FOR ALL records returned by `Hybrid_Search(ns, q, limit)`, each record's `namespace` SHALL equal `ns` (namespace isolation).
5. FOR ALL records `d` returned by `Hybrid_Search`, the fused score of `d` SHALL be greater than or equal to the fused score of every record that appears later in the result list (ordering invariant).
6. IF a record `d` appears at lexical rank `r_lex` and vector rank `r_vec`, and `d'` appears at lexical rank `r_lex` and vector rank `r_vec + n` for `n > 0`, THEN the fused score of `d` SHALL be strictly greater than the fused score of `d'` (rank-monotonicity).
7. FOR ALL queries whose FTS5 tokenisation is empty, `Hybrid_Search` SHALL return an empty array without invoking the Embedder (empty-query short-circuit).

### Requirement 17: Embedder correctness properties

**User Story:** As a developer, I want property-based guarantees about embedder output shape, so that downstream code can rely on invariants without defensive checks everywhere.

#### Acceptance Criteria

1. FOR ALL non-empty input strings up to 10000 characters, `Embedder.embed(s)` SHALL return a `Float32Array` of length exactly 384 (shape invariant).
2. FOR ALL input strings `s`, every element of `Embedder.embed(s)` SHALL be a finite number (`Number.isFinite` true); no `NaN` or `±Infinity` values SHALL appear.
3. FOR ALL input strings `s`, `Embedder.embed(s)` SHALL return the same vector across calls within the same process (determinism).
4. FOR ALL input strings `s`, the L2 norm of `Embedder.embed(s)` SHALL be greater than zero (non-degenerate output), so cosine similarity is always well-defined except for the explicit zero-norm guard in Requirement 7.6.

### Requirement 18: RRF fusion correctness properties

**User Story:** As a developer, I want property-based guarantees about the RRF fusion function in isolation, so that fusion bugs are caught independently of any storage integration.

#### Acceptance Criteria

1. FOR ALL pairs of ranked lists `L` (lexical) and `V` (vector) over a shared document set, RRF fusion SHALL produce a result list whose length is at most `|L ∪ V|` (size invariant).
2. FOR ALL pairs of ranked lists `L` and `V` and all documents `d ∈ L ∪ V`, the RRF score of `d` SHALL equal `1 / (k + rank_L(d)) + 1 / (k + rank_V(d))`, treating absence from a list as contributing `0` (correctness of score formula).
3. FOR ALL ranked lists `L` and `V` that are identical permutations, RRF fusion SHALL produce that same permutation (agreement preservation).
4. FOR ALL ranked lists `L` and the empty list `V = []`, RRF fusion SHALL produce `L` truncated to `limit` (lexical-only fallback).
5. FOR ALL ranked lists `L = []` and non-empty `V`, RRF fusion SHALL produce `V` truncated to `limit` (vector-only fallback — degraded-write mode still produces useful rankings if a query path emits one).
6. FOR ALL result lists produced by RRF fusion, the scores SHALL be monotonically non-increasing from first to last element (score-ordering invariant).

### Requirement 19: Backfill correctness properties

**User Story:** As an operator running a backfill, I want property-based guarantees that backfill is safe to run repeatedly, so that interruptions and re-runs do not corrupt state.

#### Acceptance Criteria

1. FOR ALL corpora `C` of memory records, running backfill over `C` once followed by running backfill over `C` a second time SHALL produce the same set of stored embeddings as running backfill once (idempotence).
2. FOR ALL corpora `C` and subsets `C' ⊂ C` that already have embeddings, a backfill run SHALL NOT re-compute or overwrite embeddings for records in `C'` (no-redundant-work).
3. FOR ALL corpora `C`, a backfill run interrupted at any point SHALL leave the database in a state where the non-backfilled records still have `NULL` embedding and the backfilled records have their correct embedding (crash safety — no torn writes).

### Requirement 20: Documentation

**User Story:** As a user reading kiro-learn's public docs, I want the embedding feature described in the architecture pages, so that I understand how retrieval works end-to-end.

#### Acceptance Criteria

1. THE System SHALL update `docs/architecture/retrieval.mdx` to describe hybrid search, including a short explanation of RRF and the lexical-only fallback.
2. THE System SHALL update `docs/architecture/database.mdx` to describe the new embedding column and its migration.
3. THE System SHALL update the AGENTS.md North Star progress list, marking "Hybrid search with local embeddings" as delivered and reflecting the actual model and storage choices (MiniLM + BLOB + RRF, not Titan + `sqlite-vec`).
4. THE System SHALL NOT introduce any new public wire-schema field without a corresponding update to `docs/concepts/event-types.mdx`; if the design decides to keep embeddings purely internal to storage, this requirement is trivially satisfied.
