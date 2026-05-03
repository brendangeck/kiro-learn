import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migration0001 } from '../../src/collector/storage/sqlite/migrations/0001_init.js';
import { migration0002 } from '../../src/collector/storage/sqlite/migrations/0002_xml_extraction_fields.js';
import { migration0003 } from '../../src/collector/storage/sqlite/migrations/0003_project_path.js';
import { migration0004 } from '../../src/collector/storage/sqlite/migrations/0004_session_summary_type.js';
import { migration0005 } from '../../src/collector/storage/sqlite/migrations/0005_memory_record_embedding.js';
import {
  MIGRATIONS,
  runMigrations,
} from '../../src/collector/storage/sqlite/migrations/index.js';

/**
 * Migration 0005 unit tests.
 *
 * Task 1.5 in `.kiro/specs/local-embeddings-and-hybrid-search/tasks.md`:
 *
 *   > Test migration adds `embedding` column with type BLOB and DEFAULT NULL
 *   > Test migration does not rewrite pre-existing rows (insert a row at
 *   > schema v4 fixture, apply 0005, assert same rowid and same other
 *   > column values, `embedding` reads as null)
 *   > Test migration is additive: idempotent re-run is blocked by the
 *   > migrations runner version tracking
 *
 * The three scenarios align one-to-one with the bullets above:
 *
 *   1. Fresh-database apply — running the full `MIGRATIONS` list against
 *      a clean `:memory:` DB produces the `embedding` column on
 *      `memory_records` with type `BLOB`, nullable, and either a
 *      literal `NULL` default or no default at all. `PRAGMA
 *      table_info` is the canonical inspection surface.
 *   2. Legacy-row preservation — apply migrations 0001..0004 first,
 *      insert a memory_record that predates this spec, then apply
 *      0005 on its own. The row's `rowid` and every other column must
 *      be unchanged, and the new `embedding` column must read as
 *      SQL `NULL`. This verifies the O(1) `ALTER TABLE ... ADD COLUMN`
 *      promise in the migration's TSDoc.
 *   3. Idempotent re-apply — running `runMigrations(db, MIGRATIONS)`
 *      twice in succession must leave `_migrations` with exactly one
 *      row per migration (no duplicates), confirming that the runner's
 *      version tracking blocks a re-apply of 0005.
 *
 * Validates: Requirements 4.5, 4.6, 8.3
 */

/**
 * Row shape returned by `PRAGMA table_info(memory_records)`.
 */
interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

describe('migration 0005 — memory_records.embedding column', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('adds a nullable BLOB embedding column with DEFAULT NULL on fresh apply (Requirements 4.5, 4.6)', () => {
    // Fresh DB, full migration list — what a first-time user gets.
    runMigrations(db, MIGRATIONS);

    // `PRAGMA table_info(memory_records)` returns one row per column.
    // We assert on the `embedding` row specifically: type must be BLOB,
    // `notnull` must be 0 (nullable), and `dflt_value` must represent
    // SQL NULL. SQLite is permissive about how `DEFAULT NULL` is
    // reported — some versions surface the literal string `'NULL'` in
    // `dflt_value`, others return JS `null` to mean "no DEFAULT was
    // recorded". Both are acceptable for this migration: functionally
    // an omitted DEFAULT on a nullable column yields NULL on read.
    const columns = db
      .prepare<[], TableInfoRow>('PRAGMA table_info(memory_records)')
      .all();

    const embeddingCol = columns.find((c) => c.name === 'embedding');
    expect(embeddingCol).toBeDefined();
    expect(embeddingCol?.type).toBe('BLOB');
    expect(embeddingCol?.notnull).toBe(0);
    // Accept either the literal string 'NULL' (from the explicit
    // `DEFAULT NULL` clause) or JS `null` (no recorded default).
    const dflt = embeddingCol?.dflt_value;
    expect(dflt === null || dflt === 'NULL').toBe(true);

    // Bookkeeping: exactly one row for (5, '0005_memory_record_embedding')
    // in `_migrations`. The runner is the only writer here.
    const migrationRow = db
      .prepare<[number], { version: number; name: string }>(
        'SELECT version, name FROM _migrations WHERE version = ?',
      )
      .get(5);
    expect(migrationRow).toEqual({
      version: 5,
      name: '0005_memory_record_embedding',
    });
  });

  it('preserves a pre-0005 memory_records row unchanged; embedding reads as null (Requirement 8.3)', () => {
    // Phase 1: apply migrations 1..4 only, simulating a DB that was
    // opened by a pre-0005 version of kiro-learn. Migration 0004
    // rebuilds `memory_records` (the 12-step CHECK-widening workaround)
    // so the schema here is the post-0004 table, which is exactly the
    // fixture 0005 must preserve.
    runMigrations(db, [
      migration0001,
      migration0002,
      migration0003,
      migration0004,
    ]);

    // Phase 2: insert a legacy memory_record the same way the pre-0005
    // storage layer would have. We bypass `putMemoryRecord` here
    // because we want to assert on the raw column values after 0005
    // applies — wiring through the prepared-statements module would
    // couple this test to insert-path changes in a later task.
    const legacyInsert = db.prepare<
      [
        string, // record_id
        string, // namespace
        string, // strategy
        string, // title
        string, // summary
        string, // facts_json
        string, // source_event_ids_json
        string, // created_at
        string, // concepts_json
        string, // files_touched_json
        string, // observation_type
      ]
    >(
      `INSERT INTO memory_records (
         record_id, namespace, strategy, title, summary,
         facts_json, source_event_ids_json, created_at,
         concepts_json, files_touched_json, observation_type
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const legacyRecordId = '01HZX000000000000000000042';
    const legacyNamespace = '/actor/alice/project/abc/';
    const legacyFactsJson = JSON.stringify(['fact one', 'fact two']);
    const legacySourceEventIdsJson = JSON.stringify([
      '01HZX000000000000000000001',
    ]);
    const legacyCreatedAt = '2024-01-01T00:00:00.000Z';
    const legacyConceptsJson = JSON.stringify(['concept-a']);
    const legacyFilesTouchedJson = JSON.stringify(['src/foo.ts']);
    legacyInsert.run(
      legacyRecordId,
      legacyNamespace,
      'xml-extraction',
      'Legacy title',
      'Legacy summary',
      legacyFactsJson,
      legacySourceEventIdsJson,
      legacyCreatedAt,
      legacyConceptsJson,
      legacyFilesTouchedJson,
      'tool_use',
    );

    // Capture the rowid before the migration. `rowid` is SQLite's
    // internal row identifier; preserving it is the sharpest signal
    // that the migration was a metadata-only `ADD COLUMN` and did not
    // rewrite the row under a table rebuild.
    const preRow = db
      .prepare<[string], { rowid: number }>(
        'SELECT rowid FROM memory_records WHERE record_id = ?',
      )
      .get(legacyRecordId);
    expect(preRow).toBeDefined();
    const preRowid = preRow!.rowid;

    // Sanity check: the row is present and the column we're about to
    // test doesn't exist yet.
    const preColumns = db
      .prepare<[], { name: string }>('PRAGMA table_info(memory_records)')
      .all();
    expect(preColumns.some((c) => c.name === 'embedding')).toBe(false);

    // Phase 3: apply migration 0005 on its own. We invoke the `up`
    // directly here — we've already run the prerequisite migrations
    // via `runMigrations` in phase 1, and applying just 0005 isolates
    // the behavioural assertion to this migration alone. The runner's
    // own version-tracking is covered by the idempotency scenario
    // below.
    migration0005.up(db);

    // The column must now exist.
    const postColumns = db
      .prepare<[], TableInfoRow>('PRAGMA table_info(memory_records)')
      .all();
    expect(postColumns.some((c) => c.name === 'embedding')).toBe(true);

    // The preserved row: same rowid, same values in every other
    // column, and `embedding` reads as SQL NULL.
    const preservedRow = db
      .prepare<
        [string],
        {
          rowid: number;
          record_id: string;
          namespace: string;
          strategy: string;
          title: string;
          summary: string;
          facts_json: string;
          source_event_ids_json: string;
          created_at: string;
          concepts_json: string;
          files_touched_json: string;
          observation_type: string;
          embedding: Buffer | null;
        }
      >(
        `SELECT rowid, record_id, namespace, strategy, title, summary,
                facts_json, source_event_ids_json, created_at,
                concepts_json, files_touched_json, observation_type,
                embedding
         FROM memory_records WHERE record_id = ?`,
      )
      .get(legacyRecordId);

    expect(preservedRow).toBeDefined();
    // rowid must be unchanged — `ALTER TABLE ... ADD COLUMN` is an O(1)
    // metadata operation on SQLite and must not rewrite the row.
    expect(preservedRow?.rowid).toBe(preRowid);
    // Every other column value is preserved byte-for-byte.
    expect(preservedRow?.record_id).toBe(legacyRecordId);
    expect(preservedRow?.namespace).toBe(legacyNamespace);
    expect(preservedRow?.strategy).toBe('xml-extraction');
    expect(preservedRow?.title).toBe('Legacy title');
    expect(preservedRow?.summary).toBe('Legacy summary');
    expect(preservedRow?.facts_json).toBe(legacyFactsJson);
    expect(preservedRow?.source_event_ids_json).toBe(legacySourceEventIdsJson);
    expect(preservedRow?.created_at).toBe(legacyCreatedAt);
    expect(preservedRow?.concepts_json).toBe(legacyConceptsJson);
    expect(preservedRow?.files_touched_json).toBe(legacyFilesTouchedJson);
    expect(preservedRow?.observation_type).toBe('tool_use');
    // The critical assertion: no backfill. The legacy row reads NULL
    // for the new `embedding` column because the migration is
    // deliberately additive — Requirement 4.5 is explicit that NULL
    // is the truthful representation for "not yet embedded".
    expect(preservedRow?.embedding).toBeNull();
  });

  it('is blocked from re-apply by the runner version tracking on a second invocation (additive-only guarantee)', () => {
    // First invocation: bring the DB up to head (version 5).
    runMigrations(db, MIGRATIONS);

    // Snapshot `_migrations` immediately after the first run. If the
    // runner's version tracking works, the second invocation must
    // leave this snapshot byte-identical.
    const migrationsAfterFirst = db
      .prepare<
        [],
        { version: number; name: string; applied_at: string }
      >('SELECT version, name, applied_at FROM _migrations ORDER BY version')
      .all();

    // Precondition: first run recorded all five migrations exactly
    // once. Without this check, the no-duplicate assertion below could
    // hold vacuously.
    expect(migrationsAfterFirst.map((r) => r.version)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(migrationsAfterFirst.map((r) => r.name)).toEqual([
      '0001_init',
      '0002_xml_extraction_fields',
      '0003_project_path',
      '0004_session_summary_type',
      '0005_memory_record_embedding',
    ]);

    // Second invocation — this must be a complete no-op. If the
    // runner re-ran 0005's `ALTER TABLE ... ADD COLUMN`, SQLite would
    // throw `duplicate column name: embedding`. The test passing
    // (no throw) is itself part of the contract.
    runMigrations(db, MIGRATIONS);

    const migrationsAfterSecond = db
      .prepare<
        [],
        { version: number; name: string; applied_at: string }
      >('SELECT version, name, applied_at FROM _migrations ORDER BY version')
      .all();

    // Byte-identical `_migrations` snapshots at both layers. The
    // `applied_at` field is included deliberately: the runner stamps
    // it on every insert, so a spurious re-insert or UPDATE on the
    // second invocation would surface as a timestamp drift.
    expect(migrationsAfterSecond).toEqual(migrationsAfterFirst);

    // Explicit count-per-version check: no duplicate rows for version 5.
    const versionFiveCount = db
      .prepare<[], { count: number }>(
        'SELECT COUNT(*) AS count FROM _migrations WHERE version = ?',
      )
      .get(5);
    expect(versionFiveCount?.count).toBe(1);
  });
});
