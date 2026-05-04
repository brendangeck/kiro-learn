/**
 * ExtractionWorker — a thin shim over the {@link IngestionPipeline}.
 *
 * Historically this module owned the full buffer-to-memory-record
 * extraction flow: snapshot the buffer, frame batch XML, drive the
 * compressor via ACP, parse the response, and write memory records +
 * embeddings to storage.
 *
 * As of the reconciliation-engine spec the Ingestion Pipeline owns
 * that flow end-to-end (extraction stage → reconciliation stage, with
 * a direct-commit fallback when the feature flag is off or the
 * circuit breaker is open — design § `IngestionPipeline`). The
 * `ExtractionWorker` lives on only as a compatibility wrapper the
 * {@link BufferWatcher.onExtraction} handler calls. It maps the new
 * {@link IngestionResult} shape into the legacy {@link ExtractionResult}
 * shape that downstream callers (receiver stats, compaction worker
 * metrics, integration tests) still consume.
 *
 * Keeping this seam — rather than updating every call site to take
 * {@link IngestionPipeline} directly — preserves:
 *
 * - The public `BufferWatcher.onExtraction((pid) =>
 *   extractionWorker.extract(pid).catch(...))` wiring in
 *   `src/collector/index.ts`.
 * - The `ExtractionResult.memoriesCreated` field downstream callers
 *   read. That field is now the SUM of summary-record commits,
 *   keep-separate commits, and direct-commit commits produced by the
 *   pipeline — the total number of `memory_record` rows the run
 *   wrote, which is the number the legacy field semantically meant.
 *
 * The `active` getter and `drain(timeoutMs)` method simply forward to
 * the pipeline's matching surface.
 *
 * @see .kiro/specs/reconciliation-engine/design.md § Components and
 *   Interfaces — `src/collector/buffer/extraction.ts` — thin wrapper
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 1.1, 1.5
 * @module
 */

import type { IngestionPipeline } from '../ingestion/index.js';
import type { BufferWatcher } from './watcher.js';

// ── Public types ────────────────────────────────────────────────────────

/**
 * Legacy extraction result shape consumed by the
 * `BufferWatcher.onExtraction` error handler and receiver-side stats
 * readouts.
 *
 * `memoriesCreated` is the TOTAL number of `memory_record` rows the
 * run committed — across summary records (merge decisions),
 * keep-separate commits (including the empty-neighbor fast path), and
 * direct-commit commits (feature-flag-off or circuit-breaker-open
 * runs). The split is available on the underlying
 * {@link IngestionResult}; the legacy shape deliberately collapses it
 * to preserve backward compatibility.
 */
export interface ExtractionResult {
  projectId: string;
  eventsProcessed: number;
  memoriesCreated: number;
  durationMs: number;
}

/**
 * Dependencies for the thin-shim {@link createExtractionWorker} factory.
 *
 * The refactored worker holds no storage / embedder / query / buffer-
 * store state of its own — the {@link IngestionPipeline} owns
 * everything. We still carry a `watcher` reference for symmetry with
 * the legacy API: callers of this file used to pass `watcher` and the
 * type exports are wired through the `src/collector/buffer/index.ts`
 * barrel, so dropping the field would be a breaking public-surface
 * change for no benefit. It is unused inside the worker body.
 */
export interface ExtractionWorkerDeps {
  pipeline: IngestionPipeline;
  watcher: BufferWatcher;
}

/**
 * Public surface of {@link createExtractionWorker}. Shape is unchanged
 * from the pre-reconciliation worker — the refactor is strictly
 * internal.
 */
export interface ExtractionWorker {
  extract(projectId: string): Promise<ExtractionResult>;
  drain(timeoutMs: number): Promise<void>;
  readonly active: number;
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create an {@link ExtractionWorker} that forwards every call to the
 * supplied {@link IngestionPipeline}.
 *
 * This is not a functional wrapper — it adds no behaviour, no
 * metrics, no retries. The only non-trivial step is the
 * {@link IngestionResult} → {@link ExtractionResult} projection, which
 * collapses the three commit counters into the legacy
 * `memoriesCreated` total.
 *
 * @param deps - Injected {@link IngestionPipeline} reference. The
 *   `watcher` field is part of the legacy deps surface and is
 *   ignored.
 */
export function createExtractionWorker(deps: ExtractionWorkerDeps): ExtractionWorker {
  const { pipeline } = deps;

  return {
    /**
     * The pipeline owns the semaphore — the shim just reads it so
     * tests and receiver stats see the same in-flight count they
     * would observe by reading `pipeline.active` directly.
     */
    get active(): number {
      return pipeline.active;
    },

    async extract(projectId: string): Promise<ExtractionResult> {
      const result = await pipeline.run(projectId);
      return {
        projectId,
        eventsProcessed: result.eventsProcessed,
        memoriesCreated:
          result.summaryRecordsCommitted +
          result.keepSeparateCommitted +
          result.directCommittedRecords,
        durationMs: result.durationMs,
      };
    },

    /**
     * Forwarded verbatim. The pipeline's `drain` awaits every in-
     * flight `run(...)` or resolves when `timeoutMs` expires,
     * matching the contract the legacy worker offered.
     */
    drain(timeoutMs: number): Promise<void> {
      return pipeline.drain(timeoutMs);
    },
  };
}
