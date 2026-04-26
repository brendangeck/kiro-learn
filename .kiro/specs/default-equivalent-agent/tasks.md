# Implementation Plan: Default-Equivalent Agent

## Overview

Replace the installer's hand-authored `kiro-learn.json` write with a seed-then-merge flow: for each applicable `Agent_Scope` (global always, project-scoped when detected), `writeAgentConfigs` delegates to a new `writeKiroLearnAgent` helper that deletes any existing file, invokes `kiro-cli agent create --from kiro_default --directory <targetDir> kiro-learn` under `EDITOR=true`, validates the seed payload, merges kiro-learn's `name`, `description`, and four owned hook triggers onto the seed, and writes the merged result. If seeding fails at any step, it falls back to writing the current byte-for-byte bare hooks-only config and emits a single `[kiro-learn] warning:` line per affected scope. The implementation adds four new helpers in `src/installer/index.ts` — `runSeedCommand`, `validateSeedPayload`, `mergeHooks`, `writeKiroLearnAgent` — and modifies exactly one existing function, `writeAgentConfigs`. The compressor agent write path is untouched.

## Tasks

- [x] 1. Extract module-level constants in `src/installer/index.ts`
  - [x] 1.1 Lift the kiro-learn description string and the owned-trigger tuple to module scope
    - Extract the `'Continuous learning for Kiro sessions. Captures tool-use events and injects prior context.'` literal into a module-level `KIRO_LEARN_DESCRIPTION` constant
    - Extract the owned-trigger tuple into a module-level `OWNED_TRIGGERS: readonly ['agentSpawn', 'userPromptSubmit', 'postToolUse', 'stop']` constant (use `as const` for literal-type inference)
    - Refactor the existing inline `kiroLearnConfig` construction in `writeAgentConfigs` to reference both constants — no behaviour change, purely a refactor so Task 5 produces a surgical diff
    - _Requirements: 4.2, 4.3, 4.6, 6.2_

  - [x] 1.2 Update existing installer tests that assert on the description or trigger literals
    - Any test that inlines the description string or the trigger list should import the new constants instead, so future changes flow through one source
    - _Requirements: 4.2, 4.3_

- [x] 2. Implement `validateSeedPayload`
  - [x] 2.1 Add the function body per the design pseudocode
    - `JSON.parse` in a `try`/`catch`; return `null` on `SyntaxError`
    - Reject `null`, `undefined`, non-objects, arrays, and empty objects via `typeof`, `Array.isArray`, `Object.keys(...).length === 0`
    - Return the parsed value typed as `Record<string, unknown>` on success
    - Function never throws
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 2.2 Unit tests for `validateSeedPayload` (`test/unit/installer-validate-seed-payload.test.ts`)
    - Table-driven over representative inputs: `""`, `"not json"`, `"null"`, `"true"`, `"42"`, `"[]"`, `"[1,2]"`, `"{}"`, `"{\"a\":1}"`, `"{\"name\":\"foo\",\"tools\":[]}"`
    - Assert `null` return for every invalid input and a deep-equal parsed value for every valid input
    - Explicitly assert the function does not throw for any input (wrap calls in `expect(() => ...).not.toThrow()`)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 2.3 Property test P1: `validateSeedPayload` contract (`test/unit/installer-validate-seed-payload.property.test.ts`)
    - **Property 1: `validateSeedPayload` contract**
    - Generate `fc.anything()`, `JSON.stringify` the value, feed into `validateSeedPayload`
    - Assert the return is non-null iff the generated value is a non-null, non-array object with at least one own key
    - When non-null, assert the return deep-equals `JSON.parse(raw)`
    - Separately feed `fc.string()` and assert `null` return whenever `JSON.parse(raw)` would throw
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

- [x] 3. Implement `mergeHooks`
  - [x] 3.1 Add `HookTriggerMap` and `HookEntry` interfaces and the `mergeHooks` function body per the design pseudocode
    - Export `HookEntry` with `command: string` and optional `matcher?: string`
    - Export `HookTriggerMap` with exactly the four keys `agentSpawn`, `userPromptSubmit`, `postToolUse`, `stop`, each bound to `readonly HookEntry[]`
    - Implement `mergeHooks(seed, triggers)`: shallow-copy `seed`, overwrite `name` with `'kiro-learn'`, overwrite `description` with `KIRO_LEARN_DESCRIPTION`, start `baseHooks` from `seed.hooks` (coerce to `{}` if absent / not a plain object), loop `OWNED_TRIGGERS` setting `baseHooks[t] = [...triggers[t]]`, set `merged.hooks = baseHooks`, return `merged`
    - Must not mutate `seed` — write the loop so the output is a fresh object with fresh arrays at every owned trigger
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 3.2 Unit tests for `mergeHooks` (`test/unit/installer-merge-hooks.test.ts`)
    - Happy path: seed with `tools`, `prompt`, `description`, `mcpServers`, `allowedTools`, and a non-owned `hooks.preToolUse` → merged output has all top-level fields preserved, owned triggers overwritten, `preToolUse` preserved verbatim
    - Seed with no `hooks` field at all → merged `hooks` contains exactly the four owned triggers and nothing else
    - Seed with existing owned hook entries (e.g. `hooks.agentSpawn: [{command: 'old'}]`) → overwritten with kiro-learn's entries, no warning emitted (this helper has no I/O)
    - Seed with `hooks` set to a non-object (string, array, number) → coerced to `{}`, final `hooks` has only the four owned triggers
    - Seed with a `name` of `'kiro_default'` and a `description` of the default agent's description → both overwritten with kiro-learn's values
    - Input-mutation check: clone `seed` via `structuredClone`, call `mergeHooks`, assert original `seed` deep-equals the clone
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [x] 3.3 Property test P2: owned-field overwrite (`test/unit/installer-merge-hooks-overwrite.property.test.ts`)
    - **Property 2: `mergeHooks` overwrites owned fields with constants**
    - Generator: `fc.record` over arbitrary top-level keys including random values at `name`, `description`, and `hooks.{owned}`; `HookTriggerMap` via `fc.record` over the four keys, each bound to `fc.array(fc.record({ command: fc.string(), matcher: fc.option(fc.string()) }))`
    - Assert `merged.name === 'kiro-learn'`, `merged.description === KIRO_LEARN_DESCRIPTION`, and `merged.hooks[t]` deep-equals `triggers[t]` for every `t` in `OWNED_TRIGGERS`, regardless of what `seed` had at those keys (including absent)
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.5, 4.6**

  - [x] 3.4 Property test P3: non-owned preservation (`test/unit/installer-merge-hooks-preserve.property.test.ts`)
    - **Property 3: `mergeHooks` preserves non-owned fields**
    - Generator: same base as P2 but additionally sprinkle top-level keys outside `{name, description, hooks}` and hook trigger names outside `OWNED_TRIGGERS` (e.g. `preToolUse`, `preAgentSpawn`, random strings)
    - Assert for every top-level `k ∉ {name, description, hooks}`: `merged[k]` deep-equals `seed[k]`
    - Assert for every hook trigger `u ∈ seed.hooks` with `u ∉ OWNED_TRIGGERS`: `merged.hooks[u]` deep-equals `seed.hooks[u]`
    - **Validates: Requirements 4.4, 4.7, 3.5**

  - [x] 3.5 Property test P4: determinism and purity (`test/unit/installer-merge-hooks-determinism.property.test.ts`)
    - **Property 4: `mergeHooks` is deterministic and pure**
    - Snapshot `seed` via `JSON.stringify` before the first call; call `mergeHooks(seed, triggers)` twice; assert the two outputs deep-equal each other and that `JSON.stringify(seed)` is unchanged from the snapshot
    - Additionally assert `JSON.stringify(merged, null, 2)` is byte-identical across the two calls
    - **Validates: Requirement 7.3**

- [x] 4. Implement `runSeedCommand`
  - [x] 4.1 Add the `SeedResult` tagged union and the `runSeedCommand` function body per the design pseudocode
    - Export `SeedResult = { ok: true; targetFile: string } | { ok: false; reason: 'spawn-failed' | 'non-zero-exit' | 'missing-file'; stderr: string }`
    - Decide between `execSync` with a shell-quoted command string and `execFileSync` with an argv array; the design's Security section calls out `execFileSync` as the safer option
    - Pick one and leave a one-line code comment naming the choice and why (shell-injection safety if `execFileSync`; consistency with the rest of the installer if `execSync`)
    - Pass `env: { ...process.env, EDITOR: 'true' }` and `stdio: ['ignore', 'pipe', 'pipe']`
    - Distinguish `spawn-failed` (thrown error has no numeric `status`) from `non-zero-exit` (thrown error has `typeof status === 'number'`)
    - Defensive post-check: even on exit 0, return `{ ok: false, reason: 'missing-file', stderr: '' }` if `existsSync(targetFile)` is false
    - Capture `stderr` from the thrown error's `stderr` property (Buffer or string), default to `''`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 12.3_

  - [x] 4.2 Unit tests for `runSeedCommand` (`test/unit/installer-run-seed-command.test.ts`)
    - Mock `node:child_process` (`execSync` or `execFileSync`, whichever Task 4.1 chose) and `node:fs` (`existsSync`) via `vi.mock`
    - Happy path: spawn returns normally, `existsSync(targetFile) === true` → `{ ok: true, targetFile: '<targetDir>/kiro-learn.json' }`
    - Spawn throws with no `status` → `{ ok: false, reason: 'spawn-failed', stderr: <captured> }`
    - Spawn throws with `status: 1` → `{ ok: false, reason: 'non-zero-exit', stderr: <captured> }`
    - Spawn throws with `status: 2` and a `stderr` Buffer → `stderr` decoded as UTF-8 in the result
    - Spawn returns normally but `existsSync` is false → `{ ok: false, reason: 'missing-file', stderr: '' }`
    - Argv assertions: captured command/argv contains `--from kiro_default`, `--directory <targetDir>`, and the positional `kiro-learn`; no stray flags
    - Env assertions: `env.EDITOR === 'true'`; all other `process.env` entries are preserved (spot-check `PATH`, `HOME`)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

- [x] 5. Implement `writeKiroLearnAgent`
  - [x] 5.1 Add the function per the design pseudocode, including the inner `writeFallback` helper
    - (a) `unlinkSync(<targetDir>/kiro-learn.json)` in a `try`/`catch`; swallow `err.code === 'ENOENT'`, re-throw any other error
    - (b) Call `runSeedCommand(targetDir)`
    - (c) On `SeedResult.ok === true`, `readFileSync` the target file and pass the contents to `validateSeedPayload`
    - (d) On valid payload, call `mergeHooks(payload, KIRO_LEARN_TRIGGERS)` and `writeFileSync` with `JSON.stringify(merged, null, 2) + '\n'`
    - (e) On any failure (`SeedResult.ok === false` or `validateSeedPayload` returned `null`), call the inner `writeFallback(targetFile, scopeLabel, cause)`
    - `writeFallback` writes the Fallback_Config structured per the Data Models section (key order: `name`, `description`, `hooks` at top level; `agentSpawn`, `userPromptSubmit`, `postToolUse`, `stop` inside `hooks`) and emits exactly one `process.stderr.write` call
    - Warning string must match Requirement 11.5 exactly: `[kiro-learn] warning: could not seed kiro-learn agent from kiro_default (<cause>) for <scope> scope. Writing minimal hooks-only config — the agent will not have the default tools, prompt, or MCP servers until you install/upgrade kiro-cli and rerun 'kiro-learn init'.`
    - `scopeLabel` derived from `targetDir` (`'global'` when it equals `path.join(homedir(), '.kiro', 'agents')`, otherwise `'project'`)
    - `cause` derived from the `SeedResult.reason` or `'seed command failed'` for the invalid-payload case
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 11.1, 11.2, 11.3, 11.4, 11.5, 12.1_

  - [x] 5.2 Unit tests for `writeKiroLearnAgent` (`test/unit/installer-write-kiro-learn-agent.test.ts`)
    - Use a real `os.tmpdir()` directory for `targetDir`; only mock the child-process spawn (`execSync`/`execFileSync`) so file I/O exercises the real fs layer
    - Happy path: mocked spawn writes a known seed JSON (with `tools`, `prompt`, `mcpServers`, and a non-owned `hooks.preToolUse`) to `targetDir/kiro-learn.json`; after `writeKiroLearnAgent` returns, read the file and assert the merged shape (all seed fields preserved, owned triggers from `KIRO_LEARN_TRIGGERS`, `preToolUse` unchanged)
    - `spawn-failed` branch: mocked spawn throws with no `status` → file contains exactly the Fallback_Config bytes; stderr recorded one line starting with `[kiro-learn] warning:`; cause segment contains `kiro-cli unavailable`
    - `non-zero-exit` branch: mocked spawn throws with `status: 1` → Fallback_Config written; stderr recorded one line; cause segment contains `seed command failed`
    - `missing-file` branch: mocked spawn returns normally but no file is written → Fallback_Config written; stderr recorded one line; cause segment contains `seed command failed`
    - `invalid-payload` branch: mocked spawn writes `"[1, 2, 3]"` to the target file → Fallback_Config written; stderr recorded one line; cause segment contains `seed command failed`
    - Pre-seed delete: seed a pre-existing `<targetDir>/kiro-learn.json` with bogus content, drive the happy path, and assert the pre-existing bytes are gone (the unlink step ran)
    - ENOENT tolerance: confirm the function does not throw when the pre-existing file is absent
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4, 6.5, 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 5.3 Property test P5: fallback bytes match today's bare config (`test/unit/installer-fallback-bytes.property.test.ts`)
    - **Property 5: Fallback output matches the current bare config byte-for-byte**
    - Parameterise over the four failure reasons: `'spawn-failed'`, `'non-zero-exit'`, `'missing-file'`, `'invalid-payload'` (no random input beyond this set)
    - For each reason, drive `writeKiroLearnAgent` so it takes the fallback branch, read the written file, and assert the bytes equal a golden constant extracted from the pre-spec `writeAgentConfigs` source — i.e. `JSON.stringify(FALLBACK_CONFIG, null, 2) + '\n'` with the exact key order documented in the Data Models section
    - The golden constant should be constructed in-test from `KIRO_LEARN_DESCRIPTION` and the known shim path so a future description or shim-path change still keeps the test honest
    - **Validates: Requirements 6.1, 6.2**

- [x] 6. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 7. Integrate the new helpers into `writeAgentConfigs`
  - [x] 7.1 Replace the inline kiro-learn writes with `writeKiroLearnAgent` calls per scope
    - Global: `writeKiroLearnAgent(path.join(homedir(), '.kiro', 'agents'))` — always
    - Project: `writeKiroLearnAgent(path.join(scope.projectRoot, '.kiro', 'agents'))` — iff `scope.projectRoot !== undefined`
    - Leave the compressor write path byte-for-byte unchanged (this is the explicit Requirement 8 guard)
    - Update the function's TSDoc header to describe the seed-then-merge flow and cross-reference Requirements 1–12
    - _Requirements: 1.1, 2.1, 5.3, 6.4, 8.1, 8.2, 8.3, 9.1, 9.2, 9.3, 9.4, 12.1, 12.2_

  - [x] 7.2 Update existing installer tests that asserted on the bare `kiro-learn.json` bytes
    - Prefer updating expected bytes to the merged shape (feed a mocked seed and assert the merged output)
    - Fall back to mocking `runSeedCommand` to force the fallback branch and asserting today's bare bytes where mocking a seed would be disruptive
    - Tests covering `kiro-learn-compressor.json` must remain unchanged — they are the load-bearing guard for Requirement 8.2
    - _Requirements: 6.2, 8.1, 8.2, 8.3_

  - [x] 7.3 Add `writeAgentConfigs`-level tests for scope matrix (`test/unit/installer-write-agent-configs.test.ts`, or extend existing file)
    - Global-only scope (`scope.projectRoot === undefined`): only the global `kiro-learn.json` is written; no project file at any path
    - Global + project scope: both `kiro-learn.json` files written; each has its own merged-or-fallback outcome
    - Assert `kiro-learn-compressor.json` is written globally once per invocation and never at the project scope
    - _Requirements: 8.3, 9.1, 9.2, 9.3, 9.4_

- [x] 8. Property test P6: cross-scope ordering and non-interleaving (`test/unit/installer-write-agent-configs-ordering.property.test.ts`)
  - **Property 6: Per-scope ordering holds and scopes do not interleave**
  - Instrument `unlinkSync`, `execSync`/`execFileSync`, `readFileSync`, `writeFileSync`, and `process.stderr.write` with a shared recorder via `vi.spyOn` that appends a tagged entry (`{ op, path?, scope? }`) to an array on each call
  - Generator: cartesian product of `(scope1_outcome, scope2_outcome)` where each is one of `{'success', 'spawn-failed', 'non-zero-exit', 'missing-file', 'invalid-payload'}`, times `{'no-project', 'with-project'}`
  - For each generated tuple, drive `writeAgentConfigs` with the corresponding `InstallScope` and configure the mocked spawn to produce the required outcome per scope
  - Assert the recorded trace equals the expected ordered concatenation `trace(scope1) ++ trace(scope2_if_defined) ++ trace(compressor_write)` where each per-scope trace matches either `[unlink, spawn, readFileSync, writeFileSync]` (success) or `[unlink, spawn, writeFileSync, stderrWrite]` (failure)
  - Assert no operation tagged with `scope: 'project'` appears in the trace before the last operation tagged with `scope: 'global'`
  - **Validates: Requirements 6.4, 9.3, 12.1, 12.2**

- [x] 9. Update installer integration tests (`test/integ/default-equivalent-agent.test.ts`)
  - [x] 9.1 Gate on `kiro-cli agent create --help` success
    - Mirror the `kiroCliSupportsAgentCreate()` pattern from `test/integ/extraction-pipeline.test.ts` and wrap the suite with `describe.skipIf(!canRun)` so CI without `kiro-cli` skips gracefully
    - _Requirements: 1.1, 1.4_

  - [x] 9.2 Seed-and-merge against real `kiro-cli` (Test 1)
    - Create a tmp HOME, run `writeKiroLearnAgent` against `<tmpHome>/.kiro/agents/` with the real spawn path (no mocks)
    - Read the written `kiro-learn.json` and assert it has at least 2+ top-level keys beyond what the Fallback_Config carries (e.g. `tools`, `prompt`, `mcpServers`, or whatever `kiro_default` currently ships)
    - Assert `hooks.agentSpawn`, `hooks.userPromptSubmit`, `hooks.postToolUse`, and `hooks.stop` exist and each contains kiro-learn's shim command string
    - Assert `name === 'kiro-learn'` and `description === KIRO_LEARN_DESCRIPTION`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.4, 4.1, 4.2, 4.3, 4.7, 5.1, 5.2_

  - [x] 9.3 User customisation of `kiro_default` propagates to merged output (Test 2 — Requirement 10)
    - Write a customised `~/.kiro/agents/kiro_default.json` into the tmp HOME (e.g. with a distinctive `prompt` or an extra `mcpServers` entry)
    - Run the flow; read the written `kiro-learn.json`; assert the customisation is reflected in the merged output (customised field survives, owned fields still overwritten)
    - _Requirements: 10.1, 10.2, 10.3_

- [x] 10. Checkpoint — Ensure all tests pass, ask the user if questions arise.

- [x] 11. Update installer documentation
  - [x] 11.1 Rewrite the `writeAgentConfigs` TSDoc header
    - The existing header says "hand-authored hooks-only config" — replace with a short description of the seed-then-merge flow, the per-scope semantics, and the fallback contract; cross-reference Requirements 1–12
    - _Requirements: 1.1, 6.1, 6.2, 6.3, 6.5, 8.2, 9.1, 12.1_

  - [x] 11.2 Update `AGENTS.md` if it describes the installer flow
    - If the "Distribution → Install flow" section mentions writing the agent config, extend it to describe the seed-then-merge mechanism and the fallback
    - If `AGENTS.md` does not describe this level of detail, no change is required — the TSDoc in 11.1 is the source of truth
    - _Requirements: 1.1, 6.3, 11.5_

- [x] 12. Final checkpoint — Ensure all tests pass, ask the user if questions arise.
  - `npm run test` (unit + property suites) green
  - `npm run test:integ` green (or skipped cleanly when `kiro-cli` is absent)
  - `npx tsc --noEmit` clean against `tsconfig.json`
  - Lint clean per the project's `eslint.config.js`

## Notes

- Each task references specific requirements for traceability.
- Tasks are all required for this spec — no optional MVP skips. The five failure-mode branches of `writeKiroLearnAgent` and the property tests collectively are what make the seed-then-merge flow safe to ship, so none of them can be deferred without leaving a silent regression window.
- Checkpoints (Tasks 6, 10, 12) ensure incremental validation at natural milestones: after the pure helpers land, after they're wired into the orchestrator, and at the end of the spec.
- Property tests validate the universal correctness properties from the design document; unit tests cover specific examples and edge cases. Each property test carries a bold `Property N:` label and a `Validates: Requirements X.Y` footer so the traceability chain is machine-readable.
- The project uses TypeScript with strict mode (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), ESM imports with explicit `.js` extensions, vitest for the test runner, and fast-check for property-based tests. All modules follow existing installer conventions (one-file module, `node:`-prefixed core imports, `writeFileSync` + `JSON.stringify(..., null, 2) + '\n'` for file writes).
- No new runtime or dev dependencies are introduced. `execSync` / `execFileSync`, `unlinkSync`, `readFileSync`, `writeFileSync`, and `existsSync` are already imported in `src/installer/index.ts`.
- The compressor agent write path (`kiro-learn-compressor.json`) is deliberately out of scope and must remain byte-for-byte identical — that invariant is what the unchanged compressor-prompt test in Task 7.2 guards.
