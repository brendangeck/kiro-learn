/**
 * Property-based test for end-to-end tokenized retrieval (Property 10).
 *
 * Validates that any memory record sharing a tokenizer-emitted term with the
 * query is retrieved by `searchMemoryRecords`, and that queries with no token
 * overlap return empty results without invoking the LIKE fallback.
 *
 * @see .kiro/specs/fts5-query-tokenization/design.md § Correctness Properties — Property 10
 * @see .kiro/specs/fts5-query-tokenization/requirements.md § Requirements 13.1, 13.2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { tokenizeForQuery } from '../../src/collector/storage/sqlite/fts5.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { MemoryRecord } from '../../src/types/schemas.js';

/**
 * A set of distinctive single-word tokens that survive FTS5's
 * `porter unicode61 remove_diacritics 2` tokenizer with minimal stemming
 * distortion. These are used to seed records with known, retrievable tokens.
 *
 * Each word is chosen to be:
 * - Lowercase (no case-folding surprises)
 * - A single morpheme or a word whose Porter stem is itself (or very close)
 * - Unlikely to collide with random fc.string() output
 */
const DISTINCTIVE_TOKENS = [
  'quasar',
  'nebula',
  'photon',
  'plasma',
  'prism',
  'vortex',
  'zenith',
  'flux',
  'helix',
  'orbit',
  'pulsar',
  'sigma',
  'theta',
  'omega',
  'delta',
  'gamma',
  'alpha',
  'zephyr',
  'cipher',
  'nexus',
] as const;

describe('Property 10: End-to-end tokenized retrieval', () => {
  it('Any shared-token record is retrieved; no-intersection does not invoke LIKE', async () => {
    /**
     * **Validates: Requirements 13.1, 13.2**
     *
     * For any record `m` in namespace `ns` and any query `s` whose
     * tokenized-and-FTS5-tokenized term set intersects
     * `m.title ∪ m.summary ∪ m.facts`, `searchMemoryRecords({ namespace: ns,
     * query: s, limit: 10 })` includes `m`; conversely, if the intersection
     * is empty, the result does not include `m` and `selectMemoryRecordsLike`
     * is not invoked.
     */
    await fc.assert(
      fc.asyncProperty(
        // Generate N records (3–8) per iteration
        fc.integer({ min: 3, max: 8 }),
        // Pick a random index to select the "target" record for positive query
        fc.integer({ min: 0, max: 7 }),
        // Pick which distinctive tokens to assign to each record (up to 8 records × 3 tokens each)
        fc.array(
          fc.array(
            fc.integer({ min: 0, max: DISTINCTIVE_TOKENS.length - 1 }),
            { minLength: 1, maxLength: 3 },
          ),
          { minLength: 8, maxLength: 8 },
        ),
        async (n, targetIdx, tokenIndices) => {
          // Open a fresh in-memory DB per iteration to avoid PK collisions
          const storage = openSqliteStorage({ dbPath: ':memory:' });

          try {
            const namespace = '/actor/testuser/project/prop10/';
            const actualN = Math.min(n, 8);
            const actualTargetIdx = targetIdx % actualN;

            // Build N records, each with distinctive tokens in the title
            const records: MemoryRecord[] = [];
            const allUsedTokens = new Set<string>();

            for (let i = 0; i < actualN; i++) {
              const recordTokenIndices = tokenIndices[i]!;
              const recordTokens = recordTokenIndices.map((idx) => DISTINCTIVE_TOKENS[idx % DISTINCTIVE_TOKENS.length]!);

              // Track all tokens used across all records
              for (const t of recordTokens) {
                allUsedTokens.add(t);
              }

              const title = recordTokens.join(' ');
              const recordId = `mr_${String(i).padStart(26, '0')}`;

              records.push({
                record_id: recordId,
                namespace,
                strategy: 'llm-summary',
                title,
                summary: `summary for record ${String(i)}`,
                facts: [`fact about ${recordTokens[0] ?? 'unknown'}`],
                source_event_ids: ['01JF8ZS4Y00000000000000000'],
                created_at: '2026-01-01T00:00:00Z',
                concepts: ['testing'],
                files_touched: ['src/index.ts'],
                observation_type: 'tool_use',
              });
            }

            // Seed all records
            for (const record of records) {
              await storage.putMemoryRecord(record);
            }

            // --- Positive query: pick a token from the target record's title ---
            const targetRecord = records[actualTargetIdx]!;
            const targetTokens = tokenizeForQuery(targetRecord.title);
            // Pick the first token from the target record's title as the query
            const positiveQuery = targetTokens[0]!;

            const positiveResults = await storage.searchMemoryRecords({
              namespace,
              query: positiveQuery,
              limit: 10,
            });

            // The target record must be in the results
            const foundTarget = positiveResults.some(
              (r) => r.record_id === targetRecord.record_id,
            );
            expect(foundTarget).toBe(true);

            // --- Negative query: a substring of an indexed token ---
            // If we chose a purely numeric string, LIKE would also return []
            // (numeric patterns don't match alphabetic titles), so the test
            // couldn't distinguish "LIKE ran and returned 0" from "LIKE didn't
            // run". Instead, use a 3-letter substring of an indexed distinctive
            // token. FTS5 MATCH won't match (FTS5 indexes by token, not
            // substring), but LIKE's `%sub%` pattern WOULD match if invoked.
            // An empty result therefore proves LIKE did not run.
            //
            // Pick a 3-letter substring from an indexed token, avoiding any
            // token that happens to be fully contained in another.
            const firstUsedToken = Array.from(allUsedTokens)[0] ?? 'quasar';
            const substringQuery = firstUsedToken.slice(1, 4); // e.g. "uas" from "quasar"

            // Safety check: if the substring is itself a full indexed token
            // (unlikely with 3-letter substrings of distinctive words), skip.
            const substringTokens = tokenizeForQuery(substringQuery);
            const substringOverlap = substringTokens.some((t) => allUsedTokens.has(t));
            if (substringOverlap || substringQuery.length < 2) {
              return;
            }

            const negativeResults = await storage.searchMemoryRecords({
              namespace,
              query: substringQuery,
              limit: 10,
            });

            // FTS5 MATCH on a substring-not-a-token returns []. If LIKE had
            // been invoked as a fallback, `%uas%` would match "quasar" in a
            // seeded title and return the record. `[]` therefore proves the
            // LIKE fallback was not invoked — satisfying Requirement 13.2.
            expect(negativeResults).toEqual([]);
          } finally {
            await storage.close();
          }
        },
      ),
      { numRuns: 100 },
    );
    // Feature: fts5-query-tokenization, Property 10: Any memory record sharing a tokenizer-emitted term with the query is retrieved
  });
});
