/**
 * Per-namespace vector index cache for the hybrid-search read path.
 *
 * The `QueryLayer` (task 8.x) keeps one `NamespaceVectorIndex` per active
 * namespace so every hot-path cosine comparison can run against a pre-
 * normalised `Float32Array` in memory, without re-reading the 1536-byte BLOBs
 * from SQLite. Cache population happens on demand via {@link
 * NamespaceVectorCache.getOrLoad}; cache drop happens via {@link
 * NamespaceVectorCache.invalidate}, which the extraction and backfill
 * workers call after every successful write through the explicit-wiring
 * path described in design § Cache invalidation protocol.
 *
 * Correctness in the presence of concurrent reads is achieved with a
 * per-namespace epoch counter:
 *
 *   1. Each {@link invalidate} call bumps the namespace's epoch and drops the
 *      cached entry.
 *   2. Each {@link getOrLoad} miss snapshots the current epoch at the start,
 *      performs the bulk load and normalisation pass, and then — only if
 *      the epoch has not changed — stores the rebuilt index.
 *   3. An in-flight rebuild whose epoch has advanced returns the freshly
 *      built index to the caller (so the current search is satisfied) but
 *      does NOT install it into the cache. The next {@link getOrLoad} then
 *      rebuilds from storage against the up-to-date data.
 *
 * Memory-pressure telemetry: a single `console.warn` is emitted when the
 * running total of cached vector-index bytes crosses 500 MiB. No eviction
 * is performed — the warning exists so the operator can notice the growth
 * and plan for a future eviction spec (design § Cache memory pressure).
 *
 * Modularity:
 *
 * - This module imports from `src/types/` (for `StorageBackend` and
 *   `MemoryRecord`) and from `../embedding/index.js` (for `normalize`,
 *   `VectorIndexEntry`, and `EMBEDDING_BLOB_BYTES`) only.
 * - No imports from `src/collector/storage/sqlite/`, `src/shim/`,
 *   `src/installer/`, or `src/mcp/`.
 *
 * @see Requirements 7.4, 7.5
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — Vector index cache shape
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Error Handling — Cache memory pressure
 * @module
 */

import type { MemoryRecord, StorageBackend } from '../../types/index.js';
import {
  EMBEDDING_BLOB_BYTES,
  normalize,
  type VectorIndexEntry,
} from '../embedding/index.js';

/**
 * Per-namespace snapshot of the vector corpus, as consumed by
 * {@link topKByCosine} and the hybrid-search read path.
 *
 * - `namespace` is the concrete namespace the index was built for (exact
 *   match; not a prefix).
 * - `epoch` records the per-namespace invalidation counter at the time
 *   the index was installed. Callers that hold onto a
 *   {@link NamespaceVectorIndex} across `await` boundaries can compare
 *   against the current epoch on the cache to detect staleness, though
 *   the typical `QueryLayer` flow re-reads via {@link
 *   NamespaceVectorCache.getOrLoad} on every search.
 * - `entries` is a read-only array of {@link VectorIndexEntry} in the
 *   order returned by `StorageBackend.listEmbeddings`; order is not a
 *   public contract — `topKByCosine` performs its own ranking.
 *
 * Matches the shape declared in design § Vector index cache shape
 * exactly.
 *
 * @see Requirements 7.4, 7.5
 */
export interface NamespaceVectorIndex {
  readonly namespace: string;
  readonly epoch: number;
  readonly entries: ReadonlyArray<VectorIndexEntry>;
}

/**
 * Cache surface consumed by the `QueryLayer` (task 8.x).
 *
 * Intentionally narrow: `getOrLoad` is the sole read entry point, and
 * `invalidate` is the sole write entry point. Callers never mutate the
 * returned {@link NamespaceVectorIndex}.
 *
 * @see Requirements 7.4, 7.5
 */
export interface NamespaceVectorCache {
  /**
   * Return the cached {@link NamespaceVectorIndex} for `namespace`,
   * rebuilding from storage on a cache miss. Never throws for an
   * unknown or empty namespace — an empty result set becomes an
   * index with `entries.length === 0`.
   *
   * The read path is safe against concurrent invalidations: a
   * rebuild that races with {@link invalidate} returns its result to
   * the caller but does not install it into the cache, so subsequent
   * searches see a fresh rebuild against post-write data.
   */
  getOrLoad(namespace: string): Promise<NamespaceVectorIndex>;

  /**
   * Drop the cached index for `namespace` and bump its epoch counter.
   * Called by the extraction and backfill workers after every
   * successful `putMemoryRecord` or `putEmbedding`.
   *
   * Repeated invalidations on an already-empty cache are cheap and
   * safe — each call still increments the epoch, which is how
   * in-flight rebuilds detect that their view is stale.
   */
  invalidate(namespace: string): void;
}

/**
 * Constructor dependencies for {@link createNamespaceVectorCache}.
 *
 * Only the storage backend is injected; the cache has no opinion on
 * the embedder or cosine module — those live at the `QueryLayer`
 * level. This keeps the cache pure enough to unit-test with an
 * in-memory {@link StorageBackend} stub.
 */
export interface NamespaceVectorCacheDeps {
  readonly storage: StorageBackend;
}

/**
 * Threshold at which a single `console.warn` is emitted when the
 * total bytes of cached normalised vectors first crosses it. 500 MiB
 * matches design § Cache memory pressure. Expressed in binary units
 * (1 MiB = 1 024 × 1 024 bytes) to match operator expectations for
 * RSS-style telemetry.
 */
const MEMORY_PRESSURE_WARN_THRESHOLD_BYTES = 500 * 1024 * 1024;

/**
 * Upper bound for the single-page `listMemoryRecords` call used to
 * join metadata onto embeddings. Sized well above the
 * documented 50 000-record scale target so the cache builder does
 * not need a pagination loop for any realistic namespace.
 *
 * If a namespace ever grows past this, the metadata join below
 * silently drops the excess and emits a `console.warn`; the vector
 * entries without matching metadata are skipped rather than allowed
 * through with a synthesised placeholder `MemoryRecord`.
 */
const METADATA_BULK_FETCH_LIMIT = 100_000;

/**
 * Create a {@link NamespaceVectorCache} backed by the given storage.
 *
 * Internal state is closed over by the returned object — it is NOT
 * shared across instances. The collector wiring creates a single
 * cache per `QueryLayer` and reuses it for the lifetime of the
 * daemon process (design § Vector index cache shape).
 *
 * @param deps - Required dependencies; see {@link NamespaceVectorCacheDeps}.
 * @returns A fresh cache with empty internal state.
 *
 * @see Requirements 7.4, 7.5
 */
export function createNamespaceVectorCache(
  deps: NamespaceVectorCacheDeps,
): NamespaceVectorCache {
  const { storage } = deps;

  /** Per-namespace cached indexes. `Map.has` serves as the miss probe. */
  const cache = new Map<string, NamespaceVectorIndex>();

  /**
   * Per-namespace invalidation counter. A namespace that has never
   * been invalidated has an implicit epoch of `0` — we only allocate
   * a map entry once `invalidate` is called, so the `.get(ns) ?? 0`
   * pattern is ubiquitous below.
   */
  const epochs = new Map<string, number>();

  /** Running total of cached `vec_normalised` bytes, across all namespaces. */
  let totalBytes = 0;

  /**
   * Set once the 500 MiB threshold has been crossed. Ensures the
   * `console.warn` fires at most once per cache instance (and
   * therefore at most once per daemon process, since the collector
   * holds exactly one cache).
   */
  let memoryPressureWarned = false;

  /**
   * Read the current epoch for `namespace`, defaulting to `0` for
   * namespaces that have never been invalidated.
   */
  function currentEpoch(namespace: string): number {
    return epochs.get(namespace) ?? 0;
  }

  /**
   * Subtract the byte-cost of `index` from the running
   * {@link totalBytes} counter. Safe to call on any index — the
   * entries are each exactly `EMBEDDING_BLOB_BYTES` bytes wide
   * because `normalize` produces a fresh `Float32Array` of the
   * same length as its input, and every input is the 384-dim
   * embedding read via `listEmbeddings`.
   */
  function releaseBytes(index: NamespaceVectorIndex): void {
    totalBytes -= index.entries.length * EMBEDDING_BLOB_BYTES;
    if (totalBytes < 0) {
      // Defensive: should be unreachable given the accounting
      // discipline below, but if it ever happens (e.g. a race we
      // missed), clamp to zero so we do not emit a spurious warning
      // after the next allocation.
      totalBytes = 0;
    }
  }

  /**
   * Accumulate the byte-cost of `index` into {@link totalBytes} and
   * emit the one-shot memory-pressure warning if this allocation
   * caused the threshold to be crossed.
   */
  function accountBytesAndMaybeWarn(index: NamespaceVectorIndex): void {
    totalBytes += index.entries.length * EMBEDDING_BLOB_BYTES;
    if (
      !memoryPressureWarned &&
      totalBytes > MEMORY_PRESSURE_WARN_THRESHOLD_BYTES
    ) {
      memoryPressureWarned = true;
      // eslint-disable-next-line no-console -- telemetry path; design § Cache memory pressure
      console.warn(
        `NamespaceVectorCache: total cached vector-index bytes (${totalBytes.toString()}) exceeded ${MEMORY_PRESSURE_WARN_THRESHOLD_BYTES.toString()} (500 MiB); no eviction will be performed in this release`,
      );
    }
  }

  /**
   * Build a fresh {@link NamespaceVectorIndex} for `namespace` from
   * storage. Does NOT mutate the cache — the caller decides whether
   * to install the result based on the post-build epoch check.
   *
   * Metadata is fetched via a single `listMemoryRecords` call and
   * joined by `record_id`. Embeddings whose record is missing
   * from the metadata set are skipped with a single-line warning;
   * this should only happen if a record is deleted between the
   * two reads, which is not a supported flow in v1 but is defended
   * against here to avoid a spurious crash.
   */
  async function buildIndex(
    namespace: string,
    startEpoch: number,
  ): Promise<NamespaceVectorIndex> {
    const [embeddings, recordsPage] = await Promise.all([
      storage.listEmbeddings(namespace),
      storage.listMemoryRecords({
        namespace,
        limit: METADATA_BULK_FETCH_LIMIT,
        offset: 0,
      }),
    ]);

    // If the namespace really has more records than the bulk fetch
    // limit, we surface a warning once per build so the operator
    // can notice; the cache itself still works, it simply omits
    // the over-limit records from the vector-side ranking.
    if (recordsPage.total > recordsPage.items.length) {
      // eslint-disable-next-line no-console -- operational warning, not a hot path
      console.warn(
        `NamespaceVectorCache: namespace ${namespace} has ${recordsPage.total.toString()} records but only ${recordsPage.items.length.toString()} were loaded (limit ${METADATA_BULK_FETCH_LIMIT.toString()}); records beyond the limit will not participate in vector ranking`,
      );
    }

    const byId = new Map<string, MemoryRecord>();
    for (const record of recordsPage.items) {
      byId.set(record.record_id, record);
    }

    const entries: VectorIndexEntry[] = [];
    for (const row of embeddings) {
      const record = byId.get(row.record_id);
      if (record === undefined) {
        // Embedding without a matching record — deletion race or
        // storage corruption. Skip rather than crash; the hybrid
        // layer tolerates a smaller vector set.
        // eslint-disable-next-line no-console -- rare, non-fatal
        console.warn(
          `NamespaceVectorCache: embedding for record ${row.record_id} has no matching MemoryRecord in namespace ${namespace}; skipping`,
        );
        continue;
      }
      entries.push({
        record_id: row.record_id,
        record,
        vec_normalised: normalize(row.embedding),
      });
    }

    return {
      namespace,
      epoch: startEpoch,
      entries,
    };
  }

  return {
    async getOrLoad(namespace: string): Promise<NamespaceVectorIndex> {
      const hit = cache.get(namespace);
      if (hit !== undefined) return hit;

      const startEpoch = currentEpoch(namespace);
      const built = await buildIndex(namespace, startEpoch);

      // Race check: if the namespace was invalidated while we were
      // building, return what we built to the current caller but
      // do NOT install it. Next call rebuilds against fresh data.
      if (currentEpoch(namespace) !== startEpoch) {
        return built;
      }

      // Drop any existing index (defensive — `cache.get` returned
      // undefined above, but a concurrent rebuild could have raced
      // us and installed one; if so, account for its bytes first).
      const existing = cache.get(namespace);
      if (existing !== undefined) {
        releaseBytes(existing);
      }

      cache.set(namespace, built);
      accountBytesAndMaybeWarn(built);
      return built;
    },

    invalidate(namespace: string): void {
      const existing = cache.get(namespace);
      if (existing !== undefined) {
        releaseBytes(existing);
        cache.delete(namespace);
      }
      epochs.set(namespace, currentEpoch(namespace) + 1);
    },
  };
}
