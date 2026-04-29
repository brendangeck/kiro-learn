/**
 * Unit tests for BufferWatcher (idle timer, size threshold, circuit breaker,
 * hard size ceiling).
 *
 * Uses fake timers to control idle timer behavior deterministically.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Component 2: BufferWatcher
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 5.1, 5.2, 7.1, 7.2, 9.2, 9.3
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBufferWatcher } from '../../src/collector/buffer/watcher.js';

const PROJECT_ID = 'test-project-watcher';

let watcher: ReturnType<typeof createBufferWatcher>;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  watcher?.close();
  vi.useRealTimers();
});

describe('BufferWatcher', () => {
  describe('idle timer fires extraction after configured idle period', () => {
    it('fires extraction handler after idleMs elapses with no further activity', () => {
      /** Validates: Requirements 5.1, 5.2 */
      const handler = vi.fn();
      watcher = createBufferWatcher({ idleMs: 1000 });
      watcher.onExtraction(handler);

      watcher.notifyAppend(PROJECT_ID, 10);

      // Not yet — only 999ms elapsed
      vi.advanceTimersByTime(999);
      expect(handler).not.toHaveBeenCalled();

      // Now the full 1000ms has elapsed
      vi.advanceTimersByTime(1);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(PROJECT_ID);
    });
  });

  describe('idle timer resets on each notifyAppend', () => {
    it('does not fire extraction before idleMs from the last notifyAppend', () => {
      /** Validates: Requirements 5.1, 5.2 */
      const handler = vi.fn();
      watcher = createBufferWatcher({ idleMs: 1000 });
      watcher.onExtraction(handler);

      watcher.notifyAppend(PROJECT_ID, 10);

      // Advance 500ms, then call notifyAppend again — resets the timer
      vi.advanceTimersByTime(500);
      watcher.notifyAppend(PROJECT_ID, 10);

      // Advance another 500ms (1000ms total from first call, but only 500ms from second)
      vi.advanceTimersByTime(500);
      expect(handler).not.toHaveBeenCalled();

      // Advance the remaining 500ms from the second notifyAppend
      vi.advanceTimersByTime(500);
      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(PROJECT_ID);
    });
  });

  describe('extraction deduplication', () => {
    it('does not re-trigger extraction while one is already in-flight', () => {
      /** Validates: Requirements 7.1, 7.2 */
      const handler = vi.fn();
      watcher = createBufferWatcher({
        extractionSizeThreshold: 50,
        bufferMaxBytes: 10_000,
      });
      watcher.onExtraction(handler);

      // First append crosses the size threshold → triggers extraction
      watcher.notifyAppend(PROJECT_ID, 60);
      expect(handler).toHaveBeenCalledOnce();

      // Second append also crosses threshold, but extraction is in-flight
      // so handler should NOT be called again
      watcher.notifyAppend(PROJECT_ID, 60);
      expect(handler).toHaveBeenCalledOnce();

      // Complete the in-flight extraction
      watcher.notifyExtractionResult(PROJECT_ID, true);

      // Now a new append crossing threshold should trigger again
      watcher.notifyAppend(PROJECT_ID, 60);
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('close() clears all timers', () => {
    it('prevents idle timer from firing after close', () => {
      /** Validates: Requirement 5.1 (timer cleanup) */
      const handler = vi.fn();
      watcher = createBufferWatcher({ idleMs: 1000 });
      watcher.onExtraction(handler);

      watcher.notifyAppend(PROJECT_ID, 10);

      // Close the watcher before the timer fires
      watcher.close();

      // Advance past the idle period — handler should NOT fire
      vi.advanceTimersByTime(2000);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('hard size ceiling warning logged only once per project', () => {
    it('logs a stderr warning on the first ceiling hit and suppresses subsequent warnings', () => {
      /** Validates: Requirements 9.2, 9.3 */
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      watcher = createBufferWatcher({ bufferMaxBytes: 100 });

      // Fill the buffer to capacity
      watcher.notifyAppend(PROJECT_ID, 100);

      // First ceiling hit — should log a warning
      const result1 = watcher.notifyAppend(PROJECT_ID, 1);
      expect(result1).toBe(false);
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('buffer size ceiling hit'),
      );
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining(PROJECT_ID),
      );

      // Subsequent ceiling hits — should NOT log additional warnings
      const result2 = watcher.notifyAppend(PROJECT_ID, 1);
      expect(result2).toBe(false);
      expect(stderrSpy).toHaveBeenCalledOnce();

      const result3 = watcher.notifyAppend(PROJECT_ID, 50);
      expect(result3).toBe(false);
      expect(stderrSpy).toHaveBeenCalledOnce();
    });
  });
});
