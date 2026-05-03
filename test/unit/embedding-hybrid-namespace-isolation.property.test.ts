/**
 * Property-based test for hybrid-search namespace isolation and
 * size invariant.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 9: Hybrid
 * preserves namespace isolation and size invariant.
 *
 * The contract under test — copied verbatim from
 * `.kiro/specs/local-embeddings-and-hybrid-search/design.md`
 * § Property 9:
 *
 *   *For any* multi-namespace corpus, query, and limit,
 *   `QueryLayer.search(ns, q, limit)` returns a list whose length
 *   is at most `limit` and each of whose records has
 *   `record.namespace === ns`.
 *
 * This pins down the two cheapest — and most load-bearing —
 * guarantees a top-k retriever must give its caller:
 *
 *   1. **Size invariant.** The result list never exceeds `limit`,
 *      regardless of how many records match lexically, how many
 *      embeddings exist in the namespace, or how many items the
 *      vector + lexical fusion accumulates before truncation.
 *   2. **Namespace isolation.** Every returned record lives in the
 *      requested namespace. Cross-namespace leakage — via the
 *      storage query, the vector cache, or the RRF fusion — is a
 *      correctness violation even if rankings look plausible.
 *
 * Per-run setup: a fresh in-memory SQLite backend seeded with a
 * corpus of 3–15 records spread across three fixed namespaces, a
 * healthy fake {@link Embedder} that returns a random finite
 * `Float32Array(384)` as the query embedding, and a fresh
 * {@link createQueryLayer}. Using a real SQLite backend (not a
 * stub) means the lexical path exercises the same FTS5 ranker the
 * production path uses, and the vector cache exercises the real
 * `listEmbeddings` namespace filter. A divergence in either would
 * leak an out-of-namespace record or oversize the result, and the
 * property would catch it.
 *
 * Per-run assertion: `queryLayer.search(target, q, limit)` returns
 * at most `limit` records AND every record carries
 * `namespace === target`.
 *
 * **Validates: Requirements 5.4, 5.5, 16.1, 16.4**
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Property 9 — Hybrid preserves namespace isolation and size
 *      invariant
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md
 *      § Task 8.6
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Embedder } from '../../src/collector/embedding/index.js';
import { createQueryLayer } from '../../src/collector/query/index.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { MemoryRecord, StorageBackend } from '../../src/types/index.js';

import { arbitraryMemoryRecord } from '../helpers/arbitrary.js';

// ── Constants ───────────────────────────────────────────────────────────

/**
 * Three fixed namespaces spanning two distinct actors and two
 * distinct projects. Using fixed strings (rather than a fast-check
 * draw) keeps the per-run setup cheap and the assertions trivial —
 * the property under test is *namespace isolation*, not *namespace
 * string generation*, so randomising the namespaces themselves
 * would only add shrink noise. The three namespaces guarantee the
 * corpus spans the minimum "multi-namespace" the property cares
 * about (2+) while still exercising a corpus where some records
 * share an actor, some share a project, and some share neither.
 */
const NAMESPACES = [
  '/actor/alice/project/abc/',
  '/actor/alice/project/xyz/',
  '/actor/bob/project/abc/',
] as const;

/**
 * `fast-check` iteration count. Task 8.6 calls for 50 runs — each
 * iteration opens a fresh in-memory SQLite and seeds 3–15 records
 * with their embeddings, so this is sub-second total.
 */
const NUM_RUNS = 50;

// ── Fake embedder ───────────────────────────────────────────────────────

/**
 * Fake {@link Embedder} that reports ready and returns a fresh
 * finite `Float32Array(384)` on every `embed()` call. The exact
 * contents of the returned vector do not matter for this property —
 * the search is allowed to rank the corpus in any order; we only
 * assert namespace membership and size. Returning a random (but
 * finite) vector exercises the hybrid path end-to-end (query
 * embedding → cosine ranking → RRF fusion) rather than the
 * lexical-only fallback branches, which have their own dedicated
 * property test (Property 8).
 *
 * The returned vector is freshly allocated per call so tests cannot
 * observe aliasing with a prior call's buffer.
 */
function makeHealthyEmbedder(): Embedder {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    embed: vi.fn(async () => {
      const v = new Float32Array(384);
      for (let i = 0; i < 384; i++) {
        // Deterministic but distinct per slot; the value space is
        // irrelevant to this property. `Math.fround` keeps the
        // assignment loss-free for the underlying Float32Array.
        v[i] = Math.fround(Math.random() - 0.5);
      }
      return v;
    }),
    dim: 384 as const,
  };
}

// ── Generators ──────────────────────────────────────────────────────────

/**
 * Finite-only `Float32Array(384)` generator. Used for both the
 * record embeddings seeded into storage and the query vector the
 * fake embedder returns. We exclude `NaN` and `±Infinity` so cosine
 * similarity is well-defined on every pair in the index — Property
 * 9 is about namespace and size, not about how the ranker copes
 * with pathological vectors (Property 3 covers that), and allowing
 * non-finite inputs would just flatten the ranking without changing
 * the invariants under test.
 */
function finiteFloat32Array(len: number): fc.Arbitrary<Float32Array> {
  return fc
    .array(fc.float({ noNaN: true, noDefaultInfinity: true }), {
      minLength: len,
      maxLength: len,
    })
    .map((arr) => Float32Array.from(arr));
}

/**
 * Arbitrary multi-namespace corpus entry: a memory record whose
 * `namespace` has been overwritten to one of the fixed
 * {@link NAMESPACES}, paired with a finite 384-dim embedding.
 *
 * The namespace assignment draws uniformly from the three fixed
 * namespaces; with 3–15 records per run, every iteration has a
 * high probability of landing records in at least two namespaces,
 * and fast-check's shrinker is free to collapse toward the simpler
 * single-namespace corpus when that still exhibits a counterexample.
 *
 * We also dedupe on `record_id` at the corpus level (see
 * {@link dedupeCorpus}) so shrinks that collapse every ULID to the
 * literal 26-zero id do not produce a primary-key collision inside
 * `storage.putMemoryRecord`, which would mask the actual property
 * failure behind a seed-time error.
 */
function arbitraryMultiNsEntry(): fc.Arbitrary<{
  record: MemoryRecord;
  embedding: Float32Array;
}> {
  return fc
    .tuple(
      arbitraryMemoryRecord(),
      fc.constantFrom(...NAMESPACES),
      finiteFloat32Array(384),
    )
    .map(([record, ns, embedding]) => ({
      record: { ...record, namespace: ns },
      embedding,
    }));
}

/**
 * Arbitrary corpus of 3–15 entries spread across the three fixed
 * namespaces. The lower bound of 3 records is chosen so that every
 * run has a fighting chance of covering multiple namespaces even
 * under shrinking; the upper bound of 15 keeps per-iteration
 * seeding under a few tens of milliseconds.
 */
const corpusArb = fc.array(arbitraryMultiNsEntry(), {
  minLength: 3,
  maxLength: 15,
});

/**
 * Small-ish query string. Bounded at 50 chars so shrinks stay
 * readable; at least one char so the non-empty lexical branch is
 * exercised (the empty-query short-circuit has its own Property 11
 * test and would vacuously satisfy size + namespace by returning
 * `[]`, so it would not add signal here).
 */
const queryArb = fc.string({ minLength: 1, maxLength: 50 });

/**
 * Limits in `[1, 20]`. The upper bound exceeds the corpus size
 * cap (15) so we also cover the case where `limit` is larger than
 * the number of records in the requested namespace — the size
 * invariant must still hold (`result.length <= limit`), and the
 * namespace invariant must not be relaxed just because the
 * ranker could have returned more if other namespaces' records
 * were eligible.
 */
const limitArb = fc.integer({ min: 1, max: 20 });

/**
 * Target-namespace picker. Drawn independently from the corpus so
 * the target is sometimes a namespace that has many records,
 * sometimes a namespace with few, and sometimes a namespace with
 * zero records in this particular corpus (the empty-namespace case
 * is the sharpest test of isolation — a leaky implementation that
 * falls back to the full corpus would fail here).
 */
const targetNsArb = fc.constantFrom(...NAMESPACES);

// ── Corpus helpers ──────────────────────────────────────────────────────

/**
 * Deduplicate a corpus on `record.record_id`, keeping the first
 * occurrence. See the note in the task-8.5 test for why this is
 * load-bearing under fast-check shrinking: the ULID generator
 * draws indices into the Crockford base32 alphabet, and the
 * shrinker happily collapses every index to `0`, collapsing every
 * record id to the same literal 26-zero ULID. Without dedup, the
 * second `putMemoryRecord` call for that id would fail with a
 * primary-key violation and mask the actual property failure
 * (or non-failure).
 */
function dedupeCorpus(
  corpus: ReadonlyArray<{ record: MemoryRecord; embedding: Float32Array }>,
): Array<{ record: MemoryRecord; embedding: Float32Array }> {
  const seen = new Set<string>();
  const out: Array<{ record: MemoryRecord; embedding: Float32Array }> = [];
  for (const entry of corpus) {
    if (seen.has(entry.record.record_id)) continue;
    seen.add(entry.record.record_id);
    out.push(entry);
  }
  return out;
}

/**
 * Seed every record + embedding in `corpus` into `storage`. Records
 * are inserted first, then their embeddings — matching the
 * production write path (extraction worker inserts the record and
 * then, on a separate call, persists the embedding).
 */
async function seedCorpus(
  storage: StorageBackend,
  corpus: ReadonlyArray<{ record: MemoryRecord; embedding: Float32Array }>,
): Promise<void> {
  for (const entry of corpus) {
    await storage.putMemoryRecord(entry.record);
    await storage.putEmbedding(entry.record.record_id, entry.embedding);
  }
}

// ── Test-lifecycle scaffolding ──────────────────────────────────────────

let storage: StorageBackend;

beforeEach(() => {
  storage = openSqliteStorage({ dbPath: ':memory:' });
});

afterEach(async () => {
  try {
    await storage.close();
  } catch {
    // swallow — cleanup must not mask a real failure
  }
  vi.restoreAllMocks();
});

// ── Test ────────────────────────────────────────────────────────────────

describe('Feature: local-embeddings-and-hybrid-search, Property 9: Hybrid preserves namespace isolation and size invariant', () => {
  it('search(ns, q, limit) returns ≤ limit records and every record has namespace === ns', async () => {
    await fc.assert(
      fc.asyncProperty(
        corpusArb,
        targetNsArb,
        queryArb,
        limitArb,
        async (rawCorpus, targetNs, query, limit) => {
          // Fresh backend per run — `beforeEach` only runs once
          // per `it`, not per property iteration. Without this,
          // runs would contaminate each other's namespaces and a
          // late iteration could see records seeded by an earlier
          // one.
          await storage.close();
          storage = openSqliteStorage({ dbPath: ':memory:' });

          const corpus = dedupeCorpus(rawCorpus);
          await seedCorpus(storage, corpus);

          const embedder = makeHealthyEmbedder();
          const queryLayer = createQueryLayer({ storage, embedder });

          const results = await queryLayer.search(targetNs, query, limit);

          // Size invariant — the result list never exceeds
          // `limit`, regardless of how many records across all
          // namespaces match lexically or semantically.
          expect(results.length).toBeLessThanOrEqual(limit);

          // Namespace invariant — every returned record lives in
          // the requested namespace. A leaky implementation (e.g.
          // a missing `WHERE namespace = ?` on the storage path,
          // or a vector cache that aggregates across namespaces)
          // would surface here.
          for (const record of results) {
            expect(record.namespace).toBe(targetNs);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
