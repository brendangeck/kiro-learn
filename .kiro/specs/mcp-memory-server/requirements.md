# Requirements: MCP Memory Server

## Introduction

This document defines the requirements for the MCP (Model Context Protocol) memory server — a stdio-based JSON-RPC process that exposes kiro-learn's memory capabilities as MCP tools. The server translates MCP tool calls into HTTP requests against the already-running collector daemon at `127.0.0.1:21100`, enabling two key capabilities: pull-based memory retrieval (agents actively search memory) and agent-driven memory writes (agents store session summaries and observations directly).

The MCP server is architecturally analogous to the shim modules: a pure HTTP client of the collector. It does NOT import from `src/collector/`, `src/shim/`, or `src/installer/`. It may import from `src/types/` for type definitions only. The `@modelcontextprotocol/sdk` TypeScript SDK is used for protocol correctness.

## Glossary

- **MCP_Server**: The stdio JSON-RPC process at `src/mcp/` that implements the Model Context Protocol and exposes kiro-learn memory tools to agents.
- **Collector**: The existing HTTP daemon at `127.0.0.1:21100` that owns the SQLite database and exposes REST endpoints for event ingestion, memory storage, and search.
- **MCP_Tool**: A named capability exposed by the MCP_Server that agents can invoke via JSON-RPC tool calls.
- **Tool_Result**: The JSON-RPC response payload returned to the agent after an MCP_Tool call completes.
- **Collector_Client**: The HTTP client module within `src/mcp/` that translates MCP tool parameters into HTTP requests against the Collector's REST API.
- **MCP_Config**: The `.kiro/settings/mcp.json` file written by the Installer during `cmdInit` to register the MCP_Server with Kiro IDE.
- **Bin_Wrapper**: The executable script at `~/.kiro-learn/bin/mcp-server` that launches the MCP_Server process.
- **Observation_Type**: One of `tool_use`, `decision`, `error`, `discovery`, `pattern` — the classification for a memory record, as defined in `src/types/schemas.ts`.
- **Session_Summary**: A structured memory record with `observation_type` of `session_summary` that captures what a user asked, what was investigated, learned, completed, and next steps.
- **Namespace**: The `/actor/<actor_id>/project/<project_id>/` path that scopes all memory operations to a specific user and project.

## Requirements

### Requirement 1: MCP Server Process Lifecycle

**User Story:** As a Kiro IDE user, I want the MCP server to start quickly and run reliably as a stdio process, so that memory tools are available throughout my agent session without noticeable delay.

#### Acceptance Criteria

1.1 WHEN the MCP_Server process is spawned, THE MCP_Server SHALL complete initialization and be ready to accept JSON-RPC requests within 2 seconds.

1.2 WHEN the MCP_Server process is spawned, THE MCP_Server SHALL communicate via JSON-RPC over stdin/stdout using the MCP stdio transport.

1.3 WHEN the MCP_Server receives a valid MCP `initialize` request, THE MCP_Server SHALL respond with its server info and the list of supported tools.

1.4 WHEN the MCP_Server's stdin stream closes, THE MCP_Server SHALL shut down gracefully and exit with code 0.

1.5 WHEN an unhandled error occurs during MCP_Server initialization, THE MCP_Server SHALL log the error to stderr and exit with a non-zero exit code.

1.6 THE MCP_Server SHALL NOT write any output to stdout other than valid JSON-RPC messages.

### Requirement 2: Tool Registration

**User Story:** As an agent developer, I want the MCP server to advertise its tools with clear schemas, so that agents can discover and invoke memory operations correctly.

#### Acceptance Criteria

2.1 WHEN the MCP_Server responds to a `tools/list` request, THE MCP_Server SHALL include a tool named `search_memory` with input schema specifying `query` (string, required) and `limit` (number, optional, default 10).

2.2 WHEN the MCP_Server responds to a `tools/list` request, THE MCP_Server SHALL include a tool named `save_observation` with input schema specifying `title` (string, required), `summary` (string, required), `observation_type` (enum of Observation_Type values, required), `concepts` (array of strings, required), `files_touched` (array of strings, required), and `facts` (array of strings, required).

2.3 WHEN the MCP_Server responds to a `tools/list` request, THE MCP_Server SHALL include a tool named `save_session_summary` with input schema specifying `request` (string, required), `investigated` (string, required), `learned` (string, required), `completed` (string, required), `next_steps` (string, required), `files_read` (array of strings, required), and `files_modified` (array of strings, required).

2.4 WHEN the MCP_Server responds to a `tools/list` request, THE MCP_Server SHALL include exactly three tools.

### Requirement 3: search_memory Tool

**User Story:** As an agent, I want to search memory records by natural language query, so that I can retrieve relevant prior context about the current project.

#### Acceptance Criteria

3.1 WHEN the `search_memory` tool is called with a valid `query` string, THE Collector_Client SHALL send a `GET /v1/memories/search` request to the Collector with the query and limit as query parameters.

3.2 WHEN the Collector returns matching memory records, THE MCP_Server SHALL format the results as a human-readable text string containing each record's title, summary, concepts, and files_touched.

3.3 WHEN the Collector returns zero matching records, THE MCP_Server SHALL return a Tool_Result with text content indicating no matching memories were found.

3.4 WHEN the `limit` parameter is omitted, THE MCP_Server SHALL default to 10.

3.5 WHEN the `limit` parameter is provided, THE Collector_Client SHALL pass the value to the Collector's search endpoint.

3.6 WHEN the `query` parameter is an empty string, THE MCP_Server SHALL return an error Tool_Result indicating that the query must be non-empty.

### Requirement 4: save_observation Tool

**User Story:** As an agent (IDE agent or CLI compressor), I want to store a structured observation as a memory record, so that the knowledge is available in future sessions.

#### Acceptance Criteria

4.1 WHEN the `save_observation` tool is called with valid parameters, THE Collector_Client SHALL send a `POST /v1/memories` request to the Collector with a JSON body containing the memory record fields.

4.2 WHEN the Collector successfully stores the memory record, THE MCP_Server SHALL return a Tool_Result with text content confirming storage and including the `record_id`.

4.3 WHEN the `observation_type` parameter is not one of the valid Observation_Type values, THE MCP_Server SHALL return an error Tool_Result indicating the invalid observation type.

4.4 WHEN the `title` parameter exceeds 200 characters, THE MCP_Server SHALL return an error Tool_Result indicating the title length constraint.

4.5 WHEN the `summary` parameter exceeds 4000 characters, THE MCP_Server SHALL return an error Tool_Result indicating the summary length constraint.

### Requirement 5: save_session_summary Tool

**User Story:** As a Kiro IDE agent prompted on agentStop, I want to store a structured session summary, so that future sessions have context about what was accomplished.

#### Acceptance Criteria

5.1 WHEN the `save_session_summary` tool is called with valid parameters, THE Collector_Client SHALL send a `POST /v1/memories` request to the Collector with a JSON body containing the session summary fields and `observation_type` set to `session_summary`.

5.2 WHEN the Collector successfully stores the session summary, THE MCP_Server SHALL return a Tool_Result with text content confirming storage and including the `record_id`.

5.3 WHEN the `save_session_summary` tool is called, THE Collector_Client SHALL construct the memory record `title` from the `request` parameter (truncated to 200 characters) and the `summary` from a formatted concatenation of the `investigated`, `learned`, `completed`, and `next_steps` fields.

5.4 WHEN the formatted summary exceeds 4000 characters, THE Collector_Client SHALL truncate the summary to fit within the 4000-character limit.

### Requirement 6: Collector HTTP Client

**User Story:** As a maintainer, I want the MCP server's HTTP client to be a self-contained module that communicates with the collector via REST, so that the modularity boundary is preserved.

#### Acceptance Criteria

6.1 THE Collector_Client SHALL use `node:http` to communicate with the Collector at `127.0.0.1:21100`.

6.2 THE Collector_Client SHALL read the collector host and port from `~/.kiro-learn/settings.json` when available, falling back to `127.0.0.1:21100` when the file is missing or unreadable.

6.3 WHEN the Collector_Client sends an HTTP request, THE Collector_Client SHALL set a timeout of 5 seconds per request.

6.4 WHEN the Collector returns a non-2xx HTTP status, THE Collector_Client SHALL propagate the error as a failed Tool_Result with the HTTP status code and response body.

6.5 THE Collector_Client module SHALL NOT import from `src/collector/`, `src/shim/`, or `src/installer/`.

6.6 THE Collector_Client module SHALL import only from `src/types/` for type definitions and from `node:` built-in modules.

### Requirement 7: Error Handling and Resilience

**User Story:** As a Kiro IDE user, I want the MCP server to handle errors gracefully, so that a single tool failure does not crash the server or block my agent session.

#### Acceptance Criteria

7.1 WHEN the Collector is unreachable (connection refused), THE MCP_Server SHALL return an error Tool_Result with a message indicating the collector is not running, rather than crashing.

7.2 WHEN the Collector request times out, THE MCP_Server SHALL return an error Tool_Result with a message indicating the request timed out.

7.3 WHEN a tool call receives invalid or malformed parameters, THE MCP_Server SHALL return an error Tool_Result with a descriptive validation message.

7.4 WHEN any tool call fails, THE MCP_Server SHALL continue running and remain ready to handle subsequent tool calls.

7.5 WHEN the Collector returns an unexpected response format, THE MCP_Server SHALL return an error Tool_Result rather than throwing an unhandled exception.

### Requirement 8: Collector Endpoint Extensions

**User Story:** As a collector maintainer, I want the new endpoints to follow the existing REST conventions, so that the API surface remains consistent.

#### Acceptance Criteria

8.1 WHEN the Collector receives a `POST /v1/memories` request with a valid memory record JSON body, THE Collector SHALL validate the record using `parseMemoryRecord`, store it via `putMemoryRecord`, and return a 200 response with `{ record_id, stored: true }`.

8.2 WHEN the Collector receives a `POST /v1/memories` request with an invalid body, THE Collector SHALL return a 400 response with validation error details.

8.3 WHEN the Collector receives a `GET /v1/memories/search` request with `query` and `limit` parameters, THE Collector SHALL perform a `searchMemoryRecords` call scoped to the provided `namespace` and return the matching records as a JSON array.

8.4 WHEN the Collector receives a `GET /v1/memories/search` request without a `query` parameter, THE Collector SHALL return a 400 response indicating the query parameter is required.

8.5 WHEN the Collector receives a `POST /v1/memories` request, THE Collector SHALL enforce the same request body size limit (2 MiB) as the existing `POST /v1/events` endpoint.

### Requirement 9: Installer Integration

**User Story:** As a Kiro IDE user, I want the MCP server to be automatically registered during `kiro-learn init`, so that memory tools are available without manual configuration.

#### Acceptance Criteria

9.1 WHEN `cmdInit` runs with a detected project scope, THE Installer SHALL write a `.kiro/settings/mcp.json` file in the project root that registers the MCP_Server.

9.2 WHEN the Installer writes MCP_Config, THE MCP_Config SHALL contain an `mcpServers` object with a `kiro-learn-memory` entry specifying `command` as the path to the Bin_Wrapper and `args` as an empty array.

9.3 WHEN the Installer runs `writeBinWrappers`, THE Installer SHALL create a `~/.kiro-learn/bin/mcp-server` executable that launches the MCP_Server via `node` with the compiled entry point.

9.4 WHEN the Installer writes the Bin_Wrapper, THE Bin_Wrapper SHALL be chmod 0o755.

9.5 WHEN `cmdUninstall` runs, THE Installer SHALL remove the `.kiro/settings/mcp.json` file from the project root when project scope is detected.

9.6 WHEN `cmdUninstall` runs, THE Installer SHALL remove the `~/.kiro-learn/bin/mcp-server` Bin_Wrapper.

### Requirement 10: Modularity Boundary

**User Story:** As a maintainer, I want the MCP server module to respect the same modularity boundaries as the shim, so that the architecture remains clean and testable.

#### Acceptance Criteria

10.1 THE `src/mcp/` module SHALL NOT contain any import from `src/collector/`.

10.2 THE `src/mcp/` module SHALL NOT contain any import from `src/shim/`.

10.3 THE `src/mcp/` module SHALL NOT contain any import from `src/installer/`.

10.4 THE `src/mcp/` module SHALL import from `src/types/` using `import type` for type-only imports.

10.5 WHEN a new guard test is added for the MCP modularity boundary, THE test SHALL verify that no file under `src/mcp/` imports from `src/collector/`, `src/shim/`, or `src/installer/`.

### Requirement 11: Input Validation

**User Story:** As a security-conscious developer, I want all MCP tool inputs to be validated before being forwarded to the collector, so that malformed data is rejected at the boundary.

#### Acceptance Criteria

11.1 WHEN the `search_memory` tool receives a `query` longer than 1000 characters, THE MCP_Server SHALL return an error Tool_Result indicating the query is too long.

11.2 WHEN the `save_observation` tool receives a `concepts` array with more than 50 entries, THE MCP_Server SHALL return an error Tool_Result indicating the limit.

11.3 WHEN the `save_observation` tool receives a `files_touched` array with more than 100 entries, THE MCP_Server SHALL return an error Tool_Result indicating the limit.

11.4 WHEN the `save_observation` tool receives a `facts` array with more than 50 entries, THE MCP_Server SHALL return an error Tool_Result indicating the limit.

11.5 WHEN any string field in a tool call contains `<private>` tags, THE MCP_Server SHALL pass the content through unchanged — privacy scrubbing is the Collector pipeline's responsibility, not the MCP_Server's.

### Requirement 12: Namespace Resolution

**User Story:** As an agent operating in a project context, I want memory operations to be automatically scoped to the correct namespace, so that I only see and store memories relevant to the current project.

#### Acceptance Criteria

12.1 WHEN the MCP_Server starts, THE MCP_Server SHALL derive the Namespace from the working directory using the same algorithm as the shim: `project_id` = SHA-256 of `fs.realpathSync(cwd)`, `actor_id` from `os.userInfo().username`, Namespace = `/actor/<actor_id>/project/<project_id>/`.

12.2 WHEN `os.userInfo()` throws, THE MCP_Server SHALL fall back to `process.env.USER`, then `process.env.USERNAME`, then `'unknown'` for the actor_id.

12.3 WHEN the `search_memory` tool is called, THE Collector_Client SHALL include the derived Namespace in the search request.

12.4 WHEN the `save_observation` or `save_session_summary` tool is called, THE Collector_Client SHALL include the derived Namespace in the memory record.

### Requirement 13: Output Formatting

**User Story:** As an agent consuming search results, I want memory records formatted as readable text, so that I can incorporate prior context into my reasoning without parsing JSON.

#### Acceptance Criteria

13.1 WHEN `search_memory` returns results, THE MCP_Server SHALL format each record as a text block containing the title on a header line, the summary as a paragraph, concepts as a comma-separated list, and files_touched as a newline-separated list.

13.2 WHEN `search_memory` returns multiple results, THE MCP_Server SHALL separate each record block with a blank line.

13.3 WHEN `save_observation` or `save_session_summary` succeeds, THE MCP_Server SHALL return a single-line confirmation including the record_id.

## Non-functional Requirements

### Performance

- N1. WHEN the MCP_Server process is spawned by Kiro IDE, THE MCP_Server SHALL be ready to accept tool calls within 2 seconds.
- N2. WHEN a `search_memory` tool call is made, THE end-to-end latency (MCP_Server receive → Collector search → MCP_Server respond) SHALL be under 500 milliseconds for a corpus of 1000 memory records.
- N3. WHEN a `save_observation` or `save_session_summary` tool call is made, THE end-to-end latency SHALL be under 200 milliseconds.

### Reliability

- N4. WHEN the Collector daemon is not running, THE MCP_Server SHALL return error Tool_Results for all tool calls without crashing, and SHALL resume normal operation when the Collector becomes available.
- N5. WHEN the MCP_Server encounters an out-of-memory condition or unrecoverable error, THE MCP_Server SHALL log to stderr and exit with a non-zero code rather than hanging.

### Security

- N6. THE MCP_Server SHALL bind only to stdio (stdin/stdout) and SHALL NOT open any network listening socket.
- N7. THE MCP_Server SHALL NOT log tool call parameters or memory record content to stderr in production mode, to avoid leaking sensitive project data.
- N8. WHEN constructing HTTP requests to the Collector, THE Collector_Client SHALL use parameter encoding for query strings rather than string concatenation.

### Compatibility

- N9. THE MCP_Server SHALL use the `@modelcontextprotocol/sdk` TypeScript SDK for protocol correctness and transport handling.
- N10. THE MCP_Server SHALL work with both Kiro IDE (via `.kiro/settings/mcp.json` registration) and CLI compressor agents (via agent config `mcpServers` field).

### Maintainability

- N11. THE MCP_Server module SHALL follow the same TypeScript strictness conventions as the rest of the codebase: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, ESM-only with `.js` import extensions.
- N12. THE MCP_Server SHALL have a guard test enforcing the modularity boundary (no imports from `src/collector/`, `src/shim/`, `src/installer/`).

## Out of Scope (explicit)

The following are NOT in this spec:

- **Embedding-based semantic search** — the MCP server uses the Collector's existing FTS5 lexical search. Hybrid search with embeddings is deferred to v2.
- **Authentication or authorization** — the MCP server communicates with a localhost-only Collector. Network-level auth is deferred to v3.
- **MCP resources or prompts** — only MCP tools are exposed in v1. MCP resources (e.g., browsable memory records) and MCP prompts are future work.
- **Streaming tool results** — tool results are returned as complete text blocks. Streaming is not needed for the expected result sizes.
- **Direct database access** — the MCP server is a pure HTTP client. It does not import or use `better-sqlite3` directly.
- **Privacy scrubbing** — the MCP server passes content through to the Collector, which owns the privacy scrub pipeline. The MCP server does not perform its own scrubbing.
- **Observation_Type extension** — the `session_summary` observation type referenced in Requirement 5 requires adding `'session_summary'` to the `OBSERVATION_TYPES` enum in `src/types/schemas.ts`. That schema change is captured here as a dependency but the migration details belong to the design document.
