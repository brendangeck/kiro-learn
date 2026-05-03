/**
 * End-to-end degraded-mode unit tests (task 11.4).
 *
 * Exercises the full degraded-mode path — startup with a failing
 * embedder stub → subsequent writes store records with NULL embedding
 * and log warnings → subsequent searches are lexical-only and log a
 * warning per query that attempts hybrid.
 *
 * Degraded mode is the permanent not-ready state the `Embedder`
 * enters when its initial `ready()` rejects (design § Degraded-mode
 * state machine). The ExtractionWorker and QueryLayer both carry
 * explicit branches for this state, but the spec (Req 2.2, 14.3)
 * requires the full pipeline — startup, write, read — to behave
 * cohesively. This test validates that cohesion.
 *
 * Strategy:
 *
 *   - The test drives the two primary consumers (`ExtractionWorker`
 *     and `QueryLayer`) directly against the real SQLite backend so
 *     NULL-embedding persistence and lexical-only fallback are
 *     observed as they'll happen in production. The full
 *     `startCollector` wiring is exercised in task 11.3 /
 *     `embedding-collector-wiring.test.ts`; here we focus on the
 *     user-observable behaviour once degraded mode is active.
 *   - `@huggingface/transformers` is mocked so we can explicitly
 *     fail `ready()` through the real `createOnnxEmbedder` — no
 *     model download, no ONNX runtime.
 *   - The ExtractionWorker is driven via a small in-memory
 *     `BufferStore` stub and a mocked ACP session that returns a
 *     canned `memory_record` XML payload.
 *
 * Validates: Requirements 2.2, 2.3, 12.4, 14.2, 14.3
 *
 * @see src/collector/embedding/onnx-embedder.ts
 * @see src/collector/buffer/extraction.ts
 * @see src/collector/query/index.ts
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md § Degraded-mode state machine
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOnnxEmbedder } from '../../src/collector/embedding/onnx-embedder.js';
import { createQueryLayer } from '../../src/collector/query/index.js';
import { createExtractionWorker } from '../../src/collector/buffer/extraction.js';
import { createBufferStore } from '../../src/collector/buffer/store.js';
import { createBufferWatcher } from '../../src/collector/buffer/watcher.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { StorageBackend } from '../../src/types/index.js';

// ── Mock ACP ─────────────────────────────────────────────────────────────

/** Single-record XML the mocked compressor returns for every prompt. */
const SINGLE_RECORD_XML = `
<memory_record type="tool_use">
  <title>Reads src/test.ts</title>
  <summary>Agent read the file at src/test.ts for inspection</summary>
  <facts>
    <fact>src/test.ts is 42 lines long</fact>
  </facts>
  <concepts>
    <concept>typescript</concept>
  </concepts>
  <files>
    <file>src/test.ts</file>
  </files>
</memory_record>
`.trim();

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() =>
    Promise.resolve({
      sendPrompt: vi.fn(() => Promise.resolve(SINGLE_RECORD_XML)),
      destroy: vi.fn(),
    }),
  ),
}));

// ── Mock @huggingface/transformers — force ready() to reject ─────────────

const LOAD_ERROR = new Error('model load failed in degraded-mode test');

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(async () => {
    throw LOAD_ERROR;
  }),
  env: {} as Record<string, unknown>,
}));

// ── Test lifecycle ──────────────────────────────────────────────────────

let tmpRoot: string;
let dbPath: string;
let bufferDir: string;
let storage: StorageBackend;
let capturedStderr: string[];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-degraded-'));
  dbPath = join(tmpRoot, 'kiro-learn.db');
  bufferDir = join(tmpRoot, 'buffers');
  storage = openSqliteStorage({ dbPath });

  capturedStderr = [];
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      capturedStderr.push(String(chunk));
      return true;
    });
});

afterEach(async () => {
  stderrSpy.mockRestore();
  try {
    await storage.close();
  } catch {
    /* swallow cleanup failure */
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────

/** Valid buffer entry for the ExtractionWorker to process. */
const NAMESPACE = '/actor/alice/project/abc/';
const PROJECT_ID = 'abc123def456';

function makeBufferEntry(): {
  event_id: string;
  namespace: string;
  kind: 'tool_use';
  body: { type: 'json'; data: Record<string, unknown> };
  timestamp: string;
  surface: string;
} {
  return {
    event_id: '01JF8ZS4Y00000000000000000',
    namespace: NAMESPACE,
    kind: 'tool_use',
    body: {
      type: 'json',
      data: {
        tool_name: 'readFile',
        tool_input: { path: 'src/test.ts' },
        tool_response: 'file contents here',
      },
    },
    timestamp: '2026-04-23T20:00:00.000Z',
    surface: 'kiro-cli',
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('End-to-end degraded mode', () => {
  it('startup: ready() rejects and isReady() stays false permanently', async () => {
    /**
     * **Validates: Requirement 2.2**
     *
     * The embedder's `ready()` must reject on load failure and
     * `isReady()` must remain `false` for every subsequent call —
     * this is the terminal not-ready state that the downstream
     * consumers (ExtractionWorker, QueryLayer) rely on to take
     * their degraded-mode branches.
     */
    const embedder = createOnnxEmbedder({});

    // Initial state — not ready because `ready()` has not run.
    expect(embedder.isReady()).toBe(false);

    // First `ready()` rejects with the load error.
    await expect(embedder.ready()).rejects.toBe(LOAD_ERROR);
    expect(embedder.isReady()).toBe(false);

    // Re-entering `ready()` must NOT retry and must reject with the
    // same memoised error. Still not ready.
    await expect(embedder.ready()).rejects.toBe(LOAD_ERROR);
    expect(embedder.isReady()).toBe(false);

    // `embed()` after a failed load rejects immediately with the
    // original error — consumers can rely on this shape when they
    // plumb error messages through their warnings.
    await expect(embedder.embed('hello')).rejects.toBe(LOAD_ERROR);
    expect(embedder.isReady()).toBe(false);
  });

  it('writes: ExtractionWorker stores records with NULL embedding and logs a degraded-mode warning', async () => {
    /**
     * **Validates: Requirements 14.2, 14.3**
     *
     * With a degraded embedder, the `ExtractionWorker` must still
     * persist the `MemoryRecord` (so the lexical read path sees
     * it), must NOT call `putEmbedding`, and must emit a
     * degraded-mode warning per affected write so operators can
     * observe the gap.
     */
    const embedder = createOnnxEmbedder({});
    // Trigger the load failure synchronously before the worker runs
    // so `isReady()` is definitively `false` by the time the worker
    // checks it.
    await expect(embedder.ready()).rejects.toBe(LOAD_ERROR);
    expect(embedder.isReady()).toBe(false);

    const bufferStore = createBufferStore(bufferDir);
    const watcher = createBufferWatcher({
      idleMs: 60_000,
      extractionSizeThreshold: 262_144,
      bufferMaxBytes: 4_194_304,
      maxConsecutiveFailures: 3,
      compactionSizeThreshold: 1_048_576,
    });

    // Spy on the embedding surface so we can confirm no
    // `putEmbedding` slipped through in degraded mode.
    const putEmbeddingSpy = vi.spyOn(storage, 'putEmbedding');

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      embedder,
      config: { concurrency: 1, timeoutMs: 60_000, maxRetries: 3 },
    });

    // Seed one buffer entry and run extraction.
    await bufferStore.append(PROJECT_ID, makeBufferEntry());
    const result = await worker.extract(PROJECT_ID);

    expect(result.memoriesCreated).toBe(1);

    // Record is in storage, lexical path sees it. No embedding.
    const { items } = await storage.listMemoryRecords({
      namespace: NAMESPACE,
      limit: 10,
      offset: 0,
    });
    expect(items.length).toBe(1);
    expect(await storage.getEmbedding(items[0]!.record_id)).toBeNull();
    const stats = await storage.getStats(NAMESPACE);
    expect(stats.embeddings_present).toBe(0);
    expect(stats.embeddings_missing).toBe(1);

    // No `putEmbedding` call happened.
    expect(putEmbeddingSpy).not.toHaveBeenCalled();

    // Degraded-mode warning naming the record_id.
    const stderrOut = capturedStderr.join('');
    expect(stderrOut).toMatch(/degraded mode: skipping embed/);
    expect(stderrOut).toContain(items[0]!.record_id);

    watcher.close();
  });

  it('reads: QueryLayer.search falls back to lexical-only and logs once per query when embed throws', async () => {
    /**
     * **Validates: Requirements 2.3, 12.4, 14.2**
     *
     * The `QueryLayer` must never throw on embedder failure — it
     * must fall back to lexical-only results (the strictly-
     * additive guarantee from Property 8) and emit a warning once
     * per query that actually attempted to embed. Queries whose
     * tokens are empty do not attempt to embed, so the warning
     * must be bounded by the query count, not the search count.
     *
     * In the genuine degraded mode the QueryLayer's `embedder ===
     * null || !isReady()` branch (step 3 in the algorithm) returns
     * lexical-only WITHOUT invoking `embed`, which means the
     * "embed threw" warning wouldn't fire — exactly what we want.
     * To verify the warning surface, we exercise the closely-
     * related "embed throws" path with a healthy-looking embedder
     * whose `embed` always rejects. This is the same fallback
     * exit and is the one that actually logs. Together they
     * validate the complete degraded read path (Req 16.3).
     */
    // Seed two records so lexical search has something to return.
    await storage.putMemoryRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000001',
      namespace: NAMESPACE,
      strategy: 'llm-summary',
      title: 'First record about typescript',
      summary: 'A first record talking about typescript decisions',
      facts: ['used strict mode'],
      source_event_ids: ['01JF8ZS4Y00000000000000000'],
      created_at: '2026-04-23T20:00:00.000Z',
      concepts: ['typescript'],
      files_touched: ['src/index.ts'],
      observation_type: 'tool_use',
    });
    await storage.putMemoryRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000002',
      namespace: NAMESPACE,
      strategy: 'llm-summary',
      title: 'Second record about typescript config',
      summary: 'A second record about typescript config and build',
      facts: ['tsconfig.json'],
      source_event_ids: ['01JF8ZS4Y00000000000000001'],
      created_at: '2026-04-23T20:01:00.000Z',
      concepts: ['typescript', 'build'],
      files_touched: ['tsconfig.json'],
      observation_type: 'tool_use',
    });

    // ── Branch A: isReady() === false (the "true" degraded-mode
    //     branch). Lexical-only, no warning (step 3, not step 4).
    {
      const degradedEmbedder = {
        ready: vi.fn().mockRejectedValue(LOAD_ERROR),
        isReady: vi.fn(() => false),
        embed: vi.fn().mockRejectedValue(
          new Error('embed should never be called in true degraded mode'),
        ),
        dim: 384 as const,
      };

      const queryLayer = createQueryLayer({
        storage,
        embedder: degradedEmbedder,
      });

      capturedStderr.length = 0;

      const results = await queryLayer.search(NAMESPACE, 'typescript', 10);
      expect(results.length).toBe(2);
      expect(degradedEmbedder.embed).not.toHaveBeenCalled();

      // Step-3 branch does not emit a warning — fallback is silent
      // because the embedder is known to be unavailable. The loud
      // logging case is step 4 (embed threw), covered next.
      const stderrOut = capturedStderr.join('');
      expect(stderrOut).not.toMatch(/hybrid search falling back/);
    }

    // ── Branch B: the step-4 fallback — embedder looks healthy but
    //     `embed` rejects. This is the loud variant that emits the
    //     warning. The lexical-only result set must still be
    //     returned; the warning must appear once per attempted
    //     hybrid query.
    {
      const flakyEmbedder = {
        ready: vi.fn().mockResolvedValue(undefined),
        isReady: vi.fn(() => true),
        embed: vi
          .fn()
          .mockRejectedValue(new Error('embed boom')),
        dim: 384 as const,
      };

      const queryLayer = createQueryLayer({
        storage,
        embedder: flakyEmbedder,
      });

      capturedStderr.length = 0;

      // Two hybrid-eligible queries.
      const r1 = await queryLayer.search(NAMESPACE, 'typescript', 10);
      const r2 = await queryLayer.search(NAMESPACE, 'build', 10);

      // Both fell back to lexical-only (non-empty results).
      expect(r1.length).toBe(2);
      expect(r2.length).toBeGreaterThan(0);

      // `embed` was invoked once per query (it rejected each time).
      expect(flakyEmbedder.embed).toHaveBeenCalledTimes(2);

      // Warning line fired — matching the QueryLayer's wording.
      const stderrOut = capturedStderr.join('');
      const matches = stderrOut.match(/hybrid search falling back to lexical/g) ?? [];
      expect(matches.length).toBe(2);

      // A whitespace-only query must NOT log a warning (empty-
      // token short-circuit — step 2, before the embed attempt).
      capturedStderr.length = 0;
      const r3 = await queryLayer.search(NAMESPACE, '   ', 10);
      expect(r3).toEqual([]);
      expect(
        capturedStderr.join('').match(/hybrid search falling back/g),
      ).toBeNull();
    }
  });
});
