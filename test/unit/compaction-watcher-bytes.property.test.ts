/**
 * Property-based test for watcher byte counter consistency after compaction.
 *
 * Feature: buffer-compaction-worker, Property 10: Watcher byte counter consistency
 *
 * For any successful compaction, the BufferWatcher updates the project's
 * `currentBytes` to reflect the new buffer size. Subsequent threshold checks
 * use accurate data.
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Property 10
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirement 9.1
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBufferWatcher } from '../../src/collector/buffer/watcher.js';

/** Use a large idleMs to prevent idle-triggered extraction from interfering. */
const IDLE_MS = 999_999;

describe('Watcher byte counter consistency after compaction (Property 10)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('currentBytes equals newSizeBytes after successful compaction', () => {
    /**
     * **Validates: Requirement 9.1**
     *
     * For any initial append amount and any newSizeBytes value provided
     * to notifyCompactionResult with success=true, the watcher's
     * currentBytes for that project equals newSizeBytes.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        (appendedBytes, newSizeBytes) => {
          const watcher = createBufferWatcher({
            extractionSizeThreshold: 100_000,
            compactionSizeThreshold: 100_000,
            bufferMaxBytes: 10_000_000,
            idleMs: IDLE_MS,
          });

          watcher.onExtraction(() => {});
          watcher.onCompaction(() => {});

          watcher.notifyAppend('proj', appendedBytes);

          const stateBefore = watcher._getState('proj');
          expect(stateBefore).toBeDefined();
          expect(stateBefore!.currentBytes).toBe(appendedBytes);

          // Simulate successful compaction with a new size
          watcher.notifyCompactionResult('proj', true, newSizeBytes);

          const stateAfter = watcher._getState('proj');
          expect(stateAfter).toBeDefined();
          expect(stateAfter!.currentBytes).toBe(newSizeBytes);

          watcher.close();
        },
      ),
      { numRuns: 300 },
    );
  });

  it('subsequent threshold checks use updated byte count after compaction', () => {
    /**
     * **Validates: Requirement 9.1**
     *
     * After a successful compaction reduces currentBytes below the
     * compaction threshold, appending bytes that would have exceeded
     * the threshold relative to the OLD byte count does NOT trigger
     * compaction if the NEW cumulative total (newSizeBytes + append)
     * is still below the threshold.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 500, max: 2000 }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 300 }),
        (compactionThreshold, newSizeBytes, subsequentAppend) => {
          // Ensure newSizeBytes is well below the compaction threshold
          fc.pre(newSizeBytes < compactionThreshold);
          // Ensure the subsequent append alone doesn't cross the threshold
          fc.pre(newSizeBytes + subsequentAppend <= compactionThreshold);

          const watcher = createBufferWatcher({
            extractionSizeThreshold: 100_000,
            compactionSizeThreshold: compactionThreshold,
            bufferMaxBytes: 10_000_000,
            idleMs: IDLE_MS,
          });

          watcher.onExtraction(() => {});

          let compactionCount = 0;
          watcher.onCompaction(() => {
            compactionCount++;
          });

          // Append enough to cross compaction threshold initially
          watcher.notifyAppend('proj', compactionThreshold + 1);
          expect(compactionCount).toBe(1);

          // Simulate successful compaction reducing size
          watcher.notifyCompactionResult('proj', true, newSizeBytes);

          // Reset compaction count to track new triggers
          compactionCount = 0;

          // Append more bytes — should NOT trigger compaction since
          // newSizeBytes + subsequentAppend <= compactionThreshold
          watcher.notifyAppend('proj', subsequentAppend);

          expect(compactionCount).toBe(0);

          // Verify the byte counter is accurate
          const state = watcher._getState('proj');
          expect(state).toBeDefined();
          expect(state!.currentBytes).toBe(newSizeBytes + subsequentAppend);

          watcher.close();
        },
      ),
      { numRuns: 300 },
    );
  });

  it('compaction re-triggers when new appends push past threshold after compaction', () => {
    /**
     * **Validates: Requirement 9.1**
     *
     * After a successful compaction resets currentBytes to newSizeBytes,
     * if subsequent appends push the cumulative total past the compaction
     * threshold again, the compaction trigger fires again.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 2000 }),
        fc.integer({ min: 0, max: 50 }),
        (compactionThreshold, newSizeBytes) => {
          fc.pre(newSizeBytes < compactionThreshold);

          const watcher = createBufferWatcher({
            extractionSizeThreshold: 100_000,
            compactionSizeThreshold: compactionThreshold,
            bufferMaxBytes: 10_000_000,
            idleMs: IDLE_MS,
          });

          watcher.onExtraction(() => {});

          let compactionCount = 0;
          watcher.onCompaction(() => {
            compactionCount++;
          });

          // Initial append crosses threshold
          watcher.notifyAppend('proj', compactionThreshold + 1);
          expect(compactionCount).toBe(1);

          // Successful compaction reduces size
          watcher.notifyCompactionResult('proj', true, newSizeBytes);
          compactionCount = 0;

          // Append enough to cross threshold again from the new base
          const needed = compactionThreshold - newSizeBytes + 1;
          watcher.notifyAppend('proj', needed);

          expect(compactionCount).toBe(1);

          const state = watcher._getState('proj');
          expect(state).toBeDefined();
          expect(state!.currentBytes).toBe(newSizeBytes + needed);

          watcher.close();
        },
      ),
      { numRuns: 300 },
    );
  });

  it('failed compaction does not change currentBytes', () => {
    /**
     * **Validates: Requirement 9.1**
     *
     * When notifyCompactionResult is called with success=false, the
     * currentBytes remain unchanged — only successful compaction
     * updates the byte counter.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        (appendedBytes) => {
          const watcher = createBufferWatcher({
            extractionSizeThreshold: 100_000,
            compactionSizeThreshold: 100_000,
            bufferMaxBytes: 10_000_000,
            idleMs: IDLE_MS,
          });

          watcher.onExtraction(() => {});
          watcher.onCompaction(() => {});

          watcher.notifyAppend('proj', appendedBytes);

          // Failed compaction should not change currentBytes
          watcher.notifyCompactionResult('proj', false);

          const state = watcher._getState('proj');
          expect(state).toBeDefined();
          expect(state!.currentBytes).toBe(appendedBytes);

          watcher.close();
        },
      ),
      { numRuns: 300 },
    );
  });
});
