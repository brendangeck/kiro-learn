# Requirements: Project Path Capture

## Introduction

This document defines the requirements for fixing project-root detection in the kiro-learn shim and for capturing the resolved project path on every event so downstream consumers can surface human-readable project names.

Today the shim derives `project_id` as `SHA-256(realpath(cwd))` (see `src/shim/shared/index.ts` `buildEvent`). Running kiro-cli from `~/code/myrepo`, `~/code/myrepo/src`, and `~/code/myrepo/test` therefore produces three different `project_id`s for what is logically one project. That fragments the namespace and fragments memory retrieval — a correctness bug, not just a UX issue.

This spec changes the hash input from `realpath(cwd)` to `realpath(project_root)`, where `project_root` is determined by walking upward from cwd looking for the same 15 project markers the installer uses (`src/installer/index.ts` `PROJECT_MARKERS`). When no marker is found before the walk reaches `$HOME`, the shim emits a stable **global sentinel** identity derived from `$HOME` itself — all non-project events from one user collapse into one namespace instead of fragmenting per-directory.

The spec also adds an optional `project_path` field to `EventSource` so the preimage of the hash is persisted alongside it. Storage gains a matching nullable `project_path` column via migration `0003_project_path`. With the preimage captured, future read APIs can display human-readable project names.

This is a precursor to the v1 visualizer sequence. It is strictly about capturing and persisting project identity correctly. No UI, no new endpoints, no read API.

**In scope:** Shim project-root detection (marker walk, walk ceiling, fallback); `EventSource.project_path` field addition; `events.project_path` column migration; insert-time extraction of `source.project_path` into the storage column; property tests for the invariants called out below.

**Out of scope:** Visualizer endpoints, read API, display-name formatting (stripping `$HOME/` for UI presentation), hash-scheme migration or event-backfill tooling, environment-variable overrides for `project_path`, refactoring the installer's marker-walk logic into a shared utility.

## Glossary

- **Shim**: The thin adapter layer invoked by Kiro CLI agent hooks. Reads stdin, builds a canonical event, POSTs to the collector. Implemented under `src/shim/`.
- **Project_Root**: The nearest ancestor directory of cwd (including cwd itself) that contains a project marker. Determined by the upward walk defined in Requirement 1. When no marker is found before the walk reaches the Walk_Ceiling, Project_Root is the Walk_Ceiling (the resolved `$HOME`) and the event is a Global_Event.
- **Project_Marker**: One of the 15 filenames the installer uses in `PROJECT_MARKERS` (`.kiro`, `.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, `setup.py`, `go.mod`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `Gemfile`, `composer.json`, `mix.exs`, `deno.json`, `deno.jsonc`). A directory contains a marker if any of these files or directories exists at that directory.
- **Walk_Ceiling**: The resolved `$HOME` directory (`realpath(os.homedir())`). The marker walk never inspects this directory or any directory at or above it.
- **Global_Event**: An event whose Project_Root resolves to the Walk_Ceiling because no Project_Marker was found during the upward walk. Its `project_id` hashes the Walk_Ceiling so all of one user's non-project events share a single namespace.
- **Project_Path**: The absolute, symlink-resolved filesystem path of the Project_Root. Emitted by the shim as `source.project_path` and persisted in the `events.project_path` column.
- **EventSource**: The `source` block of a `KiroMemEvent` — `{ surface, version, client_id }` today; this spec adds an optional `project_path` field.
- **Migration_0003**: The new storage migration `0003_project_path` that adds the nullable `project_path` TEXT column to the `events` table and an index supporting namespace-grouped aggregation.

## Requirements

### Requirement 1: Shim — Project-Root Detection via Marker Walk

**User Story:** As a kiro-learn user, I want the shim to identify my project by the repo's root directory — not by whatever subdirectory I happened to run kiro-cli from — so memories captured in `~/code/myrepo/src` and `~/code/myrepo/test` share the same namespace as those captured in `~/code/myrepo` itself.

#### Acceptance Criteria

1. THE Shim SHALL derive Project_Root by walking from the resolved cwd upward, inspecting each directory for any Project_Marker.
2. THE Shim SHALL resolve cwd with `realpathSync` before starting the walk, so symlinked working directories are normalised to their real paths.
3. WHEN a directory contains at least one Project_Marker, THE Shim SHALL stop the walk and use that directory as the Project_Root.
4. THE Shim SHALL check markers in the exact order defined by the installer's `PROJECT_MARKERS` list (`.kiro`, `.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, `setup.py`, `go.mod`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `Gemfile`, `composer.json`, `mix.exs`, `deno.json`, `deno.jsonc`). Within a single directory, the first marker present in this order wins.
5. WHERE a single directory contains multiple markers, THE Shim SHALL treat the directory itself as the Project_Root regardless of which marker matched — the marker identity is not persisted or used downstream. (Order-of-checks is a tie-breaker for debug logging only.) *(testable as a property — for any directory containing any subset of markers, the derived Project_Root equals the directory path.)*

### Requirement 2: Shim — Walk Ceiling

**User Story:** As a kiro-learn user, I want the marker walk to terminate cleanly at `$HOME` so it never escapes into `/Users`, `/`, or other system directories, and so the walk's worst case is bounded by my home-directory depth.

#### Acceptance Criteria

1. THE Shim SHALL compute the Walk_Ceiling once at walk start as `realpathSync(homedir())`.
2. THE Shim SHALL NOT inspect the Walk_Ceiling directory for markers.
3. THE Shim SHALL NOT inspect any directory at or above the Walk_Ceiling.
4. WHEN the resolved cwd equals the Walk_Ceiling, THE Shim SHALL skip the walk entirely and treat the event as a Global_Event (Requirement 3).
5. WHEN the resolved cwd is not under the Walk_Ceiling (e.g. `/tmp`, `/private/var`), THE Shim SHALL skip the walk entirely and treat the event as a Global_Event (Requirement 3). The shim does not fail; every event must still produce a valid namespace.
6. THE walk-ceiling behaviour SHALL match the installer's `detectScope` ceiling behaviour (installer `src/installer/index.ts` — walk stops *before* `$HOME`). *(testable as a property — for every cwd under `$HOME`, the derived Project_Root is also at or under `$HOME`.)*

### Requirement 3: Shim — Global Sentinel Fallback

**User Story:** As a kiro-learn user running kiro-cli outside any project (e.g. directly in `$HOME`, or in an ad-hoc scratch directory), I want all such sessions to share a single "global" namespace rather than fragmenting into a different namespace per directory.

#### Acceptance Criteria

1. WHEN the marker walk completes without finding a Project_Marker, THE Shim SHALL set Project_Root to the Walk_Ceiling (the resolved `$HOME`).
2. WHEN the event is a Global_Event, THE Shim SHALL compute `project_id` as `SHA-256(Walk_Ceiling)` so every Global_Event from a given user shares one `project_id`.
3. WHEN the event is a Global_Event, THE Shim SHALL set `source.project_path` to the Walk_Ceiling.
4. THE Shim SHALL NOT introduce any schema change to represent Global_Events. The namespace remains `/actor/<actor_id>/project/<project_id>/` with no structural difference from project events. *(Preserves backward compatibility of the existing namespace shape — see Glossary / Requirement 5.)*

### Requirement 4: Shim — Hash Input Change

**User Story:** As a kiro-learn user, I want `project_id` to be computed from the resolved Project_Root rather than from cwd, so running kiro-cli from any subdirectory of a project produces the same `project_id`.

#### Acceptance Criteria

1. THE Shim SHALL compute `project_id` as the hex-encoded SHA-256 of `realpathSync(Project_Root)` (lowercase hex, 64 chars).
2. THE Shim SHALL construct `namespace` as `/actor/<actor_id>/project/<project_id>/` with a trailing slash, unchanged from today's format.
3. WHEN two invocations of the shim run from two different subdirectories that resolve to the same Project_Root, THE resulting `project_id` values SHALL be equal. *(testable as a property — for any project root `R` under `$HOME` containing a marker, and any cwd `C` such that the walk from `C` resolves to `R`, `project_id(C) == project_id(R)`.)*
4. WHEN the shim is invoked twice from the same cwd under the same filesystem state, THE resulting `project_id` values SHALL be equal. *(Idempotence; testable as a property.)*
5. THE new hash input SHALL replace the existing hash input in `buildEvent`. No feature flag or dual-write mode is introduced.

### Requirement 5: Event Schema — `source.project_path` Field

**User Story:** As a downstream consumer (read API, visualizer), I want the preimage of `project_id` persisted alongside every new event so I can display a human-readable project name without maintaining a separate `project_id → path` mapping.

#### Acceptance Criteria

1. THE `EventSourceSchema` in `src/types/schemas.ts` SHALL add an OPTIONAL field `project_path` of type `string`.
2. THE `project_path` field SHALL be constrained to a minimum length of 1 and a maximum length of 2048 characters when present.
3. THE `schema_version` literal SHALL remain `1`. Adding an optional field is an additive change and does not bump the schema version.
4. WHEN an event is parsed via `parseEvent` and `source.project_path` is absent, THE parser SHALL accept the event. (Backward compatibility with older shims and with events already in storage.)
5. WHEN an event is parsed via `parseEvent` and `source.project_path` is present, THE parser SHALL validate the length bounds and reject values outside the range.
6. THE validator SHALL NOT require `project_path` to match any structural pattern (no regex for absolute path / no enforcement that it starts with `$HOME`). The field is a carrier, not a constraint.

### Requirement 6: Shim — Populate `source.project_path`

**User Story:** As a kiro-learn user, I want every event the updated shim emits to carry the resolved Project_Root as `source.project_path`, so downstream storage and APIs never have to reverse-engineer the hash.

#### Acceptance Criteria

1. WHEN the shim builds an event via `buildEvent`, THE Shim SHALL set `source.project_path` to the same resolved Project_Root path used as the hash input for `project_id`.
2. WHEN the event is a Global_Event, THE Shim SHALL set `source.project_path` to the Walk_Ceiling (per Requirement 3.3).
3. THE Shim SHALL NOT apply any transformation to `project_path` beyond the `realpathSync` call used to resolve it. (No `$HOME/` stripping, no normalisation beyond `realpath`, no case-folding.)
4. THE `project_path` value emitted by the shim SHALL always be an absolute path. *(Consequence of `realpathSync`; testable as a property.)*

### Requirement 7: Shim — Error Handling During Walk

**User Story:** As a kiro-learn user, I want the shim to remain harmless in the face of filesystem errors during project-root detection, so the "exits 0 always" invariant is preserved.

#### Acceptance Criteria

1. IF `realpathSync` on cwd throws (e.g. cwd deleted between process start and walk), THE Shim SHALL fall back to hashing the raw cwd string and SHALL set `source.project_path` to the raw cwd string.
2. IF `realpathSync` on `homedir()` throws, THE Shim SHALL fall back to hashing the unresolved `homedir()` value and SHALL set the Walk_Ceiling to the unresolved `homedir()` value.
3. IF a filesystem error occurs while checking for a marker in a directory during the walk (e.g. permission denied on an ancestor directory), THE Shim SHALL treat that directory as containing no marker and continue the walk upward.
4. IF the walk itself throws an unexpected error, THE Shim SHALL fall back to the current behaviour (hashing the resolved cwd) so event construction cannot fail because of project-root detection.
5. THE Shim SHALL log a `[kiro-learn]` stderr warning for fallback cases 7.1, 7.2, and 7.4, and SHALL NOT log for case 7.3 (marker-check failures during an otherwise successful walk are expected and silent).
6. THE Shim SHALL never throw from `buildEvent` as a result of project-root detection errors. The "exits 0 always" contract from the shim spec (Requirement 7 there) remains intact.

### Requirement 8: Storage — Migration `0003_project_path`

**User Story:** As an operator, I want the `events` table to carry `project_path` as a first-class column so downstream aggregations (e.g. project-list queries) can group by namespace and return the display path without parsing `source_json`.

#### Acceptance Criteria

1. THE storage layer SHALL add a new migration file `src/collector/storage/sqlite/migrations/0003_project_path.ts`.
2. THE migration's `up` SHALL add a column `project_path TEXT` to the `events` table. The column SHALL be NULLABLE and SHALL have no `DEFAULT` clause.
3. THE migration SHALL add an index named `idx_events_namespace_project_path` on `(namespace, project_path)` supporting namespace-grouped aggregation of distinct `project_path` values.
4. THE migration SHALL be registered in `src/collector/storage/sqlite/migrations/index.ts` with `version: 3` and `name: '0003_project_path'`, appended after `0002_xml_extraction_fields`.
5. WHEN the migration is applied to a database that already contains events (from schema versions 0001 or 0002), THE existing rows SHALL remain valid with `project_path` NULL. No backfill is performed.
6. WHEN the migration is applied twice (e.g. by running migrations against a database that already recorded version 3), THE second run SHALL be a no-op. *(Inherits existing migration-runner idempotency — Requirement 9.2 of event-schema-and-storage; verified by example test.)*
7. THE migration runner SHALL raise `MigrationDriftError` if `_migrations` contains a row for version 3 whose `name` differs from `'0003_project_path'`. (Inherited from existing runner; no new behaviour required.)

### Requirement 9: Storage — Extract `project_path` on Insert

**User Story:** As a storage layer author, I want `project_path` written into its dedicated column at insert time, so aggregations don't have to parse `source_json`.

#### Acceptance Criteria

1. THE SQLite backend's `insertEvent` prepared statement SHALL bind `project_path` as an additional positional parameter. Column order and parameter tuple SHALL both be updated.
2. WHEN `putEvent(e)` is called and `e.source.project_path` is a string, THE backend SHALL bind that string to the `project_path` column.
3. WHEN `putEvent(e)` is called and `e.source.project_path` is undefined, THE backend SHALL bind `NULL` to the `project_path` column.
4. THE `source_json` column SHALL continue to store the full serialised `source` object, including `project_path` when present. The new column is a denormalised projection, not a replacement. *(Round-trip correctness relies on `source_json`; the new column exists for indexing.)*
5. WHEN an event is fetched via `getEventById`, THE returned object's `source.project_path` SHALL come from the deserialised `source_json` — not from the `project_path` column — so the new column's presence does not affect round-trip equality.
6. THE idempotency contract of `putEvent` (Requirement 6 of event-schema-and-storage) SHALL remain intact. A retry with the same `event_id` SHALL NOT rewrite the `project_path` column. (Consequence of `INSERT OR IGNORE`.)

### Requirement 10: Round-Trip Integrity for `project_path`

**User Story:** As a future read-API author, I want `getEventById` to return an event whose `source.project_path` is byte-identical to what the shim emitted, so display-name logic can trust the preimage.

#### Acceptance Criteria

1. WHEN `putEvent(e)` is called for an event with `e.source.project_path` present and valid, THE subsequent `getEventById(e.event_id)` SHALL return an event whose `source.project_path` equals the input's `source.project_path`. *(testable as a property.)*
2. WHEN `putEvent(e)` is called for an event with `e.source.project_path` absent, THE subsequent `getEventById(e.event_id)` SHALL return an event whose `source.project_path` is absent (the key is not present on the returned object under `exactOptionalPropertyTypes`). *(testable as a property.)*
3. THE round-trip property SHALL hold for every valid `project_path` value the validator accepts (any 1–2048 char string).

### Requirement 11: Backward Compatibility

**User Story:** As a kiro-learn operator upgrading from a prior release, I want old events already in my database to remain valid and readable, and I want older shims to continue working against an updated collector.

#### Acceptance Criteria

1. THE updated `EventSourceSchema` SHALL accept events emitted by shim releases that do not include `project_path`. (Field is optional — Requirement 5.1.)
2. THE updated collector SHALL accept `POST /v1/events` bodies from older shims without `source.project_path` and SHALL persist them with `events.project_path = NULL`.
3. THE updated read path (`getEventById`) SHALL return events from rows whose `project_path` column is `NULL` without materialising a `project_path` key on `source`.
4. THE updated shim SHALL NOT require a collector that has applied Migration_0003. If the updated shim runs against a pre-0003 collector, the collector's existing behaviour (ignoring unknown source fields when serialising `source_json`) SHALL preserve correctness — `source.project_path` round-trips through `source_json` regardless of whether the column exists. *(Stretch guarantee; the intended deployment order is collector first, then shim, but this is not enforced.)*
5. THE `schema_version` literal SHALL remain `1`. No schema bump is introduced by this spec.

### Requirement 12: Pipeline and Receiver — Pass-Through Behaviour

**User Story:** As a pipeline author, I want to be certain that `project_path` passes through the pipeline unchanged and is not subject to privacy scrubbing, so the shim's emitted value is what storage persists.

#### Acceptance Criteria

1. THE pipeline's privacy scrub stage SHALL continue to operate on `event.body` only. `event.source` SHALL NOT be scrubbed. *(Unchanged contract — restated for testability against a future regression.)*
2. THE pipeline's dedup stage SHALL NOT consider `source.project_path` in its hash/key. Dedup remains keyed on `event_id` alone.
3. THE receiver (`POST /v1/events`) SHALL accept events whose `source.project_path` is present or absent without special handling beyond Zod validation.
4. NO pipeline stage SHALL rewrite, truncate, or strip `source.project_path`. What the shim emits is what storage receives.
5. THE pipeline's body-size check (1 MiB serialized body cap) SHALL NOT include `source` in its calculation. *(Unchanged — the cap is on `body`, not the whole event.)*

## Non-functional Requirements

### Performance

- **N1.** THE marker walk SHALL complete in under 5 ms on commodity developer hardware for any cwd under `$HOME` with depth ≤ 20. (The walk performs at most 15 `existsSync` calls per directory × depth; sub-millisecond per directory is realistic.)
- **N2.** Adding `project_path` binding to `putEvent` SHALL NOT regress the 95th-percentile `putEvent` latency (< 5 ms, inherited from event-schema-and-storage N1).
- **N3.** The new `idx_events_namespace_project_path` index SHALL NOT regress `putEvent` 95th-percentile latency beyond the baseline. SQLite index maintenance on a two-column index is expected to be sub-millisecond.

### Reliability

- **N4.** THE Shim SHALL never block or throw as a result of project-root detection errors (Requirement 7). The "exits 0 always" contract from the shim spec remains intact.
- **N5.** Migration `0003_project_path` SHALL be transactional. If the ALTER TABLE or CREATE INDEX fails, the migration runner SHALL roll back and leave the database at schema version 2. (Inherited from existing migration runner; no new behaviour required.)

### Security and Privacy

- **N6.** THE shim SHALL NOT log `source.project_path` to stderr under normal operation. (Project paths are not secrets, but unnecessary logging is avoided per the existing shim observability convention — shim Requirement N8.) Warning logs for the three fallback cases in Requirement 7 SHALL NOT include the path value.
- **N7.** THE storage layer SHALL NOT treat `project_path` as sensitive for encryption-at-rest purposes — v1 single-user local SQLite's existing `0700` directory permissions remain the only boundary. Future multi-tenant deployments (v3+) will reconsider.
- **N8.** THE pipeline's privacy scrub SHALL continue to operate on `event.body` only. `source.project_path` is not subject to `<private>...</private>` processing. *(Explicit re-statement of existing scope — see Requirement 12.1 and the guard test `test/unit/no-private-scrub.test.ts`.)*

### Modularity

- **N9.** THE shim's project-root detection SHALL live under `src/shim/shared/` (colocated with `buildEvent`). The shim SHALL NOT import from `src/installer/`. Code duplication with the installer's `detectScope` is acceptable for v1; a shared utility can be introduced in a later refactor spec.
- **N10.** THE existing modularity guard tests SHALL continue to pass unchanged. In particular, `src/shim/` continues not to import from `src/collector/` or `src/installer/`, and `src/collector/storage/` continues not to contain the string `<private>`.

### Testability

- **N11.** THE repository SHALL include property-based tests for the invariants called out in Requirements 1.5, 2.6, 4.3, 4.4, 6.4, 10.1, and 10.2. These tests SHALL use `fast-check` and SHALL live under `test/unit/` following the existing `*.property.test.ts` naming convention.
- **N12.** THE repository SHALL include example-based tests for Migration_0003: fresh-database application, idempotent re-application, and application against a database seeded with schema-version-2 rows.
- **N13.** THE `test/helpers/arbitrary.ts` generators SHALL be extended to produce `EventSource` values with and without `project_path`, so existing property tests exercise both shapes.

## Out of Scope (explicit)

- Visualizer read API (`GET /v1/stats`, `/v1/projects`, `/v1/memories`, `/v1/events/{id}`, etc.) — handled by the next spec (`visualizer-read-api`).
- Display-name formatting (stripping `$HOME/` prefix for UI presentation) — handled server-side in the read-API spec.
- Retroactive backfill of `events.project_path` for rows written before Migration_0003 — the preimage was not captured, so backfill is impossible. Old rows stay `NULL` permanently.
- Environment-variable or config-file override for `project_path` — auto-detection only in v1.
- Refactoring the installer's `detectScope` and the shim's new marker walk into a shared utility — deliberate short-term duplication; address later if both diverge.
- `MemoryRecord` schema additions — memory records already carry `namespace`, and project aggregation happens on the `events` table. No change to memory records.
- Hash-scheme migration tooling — events written under the old `SHA-256(realpath(cwd))` scheme become "orphans" under the new scheme. Accepted cost; kiro-learn's existing corpus is small and a fresh start is fine.
- Bump of `schema_version` — this spec is strictly additive and keeps the literal at `1`.
- New modularity boundaries or guard tests beyond N10 — existing guards remain sufficient.
