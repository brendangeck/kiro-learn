/**
 * Integration benchmark: `OnnxEmbedder.embed()` latency (task 16.1).
 *
 * Runs 100 embeds of a 4 000-character input through the real
 * `Xenova/all-MiniLM-L6-v2` feature-extraction pipeline and asserts
 * that the p95 measurement is below the 100 ms budget from Requirement
 * 10.1 (after cold start). The first 10 calls are discarded as a
 * warm-up so the measurement reflects steady-state latency rather
 * than first-call JIT/tensor-pool initialisation.
 *
 * ## Gating on model availability
 *
 * The benchmark loads the real ONNX model. Any of the following make
 * that impossible in CI:
 *
 * - No network access with a cold model cache (the ~22 MiB weight
 *   file has never been downloaded on this machine).
 * - Missing native binaries (`npm install --ignore-scripts` skipped
 *   `onnxruntime-node`'s postinstall build).
 * - Library version drift against the locally cached weights.
 *
 * When `embedder.ready()` rejects we mark the test skipped via
 * `ctx.skip()` and log a single warning explaining what went wrong.
 * There is no useful assertion we can make about embedder latency
 * when the embedder itself cannot start, and failing the suite in
 * that state would turn a legitimate environment gap into a false
 * regression signal.
 *
 * The cache directory is a dedicated `os.tmpdir()` subdirectory so
 * repeated local runs share a single download and do not pollute
 * the user's `~/.kiro-learn/models/` tree. The directory is NOT
 * cleaned between runs — it acts as a warm cache for both local
 * development and CI.
 *
 * ## Why p95 and not mean/max
 *
 * Mean can be skewed low by many fast calls and miss a real tail.
 * Max is too noisy in CI (one GC pause ruins the run). p95 is the
 * metric Requirement 10.1 targets explicitly and matches the
 * project-wide retrieval budget framing (Req 9.1 / 9.3 also use
 * p95). The measurement uses `performance.now()` for sub-ms
 * resolution.
 *
 * Run with: `npm run test:integ`.
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md § 10.1
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md § 16.1
 * @see src/collector/embedding/onnx-embedder.ts
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Embedder } from '../../src/collector/embedding/index.js';
import { createOnnxEmbedder } from '../../src/collector/embedding/index.js';

// ── Constants ───────────────────────────────────────────────────────────

/** Total measured calls after warm-up. */
const MEASURED_ITERATIONS = 100;

/** Discarded warm-up calls; not included in the p95 percentile. */
const WARMUP_ITERATIONS = 10;

/** p95 latency budget from Requirement 10.1 (ms). */
const P95_BUDGET_MS = 100;

/** Input character length from task 16.1. */
const INPUT_CHARS = 4_000;

/** Per-call embedder timeout. Generous so a slow CI box does not
 * spuriously fail the run before we have data to assert on. */
const PER_CALL_TIMEOUT_MS = 10_000;

/** Overall test timeout: 100 calls × (~100 ms budget + headroom) +
 * warm-up + model load. 120 s is roomy enough for a first-run model
 * download on a slow CDN. */
const SUITE_TIMEOUT_MS = 120_000;

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Return the p-th percentile of a sorted numeric array using
 * nearest-rank (ceiling). For p = 0.95 and length = 100 this selects
 * the 95th value (index 94).
 */
function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

/**
 * Deterministic 4 000-char input. Uses a simple repeating word
 * pattern rather than `'a'.repeat(4000)` so the tokenizer does
 * meaningful work (a single-char input collapses to very few
 * tokens; we want the full ~256-token path to match production
 * conditions).
 */
function buildInput(nChars: number): string {
  const word = 'kiro memory record embedding performance benchmark ';
  // Pre-allocate a string the right size, then slice to exact length.
  // Using `String.prototype.repeat` once and slicing is O(n) and
  // avoids quadratic concatenation.
  const needed = Math.ceil(nChars / word.length);
  return word.repeat(needed).slice(0, nChars);
}

// ── Model cache dir ─────────────────────────────────────────────────────

const MODEL_CACHE_DIR = join(tmpdir(), 'kiro-learn-test-models');
try {
  mkdirSync(MODEL_CACHE_DIR, { recursive: true });
} catch {
  // Directory creation failures are tolerated here — the embedder
  // load in `beforeAll` will surface them and cause the test to
  // skip. We do not throw at module evaluation time.
}

// ── Embedder load (gated) ───────────────────────────────────────────────

/** Loaded embedder plus the `dispose` handle `createOnnxEmbedder` returns. */
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

// Release the ONNX pipeline on suite teardown so consecutive
// integration tests do not accumulate `sharp` / `onnxruntime-node`
// worker threads. See the 1k latency test for the full rationale.
afterAll(() => {
  if (embedder === null) return;
  embedder.dispose();
  embedder = null;
});

// ── Test ────────────────────────────────────────────────────────────────

describe('Feature: local-embeddings-and-hybrid-search, Task 16.1: embedding latency benchmark', () => {
  it(
    `runs ${String(MEASURED_ITERATIONS)} embeds of a ${String(INPUT_CHARS)}-char input and asserts p95 < ${String(P95_BUDGET_MS)} ms after warm-up`,
    async (ctx) => {
      if (embedder === null) {
        // eslint-disable-next-line no-console
        console.warn(
          '[embedding-embed-latency] Skipped: embedder.ready() rejected. ' +
            'First run downloads the ~22 MiB MiniLM-L6-v2 model to ' +
            `${MODEL_CACHE_DIR}; subsequent runs use the local cache and are offline. ` +
            `Original error: ${loadError?.message ?? 'unknown'}`,
        );
        ctx.skip();
        return;
      }
      const e = embedder;
      const input = buildInput(INPUT_CHARS);

      // Warm-up: a handful of calls to let the ONNX runtime stabilise
      // its tensor pools and the JIT settle on hot paths. These
      // timings are deliberately discarded — cold-start latency is
      // measured elsewhere (Req 2.5) and is not what this benchmark
      // targets.
      for (let i = 0; i < WARMUP_ITERATIONS; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- measurement demands serial calls
        await e.embed(input);
      }

      // Measurement phase.
      const timingsMs: number[] = [];
      for (let i = 0; i < MEASURED_ITERATIONS; i += 1) {
        const t0 = performance.now();
        // eslint-disable-next-line no-await-in-loop -- measurement demands serial calls
        const vec = await e.embed(input);
        const t1 = performance.now();
        timingsMs.push(t1 - t0);

        // Sanity checks: the embedder must still return well-shaped
        // vectors across the whole benchmark. A shape regression under
        // load would otherwise ride silently into the percentile.
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(384);
      }

      const sorted = [...timingsMs].sort((a, b) => a - b);
      const p50 = percentile(sorted, 0.5);
      const p95 = percentile(sorted, 0.95);
      const p99 = percentile(sorted, 0.99);
      const max = sorted[sorted.length - 1]!;

      // eslint-disable-next-line no-console
      console.log(
        `[embedding-embed-latency] iterations=${String(MEASURED_ITERATIONS)} ` +
          `p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms ` +
          `p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms`,
      );

      expect(p95).toBeLessThan(P95_BUDGET_MS);
    },
    SUITE_TIMEOUT_MS,
  );
});
