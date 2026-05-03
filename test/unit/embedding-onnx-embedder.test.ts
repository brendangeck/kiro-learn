/**
 * Unit tests for {@link createOnnxEmbedder} lifecycle (task 4.2).
 *
 * The `@huggingface/transformers` module is stubbed at the factory
 * boundary with `vi.mock` so these tests run without touching disk,
 * network, or the ONNX runtime. Each test configures the mocked
 * `pipeline` function to simulate a particular load / call outcome
 * and then asserts on the observable behaviour of the embedder
 * surface:
 *
 *   - `ready()` is idempotent: repeated calls reuse the single
 *     memoised load promise and trigger exactly one `pipeline(...)`
 *     invocation.
 *   - `isReady()` transitions only one-way: `false` before load
 *     resolves, `true` after success, `false` *permanently* after a
 *     load rejection. A failed load does not reset on re-entry and
 *     subsequent `embed()` calls reject immediately with the same
 *     error.
 *   - Per-call timeout: if the pipeline's callable never settles,
 *     `embed()` rejects with an `embed timeout` error within a
 *     small window around `perCallTimeoutMs`.
 *   - Truncation: inputs longer than `maxInputChars` are sliced to
 *     exactly `maxInputChars` code units before being handed to the
 *     pipeline. The untruncated original is not observable inside
 *     the pipeline call.
 *   - `dim` is the literal `384` constant.
 *
 * Validates: Requirements 1.1, 1.2, 2.1, 2.4, 10.3, 10.4
 *
 * @see src/collector/embedding/onnx-embedder.ts
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — `Embedder` interface
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Degraded-mode state machine
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pipeline } from '@huggingface/transformers';

import { createOnnxEmbedder } from '../../src/collector/embedding/onnx-embedder.js';

// ── Module mock ─────────────────────────────────────────────────────────
//
// The factory below hoists above every `import` in this file (the
// `vi.mock` transform moves it to the top of the module). We import
// the real `pipeline` name above purely so `vi.mocked(pipeline)` has
// a handle we can configure per-test. `env` is stubbed to a plain
// object so `env.cacheDir = ...` inside the module under test is a
// no-op but type-compatible with the real `env` export.

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
  env: {} as Record<string, unknown>,
}));

/**
 * The real `pipeline` export from `@huggingface/transformers` has a
 * heavily overloaded signature that varies by task and returns a
 * discriminated union of concrete pipeline classes. Our mock only
 * needs to stand in for the `feature-extraction` task: a callable
 * that takes a string + options and returns `{ data }`. The cast
 * below narrows `vi.mocked(pipeline)` down to a looser shape so
 * `mockResolvedValueOnce(fakeCallable)` type-checks without us
 * having to forge the full `FeatureExtractionPipeline` class
 * surface (tokenizer, model, dispose, _call, task, …).
 */
type FakeCallable = (
  input: string,
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array }>;

const mockedPipeline = vi.mocked(pipeline) as unknown as ReturnType<
  typeof vi.fn<(...args: Parameters<typeof pipeline>) => Promise<FakeCallable>>
>;

/**
 * Build a fake feature-extraction callable that resolves to a
 * 384-element `Float32Array` wrapped in the pipeline's `{ data }`
 * shape. The spy returned by this helper lets tests assert on the
 * exact input the pipeline received (used by the truncation test).
 */
function makeFakeCallable(): ReturnType<typeof vi.fn> & FakeCallable {
  return vi.fn().mockResolvedValue({ data: new Float32Array(384) }) as ReturnType<
    typeof vi.fn
  > &
    FakeCallable;
}

beforeEach(() => {
  // `clearMocks: true` + `restoreMocks: true` in vitest.config.ts
  // wipes call history and restores spies between tests, but the
  // `mockedPipeline` reference itself is a persistent `vi.fn()` —
  // reset its implementation + history explicitly so stale
  // `mockResolvedValueOnce` / `mockRejectedValueOnce` queues from
  // the previous test never leak forward.
  mockedPipeline.mockReset();
});

describe('createOnnxEmbedder — dim', () => {
  it('exposes the fixed 384-dim constant', () => {
    const embedder = createOnnxEmbedder({});
    expect(embedder.dim).toBe(384);
  });
});

describe('createOnnxEmbedder — ready() idempotency', () => {
  it('kicks off a single load regardless of how many times ready() is called', async () => {
    mockedPipeline.mockResolvedValueOnce(makeFakeCallable());

    const embedder = createOnnxEmbedder({});

    // Two concurrent ready() calls should both resolve without
    // triggering a second load. The `async` wrapper around the
    // module's `load()` creates a fresh outer Promise per call but
    // both await the same memoised underlying load promise, so the
    // observable invariant is "pipeline invoked exactly once",
    // not "Promise identities are ===".
    const p1 = embedder.ready();
    const p2 = embedder.ready();
    await Promise.all([p1, p2]);

    // A third call after resolution must still be a no-op load-wise.
    await embedder.ready();

    expect(mockedPipeline).toHaveBeenCalledTimes(1);
    expect(embedder.isReady()).toBe(true);
  });
});

describe('createOnnxEmbedder — isReady() transitions', () => {
  it('is false before ready() resolves, true after success', async () => {
    // Hold the load in flight until the test releases it so we can
    // observe the pre-resolution state.
    let releaseLoad: ((value: FakeCallable) => void) | undefined;
    mockedPipeline.mockImplementationOnce(
      () =>
        new Promise<FakeCallable>((resolve) => {
          releaseLoad = resolve;
        }),
    );

    const embedder = createOnnxEmbedder({});

    // No `ready()` called yet → embedder is not ready.
    expect(embedder.isReady()).toBe(false);

    const readyPromise = embedder.ready();
    // Pending load → still not ready.
    expect(embedder.isReady()).toBe(false);

    // Release the load, await, then confirm the flag flipped.
    expect(releaseLoad).toBeDefined();
    releaseLoad!(makeFakeCallable());
    await readyPromise;

    expect(embedder.isReady()).toBe(true);
  });

  it('is false permanently after load rejection', async () => {
    const loadError = new Error('model load failed');
    mockedPipeline.mockRejectedValueOnce(loadError);

    const embedder = createOnnxEmbedder({});

    // First ready() surfaces the rejection. Catch it so the test
    // body keeps running.
    await expect(embedder.ready()).rejects.toBe(loadError);
    expect(embedder.isReady()).toBe(false);

    // Re-entering ready() must NOT retry the load and must reject
    // with the SAME error (the memoised rejected promise).
    await expect(embedder.ready()).rejects.toBe(loadError);
    expect(mockedPipeline).toHaveBeenCalledTimes(1);
    expect(embedder.isReady()).toBe(false);

    // embed() after a failed load rejects immediately with the
    // original error; the pipeline is never re-invoked for any
    // downstream inference call.
    await expect(embedder.embed('hello')).rejects.toBe(loadError);
    expect(mockedPipeline).toHaveBeenCalledTimes(1);
    expect(embedder.isReady()).toBe(false);
  });
});

describe('createOnnxEmbedder — per-call timeout', () => {
  it('rejects embed() with a timeout error when the pipeline hangs', async () => {
    // The pipeline loads fine, but the returned callable never
    // settles — simulating a wedged ONNX session.
    const hangingCallable: FakeCallable & ReturnType<typeof vi.fn> = vi.fn(
      () => new Promise<{ data: Float32Array }>(() => {}),
    ) as FakeCallable & ReturnType<typeof vi.fn>;
    mockedPipeline.mockResolvedValueOnce(hangingCallable);

    const perCallTimeoutMs = 100;
    const embedder = createOnnxEmbedder({ perCallTimeoutMs });

    const started = Date.now();
    await expect(embedder.embed('hello')).rejects.toThrow(/embed timeout/);
    const elapsed = Date.now() - started;

    // The race should fire within a small window around the
    // configured timeout. The upper bound is generous (5× the
    // timeout) to stay robust on a loaded CI machine while still
    // being well below any default test timeout.
    expect(elapsed).toBeGreaterThanOrEqual(perCallTimeoutMs - 20);
    expect(elapsed).toBeLessThan(perCallTimeoutMs * 5 + 200);
    expect(hangingCallable).toHaveBeenCalledTimes(1);
  });
});

describe('createOnnxEmbedder — input truncation', () => {
  it('truncates input longer than maxInputChars before calling the pipeline', async () => {
    const callable = makeFakeCallable();
    mockedPipeline.mockResolvedValueOnce(callable);

    const embedder = createOnnxEmbedder({});

    // Default `maxInputChars` is 10_000. Feed 20_000 characters in
    // and assert the pipeline received exactly the first 10_000.
    const longInput = 'x'.repeat(20_000);
    await embedder.embed(longInput);

    expect(callable).toHaveBeenCalledTimes(1);
    const passedInput = callable.mock.calls[0]?.[0] as string;
    expect(typeof passedInput).toBe('string');
    expect(passedInput.length).toBe(10_000);
    expect(passedInput).toBe('x'.repeat(10_000));
  });

  it('passes shorter inputs through unchanged', async () => {
    const callable = makeFakeCallable();
    mockedPipeline.mockResolvedValueOnce(callable);

    const embedder = createOnnxEmbedder({});

    const shortInput = 'hello world';
    await embedder.embed(shortInput);

    expect(callable).toHaveBeenCalledTimes(1);
    expect(callable.mock.calls[0]?.[0]).toBe(shortInput);
  });

  it('honours a custom maxInputChars override', async () => {
    const callable = makeFakeCallable();
    mockedPipeline.mockResolvedValueOnce(callable);

    const embedder = createOnnxEmbedder({ maxInputChars: 16 });
    await embedder.embed('x'.repeat(1_000));

    expect(callable).toHaveBeenCalledTimes(1);
    const passedInput = callable.mock.calls[0]?.[0] as string;
    expect(passedInput.length).toBe(16);
  });
});
