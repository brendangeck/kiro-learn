/**
 * Property-based test for embedder output shape (task 4.3).
 *
 * Feature: local-embeddings-and-hybrid-search, Property 4: Embedder
 * output shape is invariant.
 *
 * Unlike the lifecycle unit tests in `embedding-onnx-embedder.test.ts`
 * (which stub `@huggingface/transformers`), this file exercises the
 * **real** feature-extraction pipeline. The goal is to catch shape
 * regressions in the glue between the pipeline's tensor output and
 * the `Float32Array(384)` the collector hands to downstream code —
 * something a stub-only test cannot observe.
 *
 * ## Gating on model availability
 *
 * The test loads the real `Xenova/all-MiniLM-L6-v2` model. That
 * involves either a ~22 MiB download from the HuggingFace CDN on a
 * cold cache or a deserialise of the already-cached weights and a
 * native ONNX runtime session. Both can fail in CI:
 *
 *   - No network (sandboxed CI with a cold model cache).
 *   - Native binaries missing (`npm install --ignore-scripts`
 *     skipped `sharp`'s build; `onnxruntime-node`'s prebuilt
 *     binary may also be absent on some platforms).
 *   - Library version drift with the locally cached weights.
 *
 * Any of these produce a rejection from `embedder.ready()`. When
 * that happens we mark the test as skipped via vitest's `ctx.skip()`
 * mechanism — the whole point of Property 4 is the *shape* of the
 * embedder output, so there is no useful assertion we can make when
 * the model itself cannot start. A skipped test surfaces clearly in
 * vitest output with a console warning explaining why.
 *
 * ### Why `ctx.skip()` and not `describe.skipIf` / `it.skipIf`
 *
 * vitest evaluates the predicate passed to `describe.skipIf` /
 * `it.skipIf` at **test collection time**, before any `beforeAll`
 * hook runs. That means a predicate that depends on the outcome of
 * an async load in `beforeAll` is always evaluated against the
 * pre-load (default) state and the skip decision never reflects the
 * actual load result. The correct pattern is to load in
 * `beforeAll`, stash the outcome in a module-local, and call
 * `ctx.skip()` from inside the test body once the hook has run.
 *
 * **First CI run note.** On a fresh CI machine with no cached model
 * under `modelCacheDir`, the first run of this test downloads the
 * model (seconds to tens of seconds depending on CDN latency). A
 * 60-second `beforeAll` timeout covers that case; subsequent runs
 * resolve from the local cache in under a second and are fully
 * offline. Operators who want a deterministic cold-cache skip can
 * point `KIRO_LEARN_MODEL_DIR` at an empty directory with network
 * disabled — `ready()` will reject and the test will skip.
 *
 * The model cache directory is a per-test-run subdirectory of
 * `os.tmpdir()` so repeated local runs share a single download and
 * do not pollute the user's `~/.kiro-learn/models/` tree. The
 * directory is intentionally NOT deleted between runs; it acts as a
 * warm cache for both local development and CI.
 *
 * ## Property statement
 *
 * For any non-empty input string `s` of length 1 to 10 000:
 *
 *   1. `embedder.embed(s)` returns an instance of `Float32Array`
 *      whose `.length` is exactly 384 (the MiniLM-L6-v2 hidden size
 *      after mean pooling).
 *   2. Every element of the returned vector is finite
 *      (`Number.isFinite` true) — no `NaN`, no `±Infinity`.
 *   3. The L2 norm of the returned vector is strictly greater than
 *      zero, so cosine similarity downstream is well-defined
 *      outside the explicit zero-norm guard.
 *
 * ## Run budget
 *
 * The property runs 100 iterations (design § Correctness Properties,
 * traceability table row for Property 4). Each `embed` call on a
 * warm pipeline is ~5–20 ms on a modest laptop CPU; 100 × 20 ms =
 * ~2 s, well inside the unit-test budget.
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Property 4: Embedder output shape is invariant
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md
 *      § Requirements 1.1, 1.2, 17.1, 17.2, 17.4
 * @see src/collector/embedding/onnx-embedder.ts
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Embedder } from '../../src/collector/embedding/onnx-embedder.js';
import { createOnnxEmbedder } from '../../src/collector/embedding/onnx-embedder.js';

// ── Model cache dir ─────────────────────────────────────────────────────
//
// A dedicated test cache dir keeps real-model downloads off the
// user's `~/.kiro-learn/models/` tree and lets repeated runs reuse
// the same weights. The directory is created ahead of time so
// `@huggingface/transformers` does not have to handle the mkdir
// race itself.

const MODEL_CACHE_DIR = join(tmpdir(), 'kiro-learn-test-models');
try {
  mkdirSync(MODEL_CACHE_DIR, { recursive: true });
} catch {
  // Directory creation failures are tolerated here — the embedder
  // load in `beforeAll` will surface them and cause the test to
  // skip. We do not want to throw at module evaluation time because
  // vitest would then abort the whole worker process.
}

// ── Embedder load (gated) ───────────────────────────────────────────────
//
// We try to load the real model exactly once per suite. On success,
// `embedder` is the ready-to-call embedder and `loadError` stays
// `null`. On failure (no network + cold cache, missing native binary,
// etc.), `embedder` stays `null`, `loadError` holds the captured
// error, and the `ctx.skip()` inside the test body skips with a
// clear console warning.

let embedder: Embedder | null = null;
let loadError: Error | null = null;

beforeAll(async () => {
  const candidate = createOnnxEmbedder({
    modelCacheDir: MODEL_CACHE_DIR,
    // Generous per-call timeout: the first `embed()` on a warm
    // pipeline can still take a few hundred ms on cold CPU caches.
    // The cap protects only against a wedged session, not against
    // normal warm-up latency.
    perCallTimeoutMs: 10_000,
  });

  try {
    await candidate.ready();
    embedder = candidate;
  } catch (err) {
    loadError = err instanceof Error ? err : new Error(String(err));
  }
}, 60_000);

/**
 * Compute the L2 norm of a `Float32Array` in 64-bit arithmetic.
 *
 * We use `number` precision for the accumulator (not `float32`) so
 * the L2 > 0 assertion is not fooled by a tiny-but-nonzero embedding
 * whose squared norm underflows to zero in `float32`. The model
 * outputs are bounded well away from that regime, but the broader
 * property statement in design.md § Property 4 — "L2 norm strictly
 * greater than zero" — is a mathematical claim, and checking it in
 * `number` precision matches that intent.
 */
function l2Norm(v: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < v.length; i += 1) {
    const x = v[i] as number;
    sumSq += x * x;
  }
  return Math.sqrt(sumSq);
}

describe('Feature: local-embeddings-and-hybrid-search, Property 4: Embedder output shape is invariant', () => {
  it('returns a Float32Array(384) with all-finite elements and positive L2 norm for any non-empty string of length 1–10 000', async (ctx) => {
    /**
     * **Validates: Requirements 1.1, 1.2, 17.1, 17.2, 17.4**
     *
     * For any non-empty input string of length 1 to 10 000, the
     * embedder's output is a `Float32Array` of length exactly 384
     * (Req 1.1, 1.2, 17.1), every element is finite (Req 17.2), and
     * the L2 norm is strictly greater than zero (Req 17.4). The
     * property runs 100 iterations because each call hits the real
     * pipeline — see the file-level TSDoc for the latency budget.
     *
     * Input generation uses `fc.string({ minLength: 1, maxLength:
     * 10_000 })` directly so we cover the full character-count
     * range called out in the requirement. fast-check's default
     * `fc.string` emits a mix of ASCII, Unicode, and control
     * characters, which is exactly the kind of arbitrary text the
     * model will see in production extraction input.
     */
    if (embedder === null) {
      // eslint-disable-next-line no-console
      console.warn(
        '[embedding-embedder-shape.property.test] Skipped: embedder.ready() rejected. ' +
          'First CI run downloads the ~22 MiB MiniLM-L6-v2 model to ' +
          `${MODEL_CACHE_DIR}; subsequent runs use the local cache and are offline. ` +
          `Original error: ${loadError?.message ?? 'unknown'}`,
      );
      ctx.skip();
      return;
    }
    // Snapshot into a local const so the narrowing survives across
    // the async property callback.
    const e = embedder;

    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1, maxLength: 10_000 }), async (input) => {
        const vec = await e.embed(input);

        // Shape: concrete Float32Array, exact dimensionality.
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(384);

        // Finiteness: every element. A single `NaN` or `±Infinity`
        // would poison every downstream cosine computation, so we
        // assert element-wise rather than via a summary statistic.
        for (let i = 0; i < vec.length; i += 1) {
          const x = vec[i] as number;
          if (!Number.isFinite(x)) {
            // Include the offending index + value in the failure
            // message so the fast-check shrink output pinpoints
            // which embedding element went bad.
            throw new Error(
              `embedding element at index ${String(i)} is not finite: ${String(x)}`,
            );
          }
        }

        // Non-degenerate output: strictly positive L2 norm so
        // cosine similarity downstream is well-defined outside the
        // explicit zero-norm guard (Req 7.6 handles that guard
        // elsewhere).
        expect(l2Norm(vec)).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});
