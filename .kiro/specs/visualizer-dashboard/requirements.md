# Requirements: Visualizer Dashboard

## Introduction

This document defines the requirements for wiring the scaffold UI to live data and making the read API's namespace parameter optional. After this spec, the dashboard shows three regions: four metric cards with real counts, the graph placeholder (unchanged), and an event tail showing the last 50 events.

This is the fourth of five specs: `project-path-capture` (shipped) → `visualizer-scaffold` (shipped) → `visualizer-read-api` (shipped) → **`visualizer-dashboard` (this spec)** → `visualizer-graph`.

**In scope:** Backend: make namespace optional on `/v1/memories` and `/v1/events`; add pagination to `/v1/memories`. UI: wire stats cards to `/v1/stats`; add event tail from `/v1/events`; loading/error states; UI types; updated smoke tests.

**Out of scope:** Graph rendering (next spec); project selector; namespace filtering in the UI; breakdowns by observation type or event kind; React Router; state management libraries; charts; click-to-expand on events.

## Glossary

- **Stats_Region**: The four metric cards at the top, populated from `GET /v1/stats`.
- **Event_Tail**: The event table at the bottom, populated from `GET /v1/events?limit=50`.
- **Graph_Placeholder**: The "Memory Graph — coming soon" container. Unchanged.

## Requirements

### Requirement 1: Make Namespace Optional on `/v1/memories`

**User Story:** As the graph UI (next spec), I want to fetch all memories across all projects in one call.

#### Acceptance Criteria

1. THE `/v1/memories` endpoint SHALL accept an optional `namespace` query parameter. When absent, results span all namespaces.
2. THE endpoint SHALL support `limit` (default 100, max 500) and `offset` (default 0) query parameters.
3. THE response shape SHALL be `{ items: MemoryRecord[], total: number, limit: number, offset: number }`.
4. THE `total` field SHALL reflect the count before pagination.
5. `limit` and `offset` SHALL be parsed as integers. Non-integer values return `400`. `limit` clamped to `[1, 500]`. `offset` clamped to `[0, ∞)`.
6. Memories ordered by `created_at` descending.

### Requirement 2: Make Namespace Optional on `/v1/events`

**User Story:** As the event tail, I want the last N events across all projects.

#### Acceptance Criteria

1. THE `/v1/events` endpoint SHALL accept an optional `namespace` query parameter. When absent, results span all namespaces.
2. `limit` continues to work (default 50, max 200).
3. Response shape stays `{ items: KiroMemEvent[], total: number }`.
4. Events ordered by `valid_time` descending.

### Requirement 3: Stats Cards — Live Data

**User Story:** As a kiro-learn user, I want the four metric cards to show real counts.

#### Acceptance Criteria

1. On load, fetch `GET /v1/stats` and populate cards with `total_memories`, `total_events`, `total_projects`, `total_concepts`.
2. While fetching, show a loading indicator in each card.
3. On fetch failure, show `—` with an error indicator.
4. Refresh every 10 seconds.

### Requirement 4: Event Tail — Live Data

**User Story:** As a kiro-learn user, I want to see the most recent events.

#### Acceptance Criteria

1. Fetch `GET /v1/events?limit=50` and display in a Cloudscape `Table`.
2. Columns: Time (formatted `valid_time`), Kind, Session (8 chars), Body Preview (100 chars with `...`).
3. Header shows "Recent Events (N total)".
4. Refresh every 10 seconds.
5. Loading state while fetching. Error message on failure.
6. Newest first.

### Requirement 5: Loading and Error States

**User Story:** As a user, I want clear feedback when data is loading or unavailable.

#### Acceptance Criteria

1. On initial load, show loading indicators in all data regions.
2. On fetch failure, show error in the affected region only.
3. All fetches wrapped in try/catch. Dashboard never crashes.

### Requirement 6: UI Types

**User Story:** As a UI developer, I want TypeScript interfaces for the API responses.

#### Acceptance Criteria

1. Define interfaces in `ui/src/types/api.ts` for stats and events responses.
2. Do NOT import from `src/`.

### Requirement 7: Graph Placeholder Unchanged

#### Acceptance Criteria

1. The graph placeholder remains as-is. No data fetching, no interaction.

### Requirement 8: Updated Smoke Tests

#### Acceptance Criteria

1. Mock `fetch` for `/healthz`, `/v1/stats`, `/v1/events`.
2. Assert metric card values from mocked stats appear.
3. Assert "Recent Events" text appears.
4. Assert "kiro-learn" and "Memory Graph" text still present.

### Requirement 9: StorageBackend Changes

#### Acceptance Criteria

1. `listMemoryRecords` accepts `{ namespace?: string; limit: number; offset: number }`, returns `{ items, total }`.
2. `listEvents` accepts `{ namespace?: string; limit: number }`, returns `{ items, total }`.
3. When namespace undefined, return data across all namespaces.
4. SQLite backend adds global query variants.

## Non-functional Requirements

- **N1.** `/v1/memories?limit=100` responds in under 50 ms for 1,000 memories.
- **N2.** `/v1/events?limit=50` responds in under 20 ms.
- **N3.** Dashboard initial render (with loading states) in under 500 ms.
- **N4.** UI does not import from `src/`. Guard tests enforce.

## Out of Scope

- Graph rendering — next spec.
- Project selector / namespace filtering in UI.
- Observation type or event kind breakdowns.
- React Router, state management libraries, charts.
- Click-to-expand on events.
- Real-time SSE/WebSocket.
