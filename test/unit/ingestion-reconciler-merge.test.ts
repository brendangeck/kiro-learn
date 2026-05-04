/**
 * Unit tests for `reconcile` — merge path
 * (reconciliation-engine Task 9.3).
 *
 * These tests pin down the Reconciliation Stage's merge-decision
 * commit semantics:
 *
 * - A scripted judge returns `<merge>` citing both cluster
 *   candidates and an existing neighbor. Exactly one Summary Record
 *   is committed with `strategy === 'llm-reconciled'` (Requirement 7.2).
 * - Post-merge DB state: the neighbor is absent from
 *   `listMemoryRecords`; its embedding is absent from
 *   `getEmbedding`; its FTS5 entry is absent from a direct probe;
 *   the Summary Record is readable by its own `record_id`.
 *   (Requirements 6.4, 7.1, 9.1, 9.2, 9.3)
 * - Cluster candidates in a merge are NOT written as standalone
 *   `memory_records` rows; the Summary is the only row produced for
 *   that cluster. (Requirement 6.4)
 * - `source_event_ids` on the Summary Record equals the deduped
 *   first-seen union of every merged entity's `source_event_ids`.
 *   (Requirement 7.3)
 * - `observation_type` on the Summary Record uses the judge's value
 *   when supplied; otherwise falls back to the highest-similarity
 *   merged member's type (Requirement 7.6).
 *
 * All ACP interactions are mocked — no real `kiro-cli` is spawned.
 * The mock `createAcpSession` returns a scripted response from a
 * queue so tests can precisely control the judge's answer.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 9.3
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 6.4, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 9.1, 9.2, 9.3
 */

import Database from 'better-sqlite3';
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

/**
 * Deterministic seeded vector — two candidates with the same seed
 * cluster together, candidates with unrelated seeds stay separate.
 * Unit-normalised so cosine against itself is 1.0.
 */
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
  dbPath: string;
  cleanup: () => Promise<void>;
}

/**
 * Build a reconciliation context with a temp-file SQLite backend and
 * a real QueryLayer so vector lookups go through the same code path
 * as production.
 */
async function makeEnv(options?: {
  neighborSimilarityThreshold?: number;
  intraBatchSimilarityThreshold?: number;
  namespace?: string;
}): Promise<TestEnv> {
  const { openSqliteStorage } = await import('../../src/collector/storage/sqlite/index.js');
  const { createQueryLayer } = await import('../../src/collector/query/index.js');
  const { createReconciliationCircuitBreaker } =
    await import('../../src/collector/ingestion/circuit-breaker.js');

  const tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-reconciler-merge-'));
  const dbPath = join(tmpRoot, 'kiro-learn.db');
  const storage = openSqliteStorage({ dbPath });

  const query = createQueryLayer({ storage, embedder: null });
  const namespace = options?.namespace ?? '/actor/alice/project/p1/';

  const ctx = {
    storage,
    query,
    embedder: null,
    config: {
      intraBatchSimilarityThreshold: options?.intraBatchSimilarityThreshold ?? 0.85,
      neighborSimilarityThreshold: options?.neighborSimilarityThreshold ?? 0.8,
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
    dbPath,
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

/** Direct probe for FTS5 companion rows — bypasses the public API. */
function countFtsRows(dbPath: string, recordId: string): number {
  const probe = new Database(dbPath, { readonly: true });
  try {
    const row = probe
      .prepare<
        [string],
        { c: number }
      >('SELECT COUNT(*) AS c FROM memory_records_fts WHERE record_id = ?')
      .get(recordId);
    return row?.c ?? 0;
  } finally {
    probe.close();
  }
}

/** Compose a minimal `<merge>` XML response citing the given ids. */
function mergeXml(
  ids: string[],
  fields: {
    title: string;
    summary: string;
    facts?: string[];
    concepts?: string[];
    files?: string[];
    observation_type?: string;
  },
): string {
  const idBlocks = ids.map((id) => `<merged_record_id>${id}</merged_record_id>`).join('');
  const factBlocks = (fields.facts ?? []).map((f) => `<fact>${f}</fact>`).join('');
  const conceptBlocks = (fields.concepts ?? []).map((c) => `<concept>${c}</concept>`).join('');
  const fileBlocks = (fields.files ?? []).map((f) => `<file>${f}</file>`).join('');
  const otLine =
    fields.observation_type !== undefined
      ? `<observation_type>${fields.observation_type}</observation_type>`
      : '';
  return `
<merge>
  ${idBlocks}
  <title>${fields.title}</title>
  <summary>${fields.summary}</summary>
  <facts>${factBlocks}</facts>
  <concepts>${conceptBlocks}</concepts>
  <files>${fileBlocks}</files>
  ${otLine}
</merge>
`.trim();
}

beforeEach(() => {
  responseQueue.length = 0;
  mockSessions.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('reconcile — merge path', () => {
  /**
   * Seed one existing neighbor above threshold. The scripted judge
   * returns `<merge>` citing both candidates + the neighbor. Exactly
   * one Summary Record is committed with the expected strategy; the
   * neighbor is deleted from `memory_records`, `embeddings`, and the
   * FTS5 index; the two candidates are NOT written as standalone
   * records.
   */
  it('commits one Summary Record, deletes merged neighbor, leaves no candidate rows', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, storage, dbPath, cleanup } = await makeEnv();
    try {
      // Seed a neighbor in the same namespace with a matching
      // embedding so it surfaces in the neighbor pool.
      const neighbor: MemoryRecord = makeValidRecord({
        record_id: 'mr_01JF8ZS4Y0000000000NEIGHB1',
        namespace: ctx.namespace,
        title: 'Existing neighbor',
        summary: 'Neighbor summary that overlaps with the candidates',
        source_event_ids: ['01JF8ZS4Y0000000000EVENTN1'],
        observation_type: 'decision',
      });
      await storage.putMemoryRecord(neighbor);
      await storage.putEmbedding(neighbor.record_id, seededUnitVec(42));

      // Two candidates — distinct embeddings so they are separate
      // cluster members, both sharing the same centroid region as
      // the neighbor (cluster centroid will be close to seededUnitVec(42)
      // via nearby seeds).
      const candidates: CandidateMemory[] = [
        makeCandidate({
          record_id: 'mr_01JF8ZS4Y0000000000CAND001',
          source_event_ids: ['01JF8ZS4Y0000000000EVENTA1', '01JF8ZS4Y0000000000EVENTA2'],
          title: 'Candidate A',
          embedding: seededUnitVec(42),
        }),
        makeCandidate({
          record_id: 'mr_01JF8ZS4Y0000000000CAND002',
          source_event_ids: [
            '01JF8ZS4Y0000000000EVENTA2', // dup shared with A
            '01JF8ZS4Y0000000000EVENTB1',
          ],
          title: 'Candidate B',
          embedding: seededUnitVec(42),
        }),
      ];

      responseQueue.push(
        mergeXml([candidates[0]!.record_id, candidates[1]!.record_id, neighbor.record_id], {
          title: 'Merged summary',
          summary: 'Merged summary body that replaces all three',
          facts: ['merged fact one', 'merged fact two'],
          concepts: ['merged concept'],
          files: ['src/merged.ts'],
          observation_type: 'pattern',
        }),
      );

      const outcome = await reconcile(candidates, ctx);

      // Outcome counters.
      expect(outcome.mergeDecisions).toBe(1);
      expect(outcome.summaryRecordsCommitted).toBe(1);
      expect(outcome.recordsDeleted).toBe(1); // one neighbor deleted
      expect(outcome.keepSeparateDecisions).toBe(0);
      expect(outcome.keepSeparateCommitted).toBe(0);
      expect(outcome.judgeInvocations).toBe(1);
      expect(outcome.clustersFailed).toBe(0);
      expect(outcome.anyJudgeFailure).toBe(false);

      // Neighbor is gone at every storage level.
      expect(await storage.getEmbedding(neighbor.record_id)).toBeNull();
      const list = await storage.listMemoryRecords({
        namespace: ctx.namespace,
        limit: 100,
        offset: 0,
      });
      expect(list.items.some((r) => r.record_id === neighbor.record_id)).toBe(false);
      expect(countFtsRows(dbPath, neighbor.record_id)).toBe(0);

      // Candidates were NOT written as standalone rows.
      expect(list.items.some((r) => r.record_id === candidates[0]!.record_id)).toBe(false);
      expect(list.items.some((r) => r.record_id === candidates[1]!.record_id)).toBe(false);

      // Exactly one Summary Record is present with the expected
      // strategy and judge-supplied fields.
      const summaries = list.items.filter((r) => r.strategy === 'llm-reconciled');
      expect(summaries).toHaveLength(1);
      const summary = summaries[0]!;
      expect(summary.record_id).toMatch(/^mr_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(summary.namespace).toBe(ctx.namespace);
      expect(summary.title).toBe('Merged summary');
      expect(summary.summary).toBe('Merged summary body that replaces all three');
      expect(summary.facts).toEqual(['merged fact one', 'merged fact two']);
      expect(summary.concepts).toEqual(['merged concept']);
      expect(summary.files_touched).toEqual(['src/merged.ts']);
      expect(summary.observation_type).toBe('pattern');
    } finally {
      await cleanup();
    }
  });

  /**
   * `source_event_ids` on the Summary Record equals the deduped
   * first-seen union of every merged entity's `source_event_ids`.
   * Validates Requirement 7.3.
   */
  it('builds source_event_ids as the deduped first-seen union across merged entities', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, storage, cleanup } = await makeEnv();
    try {
      const neighbor = makeValidRecord({
        record_id: 'mr_01JF8ZS4Y0000000000NEIGHUN',
        namespace: ctx.namespace,
        source_event_ids: [
          '01JF8ZS4Y0000000000EVENTN1',
          '01JF8ZS4Y0000000000EVENTSH', // shared across entities
        ],
      });
      await storage.putMemoryRecord(neighbor);
      await storage.putEmbedding(neighbor.record_id, seededUnitVec(7));

      const candidateA = makeCandidate({
        record_id: 'mr_01JF8ZS4Y0000000000CANDA1X',
        source_event_ids: [
          '01JF8ZS4Y0000000000EVENTA1',
          '01JF8ZS4Y0000000000EVENTSH', // dup
        ],
        embedding: seededUnitVec(7),
      });
      const candidateB = makeCandidate({
        record_id: 'mr_01JF8ZS4Y0000000000CANDB1X',
        source_event_ids: [
          '01JF8ZS4Y0000000000EVENTB1',
          '01JF8ZS4Y0000000000EVENTA1', // dup with A
        ],
        embedding: seededUnitVec(7),
      });

      responseQueue.push(
        mergeXml([candidateA.record_id, candidateB.record_id, neighbor.record_id], {
          title: 'Merged',
          summary: 'Merged summary body',
        }),
      );

      await reconcile([candidateA, candidateB], ctx);

      const list = await storage.listMemoryRecords({
        namespace: ctx.namespace,
        limit: 10,
        offset: 0,
      });
      const summary = list.items.find((r) => r.strategy === 'llm-reconciled');
      expect(summary).toBeDefined();

      // Expected order: follow the merged_record_ids order —
      // candidateA first, then candidateB, then neighbor. Within
      // each, the entity's own source_event_ids order is preserved
      // except where an id was already seen.
      //
      // candidateA: EVENTA1, EVENTSH
      // candidateB: EVENTB1, EVENTA1(dup → skip)
      // neighbor:   EVENTN1, EVENTSH(dup → skip)
      expect(summary!.source_event_ids).toEqual([
        '01JF8ZS4Y0000000000EVENTA1',
        '01JF8ZS4Y0000000000EVENTSH',
        '01JF8ZS4Y0000000000EVENTB1',
        '01JF8ZS4Y0000000000EVENTN1',
      ]);
    } finally {
      await cleanup();
    }
  });

  /**
   * When the judge omits `observation_type`, the Summary Record's
   * `observation_type` falls back to the highest-similarity merged
   * member's type. The cluster member(s) (similarity 1.0) come
   * first in the merged list, so the first member cited supplies
   * the fallback.
   *
   * Validates Requirement 7.6.
   */
  it('falls back to highest-similarity merged member observation_type when judge omits it', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, storage, cleanup } = await makeEnv();
    try {
      const neighbor = makeValidRecord({
        record_id: 'mr_01JF8ZS4Y0000000000NEIGHOT',
        namespace: ctx.namespace,
        observation_type: 'error', // Would be the fallback if cited first.
      });
      await storage.putMemoryRecord(neighbor);
      await storage.putEmbedding(neighbor.record_id, seededUnitVec(11));

      const candidate = makeCandidate({
        record_id: 'mr_01JF8ZS4Y0000000000CANDOT1',
        observation_type: 'discovery', // The expected fallback value.
        embedding: seededUnitVec(11),
      });

      // Judge cites the cluster member FIRST; fallback should pick
      // the candidate's 'discovery' even though the neighbor has a
      // different type.
      responseQueue.push(
        mergeXml([candidate.record_id, neighbor.record_id], {
          title: 'Merged',
          summary: 'Merged summary body',
          // observation_type omitted
        }),
      );

      await reconcile([candidate], ctx);

      const list = await storage.listMemoryRecords({
        namespace: ctx.namespace,
        limit: 10,
        offset: 0,
      });
      const summary = list.items.find((r) => r.strategy === 'llm-reconciled');
      expect(summary).toBeDefined();
      expect(summary!.observation_type).toBe('discovery');
    } finally {
      await cleanup();
    }
  });
});
