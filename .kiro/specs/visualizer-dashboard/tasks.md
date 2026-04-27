# Implementation Plan: Visualizer Dashboard

Backend first (namespace optional + pagination), then UI.

- [x] 1. Backend: Storage and SQL changes

  - [x] 1.1 Update `listMemoryRecords` signature in `StorageBackend`
    - Change to `listMemoryRecords(params: { namespace?: string; limit: number; offset: number }): Promise<{ items: MemoryRecord[]; total: number }>`.
    - _Requirements: 9.1_

  - [x] 1.2 Update `listEvents` signature in `StorageBackend`
    - Change to `listEvents(params: { namespace?: string; limit: number }): Promise<{ items: KiroMemEvent[]; total: number }>`.
    - _Requirements: 9.2_

  - [x] 1.3 Add global SQL statements to `statements.ts`
    - `selectMemoryRecordsAll`: all memories, ORDER BY created_at DESC, LIMIT ?, OFFSET ?
    - `selectMemoryRecordCountAll`: COUNT(*) from memory_records
    - `selectMemoryRecordCountByNamespace`: COUNT(*) from memory_records WHERE namespace = ?
    - Update existing `selectMemoryRecordsByNamespace` to add LIMIT ? OFFSET ?
    - `selectEventsAll`: all events, ORDER BY valid_time DESC, LIMIT ?
    - `selectEventCountAll`: COUNT(*) from events
    - _Requirements: 1.2, 1.5, 2.2, 9.4_

  - [x] 1.4 Implement updated `listMemoryRecords` in SQLite backend
    - Namespace undefined → global queries. Namespace provided → scoped queries.
    - Return `{ items, total }`.
    - _Requirements: 1.1, 1.3, 1.4, 1.6, 9.3_

  - [x] 1.5 Implement updated `listEvents` in SQLite backend
    - Namespace undefined → global queries. Namespace provided → scoped queries.
    - _Requirements: 2.1, 2.3, 2.4, 9.3_

- [x] 2. Backend: Receiver handler updates

  - [x] 2.1 Update `GET /v1/memories` handler
    - Namespace optional. Add `limit` (default 100, max 500) and `offset` (default 0) parsing.
    - Return `{ items, total, limit, offset }`.
    - _Requirements: 1.1, 1.2, 1.5_

  - [x] 2.2 Update `GET /v1/events` handler
    - Namespace optional. Keep existing limit parsing.
    - _Requirements: 2.1_

- [x] 3. Backend tests

  - [x] 3.1 Update `test/unit/read-api-memories.test.ts`
    - Add: GET without namespace returns all memories.
    - Add: pagination (limit/offset) works, total is correct.
    - Add: offset beyond total returns empty items.
    - Existing scoped tests still pass.
    - _Requirements: 1.1, 1.2, 1.4_

  - [x] 3.2 Update `test/unit/read-api-events.test.ts`
    - Add: GET without namespace returns events globally.
    - Existing scoped tests still pass.
    - _Requirements: 2.1_

  - [x] 3.3 Update namespace isolation property tests
    - When namespace provided, isolation holds (existing).
    - When namespace omitted, results may span namespaces (correct behavior).

- [x] 4. UI: Types and components

  - [x] 4.1 Create `ui/src/types/api.ts`
    - `StatsResponse`, `EventsResponse`, `EventItem` interfaces.
    - _Requirements: 6.1, 6.2_

  - [x] 4.2 Create `ui/src/components/EventTail.tsx`
    - Cloudscape Table. Columns: Time, Kind, Session (8 chars), Body Preview (100 chars).
    - Header: "Recent Events (N total)". Loading/error/empty states.
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 4.6_

- [x] 5. UI: Wire live data into App.tsx

  - [x] 5.1 Add state and data fetching
    - State: `stats`, `events`, loading/error booleans.
    - Fetch `/v1/stats` and `/v1/events?limit=50` on mount and every 10s.
    - Try/catch on all fetches.
    - _Requirements: 3.1, 3.4, 4.4, 5.1, 5.2, 5.3_

  - [x] 5.2 Wire stats to MetricCard components
    - Pass real values instead of `0`. Update MetricCard to accept `number | null`.
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 5.3 Render EventTail below graph placeholder
    - _Requirements: 4.1, 4.6_

  - [x] 5.4 Confirm graph placeholder unchanged
    - _Requirements: 7.1_

- [x] 6. Update smoke tests

  - [x] 6.1 Update `test/unit/ui-app-smoke.test.tsx`
    - Mock `/healthz`, `/v1/stats`, `/v1/events`.
    - Assert mocked metric values appear.
    - Assert "Recent Events" appears.
    - Assert "kiro-learn" and "Memory Graph" still present.
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

- [x] 7. Final verification

  - [x] 7.1 Run full local gate
    - `npm run build && npm run typecheck && npm run lint && npm run test`

  - [x] 7.2 Manual smoke
    - Optional. Start daemon with data, open UI, verify real counts in cards, event tail with timestamps, graph placeholder unchanged, 10s refresh.
