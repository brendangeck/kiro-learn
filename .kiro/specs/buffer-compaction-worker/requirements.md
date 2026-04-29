# Requirements Document

## Introduction

The buffer compaction worker adds a background process that summarizes oversized per-project NDJSON buffer files, reducing their size while preserving semantic content. When a buffer crosses a compaction size threshold (default 1 MiB, separate from the 256 KiB extraction threshold), the worker reads a snapshot, sends entries to a cheap/fast model for summarization via ACP, and atomically replaces the buffer contents with fewer, denser summary entries. The key concurrency insight is that no lock is held during the model call — the worker records a byte offset at snapshot time, runs the model without any lock, then acquires an exclusive flock only for the brief catch-up-and-rename step. If model-based compaction fails repeatedly, a deterministic eviction fallback keeps the most recent half of entries. Compaction is serial globally, guarded per project, and off by default for non-local model configurations.

This feature builds on the workspace-buffer-pipeline spec which provides BufferStore, BufferWatcher, ExtractionWorker, and BufferEntry.

## Glossary

- **CompactionWorker**: The background worker that summarizes oversized buffers via a model call and atomically replaces buffer contents with fewer, denser entries.
- **BufferStore**: The existing component managing per-project append-only NDJSON buffer files on disk, extended with `replace()` and `sizeSync()` methods.
- **BufferWatcher**: The existing component monitoring buffer activity per project, extended with compaction threshold tracking, `onCompaction` handler, and `notifyCompactionResult` method.
- **BufferEntry**: The existing lightweight internal projection of a scrubbed KiroMemEvent used for buffering and extraction.
- **Deterministic_Eviction**: A fallback compaction strategy that keeps the most recent half of buffer entries by timestamp without requiring a model call.
- **Compaction_Threshold**: The buffer byte-size threshold (default 1 MiB) above which compaction is triggered, separate from and larger than the extraction threshold.
- **Catch_Up_Window**: The byte range [S0, current_size) representing entries appended to the buffer between the snapshot read and the exclusive lock acquisition during replace.
- **Reentrance_Guard**: A per-worker lock ensuring at most one compaction is in-flight at any time globally.
- **ACP**: Agent Client Protocol — the SDK used to communicate with kiro-cli for model sessions.
- **Collector**: The long-running local daemon that hosts the pipeline, buffer, extraction, and compaction components.
- **CollectorConfig**: The configuration interface for the collector daemon, extended with compaction-related fields.

## Requirements

### Requirement 1: CompactionWorker Lifecycle

**User Story:** As a collector daemon, I want a background compaction worker that summarizes oversized buffers, so that buffer files stay manageable without losing semantic content.

#### Acceptance Criteria

1. WHEN compaction is triggered for a project, THE CompactionWorker SHALL read the current buffer snapshot from the BufferStore and record the byte offset S0 at snapshot time
2. WHEN a buffer snapshot is read, THE CompactionWorker SHALL attempt model-based compaction first, falling back to Deterministic_Eviction only when the model fails or the model failure circuit breaker has tripped
3. WHEN compaction produces compacted entries, THE CompactionWorker SHALL call `BufferStore.replace()` with the compacted entries and the recorded byte offset S0 to atomically replace the buffer contents
4. WHEN compaction succeeds, THE CompactionWorker SHALL call `BufferWatcher.notifyCompactionResult()` with `success: true` and the new buffer size in bytes
5. WHEN compaction fails, THE CompactionWorker SHALL call `BufferWatcher.notifyCompactionResult()` with `success: false`
6. WHEN `drain` is called, THE CompactionWorker SHALL wait for any in-flight compaction to complete or until the specified timeout expires

### Requirement 2: Reentrance Guard and Serial Execution

**User Story:** As a system operator, I want compaction to run serially with at most one compaction in-flight at any time, so that the daemon does not exhaust system resources on background summarization.

#### Acceptance Criteria

1. WHILE a compaction is in-flight for any project, THE CompactionWorker SHALL reject additional `compact()` calls immediately with an error
2. WHEN a compaction completes (whether successfully or with an error), THE CompactionWorker SHALL release the Reentrance_Guard so that subsequent compaction calls can proceed
3. THE CompactionWorker SHALL expose an `active` property that returns `true` when a compaction is in-flight and `false` otherwise

### Requirement 3: Model-Based Compaction

**User Story:** As a collector daemon, I want buffer entries to be summarized by a cheap/fast model via ACP, so that compacted buffers preserve semantic content in fewer, denser entries.

#### Acceptance Criteria

1. WHEN model-based compaction is attempted, THE CompactionWorker SHALL frame the buffer entries as XML using the existing `frameBatch` function and send them to the `kiro-learn-compactor` ACP agent
2. WHEN the model returns a response, THE CompactionWorker SHALL parse `<compacted_entry>` blocks from the response text using `parseCompactionResponse`
3. WHEN the model returns zero compacted entries, THE CompactionWorker SHALL treat the attempt as a failure and retry or fall back
4. WHEN model-based compaction succeeds, THE CompactionWorker SHALL construct BufferEntry objects from the parsed summaries with `event_id` prefixed with `compact_`, `kind` set to `session_summary`, `body` of type `text`, `timestamp` set to the latest timestamp from the input entries, and `namespace` and `surface` preserved from the input entries
5. THE CompactionWorker SHALL enforce a per-compaction model call timeout (default 120 000 ms) and treat timeout expiry as a failure
6. THE CompactionWorker SHALL retry model failures up to the configured maximum retry count (default 2) within a single compaction attempt

### Requirement 4: Deterministic Eviction Fallback

**User Story:** As a system operator, I want a deterministic fallback when model-based compaction fails, so that oversized buffers are still reduced without depending on model availability.

#### Acceptance Criteria

1. WHEN model-based compaction fails after all retries within a single compaction attempt, THE CompactionWorker SHALL fall back to Deterministic_Eviction for that attempt
2. WHEN Deterministic_Eviction is applied, THE CompactionWorker SHALL keep exactly `Math.ceil(entries.length / 2)` entries — the entries with the most recent timestamps
3. WHEN Deterministic_Eviction is applied, THE CompactionWorker SHALL not fabricate or duplicate any entries — all returned entries are unmodified originals from the input
4. WHEN Deterministic_Eviction is applied, THE CompactionWorker SHALL set `CompactionResult.usedFallback` to `true`

### Requirement 5: Model Failure Circuit Breaker

**User Story:** As a system operator, I want model-based compaction to be automatically bypassed for a project after repeated model failures, so that a persistently failing model does not waste resources on futile compaction attempts.

#### Acceptance Criteria

1. WHEN model-based compaction fails for a project, THE CompactionWorker SHALL increment the per-project consecutive model failure counter
2. WHEN model-based compaction succeeds for a project, THE CompactionWorker SHALL reset the per-project consecutive model failure counter to 0
3. WHEN the per-project consecutive model failure counter reaches the configured maximum (default 3), THE CompactionWorker SHALL use Deterministic_Eviction directly for subsequent compaction attempts on that project without calling the model
4. WHEN the collector daemon restarts, THE CompactionWorker SHALL reset all per-project model failure counters to 0

### Requirement 6: BufferStore Atomic Replace

**User Story:** As a compaction worker, I want to atomically replace buffer contents with catch-up replay, so that no entries appended during the model call are lost.

#### Acceptance Criteria

1. WHEN `replace` is called, THE BufferStore SHALL acquire an exclusive POSIX file lock on the buffer file before reading catch-up bytes or writing the replacement
2. WHEN `replace` is called with a `sinceOffset`, THE BufferStore SHALL read all bytes appended to the buffer file after `sinceOffset` (the Catch_Up_Window) and parse them into BufferEntry objects
3. WHEN catch-up bytes contain corrupt NDJSON lines, THE BufferStore SHALL skip the corrupt lines with a warning logged to stderr and preserve all valid catch-up entries
4. WHEN `replace` is called, THE BufferStore SHALL write the new entries followed by the catch-up entries to a temporary file in the same directory as the buffer file
5. WHEN the temporary file is written, THE BufferStore SHALL atomically rename it to the buffer file path using POSIX `rename()`
6. WHEN `replace` completes (whether successfully or with an error), THE BufferStore SHALL release the exclusive file lock
7. WHEN `replace` completes (whether successfully or with an error), THE BufferStore SHALL clean up the temporary file if it still exists on disk

### Requirement 7: BufferStore Synchronous Size Read

**User Story:** As a compaction worker, I want to read the buffer file size synchronously at snapshot time, so that the byte offset S0 is recorded atomically with the snapshot read.

#### Acceptance Criteria

1. THE BufferStore SHALL expose a `sizeSync` method that returns the current byte size of the buffer file synchronously
2. WHEN the buffer file does not exist, THE `sizeSync` method SHALL return 0

### Requirement 8: BufferWatcher Compaction Threshold

**User Story:** As a collector daemon, I want compaction to fire when a buffer crosses a compaction size threshold, so that oversized buffers are summarized before reaching the hard size ceiling.

#### Acceptance Criteria

1. WHEN `notifyAppend` is called and the project buffer's accumulated bytes exceed the Compaction_Threshold (default 1 MiB), THE BufferWatcher SHALL fire a compaction trigger for that project
2. THE BufferWatcher SHALL fire the compaction trigger independently of the extraction trigger — compaction and extraction operate on separate thresholds and do not block each other
3. WHILE a compaction is already in-flight for a project, THE BufferWatcher SHALL suppress additional compaction triggers for that project

### Requirement 9: BufferWatcher Compaction Result Handling

**User Story:** As a collector daemon, I want the watcher to update its state after compaction completes, so that subsequent threshold checks use accurate byte counts.

#### Acceptance Criteria

1. WHEN `notifyCompactionResult` is called with `success: true` and a `newSizeBytes` value, THE BufferWatcher SHALL update the project's `currentBytes` to the provided `newSizeBytes`
2. WHEN `notifyCompactionResult` is called with `success: true`, THE BufferWatcher SHALL mark compaction as no longer in-flight for that project
3. WHEN `notifyCompactionResult` is called with `success: false`, THE BufferWatcher SHALL mark compaction as no longer in-flight for that project

### Requirement 10: parseCompactionResponse XML Parser

**User Story:** As a compaction worker, I want to parse `<compacted_entry>` blocks from the model response, so that summarized content is extracted into individual entries.

#### Acceptance Criteria

1. WHEN a response text contains `<compacted_entry>` blocks, THE `parseCompactionResponse` function SHALL extract the text content of each block as a separate string
2. WHEN a `<compacted_entry>` block contains XML entities, THE `parseCompactionResponse` function SHALL unescape them in the returned string
3. WHEN a `<compacted_entry>` block contains only whitespace after trimming, THE `parseCompactionResponse` function SHALL skip that block
4. WHEN the response text is empty or contains no `<compacted_entry>` blocks, THE `parseCompactionResponse` function SHALL return an empty array

### Requirement 11: CollectorConfig Compaction Extensions

**User Story:** As a system operator, I want all compaction behavior to be configurable, so that I can tune thresholds and enable or disable compaction for different environments.

#### Acceptance Criteria

1. THE CollectorConfig SHALL expose a `compactionEnabled` configuration option (default `false`) that controls whether buffer compaction is active
2. THE CollectorConfig SHALL expose configurable values for Compaction_Threshold (default 1 048 576 bytes), model call timeout (default 120 000 ms), maximum model retries per attempt (default 2), and maximum consecutive model failures before fallback (default 3)

### Requirement 12: Daemon Wiring and Lifecycle

**User Story:** As a system operator, I want the compaction worker to be properly wired into the collector daemon lifecycle, so that compaction is initialized on startup and drained on shutdown.

#### Acceptance Criteria

1. WHEN the collector daemon starts with compaction enabled, THE Collector SHALL instantiate the CompactionWorker and wire the BufferWatcher's `onCompaction` handler to invoke `CompactionWorker.compact()`
2. WHEN the collector daemon shuts down, THE Collector SHALL drain the CompactionWorker (with timeout) before closing storage
3. WHEN the collector daemon shuts down, THE BufferWatcher SHALL close all compaction-related timers and pending triggers alongside existing extraction timers

### Requirement 13: Error Handling — Model Call Failure

**User Story:** As a system operator, I want model call failures during compaction to be handled gracefully, so that the buffer is still compacted via the deterministic fallback.

#### Acceptance Criteria

1. IF the ACP session for the compaction model fails (timeout, garbage response, connection error), THEN THE CompactionWorker SHALL retry up to the configured maximum retry count before falling back to Deterministic_Eviction
2. IF model-based compaction fails and Deterministic_Eviction is used, THEN THE CompactionWorker SHALL increment the per-project model failure counter
3. IF model-based compaction fails, THEN THE CompactionWorker SHALL log a warning to stderr including the project ID and error details

### Requirement 14: Error Handling — Replace Failures

**User Story:** As a system operator, I want replace failures during compaction to leave the buffer unchanged, so that no data is lost if the atomic swap fails.

#### Acceptance Criteria

1. IF the exclusive lock acquisition fails during `replace`, THEN THE BufferStore SHALL throw an error and leave the original buffer file unchanged
2. IF writing the temporary file fails (disk full, permissions), THEN THE BufferStore SHALL release the exclusive lock, clean up the temporary file, and throw an error
3. IF the atomic rename fails, THEN THE BufferStore SHALL release the exclusive lock, attempt to clean up the temporary file, and throw an error

### Requirement 15: Error Handling — Compaction During Extraction

**User Story:** As a system operator, I want compaction and extraction to proceed independently without coordination, so that neither blocks the other.

#### Acceptance Criteria

1. WHEN extraction is triggered while compaction is in-flight, THE ExtractionWorker SHALL proceed independently using whatever buffer state is current at the time of its snapshot read
2. WHEN compaction completes while extraction is in-flight, THE ExtractionWorker SHALL continue using its already-read snapshot without interruption

### Requirement 16: Error Handling — Daemon Restart During Compaction

**User Story:** As a system operator, I want the buffer to remain intact if the daemon dies during compaction, so that no data is lost on restart.

#### Acceptance Criteria

1. WHEN the daemon dies while the compaction model call is in-flight, THE BufferStore SHALL still contain the original buffer file intact because no lock is held during the model call
2. WHEN the daemon restarts after a crash during compaction, THE BufferWatcher SHALL re-scan existing buffer files and re-arm compaction triggers for buffers exceeding the Compaction_Threshold
3. WHEN the daemon restarts, THE Collector SHALL clean up orphaned temporary files (matching `buffer.ndjson.*.tmp`) in buffer directories

### Requirement 17: Modularity Boundaries

**User Story:** As a developer, I want the compaction module to respect the existing modularity boundaries, so that architectural invariants are maintained.

#### Acceptance Criteria

1. THE compaction module (`src/collector/buffer/compaction.ts`) SHALL not import from `src/collector/storage/sqlite/` and SHALL receive dependencies via injection
2. THE compaction module SHALL not contain the string `<private>` because privacy scrubbing is the pipeline's responsibility before events reach the buffer
3. THE shim modules (`src/shim/`) SHALL not import from `src/collector/buffer/`

### Requirement 18: Compacted Entry Validity

**User Story:** As an extraction worker, I want compacted entries to be valid BufferEntry objects, so that they flow through the existing extraction pipeline unchanged.

#### Acceptance Criteria

1. THE CompactionWorker SHALL produce compacted entries that conform to the existing BufferEntry interface
2. WHEN constructing compacted entries, THE CompactionWorker SHALL set `event_id` to a string prefixed with `compact_` followed by a new ULID
3. WHEN constructing compacted entries, THE CompactionWorker SHALL preserve the `namespace` from the original input entries
4. WHEN constructing compacted entries, THE CompactionWorker SHALL set `kind` to `session_summary`
5. WHEN constructing compacted entries, THE CompactionWorker SHALL set `body` to type `text` with the summarized content
6. WHEN constructing compacted entries, THE CompactionWorker SHALL set `timestamp` to the latest timestamp from the input entries
