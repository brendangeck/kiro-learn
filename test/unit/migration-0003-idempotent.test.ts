import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MIGRATIONS,
  runMigrations,
} from '../../src/collector/storage/sqlite/migrations/index.js';

/**
 * Migration idempotent re-apply.
 *
 * Task 5.4 in `.kiro/specs/project-path-capture/tasks.md`:
 *
 *   > Open a DB, run all migrations, snapshot `sqlite_schema` +
 *   > `_migrations`. Run migrations again. Assert the snapshots are
 *   > byte-equal and no error is thrown.
 *
 * This is an example-level counterpart to the property-based idempotency
 * check in `migrations.idempotency.property.test.ts` (which covers
 * arbitrary prefixes of `MIGRATIONS`). Here we pin the full canonical
 * migration list (currently 4 migrations, head version 4) once — so that
 * a regression surfaces from a named, file-scoped test even if
 * fast-check's universe is ever narrowed.
 *
 * The contract under test: re-invoking `runMigrations` against a database
 * already at the current head must be a complete no-op at both the schema
 * level (`sqlite_master`) and the bookkeeping level (`_migrations`).
 * Including `applied_at` in the `_migrations` snapshot sharpens the test
 * — the runner stamps it with `new Date().toISOString()` on every insert,
 * so any accidental re-insertion (or spurious `UPDATE`) on the second
 * invocation would show up as a timestamp drift.
 *
 * Validates: Requirement 8.6
 */

/**
 * Row shape returned by the `sqlite_master` snapshot query. Includes every
 * field that drives schema identity: the object's `name`, its `type`
 * (`table` / `index` / `trigger` / …), and its reconstructed `sql`.
 * Auto-generated entries (e.g. SQLite-internal FTS5 shadow objects) have
 * `sql = null`; preserving the column keeps those rows in the snapshot
 * too.
 */
interface SchemaRow {
  name: string;
  type: string;
  sql: string | null;
}

/**
 * Row shape returned by the `_migrations` snapshot query. `applied_at` is
 * included deliberately so that a regression which re-inserts (or touches)
 * the bookkeeping row for an already-applied migration manifests as a
 * timestamp mismatch between the two snapshots.
 */
interface MigrationRow {
  version: number;
  name: string;
  applied_at: string;
}

describe('migration idempotent re-apply — full MIGRATIONS list', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('leaves sqlite_master and _migrations byte-identical on a second invocation (Requirement 8.6)', () => {
    // First invocation: bring the DB up to the current head (version 4).
    runMigrations(db, MIGRATIONS);

    const schemaAfterFirst = db
      .prepare<[], SchemaRow>(
        'SELECT name, type, sql FROM sqlite_master ORDER BY type, name',
      )
      .all();
    const migrationsAfterFirst = db
      .prepare<[], MigrationRow>(
        'SELECT version, name, applied_at FROM _migrations ORDER BY version',
      )
      .all();

    // Sanity-check the precondition: the first run must have recorded all
    // four migrations. Without this, the "no-op on second invocation"
    // check below would hold vacuously on, say, a broken runner that
    // silently skipped migrations.
    expect(migrationsAfterFirst.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    expect(migrationsAfterFirst.map((r) => r.name)).toEqual([
      '0001_init',
      '0002_xml_extraction_fields',
      '0003_project_path',
      '0004_session_summary_type',
    ]);

    // Second invocation: must be a complete no-op. Not throwing is part
    // of the contract, so we do not wrap this in `expect(...).not.toThrow`
    // — an unexpected throw would fail the test by propagation, which is
    // what we want.
    runMigrations(db, MIGRATIONS);

    const schemaAfterSecond = db
      .prepare<[], SchemaRow>(
        'SELECT name, type, sql FROM sqlite_master ORDER BY type, name',
      )
      .all();
    const migrationsAfterSecond = db
      .prepare<[], MigrationRow>(
        'SELECT version, name, applied_at FROM _migrations ORDER BY version',
      )
      .all();

    // Byte-equal snapshots at both layers.
    expect(schemaAfterSecond).toEqual(schemaAfterFirst);
    expect(migrationsAfterSecond).toEqual(migrationsAfterFirst);
  });
});
