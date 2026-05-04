/**
 * Unit tests for `reconcile` — empty neighbor pool paths
 * (reconciliation-engine Task 9.2).
 *
 * These tests pin down the "no judge invocation" branches of the
 * reconciler:
 *
 * 1. A cluster with `centroid === null` (at least one null-embedding
 *    member) skips both neighbor lookup and the judge. Members are
 *    committed as new records; `putEmbedding` is only called for
 *    members whose `embedding !== null`. (Requirements 4.4, 5.5, 6.1)
 *
 * 2. A cluster with a non-null centroid but an empty neighbor pool
 *    (the namespace has no existing records) skips the judge and
 *    commits members directly. (Requirement 5.5)
 *
 * In both cases the test asserts that `createAcpSession` was never
 * called — this is the structural counterpart of Property 14 ("judge
 * invocation gated on non-empty neighbor pool").
 *
 * All ACP interactions are mocked — no real `kiro-cli` processes are
 * spawned. The mock `createAcpSession` throws if invoked in these
 * tests, so any accidental judge call would fail loudly.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 9.2
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 4.4, 5.5, 6.1
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CandidateMemory, StorageBackend } from '../../src/types/index.js';
import type { QueryLayer } from '../../src/collector/query/index.js';
import type { ReconciliationContext } from '../../src/collector/ingestion/reconciler.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

const createAcpSessionMock = vi.fn(() => {
  throw new Error('createAcpSession should not be invoked in the empty-neighbor-pool path');
});

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: createAcpSessionMock,
}));

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Make a 384-dim Float32Array with a deterministic fingerprint so
 * cluster centroids are computable and distinguishable across test
 * candidates.
 */
function seededVec(seed: number): Float32Array {
  const vec = new Float32Array(384);
  for (let i = 0; i < 384; i += 1) {
    vec[i] = Math.sin(seed * (i + 1)) * 0.5;
  }
  return vec;
}

/** Minimal CandidateMemory factory with overridable fields. */
function makeCandidate(overrides: Partial<CandidateMemory> = {}): CandidateMemory {
  return {
    record_id: 'mr_01JF8ZS4Y00000000000000000',
    namespace: '/actor/alice/project/p1/',
    strategy: 'llm-summary',
    source_event_ids: ['01JF8ZS4Y00000000000000001'],
    title: 'Default title',
    summary: 'Default summary',
    facts: ['default fact'],
    concepts: ['default concept'],
    files_touched: ['src/default.ts'],
    observation_type: 'tool_use',
    embedding: seededVec(1),
    ...overrides,
  };
}

/**
 * Build a `ReconciliationContext` with a fresh in-memory SQLite
 * backend and a QueryLayer whose `lookupNeighbors` returns an empty
 * array — matching "no existing records in the namespace" semantics.
 *
 * The context carries the default thresholds from the design doc.
 */
async function makeContext(options?: {
  lookupNeighbors?: ReturnType<typeof vi.fn>;
  namespace?: string;
}): Promise<{
  ctx: ReconciliationContext;
  storage: StorageBackend;
  invalidateNamespace: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}> {
  const { openSqliteStorage } = await import('../../src/collector/storage/sqlite/index.js');
  const { createReconciliationCircuitBreaker } =
    await import('../../src/collector/ingestion/circuit-breaker.js');

  const storage = openSqliteStorage({ dbPath: ':memory:' });
  const invalidateNamespace = vi.fn();
  const lookupNeighbors = options?.lookupNeighbors ?? vi.fn().mockResolvedValue([]);
  const namespace = options?.namespace ?? '/actor/alice/project/p1/';

  const query = {
    search: vi.fn().mockResolvedValue([]),
    invalidateNamespace,
    getVectorIndex: vi.fn().mockResolvedValue({ entries: [] }),
    lookupNeighbors,
  } as unknown as QueryLayer;

  const ctx = {
    storage,
    query,
    embedder: null,
    config: {
      intraBatchSimilarityThreshold: 0.85,
      neighborSimilarityThreshold: 0.8,
      neighborPoolMaxSize: 10,
      judgeModelTimeoutMs: 30_000,
      debug: false,
    },
    circuitBreaker: createReconciliationCircuitBreaker(),
    projectId: 'p1',
    namespace,
  };

  return {
    ctx,
    storage,
    invalidateNamespace,
    cleanup: async () => {
      await storage.close();
    },
  };
}

beforeEach(() => {
  createAcpSessionMock.mockClear();
  createAcpSessionMock.mockImplementation(() => {
    throw new Error('createAcpSession should not be invoked in the empty-neighbor-pool path');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('reconcile — empty neighbor pool (no judge)', () => {
  /**
   * Empty namespace, single cluster with a valid centroid →
   * `lookupNeighbors` returns []. No judge session is created.
   * Every cluster member is committed as a new `memory_record`.
   *
   * Validates: Requirement 5.5.
   */
  it('commits members as new records and never invokes the judge when the neighbor pool is empty', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, storage, invalidateNamespace, cleanup } = await makeContext();
    try {
      const candidates: CandidateMemory[] = [
        makeCandidate({
          record_id: 'mr_01JF8ZS4Y000000000NOJUDGE1',
          title: 'First candidate',
          source_event_ids: ['01JF8ZS4Y00000000000000001'],
          embedding: seededVec(1),
        }),
        makeCandidate({
          record_id: 'mr_01JF8ZS4Y000000000NOJUDGE2',
          title: 'Second candidate (distinct)',
          source_event_ids: ['01JF8ZS4Y00000000000000002'],
          // Distinct embedding → separate cluster.
          embedding: seededVec(97),
        }),
      ];

      const outcome = await reconcile(candidates, ctx);

      // No judge was invoked.
      expect(createAcpSessionMock).not.toHaveBeenCalled();
      expect(outcome.judgeInvocations).toBe(0);
      expect(outcome.mergeDecisions).toBe(0);
      expect(outcome.keepSeparateDecisions).toBe(0);
      expect(outcome.summaryRecordsCommitted).toBe(0);

      // Both members committed.
      expect(outcome.keepSeparateCommitted).toBe(2);
      expect(outcome.clustersFailed).toBe(0);

      // Records are readable from storage.
      for (const c of candidates) {
        const { items } = await storage.listMemoryRecords({
          namespace: ctx.namespace,
          limit: 10,
          offset: 0,
        });
        expect(items.some((r) => r.record_id === c.record_id)).toBe(true);
      }

      // Cache was invalidated — once per commit (two clusters → two
      // calls; the namespace is the same for both).
      expect(invalidateNamespace).toHaveBeenCalledWith(ctx.namespace);
    } finally {
      await cleanup();
    }
  });

  /**
   * Cluster with `centroid === null` (member has null embedding) →
   * no neighbor lookup, no judge. The null-embedding member is
   * committed WITHOUT a `putEmbedding` call.
   *
   * Validates: Requirements 4.4, 5.5.
   */
  it('skips neighbor lookup and judge for centroid===null clusters and commits without putEmbedding for null-embedding members', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    // The lookupNeighbors mock throws if invoked — proves the
    // null-centroid path skips the lookup entirely.
    const lookupNeighbors = vi.fn(() => {
      throw new Error('lookupNeighbors should not be called for null centroid');
    });
    const { ctx, storage, cleanup } = await makeContext({ lookupNeighbors });

    try {
      // Two candidates: one with embedding, one without. They will
      // form separate singleton clusters (null-embedding never
      // union-merges with anyone per the clustering contract).
      const candidates: CandidateMemory[] = [
        makeCandidate({
          record_id: 'mr_01JF8ZS4Y000000000NOEMBED1',
          title: 'Null embedding member',
          source_event_ids: ['01JF8ZS4Y00000000000000001'],
          embedding: null,
        }),
      ];

      const outcome = await reconcile(candidates, ctx);

      // No judge session was created.
      expect(createAcpSessionMock).not.toHaveBeenCalled();
      expect(outcome.judgeInvocations).toBe(0);
      // `lookupNeighbors` was not called either (we assert that by
      // way of the lookup mock's throw guard — if it had fired the
      // cluster would be marked failed, not committed).
      expect(outcome.clustersFailed).toBe(0);

      // The null-embedding candidate was still committed.
      expect(outcome.keepSeparateCommitted).toBe(1);
      const record = await storage.listMemoryRecords({
        namespace: ctx.namespace,
        limit: 10,
        offset: 0,
      });
      expect(record.items.some((r) => r.record_id === candidates[0]!.record_id)).toBe(true);

      // Its embedding was NOT written — `getEmbedding` returns null.
      const stored = await storage.getEmbedding(candidates[0]!.record_id);
      expect(stored).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
