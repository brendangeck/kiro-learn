/**
 * Intra-batch clustering — pure union-find over {@link CandidateMemory}
 * indices.
 *
 * The Reconciliation Stage calls {@link intraBatchCluster} once per
 * ingestion batch to collapse near-duplicate Candidate Memories that the
 * compressor produced within a single extraction run. Clusters that
 * survive this pass carry a representative centroid that the
 * `reconciler.ts` module then uses to probe the per-namespace vector
 * index for existing neighbors.
 *
 * ## Algorithm
 *
 * Standard disjoint-set forest (DSU) with path compression + union by
 * rank, over the integer indices `[0, candidates.length)`:
 *
 * 1. Allocate one DSU node per candidate.
 * 2. Candidates with `embedding === null` stay in their own singleton
 *    class. They are NEVER `union`-ed with anyone — this is the
 *    null-embedding singleton rule required by Requirement 4.4.
 * 3. For every pair `(i, j)` with `i < j`, both carrying a non-null
 *    embedding, compute `cosine(a.embedding, b.embedding)`. If the
 *    similarity meets or exceeds `threshold` (inclusive `>=`), `union`
 *    them.
 * 4. Walk the DSU roots in order of first appearance to produce the
 *    final `Cluster[]`. Cluster order is deterministic — emit clusters
 *    in ascending order of their lowest member index. Members within a
 *    cluster are ascending.
 * 5. For each cluster compute the centroid:
 *      - If EVERY member has a non-null embedding, the centroid is the
 *        L2-normalised arithmetic mean of the member embeddings.
 *      - Otherwise the centroid is `null` — the null-embedding-taints-
 *        the-cluster rule. Because null-embedding candidates are forced
 *        into their own singletons by step 2, the only way a multi-
 *        member cluster ends up with a null centroid would be if the
 *        DSU contract were violated; the `null` carve-out is kept for
 *        defence-in-depth.
 *
 * ## Purity
 *
 * This module performs no I/O, writes no logs, and mutates no input
 * arrays. It imports only from the embedding barrel (`cosine`,
 * `normalize`) and from `src/types/` for the {@link CandidateMemory}
 * type. It MUST NOT import from `src/collector/storage/sqlite/` — the
 * modularity-guard test suite pins this constraint.
 *
 * ## Complexity
 *
 * O(n²) in batch size (every candidate pair is inspected). This is
 * acceptable because typical batches are single-digit candidates; the
 * reconciliation stage does not need to scale this module to thousands
 * of candidates at once.
 *
 * @see .kiro/specs/reconciliation-engine/design.md § Components and
 *   Interfaces — `clustering.ts` — pure intra-batch clustering
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 4.1, 4.2,
 *   4.3, 4.4, 4.6
 * @module
 */

import { cosine, normalize } from '../embedding/index.js';
import type { CandidateMemory } from '../../types/index.js';

// ── Public types ────────────────────────────────────────────────────────

/**
 * One cluster emitted by {@link intraBatchCluster}.
 *
 * `members` are indices back into the original `candidates` array the
 * caller passed — this keeps the cluster shape tiny (no embedding
 * copies) and lets the reconciler look up the full {@link CandidateMemory}
 * on demand. The list is always non-empty and ascending.
 *
 * `centroid` is the L2-normalised mean of the member embeddings when
 * every member has a non-null embedding, and `null` otherwise. A null
 * centroid tells the reconciler to skip neighbor lookup and judge
 * invocation for this cluster (Requirement 5.5).
 */
export interface Cluster {
  /** Indices into the original candidates array — non-empty, ascending. */
  readonly members: readonly number[];
  /** L2-normalised mean of member embeddings; null if any member lacks one. */
  readonly centroid: Float32Array | null;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Partition a batch of Candidate Memories into clusters of
 * near-duplicates.
 *
 * See the module-level doc comment for the full algorithm and the
 * null-embedding singleton rule. The function is pure — it does not
 * mutate the input and emits no logs.
 *
 * ## Edge cases
 *
 * - Empty input → empty output.
 * - Single-candidate input → one cluster containing that candidate. Its
 *   centroid is `normalize(candidate.embedding)` when the embedding is
 *   non-null, or `null` otherwise.
 * - All-null-embedding batch → one singleton cluster per candidate,
 *   each with a null centroid.
 *
 * @param candidates - The batch to cluster. Not mutated.
 * @param threshold - Cosine-similarity floor at or above which two
 *   candidates merge. Comparison is inclusive (`>=`).
 * @returns A deterministic, partitioning list of clusters over the
 *   input indices.
 *
 * @see Requirements 4.1, 4.2, 4.3, 4.4, 4.6
 */
export function intraBatchCluster(
  candidates: readonly CandidateMemory[],
  threshold: number,
): readonly Cluster[] {
  const n = candidates.length;
  if (n === 0) return [];

  // ── Union-find with path compression + union by rank ────────────────
  //
  // `parent[i]` is `i` when `i` is its own root. `rank[i]` is an upper
  // bound on the height of the subtree rooted at `i`; it is updated
  // only when two distinct roots are merged.
  const parent = new Int32Array(n);
  const rank = new Int32Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;

  function find(x: number): number {
    // Iterative path compression — faster than recursive on large n
    // and safe against stack overflow.
    let root = x;
    while (parent[root] !== root) {
      // `parent[root]` is always in `[0, n)` by construction, so the
      // cast is safe. `noUncheckedIndexedAccess` widens typed-array
      // reads to `number | undefined`; the explicit `number` cast is
      // the idiom used elsewhere in the codebase (see `cosine.ts`).
      root = parent[root] as number;
    }
    let node = x;
    while (parent[node] !== root) {
      const next = parent[node] as number;
      parent[node] = root;
      node = next;
    }
    return root;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const rankA = rank[ra] as number;
    const rankB = rank[rb] as number;
    if (rankA < rankB) {
      parent[ra] = rb;
    } else if (rankA > rankB) {
      parent[rb] = ra;
    } else {
      parent[rb] = ra;
      rank[ra] = rankA + 1;
    }
  }

  // ── Pairwise similarity scan ────────────────────────────────────────
  //
  // Skip any pair where either endpoint has a null embedding. This
  // preserves the null-embedding singleton rule (Requirement 4.4)
  // without needing a special case in the DSU itself — a node that is
  // never union-ed stays in its singleton class by construction.
  for (let i = 0; i < n; i += 1) {
    const ci = candidates[i];
    if (ci === undefined) continue; // Unreachable given `i < n`.
    const ei = ci.embedding;
    if (ei === null) continue;
    for (let j = i + 1; j < n; j += 1) {
      const cj = candidates[j];
      if (cj === undefined) continue; // Unreachable given `j < n`.
      const ej = cj.embedding;
      if (ej === null) continue;
      if (cosine(ei, ej) >= threshold) {
        union(i, j);
      }
    }
  }

  // ── Walk DSU roots in order of first appearance ─────────────────────
  //
  // `rootToMembers.get(root)` accumulates the ascending list of
  // members for that root. `rootOrder` remembers the first index at
  // which each root was seen, so we can emit clusters in deterministic
  // order (sorted by that first-appearance index, which equals the
  // minimum member index within each cluster).
  const rootToMembers = new Map<number, number[]>();
  const rootOrder: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const existing = rootToMembers.get(root);
    if (existing === undefined) {
      rootToMembers.set(root, [i]);
      rootOrder.push(root);
    } else {
      existing.push(i);
    }
  }

  // `rootOrder` is already in ascending order of first-appearance
  // index because we visit `i` from `0` upward. No sort needed.
  const clusters: Cluster[] = [];
  for (const root of rootOrder) {
    const members = rootToMembers.get(root);
    if (members === undefined) continue; // Unreachable.
    clusters.push({
      members,
      centroid: computeCentroid(members, candidates),
    });
  }

  return clusters;
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Compute the L2-normalised mean of the embeddings belonging to a
 * cluster's members.
 *
 * Returns `null` when any member has a null embedding. The singleton
 * rule in {@link intraBatchCluster} already guarantees that a multi-
 * member cluster never contains a null-embedding candidate, but the
 * guard is kept here as defence-in-depth and to handle singleton
 * clusters whose single member happens to be a null-embedding
 * candidate.
 *
 * The centroid is computed by accumulating a Float64 sum in a fresh
 * buffer, dividing by the member count, and then handing off to
 * {@link normalize} for the L2 normalisation step. Float64
 * accumulation keeps the mean numerically stable even for clusters
 * whose individual vectors are close to machine-epsilon separation —
 * the final normalisation cancels any constant factor error.
 *
 * When every member shares an identical embedding the mean equals
 * that vector and `normalize` returns its L2-normalised form; when
 * the member embeddings sum to the zero vector (pairwise antiparallel
 * pairs), `normalize` returns a zero vector by the same zero-norm
 * rule used in `cosine.ts`. A zero centroid is a legitimate result —
 * the reconciler's neighbor-lookup path filters it out by the
 * threshold gate without any special case here.
 */
function computeCentroid(
  members: readonly number[],
  candidates: readonly CandidateMemory[],
): Float32Array | null {
  if (members.length === 0) return null; // Unreachable: clusters are non-empty.

  // Resolve the first embedding to discover dimensionality. If any
  // member has a null embedding we short-circuit to `null` immediately.
  const firstIdx = members[0] as number;
  const first = candidates[firstIdx];
  if (first === undefined) return null; // Unreachable.
  const firstEmbedding = first.embedding;
  if (firstEmbedding === null) return null;

  const dims = firstEmbedding.length;
  const sum = new Float64Array(dims);

  for (const idx of members) {
    const c = candidates[idx];
    if (c === undefined) return null; // Unreachable.
    const e = c.embedding;
    if (e === null) return null; // Taint: any null embedding → null centroid.
    for (let k = 0; k < dims; k += 1) {
      // Float64 accumulator + Float32 input — the cast-and-add is
      // numerically stable up to the member count we realistically
      // encounter (single-digit in production).
      sum[k] = (sum[k] as number) + (e[k] as number);
    }
  }

  const mean = new Float32Array(dims);
  const invN = 1 / members.length;
  for (let k = 0; k < dims; k += 1) {
    mean[k] = (sum[k] as number) * invN;
  }

  return normalize(mean);
}
