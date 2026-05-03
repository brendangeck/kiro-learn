/**
 * Aggregation point for the SQLite migration stack.
 *
 * This module is the single import site the rest of the codebase uses to
 * bring up the on-disk schema: `openSqliteStorage` (and its tests) call
 * `runMigrations(db, MIGRATIONS)` to apply every pending DDL migration in
 * order. Individual migration modules (`./0001_init.ts`, future `0002_*`,
 * …) are private implementation details that flow into callers only via
 * {@link MIGRATIONS}.
 *
 * The ordering contract is strict: versions are monotonically increasing,
 * new migrations are *appended* to the list, and previously-released
 * migrations are never reordered, renamed, or rewritten. Renaming or
 * reordering an already-applied migration trips the
 * {@link MigrationDriftError} check in the runner, because that is
 * indistinguishable from a corrupted history at DB-open time.
 *
 * Also re-exports the runner entry point and the types/errors every caller
 * of `runMigrations` needs, so downstream modules can import the full
 * migration surface from a single path.
 *
 * @see Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 * @module
 */

import { migration0001 } from './0001_init.js';
import { migration0002 } from './0002_xml_extraction_fields.js';
import { migration0003 } from './0003_project_path.js';
import { migration0004 } from './0004_session_summary_type.js';
import { migration0005 } from './0005_memory_record_embedding.js';
import type { Migration } from './types.js';

export { runMigrations } from './runner.js';
export { MigrationDriftError } from './types.js';
export type { Migration } from './types.js';

/**
 * The ordered list of SQLite migrations applied by
 * {@link runMigrations}. Strictly ascending by `version` with no gaps or
 * duplicates.
 *
 * **Append-only.** New migrations are added at the end with the next
 * integer version; released migrations are never reordered, renamed, or
 * edited in place. The runner treats any mismatch between a recorded
 * `(version, name)` in `_migrations` and this list as
 * {@link MigrationDriftError}.
 *
 * @see Requirements 5.1, 5.5
 */
export const MIGRATIONS: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
];
