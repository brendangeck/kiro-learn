# Requirements Document

## Introduction

kiro-learn's retrieval pipeline currently fails in practice because the FTS5 query builder wraps the entire user prompt as a single quoted phrase. The `sanitizeForFts5` helper in `src/collector/storage/sqlite/fts5.ts` converts a string like `"how do I parse JSON in TypeScript"` into the literal FTS5 expression `"how do I parse JSON in TypeScript"` — a single-phrase match that requires the full prompt to appear verbatim, contiguously, in a stored memory record's indexed text. That substring essentially never occurs, so `searchMemoryRecords` returns an empty result set on nearly every retrieval request.

This feature replaces the "entire-query-as-one-phrase" strategy with a tokenized OR-of-terms construction that mirrors Elasticsearch's default `match` query. Inputs are split on whitespace, deduplicated (order-preserving), injection-safely re-quoted per term, and joined with ` OR ` so FTS5 can match any of the user's terms and rank by BM25. To bound query cost on large pasted inputs (entire source files, web pages), terms are capped at a configurable maximum `K` (default 32); when the corpus is large enough for inverse document frequency (IDF) to be meaningful, the retained terms are the top-`K` by IDF computed from FTS5's `fts5vocab` shadow table, so common tokens like `the`, `return`, `function` are automatically dropped in favour of rare, informative terms. On an empty or too-small corpus, the first `K` unique tokens are taken instead.

The changes are confined to the SQLite storage layer. The `sanitizeForFts5` signature (string in, string out, consumable as the right-hand side of `MATCH`) is preserved. The existing LIKE-based fallback stays intact as a belt-and-braces safety net, but the new construction is intended to always produce valid FTS5 syntax.

## Glossary

- **FTS5**: SQLite's full-text search module. Used by kiro-learn's `memory_records_fts` virtual table for lexical retrieval over memory records.
- **FTS5 phrase**: An FTS5 query token enclosed in double quotes. Inside a phrase, FTS5 operators (`AND`, `OR`, `NEAR`, `*`, `(`, `:`) are inert, and `"` is escaped by doubling to `""`.
- **MATCH expression**: The right-hand side of FTS5's `MATCH` operator. A grammar, not a plain string — unquoted tokens are matched terms and certain symbols have syntactic meaning.
- **Tokenizer**: FTS5's `porter unicode61 remove_diacritics 2` tokenizer (configured in migration 0001). Splits text into lowercased, diacritic-folded, Porter-stemmed terms.
- **fts5vocab**: A SQLite-provided shadow virtual table that exposes per-term statistics (document frequency, term frequency) for an FTS5 table. Queried by the backend to compute IDF.
- **IDF (Inverse Document Frequency)**: `log(N / df)` where `N` is the corpus document count and `df` is the number of documents containing a term. Rare terms have high IDF; common terms have low IDF.
- **Term cap `K`**: The maximum number of distinct tokens retained in the constructed OR query. Default `32`. Bounds worst-case FTS5 posting-list work per query.
- **Corpus**: The set of memory records indexed in the `memory_records_fts` virtual table for a given SQLite handle. IDF is computed against the full corpus regardless of namespace (namespace filtering is a separate predicate on the outer query).
- **Tokenizer_For_Query**: The pure function that turns a raw user query string into an ordered, deduplicated list of candidate tokens. Whitespace-split, empty-token-filtered.
- **Query_Builder**: The pure function (per-call) that takes a deduplicated token list plus a term-cap `K` and returns the final FTS5 `MATCH` expression string.
- **Term_Ranker**: The SQLite-backed component that, given a deduplicated token list, returns the subset of tokens ordered by descending IDF (computed from `fts5vocab`).
- **Sanitizer**: The exported `sanitizeForFts5` function in `src/collector/storage/sqlite/fts5.ts`. Composition of Tokenizer_For_Query, Term_Ranker, and Query_Builder behind a single `(string) => string` surface.

## Requirements

### Requirement 1: Tokenize-to-OR query construction

**User Story:** As a developer whose prompts are processed by kiro-learn's retrieval, I want my prompt split into individual terms that FTS5 can match against stored memory records with BM25 ranking, so that relevant prior observations actually surface instead of returning empty results.

#### Acceptance Criteria

1. WHEN a non-empty query string is passed to the Sanitizer, THE Sanitizer SHALL split the input on Unicode whitespace into candidate tokens.
2. WHEN candidate tokens are produced, THE Tokenizer_For_Query SHALL discard tokens that are empty strings after splitting.
3. WHEN candidate tokens are produced, THE Tokenizer_For_Query SHALL deduplicate tokens preserving first-occurrence order.
4. WHEN the deduplicated token list is non-empty, THE Query_Builder SHALL produce an FTS5 MATCH expression that joins each retained token with the FTS5 `OR` operator.
5. THE Query_Builder SHALL wrap each retained token as a single FTS5 phrase by enclosing the token in double quotes and doubling any interior `"` character.
6. THE Sanitizer SHALL return a string consumable as the right-hand side of a FTS5 `MATCH` operator without further transformation by the caller.
7. THE Sanitizer SHALL preserve its current TypeScript signature of `(query: string) => string` so no caller in `src/collector/storage/sqlite/index.ts` or elsewhere requires modification beyond the module itself.

### Requirement 2: Empty and whitespace-only inputs produce no query

**User Story:** As a developer whose retrieval pipeline must not emit broken FTS5 expressions, I want empty or whitespace-only inputs to be signalled to the caller so the search is skipped entirely instead of producing an invalid MATCH expression.

#### Acceptance Criteria

1. WHEN the input string is empty, THE Sanitizer SHALL return an empty string.
2. WHEN the input string contains only Unicode whitespace characters, THE Sanitizer SHALL return an empty string.
3. WHEN the Sanitizer returns an empty string, THE SQLite_Backend SHALL skip the FTS5 `MATCH` query and return an empty memory record array without invoking the LIKE fallback.

### Requirement 3: Injection safety under arbitrary Unicode input

**User Story:** As an operator of kiro-learn, I want the query builder to be safe against FTS5 syntax injection from any user input, so that a prompt containing FTS5 operators or special characters cannot cause a parse error or unexpected query semantics.

#### Acceptance Criteria

1. THE Query_Builder SHALL produce output that parses as a valid FTS5 MATCH expression for any Unicode input accepted by Requirement 1.
2. THE Query_Builder SHALL neutralise the FTS5 operators `AND`, `OR`, `NOT`, `NEAR`, `*`, `(`, `)`, `:`, and `^` when they appear inside a token by virtue of quoting each token as an FTS5 phrase.
3. THE Query_Builder SHALL escape every `"` character appearing inside a token by doubling it to `""` before the token is placed inside the phrase's quotes.
4. WHEN an input token consists entirely of FTS5-reserved characters, THE Query_Builder SHALL retain the token as a quoted phrase rather than dropping it silently.

### Requirement 4: IDF-based term capping from fts5vocab

**User Story:** As a developer who sometimes pastes large blocks of source code or web-page text into prompts, I want the retrieval query to retain only the most informative terms of my input, so that FTS5 does not load thousands of posting lists and degrade retrieval performance on common noise words.

#### Acceptance Criteria

1. THE Sanitizer SHALL accept a term-cap parameter `K` with a default value of `32`.
2. WHEN the deduplicated token count exceeds `K`, THE Term_Ranker SHALL query the `fts5vocab` shadow table for the `memory_records_fts` virtual table to obtain per-term document frequency values.
3. WHEN document frequency values are available for the input tokens, THE Term_Ranker SHALL compute inverse document frequency locally as `log(N / max(df, 1))` where `N` is the total document count in the `memory_records_fts` virtual table.
4. WHEN tokens are ranked by IDF, THE Term_Ranker SHALL sort in descending IDF order and return exactly the top `K` tokens.
5. WHEN a token from the input does not appear in `fts5vocab`, THE Term_Ranker SHALL assign it the IDF value for `df = 1` (the maximum observed IDF for the corpus) so unseen terms are preferred over common terms.
6. WHEN the deduplicated token count is less than or equal to `K`, THE Sanitizer SHALL retain every deduplicated token and SHALL NOT query `fts5vocab`.

### Requirement 5: Empty-corpus and small-corpus fallback

**User Story:** As a user of a freshly installed kiro-learn whose corpus is empty or tiny, I want retrieval to still work with a sensible query construction, so that the IDF path does not degrade the user experience while the corpus is being populated.

#### Acceptance Criteria

1. WHEN the `memory_records_fts` virtual table reports zero documents, THE Term_Ranker SHALL bypass the IDF computation and return the first `K` deduplicated tokens in first-occurrence order.
2. IF the `fts5vocab` query returns zero rows for every input token, THEN THE Term_Ranker SHALL return the first `K` deduplicated tokens in first-occurrence order.
3. IF the `fts5vocab` query throws a SQLite error, THEN THE Term_Ranker SHALL return the first `K` deduplicated tokens in first-occurrence order and SHALL NOT propagate the error to the caller.

### Requirement 6: Term cap is a ceiling, not a floor

**User Story:** As a developer submitting short prompts, I want every distinct token of my short query to be searched, so that the term cap does not artificially pad or shrink my input.

#### Acceptance Criteria

1. WHEN the deduplicated token count is less than or equal to `K`, THE Query_Builder SHALL include every deduplicated token in the output.
2. THE Query_Builder SHALL NOT introduce synthetic tokens that were absent from the input.
3. THE Query_Builder SHALL NOT duplicate any token in the output.

### Requirement 7: Tokenization determinism and idempotence

**User Story:** As a maintainer of kiro-learn's test suite, I want tokenization to be deterministic and idempotent so property tests can assert stable behaviour across runs and round-trips.

#### Acceptance Criteria

1. FOR ALL input strings `s`, THE Tokenizer_For_Query SHALL produce the same token list when invoked repeatedly on the same input within a single process.
2. FOR ALL input strings `s`, applying the Tokenizer_For_Query to the whitespace-join of `Tokenizer_For_Query(s)` SHALL produce the same token list as `Tokenizer_For_Query(s)`.
3. THE Tokenizer_For_Query SHALL preserve original token casing and original character sequence within each token; normalisation (case folding, stemming, diacritic removal) is the FTS5 tokenizer's responsibility at index and query time, not this module's.

### Requirement 8: Preserved LIKE fallback safety net

**User Story:** As an operator depending on retrieval availability, I want the existing LIKE-based fallback to remain in place so that any FTS5 parse error still yields results instead of a failed request.

#### Acceptance Criteria

1. THE SQLite_Backend SHALL retain its existing `try { FTS5 MATCH } catch { LIKE fallback }` structure in `searchMemoryRecords`.
2. WHEN the Sanitizer returns a non-empty string, THE SQLite_Backend SHALL pass that string to the `selectMemoryRecordsFtsMatch` prepared statement unchanged.
3. IF the `selectMemoryRecordsFtsMatch` prepared statement throws any error, THEN THE SQLite_Backend SHALL invoke the `selectMemoryRecordsLike` prepared statement with the original unsanitised query string escaped via `escapeLikePattern`.

### Requirement 9: fts5vocab access stays inside the SQLite backend

**User Story:** As a contributor who must respect kiro-learn's modularity guard tests, I want the fts5vocab lookup to live inside `src/collector/storage/sqlite/` so that the pipeline, retrieval, and query layers remain storage-agnostic.

#### Acceptance Criteria

1. THE Term_Ranker implementation SHALL reside entirely within `src/collector/storage/sqlite/`.
2. THE Sanitizer module SHALL be consumed only by `src/collector/storage/sqlite/index.ts` and its co-located tests.
3. THE fts5vocab prepared statement SHALL be declared in `src/collector/storage/sqlite/statements.ts` alongside existing prepared statements.
4. THE `src/collector/query/index.ts` and `src/collector/retrieval/index.ts` modules SHALL NOT import the Sanitizer or the Term_Ranker.

### Requirement 10: Backward-compatible Sanitizer surface

**User Story:** As a contributor maintaining the `sanitizeForFts5` export, I want the exported function signature to remain unchanged so existing callers and the co-located PBT module continue to work without modification.

#### Acceptance Criteria

1. THE Sanitizer SHALL continue to export a function named `sanitizeForFts5` from `src/collector/storage/sqlite/fts5.ts`.
2. THE exported `sanitizeForFts5` SHALL accept a single `string` parameter and return a `string`.
3. WHERE the Sanitizer requires a SQLite handle to access `fts5vocab`, THE module SHALL expose a factory function that binds the handle and returns a `(query: string) => string` closure so the backend can produce a handle-bound sanitizer at open time.
4. THE existing `escapeLikePattern` export in `src/collector/storage/sqlite/fts5.ts` SHALL remain unchanged in signature and behaviour.

### Requirement 11: Parser/printer round-trip property

**User Story:** As a maintainer relying on property-based testing to catch edge cases, I want the tokenizer and query builder to round-trip correctly under joining-and-retokenizing, so that the construction is provably stable under realistic whitespace inputs.

#### Acceptance Criteria

1. FOR ALL token lists `ts` produced by `Tokenizer_For_Query`, THE Tokenizer_For_Query SHALL satisfy `Tokenizer_For_Query(ts.join(' ')) === ts`.
2. FOR ALL deduplicated token lists `ts` of length at most `K`, THE Query_Builder SHALL produce an output in which each input token appears exactly once as a quoted FTS5 phrase.
3. FOR ALL Unicode input strings `s`, THE Sanitizer SHALL either return an empty string (per Requirement 2) or return a string that the `selectMemoryRecordsFtsMatch` prepared statement accepts without throwing.

### Requirement 12: Term cap is honoured for any input size

**User Story:** As an operator concerned with worst-case query cost, I want the term cap enforced unconditionally so that a pathological input (thousands of unique tokens) cannot cause FTS5 to load thousands of posting lists.

#### Acceptance Criteria

1. FOR ALL input strings `s` and term caps `K >= 1`, THE Query_Builder SHALL produce an output containing at most `K` quoted phrases separated by ` OR `.
2. WHEN the deduplicated token count exceeds `K`, THE Term_Ranker SHALL return exactly `K` tokens; it SHALL NOT return fewer unless the deduplicated token count is itself less than `K`.
3. THE Sanitizer SHALL enforce the term cap before the output string is constructed, so that no intermediate representation containing more than `K` tokens is retained.

### Requirement 13: Observable behaviour via the existing storage API

**User Story:** As a developer validating the fix end-to-end, I want retrieval to return non-empty results for realistic prompts against a populated corpus, so that the quality regression is provably closed.

#### Acceptance Criteria

1. WHEN `searchMemoryRecords` is invoked with a namespace that contains at least one memory record whose indexed text shares at least one token with the query, THE SQLite_Backend SHALL return that memory record in the result set ordered by FTS5 rank.
2. WHEN `searchMemoryRecords` is invoked with a query containing no tokens present in any indexed memory record for the namespace, THE SQLite_Backend SHALL return an empty array without invoking the LIKE fallback.
3. WHEN `searchMemoryRecords` is invoked with an empty or whitespace-only query, THE SQLite_Backend SHALL return an empty array without executing any SQL statement against `memory_records_fts` or `memory_records`.
