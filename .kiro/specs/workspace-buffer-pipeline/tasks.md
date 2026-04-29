# Implementation Plan: Workspace Buffer Pipeline

## Overview

Replace the current per-event extraction model with project-scoped append-only NDJSON buffers. The pipeline appends scrubbed events to per-project buffer files; extraction fires on idle timer or size threshold. Implementation builds incrementally: types → store → watcher → extraction worker → pipeline integration → collector wiring → xml-framer extension → guard tests → property tests.

All code is TypeScript (ESM-only, Node ≥ 22, `.js` import extensions, `import type` for type-only imports). The buffer module lives at `src/collector/buffer/` and receives `StorageBackend` via DI — it must NOT import from `src/collector/storage/sqlite/`.

## Tasks

- [x] 1. Define BufferEntry type and project ID utility
  - [x] 1.1 Create `src/collector/buffer/types.ts` with the `BufferEntry` interface
    - Define `BufferEntry` with fields: `event_id`, `namespace`, `kind`, `body`, `timestamp`, `surface`
    - Use `import type { KiroMemEvent }` for the `kind` and `body` field types
    - Add `toBufferEntry(event: KiroMemEvent): BufferEntry` projection function
    - Add `extractProjectId(namespace: string): string` utility (regex extraction of project segment from namespace)
    - This type is internal to `src/collector/buffer/` — not exported to `src/types/`
    - _Requirements: 2.1, 2.2, 2.3, 4.1, 4.2_

  - [x] 1.2 Write property test for BufferEntry projection correctness (Property 4)
    - **Property 4: BufferEntry projection correctness**
    - For any valid scrubbed KiroMemEvent, projecting to BufferEntry preserves `event_id`, `namespace`, `kind`, `body`, `valid_time` → `timestamp`, `source.surface` → `surface`, and omits `schema_version`, `content_hash`, `parent_event_id`, `session_id`, full `source` block
    - Use `arbitraryCleanEvent()` from `test/helpers/arbitrary.ts`
    - Test file: `test/unit/buffer-entry-projection.property.test.ts`
    - **Validates: Requirements 2.1, 2.2**

  - [x] 1.3 Write property test for project ID extraction determinism (Property 5)
    - **Property 5: Project ID extraction determinism**
    - For any string, `extractProjectId` is pure: same input → same output. For namespace-pattern strings, output equals the `<pid>` segment. For non-matching strings, output equals the full input.
    - Use `namespaceArb()` and `fc.string()` from `test/helpers/arbitrary.ts`
    - Test file: `test/unit/buffer-project-id.property.test.ts`
    - **Validates: Requirements 4.1, 4.2**

- [x] 2. Implement BufferStore (NDJSON file management)
  - [x] 2.1 Create `src/collector/buffer/store.ts` with the `BufferStore` implementation
    - Implement `append(projectId, entry)`: serialize BufferEntry as JSON + newline, `appendFileSync` with shared flock, return bytes written
    - Implement `snapshot(projectId)`: read file line-by-line, `JSON.parse` each line in try/catch, skip corrupt lines with stderr warning
    - Implement `size(projectId)`: `statSync` the buffer file, return 0 if file does not exist
    - Implement `bufferPath(projectId)`: resolve `<bufferDir>/<projectId>/buffer.ndjson`
    - Implement `listProjects()`: read buffer directory, return project IDs that have buffer files
    - Implement `clear(projectId)`: remove the buffer file via `unlinkSync`
    - Create buffer directory on first append (`mkdirSync` with `recursive: true`)
    - Accept `bufferDir` as constructor parameter (default `~/.kiro-learn/buffers/`)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 3.1, 3.2, 3.3_

  - [x] 2.2 Write property test for append/snapshot round-trip (Property 1)
    - **Property 1: Append/snapshot round-trip**
    - For any sequence of valid BufferEntry objects appended to a project buffer, reading a snapshot yields the same set (order-independent by `event_id`)
    - Use temp directories for isolation
    - Test file: `test/unit/buffer-store-roundtrip.property.test.ts`
    - **Validates: Requirements 1.1, 1.4, 1.5, 3.1**

  - [x] 2.3 Write property test for NDJSON serialization round-trip (Property 2)
    - **Property 2: NDJSON serialization round-trip**
    - For any valid BufferEntry, serializing to NDJSON line and parsing back yields an identical object
    - Test file: `test/unit/buffer-ndjson-roundtrip.property.test.ts`
    - **Validates: Requirements 3.1, 3.3**

  - [x] 2.4 Write property test for concurrent append safety (Property 3)
    - **Property 3: Concurrent append safety**
    - Multiple parallel appends to the same buffer file produce valid NDJSON where every entry appears exactly once in the snapshot
    - Test file: `test/unit/buffer-concurrent-append.property.test.ts`
    - **Validates: Requirements 1.3, 1.5**

  - [x] 2.5 Write unit tests for BufferStore
    - Test corrupt-line handling in snapshot (incomplete JSON line is skipped)
    - Test `size()` returns 0 for non-existent file
    - Test `clear()` removes the file
    - Test `listProjects()` returns correct project IDs
    - Test mkdir-on-first-append behavior
    - Test file: `test/unit/buffer-store.test.ts`
    - _Requirements: 1.1, 1.2, 1.5, 1.6, 1.7, 1.8, 3.2, 14.3_

- [x] 3. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement BufferWatcher (idle timer + size threshold + circuit breaker)
  - [x] 4.1 Create `src/collector/buffer/watcher.ts` with the `BufferWatcher` implementation
    - Implement `notifyAppend(projectId, appendedBytes)`: reset idle timer, accumulate bytes, check size threshold, check hard ceiling, return boolean
    - Implement `notifyExtractionResult(projectId, success)`: increment/reset consecutive failure counter, trip circuit breaker at threshold
    - Implement `onExtraction(handler)`: register extraction trigger listener
    - Implement `close()`: clear all timers and pending triggers
    - Per-project state: `currentBytes`, `idleTimer`, `extractionInFlight`, `consecutiveFailures`, `extractionDisabled`, `sizeCeilingWarningLogged`
    - Idle timer: start/reset on `notifyAppend`, fire extraction trigger on expiry
    - Size threshold: fire extraction trigger when accumulated bytes exceed threshold
    - Extraction deduplication: suppress triggers while extraction is in-flight for a project
    - Circuit breaker: disable extraction after `maxConsecutiveFailures` consecutive failures, log warning to stderr
    - Hard size ceiling: return `false` from `notifyAppend` when ceiling exceeded, log warning once per project
    - Accept `BufferWatcherConfig` with defaults: `idleMs: 5000`, `extractionSizeThreshold: 262_144`, `bufferMaxBytes: 4_194_304`, `maxConsecutiveFailures: 3`
    - _Requirements: 5.1, 5.2, 5.3, 6.1, 6.2, 7.1, 7.2, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 4.2 Write property test for circuit breaker monotonicity and reset (Property 6)
    - **Property 6: Circuit breaker monotonicity and reset**
    - For any sequence of `notifyExtractionResult(id, success)` calls, failure counter increases by 1 on `false`, resets to 0 on `true`. After exactly `maxConsecutiveFailures` consecutive `false` calls, `extractionDisabled` is `true`. A single `true` resets everything.
    - Test file: `test/unit/buffer-circuit-breaker.property.test.ts`
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4**

  - [x] 4.3 Write property test for size ceiling idempotence (Property 7)
    - **Property 7: Size ceiling idempotence**
    - Once `notifyAppend` returns `false` for a project, it continues returning `false` for any `appendedBytes > 0` until the buffer is cleared and byte counter reset
    - Test file: `test/unit/buffer-size-ceiling.property.test.ts`
    - **Validates: Requirements 9.1, 9.3, 9.5**

  - [x] 4.4 Write property test for size threshold extraction trigger (Property 10)
    - **Property 10: Size threshold extraction trigger**
    - For any sequence of `notifyAppend` calls whose cumulative bytes cross the extraction size threshold, the watcher fires an extraction trigger at or after the threshold-crossing call
    - Test file: `test/unit/buffer-size-trigger.property.test.ts`
    - **Validates: Requirements 6.1, 6.2**

  - [x] 4.5 Write unit tests for BufferWatcher
    - Test idle timer fires extraction after configured idle period (use `vi.useFakeTimers()`)
    - Test idle timer resets on each `notifyAppend`
    - Test extraction deduplication (no re-trigger while in-flight)
    - Test `close()` clears all timers
    - Test hard size ceiling warning logged only once per project
    - Test file: `test/unit/buffer-watcher.test.ts`
    - _Requirements: 5.1, 5.2, 7.1, 7.2, 9.2, 9.3_

- [x] 5. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement ExtractionWorker (batch extraction via ACP)
  - [x] 6.1 Create `src/collector/buffer/extraction.ts` with the `ExtractionWorker` implementation
    - Implement `extract(projectId)`: read buffer snapshot, frame as batch XML, send to ACP, parse response, store memory records, clear buffer on success
    - Implement `drain(timeoutMs)`: wait for all in-flight extractions to complete or timeout
    - Expose `active` count for testing
    - Semaphore-based concurrency control (same pattern as existing `ExtractionStage`)
    - Derive `namespace` from buffer entries (all entries in a project buffer share the same namespace)
    - Populate `source_event_ids` on each memory record with all `event_id` values from the batch
    - Call `watcher.notifyExtractionResult(projectId, true/false)` after each attempt
    - Retry transient failures up to `maxRetries` within a single extraction attempt
    - Accept dependencies via DI: `BufferStore`, `BufferWatcher`, `StorageBackend`
    - Accept `ExtractionWorkerConfig` with defaults: `concurrency: 2`, `timeoutMs: 60_000`, `maxRetries: 3`
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 11.1, 11.2, 11.3, 11.4_

  - [x] 6.2 Write unit tests for ExtractionWorker
    - Test batch framing calls `frameBatch` with buffer snapshot entries
    - Test memory record storage with correct `namespace` and `source_event_ids`
    - Test buffer cleared after successful extraction
    - Test buffer NOT cleared after failed extraction
    - Test `notifyExtractionResult` called with correct success/failure status
    - Test concurrency semaphore limits parallel extractions
    - Test `drain()` waits for in-flight extractions
    - **IMPORTANT: Mock the ACP session (which spawns `kiro-cli` as a child process). Unit/property tests must NEVER spawn real `kiro-cli` processes — that's what integ tests are for. Mock `createAcpSession` to return a fake session with a controllable `sendPrompt` response.**
    - Mock storage backend
    - Test file: `test/unit/buffer-extraction-worker.test.ts`
    - _Requirements: 10.1, 10.2, 10.4, 10.5, 10.6, 10.7, 10.8, 11.1, 11.4_

- [x] 7. Extend xml-framer with `frameBatch` for multiple events
  - [x] 7.1 Add `frameBatch(entries: BufferEntry[]): string` to `src/collector/pipeline/xml-framer.ts`
    - Frame each BufferEntry as a `<tool_observation>` block (reuse existing framing logic per entry)
    - Concatenate all blocks into a single string for the batch prompt
    - Import `BufferEntry` type from `../buffer/types.js`
    - _Requirements: 10.2_

  - [x] 7.2 Write property test for batch framing integrity (Property 8)
    - **Property 8: Batch framing integrity**
    - For any non-empty list of valid BufferEntry objects, `frameBatch(entries)` produces valid XML containing exactly one `<tool_observation>` block per entry, with all text content XML-escaped
    - **IMPORTANT: This test exercises XML framing only — it must NOT invoke ACP or spawn `kiro-cli`. The `frameBatch` function is pure string transformation with no process dependencies.**
    - Test file: `test/unit/buffer-batch-framing.property.test.ts`
    - **Validates: Requirement 10.2**

- [x] 8. Create buffer module barrel export
  - [x] 8.1 Create `src/collector/buffer/index.ts` barrel export
    - Re-export `BufferStore` (type + factory), `BufferWatcher` (type + factory), `ExtractionWorker` (type + factory)
    - Re-export `BufferEntry` type and `toBufferEntry`, `extractProjectId` utilities
    - Re-export config types: `BufferWatcherConfig`, `ExtractionWorkerConfig`
    - _Requirements: 17.1_

- [x] 9. Modify pipeline to support buffer mode
  - [x] 9.1 Modify `src/collector/pipeline/index.ts` to add buffer append path
    - Extend `PipelineOptions` with optional buffer dependencies: `bufferStore?`, `bufferWatcher?`, `bufferEnabled?`
    - In `createPipeline`, after `putEvent()` (unchanged), if buffer mode is enabled: project `toBufferEntry(scrubbedEvent)`, call `watcher.notifyAppend()`, if returns `true` then `bufferStore.append()`, catch and log write failures
    - When buffer mode is enabled, do NOT enqueue events for per-event extraction
    - When buffer mode is disabled (or buffer deps not provided), use existing per-event extraction path unchanged
    - Wrap buffer append in try/catch — failures log to stderr but do not affect the HTTP response
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 14.1, 14.2_

  - [x] 9.2 Write property test for pipeline stores before buffering (Property 9)
    - **Property 9: Pipeline stores before buffering**
    - For any event processed with buffer mode enabled, `putEvent()` is called before buffer append, ensuring durable storage regardless of buffer outcome
    - Use mock `StorageBackend` and `BufferStore` that record call order
    - Test file: `test/unit/buffer-pipeline-order.property.test.ts`
    - **Validates: Requirements 12.1, 14.2**

  - [x] 9.3 Write unit tests for pipeline buffer integration
    - Test that pipeline with buffer mode stores event in SQLite AND appends to buffer
    - Test that pipeline with buffer mode does NOT enqueue per-event extraction
    - Test that pipeline without buffer mode uses existing per-event extraction unchanged
    - Test that buffer write failure does not affect HTTP response
    - Test that `notifyAppend` returning `false` skips buffer append but event is still stored
    - Test file: `test/unit/buffer-pipeline-integration.test.ts`
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 14.1, 14.2, 16.1_

- [x] 10. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Wire buffer components into collector daemon
  - [x] 11.1 Extend `CollectorConfig` in `src/collector/index.ts` with buffer configuration
    - Add `bufferEnabled` (default `true`), `bufferIdleMs`, `bufferExtractionThreshold`, `bufferMaxBytes`, `bufferMaxConsecutiveFailures`, `bufferExtractionConcurrency`, `bufferExtractionTimeoutMs`, `bufferDir` fields
    - Update `DEFAULT_COLLECTOR_CONFIG` with defaults from the design
    - _Requirements: 18.1, 18.2_

  - [x] 11.2 Wire BufferStore, BufferWatcher, ExtractionWorker into `startCollector()`
    - When `bufferEnabled` is true: instantiate `BufferStore`, `BufferWatcher`, `ExtractionWorker`
    - Wire `BufferWatcher.onExtraction` to call `ExtractionWorker.extract`
    - Pass buffer deps to `createPipeline`
    - On startup: scan existing buffers via `BufferStore.listProjects()`, re-arm triggers for non-empty buffers
    - On shutdown: drain `ExtractionWorker` (with timeout), close `BufferWatcher`, then close storage
    - When `bufferEnabled` is false: skip buffer instantiation, pipeline uses existing per-event extraction
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 15.1, 15.2, 15.3_

  - [x] 11.3 Write unit tests for collector buffer wiring
    - Test that `startCollector` with `bufferEnabled: true` creates buffer components
    - Test that `startCollector` with `bufferEnabled: false` uses per-event extraction
    - Test shutdown sequence: drain extraction → close watcher → close storage
    - Test startup scan re-arms triggers for existing buffers
    - Test file: `test/unit/buffer-collector-wiring.test.ts`
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

- [ ] 12. Add fast-check generators for BufferEntry to test helpers
  - [x] 12.1 Add `bufferEntryArb()` generator to `test/helpers/arbitrary.ts`
    - Generate valid `BufferEntry` objects using existing `ulidArb()`, `namespaceArb()`, `kindArb()`, `eventBodyArb()`, `isoDateArb()` generators
    - Surface field: `fc.constantFrom('kiro-cli', 'kiro-ide')`
    - Export for use by all buffer property tests
    - _Requirements: 2.1, 2.2_

- [x] 13. Add modularity boundary guard tests
  - [x] 13.1 Create guard test: buffer module must not import from `storage/sqlite/`
    - Same pattern as `test/unit/no-sqlite-in-pipeline.test.ts`
    - Scan all `.ts` files under `src/collector/buffer/`, strip comments, assert no `storage/sqlite` import
    - Test file: `test/unit/no-sqlite-in-buffer.test.ts`
    - _Requirements: 17.1_

  - [x] 13.2 Create guard test: buffer module must not contain `<private>` string
    - Same pattern as `test/unit/no-private-scrub.test.ts`
    - Scan all `.ts` files under `src/collector/buffer/`, strip comments, assert no `<private>` in executable code
    - Test file: `test/unit/no-private-in-buffer.test.ts`
    - _Requirements: 17.2_

  - [x] 13.3 Create guard test: shim must not import from `src/collector/buffer/`
    - Extend or create a guard test that scans `src/shim/` for imports referencing `collector/buffer`
    - Test file: `test/unit/no-buffer-in-shim.test.ts`
    - _Requirements: 17.3_

- [x] 14. Add end-to-end integration test for buffer extraction flow
  - [x] 14.1 Create `test/integ/buffer-extraction-pipeline.test.ts`
    - Start a real collector daemon with `bufferEnabled: true` and a short idle timer (e.g., 500 ms)
    - POST several events to `POST /v1/events` via HTTP
    - Wait for the idle timer to fire extraction (poll `GET /v1/memories` or use a short sleep)
    - Verify memory records appear in SQLite storage with correct `namespace` and `source_event_ids` referencing the posted events
    - Verify the buffer file is cleared after successful extraction
    - Gate on `kiro-cli` availability — skip gracefully when absent (same pattern as `test/integ/extraction-pipeline.test.ts`)
    - Requires Bedrock credentials for the ACP extraction call
    - Test file: `test/integ/buffer-extraction-pipeline.test.ts`
    - _Requirements: 10.1, 10.4, 10.5, 10.6, 12.1, 13.1, 13.2, 16.1_

- [x] 15. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (Properties 1–10)
- Unit tests validate specific examples and edge cases
- Guard tests enforce modularity boundaries and are non-optional (tasks 13.1–13.3)
- All imports must use `.js` extensions (ESM resolution)
- Use `import type { ... }` for type-only imports (`verbatimModuleSyntax`)
- The buffer module receives `StorageBackend` via DI — never import from `storage/sqlite/`
- Buffer entries must never contain `<private>` — privacy scrubbing happens in the pipeline before buffer append
- **CRITICAL: Unit and property tests must NEVER spawn real `kiro-cli` processes.** Any test that touches ACP/extraction must mock `createAcpSession` to return a fake session. Only integration tests (task 14, `test/integ/`) may use real `kiro-cli`, and they gate on its availability.
