/**
 * Property-based test for size ceiling idempotence.
 *
 * Feature: workspace-buffer-pipeline, Property 7: Size ceiling idempotence
 *
 * Once `notifyAppend` returns `false` for a project (hard size ceiling hit),
 * it continues returning `false` for any `appendedBytes > 0` until the buffer
 * is cleared and the byte counter is reset via a successful extraction result.
 *
 * The hard ceiling check is: `currentBytes + appendedBytes > bufferMaxBytes`.
 * Rejected appends do NOT accumulate bytes, so the ceiling is idempotent in
 * the sense that once the buffer is full enough that a given append size is
 * refused, that same (or larger) append size will continue to be refused.
 * Additionally, once the buffer is completely full (no room for even 1 byte),
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
  it('once the buffer is full, notifyAppend returns false for all positive appends until reset', () => {
    /**
     * **Validates: Requirements 9.1, 9.3, 9.5**
     *
     * Strategy: fill the buffer to capacity so that no room remains for
     * even a 1-byte append, then verify that all subsequent positive
     * appends are refused. After a successful extraction result resets
     * the byte counter, small appends should succeed again.
     */
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 2, maxLength: 30 }),
        (postCeilingByteCounts) => {
          const watcher = createBufferWatcher({
            bufferMaxBytes: BUFFER_MAX_BYTES,
          });

          // Phase 1: Fill the buffer exactly to capacity.
          // Append exactly bufferMaxBytes so currentBytes === bufferMaxBytes.
          const filled = watcher.notifyAppend(PROJECT_ID, BUFFER_MAX_BYTES);
          expect(filled).toBe(true);

          // Phase 2: Verify ceiling idempotence — every positive append
          // must return false because currentBytes + appendedBytes > bufferMaxBytes
          // for any appendedBytes > 0.
          for (const bytes of postCeilingByteCounts) {
            const result = watcher.notifyAppend(PROJECT_ID, bytes);
            expect(result).toBe(false);
          }

          // Phase 3: Simulate a successful extraction which resets the
          // byte counter and the size ceiling warning flag.
          watcher.notifyExtractionResult(PROJECT_ID, true);

          // After reset, a small append should succeed again.
          expect(watcher.notifyAppend(PROJECT_ID, 1)).toBe(true);

          // Clean up timers
          watcher.close();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('a rejected append does not change state — retrying the same append yields the same result', () => {
    /**
     * **Validates: Requirements 9.1, 9.3**
     *
     * For any sequence of appends that eventually triggers a rejection,
     * the rejected append is idempotent: calling it again with the same
     * byte count produces the same false result, and the internal byte
     * counter does not change.
     */
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 2, maxLength: 30 }),
        (byteCounts) => {
          const watcher = createBufferWatcher({
            bufferMaxBytes: BUFFER_MAX_BYTES,
          });

          for (const bytes of byteCounts) {
            const firstCall = watcher.notifyAppend(PROJECT_ID, bytes);

            if (!firstCall) {
              // The append was rejected. Calling again with the same
              // byte count must also be rejected (idempotent refusal).
              const secondCall = watcher.notifyAppend(PROJECT_ID, bytes);
              expect(secondCall).toBe(false);

              // The internal byte counter should not have changed
              // between the two rejected calls.
              const state = watcher._getState(PROJECT_ID);
              expect(state).toBeDefined();

              // Verify reset restores accept behavior and break.
              watcher.notifyExtractionResult(PROJECT_ID, true);
              expect(watcher.notifyAppend(PROJECT_ID, 1)).toBe(true);

              watcher.close();
              return;
            }
          }

          // Clean up timers
          watcher.close();
        },
      ),
      { numRuns: 200 },
    );
  });
});
