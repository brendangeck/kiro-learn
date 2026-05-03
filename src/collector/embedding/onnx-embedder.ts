/**
 * Concrete ONNX embedder wrapping `@huggingface/transformers`.
 *
 * Loads the `Xenova/all-MiniLM-L6-v2` feature-extraction pipeline on
 * demand and exposes the tiny {@link Embedder} surface the rest of the
 * collector consumes. The design is lazy-load + memoised-promise + one-
 * way degraded-mode: once the model fails to load, the embedder stays
 * in a permanent not-ready state for the lifetime of the process. See
 * design § Degraded-mode state machine.
 *
 * ## Lifecycle
 *
 * - {@link createOnnxEmbedder} returns synchronously. Construction is
 *   pure configuration; no I/O happens until the first `ready()` or
 *   `embed()` call.
 * - `ready()` kicks off a single model load via `pipeline(...)` and
 *   memoises the resulting promise. Every subsequent `ready()` call
 *   returns the same promise. Repeated calls after a load failure
 *   return the original rejected promise — the load is never retried.
 * - `embed(input)` awaits `ready()` internally so callers never have
 *   to chain `await embedder.ready()` explicitly, though the collector
 *   bootstrap does so anyway to catch load errors before binding the
 *   HTTP listener (design § `createOnnxEmbedder` returns immediately).
 * - On any `embed` call after a failed load, the returned promise
 *   rejects immediately with the original load error. The model is
 *   not re-loaded: by design (Req 2.2), recovery requires a daemon
 *   restart.
 * - `dispose()` (optional) drops the internal pipeline reference so
 *   tests can force-reload a fresh embedder. The underlying ONNX
 *   session is not explicitly freed — `@huggingface/transformers`
 *   4.2 does not expose a public dispose hook on the returned
 *   pipeline; if a future version does, this is the hook to call it.
 *
 * ## Timeout semantics
 *
 * `embed` wraps the pipeline invocation in a `Promise.race` against a
 * `setTimeout` that rejects with an `embed timeout` error after
 * `perCallTimeoutMs` (default 2000 ms, Req 10.3). The pipeline call
 * itself is NOT cancellable — `@huggingface/transformers` 4.2 does
 * not accept an `AbortSignal` on the feature-extraction path. If the
 * pipeline is still running when the timeout fires, it will complete
 * in the background and its result is silently discarded. This is
 * acceptable because (a) the model is CPU-bound and fast (< 100 ms/
 * call after cold start on the hardware we target, with q8 quantized
 * weights), so timeouts represent genuinely unusual pipeline states,
 * and (b) the write-
 * path failure semantics (Req 3.4, 3.5) already require the
 * ExtractionWorker to tolerate a rejected `embed` without dropping
 * the record. An `AbortController` is plumbed through the race
 * bookkeeping so the pending `setTimeout` is cleared on success and
 * the callback is a no-op when the promise settles cleanly.
 *
 * ## Model cache directory
 *
 * The model lives on disk under `modelCacheDir` (default
 * `~/.kiro-learn/models/`). Callers can override via the config or
 * by setting the `KIRO_LEARN_MODEL_DIR` environment variable; the
 * env var takes effect only when no explicit `modelCacheDir` is
 * passed in. Tilde (`~`) at the start of the configured path is
 * expanded to `os.homedir()` before it reaches the library — this
 * is a plain prefix substitution, not a full shell-style tilde
 * expansion (`~user` is left untouched and will likely fail to
 * resolve). `env.cacheDir` is set on `@huggingface/transformers`
 * before `pipeline(...)` is called so downloads land in the
 * configured directory.
 *
 * ## Postinstall / native build note
 *
 * `@huggingface/transformers@4.2.0` depends on `sharp` (image
 * decoding) and `onnxruntime-node` (native ONNX runtime). In the
 * current workspace, `npm install` was invoked with `--ignore-
 * scripts` (or equivalent) to skip sharp's native build, which is
 * fine for `tsc --noEmit` and for tests that stub the transformers
 * library at the factory boundary. The REAL pipeline load will
 * throw at runtime until the postinstall scripts are re-run and
 * the native artifacts are present. This file's `ready()` surface
 * already treats that as a terminal not-ready state — no special
 * code path is needed here, but operators should know that shipping
 * this module requires a real `npm install` at deploy time.
 *
 * ## Modularity
 *
 * This module lives at `src/collector/embedding/` and MUST NOT
 * import from `src/collector/storage/sqlite/`, `src/shim/`,
 * `src/installer/`, or `src/mcp/` (Req 13.1–13.3). Allowed imports:
 * `node:path`, `node:os`, `@huggingface/transformers`, and sibling
 * files in the embedding module.
 *
 * @see Requirements 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 2.1, 2.4, 10.3, 10.4, 17.1, 17.2
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — `Embedder` interface
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Degraded-mode state machine
 * @module
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { env, pipeline } from '@huggingface/transformers';

/**
 * The local embedding surface. Pure function from string to 384-dim
 * vector once initialised.
 *
 * Implementations of this interface are singletons per collector
 * process (Req 2.4): the ExtractionWorker, QueryLayer, and
 * BackfillWorker all share one instance so the model is loaded into
 * memory exactly once.
 *
 * @see Requirements 1, 2, 17
 */
export interface Embedder {
  /**
   * Resolve when the underlying model is ready. Idempotent — the
   * first call kicks off a single load, every subsequent call
   * returns the same memoised promise. On failure, the returned
   * promise rejects once and continues to reject on every future
   * `ready()` call; the load is never retried.
   */
  ready(): Promise<void>;

  /**
   * True once `ready()` has resolved successfully. Returns `false`
   * before the first `ready()` call, while the load is in flight,
   * and permanently after a load failure (design § Degraded-mode
   * state machine).
   */
  isReady(): boolean;

  /**
   * Return the 384-dim embedding of `input`.
   *
   * - Input is truncated internally to `maxInputChars` code units
   *   (default 10 000) before being handed to the pipeline; the
   *   model's tokenizer will further truncate to its native
   *   sequence length.
   * - Returns a fresh {@link Float32Array} of length exactly 384
   *   that does not alias the pipeline's internal tensor buffer.
   * - Rejects on model failure, on per-call timeout, and
   *   immediately if the underlying model load has failed.
   *
   * @see Requirements 1.1, 1.2, 1.3, 10.3, 10.4, 17.1, 17.2, 17.3, 17.4
   */
  embed(input: string): Promise<Float32Array>;

  /**
   * Output dimensionality. Constant 384 for MiniLM-L6-v2. Exposed
   * as a literal type so downstream code can branch on it without
   * runtime checks.
   */
  readonly dim: 384;
}

/**
 * Runtime configuration accepted by {@link createOnnxEmbedder}.
 *
 * Every field has a sensible default — callers typically pass `{}`
 * or override a single knob (e.g. `perCallTimeoutMs` in tests).
 *
 * @see Requirements 1.1, 1.7, 10.3, 12.2, 12.3
 */
export interface EmbedderConfig {
  /**
   * HuggingFace model id. Frozen to the 384-dim MiniLM variant —
   * any other value would invalidate the BLOB codec's 1536-byte
   * contract. Exposed as a literal type to document the constraint.
   */
  modelName: 'Xenova/all-MiniLM-L6-v2';

  /**
   * Directory where `@huggingface/transformers` caches model
   * weights. A leading `~/` is expanded to `os.homedir()`. When the
   * caller omits this field and the `KIRO_LEARN_MODEL_DIR`
   * environment variable is set, that variable is used instead;
   * otherwise the default is `~/.kiro-learn/models/`.
   *
   * @see Requirements 1.5, 1.6, 12.3
   */
  modelCacheDir: string;

  /**
   * Per-call timeout for a single {@link Embedder.embed} invocation,
   * in milliseconds. On timeout the promise rejects with an
   * `embed timeout` error; the ExtractionWorker treats this as a
   * non-fatal failure and stores the record without an embedding
   * (Req 3.4, 3.5, 10.4).
   *
   * @see Requirements 10.3, 10.4, 12.2
   */
  perCallTimeoutMs: number;

  /**
   * Maximum character count of the embedder input. Strings longer
   * than this are truncated via `.slice(0, maxInputChars)` before
   * being handed to the pipeline. The model tokenizer will further
   * truncate to its native sequence length; this cap exists to
   * bound the JS-side string allocation and to match the input-
   * composition cap in {@link composeEmbeddingInput}.
   *
   * @see Requirements 1.1
   */
  maxInputChars: number;
}

/** Default model id — the only model this file supports. */
const DEFAULT_MODEL_NAME = 'Xenova/all-MiniLM-L6-v2' as const;

/** Default per-call timeout (ms). Req 10.3 / 12.2. */
const DEFAULT_PER_CALL_TIMEOUT_MS = 2_000;

/** Default maximum input length (characters). Req 1.1. */
const DEFAULT_MAX_INPUT_CHARS = 10_000;

/** Fixed output dimensionality of the MiniLM-L6-v2 model. */
const EMBEDDING_DIMS = 384;

/**
 * Minimal structural type for the feature-extraction pipeline return
 * value. `@huggingface/transformers` exports a rich class hierarchy
 * around this but the only method we ever invoke is the call
 * operator itself (the pipeline is callable as a function), so we
 * narrow to the smallest shape that makes TypeScript happy.
 *
 * The call returns a Tensor; we only read `.data`, which on the
 * feature-extraction path is a {@link Float32Array} of length
 * `[1, dim]` flattened to `dim` when `pooling: 'mean'` is set.
 */
interface FeatureExtractionPipeline {
  (
    input: string,
    options: { pooling: 'mean'; normalize: boolean },
  ): Promise<{ data: Float32Array | ArrayLike<number> }>;
}

/**
 * Expand a leading `~/` in `p` to `os.homedir()`. Bare `~` is also
 * expanded to the home directory. Any other path is returned as-is;
 * `~user` style expansion is NOT supported (it would require a POSIX
 * user-database lookup and is not worth the dependency footprint for
 * a config knob).
 */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the effective model cache directory given the caller-
 * supplied partial config. Precedence:
 *
 * 1. Explicit `cfg.modelCacheDir` (after tilde expansion).
 * 2. `KIRO_LEARN_MODEL_DIR` environment variable (after tilde
 *    expansion).
 * 3. Default `~/.kiro-learn/models/`.
 *
 * The env-var fallback is what task 11.1 will formalise as the
 * installer-facing override; plumbing it here means tests and
 * one-off CLI invocations can point at a throwaway cache without
 * threading config through every layer.
 */
function resolveModelCacheDir(explicit: string | undefined): string {
  if (explicit !== undefined) return expandTilde(explicit);
  const fromEnv = process.env['KIRO_LEARN_MODEL_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return expandTilde(fromEnv);
  return join(homedir(), '.kiro-learn', 'models');
}

/**
 * Build an {@link Embedder} backed by the
 * `@huggingface/transformers` feature-extraction pipeline.
 *
 * Returns immediately. No I/O happens until the first `ready()` or
 * `embed()` call (design § `createOnnxEmbedder` returns immediately).
 * This matters because the collector bootstrap constructs the
 * embedder before the storage backend is ready, and we want
 * construction to be unconditionally safe.
 *
 * @param cfg - Partial configuration. Omitted fields fall back to
 *   the defaults documented on {@link EmbedderConfig}.
 * @returns A singleton-shaped {@link Embedder}. Callers that want
 *   to force-reload a fresh model (e.g. between tests) must call
 *   the optional `dispose()` method documented below and then
 *   construct a new embedder via this factory.
 *
 * @see Requirements 1.1, 1.2, 1.4–1.7, 2.1, 2.4, 10.3, 10.4, 17.1, 17.2
 */
export function createOnnxEmbedder(
  cfg: Partial<EmbedderConfig>,
): Embedder & { dispose(): void } {
  // Resolve the effective configuration once at construction time.
  // The object is captured by the closures below; none of these
  // fields change for the lifetime of the embedder.
  const modelName: 'Xenova/all-MiniLM-L6-v2' = cfg.modelName ?? DEFAULT_MODEL_NAME;
  const modelCacheDir = resolveModelCacheDir(cfg.modelCacheDir);
  const perCallTimeoutMs = cfg.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS;
  const maxInputChars = cfg.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;

  // Memoised load state. `readyPromise` is null until the first
  // `ready()` call; after that it holds the single load promise
  // (pending, resolved, or rejected). `isReadyFlag` flips to true
  // only after a successful load and never flips back — this is
  // the explicit one-way state required by Req 2.2 / design §
  // Degraded-mode state machine.
  let readyPromise: Promise<void> | null = null;
  let isReadyFlag = false;
  let extractor: FeatureExtractionPipeline | null = null;
  let loadError: Error | null = null;

  async function load(): Promise<void> {
    try {
      // Route all model downloads / cache reads through the
      // configured directory. Setting both `env.cacheDir` and
      // passing `cache_dir` in the pipeline options is redundant
      // but defensive: the library honours the options override,
      // which happens to be the field the public API contract
      // exposes. We assign to `env.cacheDir` as well so any
      // ancillary downloads (tokenizer, config) triggered by the
      // pipeline land in the same place.
      env.cacheDir = modelCacheDir;

      // Announce the load. The first run has to download the
      // model (~22 MiB) and the tokenizer from the HuggingFace
      // CDN; without a log line, the daemon appears to hang. We
      // write to stderr so the installer / systemd-style log
      // capture surfaces it without polluting stdout (which is
      // reserved for retrieval context in the shim path —
      // stderr is the correct channel for operator telemetry).
      process.stderr.write(
        `[kiro-learn] loading embedding model ${modelName} from ${modelCacheDir} (first run downloads ~22 MiB from the HuggingFace CDN; subsequent runs are offline)\n`,
      );

      // Track per-file download progress. The library emits
      // status events with `{status, name, file, progress,
      // loaded, total}` shaped objects. We log the transitions
      // we care about ('initiate', 'download', 'progress' at
      // milestones, 'done', 'ready') and swallow the rest so a
      // flood of sub-percent `progress` frames does not spam
      // the log. `loggedPct` tracks which 25 % milestone we've
      // already emitted per file — keeps the output readable
      // while still proving progress.
      const loadStart = Date.now();
      const loggedPct = new Map<string, number>();
      function onProgress(data: unknown): void {
        if (data === null || typeof data !== 'object') return;
        const d = data as {
          status?: string;
          name?: string;
          file?: string;
          progress?: number;
        };
        const file = typeof d.file === 'string' ? d.file : '';
        const name = typeof d.name === 'string' ? d.name : modelName;
        switch (d.status) {
          case 'initiate':
            process.stderr.write(
              `[kiro-learn]   download starting: ${name}/${file}\n`,
            );
            break;
          case 'download':
            // Emitted when the HTTP request actually begins.
            // Repeating the initiate message here is redundant,
            // so we skip.
            break;
          case 'progress': {
            if (typeof d.progress !== 'number') break;
            const pct = Math.floor(d.progress / 25) * 25;
            const prev = loggedPct.get(file) ?? -1;
            if (pct > prev && pct > 0) {
              loggedPct.set(file, pct);
              process.stderr.write(
                `[kiro-learn]   ${name}/${file}: ${String(pct)}%\n`,
              );
            }
            break;
          }
          case 'done':
            process.stderr.write(
              `[kiro-learn]   downloaded: ${name}/${file}\n`,
            );
            break;
          case 'ready':
            // Emitted when a model is fully loaded in memory.
            // The final "ready" line after pipeline resolves
            // subsumes this, so we skip.
            break;
          default:
            break;
        }
      }

      // The library's PretrainedModelOptions type marks
      // `cache_dir` as string only (not nullable). Casting via a
      // narrow `as const` keeps verbatimModuleSyntax happy.
      //
      // `dtype: 'q8'` selects the int8-quantized ONNX variant
      // (`model_quantized.onnx`, ~22 MiB) instead of the library's
      // node-native default of fp32 (`model.onnx`, ~90 MiB). The
      // quantized model is what Req 10.1's 100 ms p95 budget targets
      // — on an M4 Pro at 4000-char inputs the fp32 model sits
      // around 100 ms p95, while q8 lands around 50 ms p95. Accuracy impact is negligible for our use case
      // (cosine-similarity retrieval is robust to the small
      // perturbations int8 quantization introduces; the Xenova
      // model card and the project's design doc both assume the
      // quantized variant).
      const loaded = (await pipeline('feature-extraction', modelName, {
        cache_dir: modelCacheDir,
        dtype: 'q8',
        progress_callback: onProgress,
      })) as unknown as FeatureExtractionPipeline;

      extractor = loaded;
      isReadyFlag = true;
      const elapsedMs = Date.now() - loadStart;
      process.stderr.write(
        `[kiro-learn] embedding model ready (${String(elapsedMs)} ms)\n`,
      );
    } catch (err) {
      // Record the error so subsequent `embed()` calls can reject
      // with context, but do NOT rethrow from this `load()` scope
      // in a way that would retry: the outer `ready()` memoises
      // this promise, so the rejection sticks.
      loadError = err instanceof Error ? err : new Error(String(err));
      throw loadError;
    }
  }

  async function ready(): Promise<void> {
    if (readyPromise === null) {
      readyPromise = load();
    }
    return readyPromise;
  }

  function isReady(): boolean {
    return isReadyFlag;
  }

  /**
   * Race `promise` against a timer. On timeout, resolves with a
   * rejection carrying `embed timeout`; the AbortController is
   * purely bookkeeping so the pending timer is cleared on settle.
   * The underlying `promise` is NOT cancellable — see the module
   * TSDoc for the caveat.
   */
  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    const ac = new AbortController();
    const timeoutPromise = new Promise<T>((_, reject) => {
      const handle = setTimeout(() => {
        reject(new Error(`embed timeout after ${String(ms)}ms`));
      }, ms);
      ac.signal.addEventListener('abort', () => {
        clearTimeout(handle);
      });
    });
    return Promise.race([
      promise.finally(() => {
        ac.abort();
      }),
      timeoutPromise,
    ]);
  }

  async function embed(input: string): Promise<Float32Array> {
    // First, make sure the model has been asked to load. If the
    // caller never called `ready()` explicitly, this triggers the
    // single memoised load. If the load previously failed, the
    // awaited promise rejects and we short-circuit with that same
    // error.
    await ready();

    // Belt-and-braces: after `ready()` resolves we should be in
    // the Ready state, but `ready()` can also reject (in which
    // case we never reach here). If somehow `isReadyFlag` is
    // false with no error to surface, synthesise one so the
    // caller gets a consistent failure.
    if (!isReadyFlag || extractor === null) {
      throw loadError ?? new Error('embedder not ready');
    }

    // Truncate on the JS side. The tokenizer will further truncate
    // to its native sequence length (~256 WordPiece tokens for
    // MiniLM-L6-v2); this cap is purely to bound JS-side string
    // allocation for pathological inputs.
    const safeInput = input.length > maxInputChars ? input.slice(0, maxInputChars) : input;

    const call = extractor(safeInput, { pooling: 'mean', normalize: false });
    const output = await withTimeout(call, perCallTimeoutMs);

    // The feature-extraction pipeline returns a Tensor with
    // `.data` as a TypedArray of length `1 * dim`. Copy into a
    // fresh Float32Array of the expected length so the caller
    // never sees the pipeline's internal buffer. Fail fast if the
    // pipeline emits a buffer of the wrong length — silently
    // truncating or zero-padding would mask a real model /
    // pipeline misconfiguration and produce subtly broken vectors
    // downstream (cosine scores against a mixed-length corpus, or
    // zero-filled tail bytes that drag similarity toward zero).
    // Tolerate both a Float32Array view (the common case) and a
    // generic ArrayLike<number> (defensive against future library
    // changes).
    const data = output.data;
    if (data.length !== EMBEDDING_DIMS) {
      throw new Error(
        `embedder produced vector of length ${String(data.length)}; expected ${String(EMBEDDING_DIMS)}`,
      );
    }
    const out = new Float32Array(EMBEDDING_DIMS);
    if (data instanceof Float32Array) {
      // Typical fast path. Copy exactly `EMBEDDING_DIMS` elements.
      for (let i = 0; i < EMBEDDING_DIMS; i += 1) {
        // `noUncheckedIndexedAccess` widens `data[i]` to
        // `number | undefined`; the loop bound guarantees the
        // index is in range, so the cast is safe.
        out[i] = data[i] as number;
      }
    } else {
      // Fallback: generic ArrayLike<number>. Same copy shape.
      for (let i = 0; i < EMBEDDING_DIMS; i += 1) {
        out[i] = data[i] as number;
      }
    }
    return out;
  }

  /**
   * Drop the cached pipeline reference so tests can construct a
   * fresh embedder. The underlying ONNX session is not explicitly
   * freed because `@huggingface/transformers` 4.2 does not expose
   * a public dispose hook on the returned pipeline. If a future
   * version does, this is the hook to call it.
   *
   * After `dispose()`, `isReady()` keeps returning whatever it
   * returned before (we don't flip it back to `false` — the
   * embedder is intentionally one-shot per process per design §
   * Degraded-mode state machine). Callers that want a fresh
   * embedder should discard this instance and call
   * {@link createOnnxEmbedder} again.
   */
  function dispose(): void {
    extractor = null;
  }

  return {
    ready,
    isReady,
    embed,
    dim: EMBEDDING_DIMS,
    dispose,
  };
}
