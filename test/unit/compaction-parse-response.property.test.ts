/**
 * Property-based test for parseCompactionResponse round-trip.
 *
 * Feature: buffer-compaction-worker, Property 11: parseCompactionResponse round-trip
 *
 * For any non-empty string that does not contain `</compacted_entry>`,
 * wrapping it in `<compacted_entry>...</compacted_entry>` and passing to
 * `parseCompactionResponse` returns an array containing that string (after
 * XML entity unescaping). For concatenation of multiple wrapped blocks,
 * the parser returns all of them in order.
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Property 11
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirements 10.1, 10.2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseCompactionResponse } from '../../src/collector/buffer/compaction.js';

/**
 * Escape a string using XML entity references so that wrapping it in
 * `<compacted_entry>` tags and parsing back via `parseCompactionResponse`
 * (which unescapes XML entities) recovers the original string.
 *
 * Order mirrors the inverse of `unescapeXml` in compaction.ts:
 * `&` must be escaped **first** to avoid double-escaping.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Arbitrary non-empty string that:
 * - Does not contain `</compacted_entry>` (precondition from Property 11)
 * - Is not whitespace-only after trimming (parser skips those)
 *
 * We generate arbitrary strings and filter out the disqualified ones.
 * The filter rate is low because `</compacted_entry>` is a long substring
 * unlikely to appear in random strings.
 */
function nonEmptyContentArb(): fc.Arbitrary<string> {
  return fc
    .string({ minLength: 1, maxLength: 200 })
    .filter((s) => !s.includes('</compacted_entry>') && s.trim().length > 0);
}

describe('parseCompactionResponse round-trip (Property 11)', () => {
  it('single wrapped block round-trips through parse after XML escaping', () => {
    /**
     * **Validates: Requirements 10.1, 10.2**
     *
     * For any non-empty string (not containing `</compacted_entry>`),
     * XML-escaping it, wrapping in `<compacted_entry>` tags, and parsing
     * returns an array with exactly one element equal to the original
     * (trimmed) string.
     */
    fc.assert(
      fc.property(nonEmptyContentArb(), (content) => {
        const trimmed = content.trim();
        const escaped = escapeXml(trimmed);
        const xml = `<compacted_entry>${escaped}</compacted_entry>`;

        const result = parseCompactionResponse(xml);

        expect(result).toHaveLength(1);
        expect(result[0]).toBe(trimmed);
      }),
      { numRuns: 200 },
    );
  });

  it('multiple wrapped blocks are returned in order', () => {
    /**
     * **Validates: Requirements 10.1, 10.2**
     *
     * For any array of 1–10 non-empty strings (none containing
     * `</compacted_entry>`), XML-escaping each, wrapping in
     * `<compacted_entry>` tags, concatenating, and parsing returns all
     * strings in the original order.
     */
    fc.assert(
      fc.property(
        fc.array(nonEmptyContentArb(), { minLength: 1, maxLength: 10 }),
        (contents) => {
          const trimmedContents = contents.map((c) => c.trim());
          const xml = trimmedContents
            .map((c) => `<compacted_entry>${escapeXml(c)}</compacted_entry>`)
            .join('');

          const result = parseCompactionResponse(xml);

          expect(result).toHaveLength(trimmedContents.length);
          for (let i = 0; i < trimmedContents.length; i++) {
            expect(result[i]).toBe(trimmedContents[i]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
