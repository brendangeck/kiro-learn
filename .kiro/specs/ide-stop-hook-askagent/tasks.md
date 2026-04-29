# Implementation Plan: IDE Stop Hook — askAgent Migration

## Overview

Migrate the `kiro-learn-stop.kiro.hook` IDE hook from `runCommand` to `askAgent` in `writeIdeHookFiles()`. Add a module-level `SESSION_SUMMARY_PROMPT` constant and update the stop hook entry to use it. Update existing unit tests and property tests to reflect the new hook format.

## Tasks

- [x] 1. Update `writeIdeHookFiles()` in `src/installer/index.ts`
  - [x] 1.1 Add `SESSION_SUMMARY_PROMPT` constant
    - Add a module-level (not exported) `const SESSION_SUMMARY_PROMPT` string above `writeIdeHookFiles()`
    - The prompt instructs the agent to call `save_session_summary` on the `kiro-learn-memory` MCP server with all seven required fields (`request`, `investigated`, `learned`, `completed`, `next_steps`, `files_read`, `files_modified`)
    - Must be under 200 words, instruct no additional output
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - [x] 1.2 Change the stop hook entry from `runCommand` to `askAgent`
    - In the `hookEntries` array, change the stop hook's `then` block from `{ type: 'runCommand', command: ... }` to `{ type: 'askAgent', prompt: SESSION_SUMMARY_PROMPT }`
    - Leave the prompt and tool hook entries unchanged
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2_

- [x] 2. Update unit tests in `test/unit/ide-hook-installer.test.ts`
  - [x] 2.1 Update the "stop hook has correct when.type" test
    - Extend to also verify `then.type === "askAgent"`, `then.prompt` is a non-empty string, and `then.command` is absent
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - [x] 2.2 Add test "stop hook prompt contains required fields"
    - Verify the prompt contains `save_session_summary`, `kiro-learn-memory`, and all seven field names
    - _Requirements: 3.1, 3.2, 3.3_
  - [x] 2.3 Add test "stop hook prompt is concise (under 200 words)"
    - Split prompt on whitespace and assert length < 200
    - _Requirements: N1_
  - [x] 2.4 Update "then.command quotes the shim path" test
    - This test should only check prompt and tool hooks (stop hook no longer has a command)
    - _Requirements: 2.1, 2.2_
  - [x] 2.5 Add test "upgrade from runCommand to askAgent"
    - Write old-format stop hook file with `runCommand`, call `writeIdeHookFiles`, verify new `askAgent` format
    - _Requirements: 6.1, 6.3_

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Update property test generators and property tests
  - [x] 4.1 Update `KiroHookFile` interface in `test/helpers/arbitrary.ts`
    - Change `then` from `{ type: string; command: string }` to a discriminated union: `{ type: 'runCommand'; command: string } | { type: 'askAgent'; prompt: string }`
    - _Requirements: 4.1, 4.4_
  - [x] 4.2 Update `ideHookFileArb()` generator in `test/helpers/arbitrary.ts`
    - For `agentStop` events, generate `{ type: 'askAgent', prompt: <non-empty string> }`
    - For `promptSubmit` and `postToolUse` events, continue generating `{ type: 'runCommand', command: ... }`
    - _Requirements: 1.1, 2.1, 2.2_
  - [x] 4.3 Update P6 (round-trip) property test in `test/unit/ide-hook-file-roundtrip.property.test.ts`
    - Verify round-trip still works for both `runCommand` and `askAgent` hook files
    - **Property 4: Hook File Round-Trip**
    - **Validates: Requirements 4.4**
  - [x] 4.4 Update P7 (command format) property test in `test/unit/ide-hook-file-roundtrip.property.test.ts`
    - P7 now only applies to `runCommand` hooks — filter or branch on `then.type`
    - Add a new property assertion for `askAgent` hooks: `then.prompt` is a non-empty string and `then.command` is absent
    - **Property 1: Stop Hook Uses askAgent, Property 2: Prompt and Tool Hooks Use runCommand**
    - **Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.2**

- [x] 5. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- The implementation language is TypeScript (matching the existing codebase)
- Only `src/installer/index.ts` and test files are modified — no new modules or exports
- The `handleStop` function in `src/shim/ide-hook/index.ts` is NOT modified
- Unit/property tests must NEVER spawn real kiro-cli processes
