# Implementation Plan: Buffer Compaction Worker

## Overview

Add a background compaction worker that summarizes oversized per-project NDJSON buffer files via a cheap/fast model call, atomically replacing buffer contents with fewer, denser entries. Implementation builds incrementally: parseCompactionResponse → deterministicEviction → BufferStore.replace + sizeSync → BufferWatcher extensions → CompactionWorker → collector wiring → agent config → tests.

All code is TypeScript (ESM-only, Node ≥ 22, `.js` import extensions, `import type` for type-only imports). The new compaction module lives at `src/collector/buffer/compaction.ts` and receives dependencies via DI — it must NOT import from `src/collector/storage/sqlite/` and must NOT contain the string `<private>`.

## Tasks

- [x] 1. Implement parseCompactionResponse XML parser
  - [x] 1.1 Create `parseCompactionResponse` in `src/collector/buffer/compaction.ts`
    - Extract text content from `<compacted_entry>...</compacted_entry>` XML blocks using regex
    - Unescape XML entities (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`) in returned strings
    - Skip blocks whose content is empty or whitespace-only after trimming
    - Return an empty array for empty input or input with no `<compacted_entry>` blocks
    - Export the function for use by CompactionWorker and tests
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 1.2 Write property test for parseCompactionResponse round-trip (Property 11)
    - **Property 11: parseCompactionResponse round-trip**
    - For any non-empty string that does not contain `</compacted_entry>`, wrapping it in `<compacted_entry>...</compacted_entry>` and passing to `parseCompactionResponse` returns an array containing that string (after XML entity unescaping). For concatenation of multiple wrapped blocks, the parser returns all in order.
    - Test file: `test/unit/compaction-parse-response.property.test.ts`
    - **Validates: Requirements 10.1, 10.2**

  - [x] 1.3 Write unit tests for parseCompactionResponse
    - Test extraction of multiple `<compacted_entry>` blocks
    - Test XML entity unescaping (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`)
    - Test skipping whitespace-only blocks
    - Test empty input returns empty array
    - Test input with no `<compacted_entry>` blocks returns empty array
    - Test malformed/unclosed tags are handled gracefully
    - Test file: `test/unit/compaction-parse-response.test.ts`
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

- [x] 2. Implement deterministicEviction fallback
  - [x] 2.1 Add `deterministicEviction` function to `src/collector/buffer/compaction.ts`
    - Accept a non-empty readonly array of `BufferEntry` objects
    - Sort entries by timestamp descending (most recent first)
    - Return the first `Math.ceil(entries.length / 2)` entries
    - Do not mutate the input array — return a new array of original entry references
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 2.2 Write property test for deterministic eviction correctness (Property 3)
    - **Property 3: Deterministic eviction correctness**
    - For any non-empty array of BufferEntry objects, `deterministicEviction(entries)` returns exactly `Math.ceil(entries.length / 2)` entries, all from the input with the most recent timestamps. No entries are fabricated or duplicated.
    - Use `bufferEntryArb()` from `test/helpers/arbitrary.ts`
    - Test file: `test/unit/compaction-deterministic-eviction.property.test.ts`
    - **Validates: Requirements 4.2, 4.3**

- [x] 3. Implement BufferStore.sizeSync and BufferStore.replace
  - [x] 3.1 Add `sizeSync(projectId)` method to `BufferStore` in `src/collector/buffer/store.ts`
    - Return the current byte size of the buffer file synchronously via `fs.statSync`
    - Return 0 if the file does not exist (catch `ENOENT`)
    - Update the `BufferStore` interface to include `sizeSync`
    - _Requirements: 7.1, 7.2_

  - [x] 3.2 Add `replace(projectId, newEntries, sinceOffset)` method to `BufferStore` in `src/collector/buffer/store.ts`
    - Open the buffer file and acquire an exclusive POSIX file lock (`flock(LOCK_EX)`)
    - Read catch-up bytes from `sinceOffset` to current file size
    - Parse catch-up bytes into BufferEntry objects line-by-line, skipping corrupt lines with stderr warning
    - Write `newEntries` + catch-up entries to a temp file (`buffer.ndjson.<timestamp>.tmp`) in the same directory
    - Atomically rename temp file to buffer file path via `fs.renameSync`
    - Release exclusive lock and close file descriptor in `finally` block
    - Clean up temp file in `finally` block if it still exists
    - Return `ReplaceResult` with `catchUpEntries` and `newSizeBytes`
    - Update the `BufferStore` interface to include `replace` and `ReplaceResult`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x] 3.3 Write property test for catch-up completeness (Property 1)
    - **Property 1: Catch-up completeness**
    - For any compaction operation where entries are appended between snapshot (S0) and replace, the resulting buffer file contains all catch-up entries in addition to the compacted entries. No entries appended after S0 are lost.
    - Use temp directories for isolation. Append entries, record S0, append more entries, call replace, verify all catch-up entries present.
    - Test file: `test/unit/compaction-catchup-completeness.property.test.ts`
    - **Validates: Requirements 1.1, 6.2, 6.4**

  - [x] 3.4 Write property test for byte offset tracking fidelity (Property 7)
    - **Property 7: Byte offset tracking fidelity**
    - For any sequence of appends followed by a replace, the catch-up window [S0, current_size) contains exactly the bytes appended after S0, with no overlap or gap.
    - Test file: `test/unit/compaction-byte-offset.property.test.ts`
    - **Validates: Requirements 1.1, 6.2**

  - [x] 3.5 Write property test for replace temp file cleanup (Property 9)
    - **Property 9: Replace temp file cleanup**
    - For any `BufferStore.replace()` call, whether successful or failed, no orphaned temp files remain on disk after the operation completes.
    - Test file: `test/unit/compaction-temp-cleanup.property.test.ts`
    - **Validates: Requirements 6.7, 14.2, 14.3**

  - [x] 3.6 Write unit tests for BufferStore.replace and sizeSync
    - Test `sizeSync` returns correct byte count for existing file
    - Test `sizeSync` returns 0 for non-existent file
    - Test `replace` with no catch-up entries (sinceOffset == file size)
    - Test `replace` with catch-up entries appended after snapshot
    - Test `replace` skips corrupt catch-up lines with stderr warning
    - Test `replace` cleans up temp file on rename failure
    - Test `replace` releases lock on error
    - Test file: `test/unit/compaction-buffer-replace.test.ts`
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.7, 7.1, 7.2, 14.1, 14.2, 14.3_

- [x] 4. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Extend BufferWatcher with compaction threshold and handlers
  - [x] 5.1 Add compaction support to `src/collector/buffer/watcher.ts`
    - Add `compactionSizeThreshold` to `BufferWatcherConfig` (default 1 048 576 bytes / 1 MiB)
    - Add `compactionInFlight` and `compactionModelFailures` fields to `ProjectBufferState`
    - Add `onCompaction(handler)` method to register a compaction trigger listener
    - Add `notifyCompactionResult(projectId, success, newSizeBytes?)` method:
      - On success: update `currentBytes` to `newSizeBytes`, mark compaction as no longer in-flight
      - On failure: mark compaction as no longer in-flight
    - Extend `notifyAppend` to check compaction threshold and fire compaction trigger when exceeded
    - Suppress compaction triggers while compaction is already in-flight for a project
    - Fire compaction trigger independently of extraction trigger (separate thresholds, no blocking)
    - Update `close()` to clear compaction-related state
    - _Requirements: 8.1, 8.2, 8.3, 9.1, 9.2, 9.3_

  - [x] 5.2 Write property test for compaction threshold independence (Property 6)
    - **Property 6: Compaction threshold independence**
    - For any buffer that crosses the compaction size threshold, the compaction trigger fires independently of the extraction trigger. Compaction and extraction operate on separate thresholds and do not block each other.
    - Test file: `test/unit/compaction-threshold-independence.property.test.ts`
    - **Validates: Requirements 8.1, 8.2**

  - [x] 5.3 Write property test for watcher byte counter consistency (Property 10)
    - **Property 10: Watcher byte counter consistency after compaction**
    - For any successful compaction, the BufferWatcher updates the project's `currentBytes` to reflect the new buffer size. Subsequent threshold checks use accurate data.
    - Test file: `test/unit/compaction-watcher-bytes.property.test.ts`
    - **Validates: Requirement 9.1**

  - [x] 5.4 Write unit tests for BufferWatcher compaction extensions
    - Test compaction trigger fires when buffer exceeds compaction threshold
    - Test compaction trigger does NOT fire when below compaction threshold
    - Test compaction trigger suppressed while compaction is in-flight
    - Test `notifyCompactionResult(success: true)` updates `currentBytes` and clears in-flight flag
    - Test `notifyCompactionResult(success: false)` clears in-flight flag
    - Test compaction and extraction triggers fire independently
    - Test `close()` clears compaction-related state
    - Test file: `test/unit/compaction-watcher.test.ts`
    - _Requirements: 8.1, 8.2, 8.3, 9.1, 9.2, 9.3_

- [x] 6. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement CompactionWorker
  - [x] 7.1 Implement `CompactionWorker` in `src/collector/buffer/compaction.ts`
    - Implement `compact(projectId)`: read snapshot, record S0 via `sizeSync`, attempt model compaction, fall back to deterministic eviction, call `replace`, report result to watcher
    - Implement reentrance guard: reject concurrent `compact()` calls immediately with an error, release guard in `finally` block
    - Implement model-based compaction: frame entries via `frameBatch`, create ACP session with `kiro-learn-compactor` agent, parse response via `parseCompactionResponse`, construct BufferEntry objects with `compact_` prefix, `session_summary` kind, `text` body, latest timestamp, preserved namespace/surface
    - Implement model retry loop: retry up to `maxModelRetries` times, destroy ACP session in `finally` of each attempt
    - Implement circuit breaker: track per-project consecutive model failures, skip model and use deterministic eviction when counter reaches `maxConsecutiveModelFailures`, reset counter on model success
    - Implement `drain(timeoutMs)`: wait for in-flight compaction to complete or timeout
    - Expose `active` boolean property
    - Accept dependencies via DI: `BufferStore`, `BufferWatcher`, config object
    - Export `createCompactionWorker` factory function, `CompactionWorker`, `CompactionResult`, `CompactionWorkerConfig` types
    - **CRITICAL: Use `createAcpSession` from `../pipeline/acp-client.js` for model calls. Use `frameBatch` from `../pipeline/xml-framer.js` for prompt framing. Use `ulid` from `ulidx` for compact_ event IDs.**
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.4, 5.1, 5.2, 5.3, 5.4, 13.1, 13.2, 13.3, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6_

  - [x] 7.2 Write property test for reentrance guard serialization (Property 4)
    - **Property 4: Reentrance guard serialization**
    - For any sequence of `compact()` calls, at most one compaction is in-flight at any time. Concurrent calls are rejected immediately with an error. The reentrance guard is released even if the compaction fails.
    - Mock BufferStore and ACP session
    - Test file: `test/unit/compaction-reentrance.property.test.ts`
    - **Validates: Requirements 2.1, 2.2**

  - [x] 7.3 Write property test for model failure circuit breaker (Property 5)
    - **Property 5: Model failure circuit breaker**
    - For any sequence of compaction attempts on the same project, after `maxConsecutiveModelFailures` consecutive model failures, subsequent attempts use deterministic eviction. A successful model compaction resets the failure counter to 0.
    - Mock ACP session to control success/failure
    - Test file: `test/unit/compaction-circuit-breaker.property.test.ts`
    - **Validates: Requirements 5.1, 5.2, 5.3**

  - [x] 7.4 Write property test for compacted entry validity (Property 8)
    - **Property 8: Compacted entry validity**
    - For any successful model compaction, every returned BufferEntry has `event_id` prefixed with `compact_`, `kind` of `session_summary`, `body` of type `text`, `timestamp` equal to the latest input timestamp, and `namespace`/`surface` preserved from input entries.
    - Mock ACP session to return valid `<compacted_entry>` blocks
    - Test file: `test/unit/compaction-entry-validity.property.test.ts`
    - **Validates: Requirements 3.4, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6**

  - [x] 7.5 Write unit tests for CompactionWorker
    - Test full compact flow: snapshot → model call → replace → result
    - Test reentrance guard rejects concurrent calls
    - Test reentrance guard released on error
    - Test model retry logic (retry up to maxModelRetries)
    - Test fallback to deterministic eviction on model failure
    - Test circuit breaker trips after maxConsecutiveModelFailures
    - Test circuit breaker resets on model success
    - Test `drain()` waits for in-flight compaction
    - Test `active` property reflects in-flight state
    - Test empty buffer returns early with zero metrics
    - Test `notifyCompactionResult` called with correct success/failure
    - **CRITICAL: Mock `createAcpSession` — unit tests must NEVER spawn real `kiro-cli` processes.**
    - Test file: `test/unit/compaction-worker.test.ts`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.4, 5.1, 5.2, 5.3, 13.1, 13.2, 13.3_

- [x] 8. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Update buffer module barrel export
  - [x] 9.1 Update `src/collector/buffer/index.ts` to re-export compaction types and factory
    - Re-export `CompactionWorker`, `CompactionResult`, `CompactionWorkerConfig` types from `./compaction.js`
    - Re-export `createCompactionWorker` factory function from `./compaction.js`
    - Re-export `parseCompactionResponse`, `deterministicEviction` for testing
    - _Requirements: 17.1_

- [x] 10. Wire compaction into collector daemon
  - [x] 10.1 Extend `CollectorConfig` in `src/collector/index.ts` with compaction configuration
    - Add `compactionEnabled` (default `false`), `compactionSizeThreshold` (default 1 048 576), `compactionModelTimeoutMs` (default 120 000), `compactionMaxModelRetries` (default 2), `compactionMaxConsecutiveModelFailures` (default 3) fields
    - Update `DEFAULT_COLLECTOR_CONFIG` with compaction defaults
    - _Requirements: 11.1, 11.2_

  - [x] 10.2 Wire CompactionWorker into `startCollector()` lifecycle
    - When `compactionEnabled` is true and buffer mode is enabled: instantiate `CompactionWorker` with config
    - Pass `compactionSizeThreshold` to `BufferWatcherConfig`
    - Wire `BufferWatcher.onCompaction` to call `CompactionWorker.compact()` with error logging
    - On startup: re-arm compaction triggers for existing buffers exceeding compaction threshold
    - On shutdown: drain `CompactionWorker` (with timeout) before closing storage
    - Clean up orphaned temp files (`buffer.ndjson.*.tmp`) in buffer directories on startup
    - _Requirements: 12.1, 12.2, 12.3, 16.2, 16.3_

  - [x] 10.3 Write unit tests for collector compaction wiring
    - Test `startCollector` with `compactionEnabled: true` creates CompactionWorker
    - Test `startCollector` with `compactionEnabled: false` (default) does not create CompactionWorker
    - Test shutdown sequence drains CompactionWorker before closing storage
    - Test startup cleans up orphaned temp files
    - Test startup re-arms compaction triggers for oversized buffers
    - Test file: `test/unit/compaction-collector-wiring.test.ts`
    - _Requirements: 12.1, 12.2, 12.3, 16.2, 16.3_

- [x] 11. Create kiro-learn-compactor agent config
  - [x] 11.1 Create hand-authored agent config for the compaction model
    - Create agent config file for `kiro-learn-compactor` (same pattern as `kiro-learn-compressor.json`)
    - Zero tools configured
    - System prompt instructs the model to summarize buffer entries into fewer, denser `<compacted_entry>` blocks
    - Configured for a cheap/fast model
    - Document the expected prompt/response XML format in the config's system prompt
    - _Requirements: 3.1_

- [x] 12. Add fast-check generators for compaction tests
  - [x] 12.1 Add compaction-related generators to `test/helpers/arbitrary.ts`
    - Add `compactedEntryArb()` generator producing BufferEntry objects with `compact_` prefixed event_id, `session_summary` kind, `text` body type
    - Add `compactionResponseArb()` generator producing XML strings with `<compacted_entry>` blocks
    - Export for use by compaction property tests
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6_

- [x] 13. Add modularity boundary guard tests
  - [x] 13.1 Verify existing guard tests cover compaction module
    - Confirm `test/unit/no-sqlite-in-buffer.test.ts` scans `src/collector/buffer/compaction.ts` (it should, since it scans all `.ts` files under `src/collector/buffer/`)
    - Confirm `test/unit/no-private-in-buffer.test.ts` scans `src/collector/buffer/compaction.ts`
    - Confirm `test/unit/no-buffer-in-shim.test.ts` covers `compaction` imports
    - If any guard test does not cover the new file, extend it
    - _Requirements: 17.1, 17.2, 17.3_

- [x] 14. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (Properties 1–11)
- Unit tests validate specific examples and edge cases
- All imports must use `.js` extensions (ESM resolution)
- Use `import type { ... }` for type-only imports (`verbatimModuleSyntax`)
- The compaction module receives dependencies via DI — never import from `storage/sqlite/`
- Compacted entries must never contain `<private>` — privacy scrubbing happens in the pipeline before events reach the buffer
- **CRITICAL: Unit and property tests must NEVER spawn real `kiro-cli` processes.** Any test that touches ACP/extraction must mock `createAcpSession` to return a fake session. Only integration tests may use real `kiro-cli`.
- The `bufferEntryArb()` generator already exists in `test/helpers/arbitrary.ts` — reuse it for compaction property tests
- Existing guard tests under `test/unit/no-sqlite-in-buffer.test.ts` and `test/unit/no-private-in-buffer.test.ts` already scan all files under `src/collector/buffer/`, so the new `compaction.ts` file is automatically covered
