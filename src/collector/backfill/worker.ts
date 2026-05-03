/**
 * BackfillWorker — idle-priority asynchronous loop that fills in
 * embeddings for pre-existing `memory_records` that were written
 * before the embedding feature landed (or whose on-write embed
 * failed under degraded mode).
 *
 * ## Where this sits
 *
 * The write path (`ExtractionWorker`) embeds new records
 * synchronously after each `putMemoryRecord`. The read path
 * (`QueryLayer`) tolerates records with `NULL` embedding via the
 * lexical-only fallback (Property 8). The backfill worker exists
 * to close the gap for records that were stored without an
 * embedding so hybrid search eventually covers the whole corpus.
 *
 * The worker is crash-safe by construction: every loop iteration
 * re-queries `embedding IS NULL`, so a restart picks up exactly
 * where the previous run left off. On a fully-embedded corpus the
 * first query returns empty and the loop exits cleanly
 * (Requirements 19.1, 19.2).
 *
 * ## Lifecycle
 *
 * - {@link createBackfillWorker} returns a handle that has NOT yet
 *   started. The caller (collector wiring in `src/collector/
 *   index.ts`) calls `start()` only when the embedder is ready
 *   and the feature flag allows it.
 * - `start()` kicks off an async loop and returns synchronously.
 *   It is idempotent — calling it a second time while the worker
 *   is already running is a no-op.
 * - `stop(timeoutMs)` sets a cancellation flag and awaits the
 *   in-flight batch (and any active circuit-breaker pause) to
 *   drain, bounded by `timeoutMs`. It is idempotent — calling
 *   it repeatedly returns the same "settled" promise once the
 *   worker is fully stopped.
 * - `status()` returns a fresh snapshot on every call; the fields
 *   are read live so callers never see stale values.
 *
 * ## State machine
 *
 * ```
 *   idle ──start()──▶ running ─(empty batch)──▶ idle
 *                       │
 *                       ├─(N consecutive failures)──▶ paused ──(pause done)──▶ running
 *                       │
 *                       └─stop()────────────────────▶ stopped
 * ```
 *
 * `stopped` is terminal for the lifetime of the handle. Callers
 * that want to restart backfill construct a fresh worker.
 *
 * ## Circuit breaker
 *
 * `circuitBreakerFailures` consecutive `embed` / `putEmbedding`
 * failures trip the breaker: the worker transitions to `paused`,
 * sleeps `circuitBreakerPauseMs`, resets the failure counter, and
 * resumes. A single success anywhere inside the batch resets the
 * counter. This isolates transient pipeline failures (disk full,
 * model thrash) without permanently stalling the feature.
 *
 * ## Cache invalidation
 *
 * Each successful `putEmbedding` fires the injected
 * `onNamespaceChanged` callback (see task 8.3 — explicit-callback
 * wiring). This lets the collector invalidate the per-namespace
 * vector index cache so the next hybrid search sees the freshly-
 * backfilled row. Keeping the callback explicit rather than a
 * `StorageBackend` hook preserves the one-way import boundary
 * between storage and query (Requirement 7.5; design § Cache
 * invalidation protocol).
 *
 * ## Modularity
 *
 * This module lives at `src/collector/backfill/` and MUST NOT
 * import from `src/collector/storage/sqlite/`, `src/shim/`,
 * `src/installer/`, or `src/mcp/` (Requirements 13.1–13.3).
 * Allowed imports: `src/types/` via the public storage interface
 * and the embedding barrel at `src/collector/embedding/`.
 *
 * @see Requirements 8.4, 8.5, 8.6, 19.1, 19.2, 19.3
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — `src/collector/backfill/`
 * @module
 */

import type { MemoryRecord, StorageBackend } from '../../types/index.js';
import { composeEmbeddingInput } from '../embedding/index.js';
import type { Embedder } from '../embedding/index.js';

// ── Public types ────────────────────────────────────────────────────────

/**
 * Runtime configuration accepted by {@link createBackfillWorker}.
 *
 * Every field has a sensible default; callers typically pass `{}`
 * or override a single knob (e.g. `idleMs` in tests to speed up
 * the loop).
 *
 * @see Requirements 8.4, 8.5
 */
export interface BackfillWorkerConfig {
  /**
   * How many `memory_records` to fetch per iteration of the loop.
   * Larger values amortise the SQL round-trip; smaller values
   * shrink the window in which `stop()` has to wait for drain.
   *
   * Default: 32.
   */
  batchSize: number;

  /**
   * Milliseconds to sleep between batches so backfill yields CPU
   * to the live ingestion / search paths. A non-zero value is
   * required to satisfy the "idle priority" contract (Req 8.5).
   *
   * Default: 1000.
   */
  idleMs: number;

  /**
   * Number of consecutive `embed` / `putEmbedding` failures that
   * trip the circuit breaker. One success resets the counter.
   *
   * Default: 5.
   */
  circuitBreakerFailures: number;

  /**
   * Milliseconds the worker pauses after the circuit breaker
   * trips before resuming. The pause is interruptible by
   * `stop()`.
   *
   * Default: 60_000 (1 minute).
   */
  circuitBreakerPauseMs: number;
}

/**
 * Snapshot returned by {@link BackfillWorker.status}.
 *
 * Field semantics:
 *
 * - `state`
 *   - `'idle'`     — constructed but not yet started, OR the loop
 *                    has exited after draining the backlog and is
 *                    waiting for a future `start()` call.
 *   - `'running'`  — the loop is actively processing a batch or
 *                    sleeping for the `idleMs` gap between batches.
 *   - `'paused'`   — the circuit breaker has tripped and the worker
 *                    is sleeping `circuitBreakerPauseMs` before it
 *                    resumes.
 *   - `'stopped'`  — `stop()` was called. Terminal. A stopped
 *                    worker cannot be re-started.
 * - `processed`    — monotonic count of records successfully
 *                    embedded and persisted by this worker
 *                    instance.
 * - `lastError`    — message of the most recent embed /
 *                    `putEmbedding` failure, or `null` if the most
 *                    recent attempt succeeded (or no attempts have
 *                    been made).
 */
export interface BackfillWorkerStatus {
  state: 'idle' | 'running' | 'paused' | 'stopped';
  processed: number;
  lastError: string | null;
}

/**
 * Asynchronous worker that backfills embeddings for records with
 * `embedding IS NULL`. See module docstring for lifecycle and
 * state-machine details.
 */
export interface BackfillWorker {
  /**
   * Kick off the async loop. Returns synchronously. Safe to call
   * multiple times — only the first call starts the loop; later
   * calls are no-ops while the worker is running.
   */
  start(): void;

  /**
   * Signal shutdown. Sets a cancellation flag and returns a
   * promise that resolves either
   *
   * - when the current batch finishes draining (and any active
   *   circuit-breaker pause is cut short), or
   * - when `timeoutMs` elapses, whichever happens first.
   *
   * Idempotent: calling `stop()` again after the worker has
   * stopped returns an already-resolved promise.
   */
  stop(timeoutMs: number): Promise<void>;

  /** Inspect progress for logs / stats. */
  status(): BackfillWorkerStatus;
}

/**
 * Dependencies injected into the backfill worker factory.
 */
export interface BackfillWorkerDeps {
  storage: StorageBackend;
  embedder: Embedder;
  /**
   * Optional callback invoked after every successful
   * `putEmbedding` write, passing the namespace of the affected
   * record. Used by the collector to invalidate the per-namespace
   * vector index cache so the next hybrid search sees the
   * freshest data.
   *
   * Wired as an explicit dependency (rather than a storage-layer
   * hook) to keep `StorageBackend` unaware of query-layer
   * concerns. See design § Cache invalidation protocol.
   *
   * @see Requirements 7.5
   */
  onNamespaceChanged?: (namespace: string) => void;
  config?: Partial<BackfillWorkerConfig>;
}

// ── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: BackfillWorkerConfig = {
  batchSize: 32,
  idleMs: 1000,
  circuitBreakerFailures: 5,
  circuitBreakerPauseMs: 60_000,
};

// ── Implementation ──────────────────────────────────────────────────────

/**
 * Create a {@link BackfillWorker} backed by the injected storage and
 * embedder. The returned handle has NOT started — the caller must
 * invoke `start()`. See module docstring for the lifecycle contract.
 *
 * @see Requirements 8.4, 8.5, 8.6, 19.1, 19.2, 19.3
 */
export function createBackfillWorker(deps: BackfillWorkerDeps): BackfillWorker {
  const { storage, embedder, onNamespaceChanged } = deps;
  const config: BackfillWorkerConfig = { ...DEFAULT_CONFIG, ...deps.config };

  // ── Live state (all reads in `status()` hit these directly) ────────
  let state: BackfillWorkerStatus['state'] = 'idle';
  let processed = 0;
  let lastError: string | null = null;

  // Cancellation flag flipped by `stop()`. Checked on every batch
  // boundary and between records within a batch so shutdown is
  // bounded by one record's worth of work.
  let stopped = false;

  // Promise of the currently running loop, held so `stop()` can
  // await it. `null` when the worker is idle or stopped.
  let loopPromise: Promise<void> | null = null;

  // Resolver for the active `sleep` call, if any. `stop()` calls
  // this to cut short the `idleMs` gap and the
  // `circuitBreakerPauseMs` pause.
  let wakeSleep: (() => void) | null = null;

  /**
   * Interruptible sleep. Returns a promise that resolves either
   * after `ms` milliseconds or as soon as `wakeSleep()` is called
   * (whichever comes first). Used for the between-batch yield
   * AND the circuit-breaker pause so both are responsive to
   * `stop()`.
   */
  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let resolved = false;
      const finish = (): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        wakeSleep = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      wakeSleep = finish;
    });
  }

  /**
   * Process a single record. Returns `true` on success,
   * `false` on any caught failure (which also records
   * `lastError`). Does not mutate the failure counter — that
   * bookkeeping is the caller's responsibility so the circuit
   * breaker can see the delta.
   */
  async function processRecord(record: MemoryRecord): Promise<boolean> {
    try {
      const input = composeEmbeddingInput(record);
      const vec = await embedder.embed(input);
      await storage.putEmbedding(record.record_id, vec);
      onNamespaceChanged?.(record.namespace);
      lastError = null;
      processed += 1;
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      lastError = message;
      process.stderr.write(
        `[kiro-learn] backfill embed failed for record ${record.record_id}: ${message}\n`,
      );
      return false;
    }
  }

  /**
   * The main loop. Runs until `stopped` is set or the embedder
   * becomes not-ready or a query returns an empty batch.
   */
  async function run(): Promise<void> {
    try {
      let consecutiveFailures = 0;

      while (!stopped) {
        // Degraded-mode guard: if the embedder has transitioned
        // to a terminal not-ready state (e.g. model load failed
        // mid-run), exit cleanly. The collector will log the
        // condition separately; the worker does not retry.
        if (!embedder.isReady()) {
          return;
        }

        state = 'running';

        const batch = await storage.listRecordsWithoutEmbedding(
          null,
          config.batchSize,
        );

        // Backlog drained — exit cleanly. A future `start()` on
        // a fresh worker would re-check; this instance is done.
        if (batch.length === 0) {
          return;
        }

        for (const record of batch) {
          if (stopped) break;

          const ok = await processRecord(record);
          if (ok) {
            consecutiveFailures = 0;
            continue;
          }

          consecutiveFailures += 1;
          if (consecutiveFailures >= config.circuitBreakerFailures) {
            state = 'paused';
            await sleep(config.circuitBreakerPauseMs);
            consecutiveFailures = 0;
            if (stopped) break;
            state = 'running';
          }
        }

        if (stopped) break;

        // Yield between batches so active ingestion / search
        // traffic always wins the CPU.
        await sleep(config.idleMs);
      }
    } catch (err: unknown) {
      // Any error thrown inside the loop body — e.g. a rejection
      // from `storage.listRecordsWithoutEmbedding` or from `sleep`
      // (which should not throw, but we guard anyway) — must not
      // leak as an unhandled rejection on `loopPromise`. The
      // worker is already idle-priority and opportunistic, so a
      // storage error is not a hard failure mode: log it, record
      // `lastError`, and let the `finally` block below drive the
      // state transition back to `idle` / `stopped`.
      const message = err instanceof Error ? err.message : String(err);
      lastError = message;
      process.stderr.write(
        `[kiro-learn] backfill loop exited on error: ${message}\n`,
      );
    } finally {
      // The loop has exited. If `stop()` was called, latch to
      // `stopped`; otherwise the backlog drained (or the
      // embedder became not-ready or an error was caught above)
      // and we return to `idle`.
      state = stopped ? 'stopped' : 'idle';
      loopPromise = null;
    }
  }

  return {
    start(): void {
      if (stopped) return;
      if (loopPromise !== null) return;
      loopPromise = run();
    },

    async stop(timeoutMs: number): Promise<void> {
      stopped = true;
      // Cut short any in-flight sleep so shutdown completes in
      // one record's worth of work rather than one `idleMs` or
      // `circuitBreakerPauseMs`.
      if (wakeSleep !== null) {
        wakeSleep();
      }

      const active = loopPromise;
      if (active === null) {
        // Loop never started, or already exited. Ensure the
        // terminal state is visible to subsequent `status()`
        // calls.
        state = 'stopped';
        return;
      }

      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      });

      await Promise.race([active.catch(() => undefined), timeout]);
      // Whether the loop drained or the timeout fired, the
      // worker is terminally stopped.
      state = 'stopped';
    },

    status(): BackfillWorkerStatus {
      return { state, processed, lastError };
    },
  };
}
