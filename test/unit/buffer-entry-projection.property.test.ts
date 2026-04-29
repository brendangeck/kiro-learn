/**
 * Property-based test for BufferEntry projection correctness.
 *
 * Feature: workspace-buffer-pipeline, Property 4: BufferEntry projection correctness
 *
 * For any valid scrubbed KiroMemEvent, projecting it to a BufferEntry preserves
 * `event_id`, `namespace`, `kind`, `body`, `valid_time` → `timestamp`,
 * `source.surface` → `surface`, and omits `schema_version`, `content_hash`,
 * `parent_event_id`, `session_id`, and the full `source` block.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Property 4
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 2.1, 2.2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toBufferEntry } from '../../src/collector/buffer/types.js';
import { arbitraryCleanEvent } from '../helpers/arbitrary.js';

describe('BufferEntry projection correctness (Property 4)', () => {
  it('preserves required fields and omits excluded fields', () => {
    /**
     * **Validates: Requirements 2.1, 2.2**
     *
     * For any valid scrubbed KiroMemEvent, projecting to BufferEntry:
     * - preserves event_id, namespace, kind, body, valid_time → timestamp, source.surface → surface
     * - omits schema_version, content_hash, parent_event_id, session_id, full source block
     */
    fc.assert(
      fc.property(arbitraryCleanEvent(), (event) => {
        const entry = toBufferEntry(event);

        // Preserved fields
        expect(entry.event_id).toBe(event.event_id);
        expect(entry.namespace).toBe(event.namespace);
        expect(entry.kind).toBe(event.kind);
        expect(entry.body).toEqual(event.body);
        expect(entry.timestamp).toBe(event.valid_time);
        expect(entry.surface).toBe(event.source.surface);

        // Omitted fields — entry must not have these as own properties
        expect(Object.prototype.hasOwnProperty.call(entry, 'schema_version')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(entry, 'content_hash')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(entry, 'parent_event_id')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(entry, 'session_id')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(entry, 'source')).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
