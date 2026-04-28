# Implementation Plan: Kiro IDE Hook Shim

## Overview

Implement the IDE hook shim that bridges Kiro IDE's `.kiro/hooks/*.kiro.hook` mechanism to the kiro-learn collector daemon. The work spans four areas: (1) adding a backward-compatible `surface` parameter to the shared `buildEvent` function, (2) implementing the new `src/shim/ide-hook/index.ts` module with dispatch, handler, and error logic, (3) extending the installer to generate `.kiro.hook` files and the `ide-shim` bin wrapper, and (4) comprehensive testing via property-based tests, unit tests, and guard tests.

## Tasks

- [x] 1. Add `surface` parameter to shared `buildEvent`
  - [x] 1.1 Extend `EventBuildParams` interface and `buildEvent` implementation
    - Add optional `surface?: 'kiro-cli' | 'kiro-ide'` field to `EventBuildParams` in `src/shim/shared/index.ts`
    - Update `buildEvent` to use `params.surface ?? 'kiro-cli'` when setting `source.surface`
    - Existing CLI shim callers omit the parameter and get the default `'kiro-cli'` — no changes to `src/shim/cli-agent/index.ts`
    - _Requirements: 5.2, 5.3, N12_

  - [x] 1.2 Write unit tests for `buildEvent` surface parameter
    - Verify default surface is `'kiro-cli'` when `surface` is omitted
    - Verify `surface: 'kiro-ide'` propagates to `event.source.surface`
    - Verify existing CLI shim tests still pass unchanged (backward compatibility)
    - Test file: `test/unit/ide-hook-surface.test.ts`
    - _Requirements: 5.2, 5.3, 5.4, N12_

- [x] 2. Implement IDE shim module (`src/shim/ide-hook/index.ts`)
  - [x] 2.1 Create the IDE shim module with `main()` and dispatch logic
    - Create `src/shim/ide-hook/index.ts`
    - Export `main()` function as the entry point
    - Read `process.argv[2]` for event type, `process.env['USER_PROMPT']` for payload, `process.cwd()` for working directory
    - Implement `switch` dispatch: `promptSubmit`, `postToolUse`, `agentStop`, default (log warning to stderr)
    - Wrap entire execution in top-level try/catch — always exit 0, log unexpected errors to stderr with `[kiro-learn]` prefix
    - Import only from `src/shim/shared/` and `src/types/` — never from `src/shim/cli-agent/`, `src/collector/`, or `src/installer/`
    - Use `.js` extensions on all imports, `import type` for type-only imports
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 4.1, 4.2, 4.5, 11.1, 11.2, 11.4, 11.5_

  - [x] 2.2 Implement `handlePrompt` handler
    - Read `USER_PROMPT` as plain text string
    - Build event with `kind: 'prompt'`, `body: { type: 'text', content: userPrompt }`, `surface: 'kiro-ide'`
    - Use `readSession(cwd)` for session management (implicit session creation via fallback)
    - Apply `truncateBody` before posting
    - POST with `retrieve: true`
    - Write retrieval context to stdout if response contains non-empty `retrieval.context`
    - Handle empty/unset `USER_PROMPT` by using empty string
    - _Requirements: 4.6, 5.1, 6.1, 6.2, 7.1, 7.4, 8.1, 8.2, 8.3_

  - [x] 2.3 Implement `handleToolUse` handler
    - Parse `USER_PROMPT` as JSON with shape `{ toolName, toolArgs, toolResult, toolSuccess }`
    - Map camelCase fields to snake_case: `toolName` → `tool_name`, `toolArgs` → `tool_input`, `toolResult` → `tool_response.result`, `toolSuccess` → `tool_response.success`
    - Build event with `kind: 'tool_use'`, `body: { type: 'json', data: { tool_name, tool_input, tool_response } }`, `surface: 'kiro-ide'`
    - Apply defaults for missing fields: `tool_name: "unknown"`, `tool_input: {}`, `tool_response: {}`
    - On JSON parse failure: log `[kiro-learn] failed to parse USER_PROMPT JSON` to stderr, proceed with all defaults
    - POST with `retrieve: false`, no stdout output
    - _Requirements: 4.7, 4.9, 5.1, 7.2, 7.5, 8.4_

  - [x] 2.4 Implement `handleStop` handler
    - Read `USER_PROMPT` as plain text string (summary)
    - Build event with `kind: 'session_summary'`, `body: { type: 'text', content: summaryText }`, `surface: 'kiro-ide'`
    - Handle empty/unset `USER_PROMPT` by using empty string
    - POST with `retrieve: false`, no stdout output
    - _Requirements: 4.8, 5.1, 7.3, 8.4_

  - [x] 2.5 Write property test: P1 (Event Schema Conformance) + P2 (Surface Identification)
    - **Property 1: Event Schema Conformance** — For any event type in `{promptSubmit, postToolUse, agentStop}` and any `USER_PROMPT` string, the event produced passes `parseEvent()` validation
    - **Property 2: Surface Identification Invariant** — For any event produced, `event.source.surface === 'kiro-ide'`
    - Generate random event types × random USER_PROMPT strings using fast-check
    - Mock `postEvent` to capture the event object; mock `readSession`, `process.cwd()`
    - Test file: `test/unit/ide-hook-schema-conformance.property.test.ts`
    - Minimum 100 iterations
    - **Validates: Requirements 7.1, 7.2, 7.3, 5.1, 5.4**

  - [x] 2.6 Write property test: P3 (Tool-Use Field Mapping Completeness)
    - **Property 3: Tool-Use Field Mapping Completeness** — For any valid camelCase `postToolUse` JSON payload, the event body contains `tool_name`, `tool_input`, and `tool_response` with correctly mapped values
    - Add `ideToolUsePayloadArb()` generator to `test/helpers/arbitrary.ts`
    - Test file: `test/unit/ide-hook-field-mapping.property.test.ts`
    - Minimum 100 iterations
    - **Validates: Requirements 7.2, 4.7**

  - [x] 2.7 Write property test: P4 (Graceful Degradation on Malformed Input)
    - **Property 4: Graceful Degradation** — For any non-JSON string as `USER_PROMPT` when event type is `postToolUse`, the shim produces a valid event with defaults and does not throw
    - Generate random non-JSON strings via fast-check
    - Verify event passes `parseEvent()`, `tool_name === "unknown"`, `tool_input` is `{}`
    - Test file: `test/unit/ide-hook-graceful-degradation.property.test.ts`
    - Minimum 100 iterations
    - **Validates: Requirements 4.9, 7.5, 11.1**

  - [x] 2.8 Write property test: P5 (Exit Code Safety)
    - **Property 5: Exit Code Safety** — For any input combination and any collector state (success, connection refused, timeout, non-2xx), the shim exits with code 0
    - Generate random inputs × simulated collector failures (mock `postEvent` to return null, throw, etc.)
    - Verify `main()` resolves without throwing
    - Test file: `test/unit/ide-hook-exit-safety.property.test.ts`
    - Minimum 100 iterations
    - **Validates: Requirements 11.1, 11.2**

  - [x] 2.9 Write property test: P8 (Output Channel Discipline)
    - **Property 8: Output Channel Discipline** — For any `postToolUse` or `agentStop` event, and for any error during `promptSubmit`, stdout remains empty; all diagnostics go to stderr with `[kiro-learn]` prefix
    - Mock `process.stdout.write` and `process.stderr.write` to capture output
    - Test file: `test/unit/ide-hook-output-discipline.property.test.ts`
    - Minimum 100 iterations
    - **Validates: Requirements 8.4, 11.4, 11.5**

- [x] 3. Checkpoint — Verify IDE shim module
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement IDE shim unit tests (example-based)
  - [x] 4.1 Write dispatch unit tests
    - Test event type dispatch: `promptSubmit`, `postToolUse`, `agentStop`, unknown type, missing argument
    - Verify correct handler is called for each event type
    - Verify stderr warning for unknown/missing event types
    - Test file: `test/unit/ide-hook-dispatch.test.ts`
    - _Requirements: 4.1, 4.5, 11.4_

  - [x] 4.2 Write prompt handler unit tests
    - Test text passthrough from `USER_PROMPT` to event body
    - Test empty `USER_PROMPT` produces empty content
    - Test retrieval context written to stdout when available
    - Test no stdout when retrieval context is empty or absent
    - Test file: `test/unit/ide-hook-prompt.test.ts`
    - _Requirements: 7.1, 8.1, 8.2, 8.3_

  - [x] 4.3 Write tool-use handler unit tests
    - Test full camelCase → snake_case field mapping
    - Test partial payloads (missing `toolResult`, missing `toolSuccess`, etc.)
    - Test JSON parse failure falls back to defaults
    - Test no stdout output
    - Test file: `test/unit/ide-hook-tool-use.test.ts`
    - _Requirements: 7.2, 4.7, 4.9, 8.4_

  - [x] 4.4 Write stop handler unit tests
    - Test text passthrough from `USER_PROMPT` to event body
    - Test empty `USER_PROMPT` produces empty content
    - Test no stdout output
    - Test file: `test/unit/ide-hook-stop.test.ts`
    - _Requirements: 7.3, 4.8, 8.4_

  - [x] 4.5 Write session management unit tests
    - Verify `readSession` is used (not `createSession`) for all hook types
    - Verify session file path is derived from `process.cwd()`
    - Test file: `test/unit/ide-hook-session.test.ts`
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 5. Checkpoint — Verify IDE shim tests
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement installer integration for IDE hooks
  - [x] 6.1 Implement `writeIdeHookFiles(projectRoot)` in `src/installer/index.ts`
    - Create `<projectRoot>/.kiro/hooks/` directory if it doesn't exist
    - Write three `.kiro.hook` files: `kiro-learn-prompt.kiro.hook`, `kiro-learn-stop.kiro.hook`, `kiro-learn-tool.kiro.hook`
    - Each file is valid JSON with fields: `enabled`, `name`, `description`, `version`, `when`, `then` (in that order)
    - `enabled: true`, `version: "1"`, `then.type: "runCommand"`
    - `then.command` quotes the shim path and appends `|| true` (e.g., `"~/.kiro-learn/bin/ide-shim" promptSubmit || true`)
    - `kiro-learn-tool.kiro.hook` includes `when.toolTypes: ["*"]`
    - Serialize with `JSON.stringify(obj, null, 2) + '\n'`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 13.1, 13.3, 13.4, 13.5_

  - [x] 6.2 Add `ide-shim` bin wrapper to `writeBinWrappers()`
    - Add a new wrapper at `~/.kiro-learn/bin/ide-shim` following the same pattern as the existing `shim` wrapper
    - Content: `#!/usr/bin/env node\nimport { main } from "../lib/shim/ide-hook/index.js";\nmain().catch(() => {});\n`
    - Set executable permissions (`0o755`)
    - _Requirements: 3.4, 9.3_

  - [x] 6.3 Wire `writeIdeHookFiles` into `cmdInit`
    - Call `writeIdeHookFiles(scope.projectRoot)` in `cmdInit` when `scope.projectRoot` is defined
    - Skip when `--global-only` is set or no project scope detected
    - On upgrade, overwrite existing kiro-learn hook files; preserve non-kiro-learn hooks
    - _Requirements: 9.1, 9.2, 9.4, 9.5, 9.6_

  - [x] 6.4 Extend `cmdUninstall` for IDE hook cleanup
    - When a project scope is detected, remove the three kiro-learn `.kiro.hook` files from `<projectRoot>/.kiro/hooks/`
    - Do not remove non-kiro-learn hook files or the `.kiro/hooks/` directory itself
    - Skip missing files without error (idempotent)
    - The `ide-shim` bin wrapper is removed as part of existing `~/.kiro-learn/bin/` cleanup
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 6.5 Write property test: P6 (Hook File Round-Trip) + P7 (Hook Command Format)
    - **Property 6: Hook File Round-Trip** — For any hook file object generated by the installer, `JSON.parse(JSON.stringify(hookFile, null, 2))` produces a deeply equal object
    - **Property 7: Hook Command Format** — For any shim path (including paths with spaces), `then.command` contains the quoted path, the event type argument, and ends with ` || true`
    - Add `ideHookFileArb()` and `shimPathArb()` generators to `test/helpers/arbitrary.ts`
    - Test file: `test/unit/ide-hook-file-roundtrip.property.test.ts`
    - Minimum 100 iterations
    - **Validates: Requirements 13.2, 1.8, 13.4**

  - [x] 6.6 Write installer unit tests for IDE hooks
    - Test `writeIdeHookFiles` creates correct directory and files
    - Test hook file content matches expected schema and field order
    - Test `ide-shim` bin wrapper content and permissions
    - Test `cmdUninstall` removes only kiro-learn hook files
    - Test `cmdInit` with `--global-only` skips hook file writing
    - Test file: `test/unit/ide-hook-installer.test.ts`
    - _Requirements: 1.1, 1.2, 1.3, 9.1, 9.4, 10.1, 10.2, 10.3, 10.4_

- [x] 7. Implement modularity guard tests
  - [x] 7.1 Add guard test: `src/shim/ide-hook/` does not import from `src/shim/cli-agent/`
    - Test file: `test/unit/no-cli-agent-in-ide-hook.test.ts`
    - Read `src/shim/ide-hook/index.ts` source and assert no import paths contain `cli-agent`
    - _Requirements: 12.1, 3.3_

  - [x] 7.2 Add guard test: `src/shim/shared/` does not import from `src/shim/ide-hook/`
    - Test file: `test/unit/no-ide-hook-in-shared.test.ts`
    - Read `src/shim/shared/` source files and assert no import paths contain `ide-hook`
    - _Requirements: 12.3_

  - [x] 7.3 Extend existing `no-collector-in-shim.test.ts` to cover `src/shim/ide-hook/`
    - Add `src/shim/ide-hook/index.ts` to the set of files checked for collector/installer imports
    - _Requirements: 12.2, 12.4_

- [x] 8. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (P1–P8)
- Unit tests validate specific examples and edge cases
- The design uses TypeScript throughout — no language selection needed
- All new code must follow project conventions: ESM-only, `.js` import extensions, `import type` for type-only imports, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- New test generators (`ideToolUsePayloadArb`, `ideHookFileArb`, `shimPathArb`) go in `test/helpers/arbitrary.ts`
