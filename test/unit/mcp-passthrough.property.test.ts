// Feature: mcp-memory-server, Property 8: Private tags pass through unchanged

/**
 * Property-based test for private tag passthrough.
 *
 * @see .kiro/specs/mcp-memory-server/design.md § Property 8
 * @see .kiro/specs/mcp-memory-server/requirements.md § 11.5
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validateObservationArgs } from '../../src/mcp/tools.js';

/**
 * Generate strings containing `<private>...</private>` tags.
 * The inner content and surrounding text are arbitrary strings that never
 * contain the literal `<private>` or `</private>` substrings themselves.
 */
function privateTagStringArb(): fc.Arbitrary<string> {
  const safeStr = fc
    .string({ minLength: 0, maxLength: 50 })
    .map((s) => s.replace(/<\/?private>/g, ''));

  return fc.oneof(
    // Simple: before<private>secret</private>after
    fc
      .tuple(safeStr, safeStr, safeStr)
      .map(([before, secret, after]) => `${before}<private>${secret}</private>${after}`),
    // Nested: before<private>outer<private>inner</private>outer</private>after
    fc
      .tuple(safeStr, safeStr, safeStr, safeStr)
      .map(
        ([before, outer, inner, after]) =>
          `${before}<private>${outer}<private>${inner}</private>${outer}</private>${after}`,
      ),
    // Unclosed: before<private>secret
    fc
      .tuple(safeStr, safeStr)
      .map(([before, secret]) => `${before}<private>${secret}`),
  );
}

describe('Private tag passthrough — property tests', () => {
  it('Property 8: strings with <private> tags pass through validation unchanged', () => {
    /**
     * **Validates: Requirements 11.5**
     *
     * For any string with `<private>` tags passed as a tool argument,
     * validation preserves the string byte-for-byte.
     */
    fc.assert(
      fc.property(privateTagStringArb(), (taggedString) => {
        // Use the tagged string in title and summary fields
        // Title is capped at 200 chars, so truncate for valid input
        const title = taggedString.slice(0, 200) || 'x';
        const summary = taggedString.slice(0, 4000) || 'x';

        const args: Record<string, unknown> = {
          title,
          summary,
          observation_type: 'discovery',
          concepts: [taggedString.slice(0, 100) || 'x'],
          files_touched: [taggedString.slice(0, 500) || 'x'],
          facts: [taggedString.slice(0, 200) || 'x'],
        };

        const result = validateObservationArgs(args);

        // If validation passes, check fields are preserved byte-for-byte
        if (!('error' in result)) {
          expect(result.title).toBe(title);
          expect(result.summary).toBe(summary);
          expect(result.concepts[0]).toBe(taggedString.slice(0, 100) || 'x');
          expect(result.files_touched[0]).toBe(taggedString.slice(0, 500) || 'x');
          expect(result.facts[0]).toBe(taggedString.slice(0, 200) || 'x');
        }
      }),
      { numRuns: 100 },
    );
  });
});
