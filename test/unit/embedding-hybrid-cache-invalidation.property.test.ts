/**
 * Property-based test for the hybrid-search cache invalidation
 * protocol.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 12:
 * Writes in a namespace are visible to the next search.
 *
 * The contract under test — copied verbatim from
 * `.kiro/specs/local-embeddings-and-hybrid-search/design.md`
 * § Property 12:
 *
 *   *For any* initial corpus, namespace `ns`, and additional
 *   record `r` whose `namespace = ns`: after
 *   `storage.putMemoryRecord(r)` followed by
 *   `storage.putEmbedding(r.record_id, v)` for a valid
 *   embedding `v`, the next call to
 *   `QueryLayer.search(ns, q, limit)` where `q` is a query that
 *   lexically matches `r` includes `r` in its results.
 *
 * This pins down the cache-invalidation protocol: the per-
 * namespace `NamespaceVectorCache` is rebuilt on demand from
 * `storage.listEmbeddings(ns)`, but a cache that was warmed by
 * an earlier search would be stale after a write if nothing
 * nudged it. The production wiring (design § Cache invalidation
 * protocol) has the extraction and backfill workers call
 * `QueryLayer.invalidateNamespace(ns)` after every successful
 * `putMemoryRecord` + `putEmbedding`. This property tests that
 * contract end-to-end: once the invalidation is called, the next
 * search must see the new record, no matter what was cached.
 *
 * The property has two load-bearing halves:
 *
 *   1. **Lexical inclusion of the new record.** FTS5 MATCH runs
 *      on the query directly against the underlying table (not
 *      the cache), so even without invalidation this half works
 *      — but the test asserts it for completeness, since a
 *      regression that broke the underlying write (e.g.
 *      `putMemoryRecord` not updating FTS5) would surface here
 *      too.
 *   2. **Cache staleness does not mask the new record.** If the
 *      hybrid path held onto a pre-write vector index and joined
 *      the fused result only against the cache's record view,
 *      the new record could lose its lexical-only hit to a
 *      RRF-fused vec-only hit that kept the cache's top slot.
 *      The explicit `invalidateNamespace` call before the
 *      second search is what the production wiring does after
 *      every write, and this property pins that requirement.
 *
 * Per-run setup: a fresh in-memory SQLite backend seeded with a
 * corpus of 1–10 records in a fixed namespace, a deterministic
 * fake {@link Embedder} that derives its output vector from a
 * hash of the input string (same approach as Property 10 — a
 * constant vector would collapse the cosine ranking and
 * trivialise the cache's role, while a non-deterministic
 * embedder would violate Req 17.3). An initial `search` call
 * warms the cache for the namespace. A new record is inserted
 * whose `title` contains a rare token distinct from anything in
 * the initial corpus; its embedding is persisted; then
 * `queryLayer.invalidateNamespace(ns)` fires — simulating the
 * production write-path hook — and the follow-up `search` uses
 * that rare token as its query.
 *
 * Per-run assertion: the second `search` returns a list that
 * includes the new record's `record_id`. The property does NOT
 * assert ranking position — the RRF fusion is allowed to place
 * it anywhere in the result — only that it is included.
 *
 * ## Rare-token construction
 *
 * The new record's title uses a fixed marker prefix
 * (`sparklysparkle`) concatenated with the record's own
 * `record_id`. Two reasons:
 *
 *   - **Uniqueness.** The initial corpus cannot accidentally
 *     contain the marker: FTS5 tokenises on Unicode whitespace
 *     and the marker is a single token of exotic letters that
 *     `arbitraryMemoryRecord()` has effectively zero chance of
 *     generating. This keeps the assertion "new record appears"
 *     crisp — any hit for the query is the new record.
 *   - **Shrink-resistance.** Using the record id (a ULID) as
 *     part of the token guarantees the marker stays distinct
 *     across shrinks even if fast-check collapses the random
 *     title bytes. Without this, a shrink that collapsed the
 *     title to a common substring could produce a false
 *     positive where an unrelated initial record happened to
 *     match the shrunk query.
 *
 * ## What this test does NOT cover
 *
 * - **Cross-namespace invalidation.** Property 12 is
 *   intentionally single-namespace; cross-namespace isolation
 *   is Property 9.
 * - **Concurrent writes racing a search.** The cache's epoch
 *   guard against concurrent rebuilds is covered by unit tests
 *   in `embedding-vector-cache.test.ts`, not here.
 * - **Ranking position of the new record.** RRF may place the
 *   new record anywhere in the top-`limit`; the property only
 *   pins inclusion, which is the minimum contract Req 7.5
 *   actually demands.
 *
 * **Validates: Requirements 7.5**
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Property 12 — Writes in a namespace are visible to the
 *      next search in that namespace
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Cache invalidation protocol
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md
 *      § Task 8.9
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
 * Single fixed namespace for the seeded corpus. Property 12 is
 * an intra-namespace property — the write lands in one namespace
 * and must be visible to the next search in that namespace.
 * Cross-namespace isolation is Property 9.
 */
const NS = '/actor/alice/project/abc/';

/**
 * Rare marker token baked into the new record's title. Chosen to
 * have effectively zero probability of appearing in an
 * {@link arbitraryMemoryRecord} draw: it is a lower-case letter
 * run with no spaces or punctuation, long enough (14 chars) that
 * fast-check's default string generator is statistically unable
 * to produce it verbatim under any shrinking schedule.
 *
 * The marker is paired with the new record's `record_id` at
 * construction time to guarantee absolute uniqueness — even if
 * by miracle the initial corpus contained the bare marker, it
 * would not contain `marker + record_id`.
 */
const RARE_MARKER = 'sparklysparkle';

/**
 * `fast-check` iteration count. Task 8.9 calls for 50 runs —
 * each iteration opens a fresh in-memory SQLite, seeds up to 10
 * records with their embeddings, warms the cache, inserts a new
 * record, invalidates, and re-searches. Sub-second total.
 */
const NUM_RUNS = 50;

// ── Deterministic fake embedder ─────────────────────────────────────────

/**
 * Deterministic 32-bit FNV-1a string hash. Same construction as
 * the Property 10 test (`embedding-hybrid-determinism.property.test.ts`)
 * — a pure, integer-only, Node-version-stable hash that seeds a
 * Lehmer PRNG in {@link deterministicVector}. Kept in-file rather
 * than factored into a shared helper because the two tests are
 * the only consumers and co-locating the construction keeps each
 * test self-contained under shrinking.
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
 * Same Lehmer-PRNG construction as the Property 10 test; see that
 * file's TSDoc for the rationale behind hash-derived vectors
 * (rather than a constant) for stressing the RRF fusion path.
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
 * Fake {@link Embedder} reporting ready and returning a
 * deterministic `Float32Array(384)` per call. The embedder
 * contract (Req 17.3 / Property 5) is deterministic-within-a-
 * process, and this fake honours it: two calls with the same
 * input return bit-identical vectors.
 *
 * Determinism matters here because the test calls `embed` three
 * times — once on each `search` (the query is embedded) and, if
 * the implementation chose to, any ancillary paths — and an
 * indeterminate embedder would introduce noise that is not the
 * subject of Property 12.
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
 * Finite-only `Float32Array(384)` generator. `NaN`/`±Infinity`
 * are excluded so cosine similarity is well-defined on every
 * pair in the index — Property 12 is about write visibility, not
 * about pathological vector handling (Property 3 covers that).
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
 * Arbitrary initial-corpus entry: a memory record whose
 * `namespace` has been overwritten to the fixed {@link NS},
 * paired with a finite 384-dim embedding. Every record in an
 * initial corpus lives in the same namespace as the eventual
 * write, because Property 12 is an intra-namespace property —
 * off-namespace records would either fail the
 * `NamespaceVectorCache` filter (and therefore not be in the
 * warmed cache at all) or, if they leaked, trip Property 9
 * instead of Property 12.
 */
function arbitraryInitialEntry(): fc.Arbitrary<{
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
 * Arbitrary initial corpus of 1–10 entries in the fixed
 * namespace. Minimum of 1 so the first `search` has something
 * to return and the `NamespaceVectorCache` has something to
 * cache — a zero-record namespace would still exercise the
 * invalidation path but with a trivially empty index, which
 * loses the "cache was stale" bite that the property is
 * designed to catch. Upper bound of 10 keeps per-iteration
 * setup under a few tens of milliseconds.
 */
const initialCorpusArb = fc.array(arbitraryInitialEntry(), {
  minLength: 1,
  maxLength: 10,
});

/**
 * Arbitrary "new record" to insert after the initial search
 * warms the cache. The record is assembled from a base
 * {@link arbitraryMemoryRecord} draw plus a fixed-namespace
 * override AND a `title` rewrite that splices
 * {@link RARE_MARKER} together with the record's own
 * `record_id`. That composite token is the query we later run —
 * see the module TSDoc for why this guarantees the initial
 * corpus cannot spuriously match it.
 */
function arbitraryNewEntry(): fc.Arbitrary<{
  record: MemoryRecord;
  embedding: Float32Array;
  marker: string;
}> {
  return fc
    .tuple(arbitraryMemoryRecord(), finiteFloat32Array(384))
    .map(([record, embedding]) => {
      // The marker is a single whitespace-delimited token so
      // FTS5's `unicode61` tokenizer sees it as one term. We
      // append the ULID-suffix of the record id (lower-cased,
      // because FTS5 tokenises to lowercase on the index side)
      // so the full query token is per-iteration unique; even
      // under shrinking, distinct property iterations produce
      // distinct tokens and cannot accidentally collide with
      // each other's seeded rows.
      const marker = `${RARE_MARKER}${record.record_id.toLowerCase()}`;
      return {
        record: {
          ...record,
          namespace: NS,
          title: marker,
        },
        embedding,
        marker,
      };
    });
}

/**
 * Headroom added on top of the initial corpus size when deriving
 * the follow-up `search` limit. Sized so the final top-`limit`
 * truncation cannot crowd the new record out of the result: with
 * the initial corpus capped at 10 entries, a limit `≥ 11` fits
 * every record (initial + new) in the returned list, and a
 * lexical hit for `r` is guaranteed to survive the final RRF
 * tie-break regardless of how the vector ranking shuffles the
 * vec-only hits. The randomised headroom range exercises both
 * the "just fits" edge (`headroom = 1`) and more generous
 * budgets (`headroom = 10`) without falling into the
 * crowd-out regime where Property 12's inclusion guarantee is
 * not implied by the hybrid algorithm's contract.
 *
 * Concretely: the hybrid search fuses up to `limit*2`
 * candidates via RRF, then tie-breaks on `(fused_score DESC,
 * created_at DESC, record_id ASC)` and truncates to `limit`.
 * When `limit < corpus_size + 1` and the new record's RRF score
 * ties with a vec-only hit's, the `record_id` tie-break can push
 * the new record out of the final top-`limit`. That failure mode
 * is a known limitation of the RRF algorithm, not a violation
 * of Property 12 — Property 12's spec text ("includes `r` in its
 * results") presupposes that the result list is large enough to
 * include every matching record, which is always true in the
 * production read path where the operator chooses `limit` based
 * on downstream display budgets.
 */
const headroomArb = fc.integer({ min: 1, max: 10 });

// ── Corpus helpers ──────────────────────────────────────────────────────

/**
 * Deduplicate a corpus on `record.record_id`, keeping the first
 * occurrence. Same load-bearing rationale as the sibling
 * Property 9/10 tests: under fast-check shrinking, the ULID
 * generator can collapse every record id to the literal 26-zero
 * ULID, which `storage.putMemoryRecord` rejects as a primary-key
 * collision. Deduping keeps the property from tripping on a
 * seed-time error instead of the actual invariant.
 */
function dedupeInitialCorpus(
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
 * Exclude any initial entry whose `record_id` collides with the
 * new record's `record_id`. The ULID generator can, under
 * shrinking, produce colliding ids across the initial corpus and
 * the new record; if we did not filter, the new-record insert
 * would either be an UPDATE (because `putMemoryRecord` is
 * upsert-like on `record_id`) or a seed-time failure, either of
 * which would mask whatever Property 12 is actually trying to
 * detect.
 */
function excludeCollidingIds(
  initial: ReadonlyArray<{ record: MemoryRecord; embedding: Float32Array }>,
  newRecordId: string,
): Array<{ record: MemoryRecord; embedding: Float32Array }> {
  return initial.filter((e) => e.record.record_id !== newRecordId);
}

/**
 * Seed every record + embedding in `corpus` into `storage`.
 * Records first, then embeddings — matching the production
 * write order (`ExtractionWorker` inserts the record and then,
 * on a separate call, persists the embedding).
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

describe('Feature: local-embeddings-and-hybrid-search, Property 12: Writes in a namespace are visible to the next search', () => {
  it('after putMemoryRecord + putEmbedding + invalidateNamespace, the next matching search includes the new record', async () => {
    await fc.assert(
      fc.asyncProperty(
        initialCorpusArb,
        arbitraryNewEntry(),
        headroomArb,
        async (rawInitial, newEntry, headroom) => {
          // Fresh backend per run — `beforeEach` only runs once
          // per `it`, not per property iteration. Without this,
          // runs would contaminate each other's namespace and a
          // late iteration could see records seeded by an
          // earlier one, which would invert the property's
          // sense of "new record".
          await storage.close();
          storage = openSqliteStorage({ dbPath: ':memory:' });

          // Deduplicate the initial corpus and exclude any id
          // that would collide with the new record — both of
          // these protect the property from seed-time errors
          // that have nothing to do with cache invalidation.
          const initial = excludeCollidingIds(
            dedupeInitialCorpus(rawInitial),
            newEntry.record.record_id,
          );
          await seedCorpus(storage, initial);

          // Derive `limit` from the actual seeded corpus plus
          // headroom so the final top-`limit` truncation cannot
          // crowd out the new record. See {@link headroomArb}
          // for the full rationale.
          const limit = initial.length + headroom;

          const embedder = makeDeterministicEmbedder();
          const queryLayer = createQueryLayer({ storage, embedder });

          // Step 1: warm the cache. A search with a cheap
          // always-lexical query (the marker is not yet in the
          // index, so this returns lexical-only results for any
          // initial records that happen to contain the marker
          // substring — effectively none — plus primes the
          // per-namespace vector cache). We do not assert
          // anything about this call's results; its purpose is
          // purely to populate `NamespaceVectorCache` for NS.
          await queryLayer.search(NS, newEntry.marker, limit);

          // Step 2: insert the new record and its embedding.
          // This is the exact two-call sequence the extraction
          // worker performs (design § Sequence: embedding on
          // write).
          await storage.putMemoryRecord(newEntry.record);
          await storage.putEmbedding(
            newEntry.record.record_id,
            newEntry.embedding,
          );

          // Step 3: invalidate the namespace's cached vector
          // index. The production wiring (design § Cache
          // invalidation protocol) has the extraction and
          // backfill workers invoke this after every successful
          // `putEmbedding`. The test invokes it directly
          // because the isolation boundary of Property 12 is
          // the `QueryLayer` surface, not the full collector
          // wiring — wiring tests live elsewhere.
          queryLayer.invalidateNamespace(NS);

          // Step 4: the follow-up search with a query that
          // lexically matches the new record's title must
          // include the new record. We search for the exact
          // marker token; FTS5 matches on whitespace-tokenised
          // phrases, and the marker is the entire title of
          // the new record, so a lexical hit is guaranteed
          // *at storage level*. The property is that the
          // cache-invalidation-aware `QueryLayer.search`
          // surfaces that hit, not just the underlying FTS5
          // layer.
          const results = await queryLayer.search(NS, newEntry.marker, limit);

          // Primary assertion: the new record appears in the
          // result set. We compare on `record_id` because two
          // `MemoryRecord` objects can be structurally
          // non-identical (e.g. after a storage round-trip
          // normalises timestamps) while still denoting the
          // same row.
          const resultIds = results.map((r) => r.record_id);
          expect(resultIds).toContain(newEntry.record.record_id);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
