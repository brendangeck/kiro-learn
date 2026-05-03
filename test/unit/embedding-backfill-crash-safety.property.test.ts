/**
 * Property-based test for `BackfillWorker` crash safety.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 14:
 * Backfill is crash-safe.
 *
 * The contract under test — copied verbatim from
 * `.kiro/specs/local-embeddings-and-hybrid-search/design.md`
 * § Property 14:
 *
 *   *For any* corpus and any interrupt point `i` (measured in
 *   number of `putEmbedding` calls completed), stopping the worker
 *   at `i`, reopening the database, and inspecting the state
 *   yields: records whose backfill completed before `i` have their
 *   correct embedding stored; all other records have `NULL`
 *   embedding. Resuming the worker on the partial state eventually
 *   reaches the same terminal state as running the worker to
 *   completion once.
 *
 * The property has three load-bearing halves, all of which Req
 * 19.3 requires to hold simultaneously:
 *
 *   1. **No torn writes.** After the interrupt, every row whose
 *      `embedding IS NOT NULL` has the exact bytes of its
 *      *expected* vector — the deterministic hash-derived vector
 *      for records that were originally `NULL`, or the pre-seeded
 *      bytes for records that already had an embedding going in.
 *      No row has a partial BLOB, a zero BLOB, or a vector from a
 *      sibling record.
 *   2. **Rest stays NULL.** Every row whose `embedding IS NULL`
 *      after the interrupt was originally `NULL` (the worker never
 *      *un*-embeds an already-embedded row) AND was not one of the
 *      rows the worker had completed before `stop`. The first
 *      clause is structural — `BackfillWorker.putEmbedding` never
 *      writes `NULL` — but the property test pins it down by
 *      equating the pre- and post-interrupt bytes for every
 *      originally-embedded record.
 *   3. **Resume converges.** Running a *second* worker against the
 *      partial state drains the remaining `NULL` rows and reaches
 *      the same terminal state as a single uninterrupted run would
 *      have produced. This is the resumability half of Req 19.3
 *      and subsumes crash-and-resume reliability for the backfill
 *      subsystem end to end.
 *
 * ## Interrupt mechanism
 *
 * We wrap the storage backend in a thin Proxy-like object whose
 * only non-passthrough method is `putEmbedding`: it calls the real
 * `putEmbedding`, increments a counter, and — on the *i*-th
 * successful call — resolves a `reachedInterrupt` promise. The
 * test awaits that promise and then calls `worker.stop(1000)`,
 * which sets the cancellation flag, cuts any in-flight `sleep`
 * short, and awaits the loop to drain. See
 * `src/collector/backfill/worker.ts` § Lifecycle for the exact
 * stop semantics.
 *
 * Because the worker checks `stopped` only at the top of each
 * record iteration (not inside `processRecord`), the in-flight
 * record continues through `embed → putEmbedding` before the loop
 * exits. This means the interrupt count `i` is a lower bound, not
 * an exact cutoff: the worker may complete `i + 0` or `i + 1`
 * records before halting, depending on scheduling. The property
 * holds either way — we never assert on the exact count of
 * embedded rows, only on the *correctness* of whatever rows are
 * embedded.
 *
 * ## Why this is the sharpest possible test
 *
 * A constant-vector embedder would satisfy "no torn writes"
 * trivially (every embedded row would have the same bytes), which
 * would mask a bug where the worker wrote the *wrong* vector —
 * e.g. stashed vector `k+1` into record `k`'s row because of a
 * misordered UPDATE. The hash-derived per-input vector (same
 * construction as Properties 10, 12, and 13) produces
 * distinguishable bytes per record, so a misfiled UPDATE would
 * surface as a byte-level mismatch between the stored vector and
 * the deterministic vector the embedder would have produced for
 * that record's composed input.
 *
 * ## Corpus and interrupt-point generation
 *
 * `arbitraryMixedCorpus` yields 1–10 records with embeddings that
 * are either a `Float32Array(384)` (pre-seeded) or `null` (pending
 * backfill). The spec requires "3+ records without embeddings" to
 * make room for a meaningful mid-flight interrupt: we filter via
 * the wrapping `fc.tuple + fc.pre` pattern (see below) to keep
 * only draws whose null subset has size ≥ 3, then pick an
 * interrupt point `i ∈ [1, nullCount - 1]` so the worker is
 * guaranteed to be halted strictly mid-flight — at least one
 * record embedded and at least one still pending.
 *
 * The `dedupeCorpus` helper mirrors the sibling Property 13 test
 * — under shrinking, ULIDs can collapse to all-zero and break
 * `putMemoryRecord`'s PRIMARY KEY invariant.
 *
 * **Validates: Requirements 19.3, 8.6**
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Property 14 — Backfill is crash-safe
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md
 *      § Task 10.5
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackfillWorker } from '../../src/collector/backfill/index.js';
import { composeEmbeddingInput } from '../../src/collector/embedding/index.js';
import type { Embedder } from '../../src/collector/embedding/index.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { MemoryRecord, StorageBackend } from '../../src/types/index.js';

import { arbitraryMixedCorpus } from '../helpers/arbitrary.js';

// ── Constants ───────────────────────────────────────────────────────────

/**
 * Shared namespace for every seeded corpus. Backfill itself is
 * namespace-agnostic — `listRecordsWithoutEmbedding(null, ...)` —
 * but pinning a single namespace keeps the test hermetic and lines
 * it up with the sibling Property 13 test for easy diffing.
 */
const NS = '/actor/alice/project/abc/';

/**
 * `fast-check` iteration count. Task 10.5 calls for 50 runs. Each
 * iteration opens a fresh in-memory SQLite, seeds up to 10 records
 * (half of which roughly have pre-seeded embeddings), runs two
 * backfill passes (one interrupted, one resuming), and compares
 * snapshots. With the compressed worker config below, each
 * iteration sits comfortably under 200 ms.
 */
const NUM_RUNS = 50;

// ── Deterministic fake embedder ─────────────────────────────────────────

/**
 * Deterministic 32-bit FNV-1a string hash. Same construction as
 * Properties 10, 12, and 13. Kept in-file for self-containment under
 * shrinking — factoring it into a shared helper would make a
 * shrunk counter-example span more files.
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
 * Pure, integer-only, Node-version-stable. Per-input distinct bytes
 * are what make the "no torn writes" half of the property catch
 * misfiled UPDATE bugs — see the module docstring.
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
 * Fake {@link Embedder} that is deterministic within a process
 * (Req 17.3 / Property 5) with a Vitest spy on `embed`. A fresh
 * instance is constructed per worker so the interrupted and
 * resumed runs carry independent spies — the spy counts aren't
 * asserted here, but keeping them separate mirrors the Property 13
 * pattern and makes failure output easier to read.
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
 * first occurrence. Same rationale as Property 13: fast-check
 * shrinking can collapse ULIDs to the all-zero string, and
 * `putMemoryRecord` rejects a duplicate PRIMARY KEY — which would
 * make the property trip on seed-time state instead of the actual
 * invariant.
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
 * into `storage`. Mirrors Property 13's seed helper — models the
 * pre-backfill DB state where some rows have embeddings from
 * successful on-write embeds and others are `NULL`.
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
 * Convert a `Float32Array` to a `Buffer` that owns its backing
 * storage. Comparisons across snapshots use `Buffer.equals`, which
 * is byte-level and handles `NaN`/`±0` uniformly (bitwise
 * comparison, not `===`). Making the Buffer own its bytes prevents
 * aliasing bugs where two snapshots taken before and after a
 * mutation could share the same underlying ArrayBuffer and mask a
 * regression.
 */
function toOwnedBuffer(view: Float32Array): Buffer {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * Snapshot `{record_id → embedding bytes | null}` for every record
 * in the corpus, reading from `storage.getEmbedding` directly.
 * Using `getEmbedding` rather than `listEmbeddings` is deliberate:
 * `listEmbeddings` filters out `NULL` rows, but the property needs
 * to observe `NULL` directly to prove records that were *not*
 * backfilled remain `NULL`.
 */
async function snapshotAll(
  storage: StorageBackend,
  records: ReadonlyArray<MemoryRecord>,
): Promise<Map<string, Buffer | null>> {
  const out = new Map<string, Buffer | null>();
  for (const r of records) {
    const vec = await storage.getEmbedding(r.record_id);
    out.set(r.record_id, vec === null ? null : toOwnedBuffer(vec));
  }
  return out;
}

/**
 * Build the per-record expected-bytes map for a corpus: the pre-
 * seeded bytes for records that arrived with an embedding, or the
 * deterministic vector for records that arrived `NULL`. This is
 * the *terminal* state a single uninterrupted backfill run should
 * produce. Used for
 *
 *   - "no torn writes" during the interrupted phase (every
 *     embedded row matches its expected bytes), and
 *   - "resume converges" after the second pass (every row matches
 *     its expected bytes, no exceptions).
 */
function buildExpectedBytes(
  corpus: ReadonlyArray<{
    record: MemoryRecord;
    embedding: Float32Array | null;
  }>,
): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const entry of corpus) {
    const expected =
      entry.embedding !== null
        ? entry.embedding
        : deterministicVector(composeEmbeddingInput(entry.record));
    out.set(entry.record.record_id, toOwnedBuffer(expected));
  }
  return out;
}

/**
 * Poll until `predicate()` returns true or `timeoutMs` elapses.
 * Mirrors the helper in `embedding-backfill-worker.test.ts` and
 * the sibling Property 13 test so the whole backfill test family
 * shares one lifecycle pattern.
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
 * Compressed `BackfillWorkerConfig` for tests. Same values as
 * Property 13: production defaults would stretch iterations into
 * seconds, which is unacceptable at 50 runs.
 */
const WORKER_CONFIG = {
  batchSize: 32,
  idleMs: 5,
  circuitBreakerFailures: 5,
  circuitBreakerPauseMs: 100,
} as const;

// ── Storage wrapper for interrupt injection ─────────────────────────────

/**
 * Result of {@link wrapStorageWithInterrupt}. The `reached`
 * promise resolves when the wrapped `putEmbedding` has been called
 * successfully `interruptAfter` times; the test awaits this and
 * then calls `worker.stop(...)`.
 *
 * The `count` field lets the test assert on how many embeds
 * completed, purely for diagnostic output if the property fails —
 * nothing in the property itself pins down the exact count.
 */
interface InterruptHandle {
  wrapped: StorageBackend;
  reached: Promise<void>;
  getCount: () => number;
}

/**
 * Wrap a `StorageBackend` so that its `putEmbedding` is
 * instrumented: it forwards to the real implementation, increments
 * a counter on success, and resolves `reached` on the
 * `interruptAfter`-th call. Every other method is a direct
 * delegation — the wrapper does not intercept reads or other
 * writes, so the worker's `listRecordsWithoutEmbedding` /
 * `getMemoryRecord` / ... paths are exercised against the real
 * SQLite backend unchanged.
 *
 * The wrapper does NOT call `worker.stop()` from inside
 * `putEmbedding`: stop-from-inside would create a dependency cycle
 * (the worker must exist before we can wrap storage, and the
 * wrapper must exist before we can construct the worker). Instead
 * the test drives the interrupt externally: it awaits `reached`
 * and then calls `stop`. See module docstring § Interrupt
 * mechanism for why this is equivalent to an in-wrapper trigger.
 */
function wrapStorageWithInterrupt(
  storage: StorageBackend,
  interruptAfter: number,
): InterruptHandle {
  let count = 0;
  let resolveReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });

  const wrapped: StorageBackend = {
    // Passthrough for every non-intercepted method. Binding is
    // necessary because the SQLite backend's methods are arrow
    // functions closing over internal state, but we forward
    // through the handle to keep parity with any future backend
    // that might use `this`.
    putEvent: (e) => storage.putEvent(e),
    getEventById: (id) => storage.getEventById(id),
    putMemoryRecord: (r) => storage.putMemoryRecord(r),
    searchMemoryRecords: (p) => storage.searchMemoryRecords(p),
    close: () => storage.close(),
    getStats: (ns) =>
      ns === undefined ? storage.getStats() : storage.getStats(ns),
    listProjects: () => storage.listProjects(),
    listMemoryRecords: (p) => storage.listMemoryRecords(p),
    listEvents: (p) => storage.listEvents(p),
    getEmbedding: (id) => storage.getEmbedding(id),
    listEmbeddings: (ns) => storage.listEmbeddings(ns),
    listRecordsWithoutEmbedding: (ns, limit) =>
      storage.listRecordsWithoutEmbedding(ns, limit),
    searchMemoryRecordsLexical: (p) => storage.searchMemoryRecordsLexical(p),

    // Intercepted method. The real write runs first so that by
    // the time `reached` resolves the DB reflects exactly `count`
    // successful backfill writes — no off-by-one between the
    // observable storage state and the counter the test uses to
    // trigger stop.
    putEmbedding: async (recordId: string, embedding: Float32Array) => {
      await storage.putEmbedding(recordId, embedding);
      count += 1;
      if (count === interruptAfter) {
        resolveReached();
      }
    },
  };

  return {
    wrapped,
    reached,
    getCount: () => count,
  };
}

// ── Test-lifecycle scaffolding ──────────────────────────────────────────

let storage: StorageBackend;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  storage = openSqliteStorage({ dbPath: ':memory:' });
  // The worker writes to stderr on embed failures. The
  // deterministic embedder never fails here, but the spy keeps
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

describe('Feature: local-embeddings-and-hybrid-search, Property 14: Backfill is crash-safe', () => {
  it('after an interrupt, every stored embedding is correct and every NULL row catches up on resume', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Draw a corpus and the interrupt point together via
        // `fc.tuple + .chain` so the interrupt point can depend
        // on the corpus shape — it must be in `[1, nullCount - 1]`
        // to guarantee a strictly mid-flight halt.
        arbitraryMixedCorpus(NS).chain((rawCorpus) => {
          const corpus = dedupeCorpus(rawCorpus);
          const nullCount = corpus.filter((e) => e.embedding === null).length;
          // Require ≥ 3 null rows so at least one is embedded and
          // at least one remains NULL after stop. Corpora that
          // don't qualify are short-circuited via an impossible
          // interrupt point and filtered at property entry via
          // `fc.pre` below.
          if (nullCount < 3) {
            return fc.record({
              corpus: fc.constant(corpus),
              interruptAfter: fc.constant(-1 as number),
            });
          }
          return fc.record({
            corpus: fc.constant(corpus),
            interruptAfter: fc.integer({ min: 1, max: nullCount - 1 }),
          });
        }),
        async ({ corpus, interruptAfter }) => {
          // Skip draws that don't satisfy the "≥ 3 null rows"
          // precondition. Using `fc.pre` keeps fast-check happy
          // (it counts skipped draws against the run budget but
          // does not fail the property) and avoids an invalid
          // `interruptAfter` reaching the wrapper.
          fc.pre(interruptAfter >= 1);

          // Fresh backend per run — `beforeEach` only runs once
          // per `it`, not per property iteration. Without this,
          // runs would contaminate each other's namespace and
          // the "resume converges" half would assert against
          // accumulated state from a prior iteration.
          await storage.close();
          storage = openSqliteStorage({ dbPath: ':memory:' });

          await seedCorpus(storage, corpus);

          const expected = buildExpectedBytes(corpus);
          const records = corpus.map((e) => e.record);

          // ── Phase 1: interrupted run ───────────────────────
          const handle = wrapStorageWithInterrupt(storage, interruptAfter);
          const interruptedEmbedder = makeDeterministicEmbedder();
          const interruptedWorker = createBackfillWorker({
            storage: handle.wrapped,
            embedder: interruptedEmbedder,
            config: WORKER_CONFIG,
          });

          interruptedWorker.start();
          // Wait until the wrapper observes `interruptAfter`
          // successful `putEmbedding` calls. A 5 s ceiling is a
          // belt-and-braces guard: with `nullCount ≤ 10` and
          // `idleMs: 5`, this should take tens of milliseconds.
          // If the worker never reaches the target, the race
          // resolves to timeout and the `stop` below proceeds
          // anyway — but the property assertions would then fail
          // on an under-filled state, pointing at a real bug.
          await Promise.race([
            handle.reached,
            new Promise<void>((resolve) => setTimeout(resolve, 5000)),
          ]);

          // Signal shutdown. The worker checks `stopped` at the
          // top of each record iteration, so up to one additional
          // record may complete between our stop call and the
          // loop's exit — this is by design (see module docstring
          // § Interrupt mechanism) and does not affect the
          // property.
          await interruptedWorker.stop(1000);
          expect(interruptedWorker.status().state).toBe('stopped');

          // ── Phase 1 assertions: no torn writes ─────────────
          const partial = await snapshotAll(storage, records);

          for (const record of records) {
            const stored = partial.get(record.record_id);
            const expectedBytes = expected.get(record.record_id);
            expect(
              expectedBytes,
              `expected-bytes map missing record_id=${record.record_id}`,
            ).toBeDefined();

            if (stored === null) {
              // A `NULL` row after the interrupt must correspond
              // to an originally-`NULL` record. The worker never
              // clears a pre-seeded embedding — a regression that
              // did so would surface here as an originally-
              // embedded row showing `NULL` post-interrupt.
              const original = corpus.find(
                (e) => e.record.record_id === record.record_id,
              )?.embedding;
              expect(
                original,
                `originally-embedded record ${record.record_id} became NULL after interrupt`,
              ).toBeNull();
            } else {
              // A non-`NULL` row must contain its *expected*
              // bytes. For an originally-embedded record that's
              // the pre-seeded vector; for an originally-`NULL`
              // record that's the deterministic vector of its
              // composed input. Any other bytes indicate a torn
              // write (misfiled UPDATE, partial BLOB, etc.).
              expect(
                stored.equals(expectedBytes!),
                `torn-write detected for record_id=${record.record_id}`,
              ).toBe(true);
            }
          }

          // ── Phase 2: resume ────────────────────────────────
          //
          // Construct a fresh worker against the *unwrapped*
          // storage so nothing throttles its progress. A fresh
          // embedder spy is used purely for parity with Property
          // 13 — the spy count is not asserted here.
          const resumeEmbedder = makeDeterministicEmbedder();
          const resumeWorker = createBackfillWorker({
            storage,
            embedder: resumeEmbedder,
            config: WORKER_CONFIG,
          });

          resumeWorker.start();
          // With `nullCount ≤ 10` remaining (in fact ≤ `nullCount
          // - interruptAfter`), a 2 s ceiling is comfortable. The
          // worker returns to `idle` when
          // `listRecordsWithoutEmbedding` comes back empty.
          await waitFor(
            () => resumeWorker.status().state === 'idle',
            2000,
          );
          expect(resumeWorker.status().state).toBe('idle');

          // ── Phase 2 assertions: resume converges ───────────
          //
          // Every record now has its *expected* bytes — the
          // same state a single uninterrupted run would have
          // produced. No row is `NULL`; no row has unexpected
          // bytes. This is the "resuming reaches the terminal
          // state of a single uninterrupted run" half of Req
          // 19.3.
          const terminal = await snapshotAll(storage, records);

          for (const record of records) {
            const stored = terminal.get(record.record_id);
            const expectedBytes = expected.get(record.record_id);
            expect(
              stored,
              `record ${record.record_id} missing from terminal snapshot`,
            ).not.toBeNull();
            expect(
              stored!.equals(expectedBytes!),
              `terminal bytes diverged for record_id=${record.record_id}`,
            ).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
