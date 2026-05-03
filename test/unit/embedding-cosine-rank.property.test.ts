/**
 * Property-based test for the `topKByCosine` ranking helper.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 7: Cosine
 * ranking is sorted and excludes missing embeddings.
 *
 * Asserts the four-part contract of `topKByCosine(q, index, k)` in
 * `src/collector/embedding/cosine.ts`:
 *
 *   1. The result length is at most `k` (the caller's cap).
 *   2. The result length is at most the number of non-zero-vector
 *      entries in the index. Entries whose `vec_normalised` is the
 *      zero vector are skipped: these stand in for records that
 *      either had a NULL stored embedding (never actually reach the
 *      ranker because `listEmbeddings` filters them out upstream) or
 *      whose raw embedding had zero norm and therefore normalised to
 *      zero. Either way, they must not surface in the top-`k`.
 *   3. Every returned entry's `record_id` came from the non-zero-
 *      vector group — never from the zero-vector stubs.
 *   4. The result is sorted in non-increasing order of `similarity`.
 *
 * The generator builds a `VectorIndexLike` fixture by pairing each
 * record from a small `arbitraryMemoryRecord()` array with a
 * randomly-chosen "embedded" or "missing" flag. Embedded entries
 * carry a finite, L2-normalised random vector. Missing entries carry
 * a zero vector, standing in for the NULL-embedding case at the
 * ranker's boundary. The query vector is a finite random vector
 * (not necessarily normalised — `cosine` is scale-invariant, so the
 * ranking is the same either way). `k` is drawn from `[0, n + 2]`
 * so the suite exercises `k = 0`, `k < n`, `k = n`, and `k > n`.
 *
 * Dimensionality is fixed at 16 for runtime. The 384-dim production
 * path exercises the same code — the dimension does not affect the
 * invariants under test, only wall time.
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md § Property 7
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md
 *      § Requirements 7.1, 7.2, 7.3
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { MemoryRecord } from '../../src/types/index.js';

import {
  normalize,
  topKByCosine,
  type VectorIndexEntry,
  type VectorIndexLike,
} from '../../src/collector/embedding/cosine.js';
import { arbitraryMemoryRecord } from '../helpers/arbitrary.js';

/**
 * Dimensionality for the test vectors. Small enough that 200 runs
 * stay well inside the suite budget, large enough that the dot
 * product and norm accumulators exercise the same floating-point
 * rounding behaviour as the real 384-dim path.
 */
const DIM = 16;

/**
 * Arbitrary finite `Float32Array` of exact length `len`. Every
 * element survives a `Math.fround` round-trip because
 * `fc.float({ noNaN: true, noDefaultInfinity: true })` is already
 * `float32`-precise, so `Float32Array.from(arr)` is lossless.
 *
 * Narrower than the shared `arbitraryFloat32Array` helper: that
 * generator admits `NaN` and ±Infinity for the BLOB round-trip
 * property, but cosine math is only well-defined on finite inputs.
 */
function finiteFloat32Array(len: number): fc.Arbitrary<Float32Array> {
  return fc
    .array(fc.float({ noNaN: true, noDefaultInfinity: true }), {
      minLength: len,
      maxLength: len,
    })
    .map((arr) => Float32Array.from(arr));
}

/**
 * Compute the L2 norm of a `Float32Array` in `number` (64-bit)
 * precision. Used to tell "embedded" entries from "missing" ones
 * without re-running the implementation's own zero-norm check.
 */
function l2Norm(v: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < v.length; i += 1) {
    const x = v[i] as number;
    sumSq += x * x;
  }
  return Math.sqrt(sumSq);
}

/**
 * Shape describing one entry in the generated index. `missing`
 * entries stand in for records with a NULL stored embedding that
 * somehow reached the ranker, plus the pathological all-zero
 * embedding case: either way, `topKByCosine` must skip them.
 */
interface IndexEntrySpec {
  readonly record: MemoryRecord;
  readonly missing: boolean;
  readonly rawVec: Float32Array;
}

/**
 * Arbitrary index-entry spec: a `MemoryRecord` paired with either a
 * finite random vector ("embedded") or a zero vector ("missing").
 *
 * The `rawVec` carried by embedded entries is the pre-normalisation
 * vector — the test fixture runs it through `normalize` when
 * building the actual `VectorIndexEntry`. This matches how the
 * `NamespaceVectorCache` builds index entries from stored BLOBs.
 */
function arbitraryIndexEntrySpec(): fc.Arbitrary<IndexEntrySpec> {
  return fc
    .record({
      record: arbitraryMemoryRecord(),
      // 25% of entries are missing — frequent enough to exercise
      // the skip path on most runs, rare enough that most runs
      // also have a meaningful non-zero top-`k` to rank.
      missing: fc.boolean().chain((b) =>
        fc.boolean().map((b2) => b && b2),
      ),
      vec: finiteFloat32Array(DIM),
    })
    .map(({ record, missing, vec }) => ({
      record,
      missing,
      rawVec: missing ? new Float32Array(DIM) : vec,
    }));
}

/**
 * Materialise a `VectorIndexLike` from the generated specs.
 *
 * - Embedded specs contribute an entry whose `vec_normalised` is
 *   the L2-normalised form of `rawVec`. If `rawVec`'s `float32`
 *   norm is zero (via underflow or all-zero elements), `normalize`
 *   returns a zero vector — we treat that spec as effectively
 *   missing for the purpose of the assertions below.
 * - Missing specs contribute an entry with a zero `vec_normalised`.
 *
 * All `record_id`s are drawn from `arbitraryMemoryRecord`, which
 * produces fresh ULIDs per call — so every entry has a unique id.
 */
function buildIndex(specs: readonly IndexEntrySpec[]): {
  index: VectorIndexLike;
  nonZeroIds: ReadonlySet<string>;
} {
  const entries: VectorIndexEntry[] = [];
  const nonZeroIds = new Set<string>();
  for (const spec of specs) {
    const vecNormalised = normalize(spec.rawVec);
    entries.push({
      record_id: spec.record.record_id,
      record: spec.record,
      vec_normalised: vecNormalised,
    });
    if (!spec.missing && l2Norm(vecNormalised) > 0) {
      nonZeroIds.add(spec.record.record_id);
    }
  }
  return { index: { entries }, nonZeroIds };
}

describe('Feature: local-embeddings-and-hybrid-search, Property 7: Cosine ranking is sorted and excludes missing embeddings', () => {
  it('topKByCosine returns ≤ k entries, sorted by descending similarity, excluding zero-vector (missing) entries', () => {
    /**
     * **Validates: Requirements 7.1, 7.2, 7.3**
     *
     * For any query vector `q` and any mixed index (a blend of
     * embedded and missing entries), `topKByCosine(q, index, k)`:
     *
     *   1. Returns at most `k` entries (the caller's cap).
     *   2. Returns at most `|nonZeroIds|` entries (the zero-vector
     *      skip path excludes missing entries entirely).
     *   3. Contains only ids from `nonZeroIds` — never a missing-
     *      entry id, even when `q` is itself the zero vector (in
     *      which case every similarity is `0` by the zero-norm
     *      guard but the skip path still prunes the stubs).
     *   4. Is sorted in non-increasing order of `similarity`.
     *
     * `k` is drawn from `[0, n + 2]` so the run distribution
     * covers `k = 0` (empty result), `k < n` (real truncation),
     * `k = n` (exact fit), and `k > n` (cap does not bind).
     */
    fc.assert(
      fc.property(
        fc.array(arbitraryIndexEntrySpec(), { minLength: 0, maxLength: 12 }),
        finiteFloat32Array(DIM),
        // `k` ranges over `[0, 14]` — larger than the max spec count
        // of 12 so `k > n` is reachable; includes `0` so the empty-
        // result branch is exercised.
        fc.integer({ min: 0, max: 14 }),
        (specs, q, k) => {
          const { index, nonZeroIds } = buildIndex(specs);
          const hits = topKByCosine(q, index, k);

          // (1) Length ≤ k.
          expect(hits.length).toBeLessThanOrEqual(k);

          // (2) Length ≤ number of non-zero entries.
          expect(hits.length).toBeLessThanOrEqual(nonZeroIds.size);

          // (3) Every returned id came from the non-zero group —
          // never a missing stub.
          for (const hit of hits) {
            expect(nonZeroIds.has(hit.record_id)).toBe(true);
          }

          // (4) Sorted by descending similarity (non-increasing).
          for (let i = 1; i < hits.length; i += 1) {
            const prev = hits[i - 1];
            const curr = hits[i];
            // `noUncheckedIndexedAccess` — both are defined by loop
            // bounds; narrow for the type-checker.
            if (prev === undefined || curr === undefined) continue;
            expect(prev.similarity).toBeGreaterThanOrEqual(curr.similarity);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
