/**
 * Unit tests for the {@link IngestionPipeline} orchestration
 * (reconciliation-engine Task 10.2).
 *
 * These tests pin the control-flow branches inside `run(projectId)`:
 *
 * 1. Zero-candidate snapshot → buffer cleared, reconcile never called.
 * 2. Extraction failure → buffer retained, watcher notified `false`,
 *    reconciliation circuit breaker NOT incremented.
 * 3. Feature flag off → direct-commit to storage, buffer cleared,
 *    reconciler never invoked.
 * 4. Circuit breaker open → direct-commit, buffer cleared,
 *    `onRunComplete(pid, false)` closes the breaker.
 * 5. Happy path → reconcile called, buffer cleared only after every
 *    cluster reached a terminal state.
 * 6. All clusters failed → watcher notified `false`, buffer retained.
 * 7. Semaphore — concurrent `run(projectId)` calls respect
 *    `extractionConcurrency`.
 * 8. Structured `ingestion-pipeline-run` log emitted to stderr with
 *    all required fields.
 * 9. `drain(timeoutMs)` waits for in-flight runs.
 *
 * All ACP interactions are mocked — no real `kiro-cli` processes are
 * spawned. The `reconcile` import is mocked per-test so the pipeline's
 * own control flow can be asserted without re-testing the reconciler.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 10.2
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 1.1–1.6, 8.4, 11.1, 12.3, 12.4
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CandidateMemory, StorageBackend } from '../../src/types/index.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';
import type { QueryLayer } from '../../src/collector/query/index.js';
import type { ReconciliationOutcome } from '../../src/collector/ingestion/reconciler.js';

// ── Mock `reconcile` ────────────────────────────────────────────────────
//
// `vi.mock` with a factory that exposes a scriptable spy. Tests set
// `reconcileMock.mockResolvedValueOnce(...)` to script an outcome; the
// default implementation returns a zero-outcome so unscripted tests
// don't crash.

const reconcileMock = vi.fn<
  (
    candidates: readonly CandidateMemory[],
    ctx: unknown,
  ) => Promise<ReconciliationOutcome>
>();

vi.mock('../../src/collector/ingestion/reconciler.js', () => ({
  reconcile: reconcileMock,
}));

// ── Mock `extractCandidates` ────────────────────────────────────────────
//
// The pipeline owns the buffer → candidates fan-out; the tests
// here focus on the pipeline's downstream control flow, so we mock
// `extractCandidates` directly. Default returns empty candidates.

const extractCandidatesMock = vi.fn<
  (entries: readonly BufferEntry[], config: unknown, deps: unknown) => Promise<CandidateMemory[]>
>();

vi.mock('../../src/collector/ingestion/candidate.js', async () => {
  // Preserve the real `toMemoryRecord` — it's a pure stamping
  // function and the direct-commit path needs the real output
  // shape for the record_id round-trip. Only `extractCandidates`
  // is replaced.
  const actual = (await vi.importActual(
    '../../src/collector/ingestion/candidate.js',
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  )) as typeof import('../../src/collector/ingestion/candidate.js');
  return {
    ...actual,
    extractCandidates: extractCandidatesMock,
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a zero-count outcome. Tests override per-field to inject
 * specific decision / failure patterns.
 */
function makeOutcome(partial?: Partial<ReconciliationOutcome>): ReconciliationOutcome {
  return {
    summaryRecordsCommitted: 0,
    recordsDeleted: 0,
    keepSeparateCommitted: 0,
    judgeInvocations: 0,
    mergeDecisions: 0,
    keepSeparateDecisions: 0,
    clustersFailed: 0,
    phaseLatencyMs: {
      clustering: 0,
      neighborLookup: 0,
      judge: 0,
      commit: 0,
    },
    anyJudgeFailure: false,
    ...partial,
  };
}

/**
 * Minimal valid candidate — enough to flow through `toMemoryRecord`
 * without schema errors.
 */
function makeCandidate(overrides: Partial<CandidateMemory> = {}): CandidateMemory {
  return {
    record_id: 'mr_01JF8ZS4Y00000000000000000',
    namespace: '/actor/alice/project/abc/',
    strategy: 'llm-summary',
    source_event_ids: ['01JF8ZS4Y00000000000000001'],
    title: 'Test candidate',
    summary: 'Candidate summary body long enough to satisfy the schema',
    facts: ['fact one'],
    concepts: ['concept'],
    files_touched: ['src/test.ts'],
    observation_type: 'tool_use',
    embedding: null,
    ...overrides,
  };
}

function makeBufferEntry(overrides: Partial<BufferEntry> = {}): BufferEntry {
  return {
    event_id: '01JF8ZS4Y00000000000000001',
    namespace: '/actor/alice/project/abc/',
    kind: 'tool_use',
    body: {
      type: 'json',
      data: { tool_name: 'readFile', tool_input: { path: 'src/x.ts' } },
    },
    timestamp: '2026-04-23T20:00:00.000Z',
    surface: 'kiro-cli',
    ...overrides,
  };
}

/**
 * Mock `StorageBackend` that tracks every write so direct-commit
 * assertions can inspect the call sequence.
 */
function makeMockStorage(): StorageBackend & {
  putMemoryRecord: ReturnType<typeof vi.fn>;
  putEmbedding: ReturnType<typeof vi.fn>;
  deleteMemoryRecord: ReturnType<typeof vi.fn>;
  withTransaction: ReturnType<typeof vi.fn>;
} {
  const stored: Array<{ method: string; args: unknown[] }> = [];
  return {
    putEvent: vi.fn().mockResolvedValue(undefined),
    getEventById: vi.fn().mockResolvedValue(null),
    putMemoryRecord: vi.fn().mockImplementation((...args: unknown[]) => {
      stored.push({ method: 'putMemoryRecord', args });
      return Promise.resolve(undefined);
    }),
    searchMemoryRecords: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({
      total_events: 0,
      total_memories: 0,
      total_projects: 0,
      total_concepts: 0,
      observation_types: {},
      event_kinds: {},
    }),
    listProjects: vi.fn().mockResolvedValue([]),
    listMemoryRecords: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listEvents: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    putEmbedding: vi.fn().mockImplementation((...args: unknown[]) => {
      stored.push({ method: 'putEmbedding', args });
      return Promise.resolve(undefined);
    }),
    getEmbedding: vi.fn().mockResolvedValue(null),
    listEmbeddings: vi.fn().mockResolvedValue([]),
    listRecordsWithoutEmbedding: vi.fn().mockResolvedValue([]),
    searchMemoryRecordsLexical: vi.fn().mockResolvedValue([]),
    deleteMemoryRecord: vi.fn().mockImplementation((...args: unknown[]) => {
      stored.push({ method: 'deleteMemoryRecord', args });
      return Promise.resolve(undefined);
    }),
    withTransaction: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) => {
      // Synchronous no-op tx — tests that cover the merge path
      // do so through `reconcileMock`, which mocks out the real
      // storage calls entirely.
      const tx = {
        putMemoryRecord: vi.fn(),
        putEmbedding: vi.fn(),
        deleteMemoryRecord: vi.fn(),
      };
      const out = fn(tx);
      return Promise.resolve(out);
    }),
  };
}

function makeMockQuery(): QueryLayer & { invalidateNamespace: ReturnType<typeof vi.fn> } {
  return {
    search: vi.fn().mockResolvedValue([]),
    invalidateNamespace: vi.fn(),
    getVectorIndex: vi.fn().mockResolvedValue({ entries: [] }),
    lookupNeighbors: vi.fn().mockResolvedValue([]),
  };
}

let tmpDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const stderrLines: string[] = [];

beforeEach(() => {
  reconcileMock.mockReset();
  extractCandidatesMock.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingestion-pipeline-test-'));
  stderrLines.length = 0;
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
});

afterEach(() => {
  stderrSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Extract the single `ingestion-pipeline-run` JSON-line from stderr.
 * Returns the parsed object or `null` if no such line was emitted.
 */
function parseIngestionLog(): Record<string, unknown> | null {
  for (const line of stderrLines) {
    for (const piece of line.split('\n')) {
      const trimmed = piece.trim();
      if (trimmed.length === 0) continue;
      if (!trimmed.startsWith('{')) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (obj['event'] === 'ingestion-pipeline-run') return obj;
      } catch {
        /* not the line we're looking for */
      }
    }
  }
  return null;
}

const DEFAULT_CONFIG = {
  reconciliationEnabled: true,
  intraBatchSimilarityThreshold: 0.85,
  neighborSimilarityThreshold: 0.8,
  neighborPoolMaxSize: 10,
  judgeModelTimeoutMs: 30_000,
  extractionConcurrency: 2,
  extractionTimeoutMs: 60_000,
  extractionMaxRetries: 3,
  debug: false,
};

// ── Tests ───────────────────────────────────────────────────────────────

describe('IngestionPipeline.run', () => {
  /**
   * Zero-candidate snapshot → buffer cleared, reconcile never called.
   * Validates Requirements 1.2, 8.4.
   */
  it('clears the buffer and skips reconcile on an empty snapshot', async () => {
    const { createIngestionPipeline } = await import(
      '../../src/collector/ingestion/index.js'
    );
    const { createBufferStore } = await import('../../src/collector/buffer/store.js');
    const { createBufferWatcher } = await import('../../src/collector/buffer/watcher.js');
    const { createReconciliationCircuitBreaker } = await import(
      '../../src/collector/ingestion/circuit-breaker.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999 });
    const storage = makeMockStorage();
    const query = makeMockQuery();
    const circuitBreaker = createReconciliationCircuitBreaker();

    const pipeline = createIngestionPipeline({
      bufferStore,
      watcher,
      storage,
      embedder: null,
      query,
      circuitBreaker,
      config: DEFAULT_CONFIG,
    });

    const result = await pipeline.run('empty-project');

    expect(result.eventsProcessed).toBe(0);
    expect(result.candidatesProduced).toBe(0);
    expect(reconcileMock).not.toHaveBeenCalled();
    expect(extractCandidatesMock).not.toHaveBeenCalled();
    expect(storage.putMemoryRecord).not.toHaveBeenCalled();

    watcher.close();
  });

  /**
   * Extraction failure → buffer retained, watcher notified `false`,
   * reconciliation circuit breaker NOT incremented.
   * Validates Requirements 1.3, 12.1, 12.4.
   */
  it('retains buffer and skips circuit breaker on extraction failure', async () => {
    extractCandidatesMock.mockRejectedValue(new Error('compressor timed out'));

    const { createIngestionPipeline } = await import(
      '../../src/collector/ingestion/index.js'
    );
    const { createBufferStore } = await import('../../src/collector/buffer/store.js');
    const { createBufferWatcher } = await import('../../src/collector/buffer/watcher.js');
    const { createReconciliationCircuitBreaker } = await import(
      '../../src/collector/ingestion/circuit-breaker.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999, maxConsecutiveFailures: 5 });
    const storage = makeMockStorage();
    const query = makeMockQuery();
    const circuitBreaker = createReconciliationCircuitBreaker();

    const projectId = 'extract-fail-project';
    await bufferStore.append(projectId, makeBufferEntry());
    watcher.notifyAppend(projectId, 100);

    const pipeline = createIngestionPipeline({
      bufferStore,
      watcher,
      storage,
      embedder: null,
      query,
      circuitBreaker,
      config: DEFAULT_CONFIG,
    });

    const result = await pipeline.run(projectId);

    // Extraction failure returns a zeroed-out result — no writes
    // were attempted.
    expect(result.eventsProcessed).toBe(0);
    expect(result.candidatesProduced).toBe(0);
    expect(result.directCommittedRecords).toBe(0);

    // Buffer remains on disk.
    const snapshot = await bufferStore.snapshot(projectId);
    expect(snapshot).toHaveLength(1);

    // Watcher observed a failure, which drives the extraction-level
    // circuit breaker (not the reconciliation one).
    const state = watcher._getState(projectId);
    expect(state?.consecutiveFailures).toBe(1);

    // Reconciliation breaker untouched.
    expect(circuitBreaker.isOpen(projectId)).toBe(false);
    expect(circuitBreaker._state(projectId)).toEqual({
      consecutiveFailures: 0,
      open: false,
    });

    // Reconciler was never called.
    expect(reconcileMock).not.toHaveBeenCalled();

    watcher.close();
  });

  /**
   * Feature flag off → direct-commit to storage, reconciler never
   * invoked, buffer cleared.
   * Validates Requirement 1.6.
   */
  it('takes the direct-commit path when reconciliation is disabled', async () => {
    const vec = new Float32Array(384);
    vec.fill(0.1);
    const candidates = [
      makeCandidate({
        record_id: 'mr_01JF8ZS4Y00000000000CAND01',
        embedding: vec,
      }),
      makeCandidate({
        record_id: 'mr_01JF8ZS4Y00000000000CAND02',
        embedding: null,
      }),
    ];
    extractCandidatesMock.mockResolvedValue(candidates);

    const { createIngestionPipeline } = await import(
      '../../src/collector/ingestion/index.js'
    );
    const { createBufferStore } = await import('../../src/collector/buffer/store.js');
    const { createBufferWatcher } = await import('../../src/collector/buffer/watcher.js');
    const { createReconciliationCircuitBreaker } = await import(
      '../../src/collector/ingestion/circuit-breaker.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999 });
    const storage = makeMockStorage();
    const query = makeMockQuery();
    const circuitBreaker = createReconciliationCircuitBreaker();

    const projectId = 'flag-off-project';
    await bufferStore.append(projectId, makeBufferEntry());
    watcher.notifyAppend(projectId, 100);

    const pipeline = createIngestionPipeline({
      bufferStore,
      watcher,
      storage,
      embedder: null,
      query,
      circuitBreaker,
      config: { ...DEFAULT_CONFIG, reconciliationEnabled: false },
    });

    const result = await pipeline.run(projectId);

    expect(result.directCommittedRecords).toBe(2);
    expect(result.candidatesProduced).toBe(2);
    expect(result.summaryRecordsCommitted).toBe(0);
    expect(result.mergeDecisions).toBe(0);
    expect(result.keepSeparateDecisions).toBe(0);

    // Two records written, one embedding written (only the
    // non-null candidate had an embedding).
    expect(storage.putMemoryRecord).toHaveBeenCalledTimes(2);
    expect(storage.putEmbedding).toHaveBeenCalledTimes(1);

    // Namespace invalidated on every write — twice per candidate
    // with an embedding (once post-record, once post-embed), once
    // for the null-embedding candidate. Total: 3.
    expect(query.invalidateNamespace).toHaveBeenCalledTimes(3);
    expect(query.invalidateNamespace).toHaveBeenCalledWith('/actor/alice/project/abc/');

    // Reconciler NEVER invoked.
    expect(reconcileMock).not.toHaveBeenCalled();

    // Buffer cleared.
    const snapshot = await bufferStore.snapshot(projectId);
    expect(snapshot).toHaveLength(0);

    watcher.close();
  });

  /**
   * Circuit breaker open → direct-commit, `onRunComplete(pid, false)`
   * re-closes the breaker (Requirement 12.3).
   */
  it('takes the direct-commit path when the circuit breaker is open and re-closes it', async () => {
    extractCandidatesMock.mockResolvedValue([makeCandidate()]);

    const { createIngestionPipeline } = await import(
      '../../src/collector/ingestion/index.js'
    );
    const { createBufferStore } = await import('../../src/collector/buffer/store.js');
    const { createBufferWatcher } = await import('../../src/collector/buffer/watcher.js');
    const { createReconciliationCircuitBreaker } = await import(
      '../../src/collector/ingestion/circuit-breaker.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999 });
    const storage = makeMockStorage();
    const query = makeMockQuery();
    const circuitBreaker = createReconciliationCircuitBreaker(3);

    const projectId = 'breaker-open-project';
    await bufferStore.append(projectId, makeBufferEntry());
    watcher.notifyAppend(projectId, 100);

    // Trip the breaker.
    circuitBreaker.record(projectId, 'failure');
    circuitBreaker.record(projectId, 'failure');
    circuitBreaker.record(projectId, 'failure');
    expect(circuitBreaker.isOpen(projectId)).toBe(true);

    const pipeline = createIngestionPipeline({
      bufferStore,
      watcher,
      storage,
      embedder: null,
      query,
      circuitBreaker,
      config: DEFAULT_CONFIG,
    });

    await pipeline.run(projectId);

    // Reconciler never invoked on this path.
    expect(reconcileMock).not.toHaveBeenCalled();
    // Direct commit happened.
    expect(storage.putMemoryRecord).toHaveBeenCalledTimes(1);
    // Breaker closed — self-heal per Requirement 12.3.
    expect(circuitBreaker.isOpen(projectId)).toBe(false);
    expect(circuitBreaker._state(projectId)).toEqual({
      consecutiveFailures: 0,
      open: false,
    });

    watcher.close();
  });

  /**
   * Happy path → reconcile is called, buffer cleared after every
   * cluster reached a terminal state (committed).
   * Validates Requirements 1.1, 1.4, 8.4.
   */
  it('calls reconcile on the happy path and clears the buffer on success', async () => {
    const candidates = [makeCandidate()];
    extractCandidatesMock.mockResolvedValue(candidates);
    reconcileMock.mockResolvedValue(
      makeOutcome({
        summaryRecordsCommitted: 1,
        mergeDecisions: 1,
        judgeInvocations: 1,
        phaseLatencyMs: { clustering: 1, neighborLookup: 2, judge: 3, commit: 4 },
      }),
    );

    const { createIngestionPipeline } = await import(
      '../../src/collector/ingestion/index.js'
    );
    const { createBufferStore } = await import('../../src/collector/buffer/store.js');
    const { createBufferWatcher } = await import('../../src/collector/buffer/watcher.js');
    const { createReconciliationCircuitBreaker } = await import(
      '../../src/collector/ingestion/circuit-breaker.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999 });
    const storage = makeMockStorage();
    const query = makeMockQuery();
    const circuitBreaker = createReconciliationCircuitBreaker();

    const projectId = 'happy-path-project';
    await bufferStore.append(projectId, makeBufferEntry());
    watcher.notifyAppend(projectId, 100);

    const pipeline = createIngestionPipeline({
      bufferStore,
      watcher,
      storage,
      embedder: null,
      query,
      circuitBreaker,
      config: DEFAULT_CONFIG,
    });

    const result = await pipeline.run(projectId);

    expect(reconcileMock).toHaveBeenCalledTimes(1);
    // The exact candidate list the pipeline received must be passed
    // into `reconcile` unchanged (Property 1 covered separately in
    // the property test file).
    const firstCall = reconcileMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall![0]).toBe(candidates);

    expect(result.summaryRecordsCommitted).toBe(1);
    expect(result.mergeDecisions).toBe(1);
    expect(result.judgeInvocations).toBe(1);
    expect(result.phaseLatencyMs.clustering).toBe(1);

    // Buffer cleared.
    const snapshot = await bufferStore.snapshot(projectId);
    expect(snapshot).toHaveLength(0);

    watcher.close();
  });

  /**
   * All clusters failed → buffer retained, watcher notified `false`.
   * Validates Requirements 1.4, 8.4.
   */
  it('retains the buffer and notifies `false` when every cluster failed', async () => {
    const candidates = [makeCandidate()];
    extractCandidatesMock.mockResolvedValue(candidates);
    reconcileMock.mockResolvedValue(
      makeOutcome({
        clustersFailed: 2,
        anyJudgeFailure: false,
      }),
    );

    const { createIngestionPipeline } = await import(
      '../../src/collector/ingestion/index.js'
    );
    const { createBufferStore } = await import('../../src/collector/buffer/store.js');
    const { createBufferWatcher } = await import('../../src/collector/buffer/watcher.js');
    const { createReconciliationCircuitBreaker } = await import(
      '../../src/collector/ingestion/circuit-breaker.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999, maxConsecutiveFailures: 5 });
    const storage = makeMockStorage();
    const query = makeMockQuery();
    const circuitBreaker = createReconciliationCircuitBreaker();

    const projectId = 'all-failed-project';
    await bufferStore.append(projectId, makeBufferEntry());
    watcher.notifyAppend(projectId, 100);

    const pipeline = createIngestionPipeline({
      bufferStore,
      watcher,
      storage,
      embedder: null,
      query,
      circuitBreaker,
      config: DEFAULT_CONFIG,
    });

    await pipeline.run(projectId);

    // Buffer retained.
    const snapshot = await bufferStore.snapshot(projectId);
    expect(snapshot).toHaveLength(1);

    // Watcher saw a failure.
    const state = watcher._getState(projectId);
    expect(state?.consecutiveFailures).toBe(1);

    watcher.close();
  });

  /**
   * Semaphore — concurrent runs respect `extractionConcurrency`.
   * Validates Requirement 1.5.
   */
  it('caps concurrent runs at extractionConcurrency', async () => {
    // Suspend each extract call on a controllable promise so we
    // can observe the `active` counter while the first two runs
    // are in flight.
    const releasers: Array<(value: CandidateMemory[]) => void> = [];
    extractCandidatesMock.mockImplementation(() =>
      new Promise<CandidateMemory[]>((resolve) => {
        releasers.push(resolve);
      }),
    );
    reconcileMock.mockResolvedValue(makeOutcome());

    const { createIngestionPipeline } = await import(
      '../../src/collector/ingestion/index.js'
    );
    const { createBufferStore } = await import('../../src/collector/buffer/store.js');
    const { createBufferWatcher } = await import('../../src/collector/buffer/watcher.js');
    const { createReconciliationCircuitBreaker } = await import(
      '../../src/collector/ingestion/circuit-breaker.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999 });
    const storage = makeMockStorage();
    const query = makeMockQuery();
    const circuitBreaker = createReconciliationCircuitBreaker();

    // Three distinct projects so each has its own buffer.
    for (const id of ['sem-a', 'sem-b', 'sem-c']) {
      await bufferStore.append(id, makeBufferEntry({ namespace: `/actor/alice/project/${id}/` }));
    }

    const pipeline = createIngestionPipeline({
      bufferStore,
      watcher,
      storage,
      embedder: null,
      query,
      circuitBreaker,
      config: { ...DEFAULT_CONFIG, extractionConcurrency: 2 },
    });

    const runA = pipeline.run('sem-a');
    const runB = pipeline.run('sem-b');
    const runC = pipeline.run('sem-c');

    // Let microtasks settle so semaphore acquisition fires.
    await new Promise((r) => setTimeout(r, 20));
    expect(pipeline.active).toBe(2);

    // Release the first two. Each releaser maps to the
    // extraction call of whichever run grabbed that slot first.
    releasers[0]!([]);
    releasers[1]!([]);
    await runA;
    await runB;

    // Third run can now acquire a slot.
    await new Promise((r) => setTimeout(r, 20));
    expect(pipeline.active).toBeLessThanOrEqual(2);
    // The third extraction's releaser is appended when the run
    // acquires the slot and invokes `extractCandidates`.
    while (releasers.length < 3) {
      await new Promise((r) => setTimeout(r, 10));
    }
    releasers[2]!([]);
    await runC;
    expect(pipeline.active).toBe(0);

    watcher.close();
  });

  /**
   * Structured log emitted with every required field.
   * Validates Requirement 11.1.
   */
  it('emits a structured ingestion-pipeline-run JSON line with all required fields', async () => {
    extractCandidatesMock.mockResolvedValue([makeCandidate()]);
    reconcileMock.mockResolvedValue(
      makeOutcome({
        summaryRecordsCommitted: 1,
        mergeDecisions: 1,
        judgeInvocations: 1,
        recordsDeleted: 2,
        phaseLatencyMs: { clustering: 1, neighborLookup: 2, judge: 3, commit: 4 },
      }),
    );

    const { createIngestionPipeline } = await import(
      '../../src/collector/ingestion/index.js'
    );
    const { createBufferStore } = await import('../../src/collector/buffer/store.js');
    const { createBufferWatcher } = await import('../../src/collector/buffer/watcher.js');
    const { createReconciliationCircuitBreaker } = await import(
      '../../src/collector/ingestion/circuit-breaker.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999 });
    const storage = makeMockStorage();
    const query = makeMockQuery();
    const circuitBreaker = createReconciliationCircuitBreaker();

    const projectId = 'log-shape-project';
    await bufferStore.append(projectId, makeBufferEntry());

    const pipeline = createIngestionPipeline({
      bufferStore,
      watcher,
      storage,
      embedder: null,
      query,
      circuitBreaker,
      config: DEFAULT_CONFIG,
    });

    await pipeline.run(projectId);

    const log = parseIngestionLog();
    expect(log).not.toBeNull();
    expect(log!['event']).toBe('ingestion-pipeline-run');
    expect(log!['project_id']).toBe(projectId);
    expect(log!['namespace']).toBe('/actor/alice/project/abc/');
    expect(log!['events_processed']).toBe(1);
    expect(log!['candidates_produced']).toBe(1);
    expect(log!['clusters_formed']).toBe(1);
    expect(log!['judge_invocations']).toBe(1);
    expect(log!['merge_decisions']).toBe(1);
    expect(log!['keep_separate_decisions']).toBe(0);
    expect(log!['summary_records_committed']).toBe(1);
    expect(log!['records_deleted']).toBe(2);
    expect(log!['direct_committed_records']).toBe(0);
    expect(log!['circuit_breaker_open']).toBe(false);
    expect(log!['reconciliation_enabled']).toBe(true);
    expect(typeof log!['duration_ms']).toBe('number');
    const phase = log!['phase_latency_ms'] as Record<string, number>;
    expect(phase['extraction']).toBeGreaterThanOrEqual(0);
    expect(phase['clustering']).toBe(1);
    expect(phase['neighbor_lookup']).toBe(2);
    expect(phase['judge']).toBe(3);
    expect(phase['commit']).toBe(4);
    // `duration_ms` >= sum of phase latencies (Requirement 11.1 /
    // design note).
    const phaseSum =
      phase['extraction']! +
      phase['clustering']! +
      phase['neighbor_lookup']! +
      phase['judge']! +
      phase['commit']!;
    expect(log!['duration_ms'] as number).toBeGreaterThanOrEqual(phaseSum);

    watcher.close();
  });

  /**
   * `drain(timeoutMs)` waits for in-flight runs to complete.
   */
  it('drain waits for in-flight runs', async () => {
    let release!: (value: CandidateMemory[]) => void;
    extractCandidatesMock.mockImplementation(
      () =>
        new Promise<CandidateMemory[]>((resolve) => {
          release = resolve;
        }),
    );
    reconcileMock.mockResolvedValue(makeOutcome());

    const { createIngestionPipeline } = await import(
      '../../src/collector/ingestion/index.js'
    );
    const { createBufferStore } = await import('../../src/collector/buffer/store.js');
    const { createBufferWatcher } = await import('../../src/collector/buffer/watcher.js');
    const { createReconciliationCircuitBreaker } = await import(
      '../../src/collector/ingestion/circuit-breaker.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999 });
    const storage = makeMockStorage();
    const query = makeMockQuery();
    const circuitBreaker = createReconciliationCircuitBreaker();

    await bufferStore.append('drain-project', makeBufferEntry());

    const pipeline = createIngestionPipeline({
      bufferStore,
      watcher,
      storage,
      embedder: null,
      query,
      circuitBreaker,
      config: DEFAULT_CONFIG,
    });

    const runPromise = pipeline.run('drain-project');

    let drained = false;
    const drainPromise = pipeline.drain(10_000).then(() => {
      drained = true;
    });

    await new Promise((r) => setTimeout(r, 30));
    expect(drained).toBe(false);

    release([]);
    await runPromise;
    await drainPromise;
    expect(drained).toBe(true);

    watcher.close();
  });
});
