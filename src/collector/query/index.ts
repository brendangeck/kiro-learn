/**
 * Query — the retrieval surface over stored memory records.
 *
 * v1: lexical search against FTS5, scoped by namespace.
 * v2 (this module): hybrid retrieval that fuses the FTS5 ranking
 * with cosine similarity against a per-namespace vector index, via
 * Reciprocal Rank Fusion. Falls back to lexical-only whenever the
 * embedder is absent, not ready, or fails on the query — so the
 * read path is strictly additive and never regresses below the
 * pre-embedding baseline.
 *
 * This file is the seam between the storage backend and the
 * retrieval assembler. It owns the per-`QueryLayer`
 * {@link NamespaceVectorCache} so every active namespace's
 * normalised vector index is held in memory for the lifetime of
 * the daemon process.
 *
 * ## Algorithm (task 8.2)
 *
 * 1. Compute `fetchDepth = limit * fetchDepthMultiplier` (default
 *    `40` at `limit = 10`) and call
 *    `storage.searchMemoryRecordsLexical({namespace, query,
 *    limit: fetchDepth})` — always run lexical first so the
 *    response is at least as good as the pre-spec baseline.
 * 2. Empty-query short-circuit: if lexical found nothing AND the
 *    Unicode-whitespace tokenisation of `query` yields zero
 *    tokens, return `[]` without invoking the embedder (Req 6.4,
 *    16.7).
 * 3. If `embedder === null || !embedder.isReady()`, return the
 *    lexical top-`limit` records. This is the flag-off and
 *    degraded-mode path (Req 9.4, 16.4, 16.5).
 * 4. Try `embedder.embed(query)`. On any error, log a single
 *    warning and return the lexical top-`limit`. The read path
 *    never throws on embed failure (Req 16.3).
 * 5. Load or refresh the per-namespace vector index via
 *    `cache.getOrLoad(namespace)` and compute the top-`fetchDepth`
 *    cosine ranking via `topKByCosine`.
 * 6. Fuse the two rankings via `rrfFuse` with `k = rrfK` (default
 *    `60`) and a pre-tie-break truncation cap of `limit * 2`.
 * 7. Join fused ids back to `MemoryRecord`s — prefer the lexical
 *    result objects (already carry the record), fall back to the
 *    cache's vector index for vector-only hits, drop anything not
 *    found (rare: a concurrent delete between lex and vec reads).
 * 8. Final tie-break on `(fused_score DESC, created_at DESC,
 *    record_id ASC)` and return the top-`limit` records
 *    (Req 5.8, 16.6).
 *
 * ## Modularity
 *
 * This module imports from `src/types/` (for `StorageBackend` and
 * `MemoryRecord`), from `../embedding/index.js` (for the
 * `Embedder` type, `topKByCosine`, and `rrfFuse`), from
 * `./vector-cache.js`, and from `./tokenize.js`. It MUST NOT
 * import from `src/collector/storage/sqlite/`, `src/shim/`,
 * `src/installer/`, or `src/mcp/` — the guard tests under
 * `test/unit/no-*.test.ts` enforce this.
 *
 * @see Requirements 5.1, 5.2, 5.4, 5.5, 5.7, 5.8, 6.1, 6.2, 6.3,
 *      6.4, 9.4, 12.1, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — `QueryLayer` — modified
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Sequence: hybrid search on read
 * @module
 */

import type { MemoryRecord, StorageBackend } from '../../types/index.js';
import type { Embedder, Ranked } from '../embedding/index.js';
import { rrfFuse, topKByCosine } from '../embedding/index.js';

import { tokenizeForQuery } from './tokenize.js';
import {
  createNamespaceVectorCache,
  type NamespaceVectorCache,
} from './vector-cache.js';

/**
 * Tunable knobs for the hybrid-search implementation. Every field is
 * optional — callers typically omit the config entirely and get the
 * defaults documented below.
 *
 * @see Requirements 5.3, 12.1
 */
export interface QueryLayerConfig {
  /**
   * Reciprocal-rank-fusion constant `k`. Larger values flatten the
   * weight the top-ranked items receive from each source; smaller
   * values sharpen it. Default `60` matches design § `QueryLayer`
   * — modified and Requirement 5.3.
   */
  rrfK?: number;

  /**
   * Multiplier applied to the caller-supplied `limit` when fetching
   * from each ranked source before fusion. A value of `4` means a
   * request for `limit=10` pulls 40 lexical and 40 vector
   * candidates into the RRF step, giving the tie-break logic enough
   * headroom to reorder the short list. Default `4` matches design
   * § `QueryLayer` — modified.
   */
  fetchDepthMultiplier?: number;
}

/**
 * Constructor dependencies for {@link createQueryLayer}.
 *
 * - `storage` is the backend the lexical path and the vector cache
 *   both read from. It is the only module allowed to know the
 *   concrete database implementation.
 * - `embedder` is `null` when the embedding feature flag is off
 *   (design § Feature flag; Req 12.5). In that case the query layer
 *   operates in lexical-only mode forever — it does not retry, does
 *   not warn, and does not allocate the vector cache's internal
 *   state until a search needs it.
 * - `config` is the partial tuning object described on
 *   {@link QueryLayerConfig}.
 *
 * @see Requirements 5.3, 5.7, 12.1
 */
export interface QueryLayerDeps {
  readonly storage: StorageBackend;
  /** `null` means the embedding feature flag is off — lexical-only for the process lifetime. */
  readonly embedder: Embedder | null;
  readonly config?: QueryLayerConfig;
}

/**
 * The query layer interface. Delegates to the storage backend for
 * the lexical path and to the embedder + vector cache for the
 * vector path, fused via RRF.
 *
 * Extended in task 8.1 with {@link QueryLayer.invalidateNamespace},
 * which the extraction and backfill workers call after every
 * successful embedding write so the next search sees the fresh
 * vector. See design § Cache invalidation protocol.
 *
 * @see Requirements 5.1, 5.7
 */
export interface QueryLayer {
  /**
   * Return up to `limit` memory records for `query` scoped to
   * `namespace`. Results are returned in ranked order as defined
   * by the hybrid algorithm documented at the top of this module.
   *
   * Never throws on embedder failure — see the module TSDoc for
   * the full fallback chain.
   */
  search(namespace: string, query: string, limit: number): Promise<MemoryRecord[]>;

  /**
   * Drop the cached vector index for `namespace` and bump its
   * epoch counter. Called by the extraction and backfill workers
   * after every successful `putEmbedding` via the explicit-wiring
   * invalidation protocol (design § Cache invalidation protocol).
   *
   * Safe to call for unknown namespaces — the underlying cache
   * allocates an epoch lazily.
   *
   * @see Requirements 5.7
   */
  invalidateNamespace(namespace: string): void;
}

/**
 * Default RRF `k`. Matches design § `QueryLayer` — modified and
 * Requirement 5.3.
 */
const DEFAULT_RRF_K = 60;

/**
 * Default fetch-depth multiplier. Matches design § `QueryLayer` —
 * modified. Sized so that `limit=10` requests pull 40 candidates
 * from each ranked source — enough for the RRF tie-break to settle
 * without ballooning the per-query allocation.
 */
const DEFAULT_FETCH_DEPTH_MULTIPLIER = 4;

/**
 * Create a query layer backed by the given storage and (optional)
 * embedder.
 *
 * The returned layer owns a private {@link NamespaceVectorCache}
 * constructed from `{ storage }`. Cache lifetime equals the
 * `QueryLayer` instance lifetime — the collector wiring creates one
 * cache per daemon process via this factory. When the feature flag
 * is off (`embedder === null`), the cache is still constructed (so
 * downstream invalidation callbacks are no-ops rather than type
 * errors), but the hybrid path short-circuits before ever calling
 * into it.
 *
 * Results are returned in ranked order. An empty result set is
 * returned as an empty array, never an error.
 *
 * @see Requirements 5.1, 5.3, 5.7, 12.1
 */
export function createQueryLayer(deps: QueryLayerDeps): QueryLayer {
  const { storage, embedder, config } = deps;

  const rrfK = config?.rrfK ?? DEFAULT_RRF_K;
  const fetchDepthMultiplier =
    config?.fetchDepthMultiplier ?? DEFAULT_FETCH_DEPTH_MULTIPLIER;

  // Per-`QueryLayer` vector index cache. Lifetime equals this
  // factory's returned object. The cache is intentionally
  // allocated even when `embedder === null`, so
  // `invalidateNamespace` stays a cheap no-op regardless of
  // feature-flag state — this keeps the extraction/backfill
  // workers from needing to branch on flag state before calling
  // the invalidation hook.
  const cache: NamespaceVectorCache = createNamespaceVectorCache({ storage });

  return {
    async search(namespace: string, query: string, limit: number): Promise<MemoryRecord[]> {
      // Step 0: a non-positive limit has no sensible meaning for
      // a top-k search. Return empty rather than probing storage.
      if (limit <= 0) return [];

      const fetchDepth = limit * fetchDepthMultiplier;

      // Step 1: always run lexical first (Req 16.1). The rank
      // field is what feeds RRF — we never reconstruct it from
      // array order.
      const lexRanked = await storage.searchMemoryRecordsLexical({
        namespace,
        query,
        limit: fetchDepth,
      });

      // Step 2: empty-query short-circuit (Req 6.4, 16.7). If
      // lexical found nothing AND the tokeniser is empty, the
      // query is effectively whitespace-only or non-matching
      // gibberish; the embedder would run but yield a vector
      // with no meaningful neighbours. Short-circuit to `[]`
      // without paying the embedder round-trip.
      if (lexRanked.length === 0 && tokenizeForQuery(query).length === 0) {
        return [];
      }

      // Step 3: if the embedder is absent (flag off) or not
      // ready (load failed, or not yet resolved), return
      // lexical-only top-`limit` (Req 9.4, 16.4, 16.5). This is
      // the degraded-mode path.
      if (embedder === null || !embedder.isReady()) {
        return lexRanked.slice(0, limit).map((r) => r.record);
      }

      // Step 4: compute the query embedding. On any error we log
      // a single warning and fall back to lexical-only — the
      // read path never throws on embedder failure (Req 16.3).
      let queryVec: Float32Array;
      try {
        queryVec = await embedder.embed(query);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Direct stderr write: avoids pulling a logger dependency
        // into this pure-ish module and matches the style used
        // by the ExtractionWorker warning path.
        process.stderr.write(
          `[kiro-learn] hybrid search falling back to lexical after embedder failure: ${message}\n`,
        );
        return lexRanked.slice(0, limit).map((r) => r.record);
      }

      // Step 5: load/refresh the per-namespace vector index and
      // score the corpus against `queryVec`. `getOrLoad` is
      // race-safe against concurrent invalidations (see
      // vector-cache.ts).
      const index = await cache.getOrLoad(namespace);
      const vecRanked = topKByCosine(queryVec, index, fetchDepth);

      // Step 6: adapt both rankings to the `Ranked` shape RRF
      // expects. The cosine ranking is 0-indexed array order;
      // we convert to 1-based rank by adding 1. The lexical
      // ranking already carries a 1-based rank from the storage
      // layer.
      const lexRankedForFusion: Ranked[] = lexRanked.map((r) => ({
        record_id: r.record.record_id,
        rank: r.rank,
      }));
      const vecRankedForFusion: Ranked[] = vecRanked.map((hit, i) => ({
        record_id: hit.record_id,
        rank: i + 1,
      }));
      const fused = rrfFuse(
        lexRankedForFusion,
        vecRankedForFusion,
        rrfK,
        limit * 2,
      );

      // Step 7: join fused ids back to full `MemoryRecord`s. The
      // lexical side is authoritative (its records came straight
      // from storage and reflect the latest `putMemoryRecord`);
      // the cache side provides any vector-only hits. Anything
      // absent from both is dropped silently — that would
      // require a race with a record deletion, which is not a
      // supported flow in v1 but we guard defensively anyway.
      const byId = new Map<string, MemoryRecord>();
      for (const r of lexRanked) {
        byId.set(r.record.record_id, r.record);
      }
      for (const entry of index.entries) {
        if (!byId.has(entry.record_id)) {
          byId.set(entry.record_id, entry.record);
        }
      }

      // Step 8: final tie-break. RRF's internal sort is
      // `(fused_score DESC, record_id ASC)`; Req 5.8 demands the
      // richer `(fused_score DESC, created_at DESC, record_id
      // ASC)` ordering once we have the metadata joined. We sort
      // the joined list explicitly here rather than trying to
      // push `created_at` into RRF, because RRF is intentionally
      // metadata-agnostic (it operates on ids and ranks only).
      const joined = fused
        .map((f) => {
          const record = byId.get(f.record_id);
          return record !== undefined ? { fused: f, record } : null;
        })
        .filter((x): x is { fused: (typeof fused)[number]; record: MemoryRecord } => x !== null);

      joined.sort((a, b) => {
        if (a.fused.fused_score !== b.fused.fused_score) {
          return b.fused.fused_score - a.fused.fused_score;
        }
        // `created_at` is an ISO-8601 datetime string. Lexical
        // comparison gives chronological order because every
        // value carries a zero-padded, fixed-precision offset
        // (enforced by the Zod schema).
        if (a.record.created_at !== b.record.created_at) {
          return a.record.created_at < b.record.created_at ? 1 : -1;
        }
        if (a.record.record_id < b.record.record_id) return -1;
        if (a.record.record_id > b.record.record_id) return 1;
        return 0;
      });

      return joined.slice(0, limit).map((x) => x.record);
    },

    invalidateNamespace(namespace: string): void {
      cache.invalidate(namespace);
    },
  };
}
