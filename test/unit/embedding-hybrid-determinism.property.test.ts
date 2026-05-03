/**
 * Property-based test for hybrid-search determinism.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 10: Hybrid
 * is deterministic.
 *
 * The contract under test — copied verbatim from
 * `.kiro/specs/local-embeddings-and-hybrid-search/design.md`
 * § Property 10:
 *
 *   *For any* corpus, query, and limit, two sequential calls to
 *   `QueryLayer.search(ns, q, limit)` against the same corpus
 *   produce identical ordered result lists (including the
 *   tie-break by `created_at DESC, record_id ASC`).
 *
 * This property is the observable consequence of two implementation
 * contracts:
 *
 *   1. **Deterministic ranking.** The fused-score sort in
 *      `QueryLayer.search` uses the richer tie-break
 *      `(fused_score DESC, created_at DESC, record_id ASC)`
 *      (Req 5.8). As long as the embedder returns the same vector
 *      for the same query within a process (Req 17.3 / Property 5)
 *      and the storage layer returns the same lexical ranking for
 *      identical inputs (FTS5 with a stable ranker), the final
 *      ordering is a pure function of its inputs.
 *   2. **No hidden state.** Neither the vector cache's `getOrLoad`
 *      nor RRF fusion injects randomness or wall-clock sensitivity.
 *      A second call reading the same cached index with the same
 *      query vector must produce the same top-k — if it does not,
 *      the tie-break is missing a determinising axis (e.g. a
 *      `Map` iteration that loses insertion order on some runtime,
 *      or a comparator that treats NaN/undefined scores as a
 *      cyclic relation).
 *
 * The property is intentionally narrow: it only compares two
 * sequential calls within the *same* `QueryLayer` instance, with
 * the same underlying SQLite backend. It does not claim
 * cross-process determinism (different FTS5 builds, different
 * `@huggingface/transformers` versions, etc. would all legitimately
 * break that), and it does not claim determinism across cache
 * invalidations. Those stronger claims are neither required by
 * Req 16.2 nor testable in isolation.
 *
 * Per-run setup: a fresh in-memory SQLite backend seeded with a
 * corpus of 1–15 records in a fixed namespace, a deterministic
 * fake {@link Embedder} that derives its output vector from a
 * hash of the input string, and a fresh {@link createQueryLayer}.
 * The deterministic-by-hash embedder exercises a richer vector-rank
 * path than a constant vector would (which would collapse every
 * cosine score to the same value and trivialise the vector
 * ranking), while still honouring the within-process determinism
 * the real embedder provides (Req 17.3 / Property 5). Using a real
 * SQLite backend (not a stub) means the lexical path exercises the
 * same FTS5 ranker the production path uses — any non-determinism
 * from the FTS5 layer or the RRF fusion would surface as a
 * counterexample here.
 *
 * Per-run assertion: `search(NS, q, limit)` is called twice back
 * to back, and the two returned lists are structurally equal
 * (same length, same `record_id`s in the same order, same record
 * contents in the same order). Comparing whole records rather
 * than just ids catches a class of bug where the record payload
 * is stable but a ranking-adjacent field — e.g. `created_at`
 * after a fractional-second round-trip — diverges between calls.
 *
 * **Validates: Requirements 5.8, 16.2**
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Property 10 — Hybrid is deterministic
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md
 *      § Task 8.7
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
 * Single fixed namespace for the seeded corpus. Determinism is an
 * intra-namespace property — multi-namespace isolation is handled
 * separately by Property 9. A fixed string keeps setup cheap and
 * assertions trivial; the property under test is that the *order*
 * is stable, not that the namespace string generator is exercised.
 */
const NS = '/actor/alice/project/abc/';

/**
 * `fast-check` iteration count. Task 8.7 calls for 50 runs. Each
 * iteration seeds a fresh in-memory SQLite with up to 15 records
 * plus their 1536-byte embedding blobs, then runs `search` twice —
 * sub-second total.
 */
const NUM_RUNS = 50;

// ── Deterministic fake embedder ─────────────────────────────────────────

/**
 * Deterministic string hash for vector derivation. A minimal FNV-1a
 * 32-bit walk: `h = (h ^ byte) * FNV_PRIME`, mod 2^32. Chosen
 * because it is:
 *
 *   - pure (no global state, no floating-point rounding),
 *   - stable across Node versions (integer-only, no locale),
 *   - trivially inspectable in a counterexample,
 *   - cheap enough to run 384 times per embed call without
 *     bottlenecking the property loop.
 *
 * We emphatically do NOT need cryptographic strength — we need a
 * deterministic, input-sensitive seed that gives different queries
 * different vectors so the vector ranking is non-trivial across
 * iterations while still satisfying Req 17.3's
 * "same-input-same-output" contract.
 *
 * The returned value is a uint32 that the caller uses to seed a
 * tiny Lehmer PRNG (see {@link deterministicVector}).
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Multiply by FNV prime and coerce back to uint32. The
    // `Math.imul` keeps the multiplication inside JavaScript's
    // 32-bit integer semantics without overflowing into a double.
    hash = Math.imul(hash, 0x01000193);
  }
  // Normalise to a non-negative uint32 so downstream arithmetic
  // stays in the integer register file.
  return hash >>> 0;
}

/**
 * Deterministic `Float32Array(384)` derived from an input string.
 *
 * The input string is hashed (see {@link fnv1a32}) and the hash
 * seeds a Lehmer PRNG (`seed = (seed * 48271) mod (2^31 - 1)`),
 * whose 31-bit output is mapped to `[-1, 1)` per slot via
 * `(v / 2^30) - 1`. The result is a pseudo-random but perfectly
 * deterministic unit-less vector.
 *
 * Why hash-derived rather than a constant vector? Because a
 * constant vector would produce the same cosine similarity against
 * every record in the index (they would all evaluate to the same
 * dot product with the normalised record vector of a given
 * direction — but since record vectors vary, the cosines would
 * differ, so strike that — a constant vector is still a valid
 * probe). The real reason is that a *query-dependent* vector lets
 * the vector-ranking path produce a genuinely different top-k per
 * iteration, which stresses the RRF fusion and the final
 * `(fused_score, created_at, record_id)` tie-break far more than
 * a constant probe would. Constant-vector probes are covered by
 * Property 11 (empty-query short-circuit) implicitly — there is no
 * benefit to re-running that path here.
 */
function deterministicVector(input: string): Float32Array {
  const out = new Float32Array(384);
  let seed = fnv1a32(input);
  // Guard against the Lehmer PRNG's fixed point at 0 — if the
  // hash happened to produce 0 we would emit 384 copies of 0 and
  // the vector would have zero norm, which `cosine` explicitly
  // short-circuits to 0. That would not break determinism, but it
  // would make the iteration a no-op on the vector path. Bumping
  // the seed by 1 avoids the degenerate state for essentially no
  // cost.
  if (seed === 0) seed = 1;
  const MODULUS = 0x7fffffff; // 2^31 - 1
  const MULT = 48271;
  for (let i = 0; i < 384; i++) {
    seed = (Math.imul(seed, MULT) >>> 0) % MODULUS;
    // Map [0, 2^31 - 1) to [-1, 1). `Math.fround` keeps the
    // resulting number representable exactly in Float32 so
    // repeated calls with the same seed return bit-identical
    // arrays.
    out[i] = Math.fround(seed / 0x40000000 - 1);
  }
  return out;
}

/**
 * Fake {@link Embedder} that is deterministic within a process —
 * matching the real embedder's contract (Req 17.3 / Property 5) —
 * and cheap enough to call in a tight property loop. Every
 * `embed(s)` call returns the same bit-identical
 * `Float32Array(384)` derived from `s` via
 * {@link deterministicVector}.
 *
 * A fresh array is allocated per call so the caller cannot observe
 * aliasing with a prior call's buffer; this matches the real
 * `OnnxEmbedder` which also allocates fresh backing storage per
 * call. (If the query layer were ever to retain a reference to the
 * returned array across calls, aliasing here would mask the bug —
 * allocating fresh forces the test to expose it.)
 */
function makeDeterministicEmbedder(): Embedder {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    embed: vi.fn(async (input: string) => deterministicVector(input)),
    dim: 384 as const,
  };
}

// ── Generators ──────────────────────────────────────────────────────────

/**
 * Finite-only `Float32Array(384)` generator for record embeddings.
 * Non-finite inputs (`NaN`, `±Infinity`) are excluded because they
 * collapse cosine similarity to pathological values (Req 7.6
 * mandates a zero short-circuit for zero-norm vectors, but non-
 * finite elements can still flow through the dot-product) and
 * Property 10 is about ordering stability, not about how the
 * ranker handles pathological inputs — Property 3 covers that.
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
 * Arbitrary corpus entry: a memory record whose `namespace` has
 * been overwritten to the fixed {@link NS}, paired with a finite
 * 384-dim embedding. Every record in a run lives in the same
 * namespace so the hybrid path exercises the full lexical + vector
 * + RRF + tie-break chain without being short-circuited by a
 * namespace-empty case.
 */
function arbitraryCorpusEntry(): fc.Arbitrary<{
  record: MemoryRecord;
  embedding: Float32Array;
}> {
  return fc
    .tuple(arbitraryMemoryRecord(), finiteFloat32Array(384))
    .map(([record, embedding]) => ({
      record: { ...record, namespace: NS },
      embedding,
    }));
}

/**
 * Arbitrary corpus of 1–15 entries in the fixed namespace. Minimum
 * of 1 so every run has at least one seedable record (zero-record
 * namespaces fall into the empty-query / empty-result short-circuit
 * paths which are covered by Properties 9 and 11). Upper bound of
 * 15 keeps per-iteration setup under a few tens of milliseconds.
 *
 * A single-namespace corpus is the correct scope for determinism:
 * the cross-namespace case is covered by Property 9, and stacking
 * multiple namespaces here would only dilute the signal.
 */
const corpusArb = fc.array(arbitraryCorpusEntry(), {
  minLength: 1,
  maxLength: 15,
});

/**
 * Small-ish query string. Bounded at 50 chars so shrinks stay
 * readable; at least one char so the non-empty lexical branch is
 * exercised (the empty-query short-circuit is Property 11 and
 * returns `[]` vacuously, which would be trivially deterministic
 * and add no signal here).
 */
const queryArb = fc.string({ minLength: 1, maxLength: 50 });

/**
 * Limits in `[1, 20]`. Upper bound exceeds the corpus cap (15) so
 * we also cover the case where the caller asks for more records
 * than exist — the property must still hold (two calls must still
 * return the same truncated-to-`limit` list).
 */
const limitArb = fc.integer({ min: 1, max: 20 });

// ── Corpus helpers ──────────────────────────────────────────────────────

/**
 * Deduplicate a corpus on `record.record_id`, keeping the first
 * occurrence. Same load-bearing rationale as the task-8.5 / 8.6
 * tests: under fast-check shrinking, the ULID generator can
 * collapse every record id to the literal 26-zero ULID, which
 * `storage.putMemoryRecord` rejects as a primary-key collision.
 * Deduping here keeps the property from tripping on a seed-time
 * error instead of the actual ordering invariant.
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
 * first, then embeddings — matching the production write order
 * (`ExtractionWorker` inserts the record and then, on a separate
 * call, persists the embedding).
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

describe('Feature: local-embeddings-and-hybrid-search, Property 10: Hybrid is deterministic', () => {
  it('two sequential search(ns, q, limit) calls return identical ordered lists', async () => {
    await fc.assert(
      fc.asyncProperty(
        corpusArb,
        queryArb,
        limitArb,
        async (rawCorpus, query, limit) => {
          // Fresh backend per run — `beforeEach` only runs once per
          // `it`, not per property iteration. Without this, runs
          // would contaminate each other's namespace and a late
          // iteration could see records seeded by an earlier one.
          await storage.close();
          storage = openSqliteStorage({ dbPath: ':memory:' });

          const corpus = dedupeCorpus(rawCorpus);
          await seedCorpus(storage, corpus);

          const embedder = makeDeterministicEmbedder();
          const queryLayer = createQueryLayer({ storage, embedder });

          // Two sequential calls with byte-identical inputs.
          // No cache invalidation, no intervening writes, no
          // wall-clock-sensitive config — the only thing that
          // could make these diverge is non-determinism in the
          // ranking pipeline itself.
          const first = await queryLayer.search(NS, query, limit);
          const second = await queryLayer.search(NS, query, limit);

          // Same length — a differing length alone would prove
          // non-determinism, and collecting it separately makes
          // the failure message sharper than a raw `toEqual`
          // diff on two arrays of different sizes.
          expect(second.length).toBe(first.length);

          // Record-id order equality — the primary determinism
          // contract. If the tie-break in `QueryLayer.search`
          // ever dropped `created_at` or `record_id` from its
          // comparator, two records with equal fused scores
          // could swap positions between calls and this
          // assertion would surface it.
          expect(second.map((r) => r.record_id)).toEqual(
            first.map((r) => r.record_id),
          );

          // Whole-record equality — catches the rarer case
          // where the id order is stable but the joined record
          // payload differs (e.g. a mismatched
          // lexical-vs-cache join on vec-only hits returning
          // different snapshots of the same record).
          expect(second).toEqual(first);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
