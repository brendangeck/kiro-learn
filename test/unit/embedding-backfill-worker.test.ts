/**
 * Unit tests for the `BackfillWorker` lifecycle (task 10.3).
 *
 * Exercises the state machine documented in
 * `src/collector/backfill/worker.ts`:
 *
 *   idle ──start()──▶ running ─(empty batch)──▶ idle
 *                       │
 *                       ├─(N consecutive failures)──▶ paused ──▶ running
 *                       │
 *                       └─stop()────────────────────▶ stopped
 *
 * Covered scenarios:
 *
 *   - `start()` processes every NULL-embedding row and lands in
 *     `idle` once the backlog is drained.
 *   - `stop(timeout)` interrupts a mid-batch run quickly, yielding
 *     `state === 'stopped'` well inside the supplied timeout.
 *   - Degraded-mode guard: when `embedder.isReady()` is `false` at
 *     the top of the loop, the worker exits without calling
 *     `embed` / `putEmbedding` and lands in `idle`.
 *   - Circuit breaker: `circuitBreakerFailures` consecutive embed
 *     failures trip the breaker — the worker visits `paused` and
 *     later recovers to `running`.
 *   - `status().processed` is a monotonic non-decreasing counter
 *     across the whole run.
 *
 * Design choices:
 *
 *   - The storage backend is the real SQLite implementation via
 *     `openSqliteStorage({ dbPath: ':memory:' })`. A fake here
 *     would reinvent the row semantics we actually care about
 *     (the `embedding IS NULL` filter, the `created_at ASC`
 *     order).
 *   - The `Embedder` is a `vi.fn()`-backed fake modelled on
 *     `makeMockEmbedder` from
 *     `embedding-extraction-worker.test.ts` (task 7.2). We drive
 *     all lifecycle scenarios by adjusting its `isReady` /
 *     `embed` behaviour between tests.
 *   - Circuit breaker timing is compressed to sub-second values
 *     (`circuitBreakerPauseMs: 100`, `idleMs: 5`) so the test
 *     suite stays under a second end-to-end.
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md § Task 10.3
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md §§ 8.4, 8.5, 8.6
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackfillWorker } from '../../src/collector/backfill/index.js';
import type { Embedder } from '../../src/collector/embedding/index.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { MemoryRecord, StorageBackend } from '../../src/types/index.js';

import { makeValidRecord } from '../helpers/fixtures.js';

// ── Constants ───────────────────────────────────────────────────────────

const NS = '/actor/alice/project/abc/';

// ── Mock embedder ───────────────────────────────────────────────────────

/**
 * Build a mock `Embedder` with configurable readiness, delay, and
 * failure behaviour. Mirrors the helper used in
 * `embedding-extraction-worker.test.ts`.
 *
 * `embedShouldFail`, if provided, is consulted on each `embed`
 * call and thrown when it returns true. This lets individual
 * tests script a precise sequence of failures / successes (e.g.
 * "the first 5 calls fail, all subsequent calls succeed").
 */
function makeMockEmbedder(opts: {
  isReady?: boolean;
  embedReturn?: Float32Array;
  embedDelayMs?: number;
  embedShouldFail?: () => boolean;
  embedError?: Error;
} = {}): Embedder & {
  embed: ReturnType<typeof vi.fn>;
  isReady: ReturnType<typeof vi.fn>;
  ready: ReturnType<typeof vi.fn>;
} {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => opts.isReady ?? true),
    embed: vi.fn(async () => {
      if (opts.embedDelayMs !== undefined && opts.embedDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.embedDelayMs));
      }
      if (opts.embedShouldFail && opts.embedShouldFail()) {
        throw opts.embedError ?? new Error('embed failed');
      }
      return opts.embedReturn !== undefined
        ? new Float32Array(opts.embedReturn)
        : new Float32Array(384);
    }),
    dim: 384 as const,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Seed `count` memory records with staggered `created_at` values so
 * the `created_at ASC` scan order is deterministic. Records are
 * stored without embeddings (the worker under test is what adds
 * them).
 */
async function seedRecordsWithoutEmbeddings(
  storage: StorageBackend,
  count: number,
): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const suffix = String(i).padStart(2, '0');
    const record = makeValidRecord({
      // `MemoryRecordSchema.record_id` requires the `mr_` prefix
      // followed by a ULID. We vary the last two chars to keep
      // each id unique while staying in the Crockford base32 set.
      record_id: `mr_01JF8ZS4Z000000000000000${suffix}`,
      namespace: NS,
      title: `Record ${suffix}`,
      summary: `Summary for record ${suffix}`,
      // Stagger so `listRecordsWithoutEmbedding` returns a stable
      // ordering (ASC by created_at). Minutes to stay well under
      // day-level granularity and avoid ISO-8601 rollover.
      created_at: `2026-04-23T20:${String(i).padStart(2, '0')}:00Z`,
    });
    await storage.putMemoryRecord(record);
    records.push(record);
  }
  return records;
}

/** Poll until `predicate()` returns true or `timeoutMs` elapses. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ── Test-lifecycle scaffolding ──────────────────────────────────────────

let storage: StorageBackend;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  storage = openSqliteStorage({ dbPath: ':memory:' });
  // Swallow the worker's "embed failed" warnings to keep the test
  // output clean. We still let successful test logging through via
  // the vi default.
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);
});

afterEach(async () => {
  stderrSpy.mockRestore();
  try {
    await storage.close();
  } catch {
    // swallow — cleanup must not mask a real failure
  }
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('BackfillWorker lifecycle', () => {
  /**
   * Seed three records without embeddings, start the worker, wait
   * for the backlog to drain. Every record ends up with an
   * embedding and the worker's final state is `idle` (the terminal
   * state after an empty `listRecordsWithoutEmbedding` batch).
   *
   * `processed` matches the backlog size.
   *
   * Validates: Requirements 8.4, 8.6
   */
  it('start() processes all NULL-embedding records and returns to idle', async () => {
    const seeded = await seedRecordsWithoutEmbeddings(storage, 3);

    const embedder = makeMockEmbedder();
    const worker = createBackfillWorker({
      storage,
      embedder,
      config: {
        batchSize: 32,
        idleMs: 5,
        circuitBreakerFailures: 5,
        circuitBreakerPauseMs: 100,
      },
    });

    expect(worker.status().state).toBe('idle');

    worker.start();

    await waitFor(() => worker.status().state === 'idle', 2000);

    const status = worker.status();
    expect(status.state).toBe('idle');
    expect(status.processed).toBe(seeded.length);
    expect(status.lastError).toBeNull();
    expect(embedder.embed).toHaveBeenCalledTimes(seeded.length);

    // Every record's embedding is durably persisted.
    for (const r of seeded) {
      const vec = await storage.getEmbedding(r.record_id);
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec?.length).toBe(384);
    }

    // No NULL-embedding rows remain for this namespace.
    const remaining = await storage.listRecordsWithoutEmbedding(NS, 100);
    expect(remaining).toHaveLength(0);
  });

  /**
   * With a slow embedder and a healthy backlog, `stop(timeoutMs)`
   * should resolve well inside the timeout because the worker cuts
   * short its in-flight `idleMs` sleep AND stops taking new work
   * between records. The terminal state is `stopped` and any
   * subsequent `status()` call reports that value (stopped is
   * terminal for the lifetime of the handle).
   *
   * We use `embedDelayMs: 500` so the first batch is still in
   * flight when `stop` fires; the timeout is 1000 ms, so even the
   * worst case (complete one in-flight embed, then stop) resolves
   * in ≲ 500 ms.
   *
   * Validates: Requirements 8.4, 8.5
   */
  it('stop(timeoutMs) interrupts mid-batch and resolves within the timeout', async () => {
    await seedRecordsWithoutEmbeddings(storage, 10);

    const embedder = makeMockEmbedder({ embedDelayMs: 500 });
    const worker = createBackfillWorker({
      storage,
      embedder,
      config: {
        batchSize: 32,
        idleMs: 5,
        circuitBreakerFailures: 5,
        circuitBreakerPauseMs: 100,
      },
    });

    worker.start();

    // Give the worker a moment to enter `running` and kick off its
    // first slow embed.
    await waitFor(() => worker.status().state === 'running', 500);
    expect(worker.status().state).toBe('running');

    const startedAt = Date.now();
    await worker.stop(1000);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1000);
    expect(worker.status().state).toBe('stopped');

    // Calling `stop` again on a stopped worker is idempotent and
    // keeps the terminal state visible.
    await worker.stop(10);
    expect(worker.status().state).toBe('stopped');
  });

  /**
   * When `embedder.isReady()` is `false` at the top of the loop,
   * the worker must return cleanly without ever calling `embed` or
   * `putEmbedding`. The state lands in `idle` (the loop's
   * non-stopped exit path).
   *
   * Validates: Requirement 8.5, 8.6 (degraded-mode guard)
   */
  it('exits cleanly without processing when embedder.isReady() is false', async () => {
    const seeded = await seedRecordsWithoutEmbeddings(storage, 3);

    const embedder = makeMockEmbedder({ isReady: false });
    const worker = createBackfillWorker({
      storage,
      embedder,
      config: {
        batchSize: 32,
        idleMs: 5,
        circuitBreakerFailures: 5,
        circuitBreakerPauseMs: 100,
      },
    });

    worker.start();

    // The loop reaches its `isReady()` guard on the first tick and
    // returns. Give it a handful of microtasks to settle.
    await waitFor(() => worker.status().state !== 'running', 500);

    const status = worker.status();
    expect(status.state).toBe('idle');
    expect(status.processed).toBe(0);
    expect(embedder.embed).not.toHaveBeenCalled();

    // Records remain without embeddings.
    const remaining = await storage.listRecordsWithoutEmbedding(NS, 100);
    expect(remaining).toHaveLength(seeded.length);
  });

  /**
   * Circuit breaker: configure the worker for 5 consecutive
   * failures before trip. Seed 6 records; the embedder fails the
   * first 5 calls and succeeds thereafter. Verify the worker
   * visits the `paused` state during the pause window and returns
   * to `running` when the pause completes.
   *
   * After the pause, the next iteration of the loop re-queries
   * `listRecordsWithoutEmbedding` — the 5 previously-failed
   * records are still NULL, so they come back in the new batch.
   * With the embedder now healthy, every record embeds
   * successfully and `processed` ends at the full backlog size
   * (6).
   *
   * Validates: Requirements 8.4, 8.5
   */
  it('trips the circuit breaker on 5 consecutive failures and recovers to running', async () => {
    const seeded = await seedRecordsWithoutEmbeddings(storage, 6);

    let calls = 0;
    const embedder = makeMockEmbedder({
      embedShouldFail: () => {
        calls += 1;
        return calls <= 5;
      },
      embedError: new Error('transient embed failure'),
    });

    const observedStates = new Set<string>();
    const worker = createBackfillWorker({
      storage,
      embedder,
      config: {
        batchSize: 32,
        idleMs: 5,
        circuitBreakerFailures: 5,
        circuitBreakerPauseMs: 100,
      },
    });

    worker.start();

    // Poll states while the worker runs so we catch the transient
    // `paused` window — it only lasts `circuitBreakerPauseMs`.
    const poller = setInterval(() => {
      observedStates.add(worker.status().state);
    }, 5);

    await waitFor(() => worker.status().state === 'idle', 2000);
    clearInterval(poller);
    observedStates.add(worker.status().state);

    // We saw both the pause and the subsequent resume-to-running
    // before the backlog drained.
    expect(observedStates.has('paused')).toBe(true);
    expect(observedStates.has('running')).toBe(true);

    // Final state is idle after the backlog drained. The worker
    // re-queried after the pause; the 5 previously-failed records
    // still had NULL embeddings, so they were retried alongside
    // the 6th record and all succeeded.
    const status = worker.status();
    expect(status.state).toBe('idle');
    expect(status.processed).toBe(seeded.length);
    // The successful final embeds cleared `lastError`.
    expect(status.lastError).toBeNull();
  });

  /**
   * `status().processed` is the monotonic count of successful
   * embed + putEmbedding pairs. It must never decrease across a
   * run. We sample it continuously while the worker drains a
   * backlog and assert that every sample is ≥ the previous one.
   *
   * Validates: Requirements 8.4
   */
  it('status().processed monotonically increases across a run', async () => {
    const seeded = await seedRecordsWithoutEmbeddings(storage, 8);

    // Short per-call delay so the sampler below can catch
    // intermediate values of `processed` rather than only the
    // initial 0 and the final 8.
    const embedder = makeMockEmbedder({ embedDelayMs: 15 });
    const worker = createBackfillWorker({
      storage,
      embedder,
      config: {
        batchSize: 32,
        idleMs: 5,
        circuitBreakerFailures: 5,
        circuitBreakerPauseMs: 100,
      },
    });

    const samples: number[] = [worker.status().processed];

    worker.start();

    const poller = setInterval(() => {
      samples.push(worker.status().processed);
    }, 5);

    await waitFor(() => worker.status().state === 'idle', 3000);
    clearInterval(poller);
    samples.push(worker.status().processed);

    // Monotonic non-decreasing.
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]! >= samples[i - 1]!).toBe(true);
    }

    // Final count matches the backlog size.
    expect(worker.status().processed).toBe(seeded.length);
  });
});
