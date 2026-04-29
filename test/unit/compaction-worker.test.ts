/**
 * Unit tests for CompactionWorker.
 *
 * Covers the full compact flow, reentrance guard, model retry logic,
 * deterministic eviction fallback, circuit breaker, drain, active property,
 * empty buffer early return, and notifyCompactionResult calls.
 *
 * **CRITICAL: `createAcpSession` is mocked — no real `kiro-cli` processes.**
 *
 * _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 3.1, 3.2,
 * 3.3, 3.4, 3.5, 3.6, 4.1, 4.4, 5.1, 5.2, 5.3, 13.1, 13.2, 13.3_
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { BufferStore, ReplaceResult } from '../../src/collector/buffer/store.js';
import type { BufferWatcher } from '../../src/collector/buffer/watcher.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

/**
 * Deferred-style session factory. Each test sets this before calling
 * `compact()` to control model behaviour (success, failure, delay).
 */
let sessionFactory: () => Promise<{
  sendPrompt: (content: string) => Promise<string>;
  destroy: () => void;
}>;

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() => sessionFactory()),
}));

// ── Test data ───────────────────────────────────────────────────────────

const entry: BufferEntry = {
  event_id: 'EVT00000000000000000000000',
  namespace: '/actor/testuser/project/testproject/',
  kind: 'tool_use',
  body: { type: 'text', content: 'test content' },
  timestamp: '2024-01-01T00:00:00Z',
  surface: 'kiro-cli',
};

const entry2: BufferEntry = {
  event_id: 'EVT00000000000000000000001',
  namespace: '/actor/testuser/project/testproject/',
  kind: 'tool_use',
  body: { type: 'text', content: 'second content' },
  timestamp: '2024-01-02T00:00:00Z',
  surface: 'kiro-cli',
};

// ── Fake dependencies ───────────────────────────────────────────────────

function createFakeBufferStore(entries: BufferEntry[]): BufferStore {
  const serialized = entries.map((e) => JSON.stringify(e) + '\n').join('');
  const sizeBytes = Buffer.byteLength(serialized, 'utf-8');

  return {
    append: vi.fn().mockResolvedValue(0),
    snapshot: vi.fn().mockResolvedValue(entries),
    size: vi.fn().mockResolvedValue(sizeBytes),
    bufferPath: vi.fn().mockReturnValue('/fake/buffer.ndjson'),
    listProjects: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    sizeSync: vi.fn().mockReturnValue(sizeBytes),
    replace: vi.fn().mockResolvedValue({
      catchUpEntries: [],
      newSizeBytes: 100,
    } satisfies ReplaceResult),
  };
}

function createFakeWatcher(): BufferWatcher {
  return {
    notifyAppend: vi.fn().mockReturnValue(true),
    wouldExceedCeiling: vi.fn().mockReturnValue(false),
    notifyExtractionResult: vi.fn(),
    onExtraction: vi.fn(),
    onCompaction: vi.fn(),
    notifyCompactionResult: vi.fn(),
    close: vi.fn(),
    _getState: vi.fn().mockReturnValue(undefined),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildModelResponse(summaries: string[]): string {
  return summaries
    .map((s) => `<compacted_entry>${s}</compacted_entry>`)
    .join('\n');
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('CompactionWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Full compact flow ───────────────────────────────────────────────

  describe('full compact flow', () => {
    /**
     * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 3.1, 3.2, 3.4
     */
    it('snapshot → model call → replace → result', async () => {
      sessionFactory = () =>
        Promise.resolve({
          sendPrompt: vi.fn(() =>
            Promise.resolve(buildModelResponse(['summary A', 'summary B'])),
          ),
          destroy: vi.fn(),
        });

      const store = createFakeBufferStore([entry, entry2]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: { enabled: true },
      });

      const result = await worker.compact('test-project');

      // Snapshot was read
      expect(store.snapshot).toHaveBeenCalledWith('test-project');

      // sizeSync was called to record S0
      expect(store.sizeSync).toHaveBeenCalledWith('test-project');

      // replace was called with compacted entries and the byte offset
      expect(store.replace).toHaveBeenCalledTimes(1);
      const replaceCall = vi.mocked(store.replace).mock.calls[0]!;
      expect(replaceCall[0]).toBe('test-project');
      // Two compacted entries from the model response
      const compactedEntries = replaceCall[1] as BufferEntry[];
      expect(compactedEntries).toHaveLength(2);
      expect(compactedEntries[0]!.body).toEqual({ type: 'text', content: 'summary A' });
      expect(compactedEntries[1]!.body).toEqual({ type: 'text', content: 'summary B' });

      // Result metrics
      expect(result.projectId).toBe('test-project');
      expect(result.entriesBefore).toBe(2);
      expect(result.usedFallback).toBe(false);
      expect(result.modelDurationMs).toBeGreaterThanOrEqual(0);
      expect(result.replaceDurationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Reentrance guard ────────────────────────────────────────────────

  describe('reentrance guard', () => {
    /**
     * Validates: Requirements 2.1, 2.2
     */
    it('rejects concurrent calls', async () => {
      let resolveModel!: (value: string) => void;
      const modelPromise = new Promise<string>((resolve) => {
        resolveModel = resolve;
      });

      sessionFactory = () =>
        Promise.resolve({
          sendPrompt: vi.fn(() => modelPromise),
          destroy: vi.fn(),
        });

      const store = createFakeBufferStore([entry]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: { enabled: true },
      });

      // Start first compaction (will block on model)
      const first = worker.compact('test-project');

      // Second call should be rejected immediately
      await expect(worker.compact('test-project')).rejects.toThrow(
        'already in-flight',
      );

      // Resolve the model call so first compaction completes
      resolveModel(buildModelResponse(['summary']));
      await first;
    });

    /**
     * Validates: Requirements 2.1, 2.2
     */
    it('releases guard on error so subsequent calls succeed', async () => {
      let callCount = 0;

      sessionFactory = () => {
        callCount++;
        if (callCount <= 2) {
          // First compact() call: all retries fail (default maxModelRetries=2)
          return Promise.resolve({
            sendPrompt: vi.fn(() =>
              Promise.reject(new Error('model exploded')),
            ),
            destroy: vi.fn(),
          });
        }
        // Second compact() call: succeed
        return Promise.resolve({
          sendPrompt: vi.fn(() =>
            Promise.resolve(buildModelResponse(['recovered'])),
          ),
          destroy: vi.fn(),
        });
      };

      const store = createFakeBufferStore([entry]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: {
          enabled: true,
          maxConsecutiveModelFailures: 100, // high so breaker doesn't trip
        },
      });

      // First call: model fails, falls back to deterministic eviction
      const first = await worker.compact('test-project');
      expect(first.usedFallback).toBe(true);
      expect(worker.active).toBe(false);

      // Second call should succeed (guard was released)
      const second = await worker.compact('test-project');
      expect(second).toBeDefined();
      expect(worker.active).toBe(false);
    });
  });

  // ── Model retry logic ──────────────────────────────────────────────

  describe('model retry logic', () => {
    /**
     * Validates: Requirements 3.5, 3.6, 13.1
     */
    it('retries up to maxModelRetries before falling back', async () => {
      const destroyFn = vi.fn();
      let sendPromptCallCount = 0;

      sessionFactory = () =>
        Promise.resolve({
          sendPrompt: vi.fn(() => {
            sendPromptCallCount++;
            return Promise.reject(new Error('model error'));
          }),
          destroy: destroyFn,
        });

      const store = createFakeBufferStore([entry, entry2]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: {
          enabled: true,
          maxModelRetries: 3,
          maxConsecutiveModelFailures: 100,
        },
      });

      const result = await worker.compact('test-project');

      // Model was attempted exactly maxModelRetries times
      expect(sendPromptCallCount).toBe(3);

      // Session destroy called for each attempt
      expect(destroyFn).toHaveBeenCalledTimes(3);

      // Fell back to deterministic eviction
      expect(result.usedFallback).toBe(true);

      // Deterministic eviction keeps ceil(2/2) = 1 entry
      expect(result.entriesAfter).toBe(1);
    });

    /**
     * Validates: Requirements 3.3, 3.6
     */
    it('succeeds on retry after initial failure', async () => {
      let attemptCount = 0;

      sessionFactory = () => {
        attemptCount++;
        if (attemptCount === 1) {
          return Promise.resolve({
            sendPrompt: vi.fn(() =>
              Promise.reject(new Error('transient error')),
            ),
            destroy: vi.fn(),
          });
        }
        return Promise.resolve({
          sendPrompt: vi.fn(() =>
            Promise.resolve(buildModelResponse(['recovered summary'])),
          ),
          destroy: vi.fn(),
        });
      };

      const store = createFakeBufferStore([entry]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: { enabled: true, maxModelRetries: 3 },
      });

      const result = await worker.compact('test-project');

      // Model succeeded on retry — not fallback
      expect(result.usedFallback).toBe(false);
    });
  });

  // ── Deterministic eviction fallback ─────────────────────────────────

  describe('deterministic eviction fallback', () => {
    /**
     * Validates: Requirements 4.1, 4.4, 13.1, 13.2
     */
    it('falls back to deterministic eviction on model failure', async () => {
      sessionFactory = () =>
        Promise.resolve({
          sendPrompt: vi.fn(() =>
            Promise.reject(new Error('model unavailable')),
          ),
          destroy: vi.fn(),
        });

      const store = createFakeBufferStore([entry, entry2]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: {
          enabled: true,
          maxConsecutiveModelFailures: 100,
        },
      });

      const result = await worker.compact('test-project');

      expect(result.usedFallback).toBe(true);
      // Deterministic eviction keeps ceil(2/2) = 1 entry (the most recent)
      // Plus 0 catch-up entries
      expect(result.entriesAfter).toBe(1);

      // Verify replace was called with the evicted entries
      const replaceCall = vi.mocked(store.replace).mock.calls[0]!;
      const evictedEntries = replaceCall[1] as BufferEntry[];
      expect(evictedEntries).toHaveLength(1);
      // The most recent entry by timestamp should be kept
      expect(evictedEntries[0]!.timestamp).toBe('2024-01-02T00:00:00Z');
    });
  });

  // ── Circuit breaker ─────────────────────────────────────────────────

  describe('circuit breaker', () => {
    /**
     * Validates: Requirements 5.1, 5.2, 5.3
     */
    it('trips after maxConsecutiveModelFailures', async () => {
      sessionFactory = () =>
        Promise.resolve({
          sendPrompt: vi.fn(() =>
            Promise.reject(new Error('model failure')),
          ),
          destroy: vi.fn(),
        });

      const store = createFakeBufferStore([entry]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: {
          enabled: true,
          maxConsecutiveModelFailures: 2,
        },
      });

      // Cause 2 consecutive failures
      const r1 = await worker.compact('test-project');
      expect(r1.usedFallback).toBe(true);

      const r2 = await worker.compact('test-project');
      expect(r2.usedFallback).toBe(true);

      // Now the circuit breaker should be tripped — even if model would succeed,
      // deterministic eviction is used directly
      sessionFactory = () =>
        Promise.resolve({
          sendPrompt: vi.fn(() =>
            Promise.resolve(buildModelResponse(['should not be called'])),
          ),
          destroy: vi.fn(),
        });

      const r3 = await worker.compact('test-project');
      expect(r3.usedFallback).toBe(true);
    });

    /**
     * Validates: Requirements 5.1, 5.2
     */
    it('resets on model success', async () => {
      let shouldFail = true;

      sessionFactory = () => {
        if (shouldFail) {
          return Promise.resolve({
            sendPrompt: vi.fn(() =>
              Promise.reject(new Error('model failure')),
            ),
            destroy: vi.fn(),
          });
        }
        return Promise.resolve({
          sendPrompt: vi.fn(() =>
            Promise.resolve(buildModelResponse(['success summary'])),
          ),
          destroy: vi.fn(),
        });
      };

      const store = createFakeBufferStore([entry]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: {
          enabled: true,
          maxConsecutiveModelFailures: 3,
        },
      });

      // Cause 2 failures (below threshold of 3)
      await worker.compact('test-project');
      await worker.compact('test-project');

      // Now succeed — should reset counter
      shouldFail = false;
      const successResult = await worker.compact('test-project');
      expect(successResult.usedFallback).toBe(false);

      // Cause 2 more failures — counter should have reset, so breaker not tripped
      shouldFail = true;
      await worker.compact('test-project');
      await worker.compact('test-project');

      // 3rd failure should trip the breaker (counter was reset to 0 after success)
      const r = await worker.compact('test-project');
      expect(r.usedFallback).toBe(true);

      // Now breaker is tripped
      shouldFail = false;
      const trippedResult = await worker.compact('test-project');
      expect(trippedResult.usedFallback).toBe(true);
    });
  });

  // ── drain() ─────────────────────────────────────────────────────────

  describe('drain', () => {
    /**
     * Validates: Requirement 1.6
     */
    it('waits for in-flight compaction', async () => {
      let resolveModel!: (value: string) => void;
      const modelPromise = new Promise<string>((resolve) => {
        resolveModel = resolve;
      });

      sessionFactory = () =>
        Promise.resolve({
          sendPrompt: vi.fn(() => modelPromise),
          destroy: vi.fn(),
        });

      const store = createFakeBufferStore([entry]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: { enabled: true },
      });

      // Start compaction (blocks on model)
      const compactPromise = worker.compact('test-project');

      // drain should wait for the in-flight compaction
      let drained = false;
      const drainPromise = worker.drain(5000).then(() => {
        drained = true;
      });

      // Not drained yet — model hasn't resolved
      expect(drained).toBe(false);

      // Resolve the model call
      resolveModel(buildModelResponse(['summary']));

      // Both should complete
      await compactPromise;
      await drainPromise;

      expect(drained).toBe(true);
    });

    /**
     * Validates: Requirement 1.6
     */
    it('resolves immediately when no compaction is in-flight', async () => {
      const store = createFakeBufferStore([]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: { enabled: true },
      });

      // Should resolve immediately
      await worker.drain(1000);
    });
  });

  // ── active property ─────────────────────────────────────────────────

  describe('active property', () => {
    /**
     * Validates: Requirement 2.3
     */
    it('reflects in-flight state', async () => {
      let resolveModel!: (value: string) => void;
      const modelPromise = new Promise<string>((resolve) => {
        resolveModel = resolve;
      });

      sessionFactory = () =>
        Promise.resolve({
          sendPrompt: vi.fn(() => modelPromise),
          destroy: vi.fn(),
        });

      const store = createFakeBufferStore([entry]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: { enabled: true },
      });

      // Before compact: active is false
      expect(worker.active).toBe(false);

      // Start compact but don't await
      const compactPromise = worker.compact('test-project');

      // During compact: active is true
      expect(worker.active).toBe(true);

      // Resolve the model call
      resolveModel(buildModelResponse(['summary']));
      await compactPromise;

      // After compact: active is false
      expect(worker.active).toBe(false);
    });
  });

  // ── Empty buffer ────────────────────────────────────────────────────

  describe('empty buffer', () => {
    /**
     * Validates: Requirements 1.1, 1.4
     */
    it('returns early with zero metrics', async () => {
      const store = createFakeBufferStore([]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: { enabled: true },
      });

      const result = await worker.compact('test-project');

      expect(result.projectId).toBe('test-project');
      expect(result.entriesBefore).toBe(0);
      expect(result.entriesAfter).toBe(0);
      expect(result.bytesSaved).toBe(0);
      expect(result.modelDurationMs).toBe(0);
      expect(result.replaceDurationMs).toBe(0);
      expect(result.usedFallback).toBe(false);

      // replace should NOT have been called
      expect(store.replace).not.toHaveBeenCalled();
    });
  });

  // ── notifyCompactionResult ──────────────────────────────────────────

  describe('notifyCompactionResult', () => {
    /**
     * Validates: Requirements 1.4, 1.5
     */
    it('called with success and newSizeBytes on successful compaction', async () => {
      sessionFactory = () =>
        Promise.resolve({
          sendPrompt: vi.fn(() =>
            Promise.resolve(buildModelResponse(['summary'])),
          ),
          destroy: vi.fn(),
        });

      const store = createFakeBufferStore([entry]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: { enabled: true },
      });

      await worker.compact('test-project');

      // notifyCompactionResult should have been called with success=true
      expect(watcher.notifyCompactionResult).toHaveBeenCalledWith(
        'test-project',
        true,
        100, // newSizeBytes from the mock replace result
      );
    });

    /**
     * Validates: Requirements 1.4, 1.5
     */
    it('called with success on empty buffer early return', async () => {
      const store = createFakeBufferStore([]);
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: { enabled: true },
      });

      await worker.compact('test-project');

      // notifyCompactionResult should have been called with success=true, newSizeBytes=0
      expect(watcher.notifyCompactionResult).toHaveBeenCalledWith(
        'test-project',
        true,
        0,
      );
    });

    /**
     * Validates: Requirement 1.5
     */
    it('called with failure when replace throws', async () => {
      sessionFactory = () =>
        Promise.resolve({
          sendPrompt: vi.fn(() =>
            Promise.resolve(buildModelResponse(['summary'])),
          ),
          destroy: vi.fn(),
        });

      const store = createFakeBufferStore([entry]);
      vi.mocked(store.replace).mockRejectedValue(new Error('disk full'));
      const watcher = createFakeWatcher();

      const { createCompactionWorker } = await import(
        '../../src/collector/buffer/compaction.js'
      );

      const worker = createCompactionWorker({
        bufferStore: store,
        watcher,
        config: { enabled: true },
      });

      await expect(worker.compact('test-project')).rejects.toThrow('disk full');

      // notifyCompactionResult should have been called with success=false
      expect(watcher.notifyCompactionResult).toHaveBeenCalledWith(
        'test-project',
        false,
      );
    });
  });
});
