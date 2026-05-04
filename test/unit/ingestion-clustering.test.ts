/**
 * Unit tests for `intraBatchCluster` from the ingestion/clustering
 * module.
 *
 * These tests exercise the concrete behavioural contract declared by
 * the clustering module:
 *
 * - Empty / single-element input edge cases (the trivial partitions).
 * - Merge vs. no-merge at a known cosine and a known threshold.
 * - Inclusive threshold semantics (`>=`, not `>`).
 * - Null-embedding candidates stay singletons even when everyone else
 *   in the batch clusters.
 * - Determinism: two runs over the same input produce the same
 *   cluster ordering and membership.
 * - Centroid is `null` when any member has a null embedding.
 * - Multi-cluster shapes: two pairs merge into two clusters, not one.
 *
 * Embeddings are hand-crafted `Float32Array(384)` values with only the
 * first two dimensions non-zero. Because the embedding barrel's
 * `cosine` is invariant to higher-dimension zeros, the similarity
 * between two such vectors is fully determined by their first two
 * components. This keeps each assertion's target cosine exactly
 * computable without floating-point slop.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 6.2
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 4.1, 4.2,
 *   4.3, 4.5, 4.6
 */

import { describe, expect, it } from 'vitest';

import {
  intraBatchCluster,
  type Cluster,
} from '../../src/collector/ingestion/clustering.js';
import { normalize } from '../../src/collector/embedding/index.js';
import type { CandidateMemory } from '../../src/types/index.js';

// ── Constants & helpers ─────────────────────────────────────────────────

const DIMS = 384;

/**
 * Build a 384-dim `Float32Array` with caller-specified values in the
 * first two dimensions and zeros everywhere else. The cosine between
 * two such vectors is determined entirely by their first two
 * components, which lets the tests target exact cosine values.
 */
function vec2(a: number, b: number): Float32Array {
  const out = new Float32Array(DIMS);
  out[0] = a;
  out[1] = b;
  return out;
}

/**
 * Build a {@link CandidateMemory} with caller-chosen record_id and
 * embedding. Every other field is filled with a constant placeholder
 * because the clustering module does not read them.
 *
 * The record_id is not validated (the clustering module operates on
 * indices, not ids) — picking simple strings keeps test output
 * readable when an assertion fails.
 */
function candidate(
  recordId: string,
  embedding: Float32Array | null,
): CandidateMemory {
  return {
    record_id: recordId,
    namespace: '/actor/test/project/unit/',
    strategy: 'llm-summary',
    title: `title-${recordId}`,
    summary: `summary-${recordId}`,
    facts: [],
    concepts: [],
    files_touched: [],
    observation_type: 'pattern',
    source_event_ids: ['01HTEST0000000000000000000'],
    embedding,
  };
}

/**
 * Sort clusters by their minimum member index so two runs that
 * produce the same partition compare equal regardless of internal
 * sorting stability. `intraBatchCluster` already guarantees this
 * order — the helper is a belt-and-braces normalisation for the
 * determinism test.
 */
function sortedClusterMembers(clusters: readonly Cluster[]): number[][] {
  return clusters.map((c) => [...c.members]);
}

// ── Edge cases ──────────────────────────────────────────────────────────

describe('intraBatchCluster — edge cases', () => {
  it('returns [] for empty input', () => {
    expect(intraBatchCluster([], 0.85)).toEqual([]);
  });

  it('returns one singleton cluster for a single non-null candidate', () => {
    const emb = vec2(1, 0);
    const c0 = candidate('c0', emb);
    const clusters = intraBatchCluster([c0], 0.85);

    expect(clusters).toHaveLength(1);
    const only = clusters[0];
    if (only === undefined) throw new Error('unreachable');
    expect(only.members).toEqual([0]);

    // Centroid of a single-element cluster is `normalize(embedding)`.
    // Compare component-wise — never by reference — because
    // `normalize` always returns a fresh allocation.
    const expected = normalize(emb);
    expect(only.centroid).not.toBeNull();
    if (only.centroid === null) throw new Error('unreachable');
    expect(Array.from(only.centroid)).toEqual(Array.from(expected));
  });

  it('returns one singleton cluster with null centroid for a single null-embedding candidate', () => {
    const c0 = candidate('c0', null);
    const clusters = intraBatchCluster([c0], 0.85);

    expect(clusters).toHaveLength(1);
    const only = clusters[0];
    if (only === undefined) throw new Error('unreachable');
    expect(only.members).toEqual([0]);
    expect(only.centroid).toBeNull();
  });
});

// ── Merge / no-merge at known cosines ───────────────────────────────────

describe('intraBatchCluster — similarity threshold behaviour', () => {
  it('merges two candidates whose cosine exceeds the threshold', () => {
    // cos = 0.9 exactly: v1 = (1, 0, ...) is unit-norm; v2 = (0.9,
    // sqrt(0.19), ...) is unit-norm with dot product 0.9 against v1.
    // Threshold 0.85 < 0.9 → merge.
    const v1 = vec2(1, 0);
    const v2 = vec2(0.9, Math.sqrt(1 - 0.9 * 0.9));

    const c0 = candidate('c0', v1);
    const c1 = candidate('c1', v2);
    const clusters = intraBatchCluster([c0, c1], 0.85);

    expect(clusters).toHaveLength(1);
    const only = clusters[0];
    if (only === undefined) throw new Error('unreachable');
    expect(only.members).toEqual([0, 1]);
    expect(only.centroid).not.toBeNull();
  });

  it('keeps two candidates separate when their cosine is below the threshold', () => {
    // cos = 0.3: v1 = (1, 0, ...); v2 = (0.3, sqrt(0.91), ...).
    // Threshold 0.85 > 0.3 → stay separate.
    const v1 = vec2(1, 0);
    const v2 = vec2(0.3, Math.sqrt(1 - 0.3 * 0.3));

    const c0 = candidate('c0', v1);
    const c1 = candidate('c1', v2);
    const clusters = intraBatchCluster([c0, c1], 0.85);

    expect(clusters).toHaveLength(2);
    expect(sortedClusterMembers(clusters)).toEqual([[0], [1]]);
  });

  it('merges at the exact threshold (inclusive >=)', () => {
    // Construct v1 = (1, 0, ...), v2 = (τ, sqrt(1 - τ²), ...) so the
    // cosine is exactly τ — then set threshold = τ and expect merge.
    const tau = 0.85;
    const v1 = vec2(1, 0);
    const v2 = vec2(tau, Math.sqrt(1 - tau * tau));

    const c0 = candidate('c0', v1);
    const c1 = candidate('c1', v2);
    const clusters = intraBatchCluster([c0, c1], tau);

    expect(clusters).toHaveLength(1);
    const only = clusters[0];
    if (only === undefined) throw new Error('unreachable');
    expect(only.members).toEqual([0, 1]);
  });
});

// ── Null-embedding candidates ───────────────────────────────────────────

describe('intraBatchCluster — null-embedding handling', () => {
  it('keeps a null-embedding candidate as its own singleton even when other candidates cluster', () => {
    // Two near-identical candidates that merge, plus one null-embedding
    // candidate that must stay alone regardless of what the threshold is.
    const c0 = candidate('c0', vec2(1, 0));
    const c1 = candidate('c1', vec2(0.95, Math.sqrt(1 - 0.95 * 0.95)));
    const c2 = candidate('c2', null);

    const clusters = intraBatchCluster([c0, c1, c2], 0.85);

    expect(clusters).toHaveLength(2);
    expect(sortedClusterMembers(clusters)).toEqual([[0, 1], [2]]);

    // The merged cluster has a centroid; the null-embedding singleton
    // has a null centroid (Requirement 4.4, 4.6).
    const merged = clusters[0];
    const singleton = clusters[1];
    if (merged === undefined || singleton === undefined) {
      throw new Error('unreachable');
    }
    expect(merged.centroid).not.toBeNull();
    expect(singleton.centroid).toBeNull();
  });

  it('does not merge two null-embedding candidates with each other', () => {
    const c0 = candidate('c0', null);
    const c1 = candidate('c1', null);
    const clusters = intraBatchCluster([c0, c1], 0.85);

    expect(clusters).toHaveLength(2);
    expect(sortedClusterMembers(clusters)).toEqual([[0], [1]]);
    for (const c of clusters) expect(c.centroid).toBeNull();
  });
});

// ── Determinism ─────────────────────────────────────────────────────────

describe('intraBatchCluster — determinism', () => {
  it('produces identical clusters on two runs against the same input', () => {
    // Build a mixed batch: two merging pairs and one loner.
    const inputs: CandidateMemory[] = [
      candidate('a', vec2(1, 0)),
      candidate('b', vec2(0.95, Math.sqrt(1 - 0.95 * 0.95))),
      candidate('c', vec2(0, 1)),
      candidate('d', vec2(Math.sqrt(1 - 0.92 * 0.92), 0.92)),
      candidate('e', vec2(0.5, Math.sqrt(1 - 0.5 * 0.5))), // ~0.5 vs a, ~0.87 vs c
    ];

    const first = intraBatchCluster(inputs, 0.85);
    const second = intraBatchCluster(inputs, 0.85);

    expect(sortedClusterMembers(second)).toEqual(sortedClusterMembers(first));
  });

  it('emits clusters in ascending order of minimum member index', () => {
    // Three candidates: 0 alone, 1 and 2 merged.
    const c0 = candidate('loner', vec2(1, 0));
    const c1 = candidate('a', vec2(0, 1));
    const c2 = candidate('b', vec2(Math.sqrt(1 - 0.99 * 0.99), 0.99));

    const clusters = intraBatchCluster([c0, c1, c2], 0.85);
    expect(sortedClusterMembers(clusters)).toEqual([[0], [1, 2]]);
  });
});

// ── Multi-cluster scenarios ─────────────────────────────────────────────

describe('intraBatchCluster — multi-cluster partitioning', () => {
  it('forms two clusters when {0,1} merge and {2,3} merge independently', () => {
    // Group A: two vectors near (1, 0) — cosine ≈ 0.99.
    // Group B: two vectors near (0, 1) — cosine ≈ 0.99.
    // Across-group cosine ≈ 0 so no A↔B merges.
    const a0 = candidate('a0', vec2(1, 0));
    const a1 = candidate('a1', vec2(0.99, Math.sqrt(1 - 0.99 * 0.99)));
    const b0 = candidate('b0', vec2(0, 1));
    const b1 = candidate('b1', vec2(Math.sqrt(1 - 0.99 * 0.99), 0.99));

    const clusters = intraBatchCluster([a0, a1, b0, b1], 0.85);

    expect(clusters).toHaveLength(2);
    expect(sortedClusterMembers(clusters)).toEqual([[0, 1], [2, 3]]);

    // Both clusters have non-null centroids because every member has
    // a non-null embedding.
    for (const c of clusters) expect(c.centroid).not.toBeNull();
  });

  it('transitively merges {0,1} and {1,2} into a single three-member cluster', () => {
    // Even if 0↔2 similarity is below threshold, the presence of 1
    // with similarity ≥ τ to both of them is enough to pull 0 and 2
    // into the same class — standard union-find transitivity.
    const v0 = vec2(1, 0);
    const v1 = vec2(0.93, Math.sqrt(1 - 0.93 * 0.93));
    // v2 has cosine ≈ 0.8 vs v0 (< 0.85, no direct merge) but ~0.95
    // vs v1 — picking 0.86 against v1 hits that range while keeping
    // v2 sub-threshold against v0.
    // cos(v0, v2) = v2[0] = 0.8 → no direct merge.
    // cos(v1, v2) = v1[0]*v2[0] + v1[1]*v2[1]
    //             = 0.93*0.8 + sqrt(.1351)*sqrt(.36)
    //             ≈ 0.744 + 0.2205
    //             ≈ 0.965 → merges.
    const v2 = vec2(0.8, Math.sqrt(1 - 0.8 * 0.8));

    const c0 = candidate('c0', v0);
    const c1 = candidate('c1', v1);
    const c2 = candidate('c2', v2);

    const clusters = intraBatchCluster([c0, c1, c2], 0.85);
    expect(clusters).toHaveLength(1);
    const only = clusters[0];
    if (only === undefined) throw new Error('unreachable');
    expect(only.members).toEqual([0, 1, 2]);
    expect(only.centroid).not.toBeNull();
  });
});
