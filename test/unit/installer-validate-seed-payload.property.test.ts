/**
 * Property-based test: `validateSeedPayload` contract.
 *
 * Feature: default-equivalent-agent, Property 1: validateSeedPayload contract
 *
 * For arbitrary JSON-stringifiable values, `validateSeedPayload(raw)` returns a
 * non-null `Record<string, unknown>` iff `JSON.parse(raw)` is a non-null,
 * non-array object with at least one own key, and — when non-null — the return
 * deep-equals `JSON.parse(raw)`. For arbitrary strings where `JSON.parse` would
 * throw, the return is always `null`. The function never throws.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 *
 * @see .kiro/specs/default-equivalent-agent/design.md § Key Functions — validateSeedPayload
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validateSeedPayload } from '../../src/installer/index.js';

/**
 * True iff `value` is the kind of thing `validateSeedPayload` should accept:
 * a non-null, non-array object with at least one own enumerable key.
 *
 * Mirrors the post-parse shape check in the function under test so the property
 * is anchored to the observed parsed value, which is what the function itself
 * inspects.
 */
function isUsableObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as object).length > 0
  );
}

describe('Installer — property: validateSeedPayload contract (P1)', () => {
  it('return is non-null iff JSON.parse(raw) is a non-null non-array object with ≥1 key, and deep-equals it', () => {
    /**
     * **Validates: Requirements 3.1, 3.3, 3.4, 3.5**
     *
     * Generate arbitrary values, serialize them, feed the serialization into
     * `validateSeedPayload`, and compare against `JSON.parse(raw)` as the
     * reference interpretation of the input.
     */
    fc.assert(
      fc.property(fc.anything(), (value) => {
        let raw: string;
        try {
          const serialized = JSON.stringify(value);
          // `JSON.stringify` returns `undefined` for bare `undefined`, symbols,
          // and functions. Those inputs can't reach `validateSeedPayload` as a
          // string at all, so skip them — they're outside the input space.
          if (serialized === undefined) return;
          raw = serialized;
        } catch {
          // `fc.anything()` can produce BigInts or other values that throw on
          // `JSON.stringify`. Those are outside the input space too.
          return;
        }

        // Compute the reference interpretation of `raw`. `raw` came from
        // `JSON.stringify`, so `JSON.parse` on it will not throw.
        const reference = JSON.parse(raw) as unknown;

        const result = validateSeedPayload(raw);

        if (isUsableObject(reference)) {
          expect(result).not.toBeNull();
          expect(result).toEqual(reference);
        } else {
          expect(result).toBeNull();
        }
      }),
      { numRuns: 200 },
    );
  });

  it('returns null whenever JSON.parse(raw) would throw', () => {
    /**
     * **Validates: Requirement 3.2**
     *
     * Arbitrary strings that aren't valid JSON must produce `null` — the
     * function catches the `SyntaxError` internally and reports failure by
     * returning rather than throwing.
     */
    fc.assert(
      fc.property(fc.string(), (raw) => {
        let parseThrew = false;
        try {
          JSON.parse(raw);
        } catch {
          parseThrew = true;
        }
        if (!parseThrew) return; // only assert on the parse-throws case

        expect(validateSeedPayload(raw)).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it('never throws for any string input', () => {
    /**
     * **Validates: Requirements 3.2, 3.3** — the function is total.
     *
     * A caller must be able to treat `validateSeedPayload` as infallible, so
     * the function must report failure by returning `null` rather than by
     * throwing, for any string whatsoever.
     */
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(() => validateSeedPayload(raw)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });
});
