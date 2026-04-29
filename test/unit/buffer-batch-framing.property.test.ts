/**
 * Property-based test for batch framing integrity.
 *
 * Feature: workspace-buffer-pipeline, Property 8: Batch framing integrity
 *
 * For any non-empty list of valid BufferEntry objects, `frameBatch(entries)`
 * produces valid XML containing exactly one `<tool_observation>` block per
 * entry, with all text content XML-escaped.
 *
 * This test exercises XML framing only — it does NOT invoke ACP or spawn
 * `kiro-cli`. The `frameBatch` function is pure string transformation with
 * no process dependencies.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Property 8
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirement 10.2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { frameBatch } from '../../src/collector/pipeline/xml-framer.js';
import { toBufferEntry } from '../../src/collector/buffer/types.js';
import { arbitraryCleanEvent } from '../helpers/arbitrary.js';

describe('Batch framing integrity (Property 8)', () => {
  it('produces exactly one <tool_observation> open tag per entry', () => {
    /**
     * **Validates: Requirements 10.2**
     *
     * For any non-empty list of valid BufferEntry objects, the output of
     * `frameBatch` contains exactly `entries.length` occurrences of
     * `<tool_observation>`.
     */
    fc.assert(
      fc.property(
        fc.array(arbitraryCleanEvent().map(toBufferEntry), { minLength: 1, maxLength: 10 }),
        (entries) => {
          const output = frameBatch(entries);

          const openCount = (output.match(/<tool_observation>/g) ?? []).length;
          expect(openCount).toBe(entries.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('produces exactly one </tool_observation> close tag per entry', () => {
    /**
     * **Validates: Requirements 10.2**
     *
     * For any non-empty list of valid BufferEntry objects, the output of
     * `frameBatch` contains exactly `entries.length` occurrences of
     * `</tool_observation>`.
     */
    fc.assert(
      fc.property(
        fc.array(arbitraryCleanEvent().map(toBufferEntry), { minLength: 1, maxLength: 10 }),
        (entries) => {
          const output = frameBatch(entries);

          const closeCount = (output.match(/<\/tool_observation>/g) ?? []).length;
          expect(closeCount).toBe(entries.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});
