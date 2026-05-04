/**
 * Unit tests for `reconcile` — keep-separate path
 * (reconciliation-engine Task 9.4).
 *
 * Covers four distinct keep-separate scenarios:
 *
 * 1. Scripted `<keep_separate/>` response → every cluster member is
 *    committed as a new `memory_record`. No `deleteMemoryRecord` call
 *    is made. (Requirement 6.5)
 *
 * 2. Judge timeout → fall back to keep-separate for the cluster.
 *    The circuit breaker records one failure; the retry budget is
 *    NOT consumed (timeout is terminal per Requirement 6.6 — the
 *    full budget was already burned).
 *
 * 3. Non-XML judge response → retried once with a fresh session.
 *    Second failure also falls back to keep-separate; the circuit
 *    breaker records two failures. (Requirement 12.2)
 *
 * 4. Judge response references an unknown `record_id` → the unknown
 *    id is ignored with a warning. When the known subset of cited
 *    ids is empty, the cluster falls back to keep-separate.
 *
 * All ACP interactions are mocked.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 9.4
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 6.5, 6.6, 6.7, 12.1, 12.2
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CandidateMemory, MemoryRecord, StorageBackend } from '../../src/types/index.js';
import type { ReconciliationContext } from '../../src/collector/ingestion/reconciler.js';
import { makeValidRecord } from '../helpers/fixtures.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

const responseQueue: Array<string | Error> = [];
const mockSessions: Array<{
  sendPrompt: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() => {
    const response = responseQueue.shift();
    const session = {
      sendPrompt: vi.fn(() => {
        if (response instanceof Error) return Promise.reject(response);
        return Promise.resolve(response ?? '');
      }),
      destroy: vi.fn(),
    };
    mockSessions.push(session);
    return Promise.resolve(session);
  }),
}));

// ── Helpers ─────────────────────────────────────────────────────────────

function seededUnitVec(seed: number): Float32Array {
  const vec = new Float32Array(384);
  let norm = 0;
  for (let i = 0; i < 384; i += 1) {
    vec[i] = Math.sin((seed + 1) * (i + 1));
    norm += (vec[i] as number) * (vec[i] as number);
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < 384; i += 1) {
    vec[i] = (vec[i] as number) * inv;
  }
  return vec;
}

function makeCandidate(overrides: Partial<CandidateMemory> = {}): CandidateMemory {
  return {
    record_id: 'mr_01JF8ZS4Y00000000000000000',
    namespace: '/actor/alice/project/p1/',
    strategy: 'llm-summary',
    source_event_ids: ['01JF8ZS4Y00000000000000001'],
    title: 'Default',
    summary: 'Default summary',
    facts: ['default fact'],
    concepts: ['default concept'],
    files_touched: ['src/default.ts'],
    observation_type: 'tool_use',
    embedding: seededUnitVec(1),
    ...overrides,
  };
}

interface TestEnv {
  ctx: ReconciliationContext;
  storage: StorageBackend;
  cleanup: () => Promise<void>;
}

async function makeEnv(): Promise<TestEnv> {
  const { openSqliteStorage } = await import('../../src/collector/storage/sqlite/index.js');
  const { createQueryLayer } = await import('../../src/collector/query/index.js');
  const { createReconciliationCircuitBreaker } =
    await import('../../src/collector/ingestion/circuit-breaker.js');

  const tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-reconciler-ks-'));
  const dbPath = join(tmpRoot, 'kiro-learn.db');
  const storage = openSqliteStorage({ dbPath });
  const query = createQueryLayer({ storage, embedder: null });

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
    namespace: '/actor/alice/project/p1/',
  };

  return {
    ctx,
    storage,
    cleanup: async () => {
      try {
        await storage.close();
      } catch {
        /* swallow cleanup errors */
      }
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Seed a neighbor above threshold so the cluster gets a non-empty
 * neighbor pool — otherwise the judge is never invoked and the test
 * would not exercise the keep-separate decision paths.
 */
async function seedNeighbor(
  storage: StorageBackend,
  namespace: string,
  seed: number,
): Promise<MemoryRecord> {
  const neighbor = makeValidRecord({
    record_id: 'mr_01JF8ZS4Y0000000000NEIGHB1',
    namespace,
    title: 'Existing neighbor',
  });
  await storage.putMemoryRecord(neighbor);
  await storage.putEmbedding(neighbor.record_id, seededUnitVec(seed));
  return neighbor;
}

beforeEach(() => {
  responseQueue.length = 0;
  mockSessions.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('reconcile — keep-separate path', () => {
  /**
   * Judge explicitly returns `<keep_separate/>` → every cluster
   * member is committed as a standalone record. No
   * `deleteMemoryRecord` is called; the pre-existing neighbor
   * survives untouched.
   */
  it('commits every cluster member on <keep_separate/> and never calls deleteMemoryRecord', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, storage, cleanup } = await makeEnv();
    const deleteSpy = vi.spyOn(storage, 'deleteMemoryRecord');
    try {
      const neighbor = await seedNeighbor(storage, ctx.namespace, 42);

      const candidates: CandidateMemory[] = [
        makeCandidate({
          record_id: 'mr_01JF8ZS4Y0000000000CANDKS1',
          title: 'Cluster member one',
          embedding: seededUnitVec(42),
        }),
        makeCandidate({
          record_id: 'mr_01JF8ZS4Y0000000000CANDKS2',
          title: 'Cluster member two',
          embedding: seededUnitVec(42),
        }),
      ];

      responseQueue.push('<keep_separate/>');

      const outcome = await reconcile(candidates, ctx);

      expect(outcome.keepSeparateDecisions).toBe(1);
      expect(outcome.keepSeparateCommitted).toBe(2);
      expect(outcome.mergeDecisions).toBe(0);
      expect(outcome.summaryRecordsCommitted).toBe(0);
      expect(outcome.recordsDeleted).toBe(0);
      expect(outcome.judgeInvocations).toBe(1);
      expect(outcome.anyJudgeFailure).toBe(false);

      // No delete calls.
      expect(deleteSpy).not.toHaveBeenCalled();

      // Both candidates committed.
      const list = await storage.listMemoryRecords({
        namespace: ctx.namespace,
        limit: 100,
        offset: 0,
      });
      for (const c of candidates) {
        expect(list.items.some((r) => r.record_id === c.record_id)).toBe(true);
      }
      // Neighbor still present.
      expect(list.items.some((r) => r.record_id === neighbor.record_id)).toBe(true);

      // Circuit breaker recorded a success.
      expect(ctx.circuitBreaker._state(ctx.projectId)).toEqual({
        consecutiveFailures: 0,
        open: false,
      });
    } finally {
      deleteSpy.mockRestore();
      await cleanup();
    }
  });

  /**
   * Judge session times out → fall back to keep-separate. One
   * failure is recorded on the circuit breaker. Retry is NOT
   * attempted (timeout is terminal, Req 6.6).
   */
  it('falls back to keep-separate on judge timeout and records one circuit-breaker failure', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, storage, cleanup } = await makeEnv();
    try {
      await seedNeighbor(storage, ctx.namespace, 42);

      const candidates: CandidateMemory[] = [
        makeCandidate({
          record_id: 'mr_01JF8ZS4Y0000000000CANDTM1',
          title: 'Cluster member one',
          embedding: seededUnitVec(42),
        }),
      ];

      // Reject with a timeout-labelled error — the reconciler
      // recognises "timed out" substring.
      responseQueue.push(new Error('ACP session timed out after 30000ms'));

      const outcome = await reconcile(candidates, ctx);

      // Keep-separate fallback fired.
      expect(outcome.keepSeparateDecisions).toBe(1);
      expect(outcome.keepSeparateCommitted).toBe(1);
      expect(outcome.mergeDecisions).toBe(0);
      // Exactly one judge invocation (timeout is terminal, no retry).
      expect(outcome.judgeInvocations).toBe(1);
      expect(outcome.anyJudgeFailure).toBe(true);

      // Circuit breaker recorded one failure.
      expect(ctx.circuitBreaker._state(ctx.projectId)).toEqual({
        consecutiveFailures: 1,
        open: false,
      });

      // Candidate was committed.
      const list = await storage.listMemoryRecords({
        namespace: ctx.namespace,
        limit: 10,
        offset: 0,
      });
      expect(list.items.some((r) => r.record_id === candidates[0]!.record_id)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  /**
   * Non-XML judge response → retried once with a fresh session. On
   * the second parse failure, the cluster falls back to
   * keep-separate; two failures land on the circuit breaker.
   * Two distinct ACP sessions were created (one per attempt).
   */
  it('retries once on non-XML response and records two failures on double-failure', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, storage, cleanup } = await makeEnv();
    try {
      await seedNeighbor(storage, ctx.namespace, 42);

      const candidates: CandidateMemory[] = [
        makeCandidate({
          record_id: 'mr_01JF8ZS4Y0000000000CANDXM1',
          title: 'Cluster member one',
          embedding: seededUnitVec(42),
        }),
      ];

      // Both attempts return conversational garbage that
      // `parseJudgeResponse` will reject with null.
      responseQueue.push('I think these are different. Keep them separate.');
      responseQueue.push('Actually no, please merge them together.');

      const outcome = await reconcile(candidates, ctx);

      expect(outcome.keepSeparateDecisions).toBe(1);
      expect(outcome.keepSeparateCommitted).toBe(1);
      // Two invocations: initial + one retry.
      expect(outcome.judgeInvocations).toBe(2);
      expect(outcome.anyJudgeFailure).toBe(true);

      // Two distinct sessions, each destroyed.
      expect(mockSessions).toHaveLength(2);
      for (const s of mockSessions) {
        expect(s.destroy).toHaveBeenCalledTimes(1);
      }

      // Circuit breaker recorded both failures.
      expect(ctx.circuitBreaker._state(ctx.projectId)).toEqual({
        consecutiveFailures: 2,
        open: false,
      });
    } finally {
      await cleanup();
    }
  });

  /**
   * Judge cites ONLY unknown `record_id` values → after filtering,
   * the known-subset is empty. The reconciler falls back to
   * keep-separate rather than committing an empty merge.
   */
  it('falls back to keep-separate when the judge cites only unknown record_ids', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, storage, cleanup } = await makeEnv();
    try {
      await seedNeighbor(storage, ctx.namespace, 42);

      const candidates: CandidateMemory[] = [
        makeCandidate({
          record_id: 'mr_01JF8ZS4Y0000000000CANDUK1',
          title: 'Cluster member one',
          embedding: seededUnitVec(42),
        }),
      ];

      // Merge response citing a record_id that matches neither the
      // cluster member nor the seeded neighbor.
      responseQueue.push(
        `
<merge>
  <merged_record_id>mr_01JF8ZS4Y0000000000UNKNOWNA</merged_record_id>
  <merged_record_id>mr_01JF8ZS4Y0000000000UNKNOWNB</merged_record_id>
  <title>Hallucinated merge</title>
  <summary>The judge invented these ids entirely.</summary>
  <facts></facts>
  <concepts></concepts>
  <files></files>
</merge>
`.trim(),
      );

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const outcome = await reconcile(candidates, ctx);

      // Fallback to keep-separate — decisions counter reflects
      // that the final decision was keep-separate even though the
      // judge's literal response was a merge.
      expect(outcome.keepSeparateDecisions).toBe(1);
      expect(outcome.keepSeparateCommitted).toBe(1);
      expect(outcome.mergeDecisions).toBe(0);
      expect(outcome.summaryRecordsCommitted).toBe(0);
      expect(outcome.recordsDeleted).toBe(0);
      // Judge invocation was successful (we got a parseable
      // response) — it just cited garbage ids. Circuit breaker
      // records success, not failure.
      expect(outcome.judgeInvocations).toBe(1);
      expect(outcome.anyJudgeFailure).toBe(false);
      expect(ctx.circuitBreaker._state(ctx.projectId)).toEqual({
        consecutiveFailures: 0,
        open: false,
      });

      // Warnings were emitted per unknown id + one for the
      // no-known-ids fallback.
      const warnings = stderrSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((m) => m.includes('reconciler:'));
      expect(warnings.filter((w) => w.includes('unknown record_id')).length).toBe(2);
      expect(warnings.some((w) => w.includes('cited no known record_ids'))).toBe(true);

      // Candidate was committed as a standalone record.
      const list = await storage.listMemoryRecords({
        namespace: ctx.namespace,
        limit: 10,
        offset: 0,
      });
      expect(list.items.some((r) => r.record_id === candidates[0]!.record_id)).toBe(true);

      stderrSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });
});
