/**
 * Integration benchmark: hybrid-search latency at 1 000 records
 * (task 16.2).
 *
 * Seeds an in-memory SQLite namespace with 1 000 embedded memory
 * records, then runs 100 `QueryLayer.search` calls and asserts the
 * p95 latency is below the 100 ms budget from Requirement 9.3. The
 * first measured call is discarded as a warm-up — the per-namespace
 * vector-index cache is cold on that call and the measurement would
 * otherwise include the one-shot `listEmbeddings` + normalise cost.
 *
 * ## Why the real embedder
 *
 * The hybrid read path's single most expensive step is the query
 * embedding — a real ONNX pipeline call that costs 5–20 ms on a
 * modern CPU. Using a stubbed embedder that returns a canned vector
 * would make the benchmark trivially pass (cosine + RRF fuse in
 * well under a millisecond against 1 000 pre-normalised vectors) and
 * hide the component that actually bounds user-visible latency. So
 * we drive the hybrid layer with the real `OnnxEmbedder` and gate
 * the whole suite on model availability.
 *
 * ## Why random embeddings for the seed
 *
 * This benchmark measures performance, not retrieval quality. Every
 * record's embedding is a fresh `Float32Array(384)` of uniformly
 * random floats in `[-1, 1]`, L2-normalised before `putEmbedding`.
 * Random vectors give us realistic cosine work (the cache-builder
 * normalises them, the cosine pass does a dot product per record,
 * RRF fuses the resulting rankings) without paying the embedding
 * cost 1 000 times during setup. Correctness properties live in the
 * property-based test suite — they are not in scope here.
 *
 * ## Gating
 *
 * Skips cleanly when `embedder.ready()` rejects. Same rationale as
 * `embedding-embed-latency.test.ts` — no useful assertion is
 * available when the model cannot load, and failing the suite in
 * that state would turn a legitimate environment gap (cold cache +
 * no network; missing native binaries) into a false regression.
 *
 * Run with: `npm run test:integ`.
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md § 9.3
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md § 16.2
 * @see src/collector/query/index.ts
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { ulid } from 'ulidx';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Embedder } from '../../src/collector/embedding/index.js';
import { createOnnxEmbedder } from '../../src/collector/embedding/index.js';
import { createQueryLayer } from '../../src/collector/query/index.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { MemoryRecord, StorageBackend } from '../../src/types/index.js';

// ── Constants ───────────────────────────────────────────────────────────

const NAMESPACE = '/actor/bench/project/hybrid-1k/';
const SEED_COUNT = 1_000;
const MEASURED_QUERIES = 100;
/** p95 latency budget from Requirement 9.3 (ms). */
const P95_BUDGET_MS = 100;
/** Result limit per hybrid query. Matches the default collector
 * `resultLimit` so the benchmark reflects production sizing. */
const SEARCH_LIMIT = 10;

/** Per-call embedder timeout. Generous so a slow CI host does not
 * spuriously fail a run before we have percentile data. */
const PER_CALL_TIMEOUT_MS = 10_000;

/** Overall test timeout: seed + 100 queries + model load + warm-up.
 * 3 minutes is comfortably above the steady-state expectation
 * (~1 s seeding, ~5 s measurement) while leaving headroom for
 * first-run model download. */
const SUITE_TIMEOUT_MS = 180_000;

// ── Helpers ─────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

/**
 * Deterministic-but-varied pseudo-random in `[-1, 1]` seeded by a
 * 32-bit integer counter. A linear-congruential generator is
 * sufficient here: we only need vectors that are not all equal and
 * are cheap to produce for 1 000 × 384 = 384 000 floats.
 *
 * Using `Math.random()` would also work but is
 * non-reproducible — keeping the seeding deterministic makes
 * latency measurements comparable across runs.
 */
function nextPseudoRandom(state: { s: number }): number {
  // Numerical recipes LCG constants. State is mutated in place.
  state.s = (state.s * 1_664_525 + 1_013_904_223) >>> 0;
  // Map to [-1, 1].
  return state.s / 0x80_00_00_00 - 1;
}

/** L2-normalise in place. Returns the same array for call-site chaining. */
function normalizeInPlace(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i += 1) {
    const x = v[i] as number;
    sumSq += x * x;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < v.length; i += 1) {
      v[i] = (v[i] as number) / norm;
    }
  }
  return v;
}

/** Build a random unit vector seeded by `seed`. */
function buildRandomUnitVector(seed: number): Float32Array {
  const state = { s: (seed * 2_654_435_761) >>> 0 };
  const vec = new Float32Array(384);
  for (let i = 0; i < 384; i += 1) {
    vec[i] = nextPseudoRandom(state);
  }
  return normalizeInPlace(vec);
}

/**
 * Produce a small pool of query strings so the benchmark exercises
 * different lexical matches across its 100 calls. Each query is
 * picked to contain at least one token that appears in the seeded
 * records (so FTS5 has work to do), but is short and realistic.
 */
const QUERY_POOL = [
  'memory record',
  'embedding vector',
  'cosine similarity',
  'hybrid search',
  'lexical ranking',
  'token fusion',
  'recall quality',
  'retrieval budget',
  'namespace scope',
  'performance benchmark',
];

// ── Model cache dir ─────────────────────────────────────────────────────

const MODEL_CACHE_DIR = join(tmpdir(), 'kiro-learn-test-models');
try {
  mkdirSync(MODEL_CACHE_DIR, { recursive: true });
} catch {
  // Tolerated — see embedding-embed-latency.test.ts for rationale.
}

// ── Embedder load (gated) ───────────────────────────────────────────────

/**
 * The loaded embedder plus the `dispose` handle that
 * {@link createOnnxEmbedder} returns. Typed as the intersection so
 * the {@link afterAll} teardown can call `dispose()` without a cast.
 */
type LoadedEmbedder = Embedder & { dispose: () => void };

let embedder: LoadedEmbedder | null = null;
let loadError: Error | null = null;

beforeAll(async () => {
  const candidate = createOnnxEmbedder({
    modelCacheDir: MODEL_CACHE_DIR,
    perCallTimeoutMs: PER_CALL_TIMEOUT_MS,
  });

  try {
    await candidate.ready();
    embedder = candidate;
  } catch (err) {
    loadError = err instanceof Error ? err : new Error(String(err));
  }
}, 60_000);

// Release the ONNX pipeline on suite teardown. `createOnnxEmbedder`
// attaches `sharp` + `onnxruntime-node` native handles on load; not
// disposing them leaks worker threads across consecutive integration
// tests and can slow down `npm run test:integ` or, on some
// platforms, trip Vitest's "Worker terminated" watchdog. The dispose
// method is a pure reference-drop — no await, no I/O — so the
// teardown is cheap and safe even when the load failed (`embedder`
// is still `null` in that case and we short-circuit).
afterAll(() => {
  if (embedder === null) return;
  embedder.dispose();
  embedder = null;
});

// ── Seeding ─────────────────────────────────────────────────────────────

/**
 * Seed `SEED_COUNT` embedded memory records into `storage` under
 * `NAMESPACE`. Each record carries a distinct title/summary/facts
 * triple so FTS5 tokenisation has meaningful work to do, and a
 * freshly generated random unit vector as its embedding.
 */
async function seedCorpus(storage: StorageBackend): Promise<void> {
  // Vocabulary chosen so every query in QUERY_POOL has lexical hits
  // somewhere in the corpus.
  const titleWords = [
    'memory',
    'record',
    'embedding',
    'vector',
    'cosine',
    'similarity',
    'hybrid',
    'search',
    'lexical',
    'ranking',
    'token',
    'fusion',
    'recall',
    'quality',
    'retrieval',
    'budget',
    'namespace',
    'scope',
    'performance',
    'benchmark',
  ] as const;

  // Single source event ULID shared across records — content of the
  // field is irrelevant to the benchmark, and validating 1 000 × 1
  // unique ULIDs would just add setup cost.
  const sourceEventId = ulid();

  for (let i = 0; i < SEED_COUNT; i += 1) {
    const w1 = titleWords[i % titleWords.length]!;
    const w2 = titleWords[(i * 7 + 3) % titleWords.length]!;
    const w3 = titleWords[(i * 13 + 5) % titleWords.length]!;
    const record: MemoryRecord = {
      record_id: `mr_${ulid()}`,
      namespace: NAMESPACE,
      strategy: 'benchmark-seed',
      title: `${w1} ${w2} record #${String(i)}`,
      summary: `A synthetic record about ${w1}, ${w2}, and ${w3} for the 1k hybrid-latency benchmark.`,
      facts: [`${w1} is relevant`, `${w2} interacts with ${w3}`],
      source_event_ids: [sourceEventId],
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60, 0)).toISOString(),
      concepts: [w1, w2],
      files_touched: [`src/${w1}/${w2}.ts`],
      observation_type: 'pattern',
    };
    // Storage methods are async by contract but synchronous under
    // better-sqlite3; awaiting each call is cheap and keeps the
    // ordering deterministic.
    // eslint-disable-next-line no-await-in-loop -- deterministic ordering
    await storage.putMemoryRecord(record);
    // eslint-disable-next-line no-await-in-loop -- deterministic ordering
    await storage.putEmbedding(record.record_id, buildRandomUnitVector(i));
  }
}

// ── Test ────────────────────────────────────────────────────────────────

describe('Feature: local-embeddings-and-hybrid-search, Task 16.2: hybrid latency benchmark at 1 000 records', () => {
  it(
    `seeds ${String(SEED_COUNT)} records and asserts hybrid-search p95 < ${String(P95_BUDGET_MS)} ms over ${String(MEASURED_QUERIES)} queries`,
    async (ctx) => {
      if (embedder === null) {
        // eslint-disable-next-line no-console
        console.warn(
          '[embedding-hybrid-latency-1k] Skipped: embedder.ready() rejected. ' +
            'First run downloads the ~22 MiB MiniLM-L6-v2 model to ' +
            `${MODEL_CACHE_DIR}; subsequent runs use the local cache and are offline. ` +
            `Original error: ${loadError?.message ?? 'unknown'}`,
        );
        ctx.skip();
        return;
      }
      const e = embedder;

      const storage = openSqliteStorage({ dbPath: ':memory:' });
      try {
        await seedCorpus(storage);

        const queryLayer = createQueryLayer({ storage, embedder: e });

        // Warm-up: first call pays the cache-miss cost for the
        // per-namespace vector index (single `listEmbeddings`
        // scan + 1 000 × 384-float normalise). Subsequent calls
        // hit the warm cache and reflect steady-state latency.
        await queryLayer.search(NAMESPACE, QUERY_POOL[0]!, SEARCH_LIMIT);

        const timingsMs: number[] = [];
        for (let i = 0; i < MEASURED_QUERIES; i += 1) {
          const q = QUERY_POOL[i % QUERY_POOL.length]!;
          const t0 = performance.now();
          // eslint-disable-next-line no-await-in-loop -- measurement demands serial calls
          const results = await queryLayer.search(NAMESPACE, q, SEARCH_LIMIT);
          const t1 = performance.now();
          timingsMs.push(t1 - t0);

          // Sanity: we get at most SEARCH_LIMIT records, all within
          // NAMESPACE. Regressions that return too many records or
          // cross namespaces would ride silently into the percentile.
          expect(results.length).toBeLessThanOrEqual(SEARCH_LIMIT);
          for (const r of results) {
            expect(r.namespace).toBe(NAMESPACE);
          }
        }

        const sorted = [...timingsMs].sort((a, b) => a - b);
        const p50 = percentile(sorted, 0.5);
        const p95 = percentile(sorted, 0.95);
        const p99 = percentile(sorted, 0.99);
        const max = sorted[sorted.length - 1]!;

        // eslint-disable-next-line no-console
        console.log(
          `[embedding-hybrid-latency-1k] seeded=${String(SEED_COUNT)} ` +
            `queries=${String(MEASURED_QUERIES)} ` +
            `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms ` +
            `p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms`,
        );

        expect(p95).toBeLessThan(P95_BUDGET_MS);
      } finally {
        await storage.close();
      }
    },
    SUITE_TIMEOUT_MS,
  );
});
