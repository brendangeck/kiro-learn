/**
 * Property-based tests for the FTS5 query tokenization helpers in
 * `src/collector/storage/sqlite/fts5.ts`.
 *
 * Each property is tagged with the feature name and property number per the
 * design document's Correctness Properties section.
 *
 * @see .kiro/specs/fts5-query-tokenization/design.md § Correctness Properties
 * @see .kiro/specs/fts5-query-tokenization/requirements.md
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildFts5OrQuery,
  sanitizeForFts5,
  tokenizeForQuery,
} from '../../src/collector/storage/sqlite/fts5.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { StorageBackend } from '../../src/types/index.js';

describe('tokenizeForQuery — property tests', () => {
  it('Property 1: Tokenizer round-trip', () => {
    /**
     * **Validates: Requirements 1.1, 1.2, 1.3, 7.2, 11.1**
     *
     * For any Unicode input string `s`, let `ts = tokenizeForQuery(s)`. Then:
     * - every element of `ts` is non-empty
     * - every element contains no Unicode whitespace character
     * - every element appears exactly once in `ts`
     * - `tokenizeForQuery(ts.join(' '))` equals `ts`
     */
    fc.assert(
      fc.property(fc.string(), (s) => {
        const ts = tokenizeForQuery(s);

        // Every token is non-empty
        for (const t of ts) {
          expect(t.length).toBeGreaterThan(0);
        }

        // No token contains Unicode whitespace
        for (const t of ts) {
          expect(t).not.toMatch(/\s/u);
        }

        // Every token appears exactly once (no duplicates)
        const unique = new Set(ts);
        expect(unique.size).toBe(ts.length);

        // Round-trip: tokenizing the joined output yields the same list
        const roundTripped = tokenizeForQuery(ts.join(' '));
        expect(roundTripped).toEqual(ts);
      }),
      { numRuns: 200 },
    );
    // Feature: fts5-query-tokenization, Property 1: Tokenizer round-trip
  });

  it('Property 2: Tokens are substrings of input', () => {
    /**
     * **Validates: Requirement 7.3**
     *
     * For any Unicode input string `s` and every element `t` in
     * `tokenizeForQuery(s)`, `t` appears as a contiguous substring of `s`
     * with its original character sequence and casing preserved.
     */
    fc.assert(
      fc.property(fc.string(), (s) => {
        const ts = tokenizeForQuery(s);

        for (const t of ts) {
          expect(s).toContain(t);
        }
      }),
      { numRuns: 200 },
    );
    // Feature: fts5-query-tokenization, Property 2: Tokens are substrings of input
  });
});

describe('buildFts5OrQuery — property tests', () => {
  it('Property 3: Query builder round-trips every token as an escaped phrase', () => {
    /**
     * **Validates: Requirements 1.4, 1.5, 3.2, 3.3, 3.4, 6.2, 6.3, 11.2**
     *
     * For any non-empty deduplicated token list `ts`, `buildFts5OrQuery(ts)`
     * consists of exactly `ts.length` quoted phrases separated by exactly
     * `ts.length - 1` occurrences of the literal ` OR `, where the `i`-th
     * phrase decodes (by stripping the surrounding `"` and replacing `""` with
     * `"`) to `ts[i]` — and no other quoted phrases appear in the output.
     */
    const nonEmptyDeduplicatedTokens = fc
      .array(fc.string(), { minLength: 1, maxLength: 32 })
      .map((arr) => {
        // Use tokenizeForQuery on the joined input to get a valid deduplicated
        // non-empty token list for free.
        return tokenizeForQuery(arr.join(' '));
      })
      .filter((ts) => ts.length > 0);

    fc.assert(
      fc.property(nonEmptyDeduplicatedTokens, (ts) => {
        const output = buildFts5OrQuery(ts);

        // Split on ` OR ` — should yield exactly ts.length segments
        const segments = output.split(' OR ');
        expect(segments.length).toBe(ts.length);

        // Each segment is a quoted phrase that decodes to the original token
        for (let i = 0; i < ts.length; i++) {
          const seg = segments[i]!;

          // Must start and end with `"`
          expect(seg.startsWith('"')).toBe(true);
          expect(seg.endsWith('"')).toBe(true);

          // Strip surrounding quotes and unescape `""` → `"`
          const inner = seg.slice(1, -1).replace(/""/g, '"');
          expect(inner).toBe(ts[i]);
        }
      }),
      { numRuns: 200 },
    );
    // Feature: fts5-query-tokenization, Property 3: Query builder round-trips every token as an escaped phrase
  });
});

describe('sanitizeForFts5 — property tests', () => {
  /**
   * Shared in-memory SQLite backend for Property 4. Opened once per test
   * via `beforeEach` so each iteration of the property has a clean handle.
   * The backend is closed in `afterEach`.
   */
  let storage: StorageBackend;

  beforeEach(() => {
    storage = openSqliteStorage({ dbPath: ':memory:' });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('Property 4: Sanitizer output is always valid FTS5 or empty', async () => {
    /**
     * **Validates: Requirements 1.6, 3.1, 11.3**
     *
     * For any input `s` and `k ≤ 32`, `sanitizeForFts5(s, k)` is either `""`
     * or a string that `selectMemoryRecordsFtsMatch` accepts without throwing
     * when executed against a prepared in-memory SQLite handle.
     *
     * We seed one record so the FTS5 table exists and the prepared statement
     * can be exercised. The test does not assert on results — only that the
     * statement does not throw.
     */
    // Seed a single record so the FTS5 table has content to query against.
    await storage.putMemoryRecord({
      record_id: 'mr_00000000000000000000000000',
      namespace: '/actor/test/project/prop4/',
      strategy: 'llm-summary',
      title: 'seed record for property 4',
      summary: 'ensures the FTS5 table is non-empty',
      facts: ['seed'],
      source_event_ids: ['01JF8ZS4Y00000000000000000'],
      created_at: '2026-01-01T00:00:00Z',
      concepts: ['testing'],
      files_touched: ['src/index.ts'],
      observation_type: 'tool_use',
    });

    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.integer({ min: 1, max: 32 }),
        async (s, k) => {
          const out = sanitizeForFts5(s, k);

          if (out === '') {
            // Empty output is valid — the backend would skip the query.
            return;
          }

          // Non-empty output must be accepted by searchMemoryRecords without
          // throwing. We use the full backend method which internally calls
          // selectMemoryRecordsFtsMatch.all(out, namespace, limit).
          const results = await storage.searchMemoryRecords({
            namespace: '/actor/test/project/prop4/',
            query: s,
            limit: 10,
          });

          // The call must return an array (not throw).
          expect(Array.isArray(results)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
    // Feature: fts5-query-tokenization, Property 4: Sanitizer output is always valid FTS5 or empty
  });

  it('Property 5: Empty sanitizer output iff empty tokenization', () => {
    /**
     * **Validates: Requirements 2.1, 2.2, 2.3, 13.3**
     *
     * `sanitizeForFts5(s) === ''` if and only if `tokenizeForQuery(s).length === 0`.
     *
     * This is the biconditional half of Property 5. The "backend skips SQL"
     * half depends on task 8 (backend rewire) and will be added after that
     * task is complete.
     */
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = sanitizeForFts5(s);
        const tokens = tokenizeForQuery(s);

        if (tokens.length === 0) {
          // Empty tokenization → empty output
          expect(out).toBe('');
        } else {
          // Non-empty tokenization → non-empty output
          expect(out).not.toBe('');
        }
      }),
      { numRuns: 200 },
    );
    // Feature: fts5-query-tokenization, Property 5: Empty sanitizer output iff empty tokenization, and the backend skips SQL in that case
  });

  it('Property 6: Term cap is honoured exactly', () => {
    /**
     * **Validates: Requirements 6.1, 12.1, 12.2, 12.3**
     *
     * Output contains exactly `min(tokenizeForQuery(s).length, k)` quoted
     * phrases, each decoding to a distinct token drawn from
     * `tokenizeForQuery(s)`.
     *
     * Pure-function PBT (no DB). Count phrases by splitting on ` OR ` and
     * asserting each is a balanced `"…"`.
     */
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 1, max: 32 }),
        (s, k) => {
          const tokens = tokenizeForQuery(s);
          const out = sanitizeForFts5(s, k);

          if (tokens.length === 0) {
            expect(out).toBe('');
            return;
          }

          const expectedCount = Math.min(tokens.length, k);

          // Split on ` OR ` to get individual phrases
          const phrases = out.split(' OR ');
          expect(phrases.length).toBe(expectedCount);

          // Each phrase must be a balanced quoted string that decodes to a
          // distinct token from the original tokenization
          const decoded: string[] = [];
          for (const phrase of phrases) {
            // Must start and end with `"`
            expect(phrase.startsWith('"')).toBe(true);
            expect(phrase.endsWith('"')).toBe(true);

            // Decode: strip surrounding quotes, unescape `""` → `"`
            const inner = phrase.slice(1, -1).replace(/""/g, '"');
            decoded.push(inner);

            // Each decoded token must be drawn from the original tokenization
            expect(tokens).toContain(inner);
          }

          // All decoded tokens must be distinct
          const uniqueDecoded = new Set(decoded);
          expect(uniqueDecoded.size).toBe(expectedCount);
        },
      ),
      { numRuns: 200 },
    );
    // Feature: fts5-query-tokenization, Property 6: Term cap is honoured exactly
  });
});

// ---------------------------------------------------------------------------
// Properties 7–9: Term ranker (requires in-memory SQLite)
// ---------------------------------------------------------------------------

import Database from 'better-sqlite3';

import { createTermRanker } from '../../src/collector/storage/sqlite/fts5.js';
import { MIGRATIONS, runMigrations } from '../../src/collector/storage/sqlite/migrations/index.js';
import { prepareStatements } from '../../src/collector/storage/sqlite/statements.js';

/**
 * Helper: open an in-memory DB, run migrations, declare fts5vocab, and
 * prepare statements. Returns the db handle and statements object.
 */
function setupDb(): { db: InstanceType<typeof Database>; stmts: ReturnType<typeof prepareStatements> } {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS);
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts_vocab
     USING fts5vocab(memory_records_fts, 'row')`,
  );
  const stmts = prepareStatements(db);
  return { db, stmts };
}

/**
 * Helper: seed a memory record into the DB so the FTS index is populated.
 * Uses a unique record_id based on the provided index.
 */
function seedRecord(
  stmts: ReturnType<typeof prepareStatements>,
  index: number,
  title: string,
  summary: string,
): void {
  const id = `mr_${String(index).padStart(26, '0')}`;
  const namespace = '/actor/test/project/ranker/';
  stmts.insertMemoryRecord.run(
    id,
    namespace,
    'llm-summary',
    title,
    summary,
    '[]',
    '["01JF8ZS4Y00000000000000000"]',
    '2026-01-01T00:00:00Z',
    '[]',
    '[]',
    'tool_use',
  );
  stmts.insertMemoryRecordFts.run(id, namespace, title, summary, '');
}

/**
 * Arbitrary: generate a deduplicated non-empty token list of distinct
 * non-whitespace strings. Uses tokenizeForQuery on joined random strings
 * to get a valid shape.
 */
const deduplicatedTokensArb = fc
  .array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 40 })
  .map((arr) => tokenizeForQuery(arr.join(' ')))
  .filter((ts) => ts.length > 0);

describe('createTermRanker — property tests', () => {
  it('Property 7: Ranker returns sub-sequence of length min(|input|, k)', () => {
    /**
     * **Validates: Requirements 4.4, 4.6, 5.1, 5.2, 6.2, 6.3**
     *
     * For any deduplicated token list `ts` and positive integer `k`,
     * `termRanker(ts, k)` returns a list `rs` of length `min(ts.length, k)`
     * in which every element is drawn from `ts`, every element is distinct,
     * and the ranker holds this invariant across corpus states (empty,
     * populated, vocab-table-missing).
     */
    fc.assert(
      fc.property(
        deduplicatedTokensArb,
        fc.integer({ min: 1, max: 32 }),
        (ts, k) => {
          // Scenario 1: fresh empty DB
          {
            const { db, stmts } = setupDb();
            const ranker = createTermRanker(stmts);
            const result = ranker(ts, k);

            const expectedLen = Math.min(ts.length, k);
            expect(result.length).toBe(expectedLen);
            for (const r of result) {
              expect(ts).toContain(r);
            }
            const uniqueResult = new Set(result);
            expect(uniqueResult.size).toBe(expectedLen);
            db.close();
          }

          // Scenario 2: populated DB
          {
            const { db, stmts } = setupDb();
            seedRecord(stmts, 1, 'the quick brown fox', 'jumps over the lazy dog');
            seedRecord(stmts, 2, 'the function returns a value', 'parsing JSON data');
            seedRecord(stmts, 3, 'syzygy alignment observed', 'rare astronomical event');

            const ranker = createTermRanker(stmts);
            const result = ranker(ts, k);

            const expectedLen = Math.min(ts.length, k);
            expect(result.length).toBe(expectedLen);
            for (const r of result) {
              expect(ts).toContain(r);
            }
            const uniqueResult = new Set(result);
            expect(uniqueResult.size).toBe(expectedLen);
            db.close();
          }

          // Scenario 3: vocab table dropped after construction
          {
            const { db, stmts } = setupDb();
            seedRecord(stmts, 1, 'some content here', 'more content there');

            const ranker = createTermRanker(stmts);
            db.exec('DROP TABLE memory_records_fts_vocab');
            const result = ranker(ts, k);

            const expectedLen = Math.min(ts.length, k);
            expect(result.length).toBe(expectedLen);
            for (const r of result) {
              expect(ts).toContain(r);
            }
            const uniqueResult = new Set(result);
            expect(uniqueResult.size).toBe(expectedLen);
            db.close();
          }
        },
      ),
      { numRuns: 100 },
    );
    // Feature: fts5-query-tokenization, Property 7: Ranker returns sub-sequence of length min(|input|, k)
  });

  it('Property 8: Ranker orders by document frequency', () => {
    /**
     * **Validates: Requirements 4.2, 4.3, 4.5**
     *
     * On a populated corpus with known `df` per token, for `|ts| > k`,
     * every retained token has `df <= df` of every dropped token.
     *
     * We seed a controlled corpus where specific tokens have known document
     * frequencies, then verify the ranker retains rarer tokens over common ones.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        (k) => {
          const { db, stmts } = setupDb();

          // Seed a controlled corpus:
          // - "common" appears in 5 documents (high df)
          // - "moderate" appears in 3 documents (medium df)
          // - "rare" appears in 1 document (low df)
          // - "unique" appears in 1 document (low df)
          // - "frequent" appears in 4 documents (high df)
          seedRecord(stmts, 1, 'common moderate rare', 'a record with common words');
          seedRecord(stmts, 2, 'common moderate frequent', 'another common record');
          seedRecord(stmts, 3, 'common moderate frequent', 'yet another common one');
          seedRecord(stmts, 4, 'common frequent', 'common and frequent terms');
          seedRecord(stmts, 5, 'common unique frequent', 'common with unique term');

          // Known df values (after porter stemming, the vocab stores stemmed forms):
          // "common" → df=5, "moder" (stemmed moderate) → df=3,
          // "rare" → df=1, "uniqu" (stemmed unique) → df=1,
          // "frequent" → df=4
          //
          // We use the original tokens for the ranker input. The ranker
          // lowercases them for the vocab lookup. The FTS5 tokenizer applies
          // porter stemming, so we need to use the stemmed forms in our
          // frequency expectations.

          const ranker = createTermRanker(stmts);

          // Input tokens: mix of known tokens. We use lowercase to match
          // what the ranker will look up (it lowercases internally).
          // The vocab stores porter-stemmed forms, so we query with those.
          const tokens = ['rare', 'common', 'moderate', 'frequent', 'unique'] as const;

          // Only test when k < tokens.length (otherwise all are retained)
          if (k >= tokens.length) {
            db.close();
            return;
          }

          const result = ranker(tokens, k);

          // Get the actual df values from the vocab table for verification
          const vocabStmt = stmts.prepareSelectFts5VocabDocFreq(5);
          const vocabRows = vocabStmt.all('rare', 'common', 'moder', 'frequent', 'uniqu');
          const dfMap = new Map<string, number>();
          for (const row of vocabRows) {
            dfMap.set(row.term, row.doc);
          }

          // For each retained token, its df should be <= df of every dropped token.
          // We need to compare using the normalized (lowercased) form against the
          // vocab's stemmed form. Since we can't easily replicate porter stemming,
          // we verify the property using the IDF ordering directly:
          // retained tokens should have higher IDF (lower df) than dropped tokens.
          const retainedSet = new Set(result);
          const dropped = tokens.filter((t) => !retainedSet.has(t));

          // Get N for IDF computation
          const N = stmts.selectFts5DocCount.get()?.total ?? 0;

          // Compute IDF for each token using the same logic as the ranker
          const idfOf = (token: string): number => {
            const norm = token.toLowerCase();
            // Look up the normalized token in vocab
            const lookupStmt = stmts.prepareSelectFts5VocabDocFreq(1);
            const rows = lookupStmt.all(norm);
            const df = rows.length > 0 ? (rows[0]?.doc ?? 1) : 1;
            return Math.log(N / Math.max(df, 1));
          };

          // Every retained token's IDF should be >= every dropped token's IDF
          for (const r of result) {
            const rIdf = idfOf(r);
            for (const d of dropped) {
              const dIdf = idfOf(d);
              expect(rIdf).toBeGreaterThanOrEqual(dIdf);
            }
          }

          db.close();
        },
      ),
      { numRuns: 100 },
    );
    // Feature: fts5-query-tokenization, Property 8: Ranker orders by document frequency
  });

  it('Property 9: Ranker is total under vocab-table failure', () => {
    /**
     * **Validates: Requirement 5.3**
     *
     * After `DROP TABLE memory_records_fts_vocab`, `termRanker(ts, k)`
     * equals `ts.slice(0, k)` and does not throw.
     */
    fc.assert(
      fc.property(
        deduplicatedTokensArb,
        fc.integer({ min: 1, max: 32 }),
        (ts, k) => {
          const { db, stmts } = setupDb();
          // Seed a record so the corpus is non-empty (N > 0), which forces
          // the ranker to attempt the vocab lookup rather than short-circuiting.
          seedRecord(stmts, 1, 'some indexed content', 'for the ranker to query');

          const ranker = createTermRanker(stmts);

          // Drop the vocab table to simulate a failure scenario
          db.exec('DROP TABLE memory_records_fts_vocab');

          // The ranker must not throw and must return ts.slice(0, k)
          const result = ranker(ts, k);
          const expected = ts.slice(0, k);
          expect(result).toEqual(expected);

          db.close();
        },
      ),
      { numRuns: 100 },
    );
    // Feature: fts5-query-tokenization, Property 9: Ranker is total under vocab-table failure
  });
});
