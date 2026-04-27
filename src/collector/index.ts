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
 * 3. Create pipeline with all stages, injecting `StorageBackend`.
 * 4. Create query layer, injecting `StorageBackend`.
 * 5. Create retrieval assembler, injecting query layer.
 * 6. Start HTTP receiver, injecting pipeline and retrieval.
 * 7. Return handle with `close()` that: stops receiver, drains extraction
 *    (5 s timeout), closes storage.
 *
 * @see Requirements 14.1, 14.2, 14.3, 14.4, 14.5, 15.1
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
    // 2. Create pipeline with all stages, injecting StorageBackend
    const pipeline = createPipeline({
      storage,
      extractionConcurrency: cfg.extractionConcurrency,
      extractionQueueDepth: cfg.extractionQueueDepth,
      extractionTimeout: cfg.extractionTimeoutMs,
      dedupMaxSize: cfg.dedupMaxSize,
    });

    // 3. Create query layer, injecting StorageBackend
    const queryLayer = createQueryLayer(storage);

    // 4. Create retrieval assembler, injecting query layer
    const retrieval = createRetrievalAssembler({
      query: queryLayer,
      resultLimit: cfg.resultLimit,
    });

    // 5. Start HTTP receiver, injecting pipeline and retrieval
    const receiver = await startReceiver(
      { pipeline, retrieval, storage },
      {
        host: cfg.host,
        port: cfg.port,
        maxBodyBytes: cfg.maxBodyBytes,
        retrievalBudgetMs: cfg.retrievalBudgetMs,
      },
    );

    // 6. Return handle with close method
    return {
      async close(): Promise<void> {
        await receiver.close();
        await pipeline.extraction.drain(DRAIN_TIMEOUT_MS);
        await storage.close();
      },
    };
  } catch (err) {
    // Ensure the DB handle is released if wiring fails.
    await storage.close();
    throw err;
  }
}
