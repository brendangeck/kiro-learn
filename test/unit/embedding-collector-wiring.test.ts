/**
 * Unit tests for collector embedding wiring (task 11.3).
 *
 * Verifies that `startCollector` correctly wires the embedder into
 * the daemon lifecycle:
 *
 *   - When `embeddingEnabled: true` (default) and the ONNX pipeline
 *     loads successfully, `ExtractionWorker`, `QueryLayer`, and
 *     `BackfillWorker` all receive the SAME `Embedder` reference —
 *     the singleton-per-process invariant required by Req 2.4.
 *   - When `embeddingEnabled: false`, the ONNX embedder is never
 *     constructed (no `pipeline(...)` call), the `ExtractionWorker`
 *     and `QueryLayer` receive `null`, and `createBackfillWorker`
 *     is never called.
 *   - Degraded-mode startup: when `embedder.ready()` rejects, the
 *     collector still starts. The `ExtractionWorker` and
 *     `QueryLayer` see the SAME handle but `isReady() === false`.
 *     No `BackfillWorker` is started.
 *   - Shutdown order: `backfillWorker.stop` completes before
 *     `storage.close` (Req 13.6, design § shutdown sequencing).
 *
 * Mocking strategy:
 *
 *   - `@huggingface/transformers` is mocked at the module boundary so
 *     the real `createOnnxEmbedder` runs against a controllable
 *     pipeline stub. No ONNX model is loaded.
 *   - `createExtractionWorker`, `createQueryLayer`, and
 *     `createBackfillWorker` are each mocked and wrapped so tests can
 *     inspect the `Embedder` reference each one receives.
 *   - `openSqliteStorage` returns a mock `StorageBackend` so no real
 *     disk I/O happens.
 *   - `startReceiver` is mocked to avoid binding to a real port.
 *   - `createBufferStore` / `createBufferWatcher` are mocked to keep
 *     the buffer branch lightweight.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 12.1–12.5, 13.6
 *
 * @see src/collector/index.ts
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — `src/collector/index.ts` wiring
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageBackend } from '../../src/types/index.js';
import type { Embedder } from '../../src/collector/embedding/index.js';
import type { ExtractionWorker } from '../../src/collector/buffer/extraction.js';
import type { BufferStore } from '../../src/collector/buffer/store.js';
import type { BufferWatcher } from '../../src/collector/buffer/watcher.js';
import type { QueryLayer } from '../../src/collector/query/index.js';
import type {
  BackfillWorker,
  BackfillWorkerDeps,
} from '../../src/collector/backfill/index.js';
import type { QueryLayerDeps } from '../../src/collector/query/index.js';
import type { ExtractionWorkerDeps } from '../../src/collector/buffer/extraction.js';
import type {
  IngestionPipeline,
  IngestionPipelineDeps,
} from '../../src/collector/ingestion/index.js';

// ── Mock `@huggingface/transformers` ────────────────────────────────────
//
// We mock the library the real `createOnnxEmbedder` imports so
// `startCollector` can run the real embedder factory without loading
// the ONNX model. Tests toggle `pipelineBehaviour` to switch between a
// successful load and a failing load.

type FakeCallable = (
  input: string,
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array }>;

type PipelineBehaviour =
  | { kind: 'ok' }
  | { kind: 'throws'; error: Error };

let pipelineBehaviour: PipelineBehaviour = { kind: 'ok' };

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(async (): Promise<FakeCallable> => {
    if (pipelineBehaviour.kind === 'throws') {
      throw pipelineBehaviour.error;
    }
    // Return a callable that resolves to a 384-wide fake tensor. The
    // identity assertions in this suite never actually invoke
    // `embed`, but a realistic resolver keeps the module happy.
    return (async () => ({ data: new Float32Array(384) })) as FakeCallable;
  }),
  env: {} as Record<string, unknown>,
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
  // Embedding surface — present so the real `createQueryLayer` /
  // `createBackfillWorker` type-check, though in this suite we mock
  // those factories anyway.
  putEmbedding: vi.fn(async () => undefined),
  getEmbedding: vi.fn(async () => null),
  listEmbeddings: vi.fn(async () => []),
  listRecordsWithoutEmbedding: vi.fn(async () => []),
  searchMemoryRecordsLexical: vi.fn(async () => []),
  // Reconciliation surface — the pipeline mock below never exercises
  // these, but the StorageBackend interface requires them.
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
    Promise.resolve({ server: {}, close: mockReceiverClose }),
  ),
}));

// ── Mock pipeline (collector pipeline, not HF pipeline) ────────────────

vi.mock('../../src/collector/pipeline/index.js', () => ({
  createPipeline: vi.fn(() => ({
    process: vi.fn(async () => ({ event_id: 'test', stored: true })),
    extraction: {
      enqueue: vi.fn(),
      drain: vi.fn(async () => undefined),
      get active() {
        return 0;
      },
    },
  })),
}));

// ── Mock BufferStore ────────────────────────────────────────────────────

const mockBufferStoreListProjects = vi.fn(async () => [] as string[]);

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
        listProjects: mockBufferStoreListProjects,
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

// ── Mock ExtractionWorker ───────────────────────────────────────────────
//
// Post-Task 13 the worker is a thin shim over `IngestionPipeline` and
// its deps surface is `{ pipeline, watcher }` only — the embedder now
// lives on the ingestion pipeline deps (captured below). The shim
// mock itself is intentionally minimal: the embedder-identity
// assertions reach through the pipeline deps rather than the shim
// deps.

const mockExtractionDrain = vi.fn(async () => undefined);

vi.mock('../../src/collector/buffer/extraction.js', () => ({
  createExtractionWorker: vi.fn((_deps: ExtractionWorkerDeps) => {
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
//
// The pipeline receives the embedder now — capturing its deps lets the
// identity-check tests assert the singleton invariant across
// IngestionPipeline, QueryLayer, and BackfillWorker.

let capturedIngestionDeps: IngestionPipelineDeps | null = null;
const mockIngestionDrain = vi.fn(async () => undefined);

vi.mock('../../src/collector/ingestion/index.js', () => ({
  createIngestionPipeline: vi.fn((deps: IngestionPipelineDeps) => {
    capturedIngestionDeps = deps;
    return {
      run: vi.fn(async () => ({
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
      })),
      drain: mockIngestionDrain,
      get active() {
        return 0;
      },
    } satisfies IngestionPipeline;
  }),
}));

// ── Mock ReconciliationCircuitBreaker ──────────────────────────────────

vi.mock('../../src/collector/ingestion/circuit-breaker.js', () => ({
  createReconciliationCircuitBreaker: vi.fn(() => ({
    isOpen: vi.fn(() => false),
    record: vi.fn(),
    onRunComplete: vi.fn(),
    _state: vi.fn(() => ({ consecutiveFailures: 0, open: false })),
  })),
}));

// ── Mock CompactionWorker (not exercised here, but guard mocks keep
//    the import graph honest when compactionEnabled is true) ─────────────

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

// ── Mock QueryLayer ─────────────────────────────────────────────────────

let capturedQueryDeps: QueryLayerDeps | null = null;
const mockInvalidateNamespace = vi.fn();

vi.mock('../../src/collector/query/index.js', () => ({
  createQueryLayer: vi.fn((deps: QueryLayerDeps) => {
    capturedQueryDeps = deps;
    return {
      search: vi.fn(async () => []),
      invalidateNamespace: mockInvalidateNamespace,
      getVectorIndex: vi.fn(async () => ({ entries: [] })),
      lookupNeighbors: vi.fn(async () => []),
    } satisfies QueryLayer;
  }),
}));

// ── Mock RetrievalAssembler ────────────────────────────────────────────

vi.mock('../../src/collector/retrieval/index.js', () => ({
  createRetrievalAssembler: vi.fn(() => ({
    assemble: vi.fn(async () => ({ context: '', records: [], latency_ms: 0 })),
  })),
}));

// ── Mock BackfillWorker ─────────────────────────────────────────────────

let capturedBackfillDeps: BackfillWorkerDeps | null = null;
const mockBackfillStart = vi.fn();
const mockBackfillStop = vi.fn(async () => undefined);
const mockBackfillStatus = vi.fn(() => ({
  state: 'idle' as const,
  processed: 0,
  lastError: null,
}));

vi.mock('../../src/collector/backfill/index.js', () => ({
  createBackfillWorker: vi.fn((deps: BackfillWorkerDeps) => {
    capturedBackfillDeps = deps;
    return {
      start: mockBackfillStart,
      stop: mockBackfillStop,
      status: mockBackfillStatus,
    } satisfies BackfillWorker;
  }),
}));

// ── Test harness ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-emb-wiring-'));
  vi.clearAllMocks();
  capturedIngestionDeps = null;
  capturedQueryDeps = null;
  capturedBackfillDeps = null;
  pipelineBehaviour = { kind: 'ok' };
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('Collector embedding wiring', () => {
  it('shares the same Embedder reference across ExtractionWorker, QueryLayer, and BackfillWorker', async () => {
    /**
     * **Validates: Requirements 2.1, 2.4, 13.6**
     *
     * When the feature flag is on and the model loads successfully,
     * all three consumers (ExtractionWorker, QueryLayer,
     * BackfillWorker) must receive the very same `Embedder`
     * instance. This is the singleton-per-process guarantee from
     * design § Components and Interfaces.
     */
    const { startCollector } = await import('../../src/collector/index.js');
    const { createBackfillWorker } = await import(
      '../../src/collector/backfill/index.js'
    );

    const bufferDir = path.join(tmpDir, 'buffers');

    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'test.db'),
      bufferEnabled: true,
      bufferDir,
      embeddingEnabled: true,
      port: 0,
    });

    // All three factories must have been called once.
    expect(capturedIngestionDeps).not.toBeNull();
    expect(capturedQueryDeps).not.toBeNull();
    expect(capturedBackfillDeps).not.toBeNull();
    expect(createBackfillWorker).toHaveBeenCalledOnce();

    // The `Embedder` reference must be identical across all three —
    // literally the same object, per Req 2.4. Post-Task-13 the
    // embedder is a dep of the `IngestionPipeline`, not of the thin-
    // shim `ExtractionWorker`.
    const ingestionEmbedder = capturedIngestionDeps!.embedder;
    const queryEmbedder = capturedQueryDeps!.embedder;
    const backfillEmbedder = capturedBackfillDeps!.embedder;

    expect(ingestionEmbedder).not.toBeNull();
    expect(queryEmbedder).not.toBeNull();
    expect(backfillEmbedder).not.toBeNull();

    // Identity — same reference, not just structural equality.
    expect(queryEmbedder).toBe(ingestionEmbedder);
    expect(backfillEmbedder).toBe(ingestionEmbedder);

    // And the embedder must be ready (the ONNX load stub resolved).
    expect((ingestionEmbedder as Embedder).isReady()).toBe(true);

    // BackfillWorker was started (embedder is ready).
    expect(mockBackfillStart).toHaveBeenCalledOnce();

    await handle.close();
  });

  it('does not construct the embedder when embeddingEnabled: false', async () => {
    /**
     * **Validates: Requirements 2.2, 12.1, 12.5, 13.6**
     *
     * With the feature flag off, the daemon must never call
     * `pipeline(...)` (no model load), must not instantiate a
     * `BackfillWorker`, and must pass `null` as the embedder to the
     * `ExtractionWorker` and `QueryLayer`. Extractions will then
     * write records with NULL embedding and searches operate in
     * pure lexical mode for the process lifetime.
     */
    const { pipeline } = await import('@huggingface/transformers');
    const { startCollector } = await import('../../src/collector/index.js');
    const { createBackfillWorker } = await import(
      '../../src/collector/backfill/index.js'
    );

    const bufferDir = path.join(tmpDir, 'buffers-flag-off');

    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'flag-off.db'),
      bufferEnabled: true,
      bufferDir,
      embeddingEnabled: false,
      port: 0,
    });

    // No HF pipeline load ever happened.
    expect(pipeline).not.toHaveBeenCalled();

    // Ingestion and query both saw `null`. The thin-shim extraction
    // worker forwards to the pipeline, so the pipeline deps carry
    // the (null) embedder.
    expect(capturedIngestionDeps).not.toBeNull();
    expect(capturedQueryDeps).not.toBeNull();
    expect(capturedIngestionDeps!.embedder).toBeNull();
    expect(capturedQueryDeps!.embedder).toBeNull();

    // Backfill worker was never started (it only exists when the
    // embedder is non-null and ready).
    expect(createBackfillWorker).not.toHaveBeenCalled();
    expect(capturedBackfillDeps).toBeNull();
    expect(mockBackfillStart).not.toHaveBeenCalled();

    await handle.close();
  });

  it('starts in degraded mode when the embedder fails to load; shares the same handle and skips BackfillWorker', async () => {
    /**
     * **Validates: Requirements 2.2, 2.3, 12.1, 13.6**
     *
     * When the ONNX pipeline fails to load, `startCollector` must:
     *
     *   - log an error (not thrown) to stderr,
     *   - still bind the HTTP listener (i.e. return a handle),
     *   - hand the (still non-null) embedder to ExtractionWorker and
     *     QueryLayer — identity preserved — with `isReady() === false`
     *     so both consumers take their degraded-mode branches,
     *   - NOT instantiate a BackfillWorker (the worker requires a
     *     ready embedder).
     */
    pipelineBehaviour = {
      kind: 'throws',
      error: new Error('model load failed'),
    };

    const { startCollector } = await import('../../src/collector/index.js');
    const { createBackfillWorker } = await import(
      '../../src/collector/backfill/index.js'
    );

    // Capture stderr so we can assert on the degraded-mode log.
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const bufferDir = path.join(tmpDir, 'buffers-degraded');

    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'degraded.db'),
      bufferEnabled: true,
      bufferDir,
      embeddingEnabled: true,
      port: 0,
    });

    // The collector must have started despite the load failure.
    expect(handle).toBeDefined();
    expect(handle.close).toBeInstanceOf(Function);

    // A degraded-mode startup log must have been emitted.
    const stderrOutput = stderrWrite.mock.calls
      .map((c) => String(c[0]))
      .join('');
    expect(stderrOutput).toMatch(/embedder failed to load/);
    expect(stderrOutput).toMatch(/degraded/);

    // Ingestion + Query saw the same (non-null) handle.
    expect(capturedIngestionDeps).not.toBeNull();
    expect(capturedQueryDeps).not.toBeNull();

    const ingestionEmbedder = capturedIngestionDeps!.embedder;
    const queryEmbedder = capturedQueryDeps!.embedder;

    expect(ingestionEmbedder).not.toBeNull();
    expect(queryEmbedder).not.toBeNull();
    expect(queryEmbedder).toBe(ingestionEmbedder);

    // Both see `isReady() === false` — the permanent degraded state.
    expect((ingestionEmbedder as Embedder).isReady()).toBe(false);
    expect((queryEmbedder as Embedder).isReady()).toBe(false);

    // No BackfillWorker was instantiated because the embedder is not
    // ready. Leaves NULL-embedding records in place until a future
    // daemon start recovers the model (design § degraded-mode).
    expect(createBackfillWorker).not.toHaveBeenCalled();
    expect(capturedBackfillDeps).toBeNull();
    expect(mockBackfillStart).not.toHaveBeenCalled();

    stderrWrite.mockRestore();
    await handle.close();
  });

  it('shutdown stops the BackfillWorker before closing storage', async () => {
    /**
     * **Validates: Requirement 13.6**
     *
     * Shutdown order matters: the BackfillWorker writes embeddings
     * via `storage.putEmbedding`, so the storage handle must still
     * be open while it drains. `handle.close()` must therefore
     * await `backfillWorker.stop(...)` before calling
     * `storage.close()`.
     */
    const callOrder: string[] = [];

    mockBackfillStop.mockImplementation(async () => {
      callOrder.push('backfillWorker.stop');
    });
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

    const bufferDir = path.join(tmpDir, 'buffers-shutdown');

    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'shutdown.db'),
      bufferEnabled: true,
      bufferDir,
      embeddingEnabled: true,
      port: 0,
    });

    // Sanity — backfill worker was actually constructed and started.
    expect(capturedBackfillDeps).not.toBeNull();
    expect(mockBackfillStart).toHaveBeenCalledOnce();

    await handle.close();

    // `backfillWorker.stop` must have run.
    expect(mockBackfillStop).toHaveBeenCalledOnce();

    // And it must have completed before `storage.close`.
    const stopIdx = callOrder.indexOf('backfillWorker.stop');
    const closeIdx = callOrder.indexOf('storage.close');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(stopIdx).toBeLessThan(closeIdx);

    // Full expected ordering — receiver first (stops accepting work),
    // then backfill stop, then buffer-path drains, then storage close.
    expect(callOrder).toEqual([
      'receiver.close',
      'backfillWorker.stop',
      'extraction.drain',
      'watcher.close',
      'storage.close',
    ]);
  });
});
