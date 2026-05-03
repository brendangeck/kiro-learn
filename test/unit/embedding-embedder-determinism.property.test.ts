/**
 * Property-based test for embedder determinism (task 4.4).
 *
 * Feature: local-embeddings-and-hybrid-search, Property 5: Embedder
 * is deterministic within a process.
 *
 * Like the shape test in `embedding-embedder-shape.property.test.ts`
 * (task 4.3), this file exercises the **real**
 * `@huggingface/transformers` feature-extraction pipeline. Stub-
 * based lifecycle tests in `embedding-onnx-embedder.test.ts` cannot
 * catch determinism regressions in the glue between the pipeline's
 * tensor output and the `Float32Array(384)` the collector hands to
 * downstream code — only a real-pipeline test can observe whether
 * two back-to-back `embed(s)` calls produce bitwise-identical
 * output.
 *
 * ## Gating on model availability
 *
 * The test loads the real `Xenova/all-MiniLM-L6-v2` model. That can
 * fail in CI for the same reasons catalogued in the shape test's
 * file-level TSDoc (no network on cold cache, missing native
 * binaries, library drift). Any of those produce a rejection from
 * `embedder.ready()`; we mark the test as skipped via vitest's
 * `ctx.skip()` mechanism and emit a `console.warn` that explains
 * why. Determinism is a property of the embedder output, so there
 * is no useful assertion we can make when the pipeline itself
 * cannot start.
 *
 * We deliberately reuse the same `MODEL_CACHE_DIR`
 * (`tmpdir()/kiro-learn-test-models`) as the shape test so that a
 * single model download warms both suites. On a cold CI machine
 * whichever test runs first pays the download cost; the other
 * resolves from the local cache in under a second.
 *
 * ### Why `ctx.skip()` and not `describe.skipIf` / `it.skipIf`
 *
 * See the shape test's file-level TSDoc — same reasoning applies.
 * `describe.skipIf` / `it.skipIf` evaluate their predicate at test
 * collection time, before `beforeAll` runs, so a predicate that
 * depends on the outcome of an async model load always sees the
 * pre-load (default) state. The correct pattern is to load in
 * `beforeAll`, stash the outcome in a module-local, and call
 * `ctx.skip()` from inside the test body.
 *
 * ## Property statement
 *
 * For any non-empty input string `s` of length 1 to 10 000, two
 * sequential `embedder.embed(s)` calls return `Float32Array` values
 * whose underlying `Uint32Array` views are bitwise-equal.
 *
 * Bitwise comparison is asserted via reinterpret-cast through a
 * `Uint32Array` view of each array's byte buffer, the same pattern
 * used in Property 1 (`embedding-blob-roundtrip.property.test.ts`).
 * A `Float32Array#toEqual` check would treat NaN as never-equal
 * (`NaN !== NaN` in IEEE 754) and would ignore the `+0` / `-0`
 * distinction. Neither is expected for well-trained MiniLM outputs
 * in practice, but the property is a strict bitwise claim, and the
 * `Uint32Array` view is what makes that observable. vitest's
 * `toEqual` compares `Uint32Array`s element-wise on the 32-bit
 * unsigned numeric values, so the assertion becomes a direct bit
 * comparison after the cast.
 *
 * ## Run budget
 *
 * The property runs 50 iterations (design § Correctness Properties,
 * traceability table row for Property 5). Each iteration makes TWO
 * `embed` calls on the warm pipeline, so the effective call count
 * is 100 — still comfortably inside the unit-test budget at
 * ~5–20 ms per call.
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Property 5: Embedder is deterministic within a process
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md
 *      § Requirements 1.3, 17.3
 * @see test/unit/embedding-embedder-shape.property.test.ts — sibling
 *      real-pipeline property test for output shape (Property 4)
 * @see test/unit/embedding-blob-roundtrip.property.test.ts — the
 *      `Uint32Array` reinterpret-cast pattern used here comes from
 *      the BLOB round-trip test (Property 1)
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
// Shared with `embedding-embedder-shape.property.test.ts` so a
// single warm cache serves both real-pipeline property tests. The
// directory is created ahead of time — `@huggingface/transformers`
// does not need to race the mkdir itself.

const MODEL_CACHE_DIR = join(tmpdir(), 'kiro-learn-test-models');
try {
  mkdirSync(MODEL_CACHE_DIR, { recursive: true });
} catch {
  // Tolerate mkdir failures here — the embedder load in `beforeAll`
  // will surface them and cause the test to skip. Throwing at
  // module-evaluation time would abort the whole vitest worker.
}

// ── Embedder load (gated) ───────────────────────────────────────────────
//
// Load the real model exactly once per suite. On success, `embedder`
// is the ready-to-call embedder and `loadError` stays `null`. On
// failure (no network + cold cache, missing native binary, etc.),
// `embedder` stays `null`, `loadError` holds the captured error,
// and the `ctx.skip()` inside the test body skips with a clear
// console warning.

let embedder: Embedder | null = null;
let loadError: Error | null = null;

beforeAll(async () => {
  const candidate = createOnnxEmbedder({
    modelCacheDir: MODEL_CACHE_DIR,
    // Generous per-call timeout: first `embed()` after warm-up can
    // still take a few hundred ms on cold CPU caches. The cap
    // protects only against a wedged session, not against normal
    // warm-up latency.
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
 * Reinterpret a `Float32Array`'s bytes as an array of 32-bit
 * unsigned integers so bitwise equality can be asserted. Using
 * `Uint32Array` (rather than `Float32Array#toEqual`) is what makes
 * NaN bit patterns and the `+0` / `-0` distinction observable:
 * `NaN !== NaN` and `+0 === -0` in IEEE 754 semantics, so a direct
 * `Float32Array` comparison would silently accept those
 * differences. The returned `readonly number[]` is the shape
 * vitest's `toEqual` understands most directly. This matches the
 * `bitsOf` helper used by the BLOB round-trip property test
 * (Property 1) — same pattern, same intent.
 */
function bitsOf(vec: Float32Array): readonly number[] {
  const view = new Uint32Array(vec.buffer, vec.byteOffset, vec.length);
  return Array.from(view);
}

describe('Feature: local-embeddings-and-hybrid-search, Property 5: Embedder is deterministic within a process', () => {
  it('returns bitwise-identical Float32Arrays for two sequential embed(s) calls on any non-empty string of length 1–10 000', async (ctx) => {
    /**
     * **Validates: Requirements 1.3, 17.3**
     *
     * For any non-empty input string of length 1 to 10 000, two
     * sequential `embedder.embed(s)` calls return `Float32Array`
     * values whose underlying `Uint32Array` views are bitwise-
     * equal. Req 1.3 states that the embedder must produce
     * deterministic output for identical inputs; Req 17.3 makes
     * that same claim explicit in the correctness-properties
     * section of the requirements doc.
     *
     * The property runs 50 iterations because each iteration
     * makes two real-pipeline calls — see the file-level TSDoc
     * for the latency budget. Input generation uses `fc.string({
     * minLength: 1, maxLength: 10_000 })` directly so coverage
     * spans the full character-count range called out in the
     * requirement. fast-check's default `fc.string` emits a mix
     * of ASCII, Unicode, and control characters, matching the
     * arbitrary text the model will see in production extraction
     * input.
     *
     * The two `embed` calls run strictly sequentially (one
     * `await` between them) to mirror the collector's write-path
     * access pattern — ExtractionWorker never issues concurrent
     * `embed` calls for the same record. Concurrent-call
     * determinism is not part of this property and is not
     * asserted here.
     */
    if (embedder === null) {
      // eslint-disable-next-line no-console
      console.warn(
        '[embedding-embedder-determinism.property.test] Skipped: embedder.ready() rejected. ' +
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
        // Two sequential calls — no overlap, no shared in-flight
        // promise. Determinism must hold for this exact access
        // pattern, which is what the collector's write path uses.
        const first = await e.embed(input);
        const second = await e.embed(input);

        // Shape sanity. The shape property test (Property 4)
        // owns the primary shape assertion; checking it here
        // guards against a silently-broken pipeline that would
        // otherwise make the bitwise comparison vacuously true.
        expect(first).toBeInstanceOf(Float32Array);
        expect(second).toBeInstanceOf(Float32Array);
        expect(first.length).toBe(384);
        expect(second.length).toBe(384);

        // Bitwise equality via `Uint32Array` views. This is the
        // strict form of the determinism claim: every one of the
        // 384 × 32 = 12 288 bits must match across the two
        // calls. See the `bitsOf` doc comment for why this is
        // stronger than `expect(second).toEqual(first)` on
        // `Float32Array` directly.
        expect(bitsOf(second)).toEqual(bitsOf(first));
      }),
      { numRuns: 50 },
    );
  }, 60_000);
});
