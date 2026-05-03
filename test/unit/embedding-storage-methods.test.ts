/**
 * Unit tests for the new SQLite storage methods added by the
 * local-embeddings-and-hybrid-search spec (task 1.6).
 *
 * Each test opens a fresh backend against a temp-file SQLite database.
 * A temp file — rather than `:memory:` — is used so the corrupt-BLOB test
 * can open a second raw `Database` handle on the same file to stamp in a
 * wrong-length embedding blob without going through
 * `encodeEmbeddingBlob`. Every other test would work against `:memory:`
 * equally well; the temp-file pattern is the common case in
 * `sqlite-backend.test.ts`.
 *
 * Task 1.6 scenarios:
 *
 *   - `putEmbedding` updates the row and is idempotent on repeat
 *   - `putEmbedding` is a no-op for a non-existent `record_id`
 *   - `getEmbedding` round-trips a `Float32Array(384)` bit-for-bit and
 *     returns `null` for missing / NULL
 *   - `listEmbeddings` filters by namespace and excludes NULL
 *   - `listRecordsWithoutEmbedding` returns correct ordering
 *     (`created_at ASC`) and respects namespace scope
 *   - `searchMemoryRecordsLexical` returns 1-based rank matching FTS5
 *     order
 *   - `getStats` populates `embeddings_present` / `embeddings_missing`
 *     at global and namespace scope
 *   - `getEmbedding` throws with `record_id` context when the stored
 *     BLOB has wrong length
 *
 * Validates: Requirements 3.3, 4.1, 4.2, 4.4, 4.7, 8.6, 14.4, 15.3
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
 * Per-test scratch state. Fresh directory + DB per test so parallel runs
 * and the `afterEach` cleanup cannot clash.
 */
let tmpRoot: string;
let dbPath: string;
let storage: StorageBackend;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-emb-test-'));
  dbPath = join(tmpRoot, 'kiro-learn.db');
  storage = openSqliteStorage({ dbPath });
});

afterEach(async () => {
  try {
    await storage.close();
  } catch {
    // swallow; cleanup must not mask the real test failure
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Build a Float32Array(384) populated with interesting float patterns —
 * zeros, positives, negatives, subnormals, large magnitudes, and the
 * special values ±0, ±Infinity, NaN. Used to exercise the bit-for-bit
 * round-trip requirement.
 *
 * The pattern cycles through ten distinct shapes so every 10-wide slice
 * of the 384-long array covers the full menagerie.
 */
function buildInterestingVec(): Float32Array {
  const vec = new Float32Array(384);
  for (let i = 0; i < 384; i += 1) {
    switch (i % 10) {
      case 0:
        vec[i] = 0;
        break;
      case 1:
        vec[i] = -0;
        break;
      case 2:
        vec[i] = 1.5;
        break;
      case 3:
        vec[i] = -2.25;
        break;
      case 4:
        // A subnormal Float32: Number.MIN_VALUE is a subnormal Float64 but
        // collapses to the smallest subnormal Float32 after the cast.
        vec[i] = 1.4e-45;
        break;
      case 5:
        vec[i] = -1.4e-45;
        break;
      case 6:
        vec[i] = 3.4028235e38; // near Float32 max
        break;
      case 7:
        vec[i] = -3.4028235e38;
        break;
      case 8:
        vec[i] = Number.POSITIVE_INFINITY;
        break;
      case 9:
        vec[i] = Number.NaN;
        break;
    }
  }
  return vec;
}

/**
 * Bitwise equality over two `Float32Array`s of identical length.
 *
 * Uses a `Uint32Array` view over the same underlying buffer so NaN bit
 * patterns compare equal (unlike `===`, which treats every NaN as
 * distinct) and ±0 compare distinct (unlike `===`, which collapses them).
 * This is the comparison that matters for the round-trip requirement
 * (15.1 — "contents are bitwise-equal").
 */
function assertBitwiseEqual(actual: Float32Array, expected: Float32Array): void {
  expect(actual.length).toBe(expected.length);
  const actualBits = new Uint32Array(actual.buffer, actual.byteOffset, actual.length);
  const expectedBits = new Uint32Array(expected.buffer, expected.byteOffset, expected.length);
  expect(Array.from(actualBits)).toEqual(Array.from(expectedBits));
}

/**
 * `putEmbedding` writes the vector on the row and is idempotent on repeat.
 *
 * Validates: Requirements 3.3, 4.1, 4.2
 */
describe('putEmbedding updates the row and is idempotent (Requirements 3.3, 4.1, 4.2)', () => {
  it('writes the embedding and round-trips it via getEmbedding', async () => {
    const record = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000100',
    });
    await storage.putMemoryRecord(record);

    const vec = new Float32Array(384);
    for (let i = 0; i < 384; i += 1) vec[i] = i / 384;

    await storage.putEmbedding(record.record_id, vec);

    const got = await storage.getEmbedding(record.record_id);
    expect(got).not.toBeNull();
    assertBitwiseEqual(got!, vec);
  });

  it('overwrites a prior embedding when called twice on the same record', async () => {
    const record = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000101',
    });
    await storage.putMemoryRecord(record);

    const first = new Float32Array(384);
    for (let i = 0; i < 384; i += 1) first[i] = 1;

    const second = new Float32Array(384);
    for (let i = 0; i < 384; i += 1) second[i] = -2;

    await storage.putEmbedding(record.record_id, first);
    await storage.putEmbedding(record.record_id, second);

    const got = await storage.getEmbedding(record.record_id);
    expect(got).not.toBeNull();
    // The second write must have replaced the first — idempotent in the
    // sense that a repeat call leaves the column holding the latest value.
    assertBitwiseEqual(got!, second);
  });

  it('is idempotent when the same embedding is written twice in a row', async () => {
    const record = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000102',
    });
    await storage.putMemoryRecord(record);

    const vec = new Float32Array(384);
    for (let i = 0; i < 384; i += 1) vec[i] = Math.sin(i);

    await storage.putEmbedding(record.record_id, vec);
    await storage.putEmbedding(record.record_id, vec);

    const got = await storage.getEmbedding(record.record_id);
    expect(got).not.toBeNull();
    assertBitwiseEqual(got!, vec);
  });
});

/**
 * `putEmbedding` is a no-op when the record_id does not exist. The
 * underlying UPDATE matches zero rows; the backend swallows that as a
 * silent no-op rather than erroring.
 *
 * Validates: Requirements 3.3, 8.6
 */
describe('putEmbedding is a no-op for a non-existent record_id (Requirements 3.3, 8.6)', () => {
  it('does not throw and does not create a row', async () => {
    const missingId = 'mr_01JF8ZS4Z00000000000000999';
    const vec = new Float32Array(384);

    // The call must not throw.
    await expect(storage.putEmbedding(missingId, vec)).resolves.toBeUndefined();

    // The row was never created — getEmbedding returns null for missing.
    expect(await storage.getEmbedding(missingId)).toBeNull();
  });
});

/**
 * `getEmbedding` round-trips every bit of a Float32Array(384), and
 * returns `null` for records whose embedding column is NULL and for
 * records that do not exist.
 *
 * Validates: Requirements 4.2, 4.4, 15.1, 15.2
 */
describe('getEmbedding round-trips bit-for-bit and returns null for missing / NULL (Requirements 4.2, 4.4)', () => {
  it('round-trips a Float32Array(384) bit-for-bit, including NaN, ±Infinity, and ±0', async () => {
    const record = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000110',
    });
    await storage.putMemoryRecord(record);

    const vec = buildInterestingVec();
    await storage.putEmbedding(record.record_id, vec);

    const got = await storage.getEmbedding(record.record_id);
    expect(got).not.toBeNull();
    assertBitwiseEqual(got!, vec);
  });

  it('returns null for a record that has no embedding stored', async () => {
    const record = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000111',
    });
    await storage.putMemoryRecord(record);

    // Row exists, embedding column is NULL.
    expect(await storage.getEmbedding(record.record_id)).toBeNull();
  });

  it('returns null for a record_id that does not exist', async () => {
    expect(
      await storage.getEmbedding('mr_01JF8ZS4Z00000000000000998'),
    ).toBeNull();
  });
});

/**
 * `listEmbeddings` returns (`record_id`, `embedding`, `created_at`) for
 * every record in the given namespace that has a non-null embedding.
 * Records in a different namespace must not leak in, and records whose
 * embedding is NULL must be excluded.
 *
 * Validates: Requirements 4.7
 */
describe('listEmbeddings filters by namespace and excludes NULL (Requirements 4.7)', () => {
  it('returns only embedded records from the requested namespace', async () => {
    const namespaceA = '/actor/alice/project/abc/';
    const namespaceB = '/actor/bob/project/xyz/';

    const vec = new Float32Array(384);
    for (let i = 0; i < 384; i += 1) vec[i] = 0.1 * i;

    // Two records in namespace A: one embedded, one not.
    const a1 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000120',
      namespace: namespaceA,
    });
    const a2 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000121',
      namespace: namespaceA,
    });
    // One record in namespace B, also embedded — must not appear in
    // the namespace-A result.
    const b1 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000122',
      namespace: namespaceB,
    });

    await storage.putMemoryRecord(a1);
    await storage.putMemoryRecord(a2);
    await storage.putMemoryRecord(b1);

    await storage.putEmbedding(a1.record_id, vec);
    // a2 intentionally left without an embedding.
    await storage.putEmbedding(b1.record_id, vec);

    const results = await storage.listEmbeddings(namespaceA);

    // Exactly one result: a1. a2 is filtered out (NULL embedding);
    // b1 is filtered out (different namespace).
    expect(results).toHaveLength(1);
    expect(results[0]?.record_id).toBe(a1.record_id);
    expect(results[0]?.created_at).toBe(a1.created_at);
    expect(results[0]?.embedding.length).toBe(384);
    assertBitwiseEqual(results[0]!.embedding, vec);
  });

  it('returns an empty array when the namespace has no embedded records', async () => {
    // Record exists in the namespace but no embedding yet.
    const record = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000123',
      namespace: '/actor/alice/project/abc/',
    });
    await storage.putMemoryRecord(record);

    const results = await storage.listEmbeddings('/actor/alice/project/abc/');
    expect(results).toEqual([]);
  });
});

/**
 * `listRecordsWithoutEmbedding` returns memory records with a NULL
 * embedding, oldest first (`created_at ASC`). When a namespace is
 * passed, only records in that exact namespace are returned; when
 * `null` is passed, every namespace is scanned.
 *
 * Validates: Requirements 8.6
 */
describe('listRecordsWithoutEmbedding orders and scopes correctly (Requirements 8.6)', () => {
  it('returns NULL-embedding records in created_at ASC order', async () => {
    const namespace = '/actor/alice/project/abc/';

    const older = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000130',
      namespace,
      created_at: '2024-01-01T00:00:00.000Z',
    });
    const middle = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000131',
      namespace,
      created_at: '2024-06-01T00:00:00.000Z',
    });
    const newer = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000132',
      namespace,
      created_at: '2025-01-01T00:00:00.000Z',
    });

    // Insert in a non-sorted order to prove the statement's own ORDER BY
    // is doing the work — not insertion order.
    await storage.putMemoryRecord(middle);
    await storage.putMemoryRecord(newer);
    await storage.putMemoryRecord(older);

    const results = await storage.listRecordsWithoutEmbedding(namespace, 10);

    expect(results.map((r) => r.record_id)).toEqual([
      older.record_id,
      middle.record_id,
      newer.record_id,
    ]);
  });

  it('excludes records that already have an embedding', async () => {
    const namespace = '/actor/alice/project/abc/';

    const embedded = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000140',
      namespace,
      created_at: '2024-01-01T00:00:00.000Z',
    });
    const unembedded = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000141',
      namespace,
      created_at: '2024-02-01T00:00:00.000Z',
    });

    await storage.putMemoryRecord(embedded);
    await storage.putMemoryRecord(unembedded);

    const vec = new Float32Array(384);
    await storage.putEmbedding(embedded.record_id, vec);

    const results = await storage.listRecordsWithoutEmbedding(namespace, 10);

    expect(results.map((r) => r.record_id)).toEqual([unembedded.record_id]);
  });

  it('respects namespace scope when a namespace is provided', async () => {
    const namespaceA = '/actor/alice/project/abc/';
    const namespaceB = '/actor/bob/project/xyz/';

    const a1 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000150',
      namespace: namespaceA,
      created_at: '2024-01-01T00:00:00.000Z',
    });
    const b1 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000151',
      namespace: namespaceB,
      created_at: '2024-02-01T00:00:00.000Z',
    });

    await storage.putMemoryRecord(a1);
    await storage.putMemoryRecord(b1);

    const scoped = await storage.listRecordsWithoutEmbedding(namespaceA, 10);
    expect(scoped.map((r) => r.record_id)).toEqual([a1.record_id]);

    // Global scan (namespace = null) returns both, still oldest-first.
    const global = await storage.listRecordsWithoutEmbedding(null, 10);
    expect(global.map((r) => r.record_id)).toEqual([a1.record_id, b1.record_id]);
  });

  it('honours the limit argument', async () => {
    const namespace = '/actor/alice/project/abc/';
    const ids = [
      'mr_01JF8ZS4Z00000000000000160',
      'mr_01JF8ZS4Z00000000000000161',
      'mr_01JF8ZS4Z00000000000000162',
    ];

    for (let i = 0; i < ids.length; i += 1) {
      await storage.putMemoryRecord(
        makeValidRecord({
          record_id: ids[i],
          namespace,
          // Ascending created_at so the ASC order is deterministic.
          created_at: `2024-0${String(i + 1)}-01T00:00:00.000Z`,
        }),
      );
    }

    const results = await storage.listRecordsWithoutEmbedding(namespace, 2);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.record_id)).toEqual([ids[0], ids[1]]);
  });
});

/**
 * `searchMemoryRecordsLexical` returns the same records
 * `searchMemoryRecords` returns, paired with a 1-based integer rank that
 * matches the FTS5 ordering. Rank 1 is the top-ranked match; subsequent
 * ranks are strictly increasing and contiguous (1, 2, 3, …).
 *
 * Validates: Requirements 4.7, 5.1
 */
describe('searchMemoryRecordsLexical returns 1-based FTS5-ordered rank (Requirements 4.7, 5.1)', () => {
  it('assigns contiguous 1-based ranks matching FTS5 order', async () => {
    const namespace = '/actor/alice/project/abc/';

    // All three records share the query token "quasar" so they all match
    // the FTS5 query; their surrounding text varies so FTS5 produces a
    // non-trivial ranking.
    const r1 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000170',
      namespace,
      title: 'Observation about quasar luminosity',
      summary: 'Measured the brightness of distant celestial objects.',
    });
    const r2 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000171',
      namespace,
      title: 'Detecting quasar redshift patterns',
      summary: 'Analyzed spectral data from deep space surveys.',
    });
    const r3 = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000172',
      namespace,
      title: 'Discovered a quasar',
      summary: 'A brief mention of the newly identified quasar cluster.',
    });

    await storage.putMemoryRecord(r1);
    await storage.putMemoryRecord(r2);
    await storage.putMemoryRecord(r3);

    const ranked = await storage.searchMemoryRecordsLexical({
      namespace,
      query: 'quasar',
      limit: 10,
    });

    // Three matches, all in the same namespace.
    expect(ranked).toHaveLength(3);

    // Ranks are contiguous and 1-based (1, 2, 3).
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);

    // The unwrapped records must equal those the existing plain
    // searchMemoryRecords surface returns, in the same order.
    const plain = await storage.searchMemoryRecords({
      namespace,
      query: 'quasar',
      limit: 10,
    });
    expect(ranked.map((r) => r.record.record_id)).toEqual(
      plain.map((r) => r.record_id),
    );
  });

  it('scopes by namespace prefix and drops records from other namespaces', async () => {
    const namespaceA = '/actor/alice/project/abc/';
    const namespaceB = '/actor/bob/project/xyz/';

    const inA = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000180',
      namespace: namespaceA,
      title: 'quasar found',
      summary: 'alpha',
    });
    const inB = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000181',
      namespace: namespaceB,
      title: 'quasar found',
      summary: 'beta',
    });

    await storage.putMemoryRecord(inA);
    await storage.putMemoryRecord(inB);

    const ranked = await storage.searchMemoryRecordsLexical({
      namespace: namespaceA,
      query: 'quasar',
      limit: 10,
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.record.record_id).toBe(inA.record_id);
    expect(ranked[0]?.rank).toBe(1);
  });
});

/**
 * `getStats` populates the additive `embeddings_present` /
 * `embeddings_missing` fields both at global scope and when scoped to a
 * specific namespace.
 *
 * Validates: Requirements 14.4
 */
describe('getStats populates embeddings_present / embeddings_missing (Requirements 14.4)', () => {
  it('reports present=0, missing=0 against an empty database', async () => {
    const global = await storage.getStats();
    expect(global.embeddings_present).toBe(0);
    expect(global.embeddings_missing).toBe(0);
  });

  it('counts present and missing correctly at global scope', async () => {
    const namespaceA = '/actor/alice/project/abc/';
    const namespaceB = '/actor/bob/project/xyz/';

    const vec = new Float32Array(384);

    // 2 embedded in namespace A, 1 unembedded in namespace A,
    // 1 embedded in namespace B, 1 unembedded in namespace B.
    // Global totals: present = 3, missing = 2.
    const records = [
      { id: 'mr_01JF8ZS4Z00000000000000200', ns: namespaceA, embed: true },
      { id: 'mr_01JF8ZS4Z00000000000000201', ns: namespaceA, embed: true },
      { id: 'mr_01JF8ZS4Z00000000000000202', ns: namespaceA, embed: false },
      { id: 'mr_01JF8ZS4Z00000000000000203', ns: namespaceB, embed: true },
      { id: 'mr_01JF8ZS4Z00000000000000204', ns: namespaceB, embed: false },
    ];

    for (const r of records) {
      await storage.putMemoryRecord(
        makeValidRecord({ record_id: r.id, namespace: r.ns }),
      );
      if (r.embed) {
        await storage.putEmbedding(r.id, vec);
      }
    }

    const global = await storage.getStats();
    expect(global.embeddings_present).toBe(3);
    expect(global.embeddings_missing).toBe(2);
  });

  it('counts present and missing correctly at namespace scope', async () => {
    const namespaceA = '/actor/alice/project/abc/';
    const namespaceB = '/actor/bob/project/xyz/';

    const vec = new Float32Array(384);

    const records = [
      { id: 'mr_01JF8ZS4Z00000000000000210', ns: namespaceA, embed: true },
      { id: 'mr_01JF8ZS4Z00000000000000211', ns: namespaceA, embed: true },
      { id: 'mr_01JF8ZS4Z00000000000000212', ns: namespaceA, embed: false },
      { id: 'mr_01JF8ZS4Z00000000000000213', ns: namespaceB, embed: true },
    ];

    for (const r of records) {
      await storage.putMemoryRecord(
        makeValidRecord({ record_id: r.id, namespace: r.ns }),
      );
      if (r.embed) {
        await storage.putEmbedding(r.id, vec);
      }
    }

    // Namespace A: 2 embedded, 1 missing.
    const scopedA = await storage.getStats(namespaceA);
    expect(scopedA.embeddings_present).toBe(2);
    expect(scopedA.embeddings_missing).toBe(1);

    // Namespace B: 1 embedded, 0 missing.
    const scopedB = await storage.getStats(namespaceB);
    expect(scopedB.embeddings_present).toBe(1);
    expect(scopedB.embeddings_missing).toBe(0);
  });
});

/**
 * `getEmbedding` throws a descriptive error that mentions the offending
 * `record_id` when the stored BLOB has an unexpected length. The test
 * writes a 1000-byte buffer directly via a raw SQL UPDATE — bypassing
 * `encodeEmbeddingBlob` — to simulate a corrupt row on disk.
 *
 * Validates: Requirements 15.3
 */
describe('getEmbedding throws with record_id context on corrupt BLOB (Requirement 15.3)', () => {
  it('surfaces the offending record_id in the error message', async () => {
    const record = makeValidRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000300',
    });
    await storage.putMemoryRecord(record);

    // A second raw Database handle on the same file lets us stamp in a
    // wrong-length BLOB without going through the backend's encoder,
    // which would throw on length mismatch. The backend's own handle
    // keeps WAL-mode semantics so the raw write is visible to the next
    // read through the primary handle.
    const raw = new Database(dbPath);
    try {
      const corrupt = Buffer.alloc(1000); // 1000 != 1536
      raw
        .prepare(`UPDATE memory_records SET embedding = ? WHERE record_id = ?`)
        .run(corrupt, record.record_id);
    } finally {
      raw.close();
    }

    // The error must reject — and its message must carry the record_id
    // so an operator investigating the warning has a direct pointer to
    // the bad row.
    await expect(storage.getEmbedding(record.record_id)).rejects.toThrow(
      new RegExp(record.record_id),
    );
  });
});
