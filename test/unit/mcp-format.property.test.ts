// Feature: mcp-memory-server, Property 1: Search result formatting contains all required fields
// Feature: mcp-memory-server, Property 2: Multiple search results are separated by blank lines

/**
 * Property-based tests for `formatSearchResults`.
 *
 * @see .kiro/specs/mcp-memory-server/design.md § Property 1, Property 2
 * @see .kiro/specs/mcp-memory-server/requirements.md § 3.2, 13.1, 13.2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { MemoryRecordPayload } from '../../src/mcp/client.js';
import { formatSearchResults } from '../../src/mcp/tools.js';
import { arbitraryMemoryRecord } from '../helpers/arbitrary.js';

/**
 * Adapt the `MemoryRecord` shape from `arbitrary.ts` to the
 * `MemoryRecordPayload` shape used by `formatSearchResults`.
 */
function toPayload(
  rec: ReturnType<typeof arbitraryMemoryRecord> extends fc.Arbitrary<infer T> ? T : never,
): MemoryRecordPayload {
  return {
    record_id: rec.record_id,
    namespace: rec.namespace,
    strategy: rec.strategy,
    title: rec.title,
    summary: rec.summary,
    facts: rec.facts,
    source_event_ids: rec.source_event_ids,
    created_at: rec.created_at,
    concepts: rec.concepts,
    files_touched: rec.files_touched,
    observation_type: rec.observation_type,
  };
}

describe('formatSearchResults — property tests', () => {
  it('Property 1: output contains all required fields for every record', () => {
    /**
     * **Validates: Requirements 3.2, 13.1**
     *
     * For any non-empty array of memory records, `formatSearchResults`
     * output contains each record's title, summary, every concept, and
     * every file.
     */
    fc.assert(
      fc.property(
        fc.array(arbitraryMemoryRecord(), { minLength: 1, maxLength: 5 }),
        (records) => {
          const payloads = records.map(toPayload);
          const output = formatSearchResults(payloads);

          for (const record of payloads) {
            expect(output).toContain(record.title);
            expect(output).toContain(record.summary);

            for (const concept of record.concepts) {
              expect(output).toContain(concept);
            }

            for (const file of record.files_touched) {
              expect(output).toContain(file);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Property 2: multiple results are separated by blank lines and titles appear in order', () => {
    /**
     * **Validates: Requirements 13.2**
     *
     * For any array of 2+ records, output has N-1 blank-line separators
     * and titles appear in input order.
     */
    fc.assert(
      fc.property(
        fc.array(arbitraryMemoryRecord(), { minLength: 2, maxLength: 5 }),
        (records) => {
          const payloads = records.map(toPayload);
          const output = formatSearchResults(payloads);

          // Check blank-line separators: split on double-newline
          const blocks = output.split('\n\n');
          // With N records, there should be at least N-1 blank-line separators
          // (each block may itself contain \n\n for concepts/files sections,
          // so we check that the count is >= N-1)
          expect(blocks.length).toBeGreaterThanOrEqual(payloads.length);

          // Check titles appear in input order
          let searchFrom = 0;
          for (const record of payloads) {
            const idx = output.indexOf(`### ${record.title}`, searchFrom);
            expect(idx).toBeGreaterThanOrEqual(searchFrom);
            searchFrom = idx + 1;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
