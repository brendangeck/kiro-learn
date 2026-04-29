# Implementation Plan: Kiro CLI Agent Shim

## Overview

Implement the kiro-learn shim — the thin per-client adapter that bridges Kiro CLI agent hooks and the collector daemon. The shim reads hook input from stdin, builds a canonical `KiroMemEvent`, POSTs it to the collector, and returns retrieval context to the Kiro runtime via stdout. The implementation is split into a shared module (reusable across future shim surfaces) and a CLI-agent-specific module.

## Tasks

- [x] 1. Add `ulidx` dependency
  - Add `ulidx` to `dependencies` in `package.json`
  - Run `npm install` to refresh the lockfile
  - Verify `npm run typecheck` still passes
  - _Requirements: 3.1_

- [x] 2. Implement shared shim module (`src/shim/shared/index.ts`)
  - [x] 2.1 Implement `loadConfig` and `DEFAULT_SHIM_CONFIG`
    - Export `ShimConfig` interface with `collectorHost`, `collectorPort`, `timeoutMs`, `maxBodyBytes`
    - Export `DEFAULT_SHIM_CONFIG` with defaults: host `127.0.0.1`, port `21100`, timeout `2000`, maxBodyBytes `524_288`
    - Implement `loadConfig()`: synchronous read of `~/.kiro-learn/settings.json`, merge with defaults, return defaults on any error
    - Support config keys: `collector.host`, `collector.port`, `shim.timeoutMs`
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 2.2 Implement session management: `sessionFilePath`, `createSession`, `readSession`
    - `sessionFilePath(cwd)`: resolve cwd via `fs.realpathSync`, MD5 hash, take first 16 hex chars, return `/tmp/kiro-learn-session-<hash>`
    - `createSession(cwd)`: generate UUID via `crypto.randomUUID()`, write to session file, return UUID
    - `readSession(cwd)`: read session file, return contents; on failure generate fallback UUID, write it, return it
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 2.3 Implement `buildEvent`
    - Export `EventBuildParams` interface
    - Generate `event_id` via `ulidx`
    - Derive `project_id` as hex SHA-256 of `fs.realpathSync(cwd)`
    - Set `actor_id` from `os.userInfo().username`
    - Construct `namespace` as `/actor/<actor_id>/project/<project_id>/`
    - Set `schema_version: 1`, `valid_time` as ISO 8601, `source.surface: 'kiro-cli'`, `source.version` from package version, `source.client_id` from `os.hostname()`
    - Omit `parent_event_id` when undefined
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 8.1, 8.2, 8.3, 8.4_

  - [x] 2.4 Implement `truncateBody`
    - Check `Buffer.byteLength(JSON.stringify(body), 'utf8')` against `maxBytes`; return unchanged if within budget
    - For `text` bodies: iteratively trim `content` by 10% until under budget, append `[truncated by kiro-learn]` marker
    - For `message` bodies: trim last turn's `content` by 10% iteratively, append marker
    - For `json` bodies: if `data.tool_response.result` is a string, trim it first; otherwise stringify entire data and truncate as string with `_truncated` wrapper
    - Never mutate the input body — return a new object
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 2.5 Implement `postEvent`
    - Export `PostEventOptions` interface with `retrieve: boolean`
    - Use `node:http.request` to POST to `http://<host>:<port>/v1/events` (append `?retrieve=true` when `opts.retrieve` is true)
    - Set `Content-Type: application/json` header
    - Enforce timeout via `AbortController` + `setTimeout`
    - On success (2xx): parse response body as JSON, return `EventIngestResponse`
    - On failure (non-2xx, timeout, ECONNREFUSED, parse error): log warning to stderr with `[kiro-learn]` prefix, return `null`
    - Never throw — all errors are caught and return `null`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 7.5_

- [x] 3. Implement CLI agent shim (`src/shim/cli-agent/index.ts`)
  - [x] 3.1 Implement `main` entry point and stdin parsing
    - Export `HookInputBase`, `AgentSpawnInput`, `UserPromptSubmitInput`, `PostToolUseInput`, `StopInput`, `HookInput` types
    - Read stdin synchronously (entire buffer)
    - Parse as JSON; on failure log `[kiro-learn] failed to parse stdin JSON` to stderr, return
    - Validate `cwd` is present; on missing log `[kiro-learn] missing cwd in hook input` to stderr, return
    - Dispatch on `hook_event_name` to the appropriate handler
    - On unrecognized hook: log `[kiro-learn] unrecognized hook: <name>` to stderr, return
    - Wrap entire function in top-level try/catch — log unexpected errors to stderr, never throw
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 7.1, 7.2, 7.3, 7.5_

  - [x] 3.2 Implement `handleSpawn`
    - Call `createSession(input.cwd)` to generate and persist session ID
    - Build event: `kind: 'note'`, `body: { type: 'text', content: 'session started' }`
    - POST to collector with `retrieve: false`
    - Write `kiro-learn session <uuid>\n` to stdout
    - _Requirements: 2.1, 4.1, 6.1_

  - [x] 3.3 Implement `handlePrompt`
    - Call `readSession(input.cwd)` to get session ID
    - Build event: `kind: 'prompt'`, `body: { type: 'text', content: input.prompt ?? '' }`
    - Apply `truncateBody` before building event
    - POST to collector with `retrieve: true`
    - If response has non-empty `retrieval.context`, write it to stdout
    - If no retrieval or empty context, write nothing to stdout
    - _Requirements: 2.3, 4.2, 4.5, 5.2, 6.2, 6.3_

  - [x] 3.4 Implement `handleObserve`
    - Call `readSession(input.cwd)` to get session ID
    - Build event: `kind: 'tool_use'`, `body: { type: 'json', data: { tool_name, tool_input, tool_response } }` with defaults for missing fields
    - Apply `truncateBody` before building event
    - POST to collector with `retrieve: false`
    - No stdout output
    - _Requirements: 2.3, 4.3, 4.5, 6.4_

  - [x] 3.5 Implement `handleSummarize`
    - Call `readSession(input.cwd)` to get session ID
    - Build event: `kind: 'session_summary'`, `body: { type: 'text', content: input.assistant_response ?? '' }`
    - Apply `truncateBody` before building event
    - POST to collector with `retrieve: false`
    - No stdout output
    - _Requirements: 2.3, 4.4, 4.5, 6.4_

- [x] 4. Write unit tests for shared module
  - [x] 4.1 Unit tests for `loadConfig`
    - Test: returns defaults when settings file does not exist
    - Test: merges partial overrides from settings file
    - Test: returns defaults when settings file contains invalid JSON
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 4.2 Unit tests for session management
    - Test: `createSession` writes UUID to expected path and returns it
    - Test: `readSession` returns the UUID written by `createSession`
    - Test: `readSession` generates fallback UUID when session file is missing
    - Test: `sessionFilePath` produces deterministic path from cwd
    - Test: `sessionFilePath` resolves symlinks before hashing
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

  - [x] 4.3 Unit tests for `buildEvent`
    - Test: produced event passes `parseEvent` validation
    - Test: `namespace` matches expected `/actor/<user>/project/<sha256>/` pattern
    - Test: `event_id` matches ULID regex
    - Test: `source.surface` is `'kiro-cli'`
    - Test: `parent_event_id` is omitted when undefined
    - _Requirements: 3.1, 3.3, 3.4, 3.7, 8.3_

  - [x] 4.4 Unit tests for `truncateBody`
    - Test: returns body unchanged when under budget
    - Test: truncates text body content and appends marker
    - Test: truncates json body `tool_response.result` first, preserving `tool_name` and `tool_input`
    - Test: truncated body type matches original body type
    - Test: truncated body serialized size is within budget (plus marker)
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 4.5 Unit tests for `postEvent`
    - Test: sends POST with correct path, headers, and body (use a local HTTP server)
    - Test: appends `?retrieve=true` when `opts.retrieve` is true
    - Test: returns `null` on connection refused (no stderr crash)
    - Test: returns `null` on timeout
    - Test: returns `null` on non-2xx response
    - Test: returns parsed `EventIngestResponse` on success
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 5.7_

- [x] 5. Write property tests
  - [x] 5.1 Property test: Namespace determinism (Property 2)
    - **Property 2: Namespace determinism**
    - For any cwd string, calling `buildEvent` twice with the same cwd produces identical `namespace` fields
    - For any two distinct cwd strings, the `namespace` fields differ (with overwhelming probability)
    - **Validates: Requirements 3.4, 8.1, 8.2, 8.3, 8.4**

  - [x] 5.2 Property test: Event schema compliance (Property 3)
    - **Property 3: Event schema compliance**
    - For any valid hook input (generated via arbitrary generators for each hook type), the constructed `KiroMemEvent` passes `parseEvent` validation
    - Generate arbitrary `kind`, `body` variants, `sessionId`, and `cwd` values
    - **Validates: Requirements 3.1–3.9, 4.1–4.5**

 - [x] 5.3 Property test: Body size bound (Property 4)
    - **Property 4: Body size bound**
    - For any event body (text, message, json) of arbitrary size, `truncateBody(body, maxBytes)` produces a body whose `Buffer.byteLength(JSON.stringify(result), 'utf8')` is ≤ `maxBytes + 26` (marker length)
    - Generate oversized bodies (text with large content, json with large tool_response.result)
    - **Validates: Requirements 10.1, 10.2, 10.3, 10.4**

  - [x] 5.4 Property test: Truncation preserves body type (Property 7)
    - **Property 7: Truncation preserves body type**
    - For any event body and any byte limit, `truncateBody(body, limit).type === body.type`
    - **Validates: Requirements 10.2, 10.3, 10.4**

- [x] 6. Write modularity guard test
  - [x] 6.1 Guard test: no collector/installer imports in shim modules
    - Create `test/no-collector-in-shim.test.ts` following the pattern in `test/no-sqlite-in-pipeline.test.ts`
    - Scan `src/shim/shared/` and `src/shim/cli-agent/` for imports from `src/collector/` or `src/installer/`
    - Scan `src/shim/shared/` for imports from `src/shim/cli-agent/` (dependency direction violation)
    - Any match is a modularity violation — the test should fail with a clear message
    - _Requirements: 11.3, 11.4, Design § Module Structure_

- [x] 7. Checkpoint
  - Verify `npm run typecheck && npm run lint && npm run test` is green
  - Ask the user if questions arise

## Notes

- Tasks are ordered by dependency: dependency install → shared module → CLI module → tests → guard
- The shared module (`src/shim/shared/`) is implemented first because the CLI module depends on it
- Property tests use the existing `fast-check` and `vitest` dev dependencies
- The `ulidx` package is the only new production dependency
- All session file operations use synchronous fs calls — the shim is a short-lived process with a 3-second budget
- The shim does NOT validate hook input with Zod — it is a best-effort parser that degrades gracefully on malformed input
- `postEvent` uses `node:http` directly — no third-party HTTP client
- The modularity guard test enforces the dependency direction: `cli-agent → shared → types`, never the reverse, and never into `collector/` or `installer/`
