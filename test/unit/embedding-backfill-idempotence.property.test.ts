/**
 * Property-based test for `BackfillWorker` idempotence.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 13:
 * Backfill is idempotent and does no redundant work.
 *
 * The contract under test — copied verbatim from
 * `.kiro/specs/local-embeddings-and-hybrid-search/design.md`
 * § Property 13:
 *
 *   *For any* corpus, running the backfill loop to completion
 *   once versus twice produces the same set of stored
 *   `{record_id, embedding bytes}` pairs in the database. On the
 *   second run, `embedder.embed` is invoked **zero** times
 *   (measured by a spy on the embedder passed into the second
 *   worker).
 *
 * The property has two load-bearing halves:
 *
 *   1. **State convergence.** After the first run, the worker
 *      has embedded every record whose `embedding IS NULL` and
 *      left every pre-existing embedding untouched. A second run
 *      starts from that terminal state and must not mutate it —
 *      the set of `(record_id, embedding bytes)` pairs after the
 *      second run equals the set after the first.
 *   2. **No redundant embed work.** A second worker, constructed
 *      with a *fresh* embedder spy, must not call `embed` at all.
 *      The contract in `worker.ts` is that the loop exits cleanly
 *      on an empty `listRecordsWithoutEmbedding` batch — if that
 *      contract regresses (e.g. the worker re-embeds rows it
 *      already processed, or ignores the NULL filter), the spy
 *      count will be non-zero and the test fails with a crisp
 *      signal.
 *
 * Together these halves pin down the "no redundant work"
 * guarantee in Req 19.2: a crash-and-resume cycle that re-runs
 * backfill against a fully-embedded corpus is free, and a partial
 * backfill that resumes after restart only embeds the rows that
 * were still `NULL` at the time of the second start.
 *
 * ## Setup
 *
 * Per run:
 *   - A fresh in-memory SQLite backend.
 *   - An {@link arbitraryMixedCorpus} of 1–10 records in a fixed
 *     namespace. Roughly half of the records ship with an
 *     embedding already (simulating the pre-spec state where
 *     `ExtractionWorker` had successfully embedded them on
 *     write); the rest ship with `embedding IS NULL` (simulating
 *     pre-backfill or on-write-embed-failure rows).
 *   - A first {@link createBackfillWorker} wired with a
 *     deterministic fake embedder that returns the same vector
 *     for the same input (Req 17.3 / Property 5). The worker is
 *     started, awaited to idle, and the DB state is captured.
 *   - A second {@link createBackfillWorker} wired with a
 *     *separate* deterministic embedder whose `embed` spy starts
 *     fresh. The worker is started, awaited to idle, and the DB
 *     state is captured again.
 *
 * Per-run assertions:
 *   - `secondEmbedder.embed` has been called zero times.
 *   - The two DB states (as a `Map<record_id, embedding bytes>`)
 *     are equal — same keys, same byte sequences.
 *
 * ## Why a deterministic-by-hash embedder
 *
 * A constant-vector embedder would make the two-state equality
 * check trivial (every backfilled row has the same bytes), which
 * would mask a bug where the worker re-embedded rows with a
 * different vector on the second run. The hash-derived embedder
 * (same construction used in Properties 10 and 12) produces
 * per-input distinct vectors while still honouring the
 * within-process determinism contract — if the worker accidentally
 * re-ran embeds on the second pass, a subtle bug in the
 * `putEmbedding` UPDATE path could go undetected with a constant
 * probe but would be caught by a per-input probe whose bytes
 * differ from any pre-seeded vector.
 *
 * ## Corpus dedup and namespace pinning
 *
 * `arbitraryMemoryRecord` draws ULIDs via independent per-character
 * picks; under shrinking those picks can collapse to zero and
 * produce colliding record ids. The `dedupeCorpus` helper keeps
 * the property from tripping on a seed-time PRIMARY-KEY error.
 * The namespace is overwritten at the generator layer
 * (`arbitraryMixedCorpus`) so every record lives in the fixed
 * test namespace — backfill itself is namespace-agnostic (it
 * queries `listRecordsWithoutEmbedding(null, ...)` with no
 * namespace filter), but keeping the seeded data hermetic makes
 * the `onNamespaceChanged` wiring path — exercised once per
 * successful embed — unambiguous.
 *
 * **Validates: Requirements 19.1, 19.2, 8.6**
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Property 13 — Backfill is idempotent and does no
 *      redundant work
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md
 *      § Task 10.4
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackfillWorker } from '../../src/collector/backfill/index.js';
import type { Embedder } from '../../src/collector/embedding/index.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { MemoryRecord, StorageBackend } from '../../src/types/index.js';

import { arbitraryMixedCorpus } from '../helpers/arbitrary.js';

// ── Constants ───────────────────────────────────────────────────────────

/**
 * Shared namespace for every seeded corpus. The backfill worker's
 * `listRecordsWithoutEmbedding(null, ...)` call does not filter by
 * namespace, so a single namespace is sufficient to exercise the
 * property — and using a fixed string keeps the `onNamespaceChanged`
 * callback's argument predictable if a future test iteration wanted
 * to assert on it.
 */
const NS = '/actor/alice/project/abc/';

/**
 * `fast-check` iteration count. Task 10.4 calls for 50 runs. Each
 * iteration opens a fresh in-memory SQLite, seeds up to 10 records
 * (half with embeddings, half without), runs two backfill passes
 * end-to-end, and compares DB snapshots — well under a second per
 * iteration with the compressed worker config below.
 */
const NUM_RUNS = 50;

// ── Deterministic fake embedder ─────────────────────────────────────────

/**
 * Deterministic 32-bit FNV-1a string hash. Same construction as the
 * Property 10 and 12 tests — pure, integer-only, Node-version-stable.
 * Seeds the tiny Lehmer PRNG in {@link deterministicVector}. Kept
 * in-file rather than factored into a shared helper because the
 * three property tests that consume it each co-locate their own
 * copy for self-containment under shrinking.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic `Float32Array(384)` derived from an input string.
 * See the Property 10 TSDoc for the full rationale; in short: a
 * hash-derived per-input vector exercises the worker's
 * `embed` / `putEmbedding` / cache-invalidation path with
 * distinguishable bytes per record, which is what we need to catch
 * a regression where the second pass re-embeds rows with different
 * vectors (a constant vector would mask such a bug).
 */
function deterministicVector(input: string): Float32Array {
  const out = new Float32Array(384);
  let seed = fnv1a32(input);
  if (seed === 0) seed = 1;
  const MODULUS = 0x7fffffff;
  const MULT = 48271;
  for (let i = 0; i < 384; i++) {
    seed = (Math.imul(seed, MULT) >>> 0) % MODULUS;
    out[i] = Math.fround(seed / 0x40000000 - 1);
  }
  return out;
}

/**
 * Fake {@link Embedder} that is deterministic within a process —
 * matching the real embedder's contract (Req 17.3 / Property 5) —
 * with a Vitest spy on `embed` so the test can assert on the call
 * count. A fresh instance is constructed per worker so the two
 * workers' spies are independent; the second worker's spy must be
 * zero-call at the end of the run for the "no redundant work"
 * half of the property.
 */
function makeDeterministicEmbedder(): Embedder & {
  embed: ReturnType<typeof vi.fn>;
} {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    embed: vi.fn(async (input: string) => deterministicVector(input)),
    dim: 384 as const,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Deduplicate a mixed corpus on `record.record_id`, keeping the
 * first occurrence. Same rationale as the sibling Property 8 test:
 * under fast-check shrinking, the ULID generator can collapse
 * every record id to the literal 26-zero ULID, which
 * `storage.putMemoryRecord` would reject on the second insert.
 * Deduping keeps the property from tripping on a seed-time
 * PRIMARY-KEY error instead of the actual invariant.
 */
function dedupeCorpus(
  corpus: ReadonlyArray<{
    record: MemoryRecord;
    embedding: Float32Array | null;
  }>,
): Array<{ record: MemoryRecord; embedding: Float32Array | null }> {
  const seen = new Set<string>();
  const out: Array<{
    record: MemoryRecord;
    embedding: Float32Array | null;
  }> = [];
  for (const entry of corpus) {
    if (seen.has(entry.record.record_id)) continue;
    seen.add(entry.record.record_id);
    out.push(entry);
  }
  return out;
}

/**
 * Seed every record (and every non-null embedding) in `corpus`
 * into `storage`. This models the pre-backfill DB state: some
 * rows already have embeddings from successful on-write embeds,
 * others have `embedding IS NULL` from pre-spec inserts or
 * on-write-embed failures.
 */
async function seedCorpus(
  storage: StorageBackend,
  corpus: ReadonlyArray<{
    record: MemoryRecord;
    embedding: Float32Array | null;
  }>,
): Promise<void> {
  for (const entry of corpus) {
    await storage.putMemoryRecord(entry.record);
    if (entry.embedding !== null) {
      await storage.putEmbedding(entry.record.record_id, entry.embedding);
    }
  }
}

/**
 * Snapshot the DB's complete `{record_id, embedding bytes}`
 * mapping for a namespace. Uses the storage layer's
 * `listEmbeddings` surface — the same surface the vector cache
 * reads from in production — so any drift between what the worker
 * writes and what downstream reads see would surface as a
 * snapshot divergence.
 *
 * Represented as `Map<record_id, Buffer>` keyed on record id so
 * comparing two snapshots is `size + per-key Buffer.equals` — a
 * clean O(n) structural check that is robust to `listEmbeddings`
 * ordering (which is `created_at DESC` but could, in principle,
 * differ between calls under concurrent writes — not possible in
 * this test, but the id-keyed comparison is defensive anyway).
 */
async function snapshotEmbeddings(
  storage: StorageBackend,
  namespace: string,
): Promise<Map<string, Buffer>> {
  const rows = await storage.listEmbeddings(namespace);
  const out = new Map<string, Buffer>();
  for (const row of rows) {
    // `listEmbeddings` returns a `Float32Array` view backed by a
    // decoded BLOB. Convert to a fresh `Buffer` so the map owns
    // independent backing storage — otherwise two snapshots taken
    // before and after the second run could alias the same
    // underlying buffer and mask a mutation bug.
    out.set(
      row.record_id,
      Buffer.from(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength,
      ),
    );
  }
  return out;
}

/**
 * Assert two embedding snapshots are equal: same key set, same
 * byte sequence per key. Kept as a helper (rather than a direct
 * `expect(a).toEqual(b)`) because Vitest's deep equality on
 * `Map<string, Buffer>` does the right thing, but a targeted
 * comparison gives a counterexample that pinpoints the offending
 * `record_id` instead of dumping both full maps.
 */
function expectSnapshotsEqual(
  a: Map<string, Buffer>,
  b: Map<string, Buffer>,
): void {
  expect(a.size).toBe(b.size);
  for (const [id, bytesA] of a) {
    const bytesB = b.get(id);
    // If `b` is missing the key, `bytesB` is undefined — fail
    // loudly with both the id and the expected presence.
    expect(bytesB, `snapshot missing record_id=${id}`).toBeDefined();
    expect(
      bytesB!.equals(bytesA),
      `embedding bytes diverged for record_id=${id}`,
    ).toBe(true);
  }
}

/**
 * Poll until `predicate()` returns true or `timeoutMs` elapses.
 * Mirrors the helper in `embedding-backfill-worker.test.ts` so
 * the two tests share a lifecycle pattern. The `stepMs` is kept
 * small (5 ms) because the compressed `idleMs` in the worker
 * config (below) means state transitions happen on that same
 * cadence; a larger step would miss them.
 */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  stepMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Compressed `BackfillWorkerConfig` for tests. The production
 * defaults (`idleMs: 1000`, `circuitBreakerPauseMs: 60_000`) would
 * stretch every iteration to seconds — unacceptable at 50 runs.
 * The circuit breaker is left intact (5 failures) because the
 * deterministic embedder never fails; if a regression started
 * raising from `embed`, we still want the breaker to trip in the
 * standard way.
 */
const WORKER_CONFIG = {
  batchSize: 32,
  idleMs: 5,
  circuitBreakerFailures: 5,
  circuitBreakerPauseMs: 100,
} as const;

// ── Test-lifecycle scaffolding ──────────────────────────────────────────

let storage: StorageBackend;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  storage = openSqliteStorage({ dbPath: ':memory:' });
  // The worker writes to stderr on embed failures; the
  // deterministic embedder here never fails, but the spy keeps
  // test output clean if a future regression starts raising.
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((): boolean => true);
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

// ── Test ────────────────────────────────────────────────────────────────

describe('Feature: local-embeddings-and-hybrid-search, Property 13: Backfill is idempotent and does no redundant work', () => {
  it('a second backfill pass calls embed zero times and leaves the stored embeddings unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryMixedCorpus(NS),
        async (rawCorpus) => {
          // Fresh backend per run — `beforeEach` only runs once
          // per `it`, not per property iteration. Without this,
          // runs would contaminate each other's namespace: the
          // second iteration's "no NULL-embedding rows" state
          // would be inherited from the first, and the property
          // would assert against accumulated garbage.
          await storage.close();
          storage = openSqliteStorage({ dbPath: ':memory:' });

          const corpus = dedupeCorpus(rawCorpus);
          await seedCorpus(storage, corpus);

          // ── First pass ─────────────────────────────────────
          const firstEmbedder = makeDeterministicEmbedder();
          const firstWorker = createBackfillWorker({
            storage,
            embedder: firstEmbedder,
            config: WORKER_CONFIG,
          });

          firstWorker.start();
          // Drain the backlog. The worker returns to `idle` when
          // `listRecordsWithoutEmbedding` comes back empty; with
          // up to 10 seeded records and a 5 ms `idleMs`, 2 s is
          // comfortably enough.
          await waitFor(
            () => firstWorker.status().state === 'idle',
            2000,
          );
          expect(firstWorker.status().state).toBe('idle');

          const firstSnapshot = await snapshotEmbeddings(storage, NS);

          // Sanity: every record in the corpus now has an
          // embedding. This is implied by Property 13 via the
          // terminal-state semantics of `BackfillWorker` but we
          // make it explicit so a failure here points at the
          // underlying worker contract rather than at the
          // idempotence property itself.
          expect(firstSnapshot.size).toBe(corpus.length);

          // ── Second pass ────────────────────────────────────
          //
          // Fresh worker, fresh embedder spy. The second embedder
          // is functionally identical to the first (same
          // deterministic hash → vector mapping) so IF the worker
          // regressed and re-embedded already-embedded rows, the
          // resulting bytes would happen to match — which would
          // mask the state-convergence bug. The zero-call
          // assertion on the spy catches that case directly: the
          // worker must not invoke `embed` at all on a fully-
          // embedded corpus.
          const secondEmbedder = makeDeterministicEmbedder();
          const secondWorker = createBackfillWorker({
            storage,
            embedder: secondEmbedder,
            config: WORKER_CONFIG,
          });

          secondWorker.start();
          await waitFor(
            () => secondWorker.status().state === 'idle',
            2000,
          );
          expect(secondWorker.status().state).toBe('idle');

          const secondSnapshot = await snapshotEmbeddings(storage, NS);

          // ── Assertions ─────────────────────────────────────
          //
          // 1. No redundant embed work. The second pass starts
          //    from a fully-embedded corpus, so the first call
          //    to `listRecordsWithoutEmbedding` returns empty
          //    and the loop exits cleanly — `embed` must never
          //    fire. This is the sharpest test of Req 19.2.
          expect(secondEmbedder.embed).toHaveBeenCalledTimes(0);

          // 2. State convergence. The `(record_id, embedding
          //    bytes)` map after the second pass equals the map
          //    after the first pass — no row was dropped,
          //    re-inserted, or mutated.
          expectSnapshotsEqual(firstSnapshot, secondSnapshot);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
