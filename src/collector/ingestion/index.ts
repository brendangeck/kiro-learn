/**
 * Ingestion / Pipeline — the top-level orchestrator for the Ingestion
 * Pipeline.
 *
 * The `IngestionPipeline` owns the full buffer-to-memory-record flow:
 *
 *   1. Acquire a semaphore slot (reuses today's `ExtractionWorker`
 *      concurrency pattern — default concurrency 2).
 *   2. Read the buffer snapshot via `BufferStore.snapshot(projectId)`.
 *   3. Call `extractCandidates(...)` (Extraction Stage). On throw, leave
 *      the buffer intact and notify the watcher with `success=false`;
 *      the reconciliation circuit breaker is NOT incremented (it is
 *      strictly judge-scoped per Requirement 12.1).
 *   4. Zero-candidate fast path → clear buffer, notify success.
 *   5. Direct-commit fallback when `reconciliationEnabled === false`
 *      OR the reconciliation circuit breaker is open (Requirement 1.6,
 *      12.3): write every candidate to storage with the same
 *      `putMemoryRecord` + `putEmbedding` + `invalidateNamespace`
 *      sequence the legacy `ExtractionWorker` used. Property 4
 *      (`ingestion-feature-flag-equivalence.property.test.ts`) pins the
 *      byte-for-byte equivalence.
 *   6. Full reconciliation via `reconcile(...)` otherwise. Buffer is
 *      cleared when at least one cluster reached a terminal state
 *      (committed or deliberately dropped); if every cluster failed,
 *      the buffer is retained and the watcher is notified
 *      `success=false` so the outer extraction circuit breaker can see
 *      the failure.
 *   7. `circuitBreaker.onRunComplete(projectId, anyJudgeFailure)` on
 *      every clean return — including the direct-commit path (which
 *      has `anyJudgeFailure === false` trivially, self-healing a
 *      tripped breaker per Requirement 12.3).
 *   8. Emit one structured `ingestion-pipeline-run` JSON-line to
 *      stderr with the per-run observability payload (Requirement 11.1
 *      — Task 14.1's log emission lives here, at its natural emission
 *      site).
 *
 * ## Modularity
 *
 * This module lives at `src/collector/ingestion/` and MUST NOT import
 * from `src/collector/storage/sqlite/`. Allowed imports:
 *
 * - `src/types/` — for `CandidateMemory`, `MemoryRecord`, `StorageBackend`.
 * - `src/collector/buffer/` — for `BufferStore` and `BufferWatcher`
 *   interface types.
 * - `src/collector/embedding/` — for the `Embedder` type.
 * - `src/collector/query/` — for the `QueryLayer` type.
 * - `./candidate.js`, `./reconciler.js`, `./circuit-breaker.js`.
 *
 * The guard test `test/unit/no-sqlite-in-ingestion.test.ts` (task 16.1)
 * pins the invariant.
 *
 * @see .kiro/specs/reconciliation-engine/design.md § `index.ts` — `IngestionPipeline`
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 1.1–1.6, 8.4, 11.1, 12.3, 12.4
 * @module
 */

import type { CandidateMemory, StorageBackend } from '../../types/index.js';
import type { BufferStore } from '../buffer/store.js';
import type { BufferWatcher } from '../buffer/watcher.js';
import type { Embedder } from '../embedding/index.js';
import type { QueryLayer } from '../query/index.js';

import { extractCandidates, toMemoryRecord } from './candidate.js';
import type { ReconciliationCircuitBreaker } from './circuit-breaker.js';
import { reconcile } from './reconciler.js';
import type { ReconciliationContext, ReconciliationOutcome } from './reconciler.js';

// ── Public types ────────────────────────────────────────────────────────

/**
 * Configuration for the {@link IngestionPipeline}. Sourced from the
 * collector's top-level `CollectorConfig` at wiring time (Task 13).
 *
 * Defaults match Requirements 4.5, 5.3, 5.4, 6.6, 10.1, 10.3, 10.4,
 * 10.5, 10.6. The owner of this object (the collector wiring in
 * `src/collector/index.ts`) is responsible for validating each field
 * before passing it through — see `validateCollectorConfig` (Task
 * 13.4).
 */
export interface IngestionPipelineConfig {
  /** Feature flag. When false, every run uses the direct-commit fallback. Default `true`. */
  reconciliationEnabled: boolean;
  /** Cosine floor for intra-batch clustering. Default `0.85`. */
  intraBatchSimilarityThreshold: number;
  /** Cosine floor for neighbor lookup. Default `0.80`. */
  neighborSimilarityThreshold: number;
  /** Max neighbor pool per cluster. Default `10`. */
  neighborPoolMaxSize: number;
  /** Per-judge-call timeout in milliseconds. Default `30_000`. */
  judgeModelTimeoutMs: number;
  /** Concurrency slots across ingestion runs. Default `2`. */
  extractionConcurrency: number;
  /** Per-extraction timeout in milliseconds. Default `60_000`. */
  extractionTimeoutMs: number;
  /** Max retry attempts for transient extraction failures. Default `3`. */
  extractionMaxRetries: number;
  /** When true, emit per-cluster debug detail on stderr (Requirement 11.4). Default `false`. */
  debug: boolean;
}

/**
 * Dependencies injected into {@link createIngestionPipeline}.
 *
 * - `bufferStore` / `watcher` — the per-project buffer seam the
 *   extraction trigger flows through.
 * - `storage` — concrete `StorageBackend` used for both the direct-
 *   commit fallback and the reconciler's transactional merge path.
 * - `embedder` — nullable. When `null` or not ready, candidates emit
 *   with `embedding: null`; the reconciler treats those as singleton
 *   clusters with no judge invocation.
 * - `query` — used for `invalidateNamespace` (and, inside `reconcile`,
 *   for `lookupNeighbors`).
 * - `circuitBreaker` — per-project judge circuit breaker. Owned by
 *   the collector wiring and lives for the daemon process lifetime.
 * - `config` — the full {@link IngestionPipelineConfig}.
 */
export interface IngestionPipelineDeps {
  bufferStore: BufferStore;
  watcher: BufferWatcher;
  storage: StorageBackend;
  embedder: Embedder | null;
  query: QueryLayer;
  circuitBreaker: ReconciliationCircuitBreaker;
  config: IngestionPipelineConfig;
}

/**
 * Per-run result returned from {@link IngestionPipeline.run}. Used by
 * the thin-shim `ExtractionWorker` wrapper (Task 13.1) to build the
 * legacy `ExtractionResult` shape that downstream callers consume.
 */
export interface IngestionResult {
  projectId: string;
  eventsProcessed: number;
  candidatesProduced: number;
  clustersFormed: number;
  judgeInvocations: number;
  mergeDecisions: number;
  keepSeparateDecisions: number;
  summaryRecordsCommitted: number;
  /**
   * Count of individual cluster members committed on keep-separate
   * paths (empty-neighbor, null-centroid, judge `<keep_separate/>`, and
   * judge-fallback). One `memory_record` write per committed member.
   *
   * Tracked separately from {@link summaryRecordsCommitted} because the
   * legacy {@link ExtractionResult.memoriesCreated} field sums all
   * three commit streams (summary + keep-separate + direct-commit).
   * Downstream shim callers need the split to compute that sum without
   * reaching into the reconciliation outcome.
   */
  keepSeparateCommitted: number;
  recordsDeleted: number;
  directCommittedRecords: number;
  durationMs: number;
  phaseLatencyMs: {
    extraction: number;
    clustering: number;
    neighborLookup: number;
    judge: number;
    commit: number;
  };
}

/**
 * Public surface of the {@link createIngestionPipeline} factory.
 * Mirrors the concurrency primitives today's `ExtractionWorker`
 * exposes (`active`, `drain`) so the thin-shim wrapper can forward
 * them without adapter logic.
 */
export interface IngestionPipeline {
  run(projectId: string): Promise<IngestionResult>;
  drain(timeoutMs: number): Promise<void>;
  readonly active: number;
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Zeroed phase-latency object. Lives as a factory (rather than a
 * const) because each run mutates its copy in place.
 */
function emptyPhaseLatency(): IngestionResult['phaseLatencyMs'] {
  return {
    extraction: 0,
    clustering: 0,
    neighborLookup: 0,
    judge: 0,
    commit: 0,
  };
}

/**
 * Compute the ingestion-run log payload. Pulled out of `run(...)` so
 * every exit path emits an identically-shaped line and the fields
 * stay in lockstep with {@link IngestionResult}.
 *
 * `clusters_formed` is sourced from the reconciliation outcome when
 * one exists; the direct-commit and extraction-failure paths emit
 * `clusters_formed: 0` because no clustering step ran. The total is
 * `mergeDecisions + keepSeparateDecisions + clustersFailed`, which
 * undercounts null-centroid keep-separate clusters (they bump
 * `keepSeparateCommitted` without a decision counter). Acceptable
 * for v1 observability — the direct measurement belongs in a future
 * outcome counter.
 *
 * @see Requirement 11.1
 */
function buildLogLine(args: {
  result: IngestionResult;
  namespace: string;
  circuitBreakerOpen: boolean;
  reconciliationEnabled: boolean;
}): string {
  const payload = {
    event: 'ingestion-pipeline-run',
    project_id: args.result.projectId,
    namespace: args.namespace,
    events_processed: args.result.eventsProcessed,
    candidates_produced: args.result.candidatesProduced,
    clusters_formed: args.result.clustersFormed,
    judge_invocations: args.result.judgeInvocations,
    merge_decisions: args.result.mergeDecisions,
    keep_separate_decisions: args.result.keepSeparateDecisions,
    summary_records_committed: args.result.summaryRecordsCommitted,
    records_deleted: args.result.recordsDeleted,
    direct_committed_records: args.result.directCommittedRecords,
    circuit_breaker_open: args.circuitBreakerOpen,
    reconciliation_enabled: args.reconciliationEnabled,
    duration_ms: args.result.durationMs,
    phase_latency_ms: {
      extraction: args.result.phaseLatencyMs.extraction,
      clustering: args.result.phaseLatencyMs.clustering,
      neighbor_lookup: args.result.phaseLatencyMs.neighborLookup,
      judge: args.result.phaseLatencyMs.judge,
      commit: args.result.phaseLatencyMs.commit,
    },
  };
  return JSON.stringify(payload) + '\n';
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Create an {@link IngestionPipeline} with semaphore-based concurrency
 * control mirroring today's `ExtractionWorker` (default 2 slots).
 *
 * Every `run(projectId)` call drives the full extract-then-reconcile
 * flow. `drain(timeoutMs)` waits for every in-flight run to settle or
 * until the timeout expires.
 */
export function createIngestionPipeline(deps: IngestionPipelineDeps): IngestionPipeline {
  const { bufferStore, watcher, storage, embedder, query, circuitBreaker, config } = deps;

  // ── Semaphore state (identical pattern to
  //    `src/collector/buffer/extraction.ts`). ─────────────────────────
  let activeCount = 0;
  const waitQueue: Array<() => void> = [];
  const inFlight = new Set<Promise<IngestionResult>>();

  /**
   * Acquire a semaphore slot. Resolves immediately if a slot is
   * available, otherwise queues the caller until a slot is released.
   */
  function acquireSemaphore(): Promise<void> {
    if (activeCount < config.extractionConcurrency) {
      activeCount += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waitQueue.push(resolve);
    });
  }

  /**
   * Release a semaphore slot. If callers are waiting, the next one is
   * unblocked immediately (active count stays the same).
   */
  function releaseSemaphore(): void {
    const next = waitQueue.shift();
    if (next !== undefined) {
      next();
    } else {
      activeCount -= 1;
    }
  }

  /**
   * Inner run body — the actual orchestration. The outer `run` wraps
   * this to manage the `inFlight` bookkeeping and the returned
   * promise.
   */
  async function doRun(projectId: string): Promise<IngestionResult> {
    const startTime = Date.now();
    const phaseLatencyMs = emptyPhaseLatency();
    const result: IngestionResult = {
      projectId,
      eventsProcessed: 0,
      candidatesProduced: 0,
      clustersFormed: 0,
      judgeInvocations: 0,
      mergeDecisions: 0,
      keepSeparateDecisions: 0,
      summaryRecordsCommitted: 0,
      keepSeparateCommitted: 0,
      recordsDeleted: 0,
      directCommittedRecords: 0,
      durationMs: 0,
      phaseLatencyMs,
    };
    let namespace = '';
    const reconciliationEnabledForRun = config.reconciliationEnabled;
    let circuitBreakerOpenAtStart = false;
    let emittedLog = false;

    /**
     * Emit the structured log line. Idempotent — repeated calls in
     * a single run are a no-op. Extraction-failure paths skip the
     * log entirely per the design note (Task 14.1 owns that line;
     * here we emit only the "ran to completion" cases).
     */
    const emitLog = (): void => {
      if (emittedLog) return;
      emittedLog = true;
      const wallTime = Date.now() - startTime;
      // `duration_ms` must be ≥ sum of phase latencies per the
      // design note — bookkeeping overhead lives in the
      // difference. In production the wall-clock time always
      // dominates because each phase is wrapped in its own
      // timer; in tests with mocked reconcile outcomes the
      // injected phase latencies can exceed the real wall time,
      // so we clamp up defensively.
      const phaseSum =
        phaseLatencyMs.extraction +
        phaseLatencyMs.clustering +
        phaseLatencyMs.neighborLookup +
        phaseLatencyMs.judge +
        phaseLatencyMs.commit;
      result.durationMs = wallTime >= phaseSum ? wallTime : phaseSum;
      try {
        process.stderr.write(
          buildLogLine({
            result,
            namespace,
            circuitBreakerOpen: circuitBreakerOpenAtStart,
            reconciliationEnabled: reconciliationEnabledForRun,
          }),
        );
      } catch {
        // Never let a logging failure abort the run. This is
        // defensive — `process.stderr.write` can fail in
        // pathological environments (EPIPE during teardown).
      }
    };

    await acquireSemaphore();
    try {
      // ── Step 1: snapshot ───────────────────────────────────────
      const entries = await bufferStore.snapshot(projectId);
      if (entries.length === 0) {
        await bufferStore.clear(projectId);
        watcher.notifyExtractionResult(projectId, true);
        // A trivially-empty run counts as "no judge failure" and
        // closes a tripped breaker (Requirement 12.3).
        circuitBreaker.onRunComplete(projectId, false);
        emitLog();
        return result;
      }
      result.eventsProcessed = entries.length;
      // Every buffer entry shares the same namespace (buffers are
      // per-project). The `firstEntry` guard satisfies
      // `noUncheckedIndexedAccess`.
      const firstEntry = entries[0];
      if (firstEntry === undefined) {
        await bufferStore.clear(projectId);
        watcher.notifyExtractionResult(projectId, true);
        circuitBreaker.onRunComplete(projectId, false);
        emitLog();
        return result;
      }
      namespace = firstEntry.namespace;

      // Decide on the fallback condition BEFORE running extraction —
      // this is the observed value that flows into the log. We
      // recompute `isOpen(projectId)` only once here; the breaker
      // state can shift during the run (via
      // `circuitBreaker.record(...)` inside `reconcile`), but the
      // log carries the start-of-run snapshot so operators can
      // correlate "the breaker was open so we took the direct-
      // commit path" reliably.
      circuitBreakerOpenAtStart = circuitBreaker.isOpen(projectId);

      // ── Step 2: extraction ─────────────────────────────────────
      const extractStart = Date.now();
      let candidates: CandidateMemory[];
      try {
        candidates = await extractCandidates(
          entries,
          {
            timeoutMs: config.extractionTimeoutMs,
            maxRetries: config.extractionMaxRetries,
          },
          { storage, embedder },
        );
      } catch (err: unknown) {
        phaseLatencyMs.extraction = Date.now() - extractStart;
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[kiro-learn] ingestion pipeline extraction failed for project ${projectId}: ${message}\n`,
        );
        // Buffer retained; watcher notified `false` so the outer
        // extraction circuit breaker can count the failure. The
        // reconciliation circuit breaker is NOT touched — it is
        // judge-scoped per Requirement 12.1.
        watcher.notifyExtractionResult(projectId, false);
        // Do NOT call `circuitBreaker.onRunComplete` on an
        // extraction failure — the run did not "complete" in the
        // reconciliation sense and we must preserve any mid-run
        // judge-failure state the breaker might hold from a
        // previous partial run.
        //
        // Match today's legacy `ExtractionWorker.extract`
        // contract: a failed run returns zeroed-out counters so
        // downstream aggregators (e.g. the thin-shim wrapper that
        // maps `IngestionResult → ExtractionResult`) don't
        // double-count events that never made it through.
        result.eventsProcessed = 0;
        result.candidatesProduced = 0;
        emitLog();
        return result;
      }
      phaseLatencyMs.extraction = Date.now() - extractStart;
      result.candidatesProduced = candidates.length;

      // ── Step 3: zero-candidate fast path ───────────────────────
      if (candidates.length === 0) {
        await bufferStore.clear(projectId);
        watcher.notifyExtractionResult(projectId, true);
        circuitBreaker.onRunComplete(projectId, false);
        emitLog();
        return result;
      }

      // ── Step 4: direct-commit fallback ─────────────────────────
      // Trigger: feature flag off OR circuit breaker open at start.
      // This path MUST mirror the legacy `ExtractionWorker` write
      // sequence byte-for-byte (Property 4, task 11.1):
      //   for each candidate:
      //     storage.putMemoryRecord(record)
      //     if embedding !== null: storage.putEmbedding(id, vec)
      //     query.invalidateNamespace(namespace)
      //
      // The double-invalidate the legacy worker did (once after the
      // record, once after the embed) is intentionally reproduced
      // here because P4 compares call sequences literally.
      if (!reconciliationEnabledForRun || circuitBreakerOpenAtStart) {
        const commitStart = Date.now();
        for (const candidate of candidates) {
          const record = toMemoryRecord(candidate);
          await storage.putMemoryRecord(record);
          query.invalidateNamespace(namespace);
          if (candidate.embedding !== null) {
            await storage.putEmbedding(record.record_id, candidate.embedding);
            query.invalidateNamespace(namespace);
          }
          result.directCommittedRecords += 1;
        }
        phaseLatencyMs.commit = Date.now() - commitStart;
        await bufferStore.clear(projectId);
        watcher.notifyExtractionResult(projectId, true);
        // Direct-commit path is trivially "no judge failure" —
        // closes a tripped breaker per Requirement 12.3.
        circuitBreaker.onRunComplete(projectId, false);
        emitLog();
        return result;
      }

      // ── Step 5: full reconciliation ────────────────────────────
      const ctx: ReconciliationContext = {
        storage,
        query,
        embedder,
        config: {
          intraBatchSimilarityThreshold: config.intraBatchSimilarityThreshold,
          neighborSimilarityThreshold: config.neighborSimilarityThreshold,
          neighborPoolMaxSize: config.neighborPoolMaxSize,
          judgeModelTimeoutMs: config.judgeModelTimeoutMs,
          debug: config.debug,
        },
        circuitBreaker,
        projectId,
        namespace,
      };

      const outcome: ReconciliationOutcome = await reconcile(candidates, ctx);
      // Fold outcome into the result + phase latencies.
      result.judgeInvocations = outcome.judgeInvocations;
      result.mergeDecisions = outcome.mergeDecisions;
      result.keepSeparateDecisions = outcome.keepSeparateDecisions;
      result.summaryRecordsCommitted = outcome.summaryRecordsCommitted;
      result.keepSeparateCommitted = outcome.keepSeparateCommitted;
      result.recordsDeleted = outcome.recordsDeleted;
      // `clusters_formed` reflects clusters that reached either a
      // decision or a failure. Null-centroid keep-separate commits
      // are not represented in the outcome's decision counters;
      // they bump `keepSeparateCommitted` alone. This is
      // documented in the log field's TSDoc — callers that need
      // an exact count should add a dedicated outcome counter in
      // a future iteration.
      result.clustersFormed =
        outcome.mergeDecisions + outcome.keepSeparateDecisions + outcome.clustersFailed;
      phaseLatencyMs.clustering = outcome.phaseLatencyMs.clustering;
      phaseLatencyMs.neighborLookup = outcome.phaseLatencyMs.neighborLookup;
      phaseLatencyMs.judge = outcome.phaseLatencyMs.judge;
      phaseLatencyMs.commit = outcome.phaseLatencyMs.commit;

      // ── Step 6: buffer clear discipline ────────────────────────
      // Per design § 8.4: "When every Candidate Cluster for a
      // buffer snapshot has been processed (committed or
      // deliberately dropped), THE Ingestion_Pipeline SHALL clear
      // the buffer exactly once."
      //
      // A cluster "reaches a terminal state" when it commits
      // something (summary OR keep-separate members) — this
      // includes the null-centroid / empty-neighbor paths that
      // bump `keepSeparateCommitted` without a decision counter.
      // Pure-failure runs (every cluster's commit threw) do NOT
      // clear the buffer; retry on the next idle flush.
      const anyCommitted =
        outcome.summaryRecordsCommitted > 0 || outcome.keepSeparateCommitted > 0;
      const allClustersFailed = outcome.clustersFailed > 0 && !anyCommitted;

      if (allClustersFailed) {
        // Leave the buffer intact; notify `false` so the outer
        // extraction circuit breaker can observe the failure.
        watcher.notifyExtractionResult(projectId, false);
        circuitBreaker.onRunComplete(projectId, outcome.anyJudgeFailure);
        emitLog();
        return result;
      }

      // Success path — at least one cluster committed. Clear the
      // buffer and close the run.
      await bufferStore.clear(projectId);
      watcher.notifyExtractionResult(projectId, true);
      circuitBreaker.onRunComplete(projectId, outcome.anyJudgeFailure);
      emitLog();
      return result;
    } finally {
      releaseSemaphore();
    }
  }

  return {
    get active(): number {
      return activeCount;
    },

    run(projectId: string): Promise<IngestionResult> {
      const promise = doRun(projectId);
      inFlight.add(promise);
      // Don't await the cleanup — the promise's settlement drives
      // the Set eviction regardless of success/failure.
      void promise.finally(() => {
        inFlight.delete(promise);
      });
      return promise;
    },

    /**
     * Wait for every in-flight run to complete or until the
     * supplied timeout expires. Never rejects — a timeout resolves
     * silently and the caller is expected to surface the
     * outstanding work elsewhere (shutdown logs).
     */
    drain(timeoutMs: number): Promise<void> {
      if (inFlight.size === 0) {
        return Promise.resolve();
      }
      const allDone = Promise.allSettled([...inFlight]).then(() => {
        /* resolved with void on settle */
      });
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      });
      return Promise.race([allDone, timeout]);
    },
  };
}
