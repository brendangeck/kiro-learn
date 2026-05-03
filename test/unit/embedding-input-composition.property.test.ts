/**
 * Property-based test for `composeEmbeddingInput`.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 2:
 * `composeEmbeddingInput` is deterministic and content-preserving.
 *
 * Asserts the two-part contract of `composeEmbeddingInput(record,
 * maxInputChars)` in `src/collector/embedding/input-composition.ts`:
 *
 *   1. **Determinism.** Two sequential calls on the same record
 *      return identical strings (`===`). The function is a pure
 *      projection of the record's text fields; no process-, clock-,
 *      or ambient-state dependency is allowed. This is the property
 *      the backfill path (design § Sequence: backfill) relies on so
 *      that re-embedding an old record produces the same vector as
 *      the live extraction path produced for that record originally.
 *
 *   2. **Content preservation modulo truncation.** When called with
 *      a cap large enough that no truncation occurs (here: 1 000 000
 *      characters — three orders of magnitude above the
 *      `arbitraryMemoryRecord()` upper bound), the returned string
 *      contains `record.title`, `record.summary`, every element of
 *      `record.facts`, and every element of `record.concepts` as a
 *      substring. Separately, when called with the default cap
 *      (`DEFAULT_MAX_INPUT_CHARS = 10 000`), the returned string's
 *      `.length` is `≤ 10 000`. The containment check and the
 *      length check run on independent calls so the assertions stay
 *      decoupled from any particular suffix the truncation may
 *      remove.
 *
 * The generator is the shared `arbitraryMemoryRecord()` from
 * `test/helpers/arbitrary.ts`, which produces records whose text
 * fields satisfy the wire-schema bounds (`title ≤ 200 chars`,
 * `summary ≤ 4 000 chars`, up to 10 facts of ≤ 500 chars, up to 10
 * concepts of ≤ 100 chars). The worst-case composed length lands
 * just above 10 000, so default-cap truncation is reachable on the
 * tail of the distribution — the length assertion exercises it on
 * every run regardless of whether truncation actually fired.
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md § Property 2
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md
 *      § Requirements 3.2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_INPUT_CHARS,
  composeEmbeddingInput,
} from '../../src/collector/embedding/input-composition.js';
import { arbitraryMemoryRecord } from '../helpers/arbitrary.js';

/**
 * Cap large enough that no record produced by
 * `arbitraryMemoryRecord()` can possibly trigger truncation — the
 * worst-case composed length is on the order of 10 000, so 1 000 000
 * leaves a three-order-of-magnitude safety margin. The containment
 * assertions below rely on this: if truncation ever fired, the
 * trailing concepts (or their suffix) could legitimately be absent
 * from the output.
 */
const LARGE_CAP = 1_000_000;

describe('Feature: local-embeddings-and-hybrid-search, Property 2: composeEmbeddingInput is deterministic and content-preserving', () => {
  it('repeated calls return the identical string and the output contains every text field (modulo truncation)', () => {
    /**
     * **Validates: Requirements 3.2**
     *
     * For any `MemoryRecord`:
     *
     *   1. `composeEmbeddingInput(record, LARGE_CAP)` called twice
     *      returns the same string (`===`).
     *   2. With the untruncating cap, the output contains
     *      `record.title`, `record.summary`, every fact in
     *      `record.facts`, and every concept in `record.concepts`
     *      as a substring.
     *   3. With the default cap, the output's `.length` does not
     *      exceed `DEFAULT_MAX_INPUT_CHARS`.
     */
    fc.assert(
      fc.property(arbitraryMemoryRecord(), (record) => {
        // (1) Determinism. Two sequential calls with identical
        // arguments must return the identical string. `===` on
        // strings is value-equality in JavaScript, which is what
        // the property requires.
        const first = composeEmbeddingInput(record, LARGE_CAP);
        const second = composeEmbeddingInput(record, LARGE_CAP);
        expect(first).toBe(second);

        // (2) Content preservation under a cap that cannot truncate.
        // Every text-field element must appear as a substring of
        // the composed output. `facts` and `concepts` may be empty
        // arrays — in that case the `for` loops are no-ops and the
        // property holds vacuously.
        expect(first.includes(record.title)).toBe(true);
        expect(first.includes(record.summary)).toBe(true);
        for (const fact of record.facts) {
          expect(first.includes(fact)).toBe(true);
        }
        for (const concept of record.concepts) {
          expect(first.includes(concept)).toBe(true);
        }

        // (3) Default-cap length bound. An independent call with
        // the production default cap must produce a string whose
        // `.length` does not exceed `DEFAULT_MAX_INPUT_CHARS`.
        // Running on a separate call keeps the containment checks
        // above decoupled from any truncation suffix the default
        // cap may remove.
        const defaultCapped = composeEmbeddingInput(record);
        expect(defaultCapped.length).toBeLessThanOrEqual(
          DEFAULT_MAX_INPUT_CHARS,
        );
      }),
      { numRuns: 200 },
    );
  });
});
