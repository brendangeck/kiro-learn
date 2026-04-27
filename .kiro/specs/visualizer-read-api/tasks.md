# Implementation Plan: Visualizer Read API

Tasks are in dependency order: types first (unblocks everything), then storage (SQL + backend methods), then receiver (HTTP handlers), then tests. The storage layer must be complete before the receiver can call it, and both must exist before integration tests can exercise the full stack.

- [x] 1. Define new types
  - New interfaces needed by the storage and receiver layers.

  - [x] 1.1 Add `StatsResult` and `ProjectInfo` to `src/types/index.ts`
    - `StatsResult`: `{ total_events: number; total_memories: number; total_projects: number; total_concepts: number; observation_types: Record<string, number>; event_kinds: Record<string, number> }`.
    - `ProjectInfo`: `{ namespace: string; project_path: string | null; event_count: number; memory_count: number }`.
    - Export both from the module.
    - _Requirements: 6.2_

  - [x] 1.2 Extend `StorageBackend` interface with four new methods
    - `getStats(namespace?: string): Promise<StatsResult>`
    - `listProjects(): Promise<ProjectInfo[]>`
    - `listMemoryRecords(namespace: string): Promise<MemoryRecord[]>`
    - `listEvents(params: { namespace: string; limit: number }): Promise<{ items: KiroMemEvent[]; total: number }>`
    - Do NOT remove or modify existing methods.
    - _Requirements: 6.1, 6.4_

- [x] 2. Add prepared SQL statements
  - All new queries in `src/collector/storage/sqlite/statements.ts`. Parameterized, no string interpolation.

  - [x] 2.1 Add stats-related statements
    - `selectStats`: global counts (total_events, total_memories, total_projects).
    - `selectStatsScoped`: namespace-filtered counts (total_events, total_memories).
    - `selectObservationTypeCounts` / `selectObservationTypeCountsScoped`: group by observation_type.
    - `selectEventKindCounts` / `selectEventKindCountsScoped`: group by kind.
    - `selectDistinctConcepts` / `selectDistinctConceptsScoped`: count distinct concepts via `json_each(concepts_json)`.
    - _Requirements: 1.1, 1.2, 1.3, 1.6, N5_

  - [x] 2.2 Add project listing statement
    - `selectProjects`: distinct namespaces with event_count, memory_count, and most recent non-NULL project_path. Ordered by event_count DESC.
    - _Requirements: 1.4, 1.5, 8.1_

  - [x] 2.3 Add memory listing statement
    - `selectMemoryRecordsByNamespace`: all memory records for a namespace, ordered by created_at DESC.
    - _Requirements: 2.1, 2.4, 2.6_

  - [x] 2.4 Add event listing statements
    - `selectEventsByNamespace`: events for a namespace, ordered by valid_time DESC, with LIMIT parameter.
    - `selectEventCountByNamespace`: COUNT(*) for a namespace.
    - _Requirements: 3.1, 3.3, 3.5, 3.6_

- [x] 3. Implement StorageBackend methods in SQLite backend
  - Wire the new statements into `src/collector/storage/sqlite/index.ts`.

  - [x] 3.1 Implement `getStats`
    - When `namespace` is undefined, use global statements. When provided, use scoped statements.
    - Assemble `StatsResult` from the individual query results.
    - For `total_concepts`, use `json_each` query.
    - For `total_projects`, use the global count of distinct namespaces (only in unscoped mode; scoped mode has exactly 1 project).
    - _Requirements: 1.1, 1.2, 1.3, 1.6_

  - [x] 3.2 Implement `listProjects`
    - Execute `selectProjects`, map rows to `ProjectInfo[]`.
    - _Requirements: 1.4, 1.5, 8.1_

  - [x] 3.3 Implement `listMemoryRecords`
    - Execute `selectMemoryRecordsByNamespace`, map rows via existing `rowToMemoryRecord`.
    - _Requirements: 2.1, 2.3, 2.4_

  - [x] 3.4 Implement `listEvents`
    - Execute `selectEventsByNamespace` for items, `selectEventCountByNamespace` for total.
    - Map rows via existing `rowToEvent`.
    - Return `{ items, total }`.
    - _Requirements: 3.1, 3.4, 3.5, 3.6_

- [x] 4. Add receiver route handlers
  - Wire the three endpoints into `src/collector/receiver/index.ts`.

  - [x] 4.1 Add `storage` to `ReceiverDeps`
    - Add `storage: StorageBackend` to the `ReceiverDeps` interface.
    - Import `StorageBackend` type from `../../types/index.js`.
    - _Requirements: 9.2, N7_

  - [x] 4.2 Add helper functions `extractProjectId` and `deriveDisplayName`
    - `extractProjectId(namespace)`: regex-extract the project_id hex segment.
    - `deriveDisplayName(namespace, projectPath)`: strip `$HOME/` prefix from project_path; fall back to first 12 hex chars of project_id.
    - Both are internal to the receiver module.
    - _Requirements: 8.2, 8.3, 8.4_

  - [x] 4.3 Implement `GET /v1/stats` handler
    - Parse optional `namespace` query param. Validate against `NAMESPACE_RE` if present.
    - Call `storage.getStats(namespace)` and `storage.listProjects()`.
    - Map projects through `extractProjectId` and `deriveDisplayName`.
    - Return combined response with stats + projects array.
    - On storage error, return 500.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 5.3, 8.2, 8.3_

  - [x] 4.4 Implement `GET /v1/memories` handler
    - Require `namespace` query param (400 if missing). Validate against `NAMESPACE_RE`.
    - Call `storage.listMemoryRecords(namespace)`.
    - Return `{ items, total: items.length }`.
    - On storage error, return 500.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 5.3_

  - [x] 4.5 Implement `GET /v1/events` handler
    - Require `namespace` query param (400 if missing). Validate against `NAMESPACE_RE`.
    - Parse `limit` query param: default 50, clamp to [1, 200], reject non-integers with 400.
    - Call `storage.listEvents({ namespace, limit })`.
    - Return the result directly.
    - On storage error, return 500.
    - Must not conflict with existing `POST /v1/events` — dispatch on method.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.2, 5.3_

  - [x] 4.6 Add method enforcement for read routes
    - Non-GET requests to `/v1/stats` or `/v1/memories` return 405 with `Allow: GET` header.
    - `GET /v1/events` is distinguished from `POST /v1/events` by method check.
    - _Requirements: 5.2_

- [x] 5. Update collector wiring
  - Pass `storage` to the receiver in `src/collector/index.ts`.

  - [x] 5.1 Pass `storage` to `startReceiver` in `startCollector`
    - Change `{ pipeline, retrieval }` to `{ pipeline, retrieval, storage }` in the `startReceiver` call.
    - _Requirements: 9.1, 9.3_

- [x] 6. Property tests

  - [x] 6.1 Property test: namespace isolation on memories and events
    - New file `test/unit/read-api-namespace-isolation.property.test.ts`.
    - Seed a DB with events and memories across multiple namespaces. For any namespace, assert every item returned by `listMemoryRecords` and `listEvents` has a matching namespace.
    - _Requirements: 7.1, N9_

  - [x] 6.2 Property test: stats scoping
    - New file `test/unit/read-api-stats-scoping.property.test.ts`.
    - Seed a DB with events and memories across multiple namespaces. For any namespace, assert `getStats(ns).total_events` equals the count of events with that namespace, and `getStats(ns).total_memories` equals the count of memories with that namespace.
    - _Requirements: 7.2, N9_

- [x] 7. Example tests

  - [x] 7.1 Stats endpoint tests
    - New file `test/unit/read-api-stats.test.ts`.
    - Success: seed DB, GET /v1/stats, verify counts, observation_types, event_kinds, projects array with display_name.
    - Scoped: GET /v1/stats?namespace=..., verify counts are filtered.
    - Empty DB: all counts are 0, projects array is empty.
    - Invalid namespace: 400.
    - _Requirements: 1.1–1.7, 4.1, 5.1_

  - [x] 7.2 Memories endpoint tests
    - New file `test/unit/read-api-memories.test.ts`.
    - Success: seed DB, GET /v1/memories?namespace=..., verify items and total.
    - Missing namespace: 400.
    - Invalid namespace: 400.
    - Empty namespace: items=[], total=0.
    - Ordering: newest created_at first.
    - _Requirements: 2.1–2.7, 4.1, 5.1_

  - [x] 7.3 Events endpoint tests
    - New file `test/unit/read-api-events.test.ts`.
    - Success: seed DB, GET /v1/events?namespace=..., verify items and total.
    - Missing namespace: 400.
    - Invalid namespace: 400.
    - Limit clamping: limit=0 → 1, limit=999 → 200.
    - Non-integer limit: 400.
    - Ordering: newest valid_time first.
    - Total reflects full count, not just returned slice.
    - _Requirements: 3.1–3.8, 4.2, 5.1_

  - [x] 7.4 Method enforcement tests
    - New file `test/unit/read-api-method-enforcement.test.ts`.
    - POST /v1/stats → 405 or 404.
    - POST /v1/memories → 405 or 404.
    - DELETE /v1/stats → 405 or 404.
    - GET /v1/events still works (not blocked by POST /v1/events handler).
    - _Requirements: 5.2_

- [x] 8. Guard test verification
  - Run existing modularity guard tests and confirm they pass with the new code.

  - [x] 8.1 Verify `no-sqlite-in-pipeline.test.ts` passes
    - The receiver imports `StorageBackend` from `src/types/`, not from `src/collector/storage/sqlite/`.
    - _Requirements: 9.4, N7, N8_

- [x] 9. Extend test helpers

  - [x] 9.1 Add generators for `StatsResult` and `ProjectInfo` to `test/helpers/arbitrary.ts`
    - `arbitraryStatsResult()`: generates valid `StatsResult` objects.
    - `arbitraryProjectInfo()`: generates valid `ProjectInfo` objects.
    - _Requirements: N11_

- [x] 10. Final verification

  - [x] 10.1 Run the full local gate
    - `npm run build` — confirms compilation with new types and methods.
    - `npm run typecheck` — confirms strict mode passes.
    - `npm run lint` — no new violations.
    - `npm run test` — all new and existing tests pass.

  - [x] 10.2 Manual smoke test
    - Optional. Start daemon, seed some events via POST, then curl the three endpoints and verify JSON responses.

## Notes

- The `GET /v1/events` route shares a path with the existing `POST /v1/events` ingest endpoint. They are distinguished by HTTP method in the receiver's routing logic.
- `display_name` is computed in the receiver handler, not in storage. This keeps the storage layer platform-agnostic (no `os.homedir()` dependency).
- The `total_concepts` count uses SQLite's `json_each()` to explode the `concepts_json` array column. This is a table scan but acceptable for v1 data volumes.
- No pagination on `/v1/memories` — all records for a namespace are returned. v1 expects < 500 memories per project.
- The events endpoint is a simple tail (last N), not paginated. The `total` field tells the UI how many events exist even though only `limit` are returned.
