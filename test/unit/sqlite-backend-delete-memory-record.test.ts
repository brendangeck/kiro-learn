/**
 * Unit tests for `deleteMemoryRecord` and `withTransaction` on the SQLite
 * storage backend (reconciliation-engine spec, Task 2.4).
 *
 * The reconciliation-engine feature extends `StorageBackend` with two
 * write operations that the Reconciliation Stage needs to commit a
 * `<merge>` decision atomically:
 *
 * - `deleteMemoryRecord(recordIds[])` — removes each listed record from
 *   `memory_records`, nulls its embedding column, and removes its FTS5
 *   companion row. Idempotent: unknown ids are a silent no-op so a
 *   partially-applied merge can be retried safely (Requirement 9.5).
 *
 * - `withTransaction(fn)` — runs `fn` inside one BEGIN/COMMIT, passing a
 *   synchronous `StorageTransaction` handle exposing
 *   `putMemoryRecord` + `putEmbedding` + `deleteMemoryRecord`. A thrown
 *   error from `fn` rolls back every write (Requirement 8.1). The
 *   callback body is synchronous by design — `better-sqlite3`
 *   transactions are synchronous, and yielding to the microtask queue
 *   inside the body would escape the BEGIN/COMMIT.
 *
 * Each test opens a fresh temp-directory SQLite file via `openSqliteStorage`
 * so isolation is per-test (matching the pattern in `sqlite-backend.test.ts`).
 * The `afterEach` hook closes and removes the temp tree even on failure so
 * nothing leaks into `/tmp` across runs.
 *
 * Validates: Requirements 8.1, 9.1, 9.2, 9.3, 9.4, 9.5.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { StorageBackend } from '../../src/types/index.js';

import { makeValidRecord } from '../helpers/fixtures.js';

/**
 * Per-test scratch state. A unique temp directory per test keeps parallel
 * runs and cleanup failures from clashing.
 */
let tmpRoot: string;
let dbPath: string;
let storage: StorageBackend;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-delete-test-'));
  dbPath = join(tmpRoot, 'kiro-learn.db');
  storage = openSqliteStorage({ dbPath });
});

afterEach(async () => {
  try {
    await storage.close();
  } catch {
    // swallow: cleanup must not mask the real test failure
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Make a deterministic 384-dimensional `Float32Array` from a string seed so
 * tests that write embeddings are easy to read. The values themselves are
 * not inspected by these tests — only their presence / absence via the
 * existing `getEmbedding` surface.
 */
function seededEmbedding(seed: string): Float32Array {
  const vec = new Float32Array(384);
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  for (let i = 0; i < vec.length; i++) {
    h = (h * 1103515245 + 12345) | 0;
    vec[i] = ((h >>> 8) & 0xffff) / 0xffff;
  }
  return vec;
}

/**
 * Count the FTS5 companion rows for a given `record_id` by opening a
 * read-only sibling handle. The public `StorageBackend` surface does not
 * expose FTS5-level reads, so probing directly is the simplest way to
 * assert that `deleteMemoryRecord` removed the index row too.
 */
function countFtsRows(recordId: string): number {
  const probe = new Database(dbPath, { readonly: true });
  try {
    const row = probe
      .prepare<[string], { c: number }>(
        'SELECT COUNT(*) AS c FROM memory_records_fts WHERE record_id = ?',
      )
      .get(recordId);
    return row?.c ?? 0;
  } finally {
    probe.close();
  }
}

/**
 * Count the rows in `memory_records` for a given `record_id`. Returns 0
 * (no row) or 1 (primary key is unique).
 */
function countMemoryRows(recordId: string): number {
  const probe = new Database(dbPath, { readonly: true });
  try {
    const row = probe
      .prepare<[string], { c: number }>(
        'SELECT COUNT(*) AS c FROM memory_records WHERE record_id = ?',
      )
      .get(recordId);
    return row?.c ?? 0;
  } finally {
    probe.close();
  }
}

/* ────────────────────────────────────────────────────────────────────
 * deleteMemoryRecord — happy path
 * ──────────────────────────────────────────────────────────────────── */

describe('SQLite backend — deleteMemoryRecord happy path', () => {
  it('removes the row from memory_records, nulls its embedding, and removes its FTS5 entry', async () => {
    const record = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z0000000000DELETE1',
      title: 'To be deleted',
      summary: 'This record should disappear entirely after deleteMemoryRecord',
    });

    // Seed: insert the record (which writes the FTS5 companion row too)
    // and attach an embedding so all three cleanup steps have something
    // to remove.
    await storage.putMemoryRecord(record);
    await storage.putEmbedding(record.record_id, seededEmbedding(record.record_id));

    // Sanity: pre-conditions hold before we delete.
    expect(countMemoryRows(record.record_id)).toBe(1);
    expect(countFtsRows(record.record_id)).toBe(1);
    expect(await storage.getEmbedding(record.record_id)).not.toBeNull();

    await storage.deleteMemoryRecord([record.record_id]);

    // Primary row gone.
    expect(countMemoryRows(record.record_id)).toBe(0);
    // FTS5 companion row gone.
    expect(countFtsRows(record.record_id)).toBe(0);
    // Embedding gone — since the row itself is gone, `getEmbedding` returns
    // null regardless of the intermediate UPDATE. That matches the
    // "embedding is absent from storage" contract from Requirement 9.2.
    expect(await storage.getEmbedding(record.record_id)).toBeNull();

    // Search should no longer surface the deleted record.
    const hits = await storage.searchMemoryRecords({
      namespace: record.namespace,
      query: 'disappear',
      limit: 10,
    });
    expect(hits.map((h) => h.record_id)).not.toContain(record.record_id);
  });
});

/* ────────────────────────────────────────────────────────────────────
 * deleteMemoryRecord — idempotency on unknown ids
 * ──────────────────────────────────────────────────────────────────── */

describe('SQLite backend — deleteMemoryRecord idempotency', () => {
  it('does not throw when called with a nonexistent record_id', async () => {
    // No records written — the call must complete cleanly (Req 9.5).
    await expect(
      storage.deleteMemoryRecord(['mr_01JF8ZS4Z00000000NONEXISTENT']),
    ).resolves.toBeUndefined();
  });

  it('does not throw when the record_id list mixes existing and unknown ids', async () => {
    const seeded = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000MIXED1',
    });
    await storage.putMemoryRecord(seeded);
    expect(countMemoryRows(seeded.record_id)).toBe(1);

    // Deleting a known id + an unknown id succeeds and leaves no trace
    // of either.
    await expect(
      storage.deleteMemoryRecord([seeded.record_id, 'mr_01JF8ZS4Z00000000NEVERTHERE']),
    ).resolves.toBeUndefined();
    expect(countMemoryRows(seeded.record_id)).toBe(0);
  });

  it('empty input is a trivial no-op', async () => {
    // Zero-length input must not raise; it also must not invalidate any
    // existing state.
    const seeded = makeValidRecord({ record_id: 'mr_01JF8ZS4Z0000000EMPTYINPUT1' });
    await storage.putMemoryRecord(seeded);
    await storage.deleteMemoryRecord([]);
    expect(countMemoryRows(seeded.record_id)).toBe(1);
  });
});

/* ────────────────────────────────────────────────────────────────────
 * deleteMemoryRecord — batch semantics
 * ──────────────────────────────────────────────────────────────────── */

describe('SQLite backend — deleteMemoryRecord batch', () => {
  it('removes exactly the listed ids and leaves every other row intact', async () => {
    // Seed five records. We will delete three; the remaining two must
    // stay fully intact (primary row + FTS5 entry + embedding).
    const records = [
      makeValidRecord({ record_id: 'mr_01JF8ZS4Z00000000000BATCH1', title: 'batch one' }),
      makeValidRecord({ record_id: 'mr_01JF8ZS4Z00000000000BATCH2', title: 'batch two' }),
      makeValidRecord({ record_id: 'mr_01JF8ZS4Z00000000000BATCH3', title: 'batch three' }),
      makeValidRecord({ record_id: 'mr_01JF8ZS4Z00000000000BATCH4', title: 'batch four' }),
      makeValidRecord({ record_id: 'mr_01JF8ZS4Z00000000000BATCH5', title: 'batch five' }),
    ];
    for (const r of records) {
      await storage.putMemoryRecord(r);
      await storage.putEmbedding(r.record_id, seededEmbedding(r.record_id));
    }

    const toDelete = [
      records[0]!.record_id,
      records[2]!.record_id,
      records[4]!.record_id,
    ];
    const toKeep = [records[1]!.record_id, records[3]!.record_id];

    await storage.deleteMemoryRecord(toDelete);

    for (const id of toDelete) {
      expect(countMemoryRows(id)).toBe(0);
      expect(countFtsRows(id)).toBe(0);
      expect(await storage.getEmbedding(id)).toBeNull();
    }

    for (const id of toKeep) {
      expect(countMemoryRows(id)).toBe(1);
      expect(countFtsRows(id)).toBe(1);
      expect(await storage.getEmbedding(id)).not.toBeNull();
    }
  });
});

/* ────────────────────────────────────────────────────────────────────
 * withTransaction — happy path
 * ──────────────────────────────────────────────────────────────────── */

describe('SQLite backend — withTransaction happy path', () => {
  it('commits put + delete + put-embedding atomically and the writes are visible afterward', async () => {
    // Pre-existing record that the transaction will delete. This is the
    // "merged-away" row in a reconciliation scenario.
    const preexisting = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z0000000000MERGED1',
      title: 'pre-existing merged record',
    });
    await storage.putMemoryRecord(preexisting);
    await storage.putEmbedding(preexisting.record_id, seededEmbedding(preexisting.record_id));

    // New summary record + its embedding committed inside the same
    // transaction that deletes the pre-existing row.
    const summary = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z000000000SUMMARY1',
      strategy: 'llm-reconciled',
      title: 'summary title',
      summary: 'synthetic summary that replaces the merged record',
    });
    const summaryEmbedding = seededEmbedding(summary.record_id);

    await storage.withTransaction((tx) => {
      tx.putMemoryRecord(summary);
      tx.deleteMemoryRecord([preexisting.record_id]);
      tx.putEmbedding(summary.record_id, summaryEmbedding);
    });

    // Summary row landed along with its FTS5 companion and embedding.
    expect(countMemoryRows(summary.record_id)).toBe(1);
    expect(countFtsRows(summary.record_id)).toBe(1);
    const storedEmbedding = await storage.getEmbedding(summary.record_id);
    expect(storedEmbedding).not.toBeNull();
    expect(storedEmbedding!.length).toBe(summaryEmbedding.length);

    // Pre-existing row is gone at every level.
    expect(countMemoryRows(preexisting.record_id)).toBe(0);
    expect(countFtsRows(preexisting.record_id)).toBe(0);
    expect(await storage.getEmbedding(preexisting.record_id)).toBeNull();
  });

  it('resolves with the callback return value', async () => {
    const returned = await storage.withTransaction(() => 'hello-from-tx');
    expect(returned).toBe('hello-from-tx');
  });
});

/* ────────────────────────────────────────────────────────────────────
 * withTransaction — rollback
 * ──────────────────────────────────────────────────────────────────── */

describe('SQLite backend — withTransaction rollback', () => {
  it('rolls back every write when the callback throws', async () => {
    // Seed two records. The transaction will attempt to insert a new
    // record + delete one of the seeded records + put an embedding,
    // then throw — after which none of those changes must be visible.
    const kept = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000KEPT01',
      title: 'kept record',
    });
    const wouldBeDeleted = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z0000000000TODROP1',
      title: 'would be deleted',
    });
    await storage.putMemoryRecord(kept);
    await storage.putMemoryRecord(wouldBeDeleted);
    await storage.putEmbedding(
      wouldBeDeleted.record_id,
      seededEmbedding(wouldBeDeleted.record_id),
    );

    const wouldBeInserted = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z0000000000TOINSRT',
      title: 'would be inserted',
    });

    // Expect the callback error to propagate. `better-sqlite3` rolls
    // back on throw; we verify the rollback by inspecting the DB state
    // after the call returns.
    const trigger = new Error('simulated failure inside tx body');
    await expect(
      storage.withTransaction((tx) => {
        tx.putMemoryRecord(wouldBeInserted);
        tx.deleteMemoryRecord([wouldBeDeleted.record_id]);
        tx.putEmbedding(
          wouldBeInserted.record_id,
          seededEmbedding(wouldBeInserted.record_id),
        );
        throw trigger;
      }),
    ).rejects.toBe(trigger);

    // Post-conditions: the "would-be-deleted" row is still there, its
    // embedding is still present, its FTS5 row is still there, and the
    // "would-be-inserted" row never landed.
    expect(countMemoryRows(wouldBeDeleted.record_id)).toBe(1);
    expect(countFtsRows(wouldBeDeleted.record_id)).toBe(1);
    expect(await storage.getEmbedding(wouldBeDeleted.record_id)).not.toBeNull();

    expect(countMemoryRows(wouldBeInserted.record_id)).toBe(0);
    expect(countFtsRows(wouldBeInserted.record_id)).toBe(0);

    // The unrelated `kept` row is unaffected either way.
    expect(countMemoryRows(kept.record_id)).toBe(1);
  });

  it('rejects when the callback returns a Promise (async tx bodies are not supported)', async () => {
    // The contract is "synchronous tx body"; awaiting inside would
    // escape BEGIN/COMMIT. The backend rejects rather than silently
    // losing atomicity. The reject happens from inside the transaction
    // body, so `better-sqlite3` also rolls back any writes that were
    // made before the Promise check (none here).
    await expect(
      storage.withTransaction(async () => {
        return 42;
      }),
    ).rejects.toThrow(/synchronous/i);
  });
});
