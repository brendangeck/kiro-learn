/**
 * FTS5 query sanitisation helpers for the SQLite storage backend.
 *
 * FTS5's `MATCH` right-hand side is a query grammar, not a plain string:
 * unquoted tokens are matched as individual terms and symbols like `*`,
 * `(`, `)`, `:`, and the keywords `AND | OR | NOT | NEAR` have syntactic
 * meaning. Splicing a user-controlled string into that grammar is a
 * FTS5-equivalent of SQL injection — at best it produces surprising ranking,
 * at worst it throws a parse error and breaks the enrichment path.
 *
 * The sanitisation strategy tokenizes the user query on Unicode whitespace,
 * deduplicates preserving first-occurrence order, caps at `K` terms (default
 * 32), quotes each retained token as an FTS5 phrase (doubling interior `"`),
 * and joins with ` OR `. The result is a valid FTS5 MATCH expression that
 * matches any of the user's terms with BM25 ranking.
 *
 * When a DB handle is available, the factory `createFts5Sanitizer(db)` ranks
 * tokens by IDF from `fts5vocab` before capping. The standalone
 * `sanitizeForFts5` export is the DB-less fallback (first-K), preserved for
 * the co-located PBT and test-only callers.
 *
 * Kept in its own file — rather than inlined in `index.ts` — so the PBTs
 * can import it without reaching into the backend.
 *
 * @see Requirements 1.1–1.6, 2.1, 2.2, 3.1–3.4, 8.5, 10.1, 10.2, 12.2
 * @see .kiro/specs/fts5-query-tokenization/design.md § Components
 * @module
 */

import { tokenizeForQuery } from '../../query/tokenize.js';
import type { Statements } from './statements.js';

// Re-export so existing callers (including property tests) that
// import `tokenizeForQuery` from this module keep working. The
// canonical definition lives under `src/collector/query/` so the
// `QueryLayer` can consult it without importing sqlite-side code.
export { tokenizeForQuery };

/**
 * Tokenize a user query into deduplicated terms, cap at `termCap`, and build
 * an FTS5 OR-of-quoted-phrases expression.
 *
 * This is the DB-less "first-K fallback" branch of the sanitizer — equivalent
 * to what {@link createFts5Sanitizer} produces when the corpus is empty or
 * the token count is within the cap. It exists as a standalone export so the
 * co-located property-based tests can exercise the tokenize → build pipeline
 * without opening a SQLite handle on every iteration.
 *
 * Semantics:
 * - Splits the input on Unicode whitespace, deduplicates preserving
 *   first-occurrence order, retains the first `termCap` tokens.
 * - Each retained token is quoted as an FTS5 phrase (interior `"` doubled)
 *   and joined with ` OR `.
 * - Returns `""` (empty string) when the input tokenizes to zero tokens
 *   (empty or whitespace-only input). The backend treats `""` as a signal
 *   to skip the MATCH query and return `[]`.
 *
 * Runtime callers in the backend use the factory-produced closure from
 * `createFts5Sanitizer(db)` instead; this shim is effectively test-only.
 *
 * @param query  Raw user query string.
 * @param termCap  Maximum number of tokens to retain. Default `32`.
 * @returns An FTS5 MATCH expression or `""`.
 *
 * @see Requirements 1.1–1.6, 2.1, 2.2, 10.1, 10.2
 */
export function sanitizeForFts5(query: string, termCap: number = 32): string {
  const tokens = tokenizeForQuery(query);
  if (tokens.length === 0) return '';
  const retained = tokens.slice(0, termCap);
  return buildFts5OrQuery(retained);
}

/**
 * Escape LIKE-pattern metacharacters (`\`, `%`, `_`) so a user-supplied
 * query is matched as a literal substring rather than a wildcard pattern.
 *
 * The escape character is `\`, which must be declared in the SQL via
 * `ESCAPE '\'` for the escapes to be honoured by SQLite. The companion
 * prepared statement in `statements.ts` (`selectMemoryRecordsLike`)
 * includes that clause.
 *
 * Examples:
 *   escapeLikePattern('100%')    → '100\\%'
 *   escapeLikePattern('a_b')     → 'a\\_b'
 *   escapeLikePattern('c\\d')    → 'c\\\\d'
 *   escapeLikePattern('normal')  → 'normal'
 *
 * @see Requirements 8.5, 12.2
 */
export function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Join a non-empty list of tokens into an FTS5 OR-of-phrases expression.
 *
 * Each token is enclosed in double quotes (making it an FTS5 phrase where all
 * operators are inert) and any interior `"` is doubled per FTS5's escaping
 * convention. The resulting phrases are joined with the FTS5 `OR` keyword.
 *
 * Callers (the sanitizer and factory) must ensure the input is non-empty;
 * this helper does not handle the empty case.
 *
 * @see Requirements 1.4, 1.5, 3.1, 3.2, 3.3, 3.4
 */
export function buildFts5OrQuery(tokens: readonly string[]): string {
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * The signature of the term-ranker closure returned by {@link createTermRanker}.
 *
 * Given a deduplicated token list and a cap `k`, returns the top-`k` tokens
 * ordered by descending IDF (rare terms first). The function is total — it
 * never throws, falling back to `tokens.slice(0, k)` on any error.
 */
export interface TermRanker {
  (tokens: readonly string[], k: number): readonly string[];
}

/**
 * Factory that produces a handle-bound term ranker.
 *
 * The ranker queries `fts5vocab` for document frequencies, computes IDF
 * locally, and returns the top `k` tokens by descending IDF. It is total:
 * any SQLite error (including a missing vocab table) is caught and the
 * fallback `tokens.slice(0, k)` is returned.
 *
 * The ranker lowercases tokens for the vocab lookup (matching the FTS5
 * tokenizer's `unicode61` first step) but preserves original casing in the
 * output.
 *
 * @param stmts - The subset of prepared statements needed: `selectFts5DocCount`
 *   and `prepareSelectFts5VocabDocFreq`.
 * @returns A total `(tokens, k) => readonly string[]` closure.
 *
 * @see Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 9.1
 * @see .kiro/specs/fts5-query-tokenization/design.md § Components → createTermRanker
 */
/**
 * Factory that produces a handle-bound FTS5 sanitizer closure.
 *
 * Composes {@link tokenizeForQuery}, {@link createTermRanker}, and
 * {@link buildFts5OrQuery} behind a single `(query: string) => string`
 * surface. The closure captures the ranker and term cap by value so no
 * allocation beyond the token array happens on each call.
 *
 * Dataflow:
 * 1. Tokenize the input on Unicode whitespace, deduplicate.
 * 2. If zero tokens, return `''` (empty-guard).
 * 3. If token count ≤ K, retain all tokens.
 * 4. Otherwise, invoke the term ranker to select the top-K by IDF.
 * 5. Build and return the FTS5 OR-of-phrases expression.
 *
 * @param stmts - The subset of prepared statements needed by the term ranker.
 * @param opts - Optional configuration. `termCap` defaults to 32.
 * @returns A total `(query: string) => string` closure.
 *
 * @see Requirements 4.1, 10.3
 * @see .kiro/specs/fts5-query-tokenization/design.md § Architecture → Dataflow
 */
export function createFts5Sanitizer(
  stmts: Pick<Statements, 'selectFts5DocCount' | 'prepareSelectFts5VocabDocFreq'>,
  opts?: { termCap?: number },
): (query: string) => string {
  const K = opts?.termCap ?? 32;
  const ranker = createTermRanker(stmts);

  return (query: string): string => {
    const tokens = tokenizeForQuery(query);
    if (tokens.length === 0) return '';

    const retained = tokens.length <= K ? tokens : ranker(tokens, K);
    return buildFts5OrQuery(retained);
  };
}

export function createTermRanker(
  stmts: Pick<Statements, 'selectFts5DocCount' | 'prepareSelectFts5VocabDocFreq'>,
): TermRanker {
  return (tokens: readonly string[], k: number): readonly string[] => {
    // Step 1: shortcut when input fits within the cap.
    if (tokens.length <= k) return tokens;

    try {
      // Step 2: fetch total document count.
      const row = stmts.selectFts5DocCount.get();
      const N = row?.total ?? 0;

      // On empty corpus, IDF is meaningless — return first K in original order.
      if (N === 0) return tokens.slice(0, k);

      // Step 3: lowercase tokens for the vocab lookup (FTS5 tokenizer lowercases).
      const normalized = tokens.map((t) => t.toLowerCase());

      // Step 4: batch-query fts5vocab for document frequencies.
      const stmt = stmts.prepareSelectFts5VocabDocFreq(normalized.length);
      const rows = stmt.all(...normalized);

      // Step 5: build a Map<normalizedToken, df>.
      const docFreq = new Map<string, number>();
      for (const r of rows) {
        docFreq.set(r.term, r.doc);
      }

      // Step 6: compute IDF and stable-sort descending by IDF with
      // first-occurrence tie-breaking.
      const indexed = tokens.map((t, i) => {
        const norm = normalized[i]!;
        const df = docFreq.get(norm) ?? 1; // unseen → df=1 → maximum IDF
        const idf = Math.log(N / Math.max(df, 1));
        return { token: t, idf, originalIndex: i };
      });

      // Stable sort: descending IDF, then ascending original index for ties.
      indexed.sort((a, b) => {
        if (b.idf !== a.idf) return b.idf - a.idf;
        return a.originalIndex - b.originalIndex;
      });

      // Return the top k tokens.
      return indexed.slice(0, k).map((entry) => entry.token);
    } catch {
      // Any error in steps 2–6: fall back to first-K in original order.
      return tokens.slice(0, k);
    }
  };
}
