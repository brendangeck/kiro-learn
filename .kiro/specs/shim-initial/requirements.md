# Requirements: Kiro CLI Agent Shim

## Introduction

This document defines the requirements for the kiro-learn shim — the thin per-client adapter that bridges Kiro CLI agent hooks and the collector daemon. The shim reads hook input from stdin, builds a canonical `KiroMemEvent`, POSTs it to the collector, and returns retrieval context to the Kiro runtime via stdout.

The shim builds on the contracts established in [event-schema-and-storage](../event-schema-and-storage/requirements.md) (the canonical `KiroMemEvent` type and `EventIngestResponse`) and [collector-pipeline](../collector-pipeline/requirements.md) (the `POST /v1/events` endpoint the shim targets). Those are consumed here, not redefined.

**In scope:** Stdin parsing, event construction, session management, HTTP transport to the collector, stdout output for context injection, error handling, and the four hook handlers (`spawn`, `prompt`, `observe`, `summarize`).

**Out of scope:** Collector implementation, storage, extraction, installer/CLI dispatch, daemon lifecycle, IDE hook support (v3), local spool/retry (v2+).

## Glossary

- **Shim**: The thin adapter layer invoked by Kiro CLI agent hooks. Reads stdin JSON, builds a canonical event, ships it to the collector, returns context to the agent runtime. Owns no state beyond a session file, makes no processing decisions, exits 0 always.
- **Hook_Input**: The JSON object Kiro passes to hook commands via stdin. Contains `hook_event_name`, `cwd`, and hook-type-specific fields.
- **Session_File**: A temporary file at a deterministic path derived from `cwd` that stores the current session's UUID. Written on `agentSpawn`, read by subsequent hooks, overwritten on the next spawn.
- **Collector_Endpoint**: The local HTTP endpoint (`POST /v1/events`) hosted by the collector daemon at `127.0.0.1` on a configurable port (default `21100`).
- **Context_Injection**: The mechanism by which retrieval context reaches the agent. For `agentSpawn` and `userPromptSubmit` hooks, Kiro captures stdout and adds it to the agent's context window.
- **Event_Builder**: The shared module that constructs a canonical `KiroMemEvent` from parsed hook input, session ID, actor ID, and derived namespace.

## Requirements

### Requirement 1: Stdin Input Parsing

**User Story:** As a shim author, I want to parse Kiro's hook input reliably from stdin, so that the shim handles all hook types without depending on environment variables or command-line arguments for event data.

#### Acceptance Criteria

1. WHEN a hook fires, THE Shim SHALL read the complete JSON payload from stdin.
2. THE Shim SHALL parse the stdin payload as JSON. IF parsing fails, THE Shim SHALL log a warning to stderr and exit with code 0.
3. THE Shim SHALL extract the `hook_event_name` field to determine the hook type.
4. THE Shim SHALL extract the `cwd` field to derive project identity and the session file path.
5. THE Shim SHALL validate that `hook_event_name` is one of the expected values (`agentSpawn`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `stop`). IF the value is unrecognized, THE Shim SHALL log a warning to stderr and exit with code 0.

### Requirement 2: Session Management

**User Story:** As a shim author, I want a stable session ID that persists across all hook invocations within a single Kiro agent session, so that events from the same session are grouped correctly.

#### Acceptance Criteria

1. WHEN the `agentSpawn` hook fires, THE Shim SHALL generate a new UUID (v4) as the session ID.
2. THE Shim SHALL write the session ID to a deterministic file path derived from `cwd`: `/tmp/kiro-learn-session-<hash>` where `<hash>` is the first 16 characters of the hex-encoded MD5 of the resolved `cwd`.
3. WHEN any non-spawn hook fires (`userPromptSubmit`, `postToolUse`, `stop`), THE Shim SHALL read the session ID from the session file at the path derived from `cwd`.
4. IF the session file does not exist or is unreadable when a non-spawn hook fires, THE Shim SHALL generate a fallback UUID, write it to the session file, and use it as the session ID.
5. THE Shim SHALL NOT delete the session file on `stop`. The file is overwritten on the next `agentSpawn`.
6. THE session file path derivation SHALL use the real (resolved) path of `cwd` to ensure consistency regardless of symlinks.

### Requirement 3: Event Construction

**User Story:** As a shim author, I want to build a canonical `KiroMemEvent` from hook input, so that the collector receives a well-formed event regardless of which hook type fired.

#### Acceptance Criteria

1. THE Shim SHALL generate a ULID for `event_id` using a third-party ULID library (not hand-rolled).
2. THE Shim SHALL set `session_id` to the session ID obtained from session management (Requirement 2).
3. THE Shim SHALL set `actor_id` to the value of `os.userInfo().username`.
4. THE Shim SHALL derive `namespace` as `/actor/<actor_id>/project/<project_id>/` where `project_id` is the hex-encoded SHA-256 of the resolved `cwd`.
5. THE Shim SHALL set `schema_version` to `1`.
6. THE Shim SHALL set `valid_time` to the current time in ISO 8601 format (`YYYY-MM-DDTHH:mm:ss.sssZ`).
7. THE Shim SHALL set `source.surface` to `"kiro-cli"`.
8. THE Shim SHALL set `source.version` to the kiro-learn package version (read from `package.json` or a build-time constant).
9. THE Shim SHALL set `source.client_id` to a stable machine identifier (e.g., hostname or a persisted UUID).

### Requirement 4: Hook-Specific Event Mapping

**User Story:** As a shim author, I want each hook type to produce an event with the correct `kind` and `body`, so that the collector can distinguish prompt events (which trigger retrieval) from observation events.

#### Acceptance Criteria

1. WHEN the `agentSpawn` hook fires, THE Shim SHALL produce an event with `kind: "note"` and `body: { type: "text", content: "session started" }`.
2. WHEN the `userPromptSubmit` hook fires, THE Shim SHALL produce an event with `kind: "prompt"` and `body: { type: "text", content: <prompt> }` where `<prompt>` is the `prompt` field from the hook input.
3. WHEN the `postToolUse` hook fires, THE Shim SHALL produce an event with `kind: "tool_use"` and `body: { type: "json", data: { tool_name, tool_input, tool_response } }` preserving the original hook input fields.
4. WHEN the `stop` hook fires, THE Shim SHALL produce an event with `kind: "session_summary"` and `body: { type: "text", content: <assistant_response> }` where `<assistant_response>` is the `assistant_response` field from the hook input.
5. WHEN a hook input field required for body construction is missing or empty (e.g., `prompt` is absent on `userPromptSubmit`), THE Shim SHALL use a sensible default (empty string for text content, empty object for JSON data) rather than failing.

### Requirement 5: HTTP Transport

**User Story:** As a shim author, I want the shim to POST events to the collector reliably, so that captured events reach the pipeline without requiring the shim to manage retries or queues.

#### Acceptance Criteria

1. THE Shim SHALL POST the constructed `KiroMemEvent` as JSON to `http://127.0.0.1:<port>/v1/events` where `<port>` is configurable (default `21100`).
2. WHEN the hook type is `userPromptSubmit`, THE Shim SHALL append `?retrieve=true` to the request URL to request synchronous retrieval context.
3. THE Shim SHALL set the `Content-Type: application/json` header on the request.
4. THE Shim SHALL use `node:http` for the HTTP request. No third-party HTTP client dependencies.
5. THE Shim SHALL enforce a request timeout (default 2 seconds). IF the timeout expires, THE Shim SHALL log a warning to stderr and exit with code 0.
6. IF the collector is unreachable (connection refused, DNS failure, or timeout), THE Shim SHALL log a warning to stderr and exit with code 0. No event is lost silently — the warning is the v1 signal.
7. IF the collector returns a non-2xx status code, THE Shim SHALL log the status code and response body to stderr and exit with code 0.

### Requirement 6: Stdout Output and Context Injection

**User Story:** As a shim author, I want the shim to write retrieval context to stdout when available, so that Kiro injects prior observations into the agent's context window.

#### Acceptance Criteria

1. WHEN the `agentSpawn` hook fires, THE Shim SHALL write the session ID to stdout (for debugging visibility in the agent context).
2. WHEN the `userPromptSubmit` hook fires AND the collector response contains a `retrieval` field with a non-empty `context` string, THE Shim SHALL write the retrieval context to stdout.
3. WHEN the `userPromptSubmit` hook fires AND the collector response contains no `retrieval` field or an empty `context`, THE Shim SHALL write nothing to stdout.
4. WHEN the `postToolUse` or `stop` hooks fire, THE Shim SHALL write nothing to stdout (Kiro does not capture stdout for these hook types).
5. THE Shim SHALL NOT write diagnostic messages, warnings, or errors to stdout. All diagnostic output goes to stderr.

### Requirement 7: Error Handling and Exit Behavior

**User Story:** As a Kiro user, I want the shim to never block or crash my agent session, so that memory capture is invisible when it works and harmless when it fails.

#### Acceptance Criteria

1. THE Shim SHALL exit with code 0 in all cases — success, collector down, parse error, timeout, or any unexpected exception.
2. THE Shim SHALL wrap the entire execution in a top-level try/catch. IF an uncaught exception occurs, THE Shim SHALL log the error to stderr and exit with code 0.
3. THE Shim SHALL NOT throw exceptions that propagate to the Kiro runtime.
4. THE Shim SHALL complete execution within a total budget of 3 seconds (including stdin read, event construction, HTTP transport, and stdout write). IF the budget is exceeded, THE Shim SHALL abort and exit with code 0.
5. WHEN the shim logs warnings or errors to stderr, THE format SHALL include a `[kiro-learn]` prefix for easy identification in Kiro's output.

### Requirement 8: Project Identity Derivation

**User Story:** As a shim author, I want project identity to be derived deterministically from the working directory, so that events from the same project always share a namespace without requiring registration or configuration.

#### Acceptance Criteria

1. THE Shim SHALL derive `project_id` as the hex-encoded SHA-256 hash of the resolved (real) `cwd` path.
2. THE Shim SHALL resolve `cwd` using `fs.realpathSync` (or equivalent) to normalize symlinks before hashing.
3. THE Shim SHALL construct `namespace` as `/actor/<actor_id>/project/<project_id>/` with a trailing slash.
4. Two events from the same `cwd` (after symlink resolution) SHALL always produce the same `namespace`, regardless of which hook type fired.

### Requirement 9: Configuration

**User Story:** As a kiro-learn user, I want the shim to work with zero configuration by default, but allow overrides for non-standard setups.

#### Acceptance Criteria

1. THE Shim SHALL use default values for all configuration: collector port `21100`, collector host `127.0.0.1`, request timeout `2000ms`.
2. THE Shim SHALL read configuration overrides from `~/.kiro-learn/settings.json` if the file exists.
3. IF `~/.kiro-learn/settings.json` does not exist or is unreadable, THE Shim SHALL use defaults without error.
4. THE Shim SHALL support the following configuration keys: `collector.port` (number), `collector.host` (string), `shim.timeoutMs` (number).

### Requirement 10: Body Size Safety

**User Story:** As a shim author, I want to prevent oversized events from being constructed, so that the collector's 2 MiB body limit is never hit due to large tool responses or prompts.

#### Acceptance Criteria

1. THE Shim SHALL enforce a maximum body content size of 512 KiB (524,288 bytes) for the serialized event body.
2. WHEN the body content exceeds the size limit, THE Shim SHALL truncate the content and append a `[truncated by kiro-learn]` marker.
3. FOR `tool_use` events with JSON bodies, THE Shim SHALL truncate `tool_response.result` first (the largest field), preserving `tool_name` and `tool_input`.
4. FOR `text` body types, THE Shim SHALL truncate the `content` string.

### Requirement 11: Shared Module Structure

**User Story:** As a shim author, I want shared logic (event building, transport, session management) separated from hook-specific logic, so that adding a future IDE hook shim (v3) reuses the same core.

#### Acceptance Criteria

1. THE Shim SHALL separate shared logic into `src/shim/shared/index.ts`: event builder, HTTP transport, session file management, configuration loading, body truncation.
2. THE Shim SHALL implement hook-specific logic in `src/shim/cli-agent/index.ts`: stdin parsing, hook-type dispatch, stdout output formatting.
3. THE shared module SHALL NOT import from `src/shim/cli-agent/`. The dependency direction is cli-agent → shared, never the reverse.
4. THE shared module SHALL NOT import from `src/collector/` or `src/installer/`. The shim is a standalone client of the collector's HTTP API.

## Non-functional Requirements

### Performance

- N1. THE Shim SHALL complete the full cycle (stdin read → event build → HTTP POST → stdout write) in under 200ms on commodity developer hardware when the collector is healthy and responsive.
- N2. THE Shim SHALL abort and exit 0 within 3 seconds in the worst case (collector timeout + cleanup).

### Reliability

- N3. THE Shim SHALL never cause a Kiro agent session to fail, hang, or degrade. All failures are silent (stderr warning + exit 0).
- N4. THE Shim SHALL handle concurrent invocations from the same project gracefully. Two hooks firing near-simultaneously for the same `cwd` SHALL NOT corrupt the session file (last-write-wins is acceptable).

### Observability

- N5. THE Shim SHALL log all warnings and errors to stderr with a `[kiro-learn]` prefix.
- N6. THE Shim SHALL NOT log successful operations to stderr (silent on success).

### Security

- N7. THE Shim SHALL only connect to `127.0.0.1`. No remote collector endpoints in v1.
- N8. THE Shim SHALL NOT log event body content to stderr (may contain sensitive data). Log event IDs and error messages only.

## Out of Scope (explicit)

- Local spool / retry queue for collector-down scenarios (v2+)
- IDE hook shim (`src/shim/ide-hook/`) (v3)
- Encryption of the session file or transport (localhost-only in v1)
- Authentication with the collector (v4 cloud path)
- Configurable hook-to-event-kind mapping (hardcoded in v1)
- `preToolUse` hook handling (not registered in v1)
- Installer/CLI dispatch routing (installer spec)
- Daemon lifecycle management (installer spec)
