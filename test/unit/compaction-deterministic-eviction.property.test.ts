/**
 * Property-based test for deterministic eviction correctness.
 *
 * Feature: buffer-compaction-worker, Property 3: Deterministic eviction correctness
 *
 * For any non-empty array of BufferEntry objects, `deterministicEviction(entries)`
 * returns exactly `Math.ceil(entries.length / 2)` entries, all from the input
 * with the most recent timestamps. No entries are fabricated or duplicated.
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Property 3
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirements 4.2, 4.3
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { deterministicEviction } from '../../src/collector/buffer/compaction.js';
import { bufferEntryArb } from '../helpers/arbitrary.js';

describe('deterministicEviction correctness (Property 3)', () => {
  it('returns exactly Math.ceil(entries.length / 2) entries', () => {
    /**
     * **Validates: Requirements 4.2, 4.3**
     *
     * For any non-empty array of BufferEntry objects, the result length
     * is exactly Math.ceil(entries.length / 2).
     */
    fc.assert(
      fc.property(
        fc.array(bufferEntryArb(), { minLength: 1, maxLength: 50 }),
        (entries) => {
          const result = deterministicEviction(entries);
          expect(result).toHaveLength(Math.ceil(entries.length / 2));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('all returned entries are from the input (no fabrication)', () => {
    /**
     * **Validates: Requirements 4.2, 4.3**
     *
     * Every entry in the result must be a reference-identical object
     * from the input array. No entries are fabricated.
     */
    fc.assert(
      fc.property(
        fc.array(bufferEntryArb(), { minLength: 1, maxLength: 50 }),
        (entries) => {
          const result = deterministicEviction(entries);
          for (const entry of result) {
            expect(entries).toContain(entry);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returned entries have the most recent timestamps', () => {
    /**
     * **Validates: Requirements 4.2, 4.3**
     *
     * The returned entries should have timestamps that are all >= the
     * timestamps of the dropped entries. Sort all input timestamps
     * descending and verify the result timestamps match the top half.
     */
    fc.assert(
      fc.property(
        fc.array(bufferEntryArb(), { minLength: 1, maxLength: 50 }),
        (entries) => {
          const result = deterministicEviction(entries);
          const keepCount = Math.ceil(entries.length / 2);

          // Sort all input timestamps descending
          const sortedTimestamps = [...entries]
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .map((e) => e.timestamp);

          // The result timestamps, sorted descending, should match the
          // top keepCount timestamps from the sorted input
          const resultTimestamps = [...result]
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .map((e) => e.timestamp);

          const expectedTimestamps = sortedTimestamps.slice(0, keepCount);

          expect(resultTimestamps).toEqual(expectedTimestamps);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('no duplicates in the result', () => {
    /**
     * **Validates: Requirements 4.2, 4.3**
     *
     * The result must not contain duplicate references. Each entry
     * object appears at most once (by reference identity).
     */
    fc.assert(
      fc.property(
        fc.array(bufferEntryArb(), { minLength: 1, maxLength: 50 }),
        (entries) => {
          const result = deterministicEviction(entries);
          const seen = new Set<object>();
          for (const entry of result) {
            expect(seen.has(entry)).toBe(false);
            seen.add(entry);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('input array is not mutated', () => {
    /**
     * **Validates: Requirements 4.2, 4.3**
     *
     * The original input array must remain unchanged after calling
     * deterministicEviction. Both the array length and the order of
     * entries must be preserved.
     */
    fc.assert(
      fc.property(
        fc.array(bufferEntryArb(), { minLength: 1, maxLength: 50 }),
        (entries) => {
          // Deep-copy the entry references and their order
          const originalEntries = [...entries];
          const originalLength = entries.length;

          deterministicEviction(entries);

          expect(entries).toHaveLength(originalLength);
          for (let i = 0; i < originalLength; i++) {
            expect(entries[i]).toBe(originalEntries[i]);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
