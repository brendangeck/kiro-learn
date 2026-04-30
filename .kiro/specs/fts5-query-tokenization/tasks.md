# Implementation Plan: FTS5 Query Tokenization

Tasks are in dependency order: prepared statements first (backend plumbing, isolated from call sites), then the lazy `fts5vocab` DDL, then the three pure helpers in `fts5.ts` each paired with their property-based tests, then the handle-bound ranker, then composition via the factory, then backend rewire. Finally the existing test sweep — flagged as likely-breaking — and the end-to-end retrieval property test, closing with typecheck + full suite.

Property IDs (P1–P10) reference the Correctness Properties section of `design.md`. Each property is implemented in a dedicated sub-task that references the property number and the requirement clauses it validates.

## Tasks

- [x] 1. Add prepared statements for fts5vocab lookup
  - All changes land in `src/collector/storage/sqlite/statements.ts`. The two new entries are the only additions to `Statements`; no existing statement is touched.

  - [x] 1.1 Add `selectFts5DocCount` prepared statement
    - Fixed-arity statement: `SELECT COUNT(*) AS total FROM memory_records`. No parameters.
    - Row shape: `{ total: number }`.
    - Declared alongside the existing read-API count statements.
    - _Requirements: 4.3, 5.1, 9.3_

  - [x] 1.2 Add `prepareSelectFts5VocabDocFreq(arity)` factory
    - Not a prepared statement directly — a function on the returned `Statements` object that, given a positive integer `arity`, returns a `Statement<string[], { term: string; doc: number }>`.
    - Internally memoised in a `Map<number, Statement>` scoped to the handle so each distinct arity is prepared at most once per process.
    - Generated SQL: `SELECT term, doc FROM memory_records_fts_vocab WHERE term IN (?, ?, …)` with one `?` per arity slot.
    - _Requirements: 4.2, 9.3_

  - [x] 1.3 Example tests for the two new prepared statements
    - `selectFts5DocCount` against an empty DB returns `{ total: 0 }`; against a seeded DB returns the inserted count.
    - `prepareSelectFts5VocabDocFreq(3).all('a', 'b', 'c')` on a seeded DB returns rows for the terms that were indexed, with the tokenizer-normalised spelling.
    - Calling the factory twice with the same arity returns the same `Statement` instance (cache hit).
    - Added to `test/unit/sqlite-backend.test.ts`.
    - _Requirements: 4.2, 4.3, 5.1_

- [x] 2. Lazily declare `memory_records_fts_vocab` in `openSqliteStorage`
  - Added as a single `db.exec(...)` call inside `openSqliteStorage`, between `runMigrations(...)` and `prepareStatements(...)`. Not a migration (design § Migration Concerns).

  - [x] 2.1 Emit `CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts_vocab USING fts5vocab(memory_records_fts, 'row')`
    - Runs once per open; `IF NOT EXISTS` makes re-open a no-op.
    - Placed before `prepareStatements(db)` so the vocab prepared statements (task 1) compile against an existing table.
    - On failure, the surrounding `try { … } catch (err) { db.close(); throw err; }` in `openSqliteStorage` closes the handle and rethrows (no leaked DB lock).
    - _Requirements: 4.2, 9.1_

  - [x] 2.2 Example test for the lazy DDL
    - Open a fresh `:memory:` DB, assert `memory_records_fts_vocab` is listed by `PRAGMA table_list`.
    - Close and reopen the same file (or simulate via `openSqliteStorage` twice on a shared path); assert no error is thrown on the second open.
    - Not a PBT — one-shot DDL, example coverage is sufficient (per user instruction).
    - Added to `test/unit/sqlite-backend.test.ts`.
    - _Requirements: 4.2_

- [x] 3. Implement `tokenizeForQuery` in `fts5.ts`
  - Pure helper. Splits on `/\s+/u`, filters empties, deduplicates preserving first-occurrence order. Exported as a named export so the PBTs can import it directly.

  - [x] 3.1 Write `tokenizeForQuery(query: string): readonly string[]`
    - Matches the pseudocode in `design.md` § Components: `split → filter empty → first-occurrence dedup via Set`.
    - TSDoc references Requirements 1.1, 1.2, 1.3, 7.2, 7.3, 11.1.
    - _Requirements: 1.1, 1.2, 1.3, 7.1, 7.2, 7.3_

  - [x] 3.2 Property test — Property 1 (Tokenizer round-trip)
    - **Property 1: Tokenizer round-trip** — every token is non-empty, contains no `\s`, appears once; `tokenizeForQuery(ts.join(' ')) === ts`.
    - **Validates: Requirements 1.1, 1.2, 1.3, 7.2, 11.1**
    - Input: `fc.fullUnicodeString()`. Iterations ≥ 100.
    - Added to `test/unit/sqlite-fts5-sanitize.property.test.ts` (new file, or extension of existing co-located PBT — pick one, reference in TSDoc header).
    - _Requirements: 1.1, 1.2, 1.3, 7.2, 11.1_

  - [x] 3.3 Property test — Property 2 (Tokens are substrings of input)
    - **Property 2: Tokens are substrings of input** — every token in `tokenizeForQuery(s)` appears verbatim as a contiguous substring of `s` with original casing preserved.
    - **Validates: Requirement 7.3**
    - Input: `fc.fullUnicodeString()`. Iterations ≥ 100.
    - Same file as 3.2.
    - _Requirements: 7.3_

- [x] 4. Implement `buildFts5OrQuery` in `fts5.ts`
  - Pure helper. Quotes each token as a phrase (doubling `"`), joins with ` OR `. Caller guarantees non-empty input.

  - [x] 4.1 Write `buildFts5OrQuery(tokens: readonly string[]): string`
    - Matches the pseudocode in `design.md` § Components: `tokens.map(t => ``"${t.replace(/"/g, '""')}"``).join(' OR ')`.
    - Callers (sanitizer / factory) must ensure the input is non-empty; this helper does not handle the empty case.
    - TSDoc references Requirements 1.4, 1.5, 3.1–3.4.
    - _Requirements: 1.4, 1.5, 3.1, 3.2, 3.3, 3.4_

  - [x] 4.2 Property test — Property 3 (Query builder round-trips every token)
    - **Property 3: Query builder round-trips every token as an escaped phrase** — output is exactly `ts.length` quoted phrases joined by exactly `ts.length - 1` `OR` separators, where the `i`-th phrase decodes (strip surrounding `"`, replace `""` with `"`) to `ts[i]`, and no other quoted phrases appear.
    - **Validates: Requirements 1.4, 1.5, 3.2, 3.3, 3.4, 6.2, 6.3, 11.2**
    - Arbitrary: `fc.array(fc.fullUnicodeString(), { minLength: 1, maxLength: 32 })` filtered to deduplicated non-empty tokens (use the output of `tokenizeForQuery` on a joined input to get a free valid shape).
    - Iterations ≥ 100. Same file as 3.2.
    - _Requirements: 1.4, 1.5, 3.2, 3.3, 3.4, 6.2, 6.3, 11.2_

- [x] 5. Implement the `sanitizeForFts5` shim over 3 and 4
  - Preserves the existing export's signature `(query: string, termCap?: number) => string`. No DB handle. Equivalent to the factory's "first-K fallback" branch.

  - [x] 5.1 Replace the body of `sanitizeForFts5` with `tokenize → first-K → build`
    - On empty tokenization, return `""`.
    - Default `termCap = 32`.
    - Existing co-located PBT at `test/unit/sqlite-backend.property.test.ts` § "sanitizeForFts5 output shape (task 6.6A)" MUST be audited separately in task 9 — it asserts `out.startsWith('"')` which now fails on empty input.
    - TSDoc updated to describe the new semantics (tokenized OR, not single phrase) and note the shim is test-only; runtime callers use the factory.
    - _Requirements: 1.1–1.6, 2.1, 2.2, 10.1, 10.2_

  - [x] 5.2 Property test — Property 4 (Sanitizer output is valid FTS5 or empty)
    - **Property 4: Sanitizer output is always valid FTS5 or empty** — for any input `s` and `k ≤ 32`, `sanitizeForFts5(s, k)` is either `""` or a string that `selectMemoryRecordsFtsMatch` accepts without throwing.
    - **Validates: Requirements 1.6, 3.1, 11.3**
    - Uses an in-memory SQLite handle opened once in `beforeEach` (from `openSqliteStorage({ dbPath: ':memory:' })`). The test seeds zero or one record — only the prepared statement's `.all(...)` is being exercised, not the results.
    - Iterations ≥ 100.
    - _Requirements: 1.6, 3.1, 11.3_

  - [x] 5.3 Property test — Property 5 (Empty output iff empty tokenization, backend skips SQL)
    - **Property 5: Empty sanitizer output iff empty tokenization, and the backend skips SQL in that case** — `sanitizeForFts5(s) === ''` ⇔ `tokenizeForQuery(s).length === 0`. When `''`, `backend.searchMemoryRecords(...)` returns `[]` without invoking either prepared statement.
    - **Validates: Requirements 2.1, 2.2, 2.3, 13.3**
    - The "backend skips SQL" half uses a spy — wrap the two prepared statements in proxies that set a flag on `.all(...)` and assert the flags are unset after the call.
    - This task depends on task 8 (backend rewire) for the "skip SQL" branch; until then, this PBT asserts only the biconditional half and the other half lands when task 8 is complete. An acceptable alternative is to defer authoring 5.3 until after task 8 — whichever order matches the implementer's rhythm, but the requirements reference remains.
    - Iterations ≥ 100.
    - _Requirements: 2.1, 2.2, 2.3, 13.3_

  - [x] 5.4 Property test — Property 6 (Term cap honoured exactly)
    - **Property 6: Term cap is honoured exactly** — output contains exactly `min(tokenizeForQuery(s).length, k)` quoted phrases, each decoding to a distinct token drawn from `tokenizeForQuery(s)`.
    - **Validates: Requirements 6.1, 12.1, 12.2, 12.3**
    - Pure-function PBT (no DB). Count phrases by splitting on ` OR ` and asserting each is a balanced `"…"`.
    - Iterations ≥ 100.
    - _Requirements: 6.1, 12.1, 12.2, 12.3_

- [x] 6. Implement `createTermRanker(db)` in `fts5.ts`
  - Handle-bound factory producing a total `(tokens, k) => readonly string[]`. Lowercases tokens for the vocab lookup but preserves original casing in the output. Wraps all vocab access in a single `try/catch` that falls back to `tokens.slice(0, k)`.

  - [x] 6.1 Write the ranker factory
    - Steps 1–6 per `design.md` § Components → `createTermRanker`: shortcut when `tokens.length <= k`; fetch `N`; on `N === 0`, return `tokens.slice(0, k)`; batch-query `prepareSelectFts5VocabDocFreq(tokens.length).all(...normalized)`; build `Map<string, number>` keyed by normalised token; compute `idf = log(N / max(df, 1))`; stable-sort descending by IDF with first-occurrence tie-breaking.
    - Stable sort: attach original index to each token, sort by `(−idf, originalIndex)` lexicographically.
    - Wrap steps 2–6 in `try/catch` → on any throw, return `tokens.slice(0, k)`.
    - The ranker is internal to `fts5.ts` (not exported), consumed only by `createFts5Sanitizer`.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 9.1_

  - [x] 6.2 Property test — Property 7 (Ranker returns sub-sequence of length min(|input|, k))
    - **Property 7: Term ranker returns a sub-sequence of its input of length min(|input|, k)** — every element of `termRanker(ts, k)` is drawn from `ts`, every element is distinct, length is `min(ts.length, k)`; holds across corpus states (empty, populated, vocab-missing).
    - **Validates: Requirements 4.4, 4.6, 5.1, 5.2, 6.2, 6.3**
    - In-memory DB, three scenarios run per iteration: fresh empty DB, populated DB (seed a handful of `memoryRecordArb()` records), `DROP TABLE memory_records_fts_vocab` after construction.
    - Iterations ≥ 100.
    - _Requirements: 4.4, 4.6, 5.1, 5.2, 6.2, 6.3_

  - [x] 6.3 Property test — Property 8 (Ranker orders by document frequency)
    - **Property 8: Term ranker orders by document frequency** — on a populated corpus with known `df` per token (unseen ⇒ `df = 1`), for `|ts| > k`, every retained token has `df <= df` of every dropped token.
    - **Validates: Requirements 4.2, 4.3, 4.5**
    - Arbitrary: seed a small controlled corpus where the test fixes `df(t)` for a known set of tokens (e.g. `the` indexed in 5 records, `syzygy` in 1). The property is asserted over an arbitrary interleaving of known tokens plus unseen tokens.
    - Iterations ≥ 100 against the per-iteration shuffled input; the seeded corpus is built once per PBT iteration using the arbitrary's `preconditionedSeed` pattern from `test/helpers/arbitrary.ts`.
    - _Requirements: 4.2, 4.3, 4.5_

  - [x] 6.4 Property test — Property 9 (Ranker is total under vocab-table failure)
    - **Property 9: Term ranker is total under vocab-table failure** — after `DROP TABLE memory_records_fts_vocab`, `termRanker(ts, k) === ts.slice(0, k)` and does not throw.
    - **Validates: Requirement 5.3**
    - Per iteration: open DB, construct ranker, `db.exec('DROP TABLE memory_records_fts_vocab')`, invoke ranker, assert deep equality with `ts.slice(0, k)`.
    - Iterations ≥ 100.
    - _Requirements: 5.3_

- [x] 7. Implement `createFts5Sanitizer(db, opts?)` factory in `fts5.ts`
  - Exported. Composes `tokenizeForQuery`, `createTermRanker(db)`, and `buildFts5OrQuery` behind a `(query: string) => string` closure. Default `termCap = 32` from `opts?.termCap ?? 32`.

  - [x] 7.1 Write the factory
    - Dataflow per `design.md` § Architecture → "Dataflow inside `createFts5Sanitizer(db)`": tokenize → empty-guard → cap check → either retain-all or ranker → build → return.
    - The ranker is constructed once inside the factory; the closure captures it by value.
    - TSDoc: single `@see Requirements 4.1, 10.3` block; reference the dataflow diagram.
    - _Requirements: 4.1, 4.2, 4.6, 6.1, 9.1, 9.2, 10.3, 12.3_

  - [x] 7.2 Example tests for the factory
    - Empty corpus: any input with > K tokens falls back to first-K and returns a valid OR expression.
    - Populated corpus: input `"the syzygy the the"` against a corpus where `the` has high df and `syzygy` has df 1 returns tokens ordered `[syzygy, the]` — dedup applied before ranking, and the IDF signal wins.
    - Casing: ranker lowercases `"JSON"` for the vocab lookup but the output phrase is `"JSON"` (original casing preserved).
    - Detaching `memory_records_fts_vocab` after construction still yields a valid OR expression from the first-K fallback.
    - Added to `test/unit/sqlite-backend.test.ts` or a new `test/unit/sqlite-fts5-factory.test.ts` — implementer's choice.
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 5.1, 5.3, 6.1_

- [x] 8. Rewire `openSqliteStorage` to use the handle-bound sanitizer
  - `src/collector/storage/sqlite/index.ts`. Import `createFts5Sanitizer` alongside existing imports. Construct one sanitizer per open. `searchMemoryRecords` calls the closure instead of the free function.

  - [x] 8.1 Build the sanitizer once at open time
    - After `prepareStatements(db)`, add `const sanitize = createFts5Sanitizer(db);` inside the same `try { … } catch { db.close(); throw; }` so any failure during sanitizer construction leaves no leaked handle.
    - _Requirements: 1.7, 9.1, 10.3_

  - [x] 8.2 Short-circuit empty sanitizer output in `searchMemoryRecords`
    - Before the existing `try { selectMemoryRecordsFtsMatch } catch { selectMemoryRecordsLike }` block: `const match = sanitize(query); if (match === '') return [];`.
    - In the `try` branch, pass `match` (not `sanitizeForFts5(query)`) to `selectMemoryRecordsFtsMatch.all(...)`.
    - The `catch` branch continues to call `selectMemoryRecordsLike` with `escapeLikePattern(query)` — Requirement 8.3 keeps LIKE fed from the original unsanitised string.
    - Remove the now-unused top-level `sanitizeForFts5` import if no other call site uses it (it stays exported from `fts5.ts` for the shim's test-only callers).
    - _Requirements: 2.3, 8.1, 8.2, 8.3, 13.3_

  - [x] 8.3 Example tests for backend wiring
    - Empty query and whitespace-only query return `[]`; the two prepared statements are not invoked (spy/proxy on `.all`).
    - Two memory records with no common substring beyond a single shared token; a query containing that token returns both records ordered by FTS5 rank.
    - Added to `test/unit/sqlite-backend.test.ts`.
    - _Requirements: 2.3, 13.1, 13.3_

- [x] 9. Audit and update existing tests whose expectations are at odds with tokenized-OR semantics
  - **⚠ This task is likely-breaking.** Before editing any test, enumerate the full list of affected tests so reviewers can audit the scope. Do this in 9.1 as a dry-run pass. Do not mix the enumeration commit with the edit commit.

  - [x] 9.1 Enumerate existing tests that will change behaviour
    - Produce a list (commit as a comment block or a scratch markdown file under this spec directory) of every test case in `test/unit/sqlite-backend.test.ts` and `test/unit/sqlite-backend.property.test.ts` whose assertion depends on the old single-phrase-match semantics.
    - Expected categories (per `design.md` § "Tests that must change"):
      - Tests asserting that a multi-word query against a record whose text does not contain the exact phrase returns an empty result.
      - Tests asserting that `sanitizeForFts5(s)` starts with `"` / ends with `"` / is length ≥ 2 — the existing PBT at task 6.6A violates all three on empty input.
      - Tests asserting exact FTS5 MATCH expressions (strings like `"how do I parse"`).
    - The list stands on its own as the scope-of-change record; no source files edited in this sub-task.
    - _Requirements: 13.1, 13.2_

  - [x] 9.2 Update the tests enumerated in 9.1
    - For empty-phrase-match tests: change the expectation from `[]` to "includes the seeded record" when tokens overlap; keep `[]` when tokens do not overlap.
    - For the 6.6A PBT (`sanitizeForFts5 output shape`): update the property to branch on empty input — assert `out === ''` when the input tokenises to zero tokens, otherwise assert the quoted-OR shape (each ` OR `-separated segment balanced-quoted). Update the TSDoc validation reference from "Requirement 12.2" to "Requirements 1.4, 1.5, 3.2, 3.3, 3.4" — Property 3 supersedes the old shape assertion.
    - For exact-MATCH-string assertions: update the expected string to the OR-of-phrases shape, or relax the assertion to "matches the record by any token".
    - Do not loosen assertions just to make them pass — every change must match the new semantics described in `design.md`.
    - _Requirements: 1.4, 1.5, 13.1, 13.2_

  - [x] 9.3 Confirm the shim's remaining callers still pass
    - Enumerate all import sites of `sanitizeForFts5` (outside `src/collector/storage/sqlite/index.ts`, which switches to the factory in task 8). Expected set: `test/unit/sqlite-backend.property.test.ts` task 6.6A (updated in 9.2), and any other test file still calling the shim directly.
    - For each call site that remains after 9.2, verify the test passes against the new shim — no production call site should remain (task 8.2 removed it).
    - _Requirements: 10.1, 10.2_

- [x] 10. End-to-end retrieval property test — Property 10
  - The acceptance criterion that pins down the user-visible fix: any shared-token query retrieves the record; no-intersection queries do not invoke LIKE.

  - [x] 10.1 Property test — Property 10 (Any shared-token record is retrieved, no-intersection doesn't invoke LIKE)
    - **Property 10: Any memory record sharing a tokenizer-emitted term with the query is retrieved** — for any record `m` in namespace `ns` and any query `s` whose tokenized-and-FTS5-tokenized term set intersects `m.title ∪ m.summary ∪ m.facts`, `searchMemoryRecords({ namespace: ns, query: s, limit: 10 })` includes `m`; conversely, if the intersection is empty, the result does not include `m` and `selectMemoryRecordsLike` is not invoked.
    - **Validates: Requirements 13.1, 13.2**
    - Use `memoryRecordArb()` from `test/helpers/arbitrary.ts`. Seed N records per iteration (3 ≤ N ≤ 8). Derive a positive query by drawing one indexed token from a record at random; derive a negative query from a synthetic token guaranteed not to appear (use a random `fc.string()` filtered against the indexed vocabulary).
    - Proxy `selectMemoryRecordsLike.all` and assert the counter stays at 0 across the entire property run.
    - Iterations ≥ 100. New file `test/unit/sqlite-backend-tokenized-retrieval.property.test.ts`.
    - _Requirements: 13.1, 13.2_

- [x] 11. Integration test — full retrieval path through HTTP layer
  - Exercises the complete retrieval flow: POST /v1/events?retrieve=true → receiver → retrieval assembler → query layer → storage → FTS5 → response with context. Lives in `test/integ/` alongside the existing extraction and agent-create integration tests.

  - [x] 11.1 Write `test/integ/tokenized-retrieval.test.ts`
    - Start a real collector daemon (via `startCollector()`) on a random port with an in-memory or temp-file SQLite DB.
    - Seed 3–5 memory records via `POST /v1/memories` with known titles, summaries, and concepts containing distinctive tokens (e.g. `"syzygy"`, `"quasar"`, `"zephyr"`).
    - POST a prompt event via `POST /v1/events?retrieve=true` with a body containing one of the seeded tokens (e.g. `"tell me about syzygy"`).
    - Assert the response includes a non-empty `retrieval.context` string containing the `## Prior observations from kiro-learn` header and the matching record's title.
    - POST a second prompt event with a body containing no seeded tokens (e.g. `"completely unrelated xylophone"`).
    - Assert the response has either no `retrieval` field or an empty `retrieval.context`.
    - Shut down the collector cleanly via `handle.close()`.
    - _Requirements: 13.1, 13.2, 13.3_

  - [x] 11.2 Verify the integration test passes
    - Run `npm run test:integ` and confirm the new test passes alongside the existing integration tests.
    - This test does NOT require `kiro-cli` or Bedrock credentials — it only exercises the collector's HTTP layer and SQLite storage, both of which are local.
    - _Requirements: 13.1, 13.2_

- [x] 12. Final verification — typecheck + full unit suite green
  - Local gate before handing off. Every sub-step must exit 0 before the task is marked complete.

  - [x] 12.1 `npm run typecheck`
    - Confirms the new named exports, the `prepareSelectFts5VocabDocFreq` factory signature on `Statements`, and the ranker's `Map`-based lookup all type-check under `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess`.
    - _Requirements: —_

  - [x] 12.2 `npm run lint`
    - No new ESLint violations. Expect `@typescript-eslint/consistent-type-imports` to catch any accidental value-import of the `Database` type in `fts5.ts`.
    - _Requirements: —_

  - [x] 12.3 `npm run test`
    - Full unit suite passes. Expect the updated tests from task 9.2 to pass, the new PBTs from tasks 3–7 and 10 to pass, and the modularity guards (`test/unit/no-sqlite-in-pipeline.test.ts` et al.) to remain green — no new imports cross the `storage/sqlite/` boundary.
    - If any PBT fails, use the fast-check counterexample to diagnose before retrying. Do not raise the iteration count to paper over a failure.
    - _Requirements: all — end-to-end verification_

## Notes

- Tasks marked with `*` are optional (test-only sub-tasks); core implementation tasks are never optional per spec conventions.
- Each correctness property P1–P10 has its own dedicated sub-task (3.2, 3.3, 4.2, 5.2, 5.3, 5.4, 6.2, 6.3, 6.4, 10.1) annotated with the property number and the requirement clauses it validates.
- Task 2 (lazy `CREATE VIRTUAL TABLE IF NOT EXISTS`) uses example tests only — one-shot DDL, no property surface worth exploring, per spec author's instruction.
- Task 9 is flagged ⚠ likely-breaking. Sub-task 9.1 enumerates the scope before any edit lands so reviewers can audit the change set.
- Task 5.1 preserves the `sanitizeForFts5` export for test-only callers. The shim's semantics change (empty input now returns `""`), which breaks one existing PBT — updating that PBT is the responsibility of task 9.2, not 5.1.
- Property 5 (task 5.3) depends on task 8 for its backend-skips-SQL half. Implementers can author 5.3 after 8.2 lands, or author it up-front and leave the backend assertion pending until 8.2 — either order is fine, but the cross-reference is documented here so the dependency is not silent.
- No migration added for `memory_records_fts_vocab`: it is a stateless view over `memory_records_fts` and is declared lazily at open time (design § Migration Concerns). The migration stack stays at four entries.
