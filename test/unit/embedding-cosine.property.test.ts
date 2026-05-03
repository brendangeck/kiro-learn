/**
 * Property-based test for cosine similarity well-definedness.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 3: Cosine
 * similarity is well-defined and bounded.
 *
 * Asserts three sub-clauses of the `cosine(a, b)` contract in
 * `src/collector/embedding/cosine.ts`:
 *
 *   1. Zero-norm inputs on either side yield exactly `0`. This is the
 *      explicit zero-norm guard in the implementation — without it a
 *      division-by-zero would produce `NaN` and poison the sort order
 *      in `topKByCosine`.
 *   2. For any two non-zero finite vectors of equal length, the
 *      cosine lies inside the closed interval `[-1, 1]` up to a
 *      small floating-point tolerance. The tolerance is needed
 *      because the squared-norm accumulator, the square roots, and
 *      the final division each introduce a rounding error that can
 *      push a theoretically unit value a few ULPs outside the
 *      mathematical range.
 *   3. For any non-zero finite vector `a`, `cosine(a, a)` is equal to
 *      `1` up to the same tolerance. The identity is exact in real
 *      arithmetic but the `float32` accumulator makes it approximate
 *      in practice.
 *
 * All three sub-properties are restricted to *finite* `float32`
 * values. The `arbitraryFloat32Array` helper in
 * `test/helpers/arbitrary.ts` explicitly admits `NaN` and ±Infinity
 * so the BLOB codec can round-trip every bit pattern; cosine, by
 * contrast, is only well-defined over finite inputs — a single `NaN`
 * makes every arithmetic step `NaN`, and ±Infinity makes the squared
 * norms overflow to Infinity and the division collapse to `NaN` or
 * `0`. A local `arbitraryFiniteFloat32Array` generator narrows to
 * finite values so the property statements are meaningful.
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md § Property 3
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md
 *      § Requirements 7.6, 17.4
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cosine } from '../../src/collector/embedding/cosine.js';

/**
 * Dimensionality used by the generators below. Small enough that 500
 * runs stay comfortably within the test-suite budget, large enough
 * that the dot product and both squared-norm accumulators exercise
 * the same floating-point rounding behaviour that the real 384-dim
 * path sees.
 */
const DIM = 16;

/**
 * Tolerance for the `[-1, 1]` bounds and the `cosine(a, a) === 1`
 * identity. Chosen generously enough to absorb the worst-case
 * accumulated rounding across a 16-element sum of products plus two
 * square roots plus one division, while still being tight enough to
 * catch any genuine algorithmic bug.
 *
 * Empirically, the worst-case drift for a 16-element `float32` unit
 * vector round-trip through `cosine(a, a)` is on the order of `1e-6`;
 * `1e-5` gives us an order-of-magnitude safety margin.
 */
const TOLERANCE = 1e-5;

/**
 * Arbitrary `Float32Array` of exact length `len` whose every element
 * is finite (no `NaN`, no ±Infinity).
 *
 * The shared `arbitraryFloat32Array` helper deliberately admits
 * non-finite values because the BLOB codec must preserve them
 * bit-for-bit. Cosine math, however, cannot: a single non-finite
 * element propagates `NaN` through the entire computation. This
 * local helper constrains the input space to the only domain on
 * which cosine is actually well-defined.
 *
 * `fc.float({ noNaN: true, noDefaultInfinity: true })` is already
 * `float32`-precise — every value it yields survives a
 * `Math.fround` round-trip — so `Float32Array.from(arr)` is
 * lossless.
 */
function arbitraryFiniteFloat32Array(len: number): fc.Arbitrary<Float32Array> {
  return fc
    .array(fc.float({ noNaN: true, noDefaultInfinity: true }), {
      minLength: len,
      maxLength: len,
    })
    .map((arr) => Float32Array.from(arr));
}

/**
 * Arbitrary all-zero `Float32Array` of exact length `len`. Used as
 * the canonical zero-norm operand for sub-clause (1). Every element
 * is `+0` so the L2 norm is exactly `0`.
 */
function arbitraryZeroFloat32Array(len: number): fc.Arbitrary<Float32Array> {
  return fc.constant(null).map(() => new Float32Array(len));
}

/**
 * Return the L2 norm of a `Float32Array` computed in `number`
 * (64-bit) precision. Used only to filter out generator-produced
 * vectors whose `float32` norm is zero — we cannot gate the sub-
 * clauses (2) and (3) on "non-zero" without actually checking.
 *
 * A vector that is elementwise small but not all-zero can still have
 * a `float32`-computed norm of `0` via underflow. Computing in
 * `number` precision dodges that trap for the filter itself; the
 * actual `cosine` call still uses `float32` arithmetic internally.
 */
function l2Norm(v: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < v.length; i += 1) {
    const x = v[i] as number;
    sumSq += x * x;
  }
  return Math.sqrt(sumSq);
}

describe('Feature: local-embeddings-and-hybrid-search, Property 3: Cosine similarity is well-defined and bounded', () => {
  it('zero-norm input (either side) yields exactly 0', () => {
    /**
     * **Validates: Requirements 7.6, 17.4**
     *
     * When either operand is the all-zero vector, the cosine is
     * defined to be exactly `0` — not `NaN`, not some small
     * floating-point noise. This is the explicit zero-norm guard in
     * `cosine.ts`; without it the `sqrt(0) * sqrt(normB)` divisor
     * would be `0` and the division would yield `NaN`, which would
     * propagate into the top-`k` sort comparator in `topKByCosine`
     * and produce non-deterministic rankings.
     *
     * The property asserts the guard fires symmetrically for both
     * argument positions.
     */
    fc.assert(
      fc.property(
        arbitraryZeroFloat32Array(DIM),
        arbitraryFiniteFloat32Array(DIM),
        (zero, other) => {
          // Zero on the left.
          expect(cosine(zero, other)).toBe(0);
          // Zero on the right.
          expect(cosine(other, zero)).toBe(0);
          // Zero on both sides (degenerate corner: both norms are
          // zero, the guard still short-circuits to `0`).
          expect(cosine(zero, zero)).toBe(0);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('non-zero inputs yield a value in [-1, 1] up to tolerance', () => {
    /**
     * **Validates: Requirements 7.6, 17.4**
     *
     * Cosine similarity is the cosine of the angle between two
     * vectors, so its exact-arithmetic range is `[-1, 1]`. In
     * `float32` the accumulated rounding across the dot product, the
     * two squared-norm sums, both square roots, and the final
     * division can push the result a few ULPs outside that range.
     * We admit a small tolerance in each direction; any result more
     * than `TOLERANCE` outside `[-1, 1]` indicates a genuine
     * algorithmic error.
     *
     * Vectors whose `float32`-precision norm is zero (via underflow
     * or all-zero elements) are excluded via `fc.pre` — those fall
     * under sub-clause (1), not this one.
     */
    fc.assert(
      fc.property(
        arbitraryFiniteFloat32Array(DIM),
        arbitraryFiniteFloat32Array(DIM),
        (a, b) => {
          fc.pre(l2Norm(a) > 0);
          fc.pre(l2Norm(b) > 0);
          const c = cosine(a, b);
          expect(Number.isFinite(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(-1 - TOLERANCE);
          expect(c).toBeLessThanOrEqual(1 + TOLERANCE);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('cosine(a, a) === 1 within tolerance for non-zero a', () => {
    /**
     * **Validates: Requirements 7.6, 17.4**
     *
     * For any non-zero vector `a`, the angle between `a` and itself
     * is zero, so `cos 0 = 1` exactly in real arithmetic. In
     * `float32` the implementation computes `dot(a, a) / (||a|| *
     * ||a||)`, which is mathematically `1` but floating-point-
     * approximately `1` after the accumulated rounding. The
     * tolerance `TOLERANCE` is wide enough to absorb the worst-case
     * drift observed empirically at `DIM = 16` and tight enough to
     * flag any correctness regression.
     *
     * As with sub-clause (2), we gate on a strictly positive L2
     * norm so the zero-norm guard path does not appear here — the
     * guard would return `0`, not `1`, and would belong under sub-
     * clause (1) instead.
     */
    fc.assert(
      fc.property(arbitraryFiniteFloat32Array(DIM), (a) => {
        fc.pre(l2Norm(a) > 0);
        const c = cosine(a, a);
        expect(Math.abs(c - 1)).toBeLessThan(TOLERANCE);
      }),
      { numRuns: 500 },
    );
  });
});
