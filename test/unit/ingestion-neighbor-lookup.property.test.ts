/**
 * Property test for `QueryLayer.lookupNeighbors`
 * (reconciliation-engine task 3.3 — Property 9).
 *
 * **Property 9: Neighbor lookup filters correctly**
 *
 * For any set of existing memory records and any centroid,
 * threshold, and cap, the output of `lookupNeighbors(ns, centroid,
 * τ, cap)` MUST satisfy four clauses simultaneously:
 *
 *   1. Every returned record has `namespace === ns`.
 *   2. Every returned record has cosine similarity ≥ τ against the
 *      centroid.
 *   3. Output length is ≤ cap.
 *   4. Output is sorted by similarity in descending order.
 *
 * These four clauses together specify the reconciler's contract
 * for neighbor pool construction (Requirements 5.1, 5.2, 5.3, 5.4
 * in `.kiro/specs/reconciliation-engine/requirements.md`).
 *
 * ## Test design
 *
 * - Each iteration uses a fresh in-memory SQLite backend so the
 *   cache starts empty; no cross-iteration state can mask a bug.
 * - Each iteration uses a freshly-drawn namespace so the `QueryLayer`'s
 *   per-namespace vector-index cache cannot leak across runs.
 *   (The `QueryLayer` keeps one cache per namespace for the life
 *   of its instance; a fresh `QueryLayer` per iteration would
 *   also work, but per-namespace isolation is cheaper and just
 *   as correct.)
 * - Records are drawn via `arbitraryMemoryRecord` and stamped with
 *   the iteration's namespace so the corpus is hermetic.
 * - Embeddings are drawn in `[-1, 1]` (via the same well-behaved
 *   distribution `arbitraryCandidateEmbedding` uses) so cosine
 *   similarity is always a real number in `[-1, 1]` — no NaN
 *   surprises.
 * - The threshold is drawn in `[0, 1]` and the cap in `[1, 50]`
 *   per the task description.
 * - After each run we `storage.close()` to release the in-memory
 *   database.
 *
 * Cleanup sits in a `try/finally` so a failing iteration still
 * closes the handle — a regression here would leak in-memory
 * databases across the 100 runs.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 3.3
 * @see .kiro/specs/reconciliation-engine/design.md § Correctness Properties — Property 9
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 5.1, 5.2, 5.3, 5.4
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cosine, normalize } from '../../src/collector/embedding/index.js';
import { createQueryLayer } from '../../src/collector/query/index.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { MemoryRecord, StorageBackend } from '../../src/types/index.js';

import { arbitraryMemoryRecord, namespaceArb } from '../helpers/arbitrary.js';

// ── Generators ──────────────────────────────────────────────────────────

/**
 * 384-dim `Float32Array` with values in `[-1, 1]`. Finite values only
 * — no NaN, no ±Infinity — so cosine similarity is always a real
 * number and the sort / threshold assertions are meaningful.
 *
 * Reconciler inputs (centroid, record embeddings) are all normalised
 * vectors in practice, but `lookupNeighbors` accepts raw Float32Array
 * and computes cosine directly, so we do not force unit norm here.
 * Property 9 is a statement about the filter/sort/cap contract, not
 * about the input-vector distribution.
 */
function arbitraryCentroidLike(): fc.Arbitrary<Float32Array> {
  return fc
    .array(
      fc.float({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }),
      { minLength: 384, maxLength: 384 },
    )
    .map((arr) => Float32Array.from(arr));
}

// ── Property ────────────────────────────────────────────────────────────

describe('Property 9: lookupNeighbors filters correctly', () => {
  it(
    'every returned record is in-namespace, above threshold, and output is sorted and capped',
    async () => {
      /**
       * **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
       *
       * For any set of 1–20 memory records seeded in a single
       * namespace, any centroid drawn from a 384-dim Float32Array,
       * any threshold in `[0, 1]`, and any cap in `[1, 50]`: the
       * output of `lookupNeighbors(ns, centroid, τ, cap)` satisfies
       * the four clauses declared above.
       */
      await fc.assert(
        fc.asyncProperty(
          namespaceArb(),
          fc.array(arbitraryMemoryRecord(), { minLength: 1, maxLength: 20 }),
          arbitraryCentroidLike(),
          fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
          fc.integer({ min: 1, max: 50 }),
          async (namespace, rawRecords, centroid, threshold, cap) => {
            const storage: StorageBackend = openSqliteStorage({
              dbPath: ':memory:',
            });
            try {
              // Dedupe by record_id and stamp every record into the
              // iteration's namespace so the corpus is hermetic.
              // Duplicates would cause `putMemoryRecord` to throw;
              // the generator doesn't guarantee uniqueness.
              const seen = new Set<string>();
              const records: MemoryRecord[] = [];
              for (const r of rawRecords) {
                if (seen.has(r.record_id)) continue;
                seen.add(r.record_id);
                records.push({ ...r, namespace });
              }

              // Seed a deterministic embedding per record. We derive
              // it from the record id so the property's counterexample
              // output is reproducible when fast-check shrinks —
              // every identical `{records, centroid, threshold, cap}`
              // tuple produces the same embeddings.
              //
              // The embedding distribution does not matter for
              // Property 9; what matters is that the seeded vector
              // ends up in the cache so `lookupNeighbors` has
              // something to score.
              for (const record of records) {
                await storage.putMemoryRecord(record);
                const vec = makeDeterministicEmbedding(record.record_id);
                await storage.putEmbedding(record.record_id, vec);
              }

              const queryLayer = createQueryLayer({ storage, embedder: null });
              const hits = await queryLayer.lookupNeighbors(
                namespace,
                centroid,
                threshold,
                cap,
              );

              // Clause 3: output length ≤ cap.
              expect(hits.length).toBeLessThanOrEqual(cap);

              // Clause 1: every returned record lives in `namespace`.
              for (const hit of hits) {
                expect(hit.record.namespace).toBe(namespace);
              }

              // Clause 2: every returned record has similarity ≥ τ.
              //
              // We re-compute cosine against the SAME normalised
              // embedding the cache would have produced (the cache
              // normalises once on load; `lookupNeighbors` scores
              // against `vec_normalised`). Recomputing here
              // ensures we are asserting the same similarity the
              // function returned — any mismatch would be the test's
              // fault, not the implementation's.
              for (const hit of hits) {
                const rawVec = makeDeterministicEmbedding(hit.record.record_id);
                const normalised = normalize(rawVec);
                const expected = cosine(centroid, normalised);
                // Assertion on the returned `similarity` field: it
                // must be ≥ threshold AND equal (to within fp
                // tolerance) the independently-computed value.
                expect(hit.similarity).toBeGreaterThanOrEqual(threshold);
                expect(hit.similarity).toBeCloseTo(expected, 5);
              }

              // Clause 4: output is sorted by similarity DESC.
              for (let i = 1; i < hits.length; i += 1) {
                const prev = hits[i - 1];
                const curr = hits[i];
                if (prev === undefined || curr === undefined) {
                  // Unreachable: the loop bounds guarantee both
                  // indices are defined. The branch is here to
                  // satisfy `noUncheckedIndexedAccess`.
                  throw new Error('unreachable');
                }
                expect(prev.similarity).toBeGreaterThanOrEqual(curr.similarity);
              }
            } finally {
              try {
                await storage.close();
              } catch {
                // swallow — cleanup must not mask a real failure
              }
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Produce a deterministic 384-dim Float32Array from a record id. The
 * same id always produces the same vector; different ids produce
 * vectors that are not trivially identical (the hash-derived seed
 * bits across the 384 dimensions make accidental collisions
 * unlikely).
 *
 * Values are bounded in `[-1, 1]` so the produced vector is a
 * plausible embedding and cosine similarity against the centroid
 * stays a real number in `[-1, 1]`.
 *
 * This is NOT a cryptographic PRNG — it is a deterministic mapping
 * for test reproducibility. The exact distribution does not matter
 * for Property 9; every record just needs a stable, non-degenerate
 * embedding.
 */
function makeDeterministicEmbedding(recordId: string): Float32Array {
  const vec = new Float32Array(384);
  // Seed an xorshift-style state from the record id so the sequence
  // is deterministic but different ids produce different sequences.
  let state = 0x9e3779b9;
  for (let i = 0; i < recordId.length; i += 1) {
    state = (state ^ recordId.charCodeAt(i)) * 0x01000193;
    state = state >>> 0;
  }
  for (let i = 0; i < 384; i += 1) {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    // Map to [-1, 1].
    vec[i] = (state / 0xffffffff) * 2 - 1;
  }
  return vec;
}
