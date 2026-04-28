# Implementation Plan: MCP Memory Server

## Overview

Add an MCP (Model Context Protocol) stdio server that exposes kiro-learn's memory as three tools — `search_memory`, `save_observation`, and `save_session_summary`. The server is a pure HTTP client of the collector daemon, living in a new `src/mcp/` module with the same modularity boundaries as the shim. Implementation proceeds in dependency order: schema extension → collector endpoints → MCP server module → installer integration → tests.

## Tasks

- [x] 1. Extend OBSERVATION_TYPES schema and add `@modelcontextprotocol/sdk` dependency
  - [x] 1.1 Add `'session_summary'` to the `OBSERVATION_TYPES` array in `src/types/schemas.ts`
    - Append `'session_summary'` after `'pattern'` in the `OBSERVATION_TYPES` const array
    - The Zod `z.enum(OBSERVATION_TYPES)` on `MemoryRecordSchema` picks it up automatically
    - _Requirements: 5.1 (save_session_summary needs this observation type)_
  - [x] 1.2 Add `@modelcontextprotocol/sdk` to `package.json` dependencies
    - Add `"@modelcontextprotocol/sdk": "1.12.1"` to the `dependencies` section (pinned, same convention as `@agentclientprotocol/sdk`)
    - Run `npm install` to update `package-lock.json`
    - _Requirements: N9_
  - [x] 1.3 Update `arbitraryMemoryRecord` generator in `test/helpers/arbitrary.ts` to include `'session_summary'` in the `observation_type` constantFrom
    - The generator already uses `fc.constantFrom(...OBSERVATION_TYPES)` so it should pick up the new value automatically — verify this is the case
    - _Requirements: 5.1_

- [x] 2. Add collector endpoints (`POST /v1/memories` and `GET /v1/memories/search`)
  - [x] 2.1 Add `POST /v1/memories` endpoint to `src/collector/receiver/index.ts`
    - Follow the exact same pattern as `POST /v1/events`: use `readBody` for body size enforcement, `JSON.parse`, validate via `parseMemoryRecord` from `src/types/`, store via `storage.putMemoryRecord()`
    - Return `200 { record_id, stored: true }` on success
    - Return `400 { error: 'validation failed', details: [...] }` on Zod validation failure
    - Enforce the same `maxBodyBytes` limit as `POST /v1/events`
    - _Requirements: 8.1, 8.2, 8.5_
  - [x] 2.2 Add `GET /v1/memories/search` endpoint to `src/collector/receiver/index.ts`
    - Read `namespace`, `query`, and `limit` from URL search params
    - Validate `namespace` against `NAMESPACE_RE` (return 400 if invalid)
    - Validate `query` is non-empty (return 400 if missing)
    - Clamp `limit` to [1, 100], default 10
    - Delegate to `storage.searchMemoryRecords({ namespace, query, limit })`
    - Return the matching records as a JSON array
    - _Requirements: 8.3, 8.4_
  - [x] 2.3 Add method enforcement for the new endpoints
    - `POST /v1/memories` should return 405 for non-POST methods
    - `GET /v1/memories/search` should return 405 for non-GET methods
    - Follow the existing pattern for method enforcement in the receiver
    - _Requirements: 8.1, 8.3_

- [x] 3. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement `src/mcp/namespace.ts` — Namespace derivation
  - [x] 4.1 Create `src/mcp/namespace.ts`
    - Implement `deriveNamespace(cwd: string): string` using the same algorithm as the shim: `project_id` = SHA-256 hex of `fs.realpathSync(cwd)`, `actor_id` from `os.userInfo().username` with fallback chain (`process.env.USER` → `process.env.USERNAME` → `'unknown'`)
    - Namespace format: `/actor/<actor_id>/project/<project_id>/`
    - Export `getActorId(): string` separately for testability
    - Use `import { createHash } from 'node:crypto'`, `import { realpathSync } from 'node:fs'`, `import { userInfo } from 'node:os'`
    - Do NOT import from `src/shim/`, `src/collector/`, or `src/installer/`
    - Use `.js` extensions on all imports, `import type` for type-only imports
    - _Requirements: 12.1, 12.2, 10.1–10.4, N11_

- [x] 5. Implement `src/mcp/client.ts` — Collector HTTP client
  - [x] 5.1 Create `src/mcp/client.ts`
    - Implement `loadCollectorConfig(): CollectorClientConfig` — reads `~/.kiro-learn/settings.json` for `collector.host` and `collector.port`, falls back to `127.0.0.1:21100`
    - Implement `postMemory(record, config): Promise<PostMemoryResult>` — `POST /v1/memories` with JSON body, 5-second timeout via `AbortController`
    - Implement `searchMemories(params, config): Promise<SearchMemoriesResult>` — `GET /v1/memories/search` with query params, 5-second timeout
    - Use `node:http.request` directly (same pattern as shim's `postEvent`)
    - Error handling: return typed `CollectorError` for connection refused, timeout, non-2xx, parse errors — never throw unhandled
    - Use proper `encodeURIComponent` for query string parameters (not string concatenation)
    - Do NOT import from `src/collector/`, `src/shim/`, or `src/installer/`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, N8_

- [x] 6. Implement `src/mcp/tools.ts` — Tool handler implementations
  - [x] 6.1 Create `src/mcp/tools.ts`
    - Implement `validateSearchArgs(args)` — validate `query` (string, required, non-empty, ≤1000 chars), `limit` (number, optional, default 10)
    - Implement `validateObservationArgs(args)` — validate `title` (string, ≤200), `summary` (string, ≤4000), `observation_type` (enum), `concepts` (array, ≤50 entries), `files_touched` (array, ≤100 entries), `facts` (array, ≤50 entries)
    - Implement `validateSessionSummaryArgs(args)` — validate all 7 required string/array fields
    - Implement `handleSearchMemory(args, ctx)` — validate → `searchMemories` → `formatSearchResults` → return `ToolResult`
    - Implement `handleSaveObservation(args, ctx)` — validate → construct `MemoryRecord` (generate `record_id` via `mr_` + ULID, strategy `'mcp_observation'`, `source_event_ids` with synthetic ULID) → `postMemory` → return confirmation
    - Implement `handleSaveSessionSummary(args, ctx)` — validate → construct `MemoryRecord` (title from `request` truncated to 200, summary from formatted concatenation truncated to 4000, `observation_type: 'session_summary'`, strategy `'mcp_session_summary'`, `files_touched` = deduplicated union of `files_read` + `files_modified`) → `postMemory` → return confirmation
    - Implement `formatSearchResults(records)` — format each record as text block with title, summary, concepts (comma-separated), files_touched (newline-separated); separate records with blank lines; return "No matching memories found" for empty results
    - All handlers wrap logic in try/catch and return error `ToolResult` on any exception (never crash)
    - Private tags pass through unchanged — no scrubbing
    - _Requirements: 2.1–2.4, 3.1–3.6, 4.1–4.5, 5.1–5.4, 7.1–7.5, 11.1–11.5, 12.3, 12.4, 13.1–13.3_

- [x] 7. Implement `src/mcp/index.ts` — MCP server entry point
  - [x] 7.1 Create `src/mcp/index.ts`
    - Import `Server` from `@modelcontextprotocol/sdk/server/index.js` and `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`
    - Create `Server` instance with name `'kiro-learn-memory'` and version read from package.json
    - Register `ListToolsRequestSchema` handler returning the three tool definitions with their JSON schemas (as specified in the design)
    - Register `CallToolRequestSchema` handler dispatching to `handleSearchMemory`, `handleSaveObservation`, `handleSaveSessionSummary` based on tool name
    - Derive namespace once at startup via `deriveNamespace(process.cwd())`
    - Load collector config once at startup via `loadCollectorConfig()`
    - Export `main()` async function that creates server, connects transport, and awaits
    - Log errors to stderr only — never write non-JSON-RPC content to stdout
    - _Requirements: 1.1–1.6, 2.1–2.4, N1, N6, N9_

- [x] 8. Checkpoint
  - Ensure the project typechecks (`npm run typecheck`). Ensure all existing tests pass (`npm run test`). Ask the user if questions arise.

- [x] 9. Installer integration
  - [x] 9.1 Add `mcp-server` bin wrapper to `writeBinWrappers()` in `src/installer/index.ts`
    - Add a new wrapper at `~/.kiro-learn/bin/mcp-server` with content:
      ```
      #!/usr/bin/env node
      import { main } from "../lib/mcp/index.js";
      main().catch((err) => { process.stderr.write(String(err) + '\n'); process.exit(1); });
      ```
    - chmod 0o755
    - _Requirements: 9.3, 9.4_
  - [x] 9.2 Add `writeMcpConfig(projectRoot: string)` function to `src/installer/index.ts`
    - Write `.kiro/settings/mcp.json` in the project root with `mcpServers.kiro-learn-memory` entry pointing to the bin wrapper path
    - Create `.kiro/settings/` directory if it doesn't exist
    - _Requirements: 9.1, 9.2_
  - [x] 9.3 Wire `writeMcpConfig` into `cmdInit`
    - Call `writeMcpConfig(scope.projectRoot)` when project scope is detected (after existing project-scope setup)
    - _Requirements: 9.1_
  - [x] 9.4 Wire MCP cleanup into `cmdUninstall`
    - Remove `.kiro/settings/mcp.json` from the project root when project scope is detected
    - The `mcp-server` bin wrapper is already cleaned up by the existing `rmSync(INSTALL_DIR)` in uninstall
    - _Requirements: 9.5, 9.6_
  - [x] 9.5 Add `@modelcontextprotocol/sdk` to the runtime `writePackageJson()` dependencies
    - Add `'@modelcontextprotocol/sdk': '1.12.1'` to the `runtimePkg.dependencies` object
    - _Requirements: N9_
  - [x] 9.6 Add `'mcp'` to the `requiredSubdirs` array in `deployPayload()`
    - Ensures `dist/mcp/` is copied to `~/.kiro-learn/lib/mcp/` during install
    - _Requirements: 9.3_

- [x] 10. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Guard tests for MCP modularity boundary
  - [x] 11.1 Create `test/unit/no-forbidden-imports-in-mcp.test.ts`
    - Follow the exact pattern of `test/unit/no-collector-in-shim.test.ts`
    - Three `it()` blocks:
      1. `src/mcp/` does not import from `src/collector/`
      2. `src/mcp/` does not import from `src/shim/`
      3. `src/mcp/` does not import from `src/installer/`
    - Use `collectTsFiles` + `stripComments` + regex scan pattern
    - _Requirements: 10.1–10.5, N12_

- [x] 12. Collector endpoint tests
  - [x] 12.1 Create `test/unit/mcp-receiver-endpoints.test.ts`
    - Follow the exact pattern of `test/unit/read-api-stats.test.ts`: start a real receiver with in-memory SQLite, mock pipeline/retrieval
    - Test `POST /v1/memories` happy path: valid record → 200 with `{ record_id, stored: true }`
    - Test `POST /v1/memories` validation failure: invalid body → 400 with error details
    - Test `POST /v1/memories` body size limit: oversized body → 413
    - Test `GET /v1/memories/search` happy path: seeded records → matching results
    - Test `GET /v1/memories/search` missing query → 400
    - Test `GET /v1/memories/search` invalid namespace → 400
    - Test method enforcement: GET on `/v1/memories` (POST-only) → 405, POST on `/v1/memories/search` → 405
    - _Requirements: 8.1–8.5_

- [x] 13. MCP server unit tests
  - [x] 13.1 Create `test/unit/mcp-tools.test.ts`
    - Test `handleSearchMemory` happy path with mocked client
    - Test `handleSearchMemory` with empty query → error result
    - Test `handleSaveObservation` happy path → confirmation with record_id
    - Test `handleSaveObservation` with invalid observation_type → error result
    - Test `handleSaveSessionSummary` happy path → confirmation with record_id
    - Test `handleSaveSessionSummary` title truncation to 200 chars
    - Test `handleSaveSessionSummary` summary truncation to 4000 chars
    - Test error handling: connection refused → error result (server continues)
    - Test error handling: timeout → error result (server continues)
    - Test `formatSearchResults` with zero results → "No matching memories" message
    - Test `formatSearchResults` with multiple results → correct text format
    - _Requirements: 2.1–2.4, 3.1–3.6, 4.1–4.5, 5.1–5.4, 7.1–7.5, 13.1–13.3_
  - [x] 13.2 Create `test/unit/mcp-client.test.ts`
    - Test `loadCollectorConfig` with valid settings.json → correct host/port
    - Test `loadCollectorConfig` with missing file → defaults
    - Test `postMemory` request construction (correct path, method, headers, body)
    - Test `searchMemories` request construction (correct path, query params, encoding)
    - Test error handling: non-2xx response → typed error
    - Test error handling: connection refused → typed error
    - _Requirements: 6.1–6.6_
  - [x] 13.3 Create `test/unit/mcp-namespace.test.ts`
    - Test `deriveNamespace` produces correct namespace format
    - Test `getActorId` fallback chain: `os.userInfo()` → `USER` env → `USERNAME` env → `'unknown'`
    - Test namespace contains SHA-256 hex of resolved cwd
    - _Requirements: 12.1, 12.2_

- [x] 14. Add fast-check generators to `test/helpers/arbitrary.ts`
  - [x] 14.1 Add `arbitrarySearchMemoryArgs()` generator
    - Generates valid `{ query: string, limit?: number }` objects
    - `query`: non-empty string ≤1000 chars, `limit`: optional number 1–100
    - _Requirements: 3.1, 11.1_
  - [x] 14.2 Add `arbitraryObservationArgs()` generator
    - Generates valid `{ title, summary, observation_type, concepts, files_touched, facts }` objects
    - Respects all size constraints from the design
    - _Requirements: 4.1, 11.2–11.4_
  - [x] 14.3 Add `arbitrarySessionSummaryArgs()` generator
    - Generates valid `{ request, investigated, learned, completed, next_steps, files_read, files_modified }` objects
    - _Requirements: 5.1_
  - [x] 14.4 Add `arbitraryMalformedToolArgs()` generator
    - Generates structurally invalid tool arguments: missing required fields, wrong types (e.g., `query` as number, `concepts` as string)
    - _Requirements: 7.3_
  - [x] 14.5 Add `arbitraryOverLimitObservationArgs()` generator
    - Generates observation args where at least one field exceeds its limit: `title` > 200, `summary` > 4000, `concepts` > 50 entries, `files_touched` > 100 entries, `facts` > 50 entries
    - _Requirements: 4.4, 4.5, 11.1–11.4_

- [x] 15. Property-based tests
  - [x] 15.1 Create `test/unit/mcp-format.property.test.ts`
    - **Property 1: Search result formatting contains all required fields**
    - **Validates: Requirements 3.2, 13.1**
    - For any non-empty array of memory records, `formatSearchResults` output contains each record's title, summary, every concept, and every file
  - [x] 15.2 Create `test/unit/mcp-format-separation.property.test.ts` (can be in same file as 15.1)
    - **Property 2: Multiple search results are separated by blank lines**
    - **Validates: Requirements 13.2**
    - For any array of 2+ records, output has N-1 blank-line separators and titles appear in input order
  - [x] 15.3 Create `test/unit/mcp-validation.property.test.ts`
    - **Property 3: Invalid observation types are rejected**
    - **Validates: Requirements 4.3**
    - For any string not in `OBSERVATION_TYPES`, `validateObservationArgs` returns a validation error
  - [x] 15.4 Add to `test/unit/mcp-validation.property.test.ts`
    - **Property 4: Over-limit fields are rejected by validation**
    - **Validates: Requirements 4.4, 4.5, 11.1, 11.2, 11.3, 11.4**
    - For any input with a size-constrained field exceeding its limit, the validation function returns an error
  - [x] 15.5 Add to `test/unit/mcp-validation.property.test.ts`
    - **Property 5: Structurally malformed tool inputs produce error results**
    - **Validates: Requirements 7.3**
    - For any args object missing a required field or with wrong-typed field, validation returns an error
  - [x] 15.6 Create `test/unit/mcp-session-summary.property.test.ts`
    - **Property 6: Session summary construction respects size limits and includes all fields**
    - **Validates: Requirements 5.3, 5.4**
    - For any valid session summary input, the constructed record has title ≤200, summary ≤4000, and summary contains substrings from each body field when total length permits
  - [x] 15.7 Create `test/unit/mcp-config.property.test.ts`
    - **Property 7: Config loading returns valid host/port or defaults**
    - **Validates: Requirements 6.2**
    - For any settings.json content (valid, invalid, missing), `loadCollectorConfig` returns non-empty host and positive port; defaults when malformed
  - [x] 15.8 Create `test/unit/mcp-passthrough.property.test.ts`
    - **Property 8: Private tags pass through unchanged**
    - **Validates: Requirements 11.5**
    - For any string with `<private>` tags passed as a tool argument, validation and construction preserve the string byte-for-byte
  - [x] 15.9 Create `test/unit/mcp-namespace.property.test.ts`
    - **Property 9: Namespace derivation produces a valid namespace**
    - **Validates: Requirements 12.1**
    - For any absolute path and actor ID, `deriveNamespace` produces a string matching `/actor/<id>/project/<64-hex>/`

- [x] 16. Final checkpoint
  - Ensure all tests pass (`npm run test`), typecheck passes (`npm run typecheck`), and lint passes (`npm run lint`). Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The `src/mcp/` module follows the same modularity pattern as `src/shim/` — pure HTTP client, no imports from collector/installer
- All TypeScript code must follow project conventions: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, ESM with `.js` extensions
