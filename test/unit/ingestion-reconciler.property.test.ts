/**
 * Property-based tests for the Reconciliation Stage commit semantics —
 * Properties 14, 15, 16, 17, 19, and 20 from the reconciliation-engine
 * design (Task 9.6).
 *
 * Each property runs 100 iterations via `fast-check`. The test
 * environment uses a real in-memory SQLite backend and a real
 * {@link QueryLayer}, but mocks the `createAcpSession` surface so no
 * `kiro-cli` processes are spawned. The scripted judge consumes a
 * response queue set up by each test, so different properties can
 * inject different judge behaviours while sharing the same harness.
 *
 * Properties validated:
 *
 * - **P14 (Judge invocation gated on non-empty neighbor pool):** the
 *   number of ACP sessions created to `kiro-learn-reconciler` equals
 *   the number of clusters whose neighbor pool is non-empty.
 *   Clusters with `centroid === null` and clusters with empty
 *   neighbor pools NEVER invoke the judge.
 * - **P15 (Merge commit semantics):** every merged id is absent
 *   from `getMemoryRecord` and its embedding after commit; the
 *   summary is readable; no row outside the merged set is touched.
 * - **P16 (Keep-separate commit semantics):** zero `deleteMemoryRecord`
 *   calls are made; exactly one `memory_record` is written per
 *   cluster member.
 * - **P17 (`source_event_ids` is deduped first-seen union):** for a
 *   merge, the summary's `source_event_ids` equals the first-seen-
 *   order deduplication of the concatenation of every merged
 *   entity's `source_event_ids`.
 * - **P19 (Judge ACP session lifecycle):** exactly one
 *   `createAcpSession('kiro-learn-reconciler')` and one `destroy()`
 *   per judge invocation.
 * - **P20 (Per-cluster failure isolation):** an injected failure on
 *   one cluster's commit does not prevent other clusters from
 *   committing. The set of successfully committed clusters equals
 *   the set of clusters whose scripted dependencies returned
 *   success.
 *
 * Validates: Requirements 5.5, 6.1, 6.4, 6.5, 6.7, 6.8, 7.1, 7.3,
 * 7.4, 7.5, 7.6, 8.2, 9.1, 9.2, 9.3, 13.4.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 9.6
 * @see .kiro/specs/reconciliation-engine/design.md § Correctness Properties — 14, 15, 16, 17, 19, 20
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CandidateMemory,
  MemoryRecord,
  StorageBackend,
  StorageTransaction,
} from '../../src/types/index.js';
import type { ReconciliationContext } from '../../src/collector/ingestion/reconciler.js';
import { makeValidRecord } from '../helpers/fixtures.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

/**
 * Per-cluster scripted response. The harness advances this queue one
 * entry per `createAcpSession` call. Each entry is either a string
 * (returned verbatim from `sendPrompt`) or an Error (rejected from
 * `sendPrompt`).
 */
const responseQueue: Array<string | Error> = [];

/** Every session ever created in the current iteration. */
const mockSessions: Array<{
  agentName: string;
  sendPrompt: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}> = [];

const createAcpSessionMock = vi.fn((opts: { agentName: string }) => {
  const response = responseQueue.shift();
  const session = {
    agentName: opts.agentName,
    sendPrompt: vi.fn(() => {
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response ?? '');
    }),
    destroy: vi.fn(),
  };
  mockSessions.push(session);
  return Promise.resolve(session);
});

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: createAcpSessionMock,
}));

// ── Shared helpers ──────────────────────────────────────────────────────

/** Reset cross-iteration state. Called at the top of every fc.asyncProperty body. */
function resetAcpState(): void {
  responseQueue.length = 0;
  mockSessions.length = 0;
  createAcpSessionMock.mockClear();
}

/**
 * Produce a deterministic 384-dim unit-norm vector from a seed. Two
 * candidates generated with the same seed produce identical vectors
 * → cluster together; distinct seeds produce unrelated vectors
 * → remain separate.
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

/**
 * Build a valid CandidateMemory sharing the given namespace and seed
 * embedding. `record_id` is parameterised so each iteration can
 * enumerate its candidates distinctly.
 */
function makeCandidate(args: {
  recordId: string;
  namespace: string;
  sourceEventIds: readonly string[];
  embeddingSeed: number | null;
  observationType?: CandidateMemory['observation_type'];
}): CandidateMemory {
  return {
    record_id: args.recordId,
    namespace: args.namespace,
    strategy: 'llm-summary',
    source_event_ids: [...args.sourceEventIds],
    title: `Title ${args.recordId}`,
    summary: `Summary for ${args.recordId}`,
    facts: ['default fact'],
    concepts: ['default concept'],
    files_touched: [`src/${args.recordId}.ts`],
    observation_type: args.observationType ?? 'tool_use',
    embedding: args.embeddingSeed === null ? null : seededUnitVec(args.embeddingSeed),
  };
}

/** Construct a valid mr_<ULID> from a counter for deterministic tests. */
function uniqueRecordId(counter: number, prefix: string = '0'): string {
  // ULID alphabet is 32 Crockford base32 chars.
  const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  // 26 chars total. Use a 26-char zero-padded hex-like counter mapped
  // into the base32 alphabet.
  let n = counter >>> 0;
  const digits: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    digits.push(ALPHA[n % 32]!);
    n = Math.floor(n / 32);
  }
  // 20 counter chars + 6 prefix chars = 26.
  const prefix6 = (prefix + '000000').slice(0, 6).toUpperCase();
  return `mr_${prefix6}${digits.reverse().join('')}`;
}

/** Construct a valid ULID event_id from a counter. */
function uniqueEventId(counter: number): string {
  const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let n = counter >>> 0;
  const digits: string[] = [];
  for (let i = 0; i < 26; i += 1) {
    digits.push(ALPHA[n % 32]!);
    n = Math.floor(n / 32);
  }
  return digits.reverse().join('');
}

/** Minimal valid `<merge>` XML citing the given ids. */
function mergeXml(
  ids: readonly string[],
  fields: {
    title: string;
    summary: string;
    facts?: readonly string[];
    concepts?: readonly string[];
    files?: readonly string[];
  },
): string {
  const idBlocks = ids.map((id) => `<merged_record_id>${id}</merged_record_id>`).join('');
  const factBlocks = (fields.facts ?? []).map((f) => `<fact>${f}</fact>`).join('');
  const conceptBlocks = (fields.concepts ?? []).map((c) => `<concept>${c}</concept>`).join('');
  const fileBlocks = (fields.files ?? []).map((f) => `<file>${f}</file>`).join('');
  return `
<merge>
  ${idBlocks}
  <title>${fields.title}</title>
  <summary>${fields.summary}</summary>
  <facts>${factBlocks}</facts>
  <concepts>${conceptBlocks}</concepts>
  <files>${fileBlocks}</files>
</merge>
`.trim();
}

/**
 * Build a fresh reconciliation context backed by an in-memory SQLite
 * database + real {@link QueryLayer}. Must be paired with `ctx.close()`
 * in a `finally` block.
 */
async function buildContext(namespace: string): Promise<{
  ctx: ReconciliationContext;
  storage: StorageBackend;
  close: () => Promise<void>;
  deleteSpy: ReturnType<typeof vi.spyOn>;
}> {
  const { openSqliteStorage } = await import('../../src/collector/storage/sqlite/index.js');
  const { createQueryLayer } = await import('../../src/collector/query/index.js');
  const { createReconciliationCircuitBreaker } =
    await import('../../src/collector/ingestion/circuit-breaker.js');

  const storage = openSqliteStorage({ dbPath: ':memory:' });
  const query = createQueryLayer({ storage, embedder: null });
  const deleteSpy = vi.spyOn(storage, 'deleteMemoryRecord');

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
    deleteSpy,
    close: async () => {
      deleteSpy.mockRestore();
      try {
        await storage.close();
      } catch {
        /* swallow */
      }
    },
  };
}

beforeEach(() => {
  resetAcpState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Property 14: Judge invocation gated on non-empty neighbor pool ──────

describe('Property 14: judge invocation gated on non-empty neighbor pool', () => {
  it('opens exactly one ACP session per cluster with ≥1 neighbor, zero otherwise', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');
    const namespace = '/actor/alice/project/p14/';

    /**
     * Generator: a small set of clusters described by
     * `{ seed, hasExistingNeighbor }`. Every cluster is a distinct
     * singleton (distinct seed) so clusters never merge intra-batch.
     * `hasExistingNeighbor === true` seeds a neighbor in storage
     * with a matching embedding.
     */
    const clusterDesc = fc.record({
      // Use widely-spaced seeds so each cluster's `seededUnitVec(seed)`
      // is effectively orthogonal to every other cluster's vector.
      // Spacing by 1000 plus an offset is more than enough to keep
      // cosine similarity between distinct-seed vectors below the
      // neighbor threshold (0.8) — Math.sin((seed+1)*(i+1)) over 384
      // dimensions yields near-zero cosine between well-separated seeds.
      seed: fc.integer({ min: 1, max: 100 }).map((s) => s * 1000 + 1),
      hasExistingNeighbor: fc.boolean(),
    });

    await fc.assert(
      fc.asyncProperty(
        fc
          .array(clusterDesc, { minLength: 1, maxLength: 6 })
          // Dedupe seeds so clusters are genuinely distinct.
          .map((arr) => {
            const seen = new Set<number>();
            const out: Array<{ seed: number; hasExistingNeighbor: boolean }> = [];
            for (const d of arr) {
              if (!seen.has(d.seed)) {
                seen.add(d.seed);
                out.push(d);
              }
            }
            return out;
          })
          .filter((arr) => arr.length >= 1),
        async (descs) => {
          resetAcpState();
          const env = await buildContext(namespace);
          try {
            // Seed neighbors for the clusters that call for one.
            let neighborCounter = 0;
            for (const d of descs) {
              if (!d.hasExistingNeighbor) continue;
              const neighbor = makeValidRecord({
                record_id: uniqueRecordId(neighborCounter, 'NBR'),
                namespace,
                source_event_ids: [uniqueEventId(neighborCounter + 10_000)],
              });
              neighborCounter += 1;
              await env.storage.putMemoryRecord(neighbor);
              await env.storage.putEmbedding(neighbor.record_id, seededUnitVec(d.seed));
            }

            // Build one candidate per cluster (singleton clusters).
            const candidates = descs.map((d, i) =>
              makeCandidate({
                recordId: uniqueRecordId(i, 'CND'),
                namespace,
                sourceEventIds: [uniqueEventId(i + 100)],
                embeddingSeed: d.seed,
              }),
            );

            // Script every invoked judge to return keep-separate.
            const expectedJudgeCalls = descs.filter((d) => d.hasExistingNeighbor).length;
            for (let i = 0; i < expectedJudgeCalls; i += 1) {
              responseQueue.push('<keep_separate/>');
            }

            const outcome = await reconcile(candidates, env.ctx);

            // The number of judge invocations equals the number of
            // clusters that had at least one neighbor seeded above
            // threshold.
            expect(outcome.judgeInvocations).toBe(expectedJudgeCalls);
            expect(createAcpSessionMock).toHaveBeenCalledTimes(expectedJudgeCalls);

            // All sessions were for the reconciler agent.
            for (const session of mockSessions) {
              expect(session.agentName).toBe('kiro-learn-reconciler');
            }
          } finally {
            await env.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 15: Merge commit semantics ─────────────────────────────────

describe('Property 15: merge commit semantics', () => {
  it('merged ids are absent from storage; summary is readable; no row outside the merged set is touched', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');
    const namespace = '/actor/alice/project/p15/';

    await fc.assert(
      fc.asyncProperty(
        // Number of neighbors to include in the merge.
        fc.integer({ min: 1, max: 5 }),
        // Number of unrelated rows (different namespace or distinct
        // cluster region) that must not be touched.
        fc.integer({ min: 0, max: 3 }),
        async (mergedNeighborCount, untouchedCount) => {
          resetAcpState();
          const env = await buildContext(namespace);
          try {
            // Seed `mergedNeighborCount` neighbors that will be
            // cited in the merge.
            const mergedNeighbors: MemoryRecord[] = [];
            for (let i = 0; i < mergedNeighborCount; i += 1) {
              const neighbor = makeValidRecord({
                record_id: uniqueRecordId(i, 'MRG'),
                namespace,
                title: `Merged neighbor ${String(i)}`,
                source_event_ids: [uniqueEventId(i + 20_000)],
              });
              mergedNeighbors.push(neighbor);
              await env.storage.putMemoryRecord(neighbor);
              await env.storage.putEmbedding(
                neighbor.record_id,
                seededUnitVec(7), // same seed — all near the cluster centroid
              );
            }
            // Seed untouched rows in the same namespace but with
            // unrelated embeddings (below threshold).
            const untouched: MemoryRecord[] = [];
            for (let i = 0; i < untouchedCount; i += 1) {
              const row = makeValidRecord({
                record_id: uniqueRecordId(i, 'UNT'),
                namespace,
                title: `Untouched ${String(i)}`,
                source_event_ids: [uniqueEventId(i + 30_000)],
              });
              untouched.push(row);
              await env.storage.putMemoryRecord(row);
              // Embedding in a different direction — well below
              // the neighbor similarity threshold of 0.8.
              await env.storage.putEmbedding(row.record_id, seededUnitVec(20_000 + i));
            }

            // One candidate near the merged neighbors so they
            // surface in the neighbor pool.
            const candidate = makeCandidate({
              recordId: uniqueRecordId(0, 'CND'),
              namespace,
              sourceEventIds: [uniqueEventId(1)],
              embeddingSeed: 7,
            });

            // Judge merges candidate + every seeded neighbor.
            responseQueue.push(
              mergeXml([candidate.record_id, ...mergedNeighbors.map((n) => n.record_id)], {
                title: 'Merged summary',
                summary: 'Merged summary body across cluster + pool',
              }),
            );

            await reconcile([candidate], env.ctx);

            // Merged neighbors are absent.
            for (const n of mergedNeighbors) {
              expect(await env.storage.getEmbedding(n.record_id)).toBeNull();
              const list = await env.storage.listMemoryRecords({
                namespace,
                limit: 100,
                offset: 0,
              });
              expect(list.items.some((r) => r.record_id === n.record_id)).toBe(false);
            }

            // Candidate was NOT committed as a standalone row.
            const list = await env.storage.listMemoryRecords({
              namespace,
              limit: 100,
              offset: 0,
            });
            expect(list.items.some((r) => r.record_id === candidate.record_id)).toBe(false);

            // Exactly one summary is present with the expected
            // strategy.
            const summaries = list.items.filter((r) => r.strategy === 'llm-reconciled');
            expect(summaries).toHaveLength(1);

            // No untouched row was mutated or deleted.
            for (const u of untouched) {
              expect(list.items.some((r) => r.record_id === u.record_id)).toBe(true);
              const emb = await env.storage.getEmbedding(u.record_id);
              expect(emb).not.toBeNull();
            }
          } finally {
            await env.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 16: Keep-separate commit semantics ─────────────────────────

describe('Property 16: keep-separate commit semantics', () => {
  it('zero deleteMemoryRecord calls; exactly one memory_record written per cluster member', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');
    const namespace = '/actor/alice/project/p16/';

    await fc.assert(
      fc.asyncProperty(
        // Number of distinct clusters.
        fc.integer({ min: 1, max: 4 }),
        // Whether each cluster has an existing neighbor. When true
        // the judge is invoked and returns <keep_separate/>; when
        // false the reconciler commits directly.
        fc.boolean(),
        async (clusterCount, hasNeighbors) => {
          resetAcpState();
          const env = await buildContext(namespace);
          try {
            // Seed one neighbor per cluster when requested.
            const neighborIds: string[] = [];
            for (let i = 0; i < clusterCount; i += 1) {
              if (!hasNeighbors) continue;
              const neighbor = makeValidRecord({
                record_id: uniqueRecordId(i, 'NKS'),
                namespace,
              });
              await env.storage.putMemoryRecord(neighbor);
              await env.storage.putEmbedding(neighbor.record_id, seededUnitVec(i + 1));
              neighborIds.push(neighbor.record_id);
            }

            // Baseline row count before reconcile.
            const baseline = await env.storage.listMemoryRecords({
              namespace,
              limit: 1000,
              offset: 0,
            });
            const baselineIds = new Set(baseline.items.map((r) => r.record_id));

            // Reset the delete spy now so baseline puts don't
            // count against it.
            env.deleteSpy.mockClear();

            // One candidate per cluster (distinct seeds →
            // singleton clusters).
            const candidates = Array.from({ length: clusterCount }, (_, i) =>
              makeCandidate({
                recordId: uniqueRecordId(i, 'KEP'),
                namespace,
                sourceEventIds: [uniqueEventId(i + 50_000)],
                embeddingSeed: i + 1,
              }),
            );

            // Script judge: one keep-separate per invoked cluster.
            if (hasNeighbors) {
              for (let i = 0; i < clusterCount; i += 1) {
                responseQueue.push('<keep_separate/>');
              }
            }

            const outcome = await reconcile(candidates, env.ctx);

            // Zero delete calls (Property 16).
            expect(env.deleteSpy).not.toHaveBeenCalled();
            expect(outcome.recordsDeleted).toBe(0);
            expect(outcome.summaryRecordsCommitted).toBe(0);
            expect(outcome.mergeDecisions).toBe(0);

            // Post-reconcile row count: baseline + one new row per
            // cluster member (every cluster has one member).
            const afterList = await env.storage.listMemoryRecords({
              namespace,
              limit: 1000,
              offset: 0,
            });
            const afterIds = new Set(afterList.items.map((r) => r.record_id));

            // Every baseline (seeded neighbor) id is still present.
            for (const id of baselineIds) {
              expect(afterIds.has(id)).toBe(true);
            }

            // Every candidate was written exactly once.
            expect(outcome.keepSeparateCommitted).toBe(clusterCount);
            for (const c of candidates) {
              expect(afterIds.has(c.record_id)).toBe(true);
            }

            // Row count delta matches cluster count exactly — no
            // duplicate writes, no extra rows appeared.
            expect(afterIds.size - baselineIds.size).toBe(clusterCount);
          } finally {
            await env.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 17: source_event_ids is deduped first-seen union ──────────

describe('Property 17: source_event_ids is deduped first-seen union', () => {
  it('summary source_event_ids equals dedup(concat(merged members))', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');
    const namespace = '/actor/alice/project/p17/';

    /**
     * Generate a list of `event_id` arrays, one per merged entity.
     * Values are drawn from a small universe so duplicates across
     * entities are common (and meaningful for dedup).
     */
    const eventUniverse = Array.from({ length: 10 }, (_, i) => uniqueEventId(i + 77_000));
    const eventIdArb = fc.constantFrom(...eventUniverse);
    const perEntityIdsArb = fc.array(eventIdArb, {
      minLength: 1,
      maxLength: 5,
    });

    await fc.assert(
      fc.asyncProperty(
        // Require 2..5 entities — the first becomes the candidate,
        // the rest become neighbors. We need at least one neighbor
        // so the judge is invoked and the merge path runs.
        fc.array(perEntityIdsArb, { minLength: 2, maxLength: 5 }),
        async (perEntityIds) => {
          resetAcpState();
          const env = await buildContext(namespace);
          try {
            // One candidate holds the first entity's ids; the rest
            // become neighbors.
            const candidateIds = perEntityIds[0]!;
            const neighborIdLists = perEntityIds.slice(1);

            const candidate = makeCandidate({
              recordId: uniqueRecordId(0, 'C17'),
              namespace,
              sourceEventIds: candidateIds,
              embeddingSeed: 13,
            });

            const neighbors: MemoryRecord[] = [];
            for (let i = 0; i < neighborIdLists.length; i += 1) {
              const neighbor = makeValidRecord({
                record_id: uniqueRecordId(i, 'N17'),
                namespace,
                source_event_ids: neighborIdLists[i]!,
              });
              neighbors.push(neighbor);
              await env.storage.putMemoryRecord(neighbor);
              await env.storage.putEmbedding(neighbor.record_id, seededUnitVec(13));
            }

            // Judge cites candidate + every neighbor in order.
            const citedIds = [candidate.record_id, ...neighbors.map((n) => n.record_id)];
            responseQueue.push(
              mergeXml(citedIds, {
                title: 'P17 merged',
                summary: 'P17 merged summary body',
              }),
            );

            await reconcile([candidate], env.ctx);

            const list = await env.storage.listMemoryRecords({
              namespace,
              limit: 10,
              offset: 0,
            });
            const summary = list.items.find((r) => r.strategy === 'llm-reconciled');
            expect(summary).toBeDefined();

            // Compute expected = dedup(concat(candidate.ids,
            // neighbor1.ids, neighbor2.ids, ...)) in that order.
            const expected: string[] = [];
            const seen = new Set<string>();
            const all = [candidateIds, ...neighborIdLists];
            for (const arr of all) {
              for (const id of arr) {
                if (!seen.has(id)) {
                  seen.add(id);
                  expected.push(id);
                }
              }
            }

            expect(summary!.source_event_ids).toEqual(expected);
          } finally {
            await env.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ── Property 19: Judge ACP session lifecycle ────────────────────────────

describe('Property 19: judge ACP session lifecycle', () => {
  it('exactly one createAcpSession + one destroy per judge attempt across mixed outcomes', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');
    const namespace = '/actor/alice/project/p19/';

    /**
     * Enumerate per-cluster judge outcomes. Drives all four shapes
     * the reconciler handles:
     *
     *   - `success-keep-separate`: judge returns <keep_separate/>
     *     → 1 session, 1 destroy.
     *   - `success-merge`: judge returns <merge>... → 1 session.
     *   - `retry-then-success`: 1st garbage, 2nd ok → 2 sessions.
     *   - `double-failure`: 1st and 2nd garbage → 2 sessions.
     *   - `timeout`: 1st times out → 1 session (terminal).
     */
    const outcomeArb = fc.constantFrom(
      'success-keep-separate' as const,
      'success-merge' as const,
      'retry-then-success' as const,
      'double-failure' as const,
      'timeout' as const,
    );

    await fc.assert(
      fc.asyncProperty(fc.array(outcomeArb, { minLength: 1, maxLength: 5 }), async (outcomes) => {
        resetAcpState();
        const env = await buildContext(namespace);
        try {
          // For every cluster outcome, seed a neighbor so the
          // judge will be invoked, build a candidate, and script
          // the response queue.
          const candidates: CandidateMemory[] = [];
          let expectedSessions = 0;
          for (let i = 0; i < outcomes.length; i += 1) {
            const seed = i + 1;
            const neighbor = makeValidRecord({
              record_id: uniqueRecordId(i, 'N19'),
              namespace,
            });
            await env.storage.putMemoryRecord(neighbor);
            await env.storage.putEmbedding(neighbor.record_id, seededUnitVec(seed));

            const candidate = makeCandidate({
              recordId: uniqueRecordId(i, 'C19'),
              namespace,
              sourceEventIds: [uniqueEventId(i + 60_000)],
              embeddingSeed: seed,
            });
            candidates.push(candidate);

            switch (outcomes[i]) {
              case 'success-keep-separate':
                responseQueue.push('<keep_separate/>');
                expectedSessions += 1;
                break;
              case 'success-merge':
                responseQueue.push(
                  mergeXml([candidate.record_id, neighbor.record_id], {
                    title: 'P19',
                    summary: 'P19 merged',
                  }),
                );
                expectedSessions += 1;
                break;
              case 'retry-then-success':
                responseQueue.push('garbage first attempt');
                responseQueue.push('<keep_separate/>');
                expectedSessions += 2;
                break;
              case 'double-failure':
                responseQueue.push('garbage first attempt');
                responseQueue.push('garbage second attempt');
                expectedSessions += 2;
                break;
              case 'timeout':
                responseQueue.push(new Error('ACP session timed out after 30000ms'));
                expectedSessions += 1;
                break;
            }
          }

          await reconcile(candidates, env.ctx);

          // Exact session count matches the scripted outcomes.
          expect(createAcpSessionMock).toHaveBeenCalledTimes(expectedSessions);
          expect(mockSessions).toHaveLength(expectedSessions);

          // Each session was for the reconciler agent, was
          // prompted once, and was destroyed exactly once.
          for (const session of mockSessions) {
            expect(session.agentName).toBe('kiro-learn-reconciler');
            expect(session.sendPrompt).toHaveBeenCalledTimes(1);
            expect(session.destroy).toHaveBeenCalledTimes(1);
          }
        } finally {
          await env.close();
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 20: Per-cluster failure isolation ──────────────────────────

describe('Property 20: per-cluster failure isolation', () => {
  it('an injected commit failure on one cluster does not prevent other clusters from committing', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');
    const namespace = '/actor/alice/project/p20/';

    /**
     * Generator: a sequence of booleans, one per cluster. `true`
     * means "inject a commit failure" on that cluster; `false`
     * means "let it commit normally". We drive at least 2 clusters
     * so there's always something to "survive" a failure.
     */
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(fc.boolean(), { minLength: 2, maxLength: 5 })
          // Require at least one failure AND at least one success,
          // otherwise the property is trivially true.
          .filter((arr) => arr.some((b) => b) && arr.some((b) => !b)),
        async (failureFlags) => {
          resetAcpState();
          const env = await buildContext(namespace);
          // Silence per-cluster failure warnings — this property
          // exercises failure paths intentionally, so stderr noise
          // is expected but not useful in CI output.
          const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
          try {
            // One candidate per cluster (distinct seeds). No
            // neighbors — clusters go through the direct-commit
            // (centroid non-null + empty pool) path, so no judge
            // invocation is needed.
            const candidates = failureFlags.map((_flag, i) =>
              makeCandidate({
                recordId: uniqueRecordId(i, 'P20'),
                namespace,
                sourceEventIds: [uniqueEventId(i + 70_000)],
                embeddingSeed: i + 100,
              }),
            );

            // Inject failures by patching
            // `storage.withTransaction`. The original function is
            // the real SQLite implementation; our wrapper returns
            // a rejected promise whenever the candidate we're
            // committing carries a "fail me" flag.
            const originalWithTxn = env.storage.withTransaction.bind(env.storage);
            const shouldFailId = new Set<string>();
            for (let i = 0; i < failureFlags.length; i += 1) {
              if (failureFlags[i] === true) {
                shouldFailId.add(candidates[i]!.record_id);
              }
            }

            env.storage.withTransaction = async <T>(
              fn: (tx: StorageTransaction) => Promise<T> | T,
            ): Promise<T> => {
              // Observe whether any `putMemoryRecord` argument's
              // id is in the fail-set. We cheaply intercept via a
              // proxy transaction that records ids first.
              let failForId: string | null = null;
              const proxy = {
                putMemoryRecord: (r: MemoryRecord) => {
                  if (shouldFailId.has(r.record_id)) {
                    failForId = r.record_id;
                  }
                  // Do NOT forward — we need to short-circuit
                  // before anything durable happens.
                },
                putEmbedding: () => {
                  /* no-op during the sniff phase */
                },
                deleteMemoryRecord: () => {
                  /* no-op during the sniff phase */
                },
              };
              try {
                // Run the callback once over the proxy to peek at
                // which ids it touches.
                await fn(proxy as unknown as StorageTransaction);
              } catch {
                // If the sniff itself threw, treat as fail — but
                // our proxy never throws, so this branch is
                // effectively dead code in practice.
              }

              if (failForId !== null) {
                throw new Error(`injected commit failure for ${failForId}`);
              }
              // No failure requested — run the real transaction.
              return originalWithTxn(fn);
            };

            const outcome = await reconcile(candidates, env.ctx);

            const expectedFailures = failureFlags.filter((b) => b).length;
            const expectedSuccesses = failureFlags.length - expectedFailures;

            expect(outcome.clustersFailed).toBe(expectedFailures);
            expect(outcome.keepSeparateCommitted).toBe(expectedSuccesses);

            // Every non-failing candidate is readable in storage;
            // every failing candidate is absent.
            const list = await env.storage.listMemoryRecords({
              namespace,
              limit: 100,
              offset: 0,
            });
            for (let i = 0; i < candidates.length; i += 1) {
              const c = candidates[i]!;
              const present = list.items.some((r) => r.record_id === c.record_id);
              if (failureFlags[i]) {
                expect(present).toBe(false);
              } else {
                expect(present).toBe(true);
              }
            }
          } finally {
            stderrSpy.mockRestore();
            await env.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
