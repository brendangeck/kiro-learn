/**
 * Property-based test for the Reciprocal Rank Fusion (`rrfFuse`) algebraic
 * contract.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 6: RRF fusion
 * satisfies its algebraic contract.
 *
 * `rrfFuse` is the pure fusion layer that combines two ranked candidate
 * lists (lexical from FTS5, vector from cosine) into a single ranked list
 * via Reciprocal Rank Fusion. Its contract has seven clauses — each
 * verified by an independent `it` block below:
 *
 * 1. **Size.**              `|result| ≤ min(limit, |L ∪ V|)`.
 * 2. **Score formula.**     For every `d` in the result,
 *                           `fused_score === 1/(k+rank_L(d)) + 1/(k+rank_V(d))`
 *                           where absence contributes `0`.
 * 3. **Ordering.**          Monotonically non-increasing `fused_score`.
 * 4. **Rank monotonicity.** Same `rank_L`, strictly worse `rank_V` →
 *                           strictly smaller fused score.
 * 5. **Agreement.**         Identical permutations fuse to the same
 *                           permutation (truncated to `limit`).
 * 6. **Lexical-only fallback.** `V === []` returns `L` truncated to `limit`.
 * 7. **Vector-only fallback.**  `L === []` returns `V` truncated to `limit`.
 *
 * The input ranked lists are drawn with the new `arbitraryRankedList(ids)`
 * helper from `test/helpers/arbitrary.ts`. A small, fixed id pool keeps
 * shrinks readable and maximises overlap between the two lists (the most
 * interesting case for the score formula, ordering, and agreement
 * clauses).
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md § Property 6
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md
 *      § Requirements 5.2, 5.4, 16.5, 16.6, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Ranked } from '../../src/collector/embedding/rrf.js';
import { rrfFuse } from '../../src/collector/embedding/rrf.js';
import { arbitraryRankedList } from '../helpers/arbitrary.js';

/**
 * Small id pool used throughout the property tests. Seven elements is
 * enough to exercise the full combinatorial space of overlaps between
 * the two ranked lists (every subset appears with non-trivial
 * probability) while keeping shrunk counter-examples readable.
 */
const ID_POOL = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;

/** Floating-point tolerance for fused-score equality assertions. */
const FP_TOLERANCE = 1e-10;

/** Look up a `Ranked` entry's rank by id; `null` for absent. */
function rankOf(list: readonly Ranked[], id: string): number | null {
  for (const r of list) {
    if (r.record_id === id) return r.rank;
  }
  return null;
}

/**
 * Expected RRF fused score for id `d` given the two input lists and `k`.
 * Matches the formula in Requirement 18.2: absence from a list
 * contributes `0`; presence contributes `1 / (k + rank)`.
 */
function expectedScore(
  lexical: readonly Ranked[],
  vector: readonly Ranked[],
  id: string,
  k: number,
): number {
  const rl = rankOf(lexical, id);
  const rv = rankOf(vector, id);
  let score = 0;
  if (rl !== null) score += 1 / (k + rl);
  if (rv !== null) score += 1 / (k + rv);
  return score;
}

describe('Feature: local-embeddings-and-hybrid-search, Property 6: RRF fusion satisfies its algebraic contract', () => {
  it('size: |result| ≤ min(limit, |L ∪ V|)', () => {
    /**
     * **Validates: Requirements 18.1, 16.5**
     *
     * Coverage of the union is bounded by `|L ∪ V|` because RRF cannot
     * invent ids that are absent from both inputs, and the `limit`
     * parameter caps the output regardless of how large the union is.
     * The size clause therefore says nothing more than the obvious —
     * but it protects against bugs like "forget to truncate" or
     * "accidentally duplicate an id" at the fusion layer.
     */
    fc.assert(
      fc.property(
        arbitraryRankedList(ID_POOL as unknown as string[]),
        arbitraryRankedList(ID_POOL as unknown as string[]),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 20 }),
        (lex, vec, k, limit) => {
          const result = rrfFuse(lex, vec, k, limit);

          const union = new Set<string>();
          for (const r of lex) union.add(r.record_id);
          for (const r of vec) union.add(r.record_id);

          expect(result.length).toBeLessThanOrEqual(
            Math.min(limit, union.size),
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it('score formula: fused_score === 1/(k+rank_L) + 1/(k+rank_V)', () => {
    /**
     * **Validates: Requirements 5.2, 18.2**
     *
     * For every id in the result, the `fused_score` reported by
     * `rrfFuse` must equal the per-id recomputation of the RRF
     * formula from the original input lists — treating absence from
     * a list as a zero contribution. The tolerance is loose enough
     * to swallow ordinary IEEE-754 rounding in the `1 / (k + rank)`
     * divisions but tight enough to catch any systematic error.
     */
    fc.assert(
      fc.property(
        arbitraryRankedList(ID_POOL as unknown as string[]),
        arbitraryRankedList(ID_POOL as unknown as string[]),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 20 }),
        (lex, vec, k, limit) => {
          const result = rrfFuse(lex, vec, k, limit);
          for (const hit of result) {
            const expected = expectedScore(lex, vec, hit.record_id, k);
            expect(Math.abs(hit.fused_score - expected)).toBeLessThan(
              FP_TOLERANCE,
            );
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('ordering: fused_score is monotonically non-increasing', () => {
    /**
     * **Validates: Requirements 5.4, 18.6**
     *
     * Two adjacent results must satisfy
     * `result[i].fused_score >= result[i + 1].fused_score`. This is the
     * top-level contract that downstream code (the query-layer
     * tie-break) leans on: without it, the order of the fused list
     * would be meaningless.
     */
    fc.assert(
      fc.property(
        arbitraryRankedList(ID_POOL as unknown as string[]),
        arbitraryRankedList(ID_POOL as unknown as string[]),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 20 }),
        (lex, vec, k, limit) => {
          const result = rrfFuse(lex, vec, k, limit);
          for (let i = 0; i < result.length - 1; i++) {
            const a = result[i];
            const b = result[i + 1];
            // `noUncheckedIndexedAccess` makes these `Fused | undefined`;
            // the loop bounds guarantee they are defined.
            if (a === undefined || b === undefined) {
              throw new Error(`ordering: result index ${i} was undefined`);
            }
            expect(a.fused_score).toBeGreaterThanOrEqual(b.fused_score);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('rank monotonicity: same rank_L, strictly worse rank_V → strictly smaller fused score', () => {
    /**
     * **Validates: Requirements 18.2, 18.6**
     *
     * The RRF contribution `1 / (k + rank)` is strictly decreasing in
     * `rank` for `k + rank > 0`. So two ids with identical `rank_L`
     * but different `rank_V` must order their fused scores by their
     * vector ranks — the better (smaller) `rank_V` wins.
     *
     * The two ids share `rank_L === 1`, so the two lexical
     * contributions cancel and the fused-score comparison reduces to
     * the vector contribution alone. The better (smaller) `rank_V`
     * must therefore produce the strictly larger fused score.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        // Two distinct vector ranks. We pick them with `min < max` so
        // the doc at rank `min` (better) should outrank the doc at
        // rank `max` (worse).
        fc
          .tuple(
            fc.integer({ min: 1, max: 50 }),
            fc.integer({ min: 1, max: 50 }),
          )
          .filter(([a, b]) => a !== b)
          .map(([a, b]): [number, number] => (a < b ? [a, b] : [b, a])),
        (k, [betterV, worseV]) => {
          const lex: Ranked[] = [
            { record_id: 'x', rank: 1 },
            { record_id: 'y', rank: 1 },
          ];
          const vec: Ranked[] = [
            { record_id: 'x', rank: betterV },
            { record_id: 'y', rank: worseV },
          ];

          const result = rrfFuse(lex, vec, k, 10);
          const byId = new Map(result.map((r) => [r.record_id, r]));
          const x = byId.get('x');
          const y = byId.get('y');
          expect(x).toBeDefined();
          expect(y).toBeDefined();
          // `fused_score` for `x` (better `rank_V`) must be strictly
          // greater than that of `y` (worse `rank_V`).
          if (x !== undefined && y !== undefined) {
            expect(x.fused_score).toBeGreaterThan(y.fused_score);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('agreement preservation: identical permutations fuse to the same permutation', () => {
    /**
     * **Validates: Requirements 18.3**
     *
     * When `L === V` as permutations, every id has `rank_L === rank_V`,
     * which means the fused scores are all `2 / (k + rank)` — a
     * strictly decreasing function of `rank`. So the fused order must
     * reproduce the input order, truncated to `limit`.
     */
    fc.assert(
      fc.property(
        arbitraryRankedList(ID_POOL as unknown as string[]),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 20 }),
        (permutation, k, limit) => {
          const result = rrfFuse(permutation, permutation, k, limit);
          const expectedIds = permutation
            .slice(0, limit)
            .map((r) => r.record_id);
          const actualIds = result.map((r) => r.record_id);
          expect(actualIds).toEqual(expectedIds);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('lexical-only fallback: V === [] returns L truncated to limit', () => {
    /**
     * **Validates: Requirements 18.4, 16.6**
     *
     * With `V === []`, every id's fused score is `1 / (k + rank_L)`,
     * strictly decreasing in `rank_L`. The output therefore matches
     * the lexical input order, truncated to `limit`. This is the
     * degraded-path shape the hybrid layer leans on when the
     * embedder is unavailable or the query cannot be embedded.
     */
    fc.assert(
      fc.property(
        arbitraryRankedList(ID_POOL as unknown as string[]),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 20 }),
        (lex, k, limit) => {
          const result = rrfFuse(lex, [], k, limit);
          const expectedIds = lex.slice(0, limit).map((r) => r.record_id);
          const actualIds = result.map((r) => r.record_id);
          expect(actualIds).toEqual(expectedIds);
          // Every hit's `vec_rank` should be `null` because the vector
          // list was empty — a small consistency check on the fused
          // shape.
          for (const hit of result) {
            expect(hit.vec_rank).toBeNull();
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('vector-only fallback: L === [] returns V truncated to limit', () => {
    /**
     * **Validates: Requirements 18.5**
     *
     * Symmetric to the lexical-only fallback. With `L === []`, every
     * id's fused score is `1 / (k + rank_V)`, so the fused order
     * matches the vector input order truncated to `limit`. This
     * shape matters when the lexical tokeniser yields nothing but
     * the vector retriever still has candidates to rank.
     */
    fc.assert(
      fc.property(
        arbitraryRankedList(ID_POOL as unknown as string[]),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 1, max: 20 }),
        (vec, k, limit) => {
          const result = rrfFuse([], vec, k, limit);
          const expectedIds = vec.slice(0, limit).map((r) => r.record_id);
          const actualIds = result.map((r) => r.record_id);
          expect(actualIds).toEqual(expectedIds);
          for (const hit of result) {
            expect(hit.lex_rank).toBeNull();
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
