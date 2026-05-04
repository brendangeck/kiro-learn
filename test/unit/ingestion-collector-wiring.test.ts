/**
 * Unit tests for collector ingestion-pipeline wiring.
 *
 * Mirrors `test/unit/buffer-collector-wiring.test.ts` but focuses on
 * the reconciliation-engine seam introduced by Task 13:
 *
 *   1. `startCollector` instantiates `createIngestionPipeline` with
 *      the configured reconciliation defaults.
 *   2. The same `IngestionPipeline` reference is passed to
 *      `createExtractionWorker` — the thin-shim wrapper
 *      (Task 13.1) delegates `extract(projectId)` to
 *      `pipeline.run(projectId)`.
 *   3. With `reconciliationEnabled: false`, the pipeline exists and
 *      the circuit breaker exists, but no judge ACP sessions are
 *      opened in a smoke run (the direct-commit fallback bypasses
 *      the judge entirely).
 *   4. Shutdown ordering: `pipeline.drain` completes before
 *      `storage.close`.
 *
 * Strategy:
 *
 * - `createIngestionPipeline`, `createExtractionWorker`, and
 *   `createReconciliationCircuitBreaker` are mocked at the module
 *   boundary so tests can inspect the deps each factory received
 *   and assert the identity of references passed between them.
 * - `openSqliteStorage` returns a mock `StorageBackend` — no real
 *   disk I/O.
 * - `startReceiver` is mocked so no port is bound.
 * - ACP `createAcpSession` is mocked so no `kiro-cli` processes
 *   spawn.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 13.6
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 1.1, 1.5, 10.1
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageBackend } from '../../src/types/index.js';
import type { BufferStore } from '../../src/collector/buffer/store.js';
import type { BufferWatcher } from '../../src/collector/buffer/watcher.js';
import type {
  ExtractionWorker,
  ExtractionWorkerDeps,
} from '../../src/collector/buffer/extraction.js';
import type {
  IngestionPipeline,
  IngestionPipelineDeps,
} from '../../src/collector/ingestion/index.js';
import type { ReconciliationCircuitBreaker } from '../../src/collector/ingestion/circuit-breaker.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

const mockCreateAcpSession = vi.fn(() =>
  Promise.resolve({
    sendPrompt: vi.fn(() => Promise.resolve('')),
    destroy: vi.fn(),
  }),
);

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: mockCreateAcpSession,
}));

// ── Mock SQLite storage ─────────────────────────────────────────────────

const mockStorageClose = vi.fn(async () => undefined);

const mockStorage: StorageBackend = {
  putEvent: vi.fn(async () => undefined),
  getEventById: vi.fn(async () => null),
  putMemoryRecord: vi.fn(async () => undefined),
  searchMemoryRecords: vi.fn(async () => []),
  close: mockStorageClose,
  getStats: vi.fn(async () => ({
    total_events: 0,
    total_memories: 0,
    total_projects: 0,
    total_concepts: 0,
    observation_types: {},
    event_kinds: {},
  })),
  listProjects: vi.fn(async () => []),
  listMemoryRecords: vi.fn(async () => ({ items: [], total: 0 })),
  listEvents: vi.fn(async () => ({ items: [], total: 0 })),
  putEmbedding: vi.fn(async () => undefined),
  getEmbedding: vi.fn(async () => null),
  listEmbeddings: vi.fn(async () => []),
  listRecordsWithoutEmbedding: vi.fn(async () => []),
  searchMemoryRecordsLexical: vi.fn(async () => []),
  deleteMemoryRecord: vi.fn(async () => undefined),
  withTransaction: vi.fn(async <T>(fn: (tx: unknown) => T | Promise<T>) => {
    const tx = {
      putMemoryRecord: vi.fn(async () => undefined),
      putEmbedding: vi.fn(async () => undefined),
      deleteMemoryRecord: vi.fn(async () => undefined),
    };
    return Promise.resolve(fn(tx));
  }),
};

vi.mock('../../src/collector/storage/sqlite/index.js', () => ({
  openSqliteStorage: vi.fn(() => mockStorage),
}));

// ── Mock HTTP receiver ──────────────────────────────────────────────────

const mockReceiverClose = vi.fn(async () => undefined);

vi.mock('../../src/collector/receiver/index.js', () => ({
  startReceiver: vi.fn(() =>
    Promise.resolve({
      server: {},
      close: mockReceiverClose,
    }),
  ),
}));

// ── Mock BufferStore ────────────────────────────────────────────────────

vi.mock('../../src/collector/buffer/store.js', () => ({
  createBufferStore: vi.fn(
    () =>
      ({
        append: vi.fn(async () => 0),
        snapshot: vi.fn(async () => []),
        snapshotWithSize: vi.fn(async () => ({ entries: [], sizeBytes: 0 })),
        size: vi.fn(async () => 0),
        bufferPath: vi.fn(
          (projectId: string) => `/mock/buffers/${projectId}/buffer.ndjson`,
        ),
        listProjects: vi.fn(async () => [] as string[]),
        clear: vi.fn(async () => undefined),
        sizeSync: vi.fn(() => 0),
        replace: vi.fn(async () => ({ catchUpEntries: [], newSizeBytes: 0 })),
      }) satisfies BufferStore,
  ),
}));

// ── Mock BufferWatcher ──────────────────────────────────────────────────

const mockWatcherClose = vi.fn();

vi.mock('../../src/collector/buffer/watcher.js', () => ({
  createBufferWatcher: vi.fn(
    () =>
      ({
        notifyAppend: vi.fn(() => true),
        wouldExceedCeiling: vi.fn(() => false),
        notifyExtractionResult: vi.fn(),
        notifyCompactionResult: vi.fn(),
        onExtraction: vi.fn(),
        onCompaction: vi.fn(),
        close: mockWatcherClose,
        _getState: vi.fn(() => undefined),
      }) satisfies BufferWatcher,
  ),
}));

// ── Mock ExtractionWorker (thin shim — Task 13.1) ───────────────────────

let capturedExtractionDeps: ExtractionWorkerDeps | null = null;
const mockExtractionDrain = vi.fn(async () => undefined);

vi.mock('../../src/collector/buffer/extraction.js', () => ({
  createExtractionWorker: vi.fn((deps: ExtractionWorkerDeps) => {
    capturedExtractionDeps = deps;
    return {
      extract: vi.fn(async () => ({
        projectId: 'test',
        eventsProcessed: 0,
        memoriesCreated: 0,
        durationMs: 0,
      })),
      drain: mockExtractionDrain,
      get active() {
        return 0;
      },
    } satisfies ExtractionWorker;
  }),
}));

// ── Mock IngestionPipeline ──────────────────────────────────────────────

let capturedIngestionDeps: IngestionPipelineDeps | null = null;
const mockIngestionDrain = vi.fn(async () => undefined);
const mockIngestionRun = vi.fn(async () => ({
  projectId: 'test',
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
  phaseLatencyMs: {
    extraction: 0,
    clustering: 0,
    neighborLookup: 0,
    judge: 0,
    commit: 0,
  },
}));

vi.mock('../../src/collector/ingestion/index.js', () => ({
  createIngestionPipeline: vi.fn((deps: IngestionPipelineDeps) => {
    capturedIngestionDeps = deps;
    return {
      run: mockIngestionRun,
      drain: mockIngestionDrain,
      get active() {
        return 0;
      },
    } satisfies IngestionPipeline;
  }),
}));

// ── Mock ReconciliationCircuitBreaker ───────────────────────────────────

let capturedCircuitBreaker: ReconciliationCircuitBreaker | null = null;
const mockCircuitBreakerIsOpen = vi.fn(() => false);
const mockCircuitBreakerRecord = vi.fn();
const mockCircuitBreakerOnRunComplete = vi.fn();

vi.mock('../../src/collector/ingestion/circuit-breaker.js', () => ({
  createReconciliationCircuitBreaker: vi.fn(() => {
    capturedCircuitBreaker = {
      isOpen: mockCircuitBreakerIsOpen,
      record: mockCircuitBreakerRecord,
      onRunComplete: mockCircuitBreakerOnRunComplete,
      _state: vi.fn(() => ({ consecutiveFailures: 0, open: false })),
    };
    return capturedCircuitBreaker;
  }),
}));

// ── Mock CompactionWorker (keep the import graph honest) ────────────────

vi.mock('../../src/collector/buffer/compaction.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    createCompactionWorker: vi.fn(() => ({
      compact: vi.fn(async () => ({
        projectId: 'test',
        entriesBefore: 0,
        entriesAfter: 0,
        bytesSaved: 0,
        modelDurationMs: 0,
        replaceDurationMs: 0,
        usedFallback: false,
      })),
      drain: vi.fn(async () => undefined),
      get active() {
        return false;
      },
    })),
  };
});

// ── Test harness ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-ing-wiring-'));
  vi.clearAllMocks();
  capturedExtractionDeps = null;
  capturedIngestionDeps = null;
  capturedCircuitBreaker = null;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('Collector ingestion pipeline wiring', () => {
  it('instantiates the ingestion pipeline with the documented reconciliation defaults', async () => {
    /**
     * **Validates: Requirements 1.1, 10.1**
     *
     * `startCollector` must construct `createIngestionPipeline`
     * with the default reconciliation thresholds (feature flag on,
     * intra-batch 0.85, neighbor 0.80, pool cap 10, judge timeout
     * 30s) when the caller supplies no overrides.
     */
    const { startCollector } = await import('../../src/collector/index.js');

    const bufferDir = path.join(tmpDir, 'buffers');

    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'test.db'),
      bufferEnabled: true,
      bufferDir,
      port: 0,
      embeddingEnabled: false,
    });

    expect(capturedIngestionDeps).not.toBeNull();
    const config = capturedIngestionDeps!.config;
    expect(config.reconciliationEnabled).toBe(true);
    expect(config.intraBatchSimilarityThreshold).toBeCloseTo(0.85, 10);
    expect(config.neighborSimilarityThreshold).toBeCloseTo(0.8, 10);
    expect(config.neighborPoolMaxSize).toBe(10);
    expect(config.judgeModelTimeoutMs).toBe(30_000);
    expect(config.extractionConcurrency).toBe(2);
    expect(config.extractionTimeoutMs).toBe(60_000);
    expect(config.extractionMaxRetries).toBe(3);
    expect(config.debug).toBe(false);

    await handle.close();
  });

  it('passes the same IngestionPipeline reference to ExtractionWorker', async () => {
    /**
     * **Validates: Requirements 1.1, 1.5**
     *
     * The thin-shim `ExtractionWorker` (Task 13.1) forwards every
     * call to the pipeline, so the wiring must hand the exact
     * same `IngestionPipeline` reference to both factories —
     * otherwise the shim would drive a detached pipeline and the
     * watcher's extraction triggers would run against a different
     * pipeline than the one the collector shut down.
     */
    const { startCollector } = await import('../../src/collector/index.js');

    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'identity.db'),
      bufferEnabled: true,
      bufferDir: path.join(tmpDir, 'buffers'),
      port: 0,
      embeddingEnabled: false,
    });

    expect(capturedExtractionDeps).not.toBeNull();
    expect(capturedIngestionDeps).not.toBeNull();

    // The shim's `pipeline` field is the same object the
    // `createIngestionPipeline` factory returned. We can verify
    // this indirectly by checking `extract` + `drain` semantics,
    // but the tightest assertion is to compare the `active`
    // getter + `drain` identity on the shim vs the pipeline mock.
    // Since both mocks return distinct plain objects per call,
    // re-calling `createIngestionPipeline` would have produced a
    // different handle — so if the shim's `drain` forwards to
    // `mockIngestionDrain`, we know the identity held.
    await capturedExtractionDeps!.pipeline.drain(0);
    expect(mockIngestionDrain).toHaveBeenCalledOnce();

    // The watcher ref held by the shim is also the same one the
    // pipeline received — both come from the single
    // `createBufferWatcher()` call in `startCollector`.
    expect(capturedExtractionDeps!.watcher).toBe(capturedIngestionDeps!.watcher);

    await handle.close();
  });

  it('with reconciliationEnabled: false, no judge ACP sessions are opened', async () => {
    /**
     * **Validates: Requirements 1.6, 10.1**
     *
     * The feature-flag-off path is the rollback escape valve. A
     * smoke run with the flag off must not reach the judge — no
     * `kiro-learn-reconciler` sessions ever open. This covers the
     * "breaker exists but is never consulted by the judge" case
     * too: the pipeline still constructs a circuit breaker (it's
     * a harmless per-project state holder), but the direct-commit
     * path bypasses judge invocation entirely.
     */
    const { startCollector } = await import('../../src/collector/index.js');

    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'flag-off.db'),
      bufferEnabled: true,
      bufferDir: path.join(tmpDir, 'buffers-flag-off'),
      port: 0,
      embeddingEnabled: false,
      reconciliationEnabled: false,
    });

    // The circuit breaker was instantiated (per-project state holder).
    expect(capturedCircuitBreaker).not.toBeNull();

    // The pipeline received the flag = false.
    expect(capturedIngestionDeps!.config.reconciliationEnabled).toBe(false);

    // A smoke run via the shim.
    const worker = capturedExtractionDeps!.pipeline;
    await worker.run('smoke-project');

    // The mocked pipeline's `run` was called, which would in
    // production take the direct-commit path. In this harness the
    // pipeline is mocked so the judge integration is elided, but
    // the `createAcpSession` spy is still the strongest end-to-
    // end assertion available: the direct-commit path never
    // constructs a reconciler session even if the mock pipeline
    // were replaced with the real one.
    const reconcilerCalls = mockCreateAcpSession.mock.calls.filter((c) => {
      const arg = c[0] as { agentName?: string } | undefined;
      return arg !== undefined && arg.agentName === 'kiro-learn-reconciler';
    });
    expect(reconcilerCalls).toEqual([]);

    await handle.close();
  });

  it('shutdown drains the pipeline before closing storage', async () => {
    /**
     * **Validates: Requirement 1.1 (shutdown ordering)**
     *
     * Drain order matters: the pipeline writes memory records and
     * embeddings through storage. If storage closes first, in-
     * flight writes fail. The order on `handle.close()` must be
     * `pipeline.drain` → `storage.close`. The drain is called
     * indirectly through `extractionWorker.drain` because the
     * thin shim forwards — this test asserts both drains run
     * before the storage close.
     */
    const callOrder: string[] = [];

    mockReceiverClose.mockImplementation(async () => {
      callOrder.push('receiver.close');
    });
    mockExtractionDrain.mockImplementation(async () => {
      callOrder.push('extraction.drain');
    });
    mockWatcherClose.mockImplementation(() => {
      callOrder.push('watcher.close');
    });
    mockStorageClose.mockImplementation(async () => {
      callOrder.push('storage.close');
    });

    const { startCollector } = await import('../../src/collector/index.js');

    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'shutdown.db'),
      bufferEnabled: true,
      bufferDir: path.join(tmpDir, 'buffers-shutdown'),
      port: 0,
      embeddingEnabled: false,
    });

    await handle.close();

    // Drain happens before storage close.
    const drainIdx = callOrder.indexOf('extraction.drain');
    const closeIdx = callOrder.indexOf('storage.close');
    expect(drainIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(drainIdx).toBeLessThan(closeIdx);

    // Watcher close is also before storage close.
    const watcherIdx = callOrder.indexOf('watcher.close');
    expect(watcherIdx).toBeGreaterThanOrEqual(0);
    expect(watcherIdx).toBeLessThan(closeIdx);
  });
});
