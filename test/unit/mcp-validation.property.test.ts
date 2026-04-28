// Feature: mcp-memory-server, Property 3: Invalid observation types are rejected
// Feature: mcp-memory-server, Property 4: Over-limit fields are rejected by validation
// Feature: mcp-memory-server, Property 5: Structurally malformed tool inputs produce error results

/**
 * Property-based tests for MCP tool input validation.
 *
 * @see .kiro/specs/mcp-memory-server/design.md § Property 3, Property 4, Property 5
 * @see .kiro/specs/mcp-memory-server/requirements.md § 4.3, 4.4, 4.5, 7.3, 11.1–11.4
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  validateObservationArgs,
  validateSearchArgs,
  validateSessionSummaryArgs,
} from '../../src/mcp/tools.js';
import { OBSERVATION_TYPES } from '../../src/types/schemas.js';
import {
  arbitraryMalformedToolArgs,
  arbitraryOverLimitObservationArgs,
} from '../helpers/arbitrary.js';

/** Set of valid observation type strings for fast lookup. */
const VALID_TYPES = new Set<string>(OBSERVATION_TYPES);

describe('MCP validation — property tests', () => {
  it('Property 3: invalid observation types are rejected', () => {
    /**
     * **Validates: Requirements 4.3**
     *
     * For any string NOT in OBSERVATION_TYPES, `validateObservationArgs`
     * returns a validation error.
     */
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 200 })
          .filter((s) => !VALID_TYPES.has(s)),
        (invalidType) => {
          const args: Record<string, unknown> = {
            title: 'valid title',
            summary: 'valid summary',
            observation_type: invalidType,
            concepts: [],
            files_touched: [],
            facts: [],
          };

          const result = validateObservationArgs(args);
          expect('error' in result).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 4: over-limit fields are rejected by validation', () => {
    /**
     * **Validates: Requirements 4.4, 4.5, 11.1, 11.2, 11.3, 11.4**
     *
     * For any input with a size-constrained field exceeding its limit,
     * the validation function returns an error.
     */
    fc.assert(
      fc.property(arbitraryOverLimitObservationArgs(), (args) => {
        const result = validateObservationArgs(args as Record<string, unknown>);
        expect('error' in result).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('Property 5: structurally malformed tool inputs produce error results', () => {
    /**
     * **Validates: Requirements 7.3**
     *
     * For any malformed args, `validateSearchArgs`,
     * `validateObservationArgs`, or `validateSessionSummaryArgs` returns
     * a validation error.
     */
    fc.assert(
      fc.property(arbitraryMalformedToolArgs(), (args) => {
        // At least one of the three validators should reject the input.
        const searchResult = validateSearchArgs(args);
        const obsResult = validateObservationArgs(args);
        const sessionResult = validateSessionSummaryArgs(args);

        const anyError =
          'error' in searchResult ||
          'error' in obsResult ||
          'error' in sessionResult;

        expect(anyError).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
