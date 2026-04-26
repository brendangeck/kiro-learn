# Implementation Plan: Project Path Capture

Tasks are organised in strict dependency order. The wire type comes first so every layer below it can import the new optional field. The shim changes next — `detectProjectRoot` is a leaf module that only depends on the type. Storage lands last, and within storage the migration precedes the insert-path change so the `project_path` column exists before `putEvent` tries to bind it. Property and example tests sit close to the code they cover so a failed implementation surfaces at the nearest checkpoint instead of in a final verification pass.

Every task below cites the specific requirement sub-clauses it implements. Every test task cites either the correctness-property number from [design.md § Correctness Properties](./design.md#correctness-properties) or the requirement number it validates. File-name mappings for tests come from [design.md § Testing Strategy](./design.md#testing-strategy) and must be followed exactly.

- [x] 1. Extend the wire contract with optional `project_path`
  - Additive schema change before anything else. With the field in place, both the shim (writer) and storage (bindings + migration) can be written against the final type without intermediate shims.

  - [x] 1.1 Add `project_path` to `EventSourceSchema` in `src/types/schemas.ts`
    - Add `project_path: z.string().min(1).max(2048).optional()` to the `EventSourceSchema` object shape.
    - Keep `schema_version` literal at `1`; this is an additive change.
    - Do NOT add any structural constraint (no absolute-path regex, no `$HOME` prefix check) — the field is a carrier, not a constraint.
    - TypeScript type derivation via `z.infer` is automatic; no separate edit to `KiroMemEvent` or `EventSource` is required.
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 11.5_

  - [x] 1.2 Example tests for the schema extension
    - In `test/unit/schemas.newFields.test.ts` (or a new `schemas.projectPath.test.ts` if the file is getting crowded), add:
      - `parseEvent` accepts an event whose `source.project_path` is a 1-char string.
      - `parseEvent` accepts an event whose `source.project_path` is a 2048-char string.
      - `parseEvent` accepts an event whose `source` has no `project_path` key (backward compat).
      - `parseEvent` rejects `source.project_path = ''` with a `ZodError` whose `issues[0].path` ends in `project_path`.
      - `parseEvent` rejects `source.project_path` of length 2049 with a `ZodError` whose `issues[0].path` ends in `project_path`.
    - _Requirements: 5.1, 5.2, 5.4, 5.5_

  - [x] 1.3 Property test: `project_path` schema bounds (Property 7)
    - New file `test/unit/schema-project-path-bounds.property.test.ts`.
    - Single `it.prop` / `fc.assert` body: for any string of length 1 to 2048, an otherwise-valid event with that `source.project_path` passes `parseEvent` and the returned `source.project_path` equals the input. For any string of length 0 or length > 2048, `parseEvent` throws `ZodError` whose issue path identifies `project_path`.
    - **Property 7: `project_path` schema bounds**
    - **Validates: Requirements 5.2, 5.5, 5.6**

- [x] 2. Extend test-helper generators for the new field
  - Property tests downstream need generators that sometimes produce `project_path` and sometimes omit it. Landing the generator changes before the shim and storage property tests means those tests can be written in one pass.

  - [x] 2.1 Add `projectPathArb()` to `test/helpers/arbitrary.ts`
    - Export a new generator `projectPathArb()` returning `fc.Arbitrary<string>` — any string of length 1–2048.
    - Mirror the existing `boundedIdArb` / `contentHashArb` style; no structural constraints beyond the length bound.
    - _Requirements: N13, Design § Test helper extensions_

  - [x] 2.2 Extend `arbitraryEvent()` to conditionally include `project_path`
    - After the existing `content_hash` conditional spread, chain one more `fc.option(projectPathArb(), { nil: undefined })` step.
    - When the option resolves to a string, return `{ ...e, source: { ...e.source, project_path: pp } }`.
    - When the option resolves to `undefined`, return the event unchanged — the key must be absent, not `project_path: undefined` (preserves `exactOptionalPropertyTypes`).
    - _Requirements: N13, Requirements 5.1, 5.4_

  - [x] 2.3 Add fs-tree generators for shim walk properties
    - Export `arbitraryFsTreeWithMarker()`: emits `{ home, projectRoot, cwd, marker }` tuples describing a directory tree rooted under a mocked `$HOME` with exactly one marker planted at a random depth, and a `cwd` at or under `projectRoot`. No marker sits strictly between `cwd` and `projectRoot`.
    - Export `arbitraryFsTreeNoMarker()`: sibling generator that emits trees with no markers anywhere between `cwd` and the ceiling. Uses the same tuple shape (`marker: null`).
    - Both generators produce values that test code maps onto a real temp directory (via `mkdtempSync`) or onto a stubbed `existsSync` / `realpathSync` — the generator itself is data-only.
    - _Requirements: N13, Design § Test helper extensions, Property 1, Property 2_

- [x] 3. Implement `detectProjectRoot` in a new shim module
  - New leaf module in `src/shim/shared/`. No imports from `src/installer/`, `src/collector/`, or `src/shim/cli-agent/` — only `node:` stdlib.

  - [x] 3.1 Create `src/shim/shared/project-root.ts` with `PROJECT_MARKERS` and `ProjectRootResult`
    - Export `PROJECT_MARKERS: readonly string[]` byte-for-byte identical to the installer's `PROJECT_MARKERS` in `src/installer/index.ts` (`.kiro`, `.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, `setup.py`, `go.mod`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `Gemfile`, `composer.json`, `mix.exs`, `deno.json`, `deno.jsonc`), in that exact order.
    - Export `interface ProjectRootResult { projectRoot: string; projectPath: string; isGlobal: boolean; }`.
    - Include a module-level TSDoc block explaining the deliberate duplication with the installer (Requirement N9) and noting that `projectRoot` and `projectPath` are always equal by contract.
    - _Requirements: 1.4, N9_

  - [x] 3.2 Implement `detectProjectRoot(cwd: string): ProjectRootResult`
    - Resolve the Walk_Ceiling once as `realpathSync(homedir())`; on throw, fall back to the unresolved `homedir()` and log `[kiro-learn] homedir/realpath failed` to stderr exactly once (Requirement 7.2, 7.5).
    - Resolve cwd as `resolvedCwd = realpathSync(cwd)`; on throw, log `[kiro-learn] cwd realpath failed` to stderr and return `{ projectRoot: cwd, projectPath: cwd, isGlobal: false }` (Requirement 7.1, 7.5).
    - When `resolvedCwd === ceiling` or `resolvedCwd` is not under `ceiling`, return `{ projectRoot: ceiling, projectPath: ceiling, isGlobal: true }` without walking (Requirement 2.4, 2.5).
    - Walk upward from `resolvedCwd`, stopping before `ceiling`. At each directory, iterate `PROJECT_MARKERS` in order and call `existsSync(join(current, marker))`; on any per-marker throw, silently treat the marker as absent and continue (Requirement 7.3 — no stderr log).
    - When a marker is found, return `{ projectRoot: current, projectPath: current, isGlobal: false }` (Requirement 1.3, 1.5).
    - When the walk completes without finding a marker, return `{ projectRoot: ceiling, projectPath: ceiling, isGlobal: true }` (Requirement 3.1, 3.2, 3.3).
    - Wrap the entire walk body in a defensive `try/catch`; on unexpected throw, log `[kiro-learn] walk error` to stderr and return `{ projectRoot: resolvedCwd, projectPath: resolvedCwd, isGlobal: false }` — today's behaviour (Requirement 7.4, 7.5).
    - Warning messages must never include the path value (Requirement N6).
    - Function must never throw; every branch has a defined fallback (Requirement 7.6).
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x] 3.3 Example tests for error-handling fallbacks
    - `test/unit/shim-detect-realpath-cwd-throws.test.ts`: mock `realpathSync` to throw on the cwd call; assert result is `{ projectRoot: cwd, projectPath: cwd, isGlobal: false }` and exactly one `[kiro-learn] cwd realpath failed` line is written to stderr. _Requirements: 7.1, 7.5_
    - `test/unit/shim-detect-realpath-home-throws.test.ts`: mock `realpathSync` to throw on the homedir call; assert the walk proceeds with the unresolved ceiling and exactly one `[kiro-learn] homedir/realpath failed` line is written to stderr. _Requirements: 7.2, 7.5_
    - `test/unit/shim-detect-existssync-throws.test.ts`: mock `existsSync` to throw at one directory mid-walk; assert the walk silently continues upward and finds a marker higher up, with **zero** stderr output. _Requirements: 7.3, 7.5_
    - `test/unit/shim-detect-walk-throws.test.ts`: inject a fault into the walk body (e.g. `dirname` throws via monkeypatch); assert result falls back to `realpath(cwd)` and exactly one `[kiro-learn] walk error` line is written to stderr. _Requirements: 7.4, 7.5_
    - `test/unit/shim-detect-stderr-observability.test.ts`: consolidated assertion that no warning for any fallback branch contains a path value as a substring. _Requirements: N6, 7.5_

  - [x] 3.4 Example tests for ceiling semantics
    - `test/unit/shim-detect-cwd-equals-home.test.ts`: when `resolvedCwd === ceiling`, result is `{ projectRoot: ceiling, projectPath: ceiling, isGlobal: true }` and the walk is not entered. _Requirements: 2.4_
    - `test/unit/shim-detect-cwd-outside-home.test.ts`: when `resolvedCwd` is not under `ceiling` (e.g. `/tmp`), result is the global sentinel. _Requirements: 2.5_
    - `test/unit/shim-detect-ceiling-computed-once.test.ts`: mock `realpathSync` and assert it is called at most once with `homedir()` per `detectProjectRoot` invocation. _Requirements: 2.1_

  - [x] 3.5 Example test for symlink resolution
    - `test/unit/shim-detect-symlink-resolution.test.ts`: create a real temp directory tree (via `mkdtempSync`) with a project marker at the root and a symlink pointing into a subdirectory; invoke `detectProjectRoot(symlinkPath)`; assert the returned `projectRoot` is the real project directory, not the symlinked ancestor.
    - _Requirements: 1.2_

  - [x] 3.6 Example test asserting marker-list parity with the installer
    - `test/unit/shim-project-markers-match-installer.test.ts`: import `PROJECT_MARKERS` from both `src/shim/shared/project-root.ts` and `src/installer/index.ts`; assert the two arrays deep-equal (same length, same strings, same order).
    - This test imports from the installer into a test file — it lives in `test/unit/` and does not violate any production modularity guard.
    - _Requirements: 1.4, N9_

  - [x] 3.7 Property test: walk finds nearest marker-bearing ancestor (Property 1)
    - New file `test/unit/shim-detect-project-root-walk.property.test.ts`.
    - Use `arbitraryFsTreeWithMarker()` to drive the input; for each generated tree, assert `detectProjectRoot(cwd).projectRoot === projectRoot` and `isGlobal === false`.
    - **Property 1: Walk finds the nearest marker-bearing ancestor**
    - **Validates: Requirements 1.3, 1.5, 4.3**

  - [x] 3.8 Property test: global sentinel fallback (Property 2)
    - New file `test/unit/shim-detect-project-root-sentinel.property.test.ts`.
    - Use `arbitraryFsTreeNoMarker()`; assert `detectProjectRoot(cwd)` returns `{ projectRoot: ceiling, projectPath: ceiling, isGlobal: true }` for every generated tree. Include the derived-consequence check: for any two cwds under the same ceiling, both computed `project_id`s are equal and equal `SHA-256(ceiling)`.
    - **Property 2: Global sentinel fallback for marker-free walks**
    - **Validates: Requirements 2.2, 3.1, 3.2, 3.3**

  - [x] 3.9 Property test: walk-ceiling containment (Property 3)
    - New file `test/unit/shim-detect-project-root-ceiling.property.test.ts`.
    - For any cwd under the mocked ceiling, assert `detectProjectRoot(cwd).projectRoot === ceiling` or starts with `ceiling + sep`.
    - **Property 3: Walk-ceiling containment**
    - **Validates: Requirements 2.3, 2.6**

- [ ] 4. Wire `detectProjectRoot` into `buildEvent`
  - Replace today's `realpathSync(cwd) + SHA-256` preimage with the result of `detectProjectRoot`. Signature is unchanged.

  - [x] 4.1 Update `buildEvent` in `src/shim/shared/index.ts`
    - Import `detectProjectRoot` from `./project-root.js`.
    - Replace `const resolvedCwd = realpathSync(params.cwd);` with `const { projectRoot, projectPath } = detectProjectRoot(params.cwd);`.
    - Compute `projectId` as `createHash('sha256').update(projectRoot).digest('hex')`.
    - Add `project_path: projectPath` to the `source` object literal — always populated (never conditional spread), since the updated shim always produces a value.
    - Do NOT add a new try/catch in `buildEvent`; `detectProjectRoot` owns all fallback logic.
    - The `parent_event_id` conditional spread is unchanged.
    - _Requirements: 4.1, 4.2, 4.5, 6.1, 6.2, 6.3, 6.4_

  - [x] 4.2 Example test: `project_id` hex format
    - `test/unit/shim-project-id-hex-format.test.ts`: invoke `buildEvent` with a cwd whose resolved project root equals a known path; extract the `project_id` segment from `event.namespace`; assert it equals the pre-computed lowercase hex SHA-256 of that path.
    - _Requirements: 4.1_

  - [x] 4.3 Property test: `buildEvent` idempotence (Property 4)
    - New file `test/unit/shim-build-event-idempotence.property.test.ts`.
    - For any `EventBuildParams` against a fixed filesystem state, two invocations of `buildEvent` produce events with equal `namespace` fields.
    - **Property 4: Idempotence**
    - **Validates: Requirement 4.4**

  - [x] 4.4 Property test: hash-preimage coherence (Property 5)
    - New file `test/unit/shim-build-event-hash-coherence.property.test.ts`.
    - For any event produced by `buildEvent`, the `project_id` segment of `event.namespace` equals `SHA-256(event.source.project_path)` in lowercase hex, and `event.source.project_path` starts with the platform path separator.
    - **Property 5: Hash-preimage coherence**
    - **Validates: Requirements 6.1, 6.3, 6.4**

  - [x] 4.5 Property test: `buildEvent` safety (Property 6)
    - New file `test/unit/shim-build-event-safety.property.test.ts`.
    - For any input `cwd` — including non-existent paths, adversarial strings, paths outside `$HOME`, and inputs that cause `realpathSync` to throw — `buildEvent` does not throw, and the returned event's `source.project_path` is a 1–2048 char string.
    - **Property 6: `buildEvent` safety**
    - **Validates: Requirement 7.6**

- [x] 5. Add migration `0003_project_path`
  - Migration must land before the insert-path change so the `project_path` column exists by the time `putEvent` binds a value to it. Migration is transactional via the existing runner.

  - [x] 5.1 Create `src/collector/storage/sqlite/migrations/0003_project_path.ts`
    - Export `const DDL` containing `ALTER TABLE events ADD COLUMN project_path TEXT;` (nullable, no DEFAULT) followed by `CREATE INDEX IF NOT EXISTS idx_events_namespace_project_path ON events (namespace, project_path);`.
    - Export `const migration0003: Migration = { version: 3, name: '0003_project_path', up: (db) => db.exec(DDL) }`.
    - Module-level TSDoc block following the `0002_xml_extraction_fields.ts` pattern, cross-referencing Requirements 8.1, 8.2, 8.3, 8.4, 8.5.
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 5.2 Register `migration0003` in `src/collector/storage/sqlite/migrations/index.ts`
    - Import `{ migration0003 } from './0003_project_path.js'`.
    - Append `migration0003` to the `MIGRATIONS` readonly tuple after `migration0002`.
    - No reorder or rename of existing entries (runner's drift check).
    - _Requirements: 8.4, 8.7_

  - [x] 5.3 Example test: fresh-database apply
    - `test/unit/migration-0003-project-path.test.ts` (new file).
    - Open a fresh `:memory:` DB, run all migrations, then:
      - Query `sqlite_master` / `PRAGMA table_info(events)` and assert the `project_path` column exists with type `TEXT` and is nullable (no `NOT NULL`).
      - Query `sqlite_master` and assert `idx_events_namespace_project_path` exists.
      - Query `_migrations` and assert a row exists for `(3, '0003_project_path')`.
    - In the same file, add a second test that opens a fresh DB, applies only migrations 1 and 2 manually, inserts one legacy event row, then runs `runMigrations` with the full list; assert the legacy row survives with `project_path IS NULL`.
    - Add a third test that opens a DB at version 3, tampers with `_migrations` to set the recorded name to `'wrong_name'` for version 3, re-runs `runMigrations`, and asserts `MigrationDriftError` is thrown.
    - _Requirements: 8.1, 8.2, 8.3, 8.5, 8.7_

  - [x] 5.4 Example test: idempotent re-apply
    - `test/unit/migration-0003-idempotent.test.ts` (new file).
    - Open a DB, run all migrations, snapshot `sqlite_schema` + `_migrations`. Run migrations again. Assert the snapshots are byte-equal and no error is thrown.
    - _Requirements: 8.6_

- [x] 6. Bind `project_path` in the insert path
  - The storage layer's write path extracts `source.project_path` into the denormalised column. The read path is deliberately **not** modified.

  - [x] 6.1 Extend `InsertEventParams` and `insertEvent` SQL in `src/collector/storage/sqlite/statements.ts`
    - Append `projectPath: string | null` to the `InsertEventParams` tuple type as position 13.
    - Update the `insertEvent` prepared SQL: extend the column list to include `project_path` after `content_hash`, and add a 13th `?` placeholder.
    - Update the TSDoc `@see` list for `insertEvent` to cite Requirement 9.1, 9.2, 9.3.
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 6.2 Do NOT modify `selectEventById` or `EventRow`
    - Add an inline code comment directly above the `selectEventById` prepared statement in `statements.ts`:
      `// project_path is intentionally NOT in this SELECT list — source.project_path round-trips via source_json. See design § Storage — Read Path (Requirement 9.5).`
    - Add an inline code comment directly above the `EventRow` interface declaration:
      `// project_path column exists in the events table (migration 0003) but is intentionally absent from this row shape — the read path reconstitutes source.project_path from source_json. See Requirement 9.5.`
    - No functional code change in this subtask; the comments are the deliverable, enforcing the design invariant against future drift.
    - _Requirements: 9.5, 10.1, 10.2, 11.3_

  - [x] 6.3 Update the `putEvent` call site in `src/collector/storage/sqlite/index.ts`
    - After the existing `event.content_hash ?? null` argument in the `stmts.insertEvent.run(...)` call, pass one additional positional argument: `event.source.project_path ?? null`.
    - The `JSON.stringify(event.source)` argument (which produces `source_json`) is unchanged — the full `source` object continues to be stored there, including `project_path` when present.
    - _Requirements: 9.2, 9.3, 9.4, 9.6_

  - [x] 6.4 Example test: insert-path column binding
    - `test/unit/sqlite-insert-event-column-binding.test.ts` (new file).
    - Open a real on-disk SQLite DB under `mkdtempSync`, run migrations, `putEvent` an event with `source.project_path = '/Users/alice/code/proj'`.
    - Execute a raw `SELECT project_path, source_json FROM events WHERE event_id = ?` (not via `getEventById`) and assert:
      - The `project_path` column equals `'/Users/alice/code/proj'`.
      - `JSON.parse(source_json).project_path` equals `'/Users/alice/code/proj'`.
    - Add a second test case: `putEvent` an event with no `project_path` on `source`; assert the `project_path` column is `NULL` and `source_json` has no `project_path` key.
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 6.5 Property test: round-trip integrity with `project_path` (Property 8)
    - New file `test/unit/sqlite-round-trip-project-path.property.test.ts`.
    - Use the extended `arbitraryEvent()` from Task 2.2 (which now sometimes produces `project_path`). For any generated event `e`: `putEvent(e)` then `getEventById(e.event_id)` returns an event that deep-equals `e`. When `e.source.project_path` is present, the returned event's `source.project_path` matches byte-for-byte. When absent, the returned event's `source` has no `project_path` key (not `project_path: undefined` — `exactOptionalPropertyTypes`).
    - **Property 8: Round-trip integrity with `project_path`**
    - **Validates: Requirements 9.5, 10.1, 10.2, 10.3, 11.3, 12.4**

  - [x] 6.6 Property test: `putEvent` idempotency preserves stored `project_path` (Property 9)
    - New file `test/unit/sqlite-put-event-project-path-idempotency.property.test.ts`.
    - For any two generated events `e1` and `e2` with the same `event_id` but different `source.project_path` values, after `putEvent(e1)` then `putEvent(e2)`, `getEventById(e1.event_id)` returns an event whose `source.project_path === e1.source.project_path`. First-write wins, mirroring the existing `INSERT OR IGNORE` contract.
    - **Property 9: `putEvent` idempotency preserves stored `project_path`**
    - **Validates: Requirement 9.6**

- [x] 7. Pipeline pass-through verification
  - The pipeline gains no new behaviour. These tests exist to catch a future regression that starts scrubbing, hashing, or rewriting `source`.

  - [x] 7.1 Property test: privacy scrub does not touch `source` (Property 10)
    - New file `test/unit/pipeline-scrub-ignores-source.property.test.ts`.
    - Construct events synthetically (bypassing `detectProjectRoot`) whose `source.project_path` contains the literal substring `<private>...</private>`. Pass through the scrub stage. Assert the output's `source.project_path` is byte-identical to the input's.
    - **Property 10: Privacy scrub does not touch `source`**
    - **Validates: Requirements 12.1, N8**

  - [x] 7.2 Property test: dedup ignores `source.project_path` (Property 11)
    - New file `test/unit/pipeline-dedup-ignores-project-path.property.test.ts`.
    - For any pair `(e1, e2)` with `e1.event_id === e2.event_id` but `e1.source.project_path !== e2.source.project_path`: after the dedup stage processes `e1` and then `e2`, the second call returns `{ action: 'halt', ... }`. `project_path` is not part of the dedup key.
    - **Property 11: Dedup ignores `source.project_path`**
    - **Validates: Requirement 12.2**

  - [x] 7.3 Example test: body-size cap excludes `source`
    - `test/unit/receiver-body-size-with-project-path.test.ts` (new file).
    - Construct an event with a near-1 MiB `body` (e.g. 1 MiB minus a small margin) and a 2 KiB `source.project_path`; assert `parseEvent` accepts it. Then construct a body > 1 MiB and assert rejection independent of `project_path` presence.
    - _Requirements: 12.5_

- [ ] 8. Modularity guard checks (no new guards added)
  - The existing `test/unit/no-collector-in-shim.test.ts` and `test/unit/no-shim-in-installer.test.ts` already cover the relevant boundaries. Requirement N10 explicitly says no new guard is needed for the installer-in-shim direction. This task confirms the existing guards continue to pass against the new files.

  - [x] 8.1 Confirm existing guard tests pass against the new shim module
    - Run `npm run test -- --run test/unit/no-collector-in-shim.test.ts test/unit/no-shim-in-installer.test.ts` and confirm both pass after Task 3 lands.
    - Visually verify that `src/shim/shared/project-root.ts` imports only from `node:` stdlib modules (`node:fs`, `node:os`, `node:path`) — no imports from `src/collector/`, `src/installer/`, or `src/shim/cli-agent/`.
    - _Requirements: N9, N10_

- [x] 9. Checkpoint — intermediate green build
  - Ensure all tests pass, ask the user if questions arise.
  - Run `npm run typecheck && npm run lint && npm run test` and confirm green before moving on to final integration verification.

- [ ] 10. Final verification
  - End-to-end sanity pass that exercises the full pipeline with the new field in the wire and in storage.

  - [x] 10.1 Run the full local gate
    - `npm run build` — confirms the package compiles with the new schema, new shim module, and new migration.
    - `npm run typecheck` — confirms strict mode + `exactOptionalPropertyTypes` still holds across the modified types.
    - `npm run lint` — confirms no new lint violations in the added/modified files.
    - `npm run test` — confirms every new property test, example test, and existing regression test passes.
    - _Requirements: all_

  - [ ] 10.2 Manual end-to-end smoke
    - Build the package, link it into an installed `~/.kiro-learn/` layout, run `kiro-cli` from a subdirectory of a real project, then open the SQLite DB and run `SELECT event_id, namespace, project_path FROM events ORDER BY transaction_time DESC LIMIT 5;` to confirm `project_path` is populated to the repo root and `namespace` is stable across subdirectories of the same repo.
    - Not a required step — every behaviour is covered by the automated suite above. This is a "does it feel right" spot-check for the operator.

  - [ ] 10.3 Microbenchmark the walk
    - Add a throwaway benchmark script (not a test) that invokes `detectProjectRoot` against a realistic home-dir-depth cwd 10 000 times and asserts the 95th-percentile is under the 5 ms target from Requirement N1.
    - Skip unless N1 becomes a real concern. The walk performs at most 15 × depth `existsSync` calls and is expected to be sub-millisecond.

## Notes

- Tasks marked with `*` are optional and may be skipped for a faster MVP. Required tasks (every non-`*` task above) cover every acceptance criterion and every correctness property in the design.
- Each property test file contains exactly one property, runs with `fast-check`'s default 100 iterations, and is named `Feature: project-path-capture, Property N: {title}` at the `describe`/`it` level per repo convention.
- The shim intentionally duplicates the installer's `PROJECT_MARKERS` list rather than importing it (Requirement N9, guard test `no-collector-in-shim.test.ts`). Task 3.6 enforces marker-list parity at the test layer without violating the production modularity boundary.
- The storage read path is intentionally **not** extended to read the new column. `source.project_path` round-trips via `source_json` only. Tasks 6.2, 6.5, and the design's Interfaces section all restate this to prevent drift.
- Migration 0003 must land before the insert-path change (Task 5 before Task 6) so the `project_path` column exists by the time `putEvent` binds to it.
- No `schema_version` bump. The change is purely additive.
- No new guard tests. No UI. No read API. No environment-variable override. No backfill. No installer/shim dedup refactor. All deliberately out of scope per the requirements doc.

## Execution order summary

1. Task 1 (wire contract) unblocks everything.
2. Task 2 (test-helper generators) unblocks every property test in Tasks 3, 4, 6, 7.
3. Task 3 (shim `detectProjectRoot`) depends on Task 1 for the type; independent of Tasks 4–7.
4. Task 4 (`buildEvent` wiring) depends on Task 3.
5. Task 5 (migration 0003) depends on Task 1 only.
6. Task 6 (insert path) depends on Tasks 1 and 5; Task 6.3 depends on Task 6.1.
7. Task 7 (pipeline pass-through verification) depends on Task 1; independent of Tasks 3–6.
8. Task 8 (guard confirmation) depends on Task 3.
9. Task 9 (intermediate checkpoint) depends on all prior.
10. Task 10 (final verification) depends on Task 9.
