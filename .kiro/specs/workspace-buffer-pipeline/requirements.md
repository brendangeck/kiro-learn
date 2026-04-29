# Requirements Document

## Introduction

The workspace buffer pipeline replaces the current per-event extraction model with project-scoped append-only NDJSON buffers inside the collector. Instead of firing an async LLM extraction for every event, the pipeline appends each scrubbed event to an internal per-project buffer file. Extraction into memory records fires on two triggers: an idle timer (no buffer activity for a configurable period) or a size threshold (buffer crosses a byte limit). This is a transparent optimization of the extraction path — shims, HTTP API, retrieval, and storage remain unchanged.

## Glossary

- **BufferStore**: The component responsible for managing per-project append-only NDJSON buffer files on disk.
- **BufferWatcher**: The component that monitors buffer activity per project, manages idle timers, size thresholds, the circuit breaker, and the hard size ceiling.
- **ExtractionWorker**: The component that reads a buffer snapshot, sends a batch of events to the LLM via ACP for extraction, and stores the resulting memory records.
- **BufferEntry**: A lightweight internal projection of a scrubbed KiroMemEvent, containing only the fields needed for buffering and extraction.
- **Pipeline**: The composed chain of processors an event traverses between the receiver and storage (dedup → privacy scrub → store → buffer append).
- **NDJSON**: Newline-delimited JSON — each line in the buffer file is a self-contained JSON object.
- **Circuit_Breaker**: A safeguard mechanism that disables extraction for a project after a configurable number of consecutive extraction failures.
- **Hard_Size_Ceiling**: A safeguard that refuses buffer appends when a project buffer exceeds a configurable byte limit.
- **ACP**: Agent Client Protocol — the SDK used to communicate with kiro-cli for LLM extraction sessions.
- **Collector**: The long-running local daemon that hosts the pipeline, buffer, and extraction components.

## Requirements

### Requirement 1: BufferStore File Management

**User Story:** As a collector daemon, I want to manage per-project append-only NDJSON buffer files, so that scrubbed events are accumulated for batch extraction.

#### Acceptance Criteria

1. WHEN a scrubbed event is appended to a project buffer, THE BufferStore SHALL write a single NDJSON line containing the serialized BufferEntry to the buffer file at `~/.kiro-learn/buffers/<project_id>/buffer.ndjson`
2. WHEN the buffer directory for a project does not exist, THE BufferStore SHALL create the directory before the first append
3. WHEN `append` is called, THE BufferStore SHALL acquire a POSIX shared file lock before writing to prevent corruption from concurrent access
4. WHEN `append` completes successfully, THE BufferStore SHALL return the number of bytes written
5. WHEN `snapshot` is called for a project, THE BufferStore SHALL return all valid BufferEntry objects from the buffer file as an array
6. WHEN `clear` is called for a project, THE BufferStore SHALL remove the buffer file from disk
7. WHEN `size` is called for a project with no buffer file, THE BufferStore SHALL return 0
8. WHEN `listProjects` is called, THE BufferStore SHALL return the project IDs of all projects that have buffer files on disk

### Requirement 2: BufferEntry Projection

**User Story:** As a pipeline stage, I want to project a scrubbed KiroMemEvent into a lightweight BufferEntry, so that only the fields needed for extraction are stored in the buffer.

#### Acceptance Criteria

1. WHEN projecting a scrubbed KiroMemEvent into a BufferEntry, THE Pipeline SHALL preserve the `event_id`, `namespace`, `kind`, `body`, `valid_time` (as `timestamp`), and `source.surface` (as `surface`) fields
2. WHEN projecting a scrubbed KiroMemEvent into a BufferEntry, THE Pipeline SHALL omit `schema_version`, `content_hash`, `parent_event_id`, `session_id`, and the full `source` block
3. THE BufferEntry type SHALL be internal to `src/collector/buffer/` and not exported to `src/types/` or the public API

### Requirement 3: NDJSON Format Integrity

**User Story:** As a system operator, I want the buffer files to maintain NDJSON format integrity, so that partial writes do not corrupt the entire buffer.

#### Acceptance Criteria

1. THE BufferStore SHALL write each BufferEntry as a single complete JSON line terminated by a newline character
2. WHEN reading a snapshot, THE BufferStore SHALL parse each line independently and skip lines that fail JSON parsing with a warning logged to stderr
3. THE BufferStore SHALL treat the buffer file as an unordered bag of entries with no ordering guarantees

### Requirement 4: Project ID Extraction

**User Story:** As a pipeline component, I want to extract the project ID from an event namespace, so that events are routed to the correct project buffer.

#### Acceptance Criteria

1. WHEN a namespace matching the pattern `/actor/<actor_id>/project/<project_id>/` is provided, THE Pipeline SHALL extract the `<project_id>` segment as the buffer key
2. WHEN a namespace does not match the expected pattern, THE Pipeline SHALL use the full namespace string as a fallback buffer key

### Requirement 5: BufferWatcher Idle Timer

**User Story:** As a collector daemon, I want extraction to fire after a period of inactivity on a project buffer, so that accumulated events are processed even when event flow stops.

#### Acceptance Criteria

1. WHEN `notifyAppend` is called for a project, THE BufferWatcher SHALL start or reset the idle timer for that project
2. WHEN the idle timer expires (default 5000 ms of no activity), THE BufferWatcher SHALL fire an extraction trigger for that project
3. WHEN a `stop` event flows through the pipeline and no further events arrive, THE BufferWatcher SHALL fire extraction via the idle timer expiring naturally

### Requirement 6: BufferWatcher Size Threshold

**User Story:** As a collector daemon, I want extraction to fire when a project buffer crosses a size threshold, so that large batches of events are processed promptly.

#### Acceptance Criteria

1. WHEN `notifyAppend` is called and the project buffer's accumulated bytes exceed the extraction size threshold (default 256 KiB), THE BufferWatcher SHALL fire an extraction trigger for that project
2. THE BufferWatcher SHALL track accumulated bytes per project by summing the byte counts reported by each `notifyAppend` call

### Requirement 7: BufferWatcher Extraction Deduplication

**User Story:** As a collector daemon, I want to avoid redundant extraction triggers, so that the same buffer is not extracted concurrently.

#### Acceptance Criteria

1. WHILE an extraction is already in-flight for a project, THE BufferWatcher SHALL suppress additional extraction triggers for that project
2. WHEN an in-flight extraction completes, THE BufferWatcher SHALL allow new extraction triggers for that project

### Requirement 8: Circuit Breaker on Repeated Extraction Failure

**User Story:** As a system operator, I want extraction to be automatically disabled for a project after repeated failures, so that a persistently failing buffer does not waste resources on futile extraction attempts.

#### Acceptance Criteria

1. WHEN `notifyExtractionResult` is called with `success: false`, THE BufferWatcher SHALL increment the consecutive failure counter for that project
2. WHEN `notifyExtractionResult` is called with `success: true`, THE BufferWatcher SHALL reset the consecutive failure counter for that project to 0
3. WHEN the consecutive failure counter for a project reaches the configured maximum (default 3), THE BufferWatcher SHALL mark extraction as disabled for that project and log a warning to stderr
4. WHILE extraction is disabled for a project, THE BufferWatcher SHALL not schedule extraction triggers for that project
5. WHILE extraction is disabled for a project, THE BufferStore SHALL continue accepting appends up to the hard size ceiling
6. WHEN the collector daemon restarts, THE BufferWatcher SHALL reset all circuit breaker state to initial values (consecutive failures = 0, extraction enabled)

### Requirement 9: Hard Size Ceiling with Graceful Degradation

**User Story:** As a system operator, I want buffer growth to be bounded, so that a stalled or failing extraction path does not consume unbounded disk space.

#### Acceptance Criteria

1. WHEN `notifyAppend` is called and the project buffer's accumulated bytes exceed the hard size ceiling (default 4 MiB), THE BufferWatcher SHALL return `false` to signal the pipeline to skip the buffer append
2. WHEN the hard size ceiling is hit for a project for the first time, THE BufferWatcher SHALL log a warning to stderr including the project ID and current buffer size
3. WHEN the hard size ceiling is hit for a project on subsequent events, THE BufferWatcher SHALL not log additional warnings for that project
4. WHEN the pipeline receives `false` from `notifyAppend`, THE Pipeline SHALL skip the buffer append but the event SHALL still be stored in SQLite via `putEvent()`
5. WHEN extraction succeeds and clears the buffer, THE BufferWatcher SHALL reset the accumulated byte counter and the size ceiling warning flag, allowing new appends to resume

### Requirement 10: ExtractionWorker Batch Extraction

**User Story:** As a collector daemon, I want to extract memory records from a batch of buffered events in a single LLM call, so that extraction quality improves and cost decreases compared to per-event extraction.

#### Acceptance Criteria

1. WHEN extraction is triggered for a project, THE ExtractionWorker SHALL read the current buffer snapshot from the BufferStore
2. WHEN a buffer snapshot is read, THE ExtractionWorker SHALL frame all entries as a batch XML prompt using the existing XML framing conventions (one `<tool_observation>` block per entry)
3. WHEN the batch prompt is sent to the LLM via ACP, THE ExtractionWorker SHALL parse the XML response into memory records using the existing XML parser
4. WHEN memory records are produced, THE ExtractionWorker SHALL store each record via `StorageBackend.putMemoryRecord()` with the `namespace` derived from the buffer entries
5. WHEN memory records are produced, THE ExtractionWorker SHALL populate `source_event_ids` on each record with the `event_id` values from the batch
6. WHEN extraction succeeds, THE ExtractionWorker SHALL clear the buffer via `BufferStore.clear()`
7. WHEN extraction succeeds, THE ExtractionWorker SHALL call `BufferWatcher.notifyExtractionResult(projectId, true)`
8. WHEN extraction fails after all retries, THE ExtractionWorker SHALL not clear the buffer and SHALL call `BufferWatcher.notifyExtractionResult(projectId, false)`

### Requirement 11: ExtractionWorker Concurrency and Timeout

**User Story:** As a system operator, I want extraction concurrency and timeouts to be bounded, so that the daemon does not exhaust system resources.

#### Acceptance Criteria

1. THE ExtractionWorker SHALL limit concurrent extractions across all projects to the configured maximum (default 2) using a semaphore
2. THE ExtractionWorker SHALL enforce a per-extraction timeout (default 60 000 ms) and treat timeout expiry as a failure
3. THE ExtractionWorker SHALL retry transient failures up to the configured maximum retry count (default 3) within a single extraction attempt
4. WHEN `drain` is called, THE ExtractionWorker SHALL wait for all in-flight extractions to complete or until the specified timeout expires

### Requirement 12: Pipeline Modification

**User Story:** As a collector daemon, I want the pipeline to append scrubbed events to the project buffer after storing them in SQLite, so that events are accumulated for batch extraction.

#### Acceptance Criteria

1. WHEN buffer mode is enabled, THE Pipeline SHALL append the scrubbed event to the project buffer after calling `putEvent()` on the storage backend
2. WHEN buffer mode is enabled, THE Pipeline SHALL call `BufferWatcher.notifyAppend()` with the project ID and appended byte count after each buffer append
3. WHEN `notifyAppend` returns `false`, THE Pipeline SHALL skip the buffer append for that event
4. WHEN buffer mode is enabled, THE Pipeline SHALL not enqueue events for per-event extraction
5. WHEN buffer mode is disabled, THE Pipeline SHALL use the existing per-event extraction path unchanged
6. THE Pipeline SHALL never block the HTTP response to the shim on buffer append or extraction operations

### Requirement 13: Daemon Wiring and Lifecycle

**User Story:** As a system operator, I want the buffer components to be properly wired into the collector daemon lifecycle, so that buffers are initialized on startup and drained on shutdown.

#### Acceptance Criteria

1. WHEN the collector daemon starts with buffer mode enabled, THE Collector SHALL instantiate BufferStore, BufferWatcher, and ExtractionWorker and inject them into the pipeline
2. WHEN the collector daemon starts, THE BufferWatcher SHALL scan existing buffer files via `BufferStore.listProjects()` and re-arm triggers for non-empty buffers
3. WHEN the collector daemon shuts down, THE Collector SHALL drain the ExtractionWorker (with timeout) before closing storage
4. WHEN the collector daemon shuts down, THE BufferWatcher SHALL close all timers and pending triggers

### Requirement 14: Buffer Write Failure Handling

**User Story:** As a system operator, I want buffer write failures to be non-fatal, so that events are still stored in SQLite even when the buffer is unavailable.

#### Acceptance Criteria

1. IF a buffer file write fails (disk full, permissions error, lock failure), THEN THE Pipeline SHALL log a warning to stderr and continue processing
2. IF a buffer file write fails, THEN THE Pipeline SHALL still have stored the event in SQLite via `putEvent()` before the buffer append was attempted
3. IF a partial write produces an incomplete NDJSON line, THEN THE BufferStore snapshot reader SHALL skip the corrupt line and process all other valid entries

### Requirement 15: Daemon Restart Recovery

**User Story:** As a system operator, I want the buffer system to recover gracefully after a daemon restart, so that buffered events are not lost.

#### Acceptance Criteria

1. WHEN the daemon restarts, THE BufferWatcher SHALL discover all existing buffer files on disk and recompute their sizes
2. WHEN the daemon restarts, THE BufferWatcher SHALL re-arm extraction triggers for all non-empty buffers with reset circuit breaker state
3. WHEN the daemon restarts after a crash during extraction, THE BufferStore SHALL still contain the buffer file intact (append-only semantics guarantee no in-place modification)

### Requirement 16: Backward Compatibility

**User Story:** As a shim developer, I want the buffer pipeline to be transparent to all external interfaces, so that no shim, HTTP API, or retrieval path changes are needed.

#### Acceptance Criteria

1. THE Pipeline SHALL not change the `POST /v1/events` request or response format
2. THE Pipeline SHALL not change the `GET /v1/events` response format or data source (events table in SQLite)
3. THE Pipeline SHALL not add any new HTTP endpoints for the buffer system
4. THE Pipeline SHALL not require any changes to shim code (CLI or IDE)
5. THE Pipeline SHALL not change the retrieval path (query → FTS5 → format → inject)

### Requirement 17: Modularity Boundaries

**User Story:** As a developer, I want the buffer module to respect the existing modularity boundaries, so that architectural invariants are maintained.

#### Acceptance Criteria

1. THE buffer module (`src/collector/buffer/`) SHALL not import from `src/collector/storage/sqlite/` and SHALL receive `StorageBackend` via dependency injection
2. THE buffer module SHALL not contain the string `<private>` because privacy scrubbing is the pipeline's responsibility before events reach the buffer
3. THE shim modules (`src/shim/`) SHALL not import from `src/collector/buffer/`

### Requirement 18: Configuration

**User Story:** As a system operator, I want all buffer behavior to be configurable, so that I can tune thresholds for different environments.

#### Acceptance Criteria

1. THE Collector SHALL expose a `bufferEnabled` configuration option (default `true`) that controls whether buffer mode or per-event extraction is used
2. THE Collector SHALL expose configurable values for idle timer period (default 5000 ms), extraction size threshold (default 256 KiB), hard size ceiling (default 4 MiB), maximum consecutive failures (default 3), extraction concurrency (default 2), extraction timeout (default 60 000 ms), and buffer directory (default `~/.kiro-learn/buffers/`)
