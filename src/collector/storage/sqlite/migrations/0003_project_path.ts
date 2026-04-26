/**
 * Migration 0003 — project path capture.
 *
 * Adds a single nullable column to `events`, plus a compound index that
 * supports namespace-grouped aggregation of distinct `project_path`
 * values (future project-list / visualizer queries).
 *
 * - `project_path` — TEXT, NULLABLE, no DEFAULT. Stores the resolved
 *                    Project_Root path the shim hashed to derive
 *                    `project_id`. Written by the collector's insert
 *                    path from `event.source.project_path`.
 *
 * Design notes:
 *
 * - The column is deliberately nullable with no DEFAULT. Rows inserted
 *   under migrations 0001 and 0002 genuinely did not carry this value —
 *   the preimage wasn't captured by the old shim — so NULL is the
 *   truthful representation for legacy rows. A synthetic DEFAULT (`''`
 *   or similar) would misrepresent them. No backfill is performed.
 * - The read path (`getEventById`) deliberately does NOT read from this
 *   column. `source.project_path` round-trips via the existing
 *   `source_json` column so legacy rows (whose `source_json` has no
 *   `project_path` key) continue to deserialise cleanly under
 *   `exactOptionalPropertyTypes`. This column exists purely as a
 *   denormalised projection for indexed aggregation.
 * - The compound `(namespace, project_path)` index matches the access
 *   pattern of "list distinct projects within a namespace". Index
 *   maintenance on a two-column nullable index is sub-millisecond and
 *   does not regress the `putEvent` latency target.
 * - `CREATE INDEX IF NOT EXISTS` makes the index creation idempotent
 *   independently of the migration-runner bookkeeping; the runner's
 *   own idempotency (skipping already-applied versions) is the
 *   primary guard, but the `IF NOT EXISTS` clause is belt-and-braces.
 * - `ALTER TABLE ... ADD COLUMN` on SQLite is an O(1) metadata
 *   operation — existing rows are not rewritten. Index creation scans
 *   the `events` table once.
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5
 */

import type { Migration } from './types.js';

export const DDL = `
ALTER TABLE events ADD COLUMN project_path TEXT;

CREATE INDEX IF NOT EXISTS idx_events_namespace_project_path
  ON events (namespace, project_path);
`;

export const migration0003: Migration = {
  version: 3,
  name: '0003_project_path',
  up: (db) => db.exec(DDL),
};
