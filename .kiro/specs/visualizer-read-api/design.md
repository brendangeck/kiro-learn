# Design Document: Visualizer Read API

## Overview

This spec adds three read-only `GET` endpoints to the collector daemon's existing `node:http` receiver. The endpoints power the three UX regions of the visualizer: stats cards at the top, a memory graph in the middle, and an event tail at the bottom. No UI changes — the dashboard and graph specs consume these endpoints.

The work breaks into three layers: new types (`StatsResult`, `ProjectInfo`), new `StorageBackend` methods with corresponding SQL statements, and new HTTP route handlers in the receiver. The receiver receives `StorageBackend` via dependency injection (added to `ReceiverDeps`); it never imports from `storage/sqlite/`.

## Architecture

### Endpoint surface

```text
GET /v1/stats?namespace=...          →  StatsResult + projects array
GET /v1/memories?namespace=...       →  { items: MemoryRecord[], total }
GET /v1/events?namespace=...&limit=N →  { items: KiroMemEvent[], total }
```

### Routing order in the receiver

```text
1. GET /healthz                      (existing)
2. POST /v1/events                   (existing — ingest)
3. GET /v1/stats                     (NEW)
4. GET /v1/memories                  (NEW)
5. GET /v1/events                    (NEW — must come after POST /v1/events)
6. GET /ui, GET /ui/*                (existing — static handler)
7. 404 fallback                      (existing)
```

Route 5 (`GET /v1/events`) shares a path with route 2 (`POST /v1/events`). The existing code already dispatches on `method === 'POST' && pathname === '/v1/events'`, so the new `GET` handler is a separate branch that fires only for `method === 'GET'`.

### Data flow

```text
Browser → GET /v1/stats → receiver → storage.getStats() → SQL → JSON response
Browser → GET /v1/memories → receiver → storage.listMemoryRecords() → SQL → JSON response
Browser → GET /v1/events → receiver → storage.listEvents() → SQL → JSON response
```

The receiver handler for `/v1/stats` also calls `storage.listProjects()` and computes `display_name` from `project_path` using `os.homedir()`.

## Components and Interfaces

### Component 1: New types in `src/types/index.ts`

```typescript
/** Aggregate stats returned by GET /v1/stats. */
export interface StatsResult {
  total_events: number;
  total_memories: number;
  total_projects: number;
  total_concepts: number;
  observation_types: Record<string, number>;
  event_kinds: Record<string, number>;
}

/** Project info returned as part of the stats response. */
export interface ProjectInfo {
  namespace: string;
  project_path: string | null;
  event_count: number;
  memory_count: number;
}
```

`ProjectInfo` carries the raw `project_path` from storage. The receiver handler derives `project_id` and `display_name` from it — storage stays platform-agnostic.

### Component 2: StorageBackend extension

Four new methods on the interface:

```typescript
export interface StorageBackend {
  // ... existing methods unchanged ...

  /** Aggregate counts, optionally scoped to a namespace. */
  getStats(namespace?: string): Promise<StatsResult>;

  /** Distinct namespaces with counts and most recent project_path. */
  listProjects(): Promise<ProjectInfo[]>;

  /** All memory records for a namespace, newest first. */
  listMemoryRecords(namespace: string): Promise<MemoryRecord[]>;

  /** Last N events for a namespace, newest first, plus total count. */
  listEvents(params: { namespace: string; limit: number }): Promise<{ items: KiroMemEvent[]; total: number }>;
}
```

### Component 3: New SQL statements

Added to `src/collector/storage/sqlite/statements.ts`:

**`selectStats` (global):**
```sql
SELECT
  (SELECT COUNT(*) FROM events) AS total_events,
  (SELECT COUNT(*) FROM memory_records) AS total_memories,
  (SELECT COUNT(DISTINCT namespace) FROM events) AS total_projects
```

**`selectStatsScoped` (namespace-filtered):**
```sql
SELECT
  (SELECT COUNT(*) FROM events WHERE namespace = ?) AS total_events,
  (SELECT COUNT(*) FROM memory_records WHERE namespace = ?) AS total_memories
```

**`selectObservationTypeCounts` / `selectObservationTypeCountsScoped`:**
```sql
SELECT observation_type, COUNT(*) AS count
FROM memory_records
[WHERE namespace = ?]
GROUP BY observation_type
```

**`selectEventKindCounts` / `selectEventKindCountsScoped`:**
```sql
SELECT kind, COUNT(*) AS count
FROM events
[WHERE namespace = ?]
GROUP BY kind
```

**`selectDistinctConcepts` / `selectDistinctConceptsScoped`:**
Concepts live inside `concepts_json` (a JSON array column). To count distinct concepts:
```sql
SELECT COUNT(DISTINCT j.value) AS total_concepts
FROM memory_records, json_each(memory_records.concepts_json) AS j
[WHERE memory_records.namespace = ?]
```

**`selectProjects`:**
```sql
SELECT
  e.namespace,
  (SELECT project_path FROM events e2
   WHERE e2.namespace = e.namespace AND e2.project_path IS NOT NULL
   ORDER BY e2.valid_time DESC LIMIT 1) AS project_path,
  COUNT(*) AS event_count,
  (SELECT COUNT(*) FROM memory_records mr WHERE mr.namespace = e.namespace) AS memory_count
FROM events e
GROUP BY e.namespace
ORDER BY event_count DESC
```

**`selectMemoryRecordsByNamespace`:**
```sql
SELECT record_id, namespace, strategy, title, summary,
       facts_json, source_event_ids_json, created_at,
       concepts_json, files_touched_json, observation_type
FROM memory_records
WHERE namespace = ?
ORDER BY created_at DESC
```

**`selectEventsByNamespace`:**
```sql
SELECT event_id, parent_event_id, session_id, actor_id,
       namespace, schema_version, kind, body_json,
       valid_time, transaction_time, source_json, content_hash
FROM events
WHERE namespace = ?
ORDER BY valid_time DESC
LIMIT ?
```

**`selectEventCountByNamespace`:**
```sql
SELECT COUNT(*) AS total FROM events WHERE namespace = ?
```

All statements are parameterized. No string interpolation.

### Component 4: Receiver handlers

Added to `startReceiver` in `src/collector/receiver/index.ts`. The `ReceiverDeps` interface gains a `storage` field:

```typescript
export interface ReceiverDeps {
  pipeline: Pipeline;
  retrieval: RetrievalAssembler;
  storage: StorageBackend;  // NEW
}
```

**`GET /v1/stats` handler:**

```typescript
if (method === 'GET' && pathname === '/v1/stats') {
  const ns = url.searchParams.get('namespace') ?? undefined;
  if (ns !== undefined && !NAMESPACE_RE.test(ns)) {
    jsonResponse(res, 400, { error: 'invalid namespace' });
    return;
  }
  try {
    const stats = await deps.storage.getStats(ns);
    const projects = await deps.storage.listProjects();
    const projectsWithDisplay = projects.map((p) => ({
      namespace: p.namespace,
      project_id: extractProjectId(p.namespace),
      display_name: deriveDisplayName(p.namespace, p.project_path),
      event_count: p.event_count,
      memory_count: p.memory_count,
    }));
    jsonResponse(res, 200, { ...stats, projects: projectsWithDisplay });
  } catch {
    jsonResponse(res, 500, { error: 'internal error' });
  }
  return;
}
```

**Helper functions (in receiver, not storage):**

```typescript
import { homedir } from 'node:os';
import { sep } from 'node:path';
import { NAMESPACE_RE } from '../../types/index.js';

function extractProjectId(namespace: string): string {
  const match = namespace.match(/^\/actor\/[^/]+\/project\/([^/]+)\/$/);
  return match?.[1] ?? namespace;
}

function deriveDisplayName(namespace: string, projectPath: string | null): string {
  if (projectPath !== null) {
    const home = homedir();
    if (projectPath.startsWith(home + sep)) {
      return projectPath.slice(home.length + 1);
    }
    return projectPath;
  }
  // Fallback: first 12 hex chars of project_id
  return extractProjectId(namespace).slice(0, 12);
}
```

**`GET /v1/memories` handler:**

```typescript
if (method === 'GET' && pathname === '/v1/memories') {
  const ns = url.searchParams.get('namespace');
  if (ns === null) {
    jsonResponse(res, 400, { error: 'namespace parameter is required' });
    return;
  }
  if (!NAMESPACE_RE.test(ns)) {
    jsonResponse(res, 400, { error: 'invalid namespace' });
    return;
  }
  try {
    const items = await deps.storage.listMemoryRecords(ns);
    jsonResponse(res, 200, { items, total: items.length });
  } catch {
    jsonResponse(res, 500, { error: 'internal error' });
  }
  return;
}
```

**`GET /v1/events` handler:**

```typescript
if (method === 'GET' && pathname === '/v1/events') {
  const ns = url.searchParams.get('namespace');
  if (ns === null) {
    jsonResponse(res, 400, { error: 'namespace parameter is required' });
    return;
  }
  if (!NAMESPACE_RE.test(ns)) {
    jsonResponse(res, 400, { error: 'invalid namespace' });
    return;
  }
  const rawLimit = url.searchParams.get('limit');
  let limit = 50;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed)) {
      jsonResponse(res, 400, { error: 'limit must be an integer' });
      return;
    }
    limit = Math.max(1, Math.min(200, parsed));
  }
  try {
    const result = await deps.storage.listEvents({ namespace: ns, limit });
    jsonResponse(res, 200, result);
  } catch {
    jsonResponse(res, 500, { error: 'internal error' });
  }
  return;
}
```

**Method enforcement:** Non-GET requests to `/v1/stats`, `/v1/memories`, or the `GET /v1/events` path are handled by the existing 404 fallback (POST to `/v1/events` is already handled above). If we want explicit 405 for `POST /v1/stats` etc., we add a check before the 404 fallback.

### Component 5: Collector wiring

`src/collector/index.ts` already creates the `storage` backend and passes it to the pipeline and query layer. It now also passes it to the receiver:

```typescript
const receiver = await startReceiver(
  { pipeline, retrieval, storage },  // storage added
  { host, port, maxBodyBytes, retrievalBudgetMs },
);
```

## Correctness Properties

### Property 1: Namespace isolation on memories

*For all* valid namespaces `ns` and any database state, every item in the response from `GET /v1/memories?namespace=ns` has `namespace === ns`.

**Validates: Requirement 7.1**

### Property 2: Namespace isolation on events

*For all* valid namespaces `ns`, every item in the response from `GET /v1/events?namespace=ns` has `namespace === ns`.

**Validates: Requirement 7.1**

### Property 3: Stats scoping

*For all* valid namespaces `ns`, the `total_events` and `total_memories` in `GET /v1/stats?namespace=ns` equal the counts of events and memories whose namespace matches `ns`.

**Validates: Requirement 7.2**

## Testing Strategy

### Property tests

| # | File | Property |
|---|---|---|
| 1 | `test/unit/read-api-namespace-isolation.property.test.ts` | Properties 1 + 2: namespace isolation on memories and events |
| 2 | `test/unit/read-api-stats-scoping.property.test.ts` | Property 3: stats counts match namespace-filtered data |

### Example tests

| File | What it validates |
|---|---|
| `test/unit/read-api-stats.test.ts` | GET /v1/stats success, with/without namespace, project list with display names, observation_type and event_kind breakdowns, empty DB returns zeros |
| `test/unit/read-api-memories.test.ts` | GET /v1/memories success, missing namespace → 400, invalid namespace → 400, empty namespace returns empty array, ordering by created_at desc |
| `test/unit/read-api-events.test.ts` | GET /v1/events success, missing namespace → 400, invalid namespace → 400, limit clamping (0→1, 999→200), non-integer limit → 400, ordering by valid_time desc, total reflects full count |
| `test/unit/read-api-method-enforcement.test.ts` | POST/PUT/DELETE on /v1/stats, /v1/memories return 404 or 405 |

## Risks and Open Questions

### Risk 1: Concept counting via json_each

SQLite's `json_each` on `concepts_json` scans every memory record row to count distinct concepts. For v1 data volumes (< 1000 memories) this is fine. If it becomes slow, a denormalized `concepts` table can be added in a future migration.

### Risk 2: Project listing subquery performance

The `selectProjects` query uses correlated subqueries for `project_path` and `memory_count`. For < 50 projects this is negligible. A future optimization could use a materialized view or a dedicated projects table.

## Interfaces

### New

| Symbol | Module | Kind |
|---|---|---|
| `StatsResult` | `src/types/index.ts` | Interface |
| `ProjectInfo` | `src/types/index.ts` | Interface |
| `getStats` | `StorageBackend` | Method |
| `listProjects` | `StorageBackend` | Method |
| `listMemoryRecords` | `StorageBackend` | Method |
| `listEvents` | `StorageBackend` | Method |
| `extractProjectId` | `src/collector/receiver/index.ts` | Function (internal) |
| `deriveDisplayName` | `src/collector/receiver/index.ts` | Function (internal) |

### Modified

| Symbol | Module | Change |
|---|---|---|
| `ReceiverDeps` | `src/collector/receiver/index.ts` | Adds `storage: StorageBackend` |
| `startReceiver` | `src/collector/receiver/index.ts` | Adds three GET route handlers |
| `startCollector` | `src/collector/index.ts` | Passes `storage` to receiver deps |
| `Statements` | `src/collector/storage/sqlite/statements.ts` | Adds ~8 new prepared statements |
| `openSqliteStorage` | `src/collector/storage/sqlite/index.ts` | Implements 4 new StorageBackend methods |
