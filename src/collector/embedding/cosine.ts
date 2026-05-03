/**
 * Cosine similarity and vector normalisation helpers.
 *
 * Pure, storage-agnostic math for the hybrid search read path. The
 * `QueryLayer` pre-normalises every vector in its per-namespace cache
 * (design § Vector index cache shape) so that hot-path cosine against
 * a normalised query reduces to a single dot product per record. When
 * either operand is a zero vector, the cosine is defined to be
 * exactly `0` — this is the explicit zero-norm guard required by
 * Req 7.6 / 17.4 and exercised by Property 3.
 *
 * No dependency on an embedding dimensionality is baked in here;
 * the helpers accept arbitrarily long `Float32Array` values so long
 * as the two operands to `cosine` have equal length. The 384-dim
 * contract is enforced at the BLOB codec boundary in `./blob.ts`,
 * not here.
 *
 * This module is pure: no imports from `src/collector/storage/sqlite/`,
 * `src/shim/`, `src/installer/`, or `src/mcp/`. It imports from
 * `src/types/` only (for `MemoryRecord`), matching the modularity
 * rules declared in design § Components and Interfaces.
 *
 * @see Requirements 7.1, 7.2, 7.3, 7.6, 17.4
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — `cosine(a, b)`
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Property 3 (cosine well-definedness); Property 7 (ranking)
 * @module
 */

import type { MemoryRecord } from '../../types/index.js';

/**
 * One entry in a per-namespace vector index, as produced by the
 * `NamespaceVectorCache` (task 6.1) and consumed by {@link topKByCosine}.
 *
 * `vec_normalised` is the L2-normalised form of the stored 384-dim
 * embedding. Entries whose raw embedding was the zero vector (all
 * elements exactly `0`) are represented with a zero-vector
 * `vec_normalised` — {@link topKByCosine} skips those so they never
 * surface as a spurious "cosine 0" tie in the top-`k`.
 *
 * Declared here so the cosine module does not have to import the
 * query-layer cache type. The cache (task 6.1) declares a
 * structurally identical shape and re-exports this type via the
 * embedding barrel.
 *
 * @see Requirements 7.1, 7.2, 7.3
 */
export interface VectorIndexEntry {
  readonly record_id: string;
  readonly record: MemoryRecord;
  readonly vec_normalised: Float32Array;
}

/**
 * Shape passed to {@link topKByCosine}. Matches the
 * `NamespaceVectorIndex` declared by the per-namespace cache (task
 * 6.1); the cosine module only needs the `entries` list, so the
 * parameter type is narrowed here to the single field it reads. Any
 * object that structurally satisfies this shape — including a full
 * `NamespaceVectorIndex` — is acceptable at the callsite.
 *
 * @see Requirements 7.1, 7.2, 7.3
 */
export interface VectorIndexLike {
  readonly entries: ReadonlyArray<VectorIndexEntry>;
}

/**
 * One scored hit returned by {@link topKByCosine}.
 *
 * `similarity` is the cosine similarity as computed against the
 * pre-normalised index vector — i.e. `dot(q, vec_normalised) /
 * (||q||)` when `q` is not itself normalised, or simply `dot(q,
 * vec_normalised)` when the caller has already normalised `q`.
 *
 * The `record` is carried through so the query layer can map fused
 * vector-only hits back to a full `MemoryRecord` without re-
 * reading from storage (design § Sequence: hybrid search on read).
 *
 * @see Requirements 7.1, 7.2, 7.3
 */
export interface CosineHit {
  readonly record_id: string;
  readonly record: MemoryRecord;
  readonly similarity: number;
}

/**
 * Compute cosine similarity between two equal-length vectors.
 *
 * Contract (design § `cosine(a, b)`; Req 7.6, 17.4):
 *
 * - Assumes `a.length === b.length`. The caller is responsible for
 *   dimensional agreement; no assertion is performed in the hot path.
 * - Returns exactly `0` when either operand has L2 norm zero. This
 *   is a hard-coded guard rather than a floating-point accident:
 *   the division-by-zero would otherwise yield `NaN`, which would
 *   propagate through sort comparisons in unpredictable ways.
 * - Otherwise returns `dot(a, b) / (||a|| * ||b||)`. Result range is
 *   the closed interval `[-1, 1]` up to floating-point tolerance.
 *
 * Implementation computes the dot product and both squared norms in
 * a single pass to maximise cache locality and avoid building any
 * intermediate arrays. The final square roots are taken once at the
 * end. This matters because cosine is called inside a hot loop in
 * {@link topKByCosine}.
 *
 * @param a - First vector.
 * @param b - Second vector of identical length.
 * @returns Cosine similarity, or `0` if either operand is the zero
 *   vector.
 *
 * @see Requirements 7.6, 17.4
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i += 1) {
    // `noUncheckedIndexedAccess` widens `a[i]` / `b[i]` to
    // `number | undefined` even though `i < n === a.length`. The
    // explicit cast is safe and local to the hot loop.
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Return a fresh L2-normalised copy of `a`.
 *
 * The returned `Float32Array` is always a new heap allocation — it
 * never aliases the input. This matters because the vector index
 * cache holds normalised vectors indefinitely while the raw
 * embedding may be backed by a short-lived SQLite row buffer.
 *
 * Contract:
 *
 * - If the L2 norm of `a` is exactly zero (all elements `0`), returns
 *   a fresh zero vector of the same length. Subsequent cosine
 *   computations against this entry therefore yield exactly `0` (by
 *   the zero-norm guard in {@link cosine}), and {@link topKByCosine}
 *   skips entries whose normalised form is the zero vector so they
 *   do not pollute the top-`k`.
 * - Otherwise returns `a / ||a||`, elementwise.
 *
 * @param a - Input vector. Not mutated.
 * @returns A freshly allocated `Float32Array` of the same length.
 *
 * @see Requirements 7.1, 7.6
 */
export function normalize(a: Float32Array): Float32Array {
  const n = a.length;
  let normSq = 0;
  for (let i = 0; i < n; i += 1) {
    const ai = a[i] as number;
    normSq += ai * ai;
  }
  const out = new Float32Array(n);
  if (normSq === 0) return out;
  const inv = 1 / Math.sqrt(normSq);
  for (let i = 0; i < n; i += 1) {
    out[i] = (a[i] as number) * inv;
  }
  return out;
}

/**
 * Rank index entries by cosine similarity to `q` and return the top
 * `k`.
 *
 * Consumed by the `QueryLayer` hybrid-search read path (task 8.2)
 * with `k = fetchDepth` (default `limit × 4 = 40`). The returned
 * list is the vector-side ranking that then feeds into
 * `rrfFuse` (task 3.8).
 *
 * Contract (Req 7.1, 7.2, 7.3; design § Property 7):
 *
 * - Entries whose `vec_normalised` is the zero vector are skipped
 *   entirely. These correspond to records stored with an all-zero
 *   embedding (degenerate input) or records whose raw embedding
 *   had zero norm; in both cases the cosine against `q` would be
 *   exactly `0` and carrying them into the top-`k` would
 *   manufacture a spurious tie. The cache excludes `NULL`-
 *   embedding records already (via `listEmbeddings`), so the only
 *   zero-vector entries reaching this function came from the
 *   pathological degenerate-input path.
 * - Remaining entries are scored via {@link cosine} and sorted in
 *   descending order of similarity.
 * - The returned array has length `min(k, nonZeroEntryCount)`.
 * - When `k <= 0`, returns an empty array.
 *
 * Implementation is O(n log n) via a full sort. For the scale
 * target (`n ≤ 50 000`, `k ≤ ~40`) this comfortably fits within the
 * 500 ms read budget; the constant-time sort comparisons dominate
 * any potential saving from a partial-sort / heap approach.
 *
 * Ties in `similarity` are left in the order produced by the
 * underlying sort — the hybrid layer applies its own richer tie-
 * break (`fused_score DESC, created_at DESC, record_id ASC`) after
 * RRF fusion, so a stable-but-unspecified tie order here is
 * acceptable.
 *
 * @param q - Query vector. Typically the raw (un-normalised) query
 *   embedding: the index entries are pre-normalised, so cosine
 *   against `q` gives the correct similarity regardless of whether
 *   `q` itself is normalised. If `q` is the zero vector, every
 *   entry scores `0` via the zero-norm guard and the result is
 *   empty (all entries are skipped or all tie at `0` then get
 *   filtered — actually every cosine against a zero `q` returns
 *   `0`, and we do NOT skip non-zero entries for scoring `0`, so
 *   the caller sees a tied-at-zero list of length `min(k, n)`).
 * @param index - Object exposing a read-only `entries` array. Any
 *   object structurally matching {@link VectorIndexLike} — e.g.
 *   the full `NamespaceVectorIndex` produced by the cache — is
 *   acceptable.
 * @param k - Maximum number of hits to return. Non-positive
 *   values yield an empty array.
 * @returns A sorted array of {@link CosineHit}, length at most `k`.
 *
 * @see Requirements 7.1, 7.2, 7.3
 */
export function topKByCosine(
  q: Float32Array,
  index: VectorIndexLike,
  k: number,
): ReadonlyArray<CosineHit> {
  if (k <= 0) return [];
  const scored: CosineHit[] = [];
  for (const entry of index.entries) {
    if (isZeroVector(entry.vec_normalised)) continue;
    scored.push({
      record_id: entry.record_id,
      record: entry.record,
      similarity: cosine(q, entry.vec_normalised),
    });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  if (scored.length <= k) return scored;
  return scored.slice(0, k);
}

/**
 * Return `true` iff every element of `v` is exactly `0`.
 *
 * Used by {@link topKByCosine} to skip entries whose normalised
 * vector collapsed to zero (Req 7.6). Walks the array and bails out
 * on the first non-zero element for fast-path rejection.
 */
function isZeroVector(v: Float32Array): boolean {
  for (let i = 0; i < v.length; i += 1) {
    if ((v[i] as number) !== 0) return false;
  }
  return true;
}
