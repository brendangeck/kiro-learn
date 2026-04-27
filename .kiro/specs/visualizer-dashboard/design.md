# Design Document: Visualizer Dashboard

## Overview

Two changes: backend makes namespace optional on `/v1/memories` and `/v1/events` (with pagination on memories), and the UI replaces hardcoded zeros with live data from `/v1/stats` plus an event tail from `/v1/events`. Three UX regions: stats cards, graph placeholder (unchanged), event tail.

## Backend Changes

### Storage signature changes

```typescript
// Was:
listMemoryRecords(namespace: string): Promise<MemoryRecord[]>
listEvents(params: { namespace: string; limit: number }): Promise<{ items: KiroMemEvent[]; total: number }>

// Becomes:
listMemoryRecords(params: { namespace?: string; limit: number; offset: number }): Promise<{ items: MemoryRecord[]; total: number }>
listEvents(params: { namespace?: string; limit: number }): Promise<{ items: KiroMemEvent[]; total: number }>
```

### New SQL statements

```sql
-- Global memories (no namespace)
SELECT ... FROM memory_records ORDER BY created_at DESC LIMIT ? OFFSET ?
SELECT COUNT(*) AS total FROM memory_records

-- Scoped memories (with namespace) — update existing to add LIMIT/OFFSET
SELECT ... FROM memory_records WHERE namespace = ? ORDER BY created_at DESC LIMIT ? OFFSET ?
SELECT COUNT(*) AS total FROM memory_records WHERE namespace = ?

-- Global events (no namespace)
SELECT ... FROM events ORDER BY valid_time DESC LIMIT ?
SELECT COUNT(*) AS total FROM events
```

### Receiver handler changes

Both handlers: namespace becomes optional. When absent, pass `undefined` to storage. Memories handler adds `limit`/`offset` parsing.

## UI Changes

### Data flow

```
mount → fetch /healthz + /v1/stats + /v1/events?limit=50
every 10s → re-fetch all three

Stats_Region: 4 MetricCards from stats response
Graph_Placeholder: unchanged
Event_Tail: Cloudscape Table from events response
```

### New types (`ui/src/types/api.ts`)

```typescript
export interface StatsResponse {
  total_events: number;
  total_memories: number;
  total_projects: number;
  total_concepts: number;
  observation_types: Record<string, number>;
  event_kinds: Record<string, number>;
  projects: Array<{
    namespace: string;
    project_id: string;
    display_name: string;
    event_count: number;
    memory_count: number;
  }>;
}

export interface EventsResponse {
  items: EventItem[];
  total: number;
}

export interface EventItem {
  event_id: string;
  session_id: string;
  kind: string;
  body: { type: string; content?: string; turns?: Array<{ role: string; content: string }>; data?: unknown };
  valid_time: string;
}
```

### EventTail component

Cloudscape `Table`. Columns: Time, Kind, Session (8 chars), Body Preview (100 chars). Header: "Recent Events (N total)". Loading/error/empty states.

### App.tsx changes

- Add state: `stats`, `events`, loading/error booleans.
- Fetch `/v1/stats` and `/v1/events?limit=50` on mount and every 10s.
- Pass real values to MetricCard instead of `0`.
- Render EventTail below graph placeholder.
- MetricCard accepts `number | null` for loading/error.

## Interfaces

### Modified (backend)

| Symbol | Change |
|---|---|
| `listMemoryRecords` on `StorageBackend` | Namespace optional, adds limit/offset, returns `{ items, total }` |
| `listEvents` on `StorageBackend` | Namespace optional |
| `Statements` | Adds global query variants + memory count queries |
| `GET /v1/memories` handler | Namespace optional, limit/offset |
| `GET /v1/events` handler | Namespace optional |

### New (UI)

| Symbol | Module |
|---|---|
| `StatsResponse`, `EventsResponse`, `EventItem` | `ui/src/types/api.ts` |
| `EventTail` | `ui/src/components/EventTail.tsx` |
