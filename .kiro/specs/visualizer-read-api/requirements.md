# Requirements: Visualizer Read API

## Introduction

This document defines the requirements for adding three read-only HTTP endpoints to the kiro-learn collector daemon. These endpoints power the three UX regions of the visualizer: aggregated stats at the top, a memory graph in the middle, and a tail of recent events at the bottom.

This is the third of five specs in the v1 visualizer sequence: `project-path-capture` (shipped) → `visualizer-scaffold` (shipped) → **`visualizer-read-api` (this spec)** → `visualizer-dashboard` → `visualizer-graph`.

The API is read-only. Three `GET` endpoints on the existing daemon, same port (`127.0.0.1:21100`), same `/v1/` prefix. No write endpoints. No pagination complexity — the events endpoint returns the last N events as a simple tail, and the memories endpoint returns all memories for a namespace (v1 data volumes are modest). The `StorageBackend` interface is extended with new read methods; the receiver routes call those methods via dependency injection.

**Three endpoints, three UX regions:**

```text
┌─────────────────────────────────────────────────┐
│  Stats   │  GET /v1/stats                       │
│          │  Counts, breakdowns, project list     │
├─────────────────────────────────────────────────┤
│  Graph   │  GET /v1/memories?namespace=...       │
│          │  All memories for a project — client  │
│          │  derives concepts + graph structure   │
├─────────────────────────────────────────────────┤
│  Events  │  GET /v1/events?namespace=...&limit=N │
│          │  Last N events, newest first          │
└─────────────────────────────────────────────────┘
```

**In scope:** Three `GET /v1/...` routes (stats, memories, events); `StorageBackend` interface extension; new prepared SQL statements; input validation; error shapes; namespace scoping; property tests for namespace isolation.

**Out of scope:** Write endpoints; pagination (not needed for v1 data volumes); individual record detail endpoints (client already has the data from the list calls); FTS5 search endpoint; graph-shaped endpoint; UI changes; MCP tool wrappers; auth; HTTPS.

## Glossary

- **Read_API**: The three `GET /v1/...` HTTP routes added by this spec. All return `Content-Type: application/json`. All are read-only.
- **StorageBackend**: The pluggable persistence interface in `src/types/index.ts`. This spec extends it with new read methods.
- **Namespace**: The `/actor/<actor_id>/project/<project_id>/` isolation key. The memories and events endpoints require it as a query parameter.
- **Project**: The user-facing concept corresponding to a namespace. Stats returns a project list with display names derived from `project_path`.
- **Display_Name**: Human-readable project name derived server-side from `events.project_path` by stripping the `$HOME/` prefix. Falls back to the first 12 hex characters of `project_id` when `project_path` is NULL.
- **Event_Tail**: The last N events for a namespace, ordered newest-first. Not paginated — a simple bounded query.

## Requirements

### Requirement 1: Stats Endpoint

**User Story:** As the dashboard UI, I want a single endpoint that returns everything needed for the stats cards and the project selector, so one fetch populates the entire top region.

#### Acceptance Criteria

1. WHEN a `GET /v1/stats` request is received, THE Read_API SHALL return a JSON object containing:
   - `total_events` (integer) — count of all events across all namespaces.
   - `total_memories` (integer) — count of all memory records across all namespaces.
   - `total_projects` (integer) — count of distinct namespaces.
   - `total_concepts` (integer) — count of distinct concept strings across all memory records.
2. THE response SHALL include an `observation_types` object mapping each observation type (`tool_use`, `decision`, `error`, `discovery`, `pattern`) to its count of memory records.
3. THE response SHALL include an `event_kinds` object mapping each event kind (`prompt`, `tool_use`, `session_summary`, `note`) to its count of events.
4. THE response SHALL include a `projects` array where each element contains:
   - `namespace` (string) — the full namespace.
   - `project_id` (string) — the hex hash segment extracted from the namespace.
   - `display_name` (string) — derived from the most recent non-NULL `project_path` for that namespace with `$HOME/` stripped; falls back to the first 12 hex chars of `project_id`.
   - `event_count` (integer).
   - `memory_count` (integer).
5. THE `projects` array SHALL be ordered by `event_count` descending.
6. WHEN a `namespace` query parameter is provided, THE counts (`total_events`, `total_memories`, `total_concepts`, `observation_types`, `event_kinds`) SHALL be scoped to that namespace only. The `projects` array SHALL still contain all projects regardless of the namespace filter.
7. THE response status SHALL be `200` with `Content-Type: application/json`.

### Requirement 2: Memories Endpoint

**User Story:** As the graph UI, I want all memory records for a project in one call, so I can derive concept nodes, project grouping, and graph edges client-side.

#### Acceptance Criteria

1. WHEN a `GET /v1/memories` request is received with a `namespace` query parameter, THE Read_API SHALL return a JSON object with an `items` array containing all memory records for that namespace.
2. THE `namespace` parameter SHALL be required. If absent, THE Read_API SHALL return `400 {"error": "namespace parameter is required"}`.
3. EACH memory record object SHALL contain all fields from the `MemoryRecord` schema: `record_id`, `namespace`, `strategy`, `title`, `summary`, `facts`, `source_event_ids`, `created_at`, `concepts`, `files_touched`, `observation_type`.
4. THE memories SHALL be ordered by `created_at` descending (newest first).
5. THE response SHALL include a `total` field with the count of memories returned.
6. THE response status SHALL be `200`.
7. THE endpoint SHALL NOT be paginated. All memories for the namespace are returned in one response. *(v1 data volumes are modest — hundreds of memories per project at most. If this assumption is violated, pagination can be added in a later spec without breaking the response shape.)*

### Requirement 3: Events Endpoint

**User Story:** As the event-tail UI region, I want the last N events for a project, newest first, so I can show a live-ish feed of what the collector has captured.

#### Acceptance Criteria

1. WHEN a `GET /v1/events` request is received with a `namespace` query parameter, THE Read_API SHALL return a JSON object with an `items` array containing events for that namespace.
2. THE `namespace` parameter SHALL be required. If absent, THE Read_API SHALL return `400 {"error": "namespace parameter is required"}`.
3. THE endpoint SHALL accept a `limit` query parameter (default `50`, max `200`). Values above `200` SHALL be clamped to `200`. Values below `1` SHALL be clamped to `1`.
4. EACH event object SHALL contain all fields from the `KiroMemEvent` schema: `event_id`, `parent_event_id` (when present), `session_id`, `actor_id`, `namespace`, `schema_version`, `kind`, `body`, `valid_time`, `source`, `content_hash` (when present).
5. THE events SHALL be ordered by `valid_time` descending (newest first).
6. THE response SHALL include a `total` field with the total count of events in that namespace (not just the returned slice).
7. THE response status SHALL be `200`.
8. THE endpoint SHALL NOT support offset-based pagination. It is a tail — the last N events. *(If the UI needs older events in the future, pagination can be added without breaking the response shape.)*

### Requirement 4: Input Validation

**User Story:** As a security-conscious developer, I want all query parameters validated before they reach the storage layer.

#### Acceptance Criteria

1. THE Read_API SHALL validate `namespace` parameters against `NAMESPACE_RE` (`/^\/actor\/[^/]+\/project\/[^/]+\/$/`). Invalid namespaces SHALL return `400 {"error": "invalid namespace"}`.
2. THE `limit` parameter on `/v1/events` SHALL be parsed as an integer. Non-integer values SHALL return `400 {"error": "limit must be an integer"}`.
3. STRING query parameters SHALL be bounded to 500 characters. Values exceeding this limit SHALL return `400 {"error": "parameter too long"}`.
4. ALL validation SHALL happen before any storage call.

### Requirement 5: Error Response Shape

**User Story:** As a UI developer, I want consistent error responses across all endpoints.

#### Acceptance Criteria

1. ALL error responses SHALL be JSON objects with an `error` field containing a human-readable message string: `{"error": "..."}`.
2. THE Read_API SHALL return `405 {"error": "method not allowed"}` with an `Allow: GET` header for non-GET requests on any `/v1/stats`, `/v1/memories`, or `/v1/events` route.
3. THE Read_API SHALL return `500 {"error": "internal error"}` when a storage operation fails unexpectedly. No stack traces in the response.

### Requirement 6: StorageBackend Extension

**User Story:** As a storage layer author, I want the new read operations defined on the `StorageBackend` interface so every backend implements them identically.

#### Acceptance Criteria

1. THE `StorageBackend` interface SHALL be extended with the following methods:
   - `getStats(namespace?: string): Promise<StatsResult>` — returns aggregate counts and breakdowns, optionally scoped to a namespace.
   - `listProjects(): Promise<ProjectInfo[]>` — returns distinct namespaces with event/memory counts and the most recent `project_path`.
   - `listMemoryRecords(namespace: string): Promise<MemoryRecord[]>` — returns all memory records for a namespace, ordered by `created_at` descending.
   - `listEvents(params: { namespace: string; limit: number }): Promise<{ items: KiroMemEvent[]; total: number }>` — returns the last N events for a namespace plus the total count.
2. THE new types `StatsResult`, `ProjectInfo` SHALL be defined in `src/types/index.ts` and exported.
3. THE SQLite backend SHALL implement all new methods using parameterized prepared statements.
4. THE new methods SHALL NOT break the existing `StorageBackend` contract.

### Requirement 7: Namespace Isolation

**User Story:** As a kiro-learn user, I want the read API to never leak data from one project into another.

#### Acceptance Criteria

1. FOR ALL responses from `/v1/memories` and `/v1/events`, EVERY returned item's namespace SHALL match the requested namespace parameter. *(testable as a property)*
2. THE `/v1/stats` endpoint, when called with a `namespace` parameter, SHALL count only events and memories whose namespace matches. *(testable as a property)*
3. THE `projects` array in the stats response is the only data that intentionally spans namespaces.

### Requirement 8: Display Name Derivation

**User Story:** As the dashboard UI, I want project display names computed server-side so the UI doesn't need to know about `$HOME` or path parsing.

#### Acceptance Criteria

1. THE `listProjects` storage method SHALL return `project_path` (the most recent non-NULL `project_path` from events in that namespace) alongside namespace and counts.
2. THE `/v1/stats` handler SHALL compute `display_name` from `project_path` by stripping the `os.homedir()` prefix plus the trailing separator.
3. WHEN `project_path` is NULL for all events in a namespace, THE `display_name` SHALL fall back to the first 12 hex characters of the `project_id` segment.
4. THE `display_name` computation SHALL happen in the receiver handler, NOT in the storage layer.

### Requirement 9: Receiver Integration

**User Story:** As a receiver author, I want the new read routes wired into the existing request handler.

#### Acceptance Criteria

1. THE new read routes SHALL be added to `startReceiver` in `src/collector/receiver/index.ts`.
2. THE receiver SHALL receive the `StorageBackend` instance via dependency injection (added to `ReceiverDeps`).
3. THE new routes SHALL be placed after `/healthz` and before the static UI handler in the routing order.
4. THE receiver SHALL NOT import from `src/collector/storage/sqlite/`. The existing modularity guard test SHALL continue to pass.

## Non-functional Requirements

### Performance

- **N1.** THE `/v1/stats` endpoint SHALL respond in under 50 ms on a database with 10,000 events and 1,000 memory records.
- **N2.** THE `/v1/memories` endpoint SHALL respond in under 50 ms for a namespace with 500 memory records.
- **N3.** THE `/v1/events` endpoint with `limit=50` SHALL respond in under 20 ms.

### Security

- **N4.** ALL new endpoints bind to loopback only, matching existing posture.
- **N5.** ALL SQL uses parameterized prepared statements. No string interpolation.
- **N6.** THE Read_API SHALL NOT expose `transaction_time` or any internal storage field not on the public types.

### Modularity

- **N7.** THE receiver accesses storage exclusively through `StorageBackend`. No direct SQLite imports.
- **N8.** Existing modularity guard tests pass unchanged.

### Testability

- **N9.** Property-based tests for namespace isolation (Requirement 7.1, 7.2) using `fast-check`.
- **N10.** Example-based tests for each endpoint: success path, 400 for invalid/missing namespace, 405 for wrong method, 500 handling, limit clamping on events.
- **N11.** `test/helpers/arbitrary.ts` extended with generators for `StatsResult` and `ProjectInfo`.

## Out of Scope (explicit)

- Write endpoints (create, update, delete) — memories and events are immutable.
- Pagination on memories or stats — v1 data volumes don't warrant it.
- Individual record detail endpoints (`/v1/memories/:id`, `/v1/events/:id`) — the client already has the data from the list calls. Add later if needed.
- FTS5 search endpoint — the dashboard and graph don't need it.
- Graph-shaped endpoint (nodes + edges) — deferred to `visualizer-graph`. The graph spec derives its structure client-side from `/v1/memories`.
- UI changes — deferred to `visualizer-dashboard` and `visualizer-graph`.
- MCP tool wrappers — separate v1 work.
- Auth, HTTPS, CORS — loopback-only posture.
- Time-range filtering — no recency/decay in v1.
- `schema_version` bump — additive changes only.
