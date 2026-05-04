/**
 * Unit tests for `QueryLayer.lookupNeighbors` (reconciliation-engine task 3.2).
 *
 * `lookupNeighbors` is a reconciler-only helper — it walks the
 * per-namespace vector index produced by `NamespaceVectorCache`,
 * scores every entry against a caller-supplied centroid via cosine
 * similarity, filters below-threshold entries out, sorts descending,
 * and truncates to at most `cap` results.
 *
 * These tests exercise the behavioural contract declared on the
 * interface:
 *
 *   - Threshold is inclusive at equality, strict below — records
 *     with similarity strictly less than `threshold` are excluded
 *     and records at exactly `threshold` are kept.
 *   - Cap truncates to the top-K by similarity, not an arbitrary
 *     K entries.
 *   - Output is sorted by similarity descending.
 *   - Namespace scoping is driven by the cache load; a lookup
 *     against namespace A never sees records in namespace B.
 *   - Empty namespace returns `[]`.
 *   - `cap === 0` (and any non-positive cap) returns `[]` without
 *     probing the cache.
 *
 * Design choices:
 *
 *   - Storage is the real SQLite backend against an in-memory
 *     database (`openSqliteStorage({ dbPath: ':memory:' })`). The
 *     real backend gives us a real `listEmbeddings` call, so the
 *     cache load path is authentic.
 *   - We seed deterministic one-hot embeddings so cosine
 *     similarities are exactly known (`dot = 1` for matching
 *     dimensions, `0` for orthogonal dimensions, intermediate
 *     values when we mix two one-hots). This lets us assert the
 *     threshold / cap / sort invariants without chasing
 *     floating-point tolerance.
 *   - The embedder is `null` throughout — `lookupNeighbors` is a
 *     pure cache walk and does not touch the embedder.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 3.2
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 5.1, 5.2, 5.3, 5.4
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createQueryLayer } from '../../src/collector/query/index.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { StorageBackend } from '../../src/types/index.js';

import { makeValidRecord } from '../helpers/fixtures.js';

// ── Constants ───────────────────────────────────────────────────────────

const NS_A = '/actor/alice/project/abc/';
const NS_B = '/actor/alice/project/xyz/';

/** Embedding dimensionality produced by the MiniLM-L6-v2 embedder. */
const DIMS = 384;

// ── Fixtures ────────────────────────────────────────────────────────────

/**
 * Build a Float32Array(384) where one dimension is `value` and the
 * rest are zero. Two one-hots with different dimensions are
 * orthogonal (cosine 0); two with the same dimension and both
 * unit-scale have cosine 1.
 */
function oneHot(dim: number, value = 1): Float32Array {
  const vec = new Float32Array(DIMS);
  vec[dim] = value;
  return vec;
}

/**
 * Build a Float32Array(384) with two specified dimensions set to
 * `value`. The L2 norm is `sqrt(2) * value`; when normalized this
 * gives a vector with `value = 1/sqrt(2)` at each of the two
 * dimensions. The cosine between two such vectors that share one
 * dimension is `0.5`; sharing both is `1.0`; sharing none is `0`.
 *
 * We use this to engineer intermediate cosine scores without
 * fighting floating-point precision.
 */
function twoHot(dimA: number, dimB: number, value = 1): Float32Array {
  const vec = new Float32Array(DIMS);
  vec[dimA] = value;
  vec[dimB] = value;
  return vec;
}

/** Pad a numeric suffix into a 26-char Crockford base32 ULID. */
function recordId(n: number): string {
  const suffix = n.toString().padStart(26, '0');
  return `mr_${suffix}`;
}

// ── Test-lifecycle scaffolding ──────────────────────────────────────────

let storage: StorageBackend;

beforeEach(() => {
  storage = openSqliteStorage({ dbPath: ':memory:' });
});

afterEach(async () => {
  try {
    await storage.close();
  } catch {
    // swallow — cleanup must not mask a real failure
  }
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('QueryLayer.lookupNeighbors', () => {
  /**
   * Records with similarity strictly below `threshold` are excluded
   * from the result; records with similarity at or above
   * `threshold` are kept.
   *
   * Corpus of three records in NS_A:
   *   - R1 embedding `oneHot(0)` → cosine 1.0 against centroid
   *     `oneHot(0)`.
   *   - R2 embedding `twoHot(0, 1)` → once normalized, cosine
   *     `1/sqrt(2) ≈ 0.7071` against `oneHot(0)`.
   *   - R3 embedding `oneHot(1)` → cosine 0.0 against `oneHot(0)`.
   *
   * With threshold 0.8 we expect only R1 (1.0). With threshold
   * 0.5 we expect R1 and R2. With threshold 0.0 we expect all
   * three.
   *
   * Validates: Requirements 5.1, 5.3
   */
  it('excludes records with similarity strictly below threshold', async () => {
    const R1 = makeValidRecord({ record_id: recordId(1), namespace: NS_A });
    const R2 = makeValidRecord({ record_id: recordId(2), namespace: NS_A });
    const R3 = makeValidRecord({ record_id: recordId(3), namespace: NS_A });

    for (const r of [R1, R2, R3]) {
      await storage.putMemoryRecord(r);
    }

    await storage.putEmbedding(R1.record_id, oneHot(0));
    await storage.putEmbedding(R2.record_id, twoHot(0, 1));
    await storage.putEmbedding(R3.record_id, oneHot(1));

    const queryLayer = createQueryLayer({ storage, embedder: null });
    const centroid = oneHot(0);

    // Threshold 0.8: only R1 (cosine 1.0) survives; R2's ~0.7071
    // is below the cutoff.
    const strict = await queryLayer.lookupNeighbors(NS_A, centroid, 0.8, 10);
    expect(strict.map((x) => x.record.record_id)).toEqual([R1.record_id]);

    // Threshold 0.5: R1 (1.0) and R2 (~0.7071) qualify; R3 (0.0)
    // does not.
    const mid = await queryLayer.lookupNeighbors(NS_A, centroid, 0.5, 10);
    expect(mid.map((x) => x.record.record_id)).toEqual([R1.record_id, R2.record_id]);

    // Threshold 0.0: every record qualifies (cosine ≥ 0).
    const loose = await queryLayer.lookupNeighbors(NS_A, centroid, 0.0, 10);
    expect(loose).toHaveLength(3);
    expect(loose.map((x) => x.record.record_id).sort()).toEqual(
      [R1.record_id, R2.record_id, R3.record_id].sort(),
    );
  });

  /**
   * With 20 records above threshold and cap=10, exactly 10 are
   * returned — and they are the top-10 by similarity.
   *
   * We seed 20 records with cosines arranged as
   * `[1.0, 0.99, 0.98, ..., 0.81]` against the centroid. We place
   * the threshold at 0.8 so every record survives filtering, then
   * assert cap=10 truncates to the top-10 (cosines 1.00..0.91).
   *
   * Validates: Requirements 5.2, 5.3
   */
  it('with 20 records above threshold and cap=10, returns the top-10 by similarity', async () => {
    // Build 20 embeddings with carefully-scaled one-hot vectors
    // so that cosine(centroid=oneHot(0), embedding) takes 20
    // distinct values in [0.81, 1.0].
    //
    // Trick: embedding = alpha * oneHot(0) + beta * oneHot(1),
    // with alpha = cosineTarget and beta = sqrt(1 - cosineTarget²).
    // The L2 norm is exactly 1 (unit vector); cosine against
    // oneHot(0) is exactly `alpha = cosineTarget`.
    const records: string[] = [];
    const cosines: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const cosineTarget = 1.0 - i * 0.01; // 1.00, 0.99, ..., 0.81
      const alpha = cosineTarget;
      const beta = Math.sqrt(1 - alpha * alpha);

      const vec = new Float32Array(DIMS);
      vec[0] = alpha;
      vec[1] = beta;

      const rid = recordId(100 + i);
      const record = makeValidRecord({ record_id: rid, namespace: NS_A });
      await storage.putMemoryRecord(record);
      await storage.putEmbedding(rid, vec);

      records.push(rid);
      cosines.push(cosineTarget);
    }

    const queryLayer = createQueryLayer({ storage, embedder: null });

    // Threshold 0.8: every one of the 20 records qualifies
    // (lowest cosine is 0.81). Cap 10 truncates to top-10.
    const hits = await queryLayer.lookupNeighbors(NS_A, oneHot(0), 0.8, 10);

    expect(hits).toHaveLength(10);

    // The top-10 expected cosines are 1.00, 0.99, ..., 0.91 (the
    // first 10 of our `cosines` array).
    const expectedIds = records.slice(0, 10);
    expect(hits.map((x) => x.record.record_id)).toEqual(expectedIds);
  });

  /**
   * Output is sorted by similarity descending. Seed records
   * deliberately out of cosine order so the cache's entry order
   * cannot accidentally match the expected sort.
   *
   * Validates: Requirements 5.2, 5.3
   */
  it('sorts output by similarity descending', async () => {
    // Insert records in cosine-ascending order; the sort MUST
    // flip them to descending.
    const entries: Array<{ rid: string; cosineTarget: number }> = [
      { rid: recordId(201), cosineTarget: 0.5 },
      { rid: recordId(202), cosineTarget: 0.9 },
      { rid: recordId(203), cosineTarget: 0.7 },
      { rid: recordId(204), cosineTarget: 0.6 },
      { rid: recordId(205), cosineTarget: 0.95 },
    ];

    for (const { rid, cosineTarget } of entries) {
      const alpha = cosineTarget;
      const beta = Math.sqrt(1 - alpha * alpha);
      const vec = new Float32Array(DIMS);
      vec[0] = alpha;
      vec[1] = beta;

      const record = makeValidRecord({ record_id: rid, namespace: NS_A });
      await storage.putMemoryRecord(record);
      await storage.putEmbedding(rid, vec);
    }

    const queryLayer = createQueryLayer({ storage, embedder: null });
    const hits = await queryLayer.lookupNeighbors(NS_A, oneHot(0), 0.0, 10);

    // Every similarity in the result is ≥ the next one (monotone
    // non-increasing).
    for (let i = 1; i < hits.length; i += 1) {
      const prev = hits[i - 1];
      const curr = hits[i];
      if (prev === undefined || curr === undefined) {
        throw new Error('unreachable: loop bounds guarantee defined');
      }
      expect(prev.similarity).toBeGreaterThanOrEqual(curr.similarity);
    }

    // Explicit expected order:
    expect(hits.map((x) => x.record.record_id)).toEqual([
      recordId(205), // 0.95
      recordId(202), // 0.90
      recordId(203), // 0.70
      recordId(204), // 0.60
      recordId(201), // 0.50
    ]);
  });

  /**
   * Namespace scoping: records in other namespaces are never
   * returned. A lookup against NS_A must not surface any record
   * from NS_B, even if NS_B's records have high cosine similarity
   * to the centroid.
   *
   * Seed three records in NS_A (with low similarity) and three in
   * NS_B (with high similarity). A lookup against NS_A returns
   * only NS_A records.
   *
   * Validates: Requirements 5.2
   */
  it('never returns records from other namespaces', async () => {
    const A_ids = [recordId(301), recordId(302), recordId(303)];
    const B_ids = [recordId(311), recordId(312), recordId(313)];

    // NS_A: every record is orthogonal to the centroid (cosine 0).
    for (const rid of A_ids) {
      const record = makeValidRecord({ record_id: rid, namespace: NS_A });
      await storage.putMemoryRecord(record);
      await storage.putEmbedding(rid, oneHot(1)); // orthogonal to oneHot(0)
    }

    // NS_B: every record is a perfect match (cosine 1).
    for (const rid of B_ids) {
      const record = makeValidRecord({ record_id: rid, namespace: NS_B });
      await storage.putMemoryRecord(record);
      await storage.putEmbedding(rid, oneHot(0)); // perfect match
    }

    const queryLayer = createQueryLayer({ storage, embedder: null });

    // Lookup against NS_A with threshold 0.0: returns every
    // NS_A record and zero NS_B records — even though every NS_B
    // record has strictly higher cosine.
    const hitsA = await queryLayer.lookupNeighbors(NS_A, oneHot(0), 0.0, 100);
    const hitIdsA = hitsA.map((x) => x.record.record_id).sort();
    expect(hitIdsA).toEqual(A_ids.slice().sort());
    for (const hit of hitsA) {
      expect(hit.record.namespace).toBe(NS_A);
    }

    // Lookup against NS_B with threshold 0.5: returns every NS_B
    // record and zero NS_A records.
    const hitsB = await queryLayer.lookupNeighbors(NS_B, oneHot(0), 0.5, 100);
    const hitIdsB = hitsB.map((x) => x.record.record_id).sort();
    expect(hitIdsB).toEqual(B_ids.slice().sort());
    for (const hit of hitsB) {
      expect(hit.record.namespace).toBe(NS_B);
    }
  });

  /**
   * Empty namespace returns `[]`. An `lookupNeighbors` against a
   * namespace that has zero records (or where every record has
   * `embedding IS NULL`) produces an empty result without throwing.
   *
   * Validates: Requirements 5.4 (empty neighbor-pool short-circuit)
   */
  it('returns [] for an empty namespace', async () => {
    const queryLayer = createQueryLayer({ storage, embedder: null });

    const hits = await queryLayer.lookupNeighbors(
      '/actor/ghost/project/nothing/',
      oneHot(0),
      0.0,
      10,
    );

    expect(hits).toEqual([]);
  });

  /**
   * `cap === 0` returns `[]`. Negative caps also return `[]`. In
   * both cases the behaviour is consistent with a top-K query
   * where `K` is non-positive: there is no meaningful result set.
   *
   * We seed a non-empty namespace so the assertion guards against
   * the "trivially empty because corpus is empty" false positive.
   *
   * Validates: Requirements 5.3 (cap-driven truncation)
   */
  it('returns [] when cap is zero', async () => {
    const record = makeValidRecord({ record_id: recordId(401), namespace: NS_A });
    await storage.putMemoryRecord(record);
    await storage.putEmbedding(record.record_id, oneHot(0));

    const queryLayer = createQueryLayer({ storage, embedder: null });

    const hitsZero = await queryLayer.lookupNeighbors(NS_A, oneHot(0), 0.0, 0);
    expect(hitsZero).toEqual([]);

    const hitsNegative = await queryLayer.lookupNeighbors(NS_A, oneHot(0), 0.0, -5);
    expect(hitsNegative).toEqual([]);
  });
});
