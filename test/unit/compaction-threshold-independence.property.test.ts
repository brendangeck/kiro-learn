/**
 * Property-based test for compaction threshold independence.
 *
 * Feature: buffer-compaction-worker, Property 6: Compaction threshold independence
 *
 * For any buffer that crosses the compaction size threshold, the compaction
 * trigger fires independently of the extraction trigger. Compaction and
 * extraction operate on separate thresholds and do not block each other.
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Property 6
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirements 8.1, 8.2
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBufferWatcher } from '../../src/collector/buffer/watcher.js';

/** Use a large idleMs to prevent idle-triggered extraction from interfering. */
const IDLE_MS = 999_999;

describe('Compaction threshold independence (Property 6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('compaction trigger fires independently when compaction threshold is crossed', () => {
    /**
     * **Validates: Requirements 8.1, 8.2**
     *
     * For any extraction and compaction thresholds where compaction > extraction,
     * and any append size that crosses the compaction threshold, the compaction
     * handler fires regardless of whether extraction also fires.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 50, max: 500 }),
        fc.integer({ min: 501, max: 2000 }),
        fc.integer({ min: 1, max: 5000 }),
        (extractionThreshold, compactionThreshold, appendSize) => {
          // Ensure compaction threshold > extraction threshold
          fc.pre(compactionThreshold > extractionThreshold);

          const watcher = createBufferWatcher({
            extractionSizeThreshold: extractionThreshold,
            compactionSizeThreshold: compactionThreshold,
            bufferMaxBytes: 10_000_000,
            idleMs: IDLE_MS,
          });

          let compactionFired = false;
          let extractionFired = false;

          watcher.onExtraction(() => {
            extractionFired = true;
          });
          watcher.onCompaction(() => {
            compactionFired = true;
          });

          watcher.notifyAppend('proj', appendSize);

          if (appendSize > compactionThreshold) {
            expect(compactionFired).toBe(true);
          }

          // Compaction firing does not depend on extraction state
          if (appendSize >= extractionThreshold) {
            expect(extractionFired).toBe(true);
          }

          watcher.close();
        },
      ),
      { numRuns: 300 },
    );
  });

  it('extraction fires at its own threshold regardless of compaction state', () => {
    /**
     * **Validates: Requirements 8.1, 8.2**
     *
     * For any sequence of appends, extraction fires when cumulative bytes
     * cross the extraction threshold, independent of whether compaction
     * is in-flight or has fired.
     */
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 200 }), {
          minLength: 1,
          maxLength: 30,
        }),
        (byteCounts) => {
          const extractionThreshold = 100;
          const compactionThreshold = 500;

          const watcher = createBufferWatcher({
            extractionSizeThreshold: extractionThreshold,
            compactionSizeThreshold: compactionThreshold,
            bufferMaxBytes: 10_000_000,
            idleMs: IDLE_MS,
          });

          let extractionFired = false;
          let compactionFired = false;

          watcher.onExtraction(() => {
            extractionFired = true;
          });
          watcher.onCompaction(() => {
            compactionFired = true;
          });

          let cumulativeBytes = 0;
          for (const bytes of byteCounts) {
            watcher.notifyAppend('proj', bytes);
            cumulativeBytes += bytes;
          }

          // Extraction must fire when its threshold is crossed,
          // regardless of compaction state
          if (cumulativeBytes >= extractionThreshold) {
            expect(extractionFired).toBe(true);
          } else {
            expect(extractionFired).toBe(false);
          }

          // Compaction fires independently at its own threshold
          if (cumulativeBytes > compactionThreshold) {
            expect(compactionFired).toBe(true);
          }

          watcher.close();
        },
      ),
      { numRuns: 300 },
    );
  });

  it('both triggers can fire from the same notifyAppend call', () => {
    /**
     * **Validates: Requirements 8.1, 8.2**
     *
     * For any append size that crosses both thresholds simultaneously,
     * both the extraction and compaction handlers fire from the same
     * notifyAppend call.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 50, max: 500 }),
        fc.integer({ min: 501, max: 2000 }),
        (extractionThreshold, compactionThreshold) => {
          fc.pre(compactionThreshold > extractionThreshold);

          const watcher = createBufferWatcher({
            extractionSizeThreshold: extractionThreshold,
            compactionSizeThreshold: compactionThreshold,
            bufferMaxBytes: 10_000_000,
            idleMs: IDLE_MS,
          });

          let extractionFired = false;
          let compactionFired = false;

          watcher.onExtraction(() => {
            extractionFired = true;
          });
          watcher.onCompaction(() => {
            compactionFired = true;
          });

          // Append enough to cross both thresholds at once
          const appendSize = compactionThreshold + 1;
          watcher.notifyAppend('proj', appendSize);

          expect(extractionFired).toBe(true);
          expect(compactionFired).toBe(true);

          watcher.close();
        },
      ),
      { numRuns: 300 },
    );
  });

  it('in-flight extraction does not block compaction trigger', () => {
    /**
     * **Validates: Requirements 8.1, 8.2**
     *
     * When extraction is already in-flight (suppressing further extraction
     * triggers), compaction still fires independently at its own threshold.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 50, max: 200 }),
        fc.integer({ min: 500, max: 2000 }),
        fc.integer({ min: 1, max: 500 }),
        (extractionThreshold, compactionThreshold, extraAppend) => {
          fc.pre(compactionThreshold > extractionThreshold);

          const watcher = createBufferWatcher({
            extractionSizeThreshold: extractionThreshold,
            compactionSizeThreshold: compactionThreshold,
            bufferMaxBytes: 10_000_000,
            idleMs: IDLE_MS,
          });

          let extractionCount = 0;
          let compactionFired = false;

          watcher.onExtraction(() => {
            extractionCount++;
          });
          watcher.onCompaction(() => {
            compactionFired = true;
          });

          // First append crosses extraction threshold — extraction fires
          watcher.notifyAppend('proj', extractionThreshold);
          expect(extractionCount).toBe(1);

          // Extraction is now in-flight (not yet reported as complete).
          // Append more bytes to cross compaction threshold.
          const remaining = compactionThreshold - extractionThreshold + 1 + extraAppend;
          watcher.notifyAppend('proj', remaining);

          // Extraction should NOT fire again (in-flight dedup)
          expect(extractionCount).toBe(1);

          // But compaction MUST fire independently
          expect(compactionFired).toBe(true);

          watcher.close();
        },
      ),
      { numRuns: 300 },
    );
  });

  it('in-flight compaction does not block extraction trigger', () => {
    /**
     * **Validates: Requirements 8.1, 8.2**
     *
     * When compaction is already in-flight, extraction still fires
     * independently at its own threshold.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 50, max: 200 }),
        fc.integer({ min: 201, max: 500 }),
        (extractionThreshold, compactionThreshold) => {
          fc.pre(compactionThreshold > extractionThreshold);

          const watcher = createBufferWatcher({
            extractionSizeThreshold: extractionThreshold,
            compactionSizeThreshold: compactionThreshold,
            bufferMaxBytes: 10_000_000,
            idleMs: IDLE_MS,
          });

          let extractionFired = false;
          let compactionFired = false;

          watcher.onExtraction(() => {
            extractionFired = true;
          });
          watcher.onCompaction(() => {
            compactionFired = true;
          });

          // Single large append crosses both thresholds
          watcher.notifyAppend('proj', compactionThreshold + 1);
          expect(compactionFired).toBe(true);
          expect(extractionFired).toBe(true);

          // Now compaction is in-flight. Report extraction success to
          // reset extraction state, then append more to re-trigger extraction.
          watcher.notifyExtractionResult('proj', true);

          extractionFired = false;
          // Append enough to cross extraction threshold again
          watcher.notifyAppend('proj', extractionThreshold);

          // Extraction must fire even though compaction is still in-flight
          expect(extractionFired).toBe(true);

          watcher.close();
        },
      ),
      { numRuns: 300 },
    );
  });
});
