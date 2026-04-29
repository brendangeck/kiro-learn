/**
 * Property-based test for size ceiling idempotence.
 *
 * Feature: workspace-buffer-pipeline, Property 7: Size ceiling idempotence
 *
 * Once `wouldExceedCeiling` returns `true` for a project (hard size ceiling
 * hit), it continues returning `true` for any `bytes > 0` until the buffer
 * is cleared and the byte counter is reset via a successful extraction result.
 *
 * The hard ceiling check is: `currentBytes + bytes > bufferMaxBytes`.
 * Rejected appends do NOT accumulate bytes (the pipeline skips the write),
 * so the ceiling is idempotent: once the buffer is full enough that a given
 * append size is refused, that same (or larger) size will continue to be
 * refused. Once the buffer is completely full (no room for even 1 byte),
 * ALL positive appends are refused until reset.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Property 7
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 9.1, 9.3, 9.5
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createBufferWatcher } from '../../src/collector/buffer/watcher.js';

const PROJECT_ID = 'test-project-size-ceiling';
const BUFFER_MAX_BYTES = 100;

describe('Size ceiling idempotence (Property 7)', () => {
  it('once the buffer is full, wouldExceedCeiling returns true for all positive appends until reset', () => {
    /**
     * **Validates: Requirements 9.1, 9.3, 9.5**
     *
     * Strategy: fill the buffer to capacity via notifyAppend so
     * currentBytes === bufferMaxBytes, then verify that wouldExceedCeiling
     * returns true for all subsequent positive byte counts. After a
     * successful extraction result resets the byte counter, small appends
     * should pass the ceiling check again.
     */
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 2, maxLength: 30 }),
        (postCeilingByteCounts) => {
          const watcher = createBufferWatcher({
            bufferMaxBytes: BUFFER_MAX_BYTES,
          });

          // Phase 1: Fill the buffer exactly to capacity.
          watcher.notifyAppend(PROJECT_ID, BUFFER_MAX_BYTES);

          // Phase 2: Verify ceiling idempotence — every positive byte count
          // must be rejected because currentBytes + bytes > bufferMaxBytes.
          for (const bytes of postCeilingByteCounts) {
            const exceeds = watcher.wouldExceedCeiling(PROJECT_ID, bytes);
            expect(exceeds).toBe(true);
          }

          // Phase 3: Simulate a successful extraction which resets the
          // byte counter and the size ceiling warning flag.
          watcher.notifyExtractionResult(PROJECT_ID, true);

          // After reset, a small append should pass the ceiling check.
          expect(watcher.wouldExceedCeiling(PROJECT_ID, 1)).toBe(false);

          // Clean up timers
          watcher.close();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a rejected ceiling check does not change state — retrying yields the same result', () => {
    /**
     * **Validates: Requirements 9.1, 9.3**
     *
     * wouldExceedCeiling is read-only: calling it multiple times with
     * the same byte count produces the same result, and the internal
     * byte counter does not change.
     */
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 2, maxLength: 30 }),
        (byteCounts) => {
          const watcher = createBufferWatcher({
            bufferMaxBytes: BUFFER_MAX_BYTES,
          });

          // Fill to capacity
          watcher.notifyAppend(PROJECT_ID, BUFFER_MAX_BYTES);

          for (const bytes of byteCounts) {
            const firstCall = watcher.wouldExceedCeiling(PROJECT_ID, bytes);
            const secondCall = watcher.wouldExceedCeiling(PROJECT_ID, bytes);
            expect(firstCall).toBe(secondCall);
            expect(firstCall).toBe(true);
          }

          // Verify reset restores accept behavior.
          watcher.notifyExtractionResult(PROJECT_ID, true);
          expect(watcher.wouldExceedCeiling(PROJECT_ID, 1)).toBe(false);

          // Clean up timers
          watcher.close();
        },
      ),
      { numRuns: 200 },
    );
  });
});
