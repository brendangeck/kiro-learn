/**
 * Unit tests for the `ExtractionWorker`'s embedding integration.
 *
 * Exercises the embed-after-insert write path added in task 7.1:
 *
 * - embed runs after `putMemoryRecord`
 * - `putEmbedding` is called with the exact vector from `embedder.embed`
 * - embed failures (thrown error, simulated timeout) do NOT re-throw and
 *   do NOT prevent record storage; a warning is logged with `record_id`
 * - `embedder === null` short-circuits to pre-spec behaviour
 * - `embedder !== null && !embedder.isReady()` skips the embed step and
 *   logs a degraded-mode warning (Req 14.3)
 *
 * CRITICAL: ACP interactions are mocked (same pattern as
 * `buffer-extraction-worker.test.ts`), storage is mocked at the
 * `StorageBackend` interface, and the `Embedder` is a plain
 * vi-backed fake. No real `kiro-cli`, no real ONNX pipeline.
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/tasks.md § Task 7.2
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md §§ 3, 14.1, 14.3
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Embedder } from '../../src/collector/embedding/index.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';
import type { MemoryRecord, StorageBackend } from '../../src/types/index.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

/**
 * Queue of responses the mocked ACP session returns from `sendPrompt`.
 * Each call to `createAcpSession` grabs the next response; `sendPrompt`
 * then replays it.
 */
const responseQueue: Array<string | Error> = [];

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() => {
    const response = responseQueue.shift();
    const session = {
      sendPrompt: vi.fn(() => {
        if (response instanceof Error) {
          return Promise.reject(response);
        }
        return Promise.resolve(response ?? '');
      }),
      destroy: vi.fn(),
    };
    return Promise.resolve(session);
  }),
}));

// ── Fixtures ────────────────────────────────────────────────────────────

/** Valid compressor XML response with one memory record. */
const SINGLE_RECORD_XML = `
<memory_record type="tool_use">
  <title>Test Memory</title>
  <summary>A test summary for the memory record</summary>
  <facts>
    <fact>fact one</fact>
  </facts>
  <concepts>
    <concept>testing</concept>
  </concepts>
  <files>
    <file>src/test.ts</file>
  </files>
</memory_record>
`.trim();

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a mock `StorageBackend` with every surface method as a spy.
 *
 * Mirrors the helper in `buffer-extraction-worker.test.ts` and adds the
 * embedding-surface methods introduced by this spec.
 */
function createMockStorage(): StorageBackend & {
  putMemoryRecord: ReturnType<typeof vi.fn>;
  putEmbedding: ReturnType<typeof vi.fn>;
} {
  return {
    putEvent: vi.fn().mockResolvedValue(undefined),
    getEventById: vi.fn().mockResolvedValue(null),
    putMemoryRecord: vi.fn().mockResolvedValue(undefined),
    searchMemoryRecords: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({
      total_events: 0,
      total_memories: 0,
      total_projects: 0,
      total_concepts: 0,
      observation_types: {},
      event_kinds: {},
    }),
    listProjects: vi.fn().mockResolvedValue([]),
    listMemoryRecords: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listEvents: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    putEmbedding: vi.fn().mockResolvedValue(undefined),
    getEmbedding: vi.fn().mockResolvedValue(null),
    listEmbeddings: vi.fn().mockResolvedValue([]),
    listRecordsWithoutEmbedding: vi.fn().mockResolvedValue([]),
    searchMemoryRecordsLexical: vi.fn().mockResolvedValue([]),
  };
}

/**
 * Build a mock `Embedder`. Use `embedError` to make `embed` throw (used
 * for both "throws" and "times out" cases — the extraction worker is
 * agnostic to the reason, so the timeout case is modelled as a thrown
 * error shaped like the one the real embedder emits: `"embed timeout
 * after Nms"`).
 */
function makeMockEmbedder(opts: {
  isReady?: boolean;
  embedReturn?: Float32Array;
  embedError?: Error;
  embedDelayMs?: number;
}): Embedder & {
  embed: ReturnType<typeof vi.fn>;
  isReady: ReturnType<typeof vi.fn>;
  ready: ReturnType<typeof vi.fn>;
} {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => opts.isReady ?? true),
    embed: vi.fn(async () => {
      if (opts.embedDelayMs !== undefined && opts.embedDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.embedDelayMs));
      }
      if (opts.embedError) {
        throw opts.embedError;
      }
      return opts.embedReturn ?? new Float32Array(384);
    }),
    dim: 384 as const,
  };
}

/** Build a valid `BufferEntry` for testing. */
function makeBufferEntry(overrides: Partial<BufferEntry> = {}): BufferEntry {
  return {
    event_id: '01JF8ZS4Y00000000000000000',
    namespace: '/actor/alice/project/abc/',
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
    ...overrides,
  };
}

// ── Test-lifecycle scaffolding ──────────────────────────────────────────

let tmpDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let capturedStderr: string[];

beforeEach(() => {
  responseQueue.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-extraction-worker-'));

  // Capture stderr writes so we can assert on warning text. We still
  // let the underlying call through to avoid perturbing other logging.
  capturedStderr = [];
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      capturedStderr.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
      return true;
    });
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('ExtractionWorker embedding integration', () => {
  /**
   * Verifies call order: `putMemoryRecord` precedes both `embedder.embed`
   * and `storage.putEmbedding`, and `putEmbedding` receives the exact
   * vector returned by `embed`.
   *
   * Validates: Requirements 3.1, 3.3
   */
  it('calls embed + putEmbedding after putMemoryRecord and passes the embed vector through', async () => {
    responseQueue.push(SINGLE_RECORD_XML);

    const { createExtractionWorker } = await import(
      '../../src/collector/buffer/extraction.js'
    );
    const { createBufferStore } = await import(
      '../../src/collector/buffer/store.js'
    );
    const { createBufferWatcher } = await import(
      '../../src/collector/buffer/watcher.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999 });
    const storage = createMockStorage();

    // Use a distinctive vector so we can assert identity (reference
    // equality) rather than structural equality.
    const vec = new Float32Array(384);
    vec[0] = 0.125;
    vec[383] = -0.25;
    const embedder = makeMockEmbedder({ embedReturn: vec });

    const projectId = 'embed-order-project';
    await bufferStore.append(
      projectId,
      makeBufferEntry({ event_id: '01JF8ZS4Y00000000000000001' }),
    );

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      embedder,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 3 },
    });

    const result = await worker.extract(projectId);
    expect(result.memoriesCreated).toBe(1);

    // Both surfaces were called exactly once.
    expect(storage.putMemoryRecord).toHaveBeenCalledTimes(1);
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(storage.putEmbedding).toHaveBeenCalledTimes(1);

    // Call order: putMemoryRecord → embed → putEmbedding.
    const putRecordOrder =
      storage.putMemoryRecord.mock.invocationCallOrder[0]!;
    const embedOrder = embedder.embed.mock.invocationCallOrder[0]!;
    const putEmbedOrder = storage.putEmbedding.mock.invocationCallOrder[0]!;
    expect(putRecordOrder).toBeLessThan(embedOrder);
    expect(embedOrder).toBeLessThan(putEmbedOrder);

    // `putEmbedding` receives the record_id from the stored record and
    // the exact vector the embedder returned (reference-equal).
    const storedRecord = storage.putMemoryRecord.mock
      .calls[0]![0] as MemoryRecord;
    const [recordId, passedVec] = storage.putEmbedding.mock.calls[0]! as [
      string,
      Float32Array,
    ];
    expect(recordId).toBe(storedRecord.record_id);
    expect(passedVec).toBe(vec);

    watcher.close();
  });

  /**
   * When `embedder.embed` throws, the record must still be stored,
   * `putEmbedding` must NOT be called, and a warning naming the
   * `record_id` must reach stderr.
   *
   * Validates: Requirements 3.4, 3.5, 14.1
   */
  it('stores the record and warns with record_id when embed throws (putEmbedding not called)', async () => {
    responseQueue.push(SINGLE_RECORD_XML);

    const { createExtractionWorker } = await import(
      '../../src/collector/buffer/extraction.js'
    );
    const { createBufferStore } = await import(
      '../../src/collector/buffer/store.js'
    );
    const { createBufferWatcher } = await import(
      '../../src/collector/buffer/watcher.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999 });
    const storage = createMockStorage();
    const embedder = makeMockEmbedder({
      embedError: new Error('embed boom'),
    });

    const projectId = 'embed-throws-project';
    await bufferStore.append(
      projectId,
      makeBufferEntry({ event_id: '01JF8ZS4Y00000000000000001' }),
    );

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      embedder,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 3 },
    });

    const result = await worker.extract(projectId);

    // Record was stored despite the embed failure.
    expect(result.memoriesCreated).toBe(1);
    expect(storage.putMemoryRecord).toHaveBeenCalledTimes(1);

    // putEmbedding was NOT called.
    expect(storage.putEmbedding).not.toHaveBeenCalled();

    // Warning on stderr names the record_id and the error message.
    const storedRecord = storage.putMemoryRecord.mock
      .calls[0]![0] as MemoryRecord;
    const joinedStderr = capturedStderr.join('');
    expect(joinedStderr).toContain(storedRecord.record_id);
    expect(joinedStderr).toContain('embed boom');
    expect(joinedStderr).toMatch(/embedding failed/);

    watcher.close();
  });

  /**
   * When `embed` times out, the worker sees the same thing as a throw —
   * the real `OnnxEmbedder` implements the timeout via `Promise.race`
   * and rejects with an `embed timeout after Nms` error. We simulate
   * that shape directly; the worker is agnostic to the reason.
   *
   * Validates: Requirements 3.4, 3.5, 10.3, 10.4, 14.1
   */
  it('treats embed timeout identically to an embed throw (record stored, warn, no putEmbedding)', async () => {
    responseQueue.push(SINGLE_RECORD_XML);

    const { createExtractionWorker } = await import(
      '../../src/collector/buffer/extraction.js'
    );
    const { createBufferStore } = await import(
      '../../src/collector/buffer/store.js'
    );
    const { createBufferWatcher } = await import(
      '../../src/collector/buffer/watcher.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999 });
    const storage = createMockStorage();
    const embedder = makeMockEmbedder({
      // Short real delay so the test is still bounded in wall time, then
      // reject with a timeout-shaped error.
      embedDelayMs: 5,
      embedError: new Error('embed timeout after 2000ms'),
    });

    const projectId = 'embed-timeout-project';
    await bufferStore.append(
      projectId,
      makeBufferEntry({ event_id: '01JF8ZS4Y00000000000000001' }),
    );

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      embedder,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 3 },
    });

    const result = await worker.extract(projectId);

    expect(result.memoriesCreated).toBe(1);
    expect(storage.putMemoryRecord).toHaveBeenCalledTimes(1);
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(storage.putEmbedding).not.toHaveBeenCalled();

    const storedRecord = storage.putMemoryRecord.mock
      .calls[0]![0] as MemoryRecord;
    const joinedStderr = capturedStderr.join('');
    expect(joinedStderr).toContain(storedRecord.record_id);
    expect(joinedStderr).toContain('embed timeout');

    watcher.close();
  });

  /**
   * With `embedder: null`, the worker must behave exactly as it did
   * before this spec — the record is stored and no embedding calls
   * happen. (Pre-spec behaviour: no embed, no putEmbedding.)
   *
   * Validates: Requirements 3.4, 3.5, 14.1 (regression guard)
   */
  it('runs identically to pre-spec behaviour when embedder is null', async () => {
    responseQueue.push(SINGLE_RECORD_XML);

    const { createExtractionWorker } = await import(
      '../../src/collector/buffer/extraction.js'
    );
    const { createBufferStore } = await import(
      '../../src/collector/buffer/store.js'
    );
    const { createBufferWatcher } = await import(
      '../../src/collector/buffer/watcher.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999 });
    const storage = createMockStorage();

    const projectId = 'embed-null-project';
    await bufferStore.append(
      projectId,
      makeBufferEntry({ event_id: '01JF8ZS4Y00000000000000001' }),
    );

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      embedder: null,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 3 },
    });

    const result = await worker.extract(projectId);

    expect(result.memoriesCreated).toBe(1);
    expect(storage.putMemoryRecord).toHaveBeenCalledTimes(1);
    expect(storage.putEmbedding).not.toHaveBeenCalled();

    // No embedding-related warning in stderr.
    const joinedStderr = capturedStderr.join('');
    expect(joinedStderr).not.toMatch(/embedding failed/);
    expect(joinedStderr).not.toMatch(/degraded mode: skipping embed/);

    watcher.close();
  });

  /**
   * When the embedder is injected but `isReady()` returns `false`, the
   * worker must not call `embed`, must not call `putEmbedding`, must
   * still store the record, and must log a degraded-mode warning
   * naming the `record_id`.
   *
   * Validates: Requirements 3.4, 3.5, 14.1, 14.3
   */
  it('skips embed and logs a degraded-mode warning when embedder.isReady() is false', async () => {
    responseQueue.push(SINGLE_RECORD_XML);

    const { createExtractionWorker } = await import(
      '../../src/collector/buffer/extraction.js'
    );
    const { createBufferStore } = await import(
      '../../src/collector/buffer/store.js'
    );
    const { createBufferWatcher } = await import(
      '../../src/collector/buffer/watcher.js'
    );

    const bufferStore = createBufferStore(tmpDir);
    const watcher = createBufferWatcher({ idleMs: 999_999 });
    const storage = createMockStorage();
    const embedder = makeMockEmbedder({ isReady: false });

    const projectId = 'embed-not-ready-project';
    await bufferStore.append(
      projectId,
      makeBufferEntry({ event_id: '01JF8ZS4Y00000000000000001' }),
    );

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      embedder,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 3 },
    });

    const result = await worker.extract(projectId);

    expect(result.memoriesCreated).toBe(1);
    expect(storage.putMemoryRecord).toHaveBeenCalledTimes(1);
    expect(embedder.embed).not.toHaveBeenCalled();
    expect(storage.putEmbedding).not.toHaveBeenCalled();

    // isReady was consulted at least once.
    expect(embedder.isReady).toHaveBeenCalled();

    // Degraded-mode warning names the record_id.
    const storedRecord = storage.putMemoryRecord.mock
      .calls[0]![0] as MemoryRecord;
    const joinedStderr = capturedStderr.join('');
    expect(joinedStderr).toContain(storedRecord.record_id);
    expect(joinedStderr).toMatch(/degraded mode/);
    expect(joinedStderr).toMatch(/embedder not ready/);

    watcher.close();
  });
});
