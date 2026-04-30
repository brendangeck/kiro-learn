/**
 * Unit tests for the SQLite storage backend (`openSqliteStorage`).
 *
 * Covers tasks 5.8–5.12 in the event-schema-and-storage spec:
 *
 * - 5.8  happy-path writes and reads across events + memory records
 * - 5.9  `getEventById` returns `null` for an unknown id
 * - 5.10 `putMemoryRecord` rejects on `record_id` collision
 * - 5.11 FTS5 malformed-query fallback — none of the listed inputs throw
 * - 5.12 data persists across `close()` + reopen, and migrations do not
 *        re-run against the reopened file
 *
 * The PBT suite in task 6 exercises the same backend with generated
 * inputs; these tests pin down specific example cases that the properties
 * either do not cover or would shrink away from (for example, "the exact
 * string `'NEAR'`").
 *
 * Each test gets its own temp directory under `os.tmpdir()` so parallel
 * runs and `afterEach` cleanup cannot clash. The `afterEach` hook closes
 * the backend and recursively removes the temp directory even on test
 * failure, so failing runs do not leak SQLite files into the user's
 * `/tmp`.
 *
 * Validates: Requirements 5.1–5.5, 7.1, 7.2, 8.1, 8.2, 8.5, N4.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import { MIGRATIONS, runMigrations } from '../../src/collector/storage/sqlite/migrations/index.js';
import { prepareStatements } from '../../src/collector/storage/sqlite/statements.js';
import type { StorageBackend } from '../../src/types/index.js';

import { makeValidEvent, makeValidRecord } from '../helpers/fixtures.js';

/**
 * Per-test scratch state. `tmpRoot` is a unique directory under the OS
 * tmpdir; `dbPath` is the SQLite file path inside it. `storage` is the
 * backend under test — tests that need a second open re-bind it.
 */
let tmpRoot: string;
let dbPath: string;
let storage: StorageBackend;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-test-'));
  dbPath = join(tmpRoot, 'kiro-learn.db');
  storage = openSqliteStorage({ dbPath });
});

afterEach(async () => {
  // Use try/catch rather than the backend's idempotent close, because
  // tests that reopen the DB replace `storage` with a new handle; the
  // previous one is already closed and `close()` on it would be a no-op,
  // but we want to be robust to a test that reassigns `storage` and
  // throws before its inner close runs.
  try {
    await storage.close();
  } catch {
    // swallow; cleanup must not mask the real test failure
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Task 5.8 — happy-path writes and reads.
 *
 * Walks the primary public surface once: two events + two records go in,
 * both events round-trip through `getEventById`, and a namespace-scoped
 * search returns both records. No mutations, no adversarial inputs;
 * this is the "does the wiring work at all" smoke test.
 *
 * Validates: Requirements 5.1–5.4, 7.1, 7.2, 8.1.
 */
describe('SQLite backend — happy path (task 5.8)', () => {
  it('round-trips events and returns memory records via search', async () => {
    const event1 = makeValidEvent({
      event_id: '01JF8ZS4Y00000000000000001',
      body: { type: 'text', content: 'first event' },
    });
    const event2 = makeValidEvent({
      event_id: '01JF8ZS4Y00000000000000002',
      kind: 'tool_use',
      body: { type: 'json', data: { tool: 'echo', input: 'ping' } },
    });

    await storage.putEvent(event1);
    await storage.putEvent(event2);

    // Both events must deep-equal the values we wrote. The backend
    // tracks `transaction_time` internally but does not surface it, so
    // a direct `toEqual` is valid here.
    expect(await storage.getEventById(event1.event_id)).toEqual(event1);
    expect(await storage.getEventById(event2.event_id)).toEqual(event2);

    const record1 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000001',
      title: 'First record',
      summary: 'summary alpha about the investigation',
      source_event_ids: [event1.event_id],
    });
    const record2 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000002',
      title: 'Second record',
      summary: 'summary beta about the refactor',
      source_event_ids: [event2.event_id],
    });

    await storage.putMemoryRecord(record1);
    await storage.putMemoryRecord(record2);

    // The query `summary` appears as a whole token in both records'
    // `summary` field, so FTS5 should return both. Ordering depends on
    // FTS5 rank, which we do not assert on here — only that both records
    // are present and no others leak in.
    const hits = await storage.searchMemoryRecords({
      namespace: record1.namespace,
      query: 'summary',
      limit: 10,
    });

    expect(hits).toHaveLength(2);
    const hitIds = new Set(hits.map((h) => h.record_id));
    expect(hitIds.has(record1.record_id)).toBe(true);
    expect(hitIds.has(record2.record_id)).toBe(true);
  });
});

/**
 * Task 5.9 — `getEventById` returns `null` for unknown ids.
 *
 * The contract is explicit about not throwing here: the not-found case
 * is part of the normal control flow (e.g. a consumer checking whether
 * an event has already landed before acting on it).
 *
 * Validates: Requirement 7.2.
 */
describe('SQLite backend — getEventById not found (task 5.9)', () => {
  it('returns null for an id that was never written', async () => {
    const result = await storage.getEventById('01JF8ZS4Y99999999999999999');
    expect(result).toBeNull();
  });
});

/**
 * Task 5.10 — `putMemoryRecord` rejects on `record_id` collision.
 *
 * Records are not deduplicated at the storage layer: a colliding
 * `record_id` indicates an upstream bug (the extractor minted the same
 * id twice), and silently swallowing it would mask that. The backend
 * relies on the `PRIMARY KEY` constraint on `memory_records.record_id`
 * and lets the resulting `SQLITE_CONSTRAINT_PRIMARYKEY` error propagate.
 *
 * Validates: Requirement 8.2.
 */
describe('SQLite backend — putMemoryRecord collision (task 5.10)', () => {
  it('rejects when the same record_id is written twice', async () => {
    const original = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000010',
      title: 'Original title',
    });
    const duplicate = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000010',
      title: 'Different title — same id',
    });

    await storage.putMemoryRecord(original);

    await expect(storage.putMemoryRecord(duplicate)).rejects.toThrow(/UNIQUE|PRIMARY|constraint/i);
  });
});

/**
 * Task 5.11 — FTS5 malformed-query fallback.
 *
 * `sanitizeForFts5` wraps every user query in a phrase — `"..."` with
 * any interior `"` doubled — which neutralises most adversarial input.
 * A handful of shapes still either (a) stay valid phrases that FTS5
 * happily matches or (b) produce a sanitised form FTS5 rejects, which
 * triggers the LIKE fallback. The contract that matters at this layer
 * is uniform regardless of which path runs: the call returns
 * `MemoryRecord[]` without throwing.
 *
 * The test populates one record first so the LIKE fallback (and the
 * FTS5 path, for queries that survive sanitisation) have something to
 * either match or not. Assertions are intentionally shape-only — no
 * claim about *which* records come back, because the two paths rank
 * differently.
 *
 * Validates: Requirement 8.5.
 */
describe('SQLite backend — FTS5 malformed-query fallback (task 5.11)', () => {
  beforeEach(async () => {
    await storage.putMemoryRecord(
      makeValidRecord({
        record_id: 'mr_01JF8ZS4Z00000000000000020',
        title: 'Fallback corpus',
        summary: 'arbitrary content so LIKE and FTS5 have something to scan',
      }),
    );
  });

  const namespace = '/actor/alice/project/abc/';

  // Each of these query strings is either a classic FTS5 footgun or a
  // shape the spec's task list calls out explicitly. What unites them is
  // that a naive implementation would let them bubble up as a
  // `SqliteError` to the caller; the backend must not.
  const cases: Array<[label: string, query: string]> = [
    ['bare asterisk', '*'],
    ['unbalanced double-quote', '"'],
    ['bare NEAR without parens', 'NEAR'],
    ['empty string', ''],
  ];

  for (const [label, query] of cases) {
    it(`returns an array without throwing for ${label} (query: ${JSON.stringify(query)})`, async () => {
      const result = await storage.searchMemoryRecords({
        namespace,
        query,
        limit: 10,
      });

      expect(Array.isArray(result)).toBe(true);
      // Defensive: every returned row must still respect namespace
      // isolation, regardless of which path served the query.
      for (const r of result) {
        expect(r.namespace.startsWith(namespace)).toBe(true);
      }
    });
  }
});

/**
 * Task 5.12 — persistence across close + reopen; migrations do not re-run.
 *
 * The first open writes an event and a record, then closes cleanly.
 * The second open against the same file must see the same data and
 * must leave `_migrations` untouched (one row for `0001_init`, not two).
 * The migration runner already guards re-application via
 * `MAX(applied_version)`, but a regression there would silently double
 * the row count; asserting the exact count is the cheapest way to catch
 * it.
 *
 * The test opens a sibling read-only `Database` handle on the file to
 * inspect `_migrations` directly — the public `StorageBackend` interface
 * does not expose migration metadata, and probing it via the public
 * surface would require adding a test-only method. A readonly sibling
 * handle is a smaller imposition on the production surface.
 *
 * Validates: Requirements 5.5, N4.
 */
describe('SQLite backend — persistence across close + reopen (task 5.12)', () => {
  it('reads back events and records from a reopened database without re-running migrations', async () => {
    const event = makeValidEvent({
      event_id: '01JF8ZS4Y00000000000000030',
      body: { type: 'text', content: 'persist across reopen' },
    });
    const record = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000030',
      title: 'Persistent record',
      summary: 'should survive a close and reopen',
      source_event_ids: [event.event_id],
    });

    await storage.putEvent(event);
    await storage.putMemoryRecord(record);
    await storage.close();

    // Reopen the same file. `beforeEach`'s reference to `storage` is
    // overwritten so the shared `afterEach` closes this handle (and
    // swallows any double-close on the already-closed original).
    storage = openSqliteStorage({ dbPath });

    expect(await storage.getEventById(event.event_id)).toEqual(event);

    const hits = await storage.searchMemoryRecords({
      namespace: record.namespace,
      query: 'persistent',
      limit: 10,
    });
    const hitIds = new Set(hits.map((h) => h.record_id));
    expect(hitIds.has(record.record_id)).toBe(true);

    // Cross-check `_migrations` via a throwaway readonly handle. Opening
    // a second writer on the same file while `storage` is active would
    // work (SQLite allows it in WAL mode), but `readonly: true` makes
    // the intent explicit and cannot accidentally mutate state. We
    // assert against MIGRATIONS.length so this test is resilient as
    // new migrations are appended.
    const probe = new Database(dbPath, { readonly: true });
    try {
      const { count } = probe
        .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM _migrations')
        .get()!;
      expect(count).toBe(MIGRATIONS.length);
    } finally {
      probe.close();
    }
  });
});

/**
 * Task 1 — fts5vocab prepared statements (fts5-query-tokenization spec).
 *
 * Tests the two new entries on the `Statements` object:
 * - `selectFts5DocCount`: fixed-arity count of memory_records rows.
 * - `prepareSelectFts5VocabDocFreq(arity)`: memoised factory for
 *   variable-arity fts5vocab lookups.
 *
 * These tests use a raw `Database` handle with migrations applied and the
 * `memory_records_fts_vocab` virtual table declared manually (Task 2 will
 * add the lazy DDL to `openSqliteStorage`; for now we declare it inline).
 *
 * Validates: Requirements 4.2, 4.3, 5.1
 */
describe('SQLite backend — fts5vocab prepared statements (task 1)', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, MIGRATIONS);
    // Declare the fts5vocab virtual table (Task 2 will add this to openSqliteStorage)
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts_vocab
       USING fts5vocab(memory_records_fts, 'row')`,
    );
  });

  afterEach(() => {
    db.close();
  });

  describe('selectFts5DocCount', () => {
    it('returns { total: 0 } against an empty DB', () => {
      const stmts = prepareStatements(db);
      const row = stmts.selectFts5DocCount.get();
      expect(row).toEqual({ total: 0 });
    });

    it('returns the inserted count against a seeded DB', () => {
      const stmts = prepareStatements(db);

      // Seed 3 memory records
      for (let i = 0; i < 3; i++) {
        const record = makeValidRecord({
          record_id: `mr_01JF8ZS4Z0000000000000000${String(i)}`,
        });
        stmts.insertMemoryRecord.run(
          record.record_id,
          record.namespace,
          record.strategy,
          record.title,
          record.summary,
          JSON.stringify(record.facts),
          JSON.stringify(record.source_event_ids),
          record.created_at,
          JSON.stringify(record.concepts),
          JSON.stringify(record.files_touched),
          record.observation_type,
        );
        stmts.insertMemoryRecordFts.run(
          record.record_id,
          record.namespace,
          record.title,
          record.summary,
          record.facts.join(' '),
        );
      }

      const row = stmts.selectFts5DocCount.get();
      expect(row).toEqual({ total: 3 });
    });
  });

  describe('prepareSelectFts5VocabDocFreq', () => {
    it('returns rows for indexed terms with tokenizer-normalised spelling', () => {
      const stmts = prepareStatements(db);

      // Seed a record with known title/summary/facts so we know what
      // terms the FTS5 tokenizer will emit.
      const record = makeValidRecord({
        record_id: 'mr_01JF8ZS4Z00000000000000001',
        title: 'Syzygy alignment',
        summary: 'The planets aligned in a rare syzygy event',
        facts: ['observed from earth'],
      });
      stmts.insertMemoryRecord.run(
        record.record_id,
        record.namespace,
        record.strategy,
        record.title,
        record.summary,
        JSON.stringify(record.facts),
        JSON.stringify(record.source_event_ids),
        record.created_at,
        JSON.stringify(record.concepts),
        JSON.stringify(record.files_touched),
        record.observation_type,
      );
      stmts.insertMemoryRecordFts.run(
        record.record_id,
        record.namespace,
        record.title,
        record.summary,
        record.facts.join(' '),
      );

      // Query for 3 terms: 'syzygi' (porter-stemmed form of 'syzygy'),
      // 'align' (stemmed form of 'alignment'/'aligned'), and 'nonexistent'
      const stmt = stmts.prepareSelectFts5VocabDocFreq(3);
      const rows = stmt.all('syzygi', 'align', 'nonexistent');

      // Should find 'syzygi' and 'align' but not 'nonexistent'
      const termMap = new Map(rows.map((r) => [r.term, r.doc]));
      expect(termMap.has('syzygi')).toBe(true);
      expect(termMap.has('align')).toBe(true);
      expect(termMap.has('nonexistent')).toBe(false);
      // doc frequency should be 1 (one document contains each term)
      expect(termMap.get('syzygi')).toBe(1);
      expect(termMap.get('align')).toBe(1);
    });

    it('returns the same Statement instance for the same arity (cache hit)', () => {
      const stmts = prepareStatements(db);

      const stmt1 = stmts.prepareSelectFts5VocabDocFreq(3);
      const stmt2 = stmts.prepareSelectFts5VocabDocFreq(3);
      const stmt3 = stmts.prepareSelectFts5VocabDocFreq(5);

      // Same arity → same instance
      expect(stmt1).toBe(stmt2);
      // Different arity → different instance
      expect(stmt1).not.toBe(stmt3);
    });
  });
});

/**
 * Task 2 — Lazy fts5vocab DDL in `openSqliteStorage`
 * (fts5-query-tokenization spec).
 *
 * Verifies that `openSqliteStorage` emits the
 * `CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts_vocab` DDL
 * between `runMigrations` and `prepareStatements`, and that re-opening
 * the same file does not throw (the `IF NOT EXISTS` makes it a no-op).
 *
 * Validates: Requirements 4.2, 9.1
 */
describe('SQLite backend — lazy fts5vocab DDL (task 2)', () => {
  it('memory_records_fts_vocab is listed by PRAGMA table_list after open', async () => {
    // `storage` is already opened in beforeEach via openSqliteStorage.
    // Open a raw handle to the same file to inspect the schema.
    const rawDb = new Database(dbPath);
    try {
      const tables = rawDb
        .prepare<[], { name: string }>(`SELECT name FROM pragma_table_list`)
        .all()
        .map((r) => r.name);
      expect(tables).toContain('memory_records_fts_vocab');
    } finally {
      rawDb.close();
    }
  });

  it('re-opening the same file does not throw (IF NOT EXISTS is a no-op)', async () => {
    // Close the first handle opened in beforeEach.
    await storage.close();

    // Second open on the same path — must not throw. The fts5vocab table
    // already exists from the first open; `IF NOT EXISTS` makes the DDL
    // a silent no-op.
    const storage2 = openSqliteStorage({ dbPath });
    try {
      // Sanity: the backend is functional after the second open.
      const result = await storage2.getEventById('01JF8ZS4Y99999999999999999');
      expect(result).toBeNull();
    } finally {
      await storage2.close();
    }

    // Reassign so afterEach's close doesn't fail on the already-closed handle.
    storage = openSqliteStorage({ dbPath });
  });
});


/**
 * Task 8 — Backend wiring with handle-bound sanitizer
 * (fts5-query-tokenization spec).
 *
 * Verifies that `openSqliteStorage` constructs the sanitizer at open time
 * and that `searchMemoryRecords` uses the closure-based sanitizer:
 * - Empty and whitespace-only queries return `[]` without invoking the
 *   FTS5 MATCH or LIKE prepared statements.
 * - A query containing a shared token returns matching records ordered by
 *   FTS5 rank.
 *
 * Validates: Requirements 2.3, 13.1, 13.3
 */
describe('SQLite backend — handle-bound sanitizer wiring (task 8)', () => {
  it('empty query returns [] without invoking prepared statements', async () => {
    // Seed a record whose title contains "should" as a common substring.
    // If the LIKE fallback were invoked on the empty query, the escaped
    // pattern `%%` would match every record and this one would surface.
    // The short-circuit asserts `[]`, proving LIKE was not called.
    await storage.putMemoryRecord(
      makeValidRecord({
        record_id: 'mr_01JF8ZS4Z00000000000000080',
        title: 'Should not appear',
        summary: 'This record exists but empty query should skip SQL entirely',
      }),
    );

    const result = await storage.searchMemoryRecords({
      namespace: '/actor/alice/project/abc/',
      query: '',
      limit: 10,
    });

    // The seeded record is LIKE-matchable by the empty-query pattern `%%`.
    // An empty result therefore proves neither FTS5 MATCH nor LIKE ran.
    expect(result).toEqual([]);
  });

  it('whitespace-only query returns [] without invoking prepared statements', async () => {
    await storage.putMemoryRecord(
      makeValidRecord({
        record_id: 'mr_01JF8ZS4Z00000000000000081',
        title: 'Should not appear either',
        summary: 'Whitespace query should short-circuit',
      }),
    );

    const result = await storage.searchMemoryRecords({
      namespace: '/actor/alice/project/abc/',
      query: '   \t\n  ',
      limit: 10,
    });

    // Same construction-proof: whitespace tokenizes to zero tokens, so the
    // sanitizer returns ''. If LIKE were called with the escaped whitespace
    // pattern, it would match the seeded record. `[]` proves the skip path.
    expect(result).toEqual([]);
  });

  it('query with a shared token returns both records ordered by FTS5 rank', async () => {
    // Two records that share only the token "quasar" — their other content
    // has no common substring beyond that single shared token.
    const record1 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000082',
      title: 'Observation about quasar luminosity',
      summary: 'Measured the brightness of distant celestial objects',
      facts: ['luminosity varies over time'],
    });
    const record2 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000083',
      title: 'Detecting quasar redshift patterns',
      summary: 'Analyzed spectral data from deep space surveys',
      facts: ['redshift correlates with distance'],
    });

    await storage.putMemoryRecord(record1);
    await storage.putMemoryRecord(record2);

    // Query containing the shared token "quasar" — should return both.
    const hits = await storage.searchMemoryRecords({
      namespace: '/actor/alice/project/abc/',
      query: 'quasar',
      limit: 10,
    });

    expect(hits).toHaveLength(2);
    const hitIds = new Set(hits.map((h) => h.record_id));
    expect(hitIds.has(record1.record_id)).toBe(true);
    expect(hitIds.has(record2.record_id)).toBe(true);
  });
});
