/**
 * Property-based test for the hybrid-search empty-query
 * short-circuit.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 11:
 * Empty-query short-circuit skips the embedder.
 *
 * The contract under test — copied verbatim from
 * `.kiro/specs/local-embeddings-and-hybrid-search/design.md`
 * § Property 11:
 *
 *   *For any* query string that tokenises to zero FTS5 tokens
 *   (the empty string or a string of only whitespace characters),
 *   `QueryLayer.search(ns, q, limit)` returns the empty array
 *   without invoking `embedder.embed`.
 *
 * This property pins two load-bearing guarantees of the
 * `QueryLayer.search` fast-path:
 *
 *   1. **Vacuous result.** A query with no meaningful tokens has
 *      no meaningful matches — the read path must return `[]`
 *      even when the namespace is fully populated. The lexical
 *      side of the algorithm already returns zero hits for such a
 *      query (FTS5 MATCH on a whitespace-only string yields an
 *      empty set), but the short-circuit adds the "don't bother
 *      with the vector path" half of the contract.
 *   2. **No embedder round-trip.** The vector path is expensive:
 *      a real embed call takes ~15–30 ms even on CPU and allocates
 *      a fresh 1 536-byte buffer per call. If the query is known
 *      to be empty from lexical tokenisation alone, the embedder
 *      call is pure waste. The short-circuit is how we avoid it
 *      (Req 6.4) and the reason the read path stays cheap under
 *      a flood of whitespace-only queries (Req 16.7).
 *
 * This property is the strict counterpart to Property 8 (hybrid
 * degrades cleanly to lexical): Property 8 says the *results* are
 * lexical-only under failure modes, this property says the
 * *embedder is not even consulted* under the empty-query case.
 * The distinction matters because an implementation that ran the
 * embedder and then threw the vector away would pass Property 8
 * but fail here — and would regress the latency invariant under
 * Req 16.7.
 *
 * Per-run setup: a fresh in-memory SQLite backend seeded with a
 * corpus of 1–10 records in a fixed namespace (so the test is
 * meaningful — a populated namespace means a leaky implementation
 * that forgot the short-circuit would happily return real
 * records), a fake {@link Embedder} whose `embed` is a
 * `vi.fn()` spy reporting `isReady === true` (so the short-circuit
 * cannot be masked by the degraded-mode branch at step 3 of
 * `QueryLayer.search`), and a fresh {@link createQueryLayer}.
 *
 * Per-run assertion:
 *   - `queryLayer.search(NS, q, limit)` returns `[]`.
 *   - The `embed` spy was never called.
 *
 * ## Query generation
 *
 * The `queryArb` generator yields strings that
 * {@link tokenizeForQuery} reports as zero tokens. We construct
 * queries from an alphabet of Unicode whitespace characters
 * (space, tab, newline, carriage return, form feed, vertical tab,
 * plus the U+00A0 no-break space to exercise Unicode-aware
 * `\s+`) and include the empty string `''` as a constant. After
 * generation we filter by the real tokeniser — belt-and-braces —
 * so any shrink that accidentally produces a non-whitespace
 * character is discarded rather than flagged as a property
 * violation.
 *
 * **Validates: Requirements 6.4, 16.7**
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Property 11 — Empty-query short-circuit skips the embedder
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md
 *      § Task 8.8
 * @see src/collector/query/index.ts — `QueryLayer.search` step 2
 * @see src/collector/query/tokenize.ts — `tokenizeForQuery`
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Embedder } from '../../src/collector/embedding/index.js';
import { createQueryLayer } from '../../src/collector/query/index.js';
import { tokenizeForQuery } from '../../src/collector/query/tokenize.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { MemoryRecord, StorageBackend } from '../../src/types/index.js';

import { arbitraryMemoryRecord } from '../helpers/arbitrary.js';

// ── Constants ───────────────────────────────────────────────────────────

/**
 * Single fixed namespace for the seeded corpus. The empty-query
 * short-circuit is a per-query property; it is independent of the
 * namespace the search is scoped to. A fixed string keeps setup
 * cheap and assertions trivial — randomising the namespace would
 * only add shrink noise without adding signal.
 */
const NS = '/actor/alice/project/abc/';

/**
 * `fast-check` iteration count. Task 8.8 calls for 100 runs. Each
 * iteration seeds a fresh in-memory SQLite with up to 10 records
 * plus their 1 536-byte embedding blobs, then runs a single
 * `search` — sub-second total.
 */
const NUM_RUNS = 100;

// ── Spying fake embedder ────────────────────────────────────────────────

/**
 * A fake {@link Embedder} whose `embed` method is a `vi.fn()`
 * spy. `isReady()` is stubbed to `true` so the short-circuit in
 * `QueryLayer.search` cannot be masked by the degraded-mode
 * branch at step 3 (which also skips `embed`, but for a
 * different reason we don't want to conflate with Property 11).
 *
 * If the short-circuit is missing, the test will proceed to
 * step 4 of `search`, `embed` will be invoked, and the spy call
 * count will be non-zero — which is exactly the failure we want
 * to surface.
 *
 * The spy is returned alongside the embedder so the test can
 * assert on `embedSpy.mock.calls.length` directly. Returning the
 * bare `vi.fn()` lets us interrogate the spy without reaching
 * through the `Embedder` interface, which would require a type
 * cast.
 */
function makeSpyingEmbedder(): {
  embedder: Embedder;
  embedSpy: ReturnType<typeof vi.fn>;
} {
  // The `embed` spy. If this property holds, its call count
  // stays at 0 across every iteration.
  const embedSpy = vi.fn(async (_input: string): Promise<Float32Array> => {
    // If the property fails we do still need to return a valid
    // vector so the search does not throw — the assertion will
    // be the spy call count, not the subsequent behaviour.
    return new Float32Array(384);
  });
  return {
    embedder: {
      ready: vi.fn().mockResolvedValue(undefined),
      isReady: vi.fn(() => true),
      embed: embedSpy,
      dim: 384 as const,
    },
    embedSpy,
  };
}

// ── Generators ──────────────────────────────────────────────────────────

/**
 * Alphabet of Unicode whitespace characters that the shared
 * tokeniser's `\s+` regex treats as separators. Explicit enumeration
 * (rather than `fc.stringMatching(/^\s*$/)`) keeps the generator
 * transparent about what characters are in play — a shrinker diff
 * that reveals "the counterexample contains a U+00A0" is strictly
 * more useful than a regex black box.
 *
 * Included:
 *   - `' '`  — ASCII space (0x20)
 *   - `'\t'` — tab (0x09)
 *   - `'\n'` — line feed (0x0A)
 *   - `'\r'` — carriage return (0x0D)
 *   - `'\f'` — form feed (0x0C)
 *   - `'\v'` — vertical tab (0x0B)
 *   - `'\u00A0'` — no-break space; part of Unicode `\s+` with the
 *     `u` flag, which the shared tokeniser uses
 *
 * Excluded by design: line separator U+2028 and paragraph
 * separator U+2029 are Unicode whitespace in some standards but
 * are NOT matched by ECMAScript's `\s` with the `u` flag in every
 * engine consistently. Keeping them out avoids a runtime-specific
 * false-positive where the generator emits a "whitespace" string
 * the tokeniser then splits into non-empty segments.
 */
const WHITESPACE_ALPHABET = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\f',
  '\v',
  '\u00A0',
] as const;

/**
 * Arbitrary single whitespace character drawn from
 * {@link WHITESPACE_ALPHABET}.
 */
const whitespaceCharArb = fc.constantFrom(...WHITESPACE_ALPHABET);

/**
 * Arbitrary query string that tokenises to zero FTS5 tokens.
 *
 * The generator produces one of three shapes:
 *   1. The empty string `''` (hit directly via `fc.constant('')`).
 *   2. A short whitespace-only string (1–20 chars) drawn from
 *      the Unicode whitespace alphabet.
 *   3. A longer whitespace-only string (0–40 chars).
 *
 * We filter the result through {@link tokenizeForQuery} as a
 * belt-and-braces check: if the shared tokeniser reports any
 * tokens for the generated string, we discard it. In practice the
 * filter is a no-op for strings drawn from
 * {@link WHITESPACE_ALPHABET} plus the empty string — the filter
 * exists to defend the property against future tokeniser changes
 * that might split on characters not currently in our alphabet.
 *
 * Using three shapes (rather than one) gives fast-check a richer
 * shrink target: an `fc.oneof` over shapes lets the shrinker
 * collapse a long whitespace string to a short one, and a short
 * one to the empty string, while still stressing the generator's
 * full range on every fresh run.
 */
const emptyQueryArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.constant(''),
    fc
      .array(whitespaceCharArb, { minLength: 1, maxLength: 20 })
      .map((chars) => chars.join('')),
    fc
      .array(whitespaceCharArb, { minLength: 0, maxLength: 40 })
      .map((chars) => chars.join('')),
  )
  .filter((s) => tokenizeForQuery(s).length === 0);

/**
 * Finite-only `Float32Array(384)` generator for the seeded record
 * embeddings. Non-finite inputs (NaN / ±Infinity) are excluded
 * because they would make cosine similarity pathological, and
 * this property is about the short-circuit happening *before* the
 * vector path runs — the vector path's behaviour under
 * pathological vectors is covered by Property 3.
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
 * namespace so the seeded corpus is meaningful — a leaky
 * implementation that ignored the short-circuit would have real
 * records to return and the property would fail.
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
 * Arbitrary corpus of 1–10 entries in the fixed namespace. The
 * minimum of 1 ensures every run seeds at least one record — a
 * zero-record namespace would vacuously return `[]` even without
 * the short-circuit, robbing the property of its signal. The
 * upper bound of 10 keeps per-iteration setup under a handful of
 * milliseconds; since `NUM_RUNS = 100` this test budgets well
 * under a second total.
 */
const corpusArb = fc.array(arbitraryCorpusEntry(), {
  minLength: 1,
  maxLength: 10,
});

/**
 * Limits in `[1, 20]`. The upper bound exceeds the corpus cap (10)
 * so we cover the case where the caller asks for more records than
 * exist — the short-circuit must still fire (the post-short-circuit
 * fallback paths clamp at `limit`, but the short-circuit itself is
 * limit-agnostic and this test confirms that).
 */
const limitArb = fc.integer({ min: 1, max: 20 });

// ── Corpus helpers ──────────────────────────────────────────────────────

/**
 * Deduplicate a corpus on `record.record_id`, keeping the first
 * occurrence. Under fast-check shrinking the ULID generator can
 * collapse every record id to the literal 26-zero ULID, which
 * `storage.putMemoryRecord` rejects as a primary-key collision.
 * Deduping here keeps the property from tripping on a seed-time
 * error instead of the actual short-circuit invariant.
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
 * (the `ExtractionWorker` inserts the record and then, on a
 * separate call, persists the embedding).
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

describe('Feature: local-embeddings-and-hybrid-search, Property 11: Empty-query short-circuit skips the embedder', () => {
  it('search(ns, emptyQuery, limit) returns [] and does not invoke embedder.embed', async () => {
    await fc.assert(
      fc.asyncProperty(
        corpusArb,
        emptyQueryArb,
        limitArb,
        async (rawCorpus, emptyQuery, limit) => {
          // Fresh backend per run — `beforeEach` only runs once
          // per `it`, not per property iteration. Without this,
          // runs would contaminate each other's namespace.
          await storage.close();
          storage = openSqliteStorage({ dbPath: ':memory:' });

          const corpus = dedupeCorpus(rawCorpus);
          await seedCorpus(storage, corpus);

          const { embedder, embedSpy } = makeSpyingEmbedder();
          const queryLayer = createQueryLayer({ storage, embedder });

          // Run a single search with the whitespace-only /
          // empty query. The property's two assertions fire on
          // the same call — there is no setup or intermediate
          // state that could mask either invariant.
          const result = await queryLayer.search(NS, emptyQuery, limit);

          // Vacuous-result invariant: the whitespace-only
          // tokenisation is zero, lexical returns nothing, and
          // the short-circuit returns `[]`. A leaky
          // implementation that fell through to the vector path
          // might return real records (cosine similarity against
          // a query vector derived from whitespace is undefined
          // but non-empty) and this assertion would surface it.
          expect(result).toEqual([]);

          // No-embed invariant: the short-circuit must fire
          // *before* step 4 of `QueryLayer.search`, which is the
          // step that calls `embedder.embed(query)`. If the
          // short-circuit is missing or misplaced (e.g. placed
          // after the embed call), the spy count will be
          // non-zero and this assertion fails.
          expect(embedSpy).not.toHaveBeenCalled();
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
