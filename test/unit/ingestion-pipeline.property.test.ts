/**
 * Property-based tests for the {@link IngestionPipeline} stage
 * composition and buffer-clear discipline
 * (reconciliation-engine Task 10.3).
 *
 * Properties validated:
 *
 * - **P1 (Pipeline stage composition):** for any buffer snapshot and
 *   any candidate list produced by the Extraction Stage, the list
 *   passed into `reconcile(...)` is the exact same reference,
 *   element-for-element in the same order, with no mutation.
 * - **P2 (Buffer-clear discipline):** the buffer is cleared iff
 *   extraction succeeded AND at least one cluster reached a terminal
 *   state (committed or deliberately dropped). It is NOT cleared
 *   when extraction threw OR when every cluster failed.
 *
 * Each property runs 100 iterations via `fast-check`. The pipeline
 * is exercised against a real `BufferStore` (temp directory),
 * `BufferWatcher`, and `QueryLayer`; `extractCandidates` and
 * `reconcile` are mocked so we can inject specific outcomes.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 10.3
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 8.4
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CandidateMemory, StorageBackend } from '../../src/types/index.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';
import type { QueryLayer } from '../../src/collector/query/index.js';
import type { ReconciliationOutcome } from '../../src/collector/ingestion/reconciler.js';

// ── Mock seam ───────────────────────────────────────────────────────────

const reconcileMock = vi.fn<
  (
    candidates: readonly CandidateMemory[],
    ctx: unknown,
  ) => Promise<ReconciliationOutcome>
>();

const extractCandidatesMock = vi.fn<
  (entries: readonly BufferEntry[], config: unknown, deps: unknown) => Promise<CandidateMemory[]>
>();

vi.mock('../../src/collector/ingestion/reconciler.js', () => ({
  reconcile: reconcileMock,
}));

vi.mock('../../src/collector/ingestion/candidate.js', async () => {
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

function makeCandidate(seed: number): CandidateMemory {
  return {
    record_id: `mr_01JF8ZS4Y0000000000CAN${String(seed).padStart(5, '0')}`,
    namespace: '/actor/alice/project/propX/',
    strategy: 'llm-summary',
    source_event_ids: [`01JF8ZS4Y000000000EV${String(seed).padStart(6, '0')}`],
    title: `Candidate ${String(seed)}`,
    summary: `Summary body for candidate number ${String(seed)} long enough for schema`,
    facts: [`fact ${String(seed)}`],
    concepts: [`concept ${String(seed)}`],
    files_touched: [`src/file${String(seed)}.ts`],
    observation_type: 'tool_use',
    embedding: null,
  };
}

function makeBufferEntry(seed: number): BufferEntry {
  // ULID alphabet is Crockford base32 — map `seed` into padded
  // digits so we always satisfy the schema regex.
  const id = `01JF8ZS4Y000000000EV${String(seed).padStart(6, '0')}`;
  return {
    event_id: id,
    namespace: '/actor/alice/project/propX/',
    kind: 'tool_use',
    body: {
      type: 'json',
      data: { tool_name: 'readFile', tool_input: { path: `src/x${String(seed)}.ts` } },
    },
    timestamp: '2026-04-23T20:00:00.000Z',
    surface: 'kiro-cli',
  };
}

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

function makeMockStorage(): StorageBackend {
  return {
    putEvent: vi.fn().mockResolvedValue(undefined),
    getEventById: vi.fn().mockResolvedValue(null),
    putMemoryRecord: vi.fn().mockResolvedValue(undefined),
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
    putEmbedding: vi.fn().mockResolvedValue(undefined),
    getEmbedding: vi.fn().mockResolvedValue(null),
    listEmbeddings: vi.fn().mockResolvedValue([]),
    listRecordsWithoutEmbedding: vi.fn().mockResolvedValue([]),
    searchMemoryRecordsLexical: vi.fn().mockResolvedValue([]),
    deleteMemoryRecord: vi.fn().mockResolvedValue(undefined),
    withTransaction: vi
      .fn()
      .mockImplementation((fn: (tx: unknown) => unknown) =>
        Promise.resolve(
          fn({
            putMemoryRecord: vi.fn(),
            putEmbedding: vi.fn(),
            deleteMemoryRecord: vi.fn(),
          }),
        ),
      ),
  };
}

function makeMockQuery(): QueryLayer {
  return {
    search: vi.fn().mockResolvedValue([]),
    invalidateNamespace: vi.fn(),
    getVectorIndex: vi.fn().mockResolvedValue({ entries: [] }),
    lookupNeighbors: vi.fn().mockResolvedValue([]),
  };
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

let tmpDir: string;

beforeEach(() => {
  reconcileMock.mockReset();
  extractCandidatesMock.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingestion-pipeline-prop-'));
  // Silence stderr noise from the structured log during property
  // runs. Tests inspect the buffer state, not the log content.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Arbitraries ─────────────────────────────────────────────────────────

/**
 * Small distinct seeds so the `record_id` / `event_id` slots stay
 * valid ULIDs after padding. We keep the set ≤ 8 to bound test
 * runtime.
 */
const arbSeeds = fc.uniqueArray(fc.integer({ min: 0, max: 99_999 }), {
  minLength: 1,
  maxLength: 8,
});

// ── P1: Pipeline stage composition ──────────────────────────────────────

describe('IngestionPipeline — Property 1: stage composition', () => {
  it('passes the exact candidate list from extraction into reconcile (same reference, same order)', async () => {
    const { createIngestionPipeline } = await import(
      '../../src/collector/ingestion/index.js'
    );
    const { createBufferStore } = await import('../../src/collector/buffer/store.js');
    const { createBufferWatcher } = await import('../../src/collector/buffer/watcher.js');
    const { createReconciliationCircuitBreaker } = await import(
      '../../src/collector/ingestion/circuit-breaker.js'
    );

    await fc.assert(
      fc.asyncProperty(arbSeeds, async (seeds) => {
        reconcileMock.mockReset();
        extractCandidatesMock.mockReset();

        const candidates = seeds.map(makeCandidate);
        extractCandidatesMock.mockResolvedValue(candidates);
        reconcileMock.mockResolvedValue(
          makeOutcome({
            summaryRecordsCommitted: 1,
            keepSeparateCommitted: 1,
            mergeDecisions: 0,
            keepSeparateDecisions: 1,
          }),
        );

        const bufferStore = createBufferStore(tmpDir);
        const watcher = createBufferWatcher({ idleMs: 999_999 });
        const storage = makeMockStorage();
        const query = makeMockQuery();
        const circuitBreaker = createReconciliationCircuitBreaker();

        const projectId = `proj-${String(seeds[0]!)}`;
        await bufferStore.append(projectId, makeBufferEntry(seeds[0]!));

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

        // Exactly one reconcile call per run.
        expect(reconcileMock).toHaveBeenCalledTimes(1);
        const call = reconcileMock.mock.calls[0];
        const passedIn = call![0] as readonly CandidateMemory[];

        // Same reference, same length, same element identity in
        // the same order. Reference equality is the strongest
        // form of "no mutation, no copy" — satisfies Property 1.
        expect(passedIn).toBe(candidates);
        expect(passedIn.length).toBe(candidates.length);
        for (let i = 0; i < candidates.length; i += 1) {
          expect(passedIn[i]).toBe(candidates[i]);
        }

        watcher.close();
        // Clean up any residual buffer for the next iteration.
        await bufferStore.clear(projectId).catch(() => undefined);
      }),
      { numRuns: 100 },
    );
  });
});

// ── P2: Buffer-clear discipline ─────────────────────────────────────────

describe('IngestionPipeline — Property 2: buffer-clear discipline', () => {
  it('clears the buffer iff extraction succeeded AND at least one cluster reached a terminal state', async () => {
    const { createIngestionPipeline } = await import(
      '../../src/collector/ingestion/index.js'
    );
    const { createBufferStore } = await import('../../src/collector/buffer/store.js');
    const { createBufferWatcher } = await import('../../src/collector/buffer/watcher.js');
    const { createReconciliationCircuitBreaker } = await import(
      '../../src/collector/ingestion/circuit-breaker.js'
    );

    /**
     * Three extraction modes × three reconciliation outcome modes:
     *
     * extraction:
     *   - 'throw'   — buffer retained
     *   - 'empty'   — zero candidates; buffer cleared regardless
     *   - 'ok'      — non-empty candidates flow into reconcile
     *
     * outcome:
     *   - 'committed'  — at least one commit → buffer cleared
     *   - 'all-failed' — every cluster failed → buffer retained
     *   - 'mixed'      — some committed, some failed → buffer cleared
     */
    const arbExtraction = fc.constantFrom(
      'throw' as const,
      'empty' as const,
      'ok' as const,
    );
    const arbOutcome = fc.constantFrom(
      'committed' as const,
      'all-failed' as const,
      'mixed' as const,
    );

    await fc.assert(
      fc.asyncProperty(
        arbExtraction,
        arbOutcome,
        arbSeeds,
        async (extraction, outcomeKind, seeds) => {
          reconcileMock.mockReset();
          extractCandidatesMock.mockReset();

          // Scripted extraction.
          if (extraction === 'throw') {
            extractCandidatesMock.mockRejectedValue(
              new Error('synthetic extraction failure'),
            );
          } else if (extraction === 'empty') {
            extractCandidatesMock.mockResolvedValue([]);
          } else {
            extractCandidatesMock.mockResolvedValue(seeds.map(makeCandidate));
          }

          // Scripted outcome (only used when extraction='ok').
          if (outcomeKind === 'committed') {
            reconcileMock.mockResolvedValue(
              makeOutcome({
                summaryRecordsCommitted: 1,
                mergeDecisions: 1,
              }),
            );
          } else if (outcomeKind === 'all-failed') {
            reconcileMock.mockResolvedValue(
              makeOutcome({ clustersFailed: 2 }),
            );
          } else {
            reconcileMock.mockResolvedValue(
              makeOutcome({
                keepSeparateCommitted: 1,
                clustersFailed: 1,
                keepSeparateDecisions: 1,
              }),
            );
          }

          const bufferStore = createBufferStore(tmpDir);
          const watcher = createBufferWatcher({
            idleMs: 999_999,
            maxConsecutiveFailures: 999,
          });
          const storage = makeMockStorage();
          const query = makeMockQuery();
          const circuitBreaker = createReconciliationCircuitBreaker();

          const projectId = `buf-${String(seeds[0]!)}-${extraction}-${outcomeKind}`;
          // Seed one buffer entry so the buffer exists on disk —
          // we check after the run whether it was cleared.
          await bufferStore.append(projectId, makeBufferEntry(seeds[0]!));

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

          const snapshot = await bufferStore.snapshot(projectId);
          const cleared = snapshot.length === 0;

          // Expected clear condition.
          let expectedCleared: boolean;
          if (extraction === 'throw') {
            expectedCleared = false;
          } else if (extraction === 'empty') {
            expectedCleared = true;
          } else {
            // extraction === 'ok'
            if (outcomeKind === 'all-failed') {
              expectedCleared = false;
            } else {
              // 'committed' or 'mixed' — at least one cluster
              // reached terminal state.
              expectedCleared = true;
            }
          }

          expect(cleared).toBe(expectedCleared);

          watcher.close();
          // Reset the buffer for the next iteration (if not
          // already cleared) so state from one run does not leak
          // into the next. Ignore errors; file may not exist.
          await bufferStore.clear(projectId).catch(() => undefined);
        },
      ),
      { numRuns: 100 },
    );
  });
});
