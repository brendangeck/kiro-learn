# Task 9 — Scope of Change: Tests Affected by Tokenized-OR Semantics

This document enumerates every test case whose assertion depends on the old
single-phrase-match semantics and must be updated for the new tokenized-OR
construction.

## Affected Tests

### 1. `test/unit/sqlite-backend.property.test.ts` — "sanitizeForFts5 output shape (task 6.6A)"

**Category:** Tests asserting that `sanitizeForFts5(s)` starts with `"` / ends with `"` / is length ≥ 2.

**Current assertion:**
```ts
fc.property(fc.string(), (q) => {
  const out = sanitizeForFts5(q);
  expect(out.startsWith('"')).toBe(true);
  expect(out.endsWith('"')).toBe(true);
  expect(out.length).toBeGreaterThanOrEqual(2);
  // interior quote pairing check
});
```

**Why it breaks:** The new `sanitizeForFts5("")` returns `''` (empty string) for
empty/whitespace-only input. The old implementation returned `""` (a quoted empty
phrase). The counterexample is `[""]` — an empty string input.

**Required update:** Branch on empty input — assert `out === ''` when the input
tokenises to zero tokens; otherwise assert the quoted-OR shape (each ` OR `-separated
segment is a balanced `"…"` phrase). Update the TSDoc validation reference from
"Requirement 12.2" to "Requirements 1.4, 1.5, 3.2, 3.3, 3.4" — Property 3
supersedes the old shape assertion.

---

### Summary

Only **one test** is affected:

| File | Test Name | Category |
|------|-----------|----------|
| `test/unit/sqlite-backend.property.test.ts` | `sanitizeForFts5 output shape (task 6.6A)` | Output shape assertion violates on empty input |

### Tests NOT affected (confirmed passing)

The following tests in `test/unit/sqlite-backend.test.ts` were reviewed and
**already pass** under the new semantics:

- **Task 5.8 happy path** — queries `'summary'` (single token), returns both records. ✓
- **Task 5.11 FTS5 malformed-query fallback** — the empty string case returns `[]`
  (short-circuit), which is still an array. The `'*'`, `'"'`, `'NEAR'` cases all
  produce non-empty tokenizations that the new sanitizer handles correctly. ✓
- **Task 5.12 persistence** — queries `'persistent'` (single token). ✓
- **Task 8 handle-bound sanitizer wiring** — tests empty, whitespace, and shared-token
  queries. Written for the new semantics. ✓
- **Task 1 fts5vocab statements** — no search assertions. ✓
- **Task 2 lazy DDL** — no search assertions. ✓

The `test/unit/sqlite-fts5-sanitize.property.test.ts` file (Properties 1–9) was
written for the new semantics and passes cleanly.

### Tests that were candidates but are NOT affected

- **Task 5.11 empty string case:** The test asserts `Array.isArray(result) === true`.
  Under the new semantics, `searchMemoryRecords` short-circuits on empty input and
  returns `[]`. The assertion still holds. The TSDoc comment is slightly outdated
  (mentions "sanitizeForFts5 wraps every user query in a phrase") but the assertion
  itself is correct. No code change needed — the comment is documentation, not a
  test expectation.

- **No tests assert exact FTS5 MATCH expression strings** (like `"how do I parse"`).
  The existing tests use `searchMemoryRecords` end-to-end and check result sets,
  not the intermediate MATCH expression.

- **No tests assert that a multi-word query returns empty** when tokens overlap with
  the seeded record. The existing tests either use single-token queries or were
  written for the new semantics (task 8).
