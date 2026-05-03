/**
 * Property-based test for the embedding BLOB codec round-trip.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 1: BLOB round-trip
 * preserves every bit.
 *
 * For any `Float32Array(384)`, `decodeEmbeddingBlob(encodeEmbeddingBlob(v))`
 * is bitwise-equal to `v`, including `NaN`, `+Infinity`, `-Infinity`, `+0`,
 * `-0`, and subnormals. Equality is asserted over `Uint32Array` views of the
 * two arrays' underlying byte buffers so NaN bit patterns and the
 * `+0` / `-0` distinction are actually compared — ordinary numeric equality
 * would miss both (NaN !== NaN, and `+0 === -0`).
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md § Property 1
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md
 *      § Requirements 4.2, 4.4, 11.1, 15.1, 15.2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_DIMS,
  decodeEmbeddingBlob,
  encodeEmbeddingBlob,
} from '../../src/collector/embedding/blob.js';
import { arbitraryFloat32Array } from '../helpers/arbitrary.js';

/**
 * Reinterpret a `Float32Array`'s bytes as an array of 32-bit unsigned
 * integers so bitwise equality can be asserted. Using `Uint32Array` (rather
 * than `Float32Array#toEqual`) is what makes NaN bit patterns and the
 * `+0` / `-0` distinction observable: `NaN !== NaN` and `+0 === -0` in
 * numeric comparisons, but the underlying 4-byte words differ in both
 * cases.
 *
 * The view aliases the input buffer and is immediately materialised via
 * `Array.from` so the returned array is a plain `number[]` — the shape
 * vitest's `toEqual` understands most directly.
 */
function bitsOf(vec: Float32Array): readonly number[] {
  const view = new Uint32Array(vec.buffer, vec.byteOffset, EMBEDDING_DIMS);
  return Array.from(view);
}

describe('Feature: local-embeddings-and-hybrid-search, Property 1: BLOB round-trip preserves every bit', () => {
  it('round-trips every Float32Array(384) bitwise', () => {
    /**
     * **Validates: Requirements 4.2, 4.4, 11.1, 15.1, 15.2**
     *
     * `encodeEmbeddingBlob` writes every element via
     * `DataView.setFloat32(offset, value, /* littleEndian * / true)` and
     * `decodeEmbeddingBlob` reads via `DataView.getFloat32(offset, true)`,
     * so every IEEE-754 single-precision bit pattern — including NaN
     * payloads, ±Infinity, ±0, and subnormals — is preserved end-to-end.
     * The property holds for any input vector of the correct length.
     */
    fc.assert(
      fc.property(arbitraryFloat32Array(EMBEDDING_DIMS), (vec) => {
        const decoded = decodeEmbeddingBlob(encodeEmbeddingBlob(vec));
        expect(bitsOf(decoded)).toEqual(bitsOf(vec));
      }),
      { numRuns: 500 },
    );
  });
});
