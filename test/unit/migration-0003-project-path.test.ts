import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migration0001 } from '../../src/collector/storage/sqlite/migrations/0001_init.js';
import { migration0002 } from '../../src/collector/storage/sqlite/migrations/0002_xml_extraction_fields.js';
import {
  MIGRATIONS,
  MigrationDriftError,
  runMigrations,
} from '../../src/collector/storage/sqlite/migrations/index.js';

/**
 * Migration 0003 unit tests.
 *
 * Three scenarios are covered here, all from Task 5.3 in
 * `.kiro/specs/project-path-capture/tasks.md`:
 *
 *   1. Fresh-database apply — running the full `MIGRATIONS` list against
 *      a clean `:memory:` DB produces the `project_path` column (TEXT,
 *      nullable, no DEFAULT), the compound
 *      `idx_events_namespace_project_path` index, and a row in
 *      `_migrations` for `(3, '0003_project_path')`.
 *   2. Legacy-row preservation — applying migrations 1 and 2 first,
 *      inserting an event row that predates this spec, then applying
 *      the full `MIGRATIONS` list leaves the legacy row intact with
 *      `project_path IS NULL`. No backfill happens.
 *   3. Drift detection — if the recorded name for version 3 in
 *      `_migrations` diverges from `'0003_project_path'`, re-running
 *      `runMigrations` refuses to proceed and throws
 *      `MigrationDriftError`. This is inherited behaviour from the
 *      runner, re-asserted here so a future drift in migration 0003
 *      is still caught at the migration-file boundary.
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.5, 8.7
 */
describe('migration 0003 — project_path column', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('adds a nullable TEXT project_path column and its compound index on fresh apply (Requirements 8.1, 8.2, 8.3)', () => {
    // Fresh DB, full migration list — what a first-time user gets.
    runMigrations(db, MIGRATIONS);

    // `PRAGMA table_info(events)` returns one row per column. We assert on
    // the project_path row specifically: type must be TEXT, `notnull` must
    // be 0 (nullable), and `dflt_value` must be null (no DEFAULT clause).
    // The migration deliberately omits a DEFAULT so legacy rows read NULL
    // rather than a synthetic placeholder — see 0003 TSDoc.
    const columns = db
      .prepare<
        [],
        {
          cid: number;
          name: string;
          type: string;
          notnull: number;
          dflt_value: string | null;
          pk: number;
        }
      >('PRAGMA table_info(events)')
      .all();

    const projectPathCol = columns.find((c) => c.name === 'project_path');
    expect(projectPathCol).toBeDefined();
    expect(projectPathCol?.type).toBe('TEXT');
    expect(projectPathCol?.notnull).toBe(0);
    expect(projectPathCol?.dflt_value).toBeNull();

    // The compound index supports namespace-grouped aggregation of
    // distinct project_path values (future project-list queries).
    const indexRow = db
      .prepare<[], { name: string; tbl_name: string }>(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_namespace_project_path'",
      )
      .get();
    expect(indexRow).toBeDefined();
    expect(indexRow?.tbl_name).toBe('events');

    // Bookkeeping: exactly one row for (3, '0003_project_path') in
    // `_migrations`. The runner is the only writer here, so any drift
    // between this row and the code-embedded migration would be a runner
    // bug.
    const migrationRow = db
      .prepare<[number], { version: number; name: string }>(
        'SELECT version, name FROM _migrations WHERE version = ?',
      )
      .get(3);
    expect(migrationRow).toEqual({ version: 3, name: '0003_project_path' });
  });

  it('preserves pre-0003 rows with project_path IS NULL when 0003 is applied later (Requirement 8.5)', () => {
    // Phase 1: apply migrations 1 and 2 only, simulating a DB that was
    // opened by a pre-0003 version of kiro-learn.
    runMigrations(db, [migration0001, migration0002]);

    // Phase 2: insert a legacy event row the same way the pre-0003
    // storage layer would have. We bypass `putEvent` here because we
    // want to assert on the raw column values after 0003 applies —
    // wiring through the prepared-statements module would couple this
    // test to the insert-path changes in Task 6 that haven't landed yet.
    // Migration 0002 only touched `memory_records`; the `events` table
    // still has the column set declared by 0001 at this point.
    const legacyInsert = db.prepare<[
      string, // event_id
      string | null, // parent_event_id
      string, // session_id
      string, // actor_id
      string, // namespace
      number, // schema_version
      string, // kind
      string, // body_json
      string, // valid_time
      string, // transaction_time
      string, // source_json
      string | null, // content_hash
    ]>(
      `INSERT INTO events (
         event_id, parent_event_id, session_id, actor_id,
         namespace, schema_version, kind, body_json,
         valid_time, transaction_time, source_json, content_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const legacyEventId = '01HZX000000000000000000001';
    const legacySource = JSON.stringify({
      surface: 'kiro-cli',
      version: '0.1.0',
      client_id: 'legacy-host',
    });
    legacyInsert.run(
      legacyEventId,
      null,
      'legacy-session',
      'legacy-actor',
      '/actor/alice/project/abc/',
      1,
      'prompt',
      JSON.stringify({ type: 'text', text: 'hello' }),
      '2024-01-01T00:00:00.000+00:00',
      '2024-01-01T00:00:00.000Z',
      legacySource,
      null,
    );

    // Sanity check: the row is present and the column we're about to
    // test doesn't exist yet.
    const preColumns = db
      .prepare<[], { name: string }>('PRAGMA table_info(events)')
      .all();
    expect(preColumns.some((c) => c.name === 'project_path')).toBe(false);

    // Phase 3: apply the full migration list. Migration 0003 should add
    // the column and leave the legacy row untouched.
    runMigrations(db, MIGRATIONS);

    const preservedRow = db
      .prepare<
        [string],
        {
          event_id: string;
          namespace: string;
          project_path: string | null;
          source_json: string;
        }
      >(
        'SELECT event_id, namespace, project_path, source_json FROM events WHERE event_id = ?',
      )
      .get(legacyEventId);

    expect(preservedRow).toBeDefined();
    expect(preservedRow?.event_id).toBe(legacyEventId);
    expect(preservedRow?.namespace).toBe('/actor/alice/project/abc/');
    // The critical assertion: no backfill. The legacy row keeps a NULL
    // project_path because the old shim never captured the preimage.
    expect(preservedRow?.project_path).toBeNull();
    // source_json is unchanged too — a legacy row has no project_path
    // key inside its serialised source either.
    expect(preservedRow?.source_json).toBe(legacySource);
  });

  it('throws MigrationDriftError when _migrations records a wrong name for version 3 (Requirement 8.7)', () => {
    // Apply the canonical list to get a clean version-3 DB.
    runMigrations(db, MIGRATIONS);

    // Tamper with the recorded name for version 3 in `_migrations`. A
    // real-world analogue is someone renaming `0003_project_path.ts`
    // (and its `.name` field) after the migration has already been
    // applied to a developer's DB.
    db.prepare('UPDATE _migrations SET name = ? WHERE version = ?').run(
      'wrong_name',
      3,
    );

    // Re-running migrations must refuse to proceed. The drift check
    // compares each applied (version, name) against the code-embedded
    // migration of the same version, so the mismatch at version 3
    // alone is enough to trip the guard.
    expect(() => runMigrations(db, MIGRATIONS)).toThrow(MigrationDriftError);

    // And the message should name both identifiers so an operator can
    // see exactly what drifted. Assert on fragments rather than the
    // full string so the test is robust to wording tweaks.
    expect(() => runMigrations(db, MIGRATIONS)).toThrow(/wrong_name/);
    expect(() => runMigrations(db, MIGRATIONS)).toThrow(/0003_project_path/);
  });
});
