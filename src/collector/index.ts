/**
 * Collector — the long-running local daemon.
 *
 * Wires receiver → pipeline → storage, exposes the HTTP surface, and runs
 * enrichment. See AGENTS.md for the architectural picture.
 *
 * This is the ONLY module that imports from `src/collector/storage/sqlite/`.
 * Every other module receives a {@link StorageBackend} via dependency
 * injection.
 *
 * @see Requirements 14.1–14.5, 15.1
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import * as fs from 'node:fs';

import { createBackfillWorker } from './backfill/index.js';
import type { BackfillWorker } from './backfill/index.js';
import { createBufferStore, createBufferWatcher, createExtractionWorker, createCompactionWorker } from './buffer/index.js';
import type { BufferStore, BufferWatcher, ExtractionWorker, CompactionWorker } from './buffer/index.js';
import { createOnnxEmbedder } from './embedding/index.js';
import type { Embedder } from './embedding/index.js';
import { openSqliteStorage } from './storage/sqlite/index.js';
import { createPipeline } from './pipeline/index.js';
import { createQueryLayer } from './query/index.js';
import { createRetrievalAssembler } from './retrieval/index.js';
import { startReceiver } from './receiver/index.js';

/**
 * Expand a leading `~` or `~/` to the real home directory. Node.js does
 * not expand tilde in filesystem APIs — only the shell does.
 */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}

// ── Configuration ───────────────────────────────────────────────────────

/**
 * Full configuration for the collector daemon.
 *
 * All fields have sensible defaults so that zero-config startup works.
 *
 * @see Requirements 14.4, 14.5
 */
export interface CollectorConfig {
  /** HTTP bind port. Default `21100`. */
  port: number;
  /** HTTP bind address. Default `'127.0.0.1'`. */
  host: string;
  /** Path to the SQLite database file. Default `'~/.kiro-learn/kiro-learn.db'`. A leading `~` is expanded to the user's home directory. */
  storagePath: string;
  /** Hard deadline for retrieval assembly in milliseconds. Default `500`. */
  retrievalBudgetMs: number;
  /** Maximum concurrent `kiro-cli` extraction processes. Default `2`. */
  extractionConcurrency: number;
  /** Maximum queued extractions before oldest is dropped. Default `100`. */
  extractionQueueDepth: number;
  /** Per-extraction timeout in milliseconds. Default `30_000`. */
  extractionTimeoutMs: number;
  /** Maximum entries in the in-memory dedup set. Default `10_000`. */
  dedupMaxSize: number;
  /** Maximum number of memory records returned per retrieval query. Default `10`. */
  resultLimit: number;
  /** Maximum request body size in bytes. Default `2 * 1024 * 1024` (2 MiB). */
  maxBodyBytes: number;

  // ── Buffer configuration ────────────────────────────────────────────

  /** Whether buffer mode is enabled. When `true`, events are appended to project buffers for batch extraction instead of per-event extraction. Default `true`. @see Requirements 18.1 */
  bufferEnabled?: boolean;
  /** Idle period (ms) before extraction fires for a project buffer. Default `5_000`. @see Requirements 18.2 */
  bufferIdleMs?: number;
  /** Buffer byte-size threshold that triggers extraction. Default `262_144` (256 KiB). @see Requirements 18.2 */
  bufferExtractionThreshold?: number;
  /** Hard ceiling on buffer size (bytes). Appends are refused above this. Default `4_194_304` (4 MiB). @see Requirements 18.2 */
  bufferMaxBytes?: number;
  /** Consecutive extraction failures before the circuit breaker trips. Default `3`. @see Requirements 18.2 */
  bufferMaxConsecutiveFailures?: number;
  /** Maximum concurrent buffer extractions across all projects. Default `2`. @see Requirements 18.2 */
  bufferExtractionConcurrency?: number;
  /** Per-extraction timeout (ms) for buffer batch extraction. Default `60_000`. @see Requirements 18.2 */
  bufferExtractionTimeoutMs?: number;
  /** Directory for per-project buffer files. Default `~/.kiro-learn/buffers/`. @see Requirements 18.2 */
  bufferDir?: string;

  // ── Compaction configuration ──────────────────────────────────────────

  /** Whether buffer compaction is enabled. Default `false`. @see Requirements 11.1 */
  compactionEnabled?: boolean;
  /** Buffer byte-size threshold for compaction trigger. Default `1_048_576` (1 MiB). @see Requirements 11.2 */
  compactionSizeThreshold?: number;
  /** Per-compaction model call timeout (ms). Default `120_000`. @see Requirements 11.2 */
  compactionModelTimeoutMs?: number;
  /** Max model retries per compaction attempt. Default `2`. @see Requirements 11.2 */
  compactionMaxModelRetries?: number;
  /** Consecutive model failures before deterministic eviction fallback. Default `3`. @see Requirements 11.2 */
  compactionMaxConsecutiveModelFailures?: number;

  // ── Embedding configuration ────────────────────────────────────────────

  /**
   * Whether local embedding + hybrid search is enabled. When `false`, the
   * daemon never constructs the ONNX embedder, extractions write records
   * with NULL embeddings, and `QueryLayer.search` operates in lexical-only
   * mode for the lifetime of the process.
   *
   * Default `true`. @see Requirements 2.1, 12.1, 12.5
   */
  embeddingEnabled?: boolean;

  /**
   * Directory where `@huggingface/transformers` caches model weights. A
   * leading `~/` is expanded to the user's home directory. When omitted,
   * the `OnnxEmbedder` falls back to the `KIRO_LEARN_MODEL_DIR`
   * environment variable and finally to `~/.kiro-learn/models/`.
   *
   * Default `undefined` (resolved at embedder-construction time via env
   * var / default cascade). @see Requirements 1.5, 1.6, 12.3
   */
  modelCacheDir?: string;

  /**
   * Per-call timeout for a single `embedder.embed(input)` invocation, in
   * milliseconds. Default `2_000`. @see Requirements 10.3, 12.2
   */
  embeddingTimeoutMs?: number;

  /**
   * Reciprocal-rank-fusion constant `k` used by the hybrid query layer.
   * Larger values flatten the weight the top-ranked items receive from
   * each source. Default `60`. @see Requirements 5.3, 12.1
   */
  rrfK?: number;

  /**
   * Multiplier applied to the caller-supplied `limit` when fetching
   * candidates from each ranked source before RRF fusion. A value of `4`
   * means a request for `limit=10` pulls 40 lexical and 40 vector
   * candidates into the fusion step. Default `4`. @see Requirements 5.3, 12.1
   */
  hybridFetchDepthMultiplier?: number;

  /**
   * How many `memory_records` the backfill worker fetches per iteration
   * of its idle-priority loop. Default `32`. @see Requirements 8.5, 12.4
   */
  backfillBatchSize?: number;
}

/**
 * Default configuration values for the collector.
 *
 * @see Requirements 14.5
 */
export const DEFAULT_COLLECTOR_CONFIG: CollectorConfig = {
  port: 21100,
  host: '127.0.0.1',
  storagePath: '~/.kiro-learn/kiro-learn.db',
  retrievalBudgetMs: 500,
  extractionConcurrency: 2,
  extractionQueueDepth: 100,
  extractionTimeoutMs: 30_000,
  dedupMaxSize: 10_000,
  resultLimit: 10,
  maxBodyBytes: 2 * 1024 * 1024,

  // Buffer defaults
  bufferEnabled: true,
  bufferIdleMs: 5_000,
  bufferExtractionThreshold: 262_144,
  bufferMaxBytes: 4_194_304,
  bufferMaxConsecutiveFailures: 3,
  bufferExtractionConcurrency: 2,
  bufferExtractionTimeoutMs: 60_000,
  bufferDir: join(homedir(), '.kiro-learn', 'buffers'),

  // Compaction defaults
  compactionEnabled: false,
  compactionSizeThreshold: 1_048_576,
  compactionModelTimeoutMs: 120_000,
  compactionMaxModelRetries: 2,
  compactionMaxConsecutiveModelFailures: 3,

  // Embedding defaults
  embeddingEnabled: true,
  // `modelCacheDir` is intentionally omitted — OnnxEmbedder falls back to
  // the `KIRO_LEARN_MODEL_DIR` env var and then to `~/.kiro-learn/models/`
  // when the field is not provided.
  embeddingTimeoutMs: 2_000,
  rrfK: 60,
  hybridFetchDepthMultiplier: 4,
  backfillBatchSize: 32,
};

// ── Handle ──────────────────────────────────────────────────────────────

/**
 * Handle returned by {@link startCollector}. Provides a graceful shutdown
 * method that stops the receiver, drains extraction, and closes storage.
 *
 * @see Requirements 14.1, 14.3
 */
export interface CollectorHandle {
  /** Gracefully shut down the collector. */
  close(): Promise<void>;
}

// ── Factory ─────────────────────────────────────────────────────────────

/** Drain timeout for in-flight extractions during shutdown (ms). */
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * Start the collector daemon.
 *
 * Wiring sequence:
 * 1. Merge provided config with defaults.
 * 2. Open storage via `openSqliteStorage` (the ONLY place that knows the
 *    concrete backend).
 * 3. If buffer mode is enabled, instantiate BufferStore, BufferWatcher,
 *    and ExtractionWorker. Wire the watcher's extraction trigger to the
 *    worker.
 * 4. Create pipeline with all stages, injecting `StorageBackend` and
 *    optional buffer dependencies.
 * 5. If buffer mode is enabled, scan existing buffers and re-arm triggers
 *    for non-empty projects (daemon restart recovery).
 * 6. Create query layer, injecting `StorageBackend`.
 * 7. Create retrieval assembler, injecting query layer.
 * 8. Start HTTP receiver, injecting pipeline and retrieval.
 * 9. Return handle with `close()` that: stops receiver, drains extraction
 *    (5 s timeout), closes watcher (if buffer mode), closes storage.
 *
 * @see Requirements 13.1, 13.2, 13.3, 13.4, 14.1, 14.2, 14.3, 14.4, 14.5, 15.1, 15.2, 15.3
 */
export async function startCollector(
  config?: Partial<CollectorConfig>,
): Promise<CollectorHandle> {
  const cfg: CollectorConfig = { ...DEFAULT_COLLECTOR_CONFIG, ...config };

  // 1. Open storage (this is the ONLY place that knows the concrete backend)
  const dbPath = expandTilde(cfg.storagePath);
  const storage = openSqliteStorage({ dbPath });

  // Wrap subsequent wiring so storage is closed if anything throws.
  try {
    // 2. Resolve buffer mode
    const bufferEnabled = cfg.bufferEnabled === true;

    let bufferStore: BufferStore | undefined;
    let bufferWatcher: BufferWatcher | undefined;
    let extractionWorker: ExtractionWorker | undefined;
    let compactionWorker: CompactionWorker | undefined;
    let backfillWorker: BackfillWorker | null = null;

    // 2a. Resolve embedder. When `embeddingEnabled === false` (Req 12.5),
    //     we skip model construction entirely and the daemon operates in
    //     lexical-only mode for the lifetime of the process. Otherwise we
    //     construct the ONNX embedder, await its `ready()` before binding
    //     the HTTP listener (design § `createOnnxEmbedder` returns
    //     immediately), and on load failure keep the handle so
    //     `isReady()` returns `false` forever — the ExtractionWorker and
    //     QueryLayer both treat that as degraded mode and fall back to
    //     their NULL-embedder code paths.
    //     @see Requirements 2.1, 2.2, 2.4, 2.5, 12.1, 12.2, 12.3, 12.5
    let embedder: (Embedder & { dispose?: () => void }) | null = null;
    if (cfg.embeddingEnabled !== false) {
      // Pass `modelCacheDir` only when the caller set it explicitly.
      // `OnnxEmbedder` already handles the env-var + default cascade
      // internally, so omitting the field preserves that precedence.
      const embedderConfig: {
        modelCacheDir?: string;
        perCallTimeoutMs: number;
      } = {
        perCallTimeoutMs: cfg.embeddingTimeoutMs ?? 2_000,
      };
      if (cfg.modelCacheDir !== undefined) {
        embedderConfig.modelCacheDir = cfg.modelCacheDir;
      }
      embedder = createOnnxEmbedder(embedderConfig);
      try {
        await embedder.ready();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[kiro-learn] embedder failed to load; running in degraded lexical-only mode: ${message}\n`,
        );
        // Keep the embedder handle — `isReady()` will continue to return
        // `false` and downstream consumers (ExtractionWorker, QueryLayer)
        // will short-circuit to their NULL-embedder paths.
      }
    }

    // 2b. Create query layer up-front so the extraction and backfill
    //     workers can invalidate its per-namespace vector index cache
    //     after every successful embed write.
    //     @see Requirement 7.5
    const queryLayer = createQueryLayer({
      storage,
      embedder,
      config: {
        rrfK: cfg.rrfK ?? 60,
        fetchDepthMultiplier: cfg.hybridFetchDepthMultiplier ?? 4,
      },
    });

    // 3. If buffer mode is enabled, instantiate buffer components
    if (bufferEnabled) {
      const bufferDir = expandTilde(cfg.bufferDir ?? join(homedir(), '.kiro-learn', 'buffers'));

      bufferStore = createBufferStore(bufferDir);

      bufferWatcher = createBufferWatcher({
        idleMs: cfg.bufferIdleMs ?? 5_000,
        extractionSizeThreshold: cfg.bufferExtractionThreshold ?? 262_144,
        bufferMaxBytes: cfg.bufferMaxBytes ?? 4_194_304,
        maxConsecutiveFailures: cfg.bufferMaxConsecutiveFailures ?? 3,
        compactionSizeThreshold: cfg.compactionSizeThreshold ?? 1_048_576,
      });

      extractionWorker = createExtractionWorker({
        bufferStore,
        watcher: bufferWatcher,
        storage,
        embedder,
        onNamespaceChanged: (ns: string) => {
          queryLayer.invalidateNamespace(ns);
        },
        config: {
          concurrency: cfg.bufferExtractionConcurrency ?? 2,
          timeoutMs: cfg.bufferExtractionTimeoutMs ?? 60_000,
          maxRetries: 3,
        },
      });

      // Wire: watcher extraction trigger → extraction worker
      bufferWatcher.onExtraction((projectId) => {
        extractionWorker!.extract(projectId).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[kiro-learn] extraction error for project ${projectId}: ${message}\n`,
          );
        });
      });

      // 3b. If compaction is enabled, instantiate CompactionWorker and wire triggers
      if (cfg.compactionEnabled === true) {
        compactionWorker = createCompactionWorker({
          bufferStore,
          watcher: bufferWatcher,
          config: {
            modelTimeoutMs: cfg.compactionModelTimeoutMs ?? 120_000,
            maxModelRetries: cfg.compactionMaxModelRetries ?? 2,
            maxConsecutiveModelFailures: cfg.compactionMaxConsecutiveModelFailures ?? 3,
            enabled: true,
          },
        });

        // Wire: watcher compaction trigger → compaction worker
        bufferWatcher.onCompaction((projectId) => {
          compactionWorker!.compact(projectId).catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(
              `[kiro-learn] compaction error for project ${projectId}: ${message}\n`,
            );
          });
        });
      }
    }

    // 4. Create pipeline with all stages, injecting StorageBackend + buffer deps
    const pipeline = createPipeline({
      storage,
      extractionConcurrency: cfg.extractionConcurrency,
      extractionQueueDepth: cfg.extractionQueueDepth,
      extractionTimeout: cfg.extractionTimeoutMs,
      dedupMaxSize: cfg.dedupMaxSize,
      ...(bufferEnabled && bufferStore !== undefined && bufferWatcher !== undefined
        ? { bufferStore, bufferWatcher, bufferEnabled: true }
        : {}),
    });

    // 5. If buffer mode is enabled, scan existing buffers and re-arm triggers
    //    for non-empty projects (daemon restart recovery).
    //    Also clean up orphaned temp files from interrupted compactions.
    if (bufferEnabled && bufferStore !== undefined && bufferWatcher !== undefined) {
      const bufferDir = expandTilde(cfg.bufferDir ?? join(homedir(), '.kiro-learn', 'buffers'));

      // 5a. Clean up orphaned temp files (buffer.ndjson.*.tmp) in buffer directories.
      //     These can be left behind if the daemon dies during a compaction replace.
      //     @see Requirement 16.3
      try {
        let dirEntries: fs.Dirent[];
        try {
          dirEntries = fs.readdirSync(bufferDir, { withFileTypes: true });
        } catch {
          dirEntries = [];
        }
        for (const entry of dirEntries) {
          if (!entry.isDirectory()) continue;
          const projectDir = join(bufferDir, entry.name);
          let files: string[];
          try {
            files = fs.readdirSync(projectDir);
          } catch {
            continue;
          }
          for (const file of files) {
            if (/^buffer\.ndjson\.\d+\.tmp$/.test(file)) {
              try {
                fs.unlinkSync(join(projectDir, file));
              } catch {
                // Best-effort cleanup — ignore errors.
              }
            }
          }
        }
      } catch (cleanupErr: unknown) {
        const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        process.stderr.write(
          `[kiro-learn] failed to clean up orphaned temp files on startup: ${message}\n`,
        );
      }

      // 5b. Re-arm triggers for existing buffers.
      try {
        const existingProjects = await bufferStore.listProjects();
        for (const projectId of existingProjects) {
          const size = await bufferStore.size(projectId);
          if (size > 0) {
            // Re-arm the watcher by notifying it of the existing buffer size.
            // This starts the idle timer and checks the size threshold,
            // including the compaction threshold for oversized buffers.
            // @see Requirement 16.2
            bufferWatcher.notifyAppend(projectId, size);
          }
        }
      } catch (scanErr: unknown) {
        const message = scanErr instanceof Error ? scanErr.message : String(scanErr);
        process.stderr.write(
          `[kiro-learn] failed to scan existing buffers on startup: ${message}\n`,
        );
      }
    }

    // 6. Query layer was created in step 2b (so extraction worker can
    //    invoke `invalidateNamespace` via its `onNamespaceChanged`
    //    callback). Nothing to do here.

    // 6b. Start the backfill worker when the embedder loaded
    //     successfully. `embedder.isReady() === false` covers both the
    //     feature-flag-off case (embedder is null; guarded above) and
    //     the degraded-mode case (load failed). Either way we leave the
    //     NULL-embedding records in place until a future daemon start
    //     recovers the embedder.
    //
    //     The worker is wired to `queryLayer.invalidateNamespace` so
    //     that hybrid searches immediately see the newly embedded
    //     records without waiting for the next cache miss (design §
    //     Cache invalidation protocol).
    //     @see Requirements 2.1, 2.5, 8.4, 8.5, 12.4, 13.6
    if (embedder !== null && embedder.isReady()) {
      backfillWorker = createBackfillWorker({
        storage,
        embedder,
        onNamespaceChanged: (ns: string) => {
          queryLayer.invalidateNamespace(ns);
        },
        config: {
          batchSize: cfg.backfillBatchSize ?? 32,
        },
      });
      backfillWorker.start();
    }

    // 7. Create retrieval assembler, injecting query layer
    const retrieval = createRetrievalAssembler({
      query: queryLayer,
      resultLimit: cfg.resultLimit,
    });

    // 8. Start HTTP receiver, injecting pipeline, retrieval, and query layer
    const receiver = await startReceiver(
      { pipeline, retrieval, storage, query: queryLayer },
      {
        host: cfg.host,
        port: cfg.port,
        maxBodyBytes: cfg.maxBodyBytes,
        retrievalBudgetMs: cfg.retrievalBudgetMs,
      },
    );

    // 9. Return handle with close method
    return {
      async close(): Promise<void> {
        await receiver.close();

        // Stop the backfill worker before draining the remaining
        // components so it stops issuing `putEmbedding` writes against
        // a closing storage handle. Bounded by a 5 s timeout — the
        // worker's state machine guarantees at most one batch of
        // embedder calls remains in flight when `stop()` returns.
        // @see Requirements 2.5, 13.6
        if (backfillWorker !== null) {
          await backfillWorker.stop(5_000);
        }

        if (bufferEnabled && extractionWorker !== undefined && bufferWatcher !== undefined) {
          // Buffer mode shutdown: drain extraction worker, drain compaction worker,
          // close watcher, then close storage.
          await extractionWorker.drain(DRAIN_TIMEOUT_MS);

          // Drain compaction worker if it was instantiated.
          // @see Requirement 12.2
          if (compactionWorker !== undefined) {
            await compactionWorker.drain(DRAIN_TIMEOUT_MS);
          }

          bufferWatcher.close();
        } else {
          // Legacy mode shutdown: drain per-event extraction stage
          await pipeline.extraction.drain(DRAIN_TIMEOUT_MS);
        }

        // Release the ONNX session last, after all consumers have
        // finished draining. `dispose` is optional on the Embedder
        // surface — only the ONNX implementation exposes it.
        if (embedder !== null && typeof embedder.dispose === 'function') {
          embedder.dispose();
        }

        await storage.close();
      },
    };
  } catch (err) {
    // Ensure the DB handle is released if wiring fails.
    await storage.close();
    throw err;
  }
}
