/**
 * Property-based test for size threshold extraction trigger.
 *
 * Feature: workspace-buffer-pipeline, Property 10: Size threshold extraction trigger
 *
 * For any sequence of `notifyAppend` calls whose cumulative byte counts cross
 * the extraction size threshold, the BufferWatcher fires an extraction trigger
 * at or after the threshold-crossing call.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Property 10
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 6.1, 6.2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createBufferWatcher } from '../../src/collector/buffer/watcher.js';

const PROJECT_ID = 'test-project-size-trigger';
const EXTRACTION_SIZE_THRESHOLD = 100;
const BUFFER_MAX_BYTES = 10_000;

describe('Size threshold extraction trigger (Property 10)', () => {
  it('fires extraction when cumulative bytes cross the threshold', () => {
    /**
     * **Validates: Requirements 6.1, 6.2**
     *
     * For any sequence of positive byte counts, track cumulative bytes.
     * If cumulative bytes >= extractionSizeThreshold, the extraction
     * handler must have been called. If cumulative bytes < threshold,
     * the handler must NOT have been called (only idle timer would
     * trigger extraction, which we disable with a very large idleMs).
     */
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50 }), {
          minLength: 1,
          maxLength: 30,
        }),
        (byteCounts) => {
          const watcher = createBufferWatcher({
            extractionSizeThreshold: EXTRACTION_SIZE_THRESHOLD,
            bufferMaxBytes: BUFFER_MAX_BYTES,
            idleMs: 999_999,
          });

          let extractionFired = false;
          watcher.onExtraction(() => {
            extractionFired = true;
          });

          let cumulativeBytes = 0;

          for (const bytes of byteCounts) {
            watcher.notifyAppend(PROJECT_ID, bytes);
            cumulativeBytes += bytes;
          }

          if (cumulativeBytes >= EXTRACTION_SIZE_THRESHOLD) {
            // Requirement 6.1: extraction must fire when threshold is crossed
            expect(extractionFired).toBe(true);
          } else {
            // Below threshold — only idle timer would fire, which we
            // disabled with a very large idleMs, so no extraction yet
            expect(extractionFired).toBe(false);
          }

          watcher.close();
        },
      ),
      { numRuns: 200 },
    );
  });

  it('fires extraction at the threshold-crossing call, not before', () => {
    /**
     * **Validates: Requirements 6.1, 6.2**
     *
     * For any sequence of positive byte counts, the extraction handler
     * must not fire before the cumulative bytes reach the threshold.
     * We track the exact call at which extraction fires and verify it
     * coincides with the first call where cumulative bytes >= threshold.
     */
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 50 }), {
          minLength: 1,
          maxLength: 30,
        }),
        (byteCounts) => {
          const watcher = createBufferWatcher({
            extractionSizeThreshold: EXTRACTION_SIZE_THRESHOLD,
            bufferMaxBytes: BUFFER_MAX_BYTES,
            idleMs: 999_999,
          });

          let extractionFiredAtCall = -1;
          watcher.onExtraction(() => {
            if (extractionFiredAtCall === -1) {
              extractionFiredAtCall = callIndex;
            }
          });

          let cumulativeBytes = 0;
          let callIndex = 0;
          let thresholdCrossingCall = -1;

          for (const bytes of byteCounts) {
            watcher.notifyAppend(PROJECT_ID, bytes);
            cumulativeBytes += bytes;

            if (
              cumulativeBytes >= EXTRACTION_SIZE_THRESHOLD &&
              thresholdCrossingCall === -1
            ) {
              thresholdCrossingCall = callIndex;
            }

            callIndex++;
          }

          if (thresholdCrossingCall !== -1) {
            // Extraction must have fired exactly at the threshold-crossing call
            expect(extractionFiredAtCall).toBe(thresholdCrossingCall);
          } else {
            // Never crossed threshold — extraction should not have fired
            expect(extractionFiredAtCall).toBe(-1);
          }

          watcher.close();
        },
      ),
      { numRuns: 200 },
    );
  });
});
