/**
 * Property-based test for NDJSON serialization round-trip.
 *
 * Feature: workspace-buffer-pipeline, Property 2: NDJSON serialization round-trip
 *
 * For any valid BufferEntry, serializing it to a single NDJSON line and parsing
 * that line back produces an object identical to the original entry.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Property 2
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 3.1, 3.3
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toBufferEntry } from '../../src/collector/buffer/types.js';
import { arbitraryCleanEvent } from '../helpers/arbitrary.js';

describe('NDJSON serialization round-trip (Property 2)', () => {
  it('serializing a BufferEntry to JSON and parsing back yields an identical object', () => {
    /**
     * **Validates: Requirements 3.1, 3.3**
     *
     * For any valid BufferEntry, `JSON.parse(JSON.stringify(entry))`
     * deep-equals the original entry. This tests the NDJSON serialization
     * format without touching the filesystem.
     */
    fc.assert(
      fc.property(arbitraryCleanEvent().map(toBufferEntry), (entry) => {
        const serialized = JSON.stringify(entry);
        const deserialized: unknown = JSON.parse(serialized);

        expect(deserialized).toEqual(entry);
      }),
      { numRuns: 200 },
    );
  });
});
