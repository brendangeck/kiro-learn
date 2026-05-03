/**
 * Shared Unicode-whitespace tokeniser for the query layer.
 *
 * Splits a raw user query on Unicode whitespace, discards empty
 * tokens, and deduplicates preserving first-occurrence order. This
 * is the exact behaviour the FTS5 sanitiser in
 * `src/collector/storage/sqlite/fts5.ts` needs when it builds an
 * OR-of-phrases MATCH expression, AND the behaviour the hybrid-
 * search read path needs to answer the "is this query effectively
 * empty?" question before invoking the embedder.
 *
 * The function lives under `src/collector/query/` rather than
 * inside the sqlite backend so the `QueryLayer` (task 8.2) can
 * consult it without violating the modularity guard
 * (`src/collector/query/` must not import from
 * `src/collector/storage/sqlite/`, per AGENTS.md). The storage
 * backend re-exports it from `fts5.ts` for backward compatibility
 * with the existing property tests.
 *
 * Casing and non-whitespace content are unchanged — normalisation
 * (case folding, stemming, diacritic removal) is the FTS5
 * tokenizer's responsibility at index/query time, not this
 * module's.
 *
 * This module is pure. It imports nothing; in particular, it does
 * NOT import from `src/collector/storage/sqlite/`, `src/shim/`,
 * `src/installer/`, or `src/mcp/`.
 *
 * @see Requirements 1.1, 1.2, 1.3, 7.2, 7.3, 11.1 (fts5-query-tokenization)
 * @see Requirements 16.7 (local-embeddings-and-hybrid-search)
 * @module
 */

/**
 * Split `query` on Unicode whitespace, discard empty tokens, and
 * deduplicate preserving first-occurrence order.
 *
 * The returned array is readonly so callers cannot accidentally
 * mutate it across shared references. Input casing and non-
 * whitespace characters (including punctuation) are preserved
 * verbatim — this function does not attempt to match FTS5's
 * `unicode61` tokenizer; it only answers "what are the distinct
 * whitespace-separated spans?"
 *
 * Examples:
 *
 *   tokenizeForQuery('')          → []
 *   tokenizeForQuery('   ')       → []
 *   tokenizeForQuery('a b a')     → ['a', 'b']
 *   tokenizeForQuery('a\tb\nc')   → ['a', 'b', 'c']
 *
 * @param query - Raw user query string.
 * @returns Deduplicated, order-preserved, non-empty token list.
 *
 * @see Requirements 1.1, 1.2, 1.3, 7.2, 7.3, 11.1
 */
export function tokenizeForQuery(query: string): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.split(/\s+/u)) {
    if (raw === '') continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}
