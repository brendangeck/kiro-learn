/**
 * Unit tests for the `QueryLayer` hybrid wiring (task 8.4).
 *
 * These tests exercise the end-to-end wiring inside `createQueryLayer`:
 *
 *   - `embed(query)` is invoked exactly once per `search` call when the
 *     embedder is available.
 *   - RRF fusion surfaces a vec-only hit — a record that the lexical
 *     stage never returned but the vector stage ranked highly enough
 *     that, after `(lex, vec)` fusion, it lands in the final
 *     top-`limit` slice.
 *   - `embedder === null` behaves identically to pure lexical search
 *     (via the `searchMemoryRecordsLexical` surface), so the feature
 *     flag is a strict no-op on the read path.
 *   - When `embedder.embed` throws, the read path falls back to
 *     lexical-only and never surfaces the error to the caller.
 *   - An empty-token query (empty string, whitespace-only) short-
 *     circuits to `[]` without invoking the embedder at all.
 *
 * Design choices:
 *
 *   - The storage backend is the real SQLite implementation against
 *     an in-memory database (`openSqliteStorage({ dbPath: ':memory:' })`).
 *     This gives us a real FTS5 index so lexical ranking is authentic
 *     — we do not reinvent the ranker in a stub.
 *   - The `Embedder` is a `vi.fn()`-backed fake modelled on
 *     `makeMockEmbedder` from `embedding-extraction-worker.test.ts`
 *     (task 7.2). This lets us spy on call counts and force specific
 *     return values / errors per scenario.
 *   - For the "vec-only hit" scenario the corpus is deliberately
 *     small (4 records) with a single lexical match (only one record
 *     contains the query token "quasar"). The mock embedder returns
 *     a query vector engineered to rank the lexically-dead record
 *     first and the remaining records in a known order. With the
 *     default `rrfK = 60`, the fused top-2 is `[lex-only, vec-only]`
 *     — the vec-only record is present in the result but would
 *     never appear in a pure-FTS5 top-`limit` slice.
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md § Task 8.4
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md §§ 5.1, 6.1, 6.2, 6.3, 6.4
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md § QueryLayer — modified
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryLayer } from '../../src/collector/query/index.js';
import type { Embedder } from '../../src/collector/embedding/index.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { StorageBackend } from '../../src/types/index.js';

import { makeValidRecord } from '../helpers/fixtures.js';

// ── Constants ───────────────────────────────────────────────────────────

/** Shared namespace for the seeded corpora. */
const NS = '/actor/alice/project/abc/';

// ── Mock embedder ───────────────────────────────────────────────────────

/**
 * Build a mock `Embedder`. Mirrors the helper used in
 * `embedding-extraction-worker.test.ts`. `embed` is a `vi.fn()` so
 * callers can assert call counts; `isReady` is also a spy.
 *
 * The embedder returns a fresh clone of `opts.embedReturn` (or a
 * 384-dim zero vector) every call so the caller cannot mutate our
 * canonical vector across invocations.
 */
function makeMockEmbedder(opts: {
  isReady?: boolean;
  embedReturn?: Float32Array;
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
      if (opts.embedError) {
        throw opts.embedError;
      }
      // Return a fresh clone so downstream code can't pollute our
      // canonical vector across calls.
      return opts.embedReturn !== undefined
        ? new Float32Array(opts.embedReturn)
        : new Float32Array(384);
    }),
    dim: 384 as const,
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────

/**
 * Build a Float32Array(384) where one dimension is 1 and everything
 * else is 0. Useful for engineering known cosine similarities against
 * the query vector — two such vectors are orthogonal when their `one`
 * dimensions differ and identical when they match.
 */
function oneHot(dim: number, value = 1): Float32Array {
  const vec = new Float32Array(384);
  vec[dim] = value;
  return vec;
}

// ── Test-lifecycle scaffolding ──────────────────────────────────────────

let storage: StorageBackend;

beforeEach(() => {
  // Fresh in-memory SQLite backend per test. No temp files needed —
  // every scenario fits comfortably in memory and the teardown
  // `close()` drops the database.
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

// ── Tests ───────────────────────────────────────────────────────────────

describe('QueryLayer hybrid wiring', () => {
  /**
   * With the embedder present and the query non-empty, a single
   * `search` call invokes `embed(query)` exactly once. The exact
   * query string is passed through verbatim (no normalisation at
   * the query-layer boundary — that's the embedder's concern).
   *
   * Validates: Requirement 6.1
   */
  it('invokes embedder.embed exactly once per search (non-empty query)', async () => {
    // One record is enough — the lexical stage finds it, then the
    // query layer goes on to call `embed`.
    const record = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000001',
      namespace: NS,
      title: 'Observation about quasar luminosity',
      summary: 'Measured the brightness of distant celestial objects.',
    });
    await storage.putMemoryRecord(record);

    const embedder = makeMockEmbedder({
      embedReturn: oneHot(0),
    });

    const queryLayer = createQueryLayer({ storage, embedder });

    await queryLayer.search(NS, 'quasar', 10);

    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(embedder.embed).toHaveBeenCalledWith('quasar');
  });

  /**
   * Fusion surfaces a vec-only hit.
   *
   * Corpus: 4 records in the same namespace. Only `R1` contains the
   * query token "quasar" (the lexical stage returns `[R1]`). The
   * remaining three records (`R2`, `R3`, `R4`) do NOT contain
   * "quasar" and therefore never appear in the FTS5 result.
   *
   * We seed each record's embedding as a distinct one-hot vector
   * (dimensions 0, 1, 2, 3 respectively) and make the mock embedder
   * return the one-hot at dimension `3` for the query. Cosine
   * similarity is then:
   *
   *   R1 (one-hot[0]) · query(one-hot[3]) = 0
   *   R2 (one-hot[1]) · query(one-hot[3]) = 0
   *   R3 (one-hot[2]) · query(one-hot[3]) = 0
   *   R4 (one-hot[3]) · query(one-hot[3]) = 1
   *
   * So the vector ranking has `R4` at rank 1. The other three tie at
   * cosine 0; `topKByCosine` will return them after `R4` in some
   * stable order — the exact order of the ties is not material to
   * this test, because `R4`'s rank-1 position is what drives the
   * assertion. With `limit = 2` and the default `rrfK = 60`, the
   * fused top-2 is `[R1, R4]`:
   *
   *   R1: 1/(60+1)  + 1/(60 + rank_V(R1))  ≈ 0.03 + 1/6x
   *   R4: 1/(60+1)                       ≈ 0.0164
   *
   * `R1` wins on combined lex + vec contribution; `R4` wins on its
   * single rank-1 vec contribution over `R2` and `R3`. The returned
   * set therefore includes `R4` — a record that the pure-FTS5 top-2
   * would have entirely missed.
   *
   * Validates: Requirements 5.1, 6.2
   */
  it('fuses a vec-only hit into the top-`limit` result', async () => {
    // Four records, only R1 lexically matches "quasar".
    const R1 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000010',
      namespace: NS,
      title: 'Observation about quasar luminosity',
      summary: 'Measured the brightness of distant celestial objects.',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    const R2 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000011',
      namespace: NS,
      title: 'Telescope calibration routine',
      summary: 'Adjusting lens focus for night sky observation.',
      created_at: '2024-02-01T00:00:00.000Z',
    });
    const R3 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000012',
      namespace: NS,
      title: 'Spectrograph maintenance log',
      summary: 'Routine cleaning of the diffraction grating.',
      created_at: '2024-03-01T00:00:00.000Z',
    });
    const R4 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000013',
      namespace: NS,
      title: 'Radiant emission patterns in deep sky',
      summary: 'Analysis of electromagnetic spectra from distant galaxies.',
      created_at: '2024-04-01T00:00:00.000Z',
    });

    for (const r of [R1, R2, R3, R4]) {
      await storage.putMemoryRecord(r);
    }

    // Each record gets a distinct one-hot vector. R4's vector is the
    // same one-hot as the query vector produced by the mock embedder,
    // so R4 wins the cosine race.
    await storage.putEmbedding(R1.record_id, oneHot(0));
    await storage.putEmbedding(R2.record_id, oneHot(1));
    await storage.putEmbedding(R3.record_id, oneHot(2));
    await storage.putEmbedding(R4.record_id, oneHot(3));

    // Sanity check: pure-FTS5 only returns R1 for "quasar", so R4 is
    // genuinely absent from the lexical stage.
    const lexOnly = await storage.searchMemoryRecordsLexical({
      namespace: NS,
      query: 'quasar',
      limit: 40,
    });
    expect(lexOnly.map((r) => r.record.record_id)).toEqual([R1.record_id]);

    const embedder = makeMockEmbedder({
      embedReturn: oneHot(3), // aligns with R4's stored embedding
    });

    const queryLayer = createQueryLayer({ storage, embedder });

    const results = await queryLayer.search(NS, 'quasar', 2);

    // R4 is the vec-only hit — it never appeared in lex, but fusion
    // pulls it into the top-2 because its rank-1 cosine contribution
    // beats every other vec rank.
    const ids = results.map((r) => r.record_id);
    expect(ids).toContain(R4.record_id);

    // R1 remains in the result because it's the only lex match and
    // its combined lex + vec contribution dominates.
    expect(ids).toContain(R1.record_id);

    // Size invariant.
    expect(results.length).toBeLessThanOrEqual(2);
  });

  /**
   * With `embedder: null` (feature flag off), the query layer must
   * behave identically to a pure lexical search — same records, same
   * order, same size. This is the strictly-additive guarantee: the
   * flag-off path never regresses below the FTS5 baseline.
   *
   * Validates: Requirement 6.3 (flag-off behaviour)
   */
  it('embedder === null returns the same records and order as pure lexical search', async () => {
    // Seed a small corpus so FTS5 has a non-trivial ranking to
    // produce. All three records contain the query token "quasar".
    const r1 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000020',
      namespace: NS,
      title: 'Observation about quasar luminosity',
      summary: 'Measured the brightness of distant celestial objects.',
    });
    const r2 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000021',
      namespace: NS,
      title: 'Detecting quasar redshift patterns',
      summary: 'Analyzed spectral data from deep space surveys.',
    });
    const r3 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000022',
      namespace: NS,
      title: 'Discovered a quasar',
      summary: 'A brief mention of the newly identified quasar cluster.',
    });

    for (const r of [r1, r2, r3]) {
      await storage.putMemoryRecord(r);
    }

    const queryLayer = createQueryLayer({ storage, embedder: null });

    const hybrid = await queryLayer.search(NS, 'quasar', 10);

    // Reference behaviour: pure lexical, sliced to `limit`.
    const lex = await storage.searchMemoryRecordsLexical({
      namespace: NS,
      query: 'quasar',
      limit: 10,
    });
    const lexRecords = lex.slice(0, 10).map((x) => x.record);

    // Same records, same order, same size.
    expect(hybrid.map((r) => r.record_id)).toEqual(
      lexRecords.map((r) => r.record_id),
    );
  });

  /**
   * When `embedder.embed` throws, the query layer logs a single
   * warning and returns the lexical-only top-`limit` slice. The
   * caller never sees the error.
   *
   * Validates: Requirement 6.3 (embedder-fails fallback)
   */
  it('embedder.embed throwing falls back to lexical-only', async () => {
    const r1 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000030',
      namespace: NS,
      title: 'Observation about quasar luminosity',
      summary: 'Measured the brightness of distant celestial objects.',
    });
    const r2 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000031',
      namespace: NS,
      title: 'Detecting quasar redshift patterns',
      summary: 'Analyzed spectral data from deep space surveys.',
    });

    for (const r of [r1, r2]) {
      await storage.putMemoryRecord(r);
    }

    const embedder = makeMockEmbedder({
      embedError: new Error('embed boom'),
    });

    // Capture stderr so we can assert the warning fired without
    // polluting the test runner output.
    const capturedStderr: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        capturedStderr.push(
          typeof chunk === 'string'
            ? chunk
            : Buffer.from(chunk).toString('utf8'),
        );
        return true;
      });

    try {
      const queryLayer = createQueryLayer({ storage, embedder });

      // The call must resolve — never reject — even though embed
      // threw.
      const hybrid = await queryLayer.search(NS, 'quasar', 10);

      const lex = await storage.searchMemoryRecordsLexical({
        namespace: NS,
        query: 'quasar',
        limit: 10,
      });
      const lexRecords = lex.slice(0, 10).map((x) => x.record);

      expect(hybrid.map((r) => r.record_id)).toEqual(
        lexRecords.map((r) => r.record_id),
      );

      // The fallback warning named the embedder failure.
      const joinedStderr = capturedStderr.join('');
      expect(joinedStderr).toContain('embed boom');
      expect(joinedStderr).toMatch(/falling back to lexical/);

      // embed was attempted exactly once — the query layer does not
      // retry on failure.
      expect(embedder.embed).toHaveBeenCalledTimes(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  /**
   * An empty-token query (empty string, whitespace-only) returns
   * `[]` without invoking the embedder. This is the short-circuit
   * path — we do not pay the embedder round-trip for a query that
   * cannot possibly match anything.
   *
   * Covers both the completely empty string and an all-whitespace
   * string (tabs, spaces, newlines), because the FTS5 tokeniser
   * reduces both to an empty token set.
   *
   * Validates: Requirement 6.4
   */
  it('empty-token query returns [] without calling embed', async () => {
    // Seed one record so the namespace is non-empty — this guards
    // against the "trivially empty because corpus is empty" false
    // positive.
    const record = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000040',
      namespace: NS,
      title: 'Observation about quasar luminosity',
      summary: 'Measured the brightness of distant celestial objects.',
    });
    await storage.putMemoryRecord(record);

    const embedder = makeMockEmbedder({ embedReturn: oneHot(0) });

    const queryLayer = createQueryLayer({ storage, embedder });

    for (const emptyQuery of ['', '   ', '\t\n  \r']) {
      embedder.embed.mockClear();
      const results = await queryLayer.search(NS, emptyQuery, 10);
      expect(results).toEqual([]);
      expect(embedder.embed).not.toHaveBeenCalled();
    }
  });
});
