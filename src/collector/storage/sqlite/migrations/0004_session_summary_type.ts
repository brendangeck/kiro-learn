/**
 * Migration 0004 — widen observation_type CHECK constraint.
 *
 * Adds `'session_summary'` to the allowed values for the
 * `observation_type` column on `memory_records`. The MCP
 * `save_session_summary` tool stores records with this type.
 *
 * SQLite does not support `ALTER TABLE ... ALTER COLUMN` or modifying a
 * CHECK constraint in place. The standard workaround is the 12-step
 * table-rebuild procedure recommended by the SQLite documentation:
 *
 *   1. Create a new table with the updated schema.
 *   2. Copy all rows from the old table.
 *   3. Drop the old table.
 *   4. Rename the new table to the original name.
 *
 * The FTS5 virtual table (`memory_records_fts`) is left untouched — it
 * has no CHECK constraint and does not store `observation_type`.
 *
 * Validates: Requirements 5.1 (save_session_summary needs this observation type)
 */

import type { Migration } from './types.js';

export const DDL = `
-- 1. Create replacement table with the widened CHECK constraint.
CREATE TABLE memory_records_new (
  record_id          TEXT PRIMARY KEY NOT NULL,
  namespace          TEXT NOT NULL,
  strategy           TEXT NOT NULL,
  title              TEXT NOT NULL,
  summary            TEXT NOT NULL,
  facts_json         TEXT NOT NULL DEFAULT '[]',
  source_event_ids_json TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  concepts_json      TEXT NOT NULL DEFAULT '[]',
  files_touched_json TEXT NOT NULL DEFAULT '[]',
  observation_type   TEXT NOT NULL DEFAULT 'tool_use'
    CHECK (observation_type IN ('tool_use','decision','error','discovery','pattern','session_summary'))
) STRICT;

-- 2. Copy all existing rows.
INSERT INTO memory_records_new
  SELECT record_id, namespace, strategy, title, summary,
         facts_json, source_event_ids_json, created_at,
         concepts_json, files_touched_json, observation_type
  FROM memory_records;

-- 3. Drop the old table (also drops idx_memory_records_namespace).
DROP TABLE memory_records;

-- 4. Rename the new table to the original name.
ALTER TABLE memory_records_new RENAME TO memory_records;

-- 5. Recreate the namespace index dropped with the old table.
CREATE INDEX IF NOT EXISTS idx_memory_records_namespace
  ON memory_records (namespace);
`;

export const migration0004: Migration = {
  version: 4,
  name: '0004_session_summary_type',
  up: (db) => db.exec(DDL),
};
