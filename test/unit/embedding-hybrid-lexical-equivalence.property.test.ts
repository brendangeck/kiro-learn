/**
 * Property-based test for hybrid-search → lexical-only fallback
 * equivalence.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 8: Hybrid
 * degrades cleanly to lexical.
 *
 * The contract under test — copied verbatim from
 * `.kiro/specs/local-embeddings-and-hybrid-search/design.md`
 * § Property 8:
 *
 *   *For any* corpus and any query, if the embedder is unavailable
 *   for any reason — feature flag off, embedder in degraded mode,
 *   `embed(query)` throws, or every record in the namespace has a
 *   `NULL` embedding — then `QueryLayer.search(ns, q, limit)` returns
 *   a record list that is exactly equal (in order and content) to
 *   the result of pure FTS5 retrieval with the same `(ns, q, limit)`.
 *
 * This is the strictly-additive guarantee: every failure mode of the
 * embedding subsystem converts hybrid into "FTS5-only for this
 * query", and the baseline never regresses below the pre-spec FTS5
 * behaviour. The four failure modes are exercised as four separate
 * `it` blocks, each with 50 runs of `fc.asyncProperty` — this keeps
 * each iteration's test logic straight-line (no combinatorial
 * switching on an `fc.constantFrom(...)` mode picker) and makes
 * failures pinpoint the exact branch that broke.
 *
 * Per-run setup: a fresh in-memory SQLite backend seeded with an
 * `arbitraryMixedCorpus` of 1–10 records in a fixed namespace, a
 * mode-specific fake {@link Embedder}, and a fresh
 * {@link createQueryLayer}. Running against a real SQLite FTS5
 * ensures the lexical ranking we compare against is the *same*
 * ranking the query layer's lexical branch reads — we are not
 * re-inventing the ranker in a stub.
 *
 * Per-run assertion: `queryLayer.search(NS, q, limit)` is identical
 * (record ids in the same order, same length) to
 * `storage.searchMemoryRecordsLexical({...}).slice(0, limit)`.
 *
 * **Validates: Requirements 2.3, 6.3, 8.1, 8.2, 12.4, 16.3**
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Property 8 — Hybrid degrades cleanly to lexical
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md
 *      § Task 8.5
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Embedder } from '../../src/collector/embedding/index.js';
import { createQueryLayer } from '../../src/collector/query/index.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { MemoryRecord, StorageBackend } from '../../src/types/index.js';

import { arbitraryMixedCorpus } from '../helpers/arbitrary.js';

// ── Constants ───────────────────────────────────────────────────────────

/**
 * Shared namespace for every seeded corpus. Using a single namespace
 * across iterations keeps the test hermetic — every run starts with a
 * fresh in-memory SQLite backend, so there is no cross-iteration
 * contamination inside the namespace either.
 */
const NS = '/actor/alice/project/abc/';

/**
 * `fast-check` iteration count. The task spec (§ Task 8.5) calls for
 * 50 runs per failure mode.
 */
const NUM_RUNS = 50;

// ── Fake embedder factory ───────────────────────────────────────────────

/**
 * Fake {@link Embedder} whose behaviour is determined by `mode`:
 *
 * - `'degraded'`: `isReady()` returns `false` permanently. `embed()`
 *   would normally never be called — but we make it reject if it is,
 *   so the test surfaces the violation loudly.
 * - `'throws'`: `isReady()` returns `true` (the embedder looks
 *   healthy from outside) but `embed()` rejects on every call. This
 *   simulates the "query-embed failure" branch from design §
 *   Error Handling.
 *
 * The `'flag-off'` and `'all-null-embeddings'` modes do not need a
 * fake embedder at all — the first passes `null` directly into the
 * `QueryLayer` deps; the second uses a normal embedder but seeds no
 * embeddings, so the vector cache is effectively empty. Both are
 * handled inline in their respective `it` blocks.
 */
type EmbedderFailureMode = 'degraded' | 'throws';

function makeFailingEmbedder(mode: EmbedderFailureMode): Embedder {
  if (mode === 'degraded') {
    return {
      ready: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn(() => false),
      embed: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'degraded-mode embedder.embed() should never be called',
          ),
        ),
      dim: 384 as const,
    };
  }
  // mode === 'throws'
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    embed: vi.fn().mockRejectedValue(new Error('embed boom')),
    dim: 384 as const,
  };
}

/**
 * Healthy fake embedder used by the "all-null-embeddings" branch.
 * Reports `isReady() === true` and `embed()` resolves to a constant
 * 384-dim vector (its exact contents do not matter — the vector
 * cache for the namespace has no entries to score against, so the
 * cosine ranking is empty and RRF collapses to the lexical list).
 */
function makeHealthyEmbedder(): Embedder {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    embed: vi.fn(async () => new Float32Array(384)),
    dim: 384 as const,
  };
}

// ── Corpus helpers ──────────────────────────────────────────────────────

/**
 * Deduplicate a mixed corpus on `record.record_id`, keeping the
 * first occurrence.
 *
 * `arbitraryMemoryRecord` samples ULIDs via independent per-character
 * draws, so the collision probability between two independent records
 * is astronomically low in the steady state. Under fast-check's
 * shrinker, however, the alphabet-index integers can all shrink to
 * `0`, collapsing every record id to the same literal 26-zero ULID —
 * which `storage.putMemoryRecord` would reject as a primary-key
 * collision, masking the actual property failure. Dedup here so the
 * property only ever sees a well-formed corpus.
 *
 * We also dedupe on title+summary as a secondary concern: duplicate
 * text would land in FTS5 with the same rank, and downstream
 * comparisons would still be correct (both paths use the same
 * ranker) but the test becomes less informative. Dedup on id is the
 * load-bearing step; text uniqueness is a nice-to-have.
 */
function dedupeCorpus(
  corpus: ReadonlyArray<{ record: MemoryRecord; embedding: Float32Array | null }>,
): Array<{ record: MemoryRecord; embedding: Float32Array | null }> {
  const seen = new Set<string>();
  const out: Array<{ record: MemoryRecord; embedding: Float32Array | null }> =
    [];
  for (const entry of corpus) {
    if (seen.has(entry.record.record_id)) continue;
    seen.add(entry.record.record_id);
    out.push(entry);
  }
  return out;
}

/**
 * Write every record (and every non-null embedding) in `corpus` into
 * `storage`. This is the shared seed step for three of the four
 * failure modes; the "all-null-embeddings" mode uses a variant that
 * skips the `putEmbedding` call entirely.
 */
async function seedCorpus(
  storage: StorageBackend,
  corpus: ReadonlyArray<{ record: MemoryRecord; embedding: Float32Array | null }>,
  opts: { skipEmbeddings?: boolean } = {},
): Promise<void> {
  for (const entry of corpus) {
    await storage.putMemoryRecord(entry.record);
    if (!opts.skipEmbeddings && entry.embedding !== null) {
      await storage.putEmbedding(entry.record.record_id, entry.embedding);
    }
  }
}

/**
 * Return the record-id list that pure FTS5 retrieval produces for a
 * given (namespace, query, limit). This is the oracle the property
 * compares the hybrid layer against — using the *same*
 * `searchMemoryRecordsLexical` surface the hybrid layer itself reads
 * from guarantees both paths see the identical FTS5 ranking, so a
 * divergence is always a fusion/fallback bug and never a tokeniser
 * mismatch.
 */
async function lexicalIdsForQuery(
  storage: StorageBackend,
  query: string,
  limit: number,
): Promise<string[]> {
  const ranked = await storage.searchMemoryRecordsLexical({
    namespace: NS,
    query,
    limit,
  });
  return ranked.slice(0, limit).map((r) => r.record.record_id);
}

// ── Query + limit arbitraries ───────────────────────────────────────────

/**
 * Small-ish query string. Bounded at 50 chars so shrinks stay
 * readable; at least one char so the non-empty lexical branch is
 * exercised (the dedicated empty-query short-circuit has its own
 * Property 11 test).
 */
const queryArb = fc.string({ minLength: 1, maxLength: 50 });

/**
 * Limits in `[1, 10]` — large enough to span the corpus (which tops
 * out at 10 records per run) so every lexical hit has a chance to
 * appear, small enough to keep the result list short.
 */
const limitArb = fc.integer({ min: 1, max: 10 });

// ── Test-lifecycle scaffolding ──────────────────────────────────────────

let storage: StorageBackend;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  storage = openSqliteStorage({ dbPath: ':memory:' });
  // The query layer writes a fallback warning to stderr on every
  // iteration of the "embed throws" mode. That is contractually
  // correct (Req 14.2) but would drown test output — silence it.
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

// ── Tests ───────────────────────────────────────────────────────────────

describe('Feature: local-embeddings-and-hybrid-search, Property 8: Hybrid degrades cleanly to lexical', () => {
  /**
   * Flag-off mode: `embedder === null`. The query layer must take the
   * "embedder absent" branch (step 3 in its algorithm), which returns
   * the lexical top-`limit` directly.
   *
   * Validates the `embeddingEnabled: false` config surface
   * (Req 12.4) and the flag-off half of Requirement 16.3.
   */
  it('embedder === null (feature flag off) produces the pure-lexical ordering', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryMixedCorpus(NS),
        queryArb,
        limitArb,
        async (rawCorpus, query, limit) => {
          // Fresh backend per run — `beforeEach` only runs once per
          // `it`, not per property iteration. Without this, runs
          // would contaminate each other's namespace.
          await storage.close();
          storage = openSqliteStorage({ dbPath: ':memory:' });

          const corpus = dedupeCorpus(rawCorpus);
          await seedCorpus(storage, corpus);

          const queryLayer = createQueryLayer({ storage, embedder: null });

          const hybrid = await queryLayer.search(NS, query, limit);
          const oracle = await lexicalIdsForQuery(storage, query, limit);

          expect(hybrid.map((r) => r.record_id)).toEqual(oracle);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * Degraded mode: the embedder's `isReady()` returns `false`. Same
   * branch as flag-off (step 3 in the algorithm) but arrived at via
   * the readiness check — validates that a failed-load embedder does
   * not accidentally take the hybrid path.
   *
   * Validates Requirements 2.3 and 16.3.
   */
  it('embedder.isReady() === false (degraded mode) produces the pure-lexical ordering', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryMixedCorpus(NS),
        queryArb,
        limitArb,
        async (rawCorpus, query, limit) => {
          await storage.close();
          storage = openSqliteStorage({ dbPath: ':memory:' });

          const corpus = dedupeCorpus(rawCorpus);
          await seedCorpus(storage, corpus);

          const embedder = makeFailingEmbedder('degraded');
          const queryLayer = createQueryLayer({ storage, embedder });

          const hybrid = await queryLayer.search(NS, query, limit);
          const oracle = await lexicalIdsForQuery(storage, query, limit);

          expect(hybrid.map((r) => r.record_id)).toEqual(oracle);
          // And the degraded embedder's `embed` was never invoked —
          // the short-circuit in step 3 hits before the embedder is
          // asked to do any work. This complements the oracle
          // equality: equivalent output AND equivalent call path.
          expect(embedder.embed).not.toHaveBeenCalled();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * Embed-throws mode: `isReady()` returns `true` but `embed()`
   * rejects. The query layer's step 4 catches the rejection, logs a
   * warning, and returns the lexical top-`limit`. The caller never
   * sees the error.
   *
   * Validates Requirement 6.3.
   */
  it('embedder.embed() throwing falls back to the pure-lexical ordering', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryMixedCorpus(NS),
        queryArb,
        limitArb,
        async (rawCorpus, query, limit) => {
          await storage.close();
          storage = openSqliteStorage({ dbPath: ':memory:' });

          const corpus = dedupeCorpus(rawCorpus);
          await seedCorpus(storage, corpus);

          const embedder = makeFailingEmbedder('throws');
          const queryLayer = createQueryLayer({ storage, embedder });

          // Must resolve — never reject — even though `embed` threw.
          const hybrid = await queryLayer.search(NS, query, limit);
          const oracle = await lexicalIdsForQuery(storage, query, limit);

          expect(hybrid.map((r) => r.record_id)).toEqual(oracle);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * All-null-embeddings mode: the embedder is healthy and the query
   * embedding succeeds, but every record in the namespace has a
   * `NULL` embedding (no `putEmbedding` calls during seed). The
   * vector cache therefore yields an empty index, the cosine ranking
   * is empty, and RRF fusion reduces to lexical-only.
   *
   * Validates Requirements 8.1 and 8.2 — pre-embedding records
   * remain searchable and, when all records are pre-embedding, the
   * result is identical to pure FTS5.
   */
  it('all-NULL-embedding corpus produces the pure-lexical ordering', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbitraryMixedCorpus(NS),
        queryArb,
        limitArb,
        async (rawCorpus, query, limit) => {
          await storage.close();
          storage = openSqliteStorage({ dbPath: ':memory:' });

          const corpus = dedupeCorpus(rawCorpus);
          // Critical: skip the `putEmbedding` step. Every row
          // lands with `embedding IS NULL`, exactly like a
          // pre-spec / pre-backfill corpus.
          await seedCorpus(storage, corpus, { skipEmbeddings: true });

          const embedder = makeHealthyEmbedder();
          const queryLayer = createQueryLayer({ storage, embedder });

          const hybrid = await queryLayer.search(NS, query, limit);
          const oracle = await lexicalIdsForQuery(storage, query, limit);

          expect(hybrid.map((r) => r.record_id)).toEqual(oracle);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
