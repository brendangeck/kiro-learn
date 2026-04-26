/**
 * Unit tests for `validateSeedPayload` in `src/installer/index.ts`.
 *
 * Table-driven over representative valid and invalid inputs. Asserts the
 * function returns `null` for every unusable payload, returns a deep-equal
 * parsed object for every usable one, and never throws.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5
 */

import { describe, expect, it } from 'vitest';

import { validateSeedPayload } from '../../src/installer/index.js';

interface InvalidCase {
  readonly description: string;
  readonly input: string;
}

interface ValidCase {
  readonly description: string;
  readonly input: string;
  readonly expected: Record<string, unknown>;
}

// Inputs that must cause `validateSeedPayload` to return `null`.
// Covers: JSON parse failure (Requirement 3.2), and every shape that fails
// the "non-null, non-array object with at least one own key" check
// (Requirement 3.3).
const invalidCases: readonly InvalidCase[] = [
  { description: 'empty string (invalid JSON)', input: '' },
  { description: 'garbage (invalid JSON)', input: 'not json' },
  { description: 'JSON null', input: 'null' },
  { description: 'JSON boolean true', input: 'true' },
  { description: 'JSON number', input: '42' },
  { description: 'empty array', input: '[]' },
  { description: 'non-empty array', input: '[1,2]' },
  { description: 'empty object', input: '{}' },
];

// Inputs that must cause `validateSeedPayload` to return a deep-equal
// `Record<string, unknown>` matching `JSON.parse(input)` (Requirements 3.1,
// 3.4, 3.5 — no specific field required).
const validCases: readonly ValidCase[] = [
  {
    description: 'object with a single key',
    input: '{"a":1}',
    expected: { a: 1 },
  },
  {
    description: 'object shaped like an agent seed (no prompt/tools asserted)',
    input: '{"name":"foo","tools":[]}',
    expected: { name: 'foo', tools: [] },
  },
];

describe('validateSeedPayload', () => {
  describe('invalid payloads return null', () => {
    for (const { description, input } of invalidCases) {
      it(`returns null for ${description}`, () => {
        /**
         * Validates: Requirements 3.2, 3.3
         */
        expect(validateSeedPayload(input)).toBeNull();
      });
    }
  });

  describe('valid payloads return the parsed object', () => {
    for (const { description, input, expected } of validCases) {
      it(`returns the parsed object for ${description}`, () => {
        /**
         * Validates: Requirements 3.1, 3.4, 3.5
         */
        expect(validateSeedPayload(input)).toEqual(expected);
      });
    }
  });

  describe('never throws for any input', () => {
    /**
     * Validates: Requirements 3.2, 3.3 — the function is total.
     * `validateSeedPayload` must report failure by returning `null`, never
     * by throwing, so callers can treat it as infallible.
     */
    const allInputs: readonly string[] = [
      ...invalidCases.map((c) => c.input),
      ...validCases.map((c) => c.input),
    ];

    for (const input of allInputs) {
      it(`does not throw for input: ${JSON.stringify(input)}`, () => {
        expect(() => validateSeedPayload(input)).not.toThrow();
      });
    }
  });
});
