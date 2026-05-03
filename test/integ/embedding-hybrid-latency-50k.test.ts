/**
 * Integration benchmark: hybrid-search latency at 50 000 records
 * (task 16.3).
 *
 * Seeds a namespace with 50 000 embedded memory records, then runs
 * 20 `QueryLayer.search` calls and asserts the p95 latency is below
 * the 500 ms budget from Requirement 9.1. The first measured call
 * is discarded as a warm-up — the per-namespace vector-index cache
 * is cold on that call and the measurement would otherwise include
 * the one-shot 50 000-record `listEmbeddings` scan + normalise cost.
 *
 * ## Seeding strategy
 *
 * 50 000 records × two inserts each (primary row + FTS companion) =
 * 100 000 statements. Calling the `StorageBackend` methods
 * sequentially wraps each pair in its own `BEGIN/COMMIT`, which on
 * a modest laptop SSD runs at ~5 k insert pairs per second and would
 * dominate test wall time. We side-step that by issuing the bulk
 * load through a dedicated raw `better-sqlite3` handle inside a
 * **single** transaction — SQLite then fuses the WAL writes into
 * one commit fsync and the whole seed completes in a handful of
 * seconds. The same `.db` file is subsequently served through a
 * standard `openSqliteStorage` handle for the measurement phase,
 * so the query path is unchanged from production wiring.
 *
 * Integration tests are allowed to import `better-sqlite3` directly
 * — the "no sqlite outside src/collector/storage/sqlite" guard is
 * scoped to production modules under `src/`.
 *
 * ## Why the real embedder
 *
 * The hybrid read path's bottleneck at 50 k records is still the
 * cosine scan (50 000 × 384 dot products ≈ 20 million multiplies)
 * plus the query embedding. Using a stubbed embedder would trade
 * the query-embedding cost (5–20 ms) for ~0 and inflate the budget
 * headroom, so we drive the hybrid layer with the real
 * `OnnxEmbedder` and gate on model availability.
 *
 * ## Why deterministic pseudo-random embeddings
 *
 * This benchmark measures performance, not retrieval quality. Each
 * record's embedding is a deterministic random unit vector seeded
 * by its row index. Keeping the seeding deterministic makes latency
 * measurements comparable across runs while still giving the
 * cosine pass 50 000 distinct vectors to chew through. Using the
 * real embedder to compute 50 k vectors would multiply seed time
 * by ~10× with no observable benchmark benefit.
 *
 * ## CI opt-out
 *
 * Some CI environments cannot spare the minutes this benchmark
 * needs. Setting `KIRO_LEARN_SKIP_LARGE_BENCHMARK=1` (any non-empty
 * value) skips the test cleanly. That behaviour is intentional and
 * mirrors the model-availability gate — a missing environment
 * capability is not a regression.
 *
 * Run with: `npm run test:integ`.
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md § 9.1
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md § 16.3
 * @see src/collector/query/index.ts
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import Database from 'better-sqlite3';
import { ulid } from 'ulidx';
import { beforeAll, describe, expect, it } from 'vitest';

import { encodeEmbeddingBlob } from '../../src/collector/embedding/blob.js';
import type { Embedder } from '../../src/collector/embedding/index.js';
import { createOnnxEmbedder } from '../../src/collector/embedding/index.js';
import { createQueryLayer } from '../../src/collector/query/index.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';

// ── Constants ───────────────────────────────────────────────────────────

const NAMESPACE = '/actor/bench/project/hybrid-50k/';
const SEED_COUNT = 50_000;
const MEASURED_QUERIES = 20;
/** p95 latency budget from Requirement 9.1 (ms). */
const P95_BUDGET_MS = 500;
/** Result limit per hybrid query. Matches the default collector
 * `resultLimit` so the benchmark reflects production sizing. */
const SEARCH_LIMIT = 10;

/** Per-call embedder timeout. Generous so a slow CI host does not
 * spuriously fail a run before we have percentile data. */
const PER_CALL_TIMEOUT_MS = 10_000;

/** Overall test timeout. 8 minutes covers a cold CI box: first-run
 * model download (≤ 60 s), 50 k-row seed in a single transaction
 * (tens of seconds), cache warm-up (≈ 1 s to normalise 50 k vectors
 * on a modern CPU), and 20 measured queries with a generous tail
 * allowance. */
const SUITE_TIMEOUT_MS = 8 * 60_000;

// ── Helpers ─────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function nextPseudoRandom(state: { s: number }): number {
  state.s = (state.s * 1_664_525 + 1_013_904_223) >>> 0;
  return state.s / 0x80_00_00_00 - 1;
}

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

function buildRandomUnitVector(seed: number, state: { s: number }): Float32Array {
  // Re-seed the LCG at each call so different row indices produce
  // different vectors but a fixed index always produces the same
  // vector across runs. XOR with Knuth's multiplicative hash makes
  // adjacent seeds spread through the state space.
  state.s = ((seed * 2_654_435_761) >>> 0) ^ 0xDEAD_BEEF;
  const vec = new Float32Array(384);
  for (let i = 0; i < 384; i += 1) {
    vec[i] = nextPseudoRandom(state);
  }
  return normalizeInPlace(vec);
}

const TITLE_WORDS = [
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

// ── Environment gates ───────────────────────────────────────────────────

const skipLargeBenchmark =
  (process.env['KIRO_LEARN_SKIP_LARGE_BENCHMARK'] ?? '') !== '';

let embedder: Embedder | null = null;
let loadError: Error | null = null;

beforeAll(async () => {
  if (skipLargeBenchmark) return;

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

// ── Bulk seeding via a raw `better-sqlite3` handle ──────────────────────

/**
 * Seed `SEED_COUNT` memory records and their embeddings into the
 * SQLite file at `dbPath` using a single transaction over a raw
 * `better-sqlite3` handle. Returns when the commit completes.
 *
 * The schema must already have been initialised on `dbPath` — the
 * caller runs `openSqliteStorage` first (and closes that handle)
 * to apply migrations 0001..0005 before this function opens its
 * own handle. Using two sequential handles on a file-backed DB is
 * safe because SQLite's locking protocol serialises them; we never
 * hold both open at once.
 */
function bulkSeed(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    const insertRecord = db.prepare<[
      string, string, string, string, string, string, string, string, string, string, string,
    ]>(
      `INSERT INTO memory_records (
         record_id, namespace, strategy, title, summary,
         facts_json, source_event_ids_json, created_at,
         concepts_json, files_touched_json, observation_type
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertRecordFts = db.prepare<[string, string, string, string, string]>(
      `INSERT INTO memory_records_fts (
         record_id, namespace, title, summary, facts_text
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const updateEmbedding = db.prepare<[Buffer, string]>(
      `UPDATE memory_records SET embedding = ? WHERE record_id = ?`,
    );

    const sourceEventId = ulid();
    const rngState = { s: 1 };

    const runAll = db.transaction((): void => {
      for (let i = 0; i < SEED_COUNT; i += 1) {
        const w1 = TITLE_WORDS[i % TITLE_WORDS.length]!;
        const w2 = TITLE_WORDS[(i * 7 + 3) % TITLE_WORDS.length]!;
        const w3 = TITLE_WORDS[(i * 13 + 5) % TITLE_WORDS.length]!;
        const recordId = `mr_${ulid()}`;
        const title = `${w1} ${w2} record #${String(i)}`;
        const summary = `A synthetic record about ${w1}, ${w2}, and ${w3} for the 50k hybrid-latency benchmark.`;
        const facts = [`${w1} is relevant`, `${w2} interacts with ${w3}`];
        const factsText = facts.join(' ');
        const createdAt = new Date(
          Date.UTC(2026, 0, 1, 0, 0, 0, 0) + i * 1_000,
        ).toISOString();

        insertRecord.run(
          recordId,
          NAMESPACE,
          'benchmark-seed',
          title,
          summary,
          JSON.stringify(facts),
          JSON.stringify([sourceEventId]),
          createdAt,
          JSON.stringify([w1, w2]),
          JSON.stringify([`src/${w1}/${w2}.ts`]),
          'pattern',
        );
        insertRecordFts.run(recordId, NAMESPACE, title, summary, factsText);

        const vec = buildRandomUnitVector(i, rngState);
        updateEmbedding.run(encodeEmbeddingBlob(vec), recordId);
      }
    });
    runAll();
  } finally {
    db.close();
  }
}

// ── Test ────────────────────────────────────────────────────────────────

describe('Feature: local-embeddings-and-hybrid-search, Task 16.3: hybrid latency benchmark at 50 000 records', () => {
  it(
    `seeds ${String(SEED_COUNT)} records and asserts hybrid-search p95 < ${String(P95_BUDGET_MS)} ms over ${String(MEASURED_QUERIES)} queries`,
    async (ctx) => {
      if (skipLargeBenchmark) {
        // eslint-disable-next-line no-console
        console.warn(
          '[embedding-hybrid-latency-50k] Skipped: KIRO_LEARN_SKIP_LARGE_BENCHMARK is set.',
        );
        ctx.skip();
        return;
      }
      if (embedder === null) {
        // eslint-disable-next-line no-console
        console.warn(
          '[embedding-hybrid-latency-50k] Skipped: embedder.ready() rejected. ' +
            'First run downloads the ~22 MiB MiniLM-L6-v2 model to ' +
            `${MODEL_CACHE_DIR}; subsequent runs use the local cache and are offline. ` +
            `Original error: ${loadError?.message ?? 'unknown'}`,
        );
        ctx.skip();
        return;
      }
      const e = embedder;

      // File-backed DB so we can open a second raw handle for the
      // single-transaction bulk seed. :memory: cannot be shared
      // across handles, and a file-backed DB is still fast enough
      // because the seed is one fsync.
      const tmpDir = mkdtempSync(join(tmpdir(), 'kiro-learn-hybrid-50k-'));
      const dbPath = join(tmpDir, 'bench.db');

      try {
        // Phase 1: apply schema migrations via the production
        // storage factory, then close so the raw handle can take
        // exclusive access for the bulk seed.
        const seedStorage = openSqliteStorage({ dbPath });
        await seedStorage.close();

        // Phase 2: bulk seed inside a single transaction.
        const seedStart = performance.now();
        bulkSeed(dbPath);
        const seedMs = performance.now() - seedStart;
        // eslint-disable-next-line no-console
        console.log(
          `[embedding-hybrid-latency-50k] seeded ${String(SEED_COUNT)} records in ${seedMs.toFixed(0)}ms`,
        );

        // Phase 3: re-open via `openSqliteStorage` and run the
        // measured queries through a real `QueryLayer`.
        const storage = openSqliteStorage({ dbPath });
        try {
          const queryLayer = createQueryLayer({ storage, embedder: e });

          // Warm-up: first call pays the cache-miss cost for the
          // per-namespace vector index (one `listEmbeddings` scan
          // + 50 000 × 384-float normalise). Subsequent calls hit
          // the warm cache and reflect steady-state latency.
          const warmStart = performance.now();
          await queryLayer.search(NAMESPACE, QUERY_POOL[0]!, SEARCH_LIMIT);
          const warmMs = performance.now() - warmStart;
          // eslint-disable-next-line no-console
          console.log(
            `[embedding-hybrid-latency-50k] cache warm-up query: ${warmMs.toFixed(0)}ms`,
          );

          const timingsMs: number[] = [];
          for (let i = 0; i < MEASURED_QUERIES; i += 1) {
            const q = QUERY_POOL[i % QUERY_POOL.length]!;
            const t0 = performance.now();
            // eslint-disable-next-line no-await-in-loop -- measurement demands serial calls
            const results = await queryLayer.search(NAMESPACE, q, SEARCH_LIMIT);
            const t1 = performance.now();
            timingsMs.push(t1 - t0);

            // Sanity: at most SEARCH_LIMIT records, all within
            // NAMESPACE.
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
            `[embedding-hybrid-latency-50k] seeded=${String(SEED_COUNT)} ` +
              `queries=${String(MEASURED_QUERIES)} ` +
              `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms ` +
              `p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms`,
          );

          expect(p95).toBeLessThan(P95_BUDGET_MS);
        } finally {
          await storage.close();
        }
      } finally {
        // Best-effort cleanup of the temp DB. `rmSync` with
        // `force: true` tolerates the file already being gone
        // (e.g. due to a prior failure that already unlinked it).
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    },
    SUITE_TIMEOUT_MS,
  );
});
