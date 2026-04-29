/**
 * Property test: Reentrance guard serialization (Property 4).
 *
 * For any sequence of `compact()` calls, at most one compaction is in-flight
 * at any time. Concurrent calls are rejected immediately with an error. The
 * reentrance guard is released even if the compaction fails.
 *
 * **Validates: Requirements 2.1, 2.2**
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Property 4
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirement 2
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

import type { BufferStore, ReplaceResult } from '../../src/collector/buffer/store.js';
import type { BufferWatcher } from '../../src/collector/buffer/watcher.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';
import { bufferEntryArb } from '../helpers/arbitrary.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

/**
 * Deferred promise control: each call to createAcpSession returns a session
 * whose sendPrompt resolves/rejects when the caller resolves/rejects the
 * deferred. This lets us control when compaction "finishes" to test
 * concurrent call rejection.
 */
let sessionFactory: () => Promise<{
  sendPrompt: (content: string) => Promise<string>;
  destroy: () => void;
}>;

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() => sessionFactory()),
}));

// ── Fake dependencies ───────────────────────────────────────────────────

function createFakeBufferStore(entries: BufferEntry[]): BufferStore {
  const serialized = entries.map((e) => JSON.stringify(e) + '\n').join('');
  const sizeBytes = Buffer.byteLength(serialized, 'utf-8');

  return {
    append: vi.fn().mockResolvedValue(0),
    snapshot: vi.fn().mockResolvedValue(entries),
    snapshotWithSize: vi.fn().mockResolvedValue({ entries, sizeBytes }),
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

/**
 * Build a valid `<compacted_entry>` XML response from summary strings.
 */
function buildModelResponse(summaries: string[]): string {
  return summaries
    .map((s) => `<compacted_entry>${s}</compacted_entry>`)
    .join('\n');
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Property 4: Reentrance guard serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Property 4a: For any number of concurrent compact() calls (2–5),
   * exactly one succeeds and the rest are rejected immediately.
   *
   * **Validates: Requirements 2.1, 2.2**
   */
  it('at most one compaction is in-flight; concurrent calls are rejected', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 1–5 buffer entries for the snapshot
        fc.array(bufferEntryArb(), { minLength: 1, maxLength: 5 }),
        // Generate number of concurrent calls (2–5)
        fc.integer({ min: 2, max: 5 }),
        async (entries, concurrentCalls) => {
          // Set up a deferred so we can control when the model call completes
          let resolveModel!: (value: string) => void;
          const modelPromise = new Promise<string>((resolve) => {
            resolveModel = resolve;
          });

          sessionFactory = () =>
            Promise.resolve({
              sendPrompt: vi.fn(() => modelPromise),
              destroy: vi.fn(),
            });

          const store = createFakeBufferStore(entries);
          const watcher = createFakeWatcher();

          // Dynamic import to pick up the mock
          const { createCompactionWorker } = await import(
            '../../src/collector/buffer/compaction.js'
          );

          const worker = createCompactionWorker({
            bufferStore: store,
            watcher,
            config: { enabled: true },
          });

          // Fire N concurrent compact() calls
          const promises: Array<Promise<unknown>> = [];
          for (let i = 0; i < concurrentCalls; i++) {
            promises.push(
              worker.compact('test-project').then(
                (result) => ({ status: 'fulfilled' as const, result }),
                (error: unknown) => ({ status: 'rejected' as const, error }),
              ),
            );
          }

          // Let the model call complete
          resolveModel(buildModelResponse(['summary entry']));

          const results = await Promise.all(promises);

          // Exactly one should succeed, the rest should be rejected
          const fulfilled = results.filter((r) => r.status === 'fulfilled');
          const rejected = results.filter((r) => r.status === 'rejected');

          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(concurrentCalls - 1);

          // All rejections should mention "already in-flight"
          for (const r of rejected) {
            if (r.status === 'rejected') {
              expect(String(r.error)).toContain('already in-flight');
            }
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  /**
   * Property 4b: After a failed compaction (model throws), the reentrance
   * guard is released and subsequent calls can proceed.
   *
   * **Validates: Requirements 2.1, 2.2**
   */
  it('reentrance guard is released even if compaction fails', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(bufferEntryArb(), { minLength: 1, maxLength: 5 }),
        async (entries) => {
          let compactCallIndex = 0;

          sessionFactory = () => {
            if (compactCallIndex === 0) {
              // All sessions during the first compact() call fail
              return Promise.resolve({
                sendPrompt: vi.fn(() =>
                  Promise.reject(new Error('model exploded')),
                ),
                destroy: vi.fn(),
              });
            }
            // Sessions during subsequent compact() calls succeed
            return Promise.resolve({
              sendPrompt: vi.fn(() =>
                Promise.resolve(buildModelResponse(['recovered summary'])),
              ),
              destroy: vi.fn(),
            });
          };

          const store = createFakeBufferStore(entries);
          const watcher = createFakeWatcher();

          const { createCompactionWorker } = await import(
            '../../src/collector/buffer/compaction.js'
          );

          const worker = createCompactionWorker({
            bufferStore: store,
            watcher,
            config: {
              enabled: true,
              // Set high so circuit breaker doesn't trip
              maxConsecutiveModelFailures: 100,
            },
          });

          // First call: model throws on every retry, falls back to deterministic eviction
          const firstResult = await worker.compact('test-project');
          expect(firstResult.usedFallback).toBe(true);

          // Guard should be released — active should be false
          expect(worker.active).toBe(false);

          // Advance to the next compact call so sessions succeed
          compactCallIndex = 1;

          // Second call should succeed (guard was released)
          const secondResult = await worker.compact('test-project');
          expect(secondResult).toBeDefined();
          expect(worker.active).toBe(false);
        },
      ),
      { numRuns: 20 },
    );
  });

  /**
   * Property 4c: The `active` property accurately reflects in-flight state.
   * Before compact() starts, active is false. During compact(), active is true.
   * After compact() completes, active is false.
   *
   * **Validates: Requirements 2.1, 2.3**
   */
  it('active property reflects in-flight state accurately', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(bufferEntryArb(), { minLength: 1, maxLength: 3 }),
        async (entries) => {
          let resolveModel!: (value: string) => void;
          const modelPromise = new Promise<string>((resolve) => {
            resolveModel = resolve;
          });

          sessionFactory = () =>
            Promise.resolve({
              sendPrompt: vi.fn(() => modelPromise),
              destroy: vi.fn(),
            });

          const store = createFakeBufferStore(entries);
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

          // Start compact but don't await yet
          const compactPromise = worker.compact('test-project');

          // During compact: active is true
          expect(worker.active).toBe(true);

          // Resolve the model call
          resolveModel(buildModelResponse(['summary']));

          await compactPromise;

          // After compact: active is false
          expect(worker.active).toBe(false);
        },
      ),
      { numRuns: 20 },
    );
  });
});
