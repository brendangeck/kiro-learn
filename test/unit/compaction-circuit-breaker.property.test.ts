/**
 * Property test: Model failure circuit breaker (Property 5).
 *
 * For any sequence of compaction attempts on the same project, after
 * `maxConsecutiveModelFailures` consecutive model failures, subsequent
 * attempts use deterministic eviction (usedFallback=true) without calling
 * the model. A successful model compaction resets the failure counter to 0.
 *
 * **Validates: Requirements 5.1, 5.2, 5.3**
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Property 5
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirement 5
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

import type { BufferStore, ReplaceResult } from '../../src/collector/buffer/store.js';
import type { BufferWatcher } from '../../src/collector/buffer/watcher.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';
import { bufferEntryArb } from '../helpers/arbitrary.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

/**
 * Controls whether the mocked ACP session succeeds or fails on each call.
 * The test sets this before each compact() invocation.
 */
let sessionShouldSucceed: boolean;

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() => {
    if (!sessionShouldSucceed) {
      return Promise.resolve({
        sendPrompt: vi.fn(() => Promise.reject(new Error('model failure'))),
        destroy: vi.fn(),
      });
    }
    return Promise.resolve({
      sendPrompt: vi.fn(() =>
        Promise.resolve('<compacted_entry>compacted summary</compacted_entry>'),
      ),
      destroy: vi.fn(),
    });
  }),
}));

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

// ── Tests ────────────────────────────────────────────────────────────────

describe('Property 5: Model failure circuit breaker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionShouldSucceed = true;
  });

  /**
   * Property 5a: After `maxConsecutiveModelFailures` consecutive model
   * failures, subsequent compact() calls use deterministic eviction
   * (usedFallback=true) without calling the model.
   *
   * **Validates: Requirements 5.1, 5.2, 5.3**
   */
  it('after maxConsecutiveModelFailures consecutive failures, uses deterministic eviction', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 1–5 buffer entries for the snapshot
        fc.array(bufferEntryArb(), { minLength: 1, maxLength: 5 }),
        // Generate maxConsecutiveModelFailures threshold (1–5)
        fc.integer({ min: 1, max: 5 }),
        async (entries, maxFailures) => {
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
              maxConsecutiveModelFailures: maxFailures,
            },
          });

          // Phase 1: Cause exactly maxFailures consecutive model failures.
          // Each model failure within a compact() call causes the worker to
          // fall back to deterministic eviction for that call, and increments
          // the per-project failure counter by 1.
          sessionShouldSucceed = false;

          for (let i = 0; i < maxFailures; i++) {
            const result = await worker.compact('test-project');
            // Each call falls back to deterministic eviction because the
            // model fails on all retries within the call
            expect(result.usedFallback).toBe(true);
          }

          // Phase 2: The circuit breaker should now be tripped. The next
          // compact() call should use deterministic eviction directly
          // without even attempting the model call.
          //
          // We set sessionShouldSucceed = true, but the circuit breaker
          // should bypass the model entirely.
          sessionShouldSucceed = true;

          const circuitBrokenResult = await worker.compact('test-project');
          expect(circuitBrokenResult.usedFallback).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });

  /**
   * Property 5b: A successful model compaction resets the failure counter
   * to 0, so subsequent failures start counting from 0 again.
   *
   * **Validates: Requirements 5.1, 5.2**
   */
  it('successful model compaction resets the failure counter', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(bufferEntryArb(), { minLength: 1, maxLength: 5 }),
        // Number of failures before the success (must be less than threshold)
        fc.integer({ min: 1, max: 4 }),
        async (entries, failuresBefore) => {
          // Use a threshold that is strictly greater than failuresBefore
          const maxFailures = failuresBefore + 1;

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
              maxConsecutiveModelFailures: maxFailures,
            },
          });

          // Phase 1: Accumulate some failures (but not enough to trip breaker)
          sessionShouldSucceed = false;

          for (let i = 0; i < failuresBefore; i++) {
            const result = await worker.compact('test-project');
            expect(result.usedFallback).toBe(true);
          }

          // Phase 2: Succeed — this should reset the counter to 0
          sessionShouldSucceed = true;

          const successResult = await worker.compact('test-project');
          expect(successResult.usedFallback).toBe(false);

          // Phase 3: Fail again — counter should start from 0, so we need
          // maxFailures consecutive failures to trip the breaker again.
          // Verify that (maxFailures - 1) failures do NOT trip the breaker
          // (the model is still attempted).
          sessionShouldSucceed = false;

          for (let i = 0; i < maxFailures - 1; i++) {
            const result = await worker.compact('test-project');
            // Falls back because model fails, but breaker is not yet tripped
            expect(result.usedFallback).toBe(true);
          }

          // The next failure should trip the breaker (maxFailures reached)
          const tripResult = await worker.compact('test-project');
          expect(tripResult.usedFallback).toBe(true);

          // Now the breaker is tripped — even with model available, fallback is used
          sessionShouldSucceed = true;
          const breakerTrippedResult = await worker.compact('test-project');
          expect(breakerTrippedResult.usedFallback).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });

  /**
   * Property 5c: For any sequence of success/failure results, the circuit
   * breaker state is consistent — the failure counter behaves monotonically
   * (increments on failure, resets on success) and the fallback engages at
   * exactly the configured threshold.
   *
   * **Validates: Requirements 5.1, 5.2, 5.3**
   */
  it('circuit breaker state is consistent for arbitrary success/failure sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(bufferEntryArb(), { minLength: 1, maxLength: 3 }),
        // Arbitrary sequence of success (true) / failure (false) outcomes
        fc.array(fc.boolean(), { minLength: 1, maxLength: 15 }),
        // maxConsecutiveModelFailures threshold
        fc.integer({ min: 1, max: 5 }),
        async (entries, outcomes, maxFailures) => {
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
              maxConsecutiveModelFailures: maxFailures,
            },
          });

          let consecutiveFailures = 0;

          for (const shouldSucceed of outcomes) {
            sessionShouldSucceed = shouldSucceed;

            const result = await worker.compact('test-project');

            if (consecutiveFailures >= maxFailures) {
              // Circuit breaker is tripped — always uses fallback
              // regardless of whether the model would succeed
              expect(result.usedFallback).toBe(true);

              if (shouldSucceed) {
                // Model was not called (breaker tripped), so fallback is used.
                // The counter does NOT reset because the model was never called.
                // consecutiveFailures stays the same.
              } else {
                // Model was not called (breaker tripped), fallback used.
                // consecutiveFailures stays the same.
              }
            } else if (shouldSucceed) {
              // Model succeeds — counter resets to 0
              expect(result.usedFallback).toBe(false);
              consecutiveFailures = 0;
            } else {
              // Model fails — counter increments, fallback used for this call
              consecutiveFailures += 1;
              expect(result.usedFallback).toBe(true);
            }
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});
