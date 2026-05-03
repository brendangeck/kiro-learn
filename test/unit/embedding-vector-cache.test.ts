/**
 * Unit tests for the per-namespace vector index cache (task 6.2).
 *
 * Covers five scenarios, each with a focused StorageBackend stub built
 * from `vi.fn()` so we can inspect call counts and arguments:
 *
 *   1. First `getOrLoad(ns)` on a cold cache calls `listEmbeddings`;
 *      a second call on the same namespace is a cache hit (no second
 *      storage call).
 *   2. `invalidate(ns)` forces the next `getOrLoad(ns)` to reload from
 *      storage (one more `listEmbeddings` call after the invalidation).
 *   3. Cached entries exclude records whose embedding is NULL — the
 *      cache relies on `listEmbeddings` to pre-filter, so if the stub
 *      returns only non-NULL rows every entry in the built index has
 *      a vector.
 *   4. Stored `vec_normalised` arrays are L2-normalised: the running
 *      norm is ≈ 1 for non-degenerate inputs, and exactly 0 for the
 *      zero vector (the guard in `normalize`).
 *   5. The 500 MiB memory-pressure `console.warn` fires exactly once
 *      when the running total of accounted bytes crosses the threshold
 *      and does not re-fire on subsequent loads.
 *
 * Notes on the memory-pressure test:
 *
 * The cache charges `entries.length * EMBEDDING_BLOB_BYTES` bytes per
 * installed index, regardless of the actual byte width of the
 * `Float32Array` held in memory. This lets us cross 500 MiB of
 * accounted bytes with minimal real heap pressure by handing the
 * mock 1-element `Float32Array`s and sharing a single `MemoryRecord`
 * object pointer across all entries with just the `record_id`
 * overridden. 4 namespaces × 90 000 entries = 360 000 × 1 536 ≈
 * 527 MiB, safely over the 500 MiB (= 524 288 000 bytes) threshold.
 *
 * @see Requirements 7.4, 7.5
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — Vector index cache shape
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Error Handling — Cache memory pressure
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNamespaceVectorCache } from '../../src/collector/query/vector-cache.js';
import type { MemoryRecord, StorageBackend } from '../../src/types/index.js';

import { makeValidRecord } from '../helpers/fixtures.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Minimal stand-in `MemoryRecord` factory — the cache never parses the
 * record, it only stores the reference and joins on `record_id`. Using
 * a shared base and overriding just `record_id` avoids building
 * hundreds of thousands of distinct objects for the memory-pressure
 * test while still giving each entry a unique key.
 */
function recordFor(recordId: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return makeValidRecord({ record_id: recordId, ...overrides }) as MemoryRecord;
}

/**
 * Build a {@link StorageBackend} stub that only implements the two
 * methods the cache calls: `listEmbeddings` and `listMemoryRecords`.
 * Every other method is a `vi.fn()` that rejects if the cache
 * accidentally calls it — this is how we catch any future drift in
 * the cache reaching into methods it should not.
 *
 * The `embeddings` / `records` maps are keyed by namespace so a single
 * stub can serve a multi-namespace workload (used by the memory-
 * pressure test).
 */
function createStorageStub(
  embeddings: Record<
    string,
    Array<{ record_id: string; embedding: Float32Array; created_at: string }>
  >,
  records: Record<string, MemoryRecord[]>,
): StorageBackend & {
  listEmbeddings: ReturnType<typeof vi.fn>;
  listMemoryRecords: ReturnType<typeof vi.fn>;
} {
  const unreachable = (method: string) =>
    vi.fn(() => {
      throw new Error(`StorageBackend.${method} should not be called by the cache`);
    });

  return {
    putEvent: unreachable('putEvent'),
    getEventById: unreachable('getEventById'),
    putMemoryRecord: unreachable('putMemoryRecord'),
    searchMemoryRecords: unreachable('searchMemoryRecords'),
    close: unreachable('close'),
    getStats: unreachable('getStats'),
    listProjects: unreachable('listProjects'),
    listMemoryRecords: vi.fn(async (params: { namespace?: string; limit: number; offset: number }) => {
      const ns = params.namespace ?? '';
      const items = records[ns] ?? [];
      return { items, total: items.length };
    }),
    listEvents: unreachable('listEvents'),
    putEmbedding: unreachable('putEmbedding'),
    getEmbedding: unreachable('getEmbedding'),
    listEmbeddings: vi.fn(async (namespace: string) => embeddings[namespace] ?? []),
    listRecordsWithoutEmbedding: unreachable('listRecordsWithoutEmbedding'),
    searchMemoryRecordsLexical: unreachable('searchMemoryRecordsLexical'),
  };
}

/**
 * Build a synthetic 384-dim embedding whose elements are all the same
 * small constant. Simple and deterministic; the exact values don't
 * matter for the cache — `normalize` will reduce it to a unit vector.
 */
function makeEmbedding(value: number): Float32Array {
  const vec = new Float32Array(384);
  vec.fill(value);
  return vec;
}

/** Compute the L2 norm of a `Float32Array` for normalisation assertions. */
function l2Norm(vec: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vec.length; i += 1) {
    const v = vec[i] as number;
    sum += v * v;
  }
  return Math.sqrt(sum);
}

// ── Test setup / teardown ────────────────────────────────────────────────

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Silence the cache's `console.warn` output across every test so the
  // test runner stays quiet, and so the memory-pressure test can count
  // invocations deterministically.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
    /* no-op */
  });
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('NamespaceVectorCache', () => {
  const NS = '/actor/alice/project/abc/';

  /**
   * Scenario 1: cold miss triggers a `listEmbeddings` call; the second
   * `getOrLoad` on the same namespace is a cache hit and does not
   * re-call storage.
   *
   * Validates: Requirement 7.4
   */
  it('caches the index after a miss and serves subsequent reads from memory', async () => {
    const record = recordFor('mr_01JF8ZS4Z00000000000000001');
    const storage = createStorageStub(
      {
        [NS]: [
          {
            record_id: record.record_id,
            embedding: makeEmbedding(0.1),
            created_at: record.created_at,
          },
        ],
      },
      { [NS]: [record] },
    );

    const cache = createNamespaceVectorCache({ storage });

    const first = await cache.getOrLoad(NS);
    const second = await cache.getOrLoad(NS);

    expect(first).toBe(second); // same reference — served from cache
    expect(storage.listEmbeddings).toHaveBeenCalledTimes(1);
    expect(storage.listMemoryRecords).toHaveBeenCalledTimes(1);
    expect(storage.listEmbeddings).toHaveBeenCalledWith(NS);
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]!.record_id).toBe(record.record_id);
  });

  /**
   * Scenario 2: `invalidate(ns)` drops the cached entry and forces a
   * reload on the next `getOrLoad(ns)`.
   *
   * Validates: Requirement 7.5
   */
  it('invalidate forces a reload on the next getOrLoad', async () => {
    const record = recordFor('mr_01JF8ZS4Z00000000000000002');
    const storage = createStorageStub(
      {
        [NS]: [
          {
            record_id: record.record_id,
            embedding: makeEmbedding(0.2),
            created_at: record.created_at,
          },
        ],
      },
      { [NS]: [record] },
    );

    const cache = createNamespaceVectorCache({ storage });

    const before = await cache.getOrLoad(NS);
    expect(storage.listEmbeddings).toHaveBeenCalledTimes(1);

    cache.invalidate(NS);

    const after = await cache.getOrLoad(NS);
    expect(storage.listEmbeddings).toHaveBeenCalledTimes(2);
    // The rebuilt index must not be the same object reference — it
    // was reconstructed from scratch, and the epoch advanced.
    expect(after).not.toBe(before);
    expect(after.epoch).toBeGreaterThan(before.epoch);
  });

  /**
   * Scenario 3: cached entries exclude records whose embedding is NULL.
   *
   * The cache relies on `listEmbeddings` to pre-filter rows with a
   * NULL blob (see the storage-layer contract). We model that here by
   * having the stub's `listEmbeddings` omit the NULL row while
   * `listMemoryRecords` returns both records. The cache must build an
   * index containing only the record with a real embedding.
   *
   * Validates: Requirement 7.4
   */
  it('entries exclude records with NULL embedding (via listEmbeddings filter)', async () => {
    const withEmbedding = recordFor('mr_01JF8ZS4Z00000000000000003');
    const withoutEmbedding = recordFor('mr_01JF8ZS4Z00000000000000004');

    const storage = createStorageStub(
      {
        // listEmbeddings returns ONLY the record with a real embedding
        [NS]: [
          {
            record_id: withEmbedding.record_id,
            embedding: makeEmbedding(0.3),
            created_at: withEmbedding.created_at,
          },
        ],
      },
      // listMemoryRecords returns BOTH records — the cache must not
      // synthesise an entry for the NULL-embedding one.
      { [NS]: [withEmbedding, withoutEmbedding] },
    );

    const cache = createNamespaceVectorCache({ storage });
    const index = await cache.getOrLoad(NS);

    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]!.record_id).toBe(withEmbedding.record_id);
    expect(
      index.entries.some((e) => e.record_id === withoutEmbedding.record_id),
    ).toBe(false);
  });

  /**
   * Scenario 4: stored `vec_normalised` arrays are L2-normalised —
   * non-zero inputs produce a unit vector, the zero vector passes
   * through as the zero vector (the explicit guard in `normalize`).
   *
   * Validates: Requirement 7.4
   */
  it('stored vectors are L2-normalised (norm ≈ 1, or exactly 0 for degenerate input)', async () => {
    const nonZeroRecord = recordFor('mr_01JF8ZS4Z00000000000000005');
    const zeroRecord = recordFor('mr_01JF8ZS4Z00000000000000006');

    const storage = createStorageStub(
      {
        [NS]: [
          {
            record_id: nonZeroRecord.record_id,
            embedding: makeEmbedding(0.5),
            created_at: nonZeroRecord.created_at,
          },
          {
            record_id: zeroRecord.record_id,
            embedding: makeEmbedding(0), // degenerate zero vector
            created_at: zeroRecord.created_at,
          },
        ],
      },
      { [NS]: [nonZeroRecord, zeroRecord] },
    );

    const cache = createNamespaceVectorCache({ storage });
    const index = await cache.getOrLoad(NS);

    expect(index.entries).toHaveLength(2);

    const byId = new Map(index.entries.map((e) => [e.record_id, e]));
    const nonZero = byId.get(nonZeroRecord.record_id)!;
    const zero = byId.get(zeroRecord.record_id)!;

    // Non-degenerate input → unit vector (allow small FP slack).
    expect(l2Norm(nonZero.vec_normalised)).toBeCloseTo(1, 5);

    // Degenerate zero input → exact zero vector (the `normalize` guard).
    expect(l2Norm(zero.vec_normalised)).toBe(0);
    expect(zero.vec_normalised.every((x) => x === 0)).toBe(true);
  });

  /**
   * Scenario 5: the 500 MiB memory-pressure `console.warn` fires
   * exactly once when the accumulated byte count crosses the threshold
   * and does not re-fire on later loads or reloads.
   *
   * Strategy: the cache charges `entries.length * 1 536` bytes per
   * installed index regardless of the actual `Float32Array` width, so
   * we can cross the threshold cheaply by feeding the mock 1-element
   * embeddings and sharing a single base `MemoryRecord` across all
   * ids. 4 namespaces × 90 000 entries = 360 000 × 1 536 ≈ 527 MiB
   * of *accounted* bytes, comfortably above the 500 MiB threshold.
   * Real heap allocation stays bounded because the normalised output
   * is only 4 bytes per entry.
   *
   * Validates: Requirement 7.4 (cache memory-pressure telemetry)
   */
  it('the 500 MiB memory-pressure warning fires exactly once across loads', async () => {
    // Build 4 namespaces of 90 000 entries each.
    const namespaces = [
      '/actor/alice/project/big1/',
      '/actor/alice/project/big2/',
      '/actor/alice/project/big3/',
      '/actor/alice/project/big4/',
    ];
    const perNs = 90_000;

    const embeddings: Record<
      string,
      Array<{ record_id: string; embedding: Float32Array; created_at: string }>
    > = {};
    const records: Record<string, MemoryRecord[]> = {};

    // Share a single 1-element Float32Array across every entry so the
    // cache's `normalize` pass is cheap and the real heap stays small.
    const tinyEmbedding = new Float32Array([1]);

    // Share one base record shape; only `record_id` changes per entry.
    const baseRecord = makeValidRecord();

    for (let n = 0; n < namespaces.length; n += 1) {
      const ns = namespaces[n]!;
      const embList: Array<{
        record_id: string;
        embedding: Float32Array;
        created_at: string;
      }> = new Array<{
        record_id: string;
        embedding: Float32Array;
        created_at: string;
      }>(perNs);
      const recList: MemoryRecord[] = new Array<MemoryRecord>(perNs);

      for (let i = 0; i < perNs; i += 1) {
        // Use `mr_` + 26-char base32 id. The cache does not validate
        // the id format; any unique string works. We include the
        // namespace index and per-ns index so ids are globally unique.
        const recordId = `mr_${String(n).padStart(2, '0')}${String(i)
          .padStart(24, '0')}`;
        embList[i] = {
          record_id: recordId,
          embedding: tinyEmbedding,
          created_at: baseRecord.created_at,
        };
        // Clone only the record_id onto the shared base reference.
        // The cache stores the object by reference; no parsing occurs.
        recList[i] = { ...baseRecord, record_id: recordId } as MemoryRecord;
      }
      embeddings[ns] = embList;
      records[ns] = recList;
    }

    const storage = createStorageStub(embeddings, records);
    const cache = createNamespaceVectorCache({ storage });

    // Load all four namespaces sequentially. Byte accounting:
    //   after ns1: 90 000 × 1 536 = 138 240 000 B (≈ 131.8 MiB)
    //   after ns2: 276 480 000 B (≈ 263.7 MiB)
    //   after ns3: 414 720 000 B (≈ 395.5 MiB)
    //   after ns4: 552 960 000 B (≈ 527.3 MiB) → crosses 500 MiB
    for (const ns of namespaces) {
      await cache.getOrLoad(ns);
    }

    // Find warnings that match the memory-pressure message. Skip any
    // other warnings (e.g. the `records beyond the limit` one that
    // fires when `total > items.length`; our stub returns `total ===
    // items.length` so this should not trigger, but we filter to be
    // safe).
    const pressureWarnings = warnSpy.mock.calls.filter((call) => {
      const first = call[0];
      return typeof first === 'string' && first.includes('500 MiB');
    });

    expect(pressureWarnings).toHaveLength(1);

    // Re-trigger the path: invalidate and reload one namespace. The
    // warning must NOT fire again because the one-shot flag latches.
    cache.invalidate(namespaces[0]!);
    await cache.getOrLoad(namespaces[0]!);

    const afterReload = warnSpy.mock.calls.filter((call) => {
      const first = call[0];
      return typeof first === 'string' && first.includes('500 MiB');
    });
    expect(afterReload).toHaveLength(1);
  });
});
