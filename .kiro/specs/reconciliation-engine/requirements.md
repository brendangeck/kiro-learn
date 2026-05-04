# Requirements Document

## Introduction

The Reconciliation Engine is the final V0 feature. It replaces today's single-stage extraction with a two-stage **ingestion pipeline**: **extraction** (unchanged conceptually — produces candidate memories from buffered events) followed by a new **reconciliation** stage that deduplicates candidates against each other and against existing memory records in the graph.

Today, the Extraction Worker fires roughly every 5 seconds per project and writes every `<memory_record>` the compressor emits as a new row in `memory_records`. Because the compressor often re-describes the same underlying fact across batches (and occasionally within a single batch), the memory graph accumulates near-duplicate nodes that share a topic, differ only in phrasing, and dilute hybrid search results.

Reconciliation addresses this by:

1. Lengthening the buffer flush cadence so each extraction batch sees more context.
2. Treating extraction output as **candidate** memories, not final records.
3. Running a reconciliation pass that:
   - Clusters semantically-similar candidates within the same batch.
   - For each surviving cluster, uses embedding-based vector search to find existing graph records above a similarity threshold.
   - Invokes a low-cost LLM ("judge") to make the final same-node / different-node call on the combined candidate-plus-neighbors pool.
   - When the judge rules "same", emits a single **summary record** and deletes the merged originals in the same transaction.
   - When the judge rules "different", emits the surviving candidates as-is.

The feature builds on infrastructure already in place: MiniLM-L6-v2 local ONNX embeddings, the cosine + RRF hybrid search, the SQLite + FTS5 backend, and the ACP-based compressor/compactor pattern.

## Glossary

- **Ingestion Pipeline**: The end-to-end flow from buffer snapshot to committed memory records. Composed of two sequential stages: Extraction and Reconciliation.
- **Extraction Stage**: The existing buffer-to-XML-to-LLM step. Produces Candidate Memories. Renamed in code and docs but unchanged in responsibility.
- **Candidate Memory**: A `MemoryRecord`-shaped value produced by the Extraction Stage but not yet persisted to `memory_records`. Carries the same fields as a final record (`title`, `summary`, `facts`, `concepts`, `files_touched`, `observation_type`, `source_event_ids`, `namespace`) plus a freshly computed embedding vector.
- **Reconciliation Stage**: The new post-extraction pass that deduplicates Candidate Memories against each other and against existing `memory_records`, then commits the survivors.
- **Candidate Cluster**: A set of one or more Candidate Memories that the intra-batch reconciliation step judged to refer to the same underlying thing.
- **Neighbor Pool**: The set of existing `memory_records` in the same namespace whose embedding has cosine similarity ≥ a configured threshold to a Candidate Cluster's representative vector.
- **Judge Model**: The cheap LLM invoked by the Reconciliation Stage to make the final merge / keep-separate decision for a (Candidate Cluster, Neighbor Pool) pair. Accessed via an ACP agent (`kiro-learn-reconciler`) so no third-party SDK is introduced.
- **Summary Record**: A new `MemoryRecord` produced when the Judge rules that the Candidate Cluster and some subset of the Neighbor Pool describe the same thing. Replaces its sources — the merged originals are deleted in the same commit transaction.
- **Reconciliation Worker**: The component that owns the Reconciliation Stage lifecycle — analogous to today's Extraction Worker and Compaction Worker.
- **Buffer Flush Interval**: The idle-timeout threshold on the buffer watcher that fires an ingestion trigger. Previously governed the Extraction Worker alone; now governs the full Ingestion Pipeline.
- **Intra-batch Similarity Threshold**: The cosine-similarity floor above which two Candidate Memories are considered for clustering without consulting the Judge Model.
- **Neighbor Similarity Threshold**: The cosine-similarity floor above which an existing `memory_record` is added to a Candidate Cluster's Neighbor Pool.
- **Embedder**: The existing local ONNX embedder (`src/collector/embedding/onnx-embedder.ts`) used on the memory-record write path today. Reused by the Reconciliation Stage to embed Candidate Memories before they reach storage.

## Requirements

### Requirement 1: Ingestion Pipeline Structure

**User Story:** As a kiro-learn operator, I want extraction and reconciliation to run as two sequential stages of a single ingestion pipeline, so that deduplication logic is applied uniformly to every memory before it enters the graph.

#### Acceptance Criteria

1. THE Ingestion_Pipeline SHALL run the Extraction Stage and the Reconciliation Stage in sequence for each buffer snapshot, with the Reconciliation Stage's input being exactly the output of the Extraction Stage.
2. WHEN the Extraction Stage returns zero Candidate Memories for a buffer snapshot, THE Ingestion_Pipeline SHALL skip the Reconciliation Stage and clear the buffer using the current extraction-success semantics.
3. WHEN the Reconciliation Stage raises an error after the Extraction Stage succeeded, THE Ingestion_Pipeline SHALL leave the buffer intact and record the failure against the reconciliation circuit breaker defined in Requirement 12.
4. THE Ingestion_Pipeline SHALL only clear the buffer after the Reconciliation Stage has successfully committed its output (including the zero-commit case where every Candidate Memory was judged redundant).
5. THE Ingestion_Pipeline SHALL preserve the existing extraction concurrency semaphore (default concurrency 2) so that the Reconciliation Stage runs inside the same semaphore slot as its paired extraction run.
6. WHERE the reconciliation feature flag is disabled, THE Ingestion_Pipeline SHALL commit every Candidate Memory directly to `memory_records` as a new record, matching today's extraction behavior byte-for-byte.

### Requirement 2: Buffer Flush Interval

**User Story:** As a kiro-learn operator, I want extraction to fire less frequently so that each ingestion batch contains enough context for reconciliation to find meaningful duplicates.

#### Acceptance Criteria

1. THE Buffer_Watcher SHALL use an idle-flush interval of 30 seconds (replacing the current 5-second default) as its default configuration.
2. THE Buffer_Watcher SHALL accept a configuration override for the idle-flush interval in the range 5 seconds to 300 seconds inclusive.
3. THE Buffer_Watcher SHALL continue to fire an ingestion trigger when the buffer size exceeds the existing 256 KiB extraction threshold, independent of the idle-flush interval.
4. THE Buffer_Watcher SHALL continue to fire a compaction trigger at the existing 1 MiB compaction threshold, independent of the idle-flush interval.

### Requirement 3: Candidate Memory Representation

**User Story:** As a developer extending the pipeline, I want extraction output to be typed as Candidate Memories rather than final records, so that I cannot accidentally write an unreconciled memory to the graph.

#### Acceptance Criteria

1. THE Extraction_Stage SHALL emit an in-memory list of Candidate Memories and SHALL NOT call `StorageBackend.putMemoryRecord` or `StorageBackend.putEmbedding`.
2. THE Candidate_Memory SHALL carry every field required by the existing `MemoryRecord` schema (`record_id`, `namespace`, `strategy`, `source_event_ids`, `title`, `summary`, `facts`, `concepts`, `files_touched`, `observation_type`, `created_at`) plus a pre-computed embedding vector of the dimensionality produced by the Embedder.
3. THE Extraction_Stage SHALL compute the embedding of each Candidate Memory using the same Embedder and input composition function used for the current embed-on-write path.
4. IF the Embedder is not ready or fails for a given Candidate Memory, THEN THE Extraction_Stage SHALL emit the Candidate Memory with a null embedding and log a warning identifying the candidate's `record_id`.
5. THE Extraction_Stage SHALL assign each Candidate Memory a fresh `record_id` of the form `mr_` followed by a ULID, using the same generation scheme as today's extraction worker.

### Requirement 4: Intra-batch Reconciliation

**User Story:** As a user of kiro-learn, I want candidates produced by the same extraction batch to be merged when they describe the same thing, so that the graph does not acquire self-duplicates from a single LLM call.

#### Acceptance Criteria

1. WHEN the Extraction_Stage emits two or more Candidate Memories, THE Reconciliation_Stage SHALL compute pairwise cosine similarity across every pair whose embeddings are both non-null.
2. WHEN the cosine similarity between two Candidate Memories meets or exceeds the Intra-batch Similarity Threshold, THE Reconciliation_Stage SHALL place them in the same Candidate Cluster.
3. THE Reconciliation_Stage SHALL produce Candidate Clusters that partition the input Candidate Memories (every candidate belongs to exactly one cluster).
4. WHERE a Candidate Memory has a null embedding, THE Reconciliation_Stage SHALL place it in a singleton cluster containing only itself.
5. THE Reconciliation_Stage SHALL expose the Intra-batch Similarity Threshold as a configuration value with a default of 0.85.
6. THE Reconciliation_Stage SHALL derive a representative embedding for each multi-member Candidate Cluster by computing the arithmetic mean of its members' embeddings and then L2-normalizing the result.

### Requirement 5: Neighbor Lookup

**User Story:** As a user of kiro-learn, I want new candidates to be compared against existing records in the graph, so that the same fact learned across multiple sessions collapses into a single node over time.

#### Acceptance Criteria

1. FOR EACH Candidate Cluster whose representative embedding is non-null, THE Reconciliation_Stage SHALL query the per-namespace vector index for existing `memory_records` whose cosine similarity to the representative embedding meets or exceeds the Neighbor Similarity Threshold.
2. THE Reconciliation_Stage SHALL restrict the neighbor query to the same `namespace` as the Candidate Cluster's members.
3. THE Reconciliation_Stage SHALL cap the Neighbor Pool at a configurable maximum size (default 10) and SHALL select the top-scoring neighbors by cosine similarity when the cap is reached.
4. THE Reconciliation_Stage SHALL expose the Neighbor Similarity Threshold as a configuration value with a default of 0.80.
5. IF the per-namespace vector index is empty or the representative embedding is null, THEN THE Reconciliation_Stage SHALL treat the Neighbor Pool as empty and skip the Judge Model invocation for that Candidate Cluster.

### Requirement 6: Judge Model Invocation

**User Story:** As a user of kiro-learn, I want a lightweight LLM to make the final same-or-different call across the candidate and its neighbors, so that semantic similarity alone doesn't collapse distinct facts.

#### Acceptance Criteria

1. WHEN a Candidate Cluster has a Neighbor Pool of at least one existing record, THE Reconciliation_Stage SHALL invoke the Judge Model via an ACP session using the `kiro-learn-reconciler` agent name.
2. THE Reconciliation_Stage SHALL frame the Judge prompt as XML containing the Candidate Cluster's merged content and each Neighbor Pool member's `record_id`, `title`, `summary`, and `facts`, using escaping rules consistent with the existing `xml-framer` module.
3. THE Reconciliation_Stage SHALL instruct the Judge Model to return either a `<merge>` block listing the `record_id`s that describe the same underlying thing together with a new `<title>`, `<summary>`, `<facts>`, `<concepts>`, and `<files_touched>` summary, OR a `<keep_separate/>` signal.
4. WHEN the Judge Model returns a `<merge>` block, THE Reconciliation_Stage SHALL delete every `record_id` listed in that block from `memory_records` (along with its embedding row and its FTS5 entry) and SHALL insert a newly created Summary Record built from the Judge's returned fields — all within a single transaction.
5. WHEN the Judge Model returns `<keep_separate/>` or an empty response, THE Reconciliation_Stage SHALL commit each Candidate Cluster's members as new `memory_records` and SHALL NOT delete any Neighbor Pool member.
6. THE Reconciliation_Stage SHALL enforce a per-judge-call timeout with a default of 30 seconds.
7. IF the Judge Model returns non-XML output after the retry budget in Requirement 12.2 is exhausted, THEN THE Reconciliation_Stage SHALL fall back to the keep-separate behavior of Acceptance Criterion 5 for that Candidate Cluster.
8. THE Reconciliation_Stage SHALL create a fresh ACP session for every Judge Model invocation and SHALL destroy that session before returning from the call, matching the single-use pattern used by the Extraction and Compaction workers.

### Requirement 7: Summary Record Creation

**User Story:** As a user of kiro-learn, I want merged memories to appear as a single, cleanly-titled record, so that the graph reflects what I actually know rather than every time I learned it.

#### Acceptance Criteria

1. WHEN the Judge Model returns a `<merge>` block, THE Reconciliation_Stage SHALL create exactly one Summary Record per merge decision.
2. THE Summary_Record SHALL have a fresh `record_id` of the form `mr_` followed by a ULID and a `strategy` value of `llm-reconciled`.
3. THE Summary_Record SHALL set `source_event_ids` to the union of every Candidate Memory's `source_event_ids` and every merged `memory_record`'s `source_event_ids`, deduplicated while preserving first-seen order.
4. THE Summary_Record SHALL use the `namespace` shared by its Candidate Cluster and its merged Neighbor Pool members.
5. THE Reconciliation_Stage SHALL embed the Summary Record using the Embedder and write the resulting vector via `StorageBackend.putEmbedding` in the same transaction, or logical unit of work, as the `putMemoryRecord` call.
6. THE Summary_Record SHALL set its `observation_type` to the value returned by the Judge Model, or fall back to the `observation_type` of the highest-similarity member of the merged set when the Judge omits it.
7. THE Summary_Record SHALL set `created_at` to the current wall-clock time at commit.

### Requirement 8: Commit Atomicity Per Cluster

**User Story:** As an operator, I want a failure mid-reconciliation not to leave the graph in a half-merged state, so that I can safely retry ingestion.

#### Acceptance Criteria

1. THE Reconciliation_Stage SHALL commit all writes for a single Candidate Cluster (Summary Record insertion, merged-record deletion, FTS5 cleanup, embedding cleanup, and any new `memory_record` writes) within one `StorageBackend` transaction.
2. IF a transaction for one Candidate Cluster fails, THEN THE Reconciliation_Stage SHALL abort only that cluster's writes and SHALL continue processing remaining Candidate Clusters.
3. WHEN a cluster commit fails, THE Reconciliation_Stage SHALL log the failure with the cluster's representative `record_id`s and SHALL treat the cluster as uncommitted for the purposes of the buffer-clear check in Requirement 1.4.
4. WHEN every Candidate Cluster for a buffer snapshot has been processed (committed or deliberately dropped), THE Ingestion_Pipeline SHALL clear the buffer exactly once.

### Requirement 9: Merge Deletion

**User Story:** As a user searching memories, I want merged-away records to disappear so that I see the current understanding rather than a history of near-duplicates.

#### Acceptance Criteria

1. WHEN the Reconciliation_Stage completes a merge decision, THE Storage_Backend SHALL delete every merged `memory_record` row inside the same transaction as the Summary Record insertion.
2. WHEN a `memory_record` row is deleted, THE Storage_Backend SHALL delete the row's embedding from the `embeddings` table inside the same transaction.
3. WHEN a `memory_record` row is deleted, THE Storage_Backend SHALL delete the row's FTS5 entry from `memory_records_fts` inside the same transaction, either via `ON DELETE` trigger or explicit `DELETE` statement consistent with the table's existing FTS5 integration pattern.
4. THE Storage_Backend SHALL expose a `deleteMemoryRecord(recordIds: readonly string[]): Promise<void>` method on both the `StorageBackend` interface and the `StorageTransaction` handle, and a `DELETE FROM memory_records WHERE record_id IN (…)` statement that drives it.
5. IF a requested delete includes a `record_id` that does not exist in `memory_records`, THEN THE Storage_Backend SHALL treat that id as a no-op and SHALL NOT raise (supports idempotent retries).

### Requirement 10: Configuration Surface

**User Story:** As an operator, I want to tune reconciliation thresholds and toggles without code changes, so that I can respond to model-behavior drift.

#### Acceptance Criteria

1. THE Collector_Config SHALL expose a boolean `reconciliationEnabled` flag with a default of `true`.
2. THE Collector_Config SHALL expose a number `bufferIdleFlushMs` field with a default of 30000 and a validated range of 5000 to 300000.
3. THE Collector_Config SHALL expose a number `intraBatchSimilarityThreshold` field with a default of 0.85 and a validated range of 0.0 to 1.0.
4. THE Collector_Config SHALL expose a number `neighborSimilarityThreshold` field with a default of 0.80 and a validated range of 0.0 to 1.0.
5. THE Collector_Config SHALL expose a number `neighborPoolMaxSize` field with a default of 10 and a validated range of 1 to 100.
6. THE Collector_Config SHALL expose a number `judgeModelTimeoutMs` field with a default of 30000 and a validated range of 5000 to 300000.
7. IF any reconciliation configuration value is outside its validated range, THEN THE Collector SHALL refuse to start and SHALL write a descriptive error to stderr.

### Requirement 11: Metrics and Observability

**User Story:** As an operator, I want visible counters for reconciliation decisions, so that I can judge whether thresholds are calibrated and whether duplicates are actually being collapsed.

#### Acceptance Criteria

1. THE Reconciliation_Stage SHALL emit a structured log line per ingestion-pipeline run containing the project id, the number of Candidate Memories, the number of Candidate Clusters, the count of clusters that invoked the Judge Model, the count of merge decisions, the count of keep-separate decisions, the number of Summary Records committed, and the number of records deleted.
2. THE Reconciliation_Stage SHALL report its latency broken into extraction, intra-batch clustering, neighbor lookup, judge invocation, and commit phases.
3. THE Viewer_UI SHALL continue to function without modification against the read behavior defined in Requirement 13.2.
4. WHERE a reconciliation debug flag is enabled, THE Reconciliation_Stage SHALL additionally log, per Candidate Cluster, the `record_id`s of the cluster members, the `record_id`s of each Neighbor Pool member with their cosine scores, and the raw Judge Model XML response.

### Requirement 12: Judge Model Reliability

**User Story:** As an operator, I want reconciliation to degrade gracefully when the Judge Model is slow or broken, so that a bad deployment doesn't block memory ingestion.

#### Acceptance Criteria

1. WHEN the Judge Model exceeds its timeout (Requirement 6.6), THE Reconciliation_Stage SHALL kill the ACP session and record a failure against that project's reconciliation circuit breaker.
2. WHEN the Judge Model returns a non-XML response, THE Reconciliation_Stage SHALL retry the Judge invocation with a fresh ACP session, up to a maximum of 2 attempts total per Candidate Cluster.
3. WHEN the reconciliation circuit breaker for a project has recorded 3 consecutive Judge Model failures, THE Reconciliation_Stage SHALL switch that project to direct-commit mode (the Requirement 1.6 fallback) until one subsequent ingestion-pipeline run completes without a Judge Model failure.
4. WHEN a project's reconciliation circuit breaker is tripped, THE Ingestion_Pipeline SHALL continue to run the Extraction Stage normally and SHALL continue to clear the buffer on success.

### Requirement 13: Backward Compatibility

**User Story:** As an existing user, I want my installed graph to keep working after the reconciliation upgrade, so that I don't lose memories and don't need a migration dance.

#### Acceptance Criteria

1. THE Storage_Backend SHALL require no schema migration for pre-existing `memory_records` rows — the new `deleteMemoryRecord` method operates on the existing schema unchanged.
2. THE Retrieval_Subsystem SHALL return identical results for any search query that does not encounter a merged record, compared to the pre-reconciliation behavior.
3. THE MCP_Server SHALL continue to return the same `MemoryRecord` shape from `search_memory` as it did prior to the reconciliation rollout, with no new fields.
4. THE Ingestion_Pipeline SHALL leave rows created before the reconciliation feature rolled out untouched unless those rows appear as Neighbor Pool members and are explicitly merged away by a Judge Model merge decision.

### Requirement 14: Documentation

**User Story:** As a developer reading the public docs, I want the ingestion pipeline documented end-to-end, so that the two-stage design and its thresholds are discoverable.

#### Acceptance Criteria

1. THE Documentation SHALL include a new `docs/architecture/ingestion.mdx` page describing the Extraction and Reconciliation stages, the candidate-to-summary flow, and the merge-deletion model.
2. THE Documentation SHALL update `docs/architecture/extraction.mdx` to reflect that extraction emits Candidate Memories consumed by the Reconciliation Stage instead of writing records directly.
3. THE Documentation SHALL update `docs/architecture/compaction.mdx` to reflect the new 30-second idle-flush default and any wording that currently references a 5-second cadence.
4. THE Documentation SHALL update `docs/architecture/database.mdx` to describe the `deleteMemoryRecord` method, the cascade-delete of embeddings and FTS5 entries, and the fact that reconciliation merges are destructive (no undo).
5. THE Documentation SHALL update `docs/concepts/event-buffer.mdx` to describe the renamed ingestion-pipeline trigger and the revised default flush interval.
