/**
 * Property-based tests for `intraBatchCluster` — Properties 5, 6, 7, 8
 * from the reconciliation-engine design.
 *
 * Each property pins down one axis of the clustering contract:
 *
 * - **Property 5: Clustering partitions the input.** For any batch of
 *   size `n`, the union of every cluster's `members` equals
 *   `[0, n)` and no index appears in more than one cluster. This is
 *   the unambiguous formal version of "every candidate belongs to
 *   exactly one cluster" (Requirement 4.3).
 * - **Property 6: Raising the threshold never widens clusters.** If
 *   two candidates are in the same cluster at threshold τ_high, they
 *   are in the same cluster at every τ_low ≤ τ_high. Equivalently,
 *   the partition at τ_high is a refinement of the partition at
 *   τ_low. (Requirements 4.1, 4.2, 4.5.)
 * - **Property 7: Null-embedding candidates are singletons.** Any
 *   candidate whose `embedding` is `null` ends up in a singleton
 *   cluster, never merged with anyone. (Requirement 4.4.)
 * - **Property 8: Cluster centroid is a unit vector.** For clusters
 *   whose members all have non-null embeddings, `||centroid||` is `1`
 *   within 1e-5 tolerance (or `0` on the pathological antiparallel-
 *   mean case). Clusters containing any null-embedding member have
 *   `centroid === null`. (Requirements 4.4, 4.6.)
 *
 * All generators come from `test/helpers/arbitrary.ts` — we use
 * `arbitraryCandidateMemory()` directly and constrain batch size to
 * 1–15 so each run finishes in well under a second even at 200
 * iterations.
 *
 * The module under test is pure. No setup / teardown is required —
 * the tests call `intraBatchCluster(...)` directly and assert on
 * the return value.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 6.3
 * @see .kiro/specs/reconciliation-engine/design.md § Correctness
 *   Properties — Properties 5, 6, 7, 8
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 4.1, 4.2,
 *   4.3, 4.4, 4.5, 4.6
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  intraBatchCluster,
  type Cluster,
} from '../../src/collector/ingestion/clustering.js';
import type { CandidateMemory } from '../../src/types/index.js';

import { arbitraryCandidateMemory } from '../helpers/arbitrary.js';

// ── Shared helpers ──────────────────────────────────────────────────────

/**
 * Map an index back to its cluster id for quick "same cluster?"
 * lookups. The cluster id is the cluster's position in the returned
 * list, which is stable by construction (`intraBatchCluster` orders
 * clusters by minimum member index).
 */
function buildClusterIdMap(clusters: readonly Cluster[]): Map<number, number> {
  const map = new Map<number, number>();
  clusters.forEach((cluster, clusterId) => {
    for (const member of cluster.members) {
      map.set(member, clusterId);
    }
  });
  return map;
}

/** L2 norm of a Float32Array. */
function l2Norm(v: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < v.length; i += 1) {
    const vi = v[i] ?? 0;
    sumSq += vi * vi;
  }
  return Math.sqrt(sumSq);
}

// ── Property 5: partition ──────────────────────────────────────────────

describe('Property 5: intraBatchCluster partitions the input', () => {
  it(
    'every index appears in exactly one cluster and the union equals [0, n)',
    () => {
      /**
       * **Validates: Requirements 4.3**
       *
       * For any batch of 1–15 {@link CandidateMemory} values and any
       * threshold in `[0, 1]`, the output of `intraBatchCluster`
       * partitions the input: (a) concatenating `members` across
       * clusters yields a set of indices equal to `[0, n)`, (b) no
       * index appears twice, (c) every cluster is non-empty.
       */
      fc.assert(
        fc.property(
          fc.array(arbitraryCandidateMemory(), { minLength: 1, maxLength: 15 }),
          fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
          (candidates: CandidateMemory[], threshold: number) => {
            const clusters = intraBatchCluster(candidates, threshold);

            // Clause (c): every cluster is non-empty.
            for (const cluster of clusters) {
              expect(cluster.members.length).toBeGreaterThan(0);
            }

            // Clauses (a) + (b): collect every index across all
            // clusters and confirm the multiset equals {0..n-1}.
            const seen = new Set<number>();
            let total = 0;
            for (const cluster of clusters) {
              for (const idx of cluster.members) {
                // No duplicates → no index appears in more than one
                // cluster AND no index appears twice within one
                // cluster.
                expect(seen.has(idx)).toBe(false);
                seen.add(idx);
                total += 1;
              }
            }
            expect(total).toBe(candidates.length);
            for (let i = 0; i < candidates.length; i += 1) {
              expect(seen.has(i)).toBe(true);
            }
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});

// ── Property 6: monotonic refinement ────────────────────────────────────

describe('Property 6: intraBatchCluster respects the similarity threshold (monotonic)', () => {
  it(
    'raising the threshold never places new pairs in the same cluster',
    () => {
      /**
       * **Validates: Requirements 4.1, 4.2, 4.5**
       *
       * For any batch and any two thresholds with `τ_low ≤ τ_high`: if
       * indices `i` and `j` are in the same cluster at `τ_high`, they
       * were also in the same cluster at `τ_low`. Formally, the
       * partition at `τ_high` is a refinement of the partition at
       * `τ_low`. We generate `τ_low` and a non-negative delta so the
       * `τ_low ≤ τ_high` invariant holds by construction.
       */
      fc.assert(
        fc.property(
          fc.array(arbitraryCandidateMemory(), { minLength: 2, maxLength: 15 }),
          fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
          fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
          (candidates: CandidateMemory[], tauLow: number, delta: number) => {
            // Clamp `tauHigh` to `[0, 1]` — clustering only compares
            // against cosine which lives in that range, but the
            // generator can produce deltas that push past 1.
            const tauHigh = Math.min(1, tauLow + delta);

            const low = intraBatchCluster(candidates, tauLow);
            const high = intraBatchCluster(candidates, tauHigh);

            const lowMap = buildClusterIdMap(low);
            const highMap = buildClusterIdMap(high);

            // For every pair (i, j), if same-cluster at τ_high then
            // same-cluster at τ_low. We check both directions of the
            // implication explicitly rather than asserting equality
            // because `τ_high === τ_low` is allowed and that case is
            // trivially a refinement.
            for (let i = 0; i < candidates.length; i += 1) {
              for (let j = i + 1; j < candidates.length; j += 1) {
                const sameHigh = highMap.get(i) === highMap.get(j);
                if (sameHigh) {
                  const sameLow = lowMap.get(i) === lowMap.get(j);
                  expect(sameLow).toBe(true);
                }
              }
            }
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});

// ── Property 7: null-embedding singletons ───────────────────────────────

describe('Property 7: null-embedding candidates are singletons', () => {
  it(
    'every null-embedding candidate is in its own singleton cluster',
    () => {
      /**
       * **Validates: Requirements 4.4**
       *
       * For any batch and any threshold, every candidate with
       * `embedding === null` ends up in a cluster of size exactly 1,
       * containing just its own index. The centroid of that cluster
       * is `null` (Requirement 4.6 — see Property 8 for the broader
       * centroid contract).
       */
      fc.assert(
        fc.property(
          fc.array(arbitraryCandidateMemory(), { minLength: 1, maxLength: 15 }),
          fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
          (candidates: CandidateMemory[], threshold: number) => {
            const clusters = intraBatchCluster(candidates, threshold);
            const clusterIdMap = buildClusterIdMap(clusters);

            for (let i = 0; i < candidates.length; i += 1) {
              const c = candidates[i];
              if (c === undefined || c.embedding !== null) continue;
              const clusterId = clusterIdMap.get(i);
              if (clusterId === undefined) {
                throw new Error('index missing from cluster map');
              }
              const cluster = clusters[clusterId];
              if (cluster === undefined) {
                throw new Error('cluster id out of range');
              }
              expect(cluster.members).toEqual([i]);
              expect(cluster.centroid).toBeNull();
            }
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});

// ── Property 8: centroid is a unit vector ──────────────────────────────

describe('Property 8: cluster centroid is a unit vector', () => {
  it(
    'non-null centroids are unit-norm (or zero); clusters with any null-embedding member have null centroid',
    () => {
      /**
       * **Validates: Requirements 4.4, 4.6**
       *
       * For each cluster in the output:
       *
       * - If every member has a non-null embedding, the centroid is a
       *   fresh `Float32Array` whose L2 norm is `1` within 1e-5
       *   tolerance. The exception is the zero-vector case: when the
       *   member embeddings mean to the zero vector, `normalize`
       *   returns a zero-vector centroid (consistent with the
       *   zero-norm guard in `cosine.ts`); the norm assertion allows
       *   the zero case explicitly.
       * - If any member has a null embedding, the centroid is `null`.
       *   Given Property 7 constrains null-embedding candidates to be
       *   singletons, the only way this branch fires is for the
       *   singleton itself.
       */
      fc.assert(
        fc.property(
          fc.array(arbitraryCandidateMemory(), { minLength: 1, maxLength: 15 }),
          fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
          (candidates: CandidateMemory[], threshold: number) => {
            const clusters = intraBatchCluster(candidates, threshold);

            for (const cluster of clusters) {
              // Does any member have a null embedding?
              let hasNull = false;
              for (const idx of cluster.members) {
                const c = candidates[idx];
                if (c === undefined) {
                  throw new Error('cluster references out-of-range index');
                }
                if (c.embedding === null) {
                  hasNull = true;
                  break;
                }
              }

              if (hasNull) {
                expect(cluster.centroid).toBeNull();
                continue;
              }

              // All-non-null case: centroid must be a fresh
              // Float32Array with L2 norm ≈ 1, or exactly 0 on the
              // pathological zero-mean case.
              const centroid = cluster.centroid;
              expect(centroid).not.toBeNull();
              if (centroid === null) throw new Error('unreachable');
              expect(centroid).toBeInstanceOf(Float32Array);

              const norm = l2Norm(centroid);
              // Accept either norm ≈ 1 (the normal case) or norm === 0
              // (the zero-mean case: `normalize` returns a zero vector
              // when its input has zero L2 norm).
              const isUnit = Math.abs(norm - 1) <= 1e-5;
              const isZero = norm === 0;
              expect(isUnit || isZero).toBe(true);
            }
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});
