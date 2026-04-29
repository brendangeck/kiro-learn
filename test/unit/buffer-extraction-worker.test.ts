/**
 * Unit tests for the ExtractionWorker (buffer-based batch extraction).
 *
 * Tests cover: batch framing, memory record storage with correct namespace
 * and source_event_ids, buffer clear on success, buffer preserved on failure,
 * notifyExtractionResult calls, concurrency semaphore, drain(), and empty
 * buffer early return.
 *
 * CRITICAL: All ACP interactions are mocked — no real `kiro-cli` processes
 * are spawned. The mock `createAcpSession` returns a fake session with a
 * controllable `sendPrompt` response.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/tasks.md § Task 6.2
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 10, 11
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageBackend, MemoryRecord } from '../../src/types/index.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

/**
 * Queue of responses that mock sessions will return from sendPrompt.
 * Each call to sendPrompt shifts the next response from the queue.
 */
const responseQueue: Array<string | Error> = [];

/**
 * Tracks all mock sessions created so tests can inspect destroy calls.
 */
const mockSessions: Array<{
  sendPrompt: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}> = [];

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
    mockSessions.push(session);
    return Promise.resolve(session);
  }),
}));

// ── Helpers ─────────────────────────────────────────────────────────────

/** Valid XML response with a single memory record. */
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

/** Valid XML response with two memory records. */
const MULTI_RECORD_XML = `
<memory_record type="tool_use">
  <title>First Memory</title>
  <summary>First summary for the memory record</summary>
  <facts>
    <fact>fact one</fact>
  </facts>
  <concepts>
    <concept>testing</concept>
  </concepts>
  <files>
    <file>src/a.ts</file>
  </files>
</memory_record>
<memory_record type="discovery">
  <title>Second Memory</title>
  <summary>Second summary for the memory record</summary>
  <facts>
    <fact>fact two</fact>
  </facts>
  <concepts>
    <concept>discovery</concept>
  </concepts>
  <files>
    <file>src/b.ts</file>
  </files>
</memory_record>
`.trim();

/**
 * Create a mock StorageBackend with `putMemoryRecord` as a vi.fn().
 */
function createMockStorage(): StorageBackend & {
  putMemoryRecord: ReturnType<typeof vi.fn>;
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
  };
}

/**
 * Build a valid BufferEntry for testing.
 */
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

let tmpDir: string;

beforeEach(() => {
  responseQueue.length = 0;
  mockSessions.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-worker-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('ExtractionWorker', () => {
  /**
   * Test 1: Successful extraction stores memory records with correct
   * namespace and source_event_ids.
   *
   * Validates: Requirements 10.1, 10.2, 10.4, 10.5
   */
  it('stores memory records with correct namespace and source_event_ids on success', async () => {
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

    const projectId = 'test-project';
    const entry1 = makeBufferEntry({ event_id: '01JF8ZS4Y00000000000000001' });
    const entry2 = makeBufferEntry({ event_id: '01JF8ZS4Y00000000000000002' });

    await bufferStore.append(projectId, entry1);
    await bufferStore.append(projectId, entry2);

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 3 },
    });

    const result = await worker.extract(projectId);

    expect(result.eventsProcessed).toBe(2);
    expect(result.memoriesCreated).toBe(1);
    expect(storage.putMemoryRecord).toHaveBeenCalledTimes(1);

    const storedRecord = storage.putMemoryRecord.mock.calls[0]![0] as MemoryRecord;
    expect(storedRecord.namespace).toBe('/actor/alice/project/abc/');
    expect(storedRecord.source_event_ids).toEqual([
      '01JF8ZS4Y00000000000000001',
      '01JF8ZS4Y00000000000000002',
    ]);
    expect(storedRecord.record_id).toMatch(/^mr_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(storedRecord.strategy).toBe('llm-summary');
    expect(storedRecord.title).toBe('Test Memory');
    expect(storedRecord.observation_type).toBe('tool_use');

    watcher.close();
  });

  /**
   * Test 2: Buffer cleared after successful extraction.
   *
   * Validates: Requirement 10.6
   */
  it('clears buffer after successful extraction', async () => {
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

    const projectId = 'test-project';
    await bufferStore.append(projectId, makeBufferEntry());

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 3 },
    });

    await worker.extract(projectId);

    // Buffer should be empty after successful extraction
    const snapshot = await bufferStore.snapshot(projectId);
    expect(snapshot).toHaveLength(0);

    watcher.close();
  });

  /**
   * Test 3: Buffer NOT cleared after failed extraction.
   *
   * Validates: Requirement 10.8
   */
  it('does NOT clear buffer after failed extraction', async () => {
    // All retries fail
    responseQueue.push(
      new Error('fail 1'),
      new Error('fail 2'),
      new Error('fail 3'),
    );

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

    const projectId = 'test-project';
    await bufferStore.append(projectId, makeBufferEntry());

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 3 },
    });

    await worker.extract(projectId);

    // Buffer should still have entries after failed extraction
    const snapshot = await bufferStore.snapshot(projectId);
    expect(snapshot).toHaveLength(1);

    watcher.close();
  });

  /**
   * Test 4: notifyExtractionResult called with true on success.
   *
   * Validates: Requirement 10.7
   */
  it('calls notifyExtractionResult with true on success', async () => {
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

    const projectId = 'test-project';
    await bufferStore.append(projectId, makeBufferEntry());

    // Manually set up the watcher state so we can verify the result
    watcher.notifyAppend(projectId, 100);

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 3 },
    });

    await worker.extract(projectId);

    // After successful extraction, watcher state should reflect success:
    // consecutiveFailures should be 0, extractionDisabled should be false
    const state = watcher._getState(projectId);
    expect(state).toBeDefined();
    expect(state!.consecutiveFailures).toBe(0);
    expect(state!.extractionDisabled).toBe(false);

    watcher.close();
  });

  /**
   * Test 5: notifyExtractionResult called with false on failure.
   *
   * Validates: Requirement 10.8
   */
  it('calls notifyExtractionResult with false on failure', async () => {
    // All retries fail
    responseQueue.push(
      new Error('fail 1'),
      new Error('fail 2'),
      new Error('fail 3'),
    );

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
    const watcher = createBufferWatcher({
      idleMs: 999_999,
      maxConsecutiveFailures: 5,
    });
    const storage = createMockStorage();

    const projectId = 'test-project';
    await bufferStore.append(projectId, makeBufferEntry());

    // Initialize watcher state
    watcher.notifyAppend(projectId, 100);

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 3 },
    });

    await worker.extract(projectId);

    // After failed extraction, watcher state should reflect failure
    const state = watcher._getState(projectId);
    expect(state).toBeDefined();
    expect(state!.consecutiveFailures).toBe(1);

    watcher.close();
  });

  /**
   * Test 6: Concurrency semaphore limits parallel extractions.
   *
   * Validates: Requirement 11.1
   */
  it('limits concurrent extractions via semaphore', async () => {
    // We'll use delayed responses to control timing.
    // Create 3 extractions with concurrency=2.
    // Track the max active count.

    let resolveFirst!: (value: string) => void;
    let resolveSecond!: (value: string) => void;
    let resolveThird!: (value: string) => void;

    const firstPromise = new Promise<string>((r) => { resolveFirst = r; });
    const secondPromise = new Promise<string>((r) => { resolveSecond = r; });
    const thirdPromise = new Promise<string>((r) => { resolveThird = r; });

    // Override the mock to use controllable promises
    const { createAcpSession } = await import(
      '../../src/collector/pipeline/acp-client.js'
    );
    const mockedCreateAcpSession = vi.mocked(createAcpSession);

    const promiseQueue = [firstPromise, secondPromise, thirdPromise];
    let promiseIdx = 0;

    mockedCreateAcpSession.mockImplementation(() => {
      const idx = promiseIdx++;
      const p = promiseQueue[idx]!;
      const session = {
        sendPrompt: vi.fn(() => p),
        destroy: vi.fn(),
      };
      return Promise.resolve(session);
    });

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

    // Append entries for 3 different projects
    await bufferStore.append('proj-a', makeBufferEntry());
    await bufferStore.append('proj-b', makeBufferEntry());
    await bufferStore.append('proj-c', makeBufferEntry());

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 1 },
    });

    // Start all 3 extractions
    const extractA = worker.extract('proj-a');
    const extractB = worker.extract('proj-b');
    const extractC = worker.extract('proj-c');

    // Give microtasks time to settle so semaphore acquisition runs
    await new Promise((r) => setTimeout(r, 50));

    // With concurrency=2, only 2 should be active
    expect(worker.active).toBe(2);

    // Resolve the first two
    resolveFirst(SINGLE_RECORD_XML);
    await extractA;

    // Now the third should be able to start
    await new Promise((r) => setTimeout(r, 50));
    expect(worker.active).toBeLessThanOrEqual(2);

    resolveSecond(SINGLE_RECORD_XML);
    await extractB;

    resolveThird(SINGLE_RECORD_XML);
    await extractC;

    // All done
    expect(worker.active).toBe(0);

    watcher.close();
  });

  /**
   * Test 7: drain() waits for in-flight extractions.
   *
   * Validates: Requirement 11.4
   */
  it('drain() waits for in-flight extractions to complete', async () => {
    let resolveExtraction!: (value: string) => void;
    const extractionPromise = new Promise<string>((r) => { resolveExtraction = r; });

    const { createAcpSession } = await import(
      '../../src/collector/pipeline/acp-client.js'
    );
    const mockedCreateAcpSession = vi.mocked(createAcpSession);

    mockedCreateAcpSession.mockImplementation(() => {
      const session = {
        sendPrompt: vi.fn(() => extractionPromise),
        destroy: vi.fn(),
      };
      return Promise.resolve(session);
    });

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

    await bufferStore.append('proj-drain', makeBufferEntry());

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 1 },
    });

    // Start extraction (don't await it)
    const extractPromise = worker.extract('proj-drain');

    // drain should not resolve until extraction completes
    let drainResolved = false;
    const drainPromise = worker.drain(10_000).then(() => {
      drainResolved = true;
    });

    // Give time for drain to start waiting
    await new Promise((r) => setTimeout(r, 50));
    expect(drainResolved).toBe(false);

    // Now resolve the extraction
    resolveExtraction(SINGLE_RECORD_XML);

    // Wait for both to complete
    await extractPromise;
    await drainPromise;

    expect(drainResolved).toBe(true);

    watcher.close();
  });

  /**
   * Test 8: Empty buffer returns early with success.
   *
   * Validates: Requirements 10.1, 10.7
   */
  it('returns early with eventsProcessed=0 and notifies success for empty buffer', async () => {
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

    const projectId = 'empty-project';

    // Initialize watcher state
    watcher.notifyAppend(projectId, 100);

    const worker = createExtractionWorker({
      bufferStore,
      watcher,
      storage,
      config: { concurrency: 2, timeoutMs: 30_000, maxRetries: 3 },
    });

    const result = await worker.extract(projectId);

    // Should return early with 0 events processed
    expect(result.eventsProcessed).toBe(0);
    expect(result.memoriesCreated).toBe(0);
    expect(result.projectId).toBe(projectId);

    // No ACP session should have been created
    expect(mockSessions).toHaveLength(0);

    // Storage should not have been called
    expect(storage.putMemoryRecord).not.toHaveBeenCalled();

    // Watcher should have been notified with success
    const state = watcher._getState(projectId);
    expect(state).toBeDefined();
    expect(state!.consecutiveFailures).toBe(0);

    watcher.close();
  });
});
