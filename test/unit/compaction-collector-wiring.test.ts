/**
 * Unit tests for collector compaction wiring.
 *
 * Verifies that `startCollector` correctly wires compaction components
 * into the daemon lifecycle:
 * - `compactionEnabled: true` creates CompactionWorker and wires triggers
 * - `compactionEnabled: false` (default) does not create CompactionWorker
 * - Shutdown sequence drains CompactionWorker before closing storage
 * - Startup cleans up orphaned temp files
 * - Startup re-arms compaction triggers for oversized buffers
 *
 * Heavy mocking is required because `startCollector` opens a real SQLite
 * database and starts an HTTP server. We mock:
 * - `openSqliteStorage` to return a mock StorageBackend
 * - `createAcpSession` to prevent real kiro-cli spawning
 * - `startReceiver` to return a mock receiver with a `close` method
 * - `createCompactionWorker` to return a mock CompactionWorker
 * - `createExtractionWorker` to return a mock ExtractionWorker
 * - `createBufferWatcher` to return a mock BufferWatcher
 * - `createBufferStore` to return a mock BufferStore
 *
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirements 12.1, 12.2, 12.3, 16.2, 16.3
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import type { StorageBackend } from '../../src/types/index.js';
import type { CompactionWorker } from '../../src/collector/buffer/compaction.js';
import type { BufferWatcher } from '../../src/collector/buffer/watcher.js';
import type { BufferStore } from '../../src/collector/buffer/store.js';
import type { ExtractionWorker } from '../../src/collector/buffer/extraction.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() =>
    Promise.resolve({
      sendPrompt: vi.fn(() => Promise.resolve('')),
      destroy: vi.fn(),
    }),
  ),
}));

// ── Mock SQLite storage ─────────────────────────────────────────────────

const mockStorage: StorageBackend = {
  putEvent: vi.fn(async () => undefined),
  getEventById: vi.fn(async () => null),
  putMemoryRecord: vi.fn(async () => undefined),
  searchMemoryRecords: vi.fn(async () => []),
  close: vi.fn(async () => undefined),
  getStats: vi.fn(async () => ({
    total_events: 0,
    total_memories: 0,
    total_projects: 0,
    total_concepts: 0,
    observation_types: {},
    event_kinds: {},
  })),
  listProjects: vi.fn(async () => []),
  listMemoryRecords: vi.fn(async () => ({ items: [], total: 0 })),
  listEvents: vi.fn(async () => ({ items: [], total: 0 })),
};

vi.mock('../../src/collector/storage/sqlite/index.js', () => ({
  openSqliteStorage: vi.fn(() => mockStorage),
}));

// ── Mock HTTP receiver ──────────────────────────────────────────────────

const mockReceiverClose = vi.fn(async () => undefined);

vi.mock('../../src/collector/receiver/index.js', () => ({
  startReceiver: vi.fn(() =>
    Promise.resolve({
      server: {},
      close: mockReceiverClose,
    }),
  ),
}));

// ── Mock CompactionWorker ───────────────────────────────────────────────

const mockCompactionDrain = vi.fn(async () => undefined);
const mockCompactionCompact = vi.fn(async () => ({
  projectId: 'test',
  entriesBefore: 0,
  entriesAfter: 0,
  bytesSaved: 0,
  modelDurationMs: 0,
  replaceDurationMs: 0,
  usedFallback: false,
}));

let capturedCompactionWorker: CompactionWorker;

vi.mock('../../src/collector/buffer/compaction.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    createCompactionWorker: vi.fn(() => {
      capturedCompactionWorker = {
        compact: mockCompactionCompact,
        drain: mockCompactionDrain,
        get active() { return false; },
      };
      return capturedCompactionWorker;
    }),
  };
});

// ── Mock ExtractionWorker ───────────────────────────────────────────────

const mockExtractionDrain = vi.fn(async () => undefined);
const mockExtractionExtract = vi.fn(async () => ({
  projectId: 'test',
  entriesProcessed: 0,
  memoriesCreated: 0,
  durationMs: 0,
}));

vi.mock('../../src/collector/buffer/extraction.js', () => ({
  createExtractionWorker: vi.fn(() => ({
    extract: mockExtractionExtract,
    drain: mockExtractionDrain,
  } satisfies ExtractionWorker)),
}));

// ── Mock BufferWatcher ──────────────────────────────────────────────────

let _capturedExtractionHandler: ((projectId: string) => void) | null = null;
let capturedCompactionHandler: ((projectId: string) => void) | null = null;
const mockWatcherClose = vi.fn();
const mockNotifyAppend = vi.fn(() => true);
const mockNotifyCompactionResult = vi.fn();
const mockNotifyExtractionResult = vi.fn();

vi.mock('../../src/collector/buffer/watcher.js', () => ({
  createBufferWatcher: vi.fn(() => ({
    notifyAppend: mockNotifyAppend,
    wouldExceedCeiling: vi.fn(() => false),
    notifyExtractionResult: mockNotifyExtractionResult,
    notifyCompactionResult: mockNotifyCompactionResult,
    onExtraction: vi.fn((handler: (projectId: string) => void) => {
      _capturedExtractionHandler = handler;
    }),
    onCompaction: vi.fn((handler: (projectId: string) => void) => {
      capturedCompactionHandler = handler;
    }),
    close: mockWatcherClose,
    _getState: vi.fn(() => undefined),
  } satisfies BufferWatcher)),
}));

// ── Mock BufferStore ────────────────────────────────────────────────────

const mockBufferStoreListProjects = vi.fn(async () => [] as string[]);
const mockBufferStoreSize = vi.fn(async () => 0);

vi.mock('../../src/collector/buffer/store.js', () => ({
  createBufferStore: vi.fn(() => ({
    append: vi.fn(async () => 0),
    snapshot: vi.fn(async () => []),
    snapshotWithSize: vi.fn(async () => ({ entries: [], sizeBytes: 0 })),
    size: mockBufferStoreSize,
    bufferPath: vi.fn((projectId: string) => `/mock/buffers/${projectId}/buffer.ndjson`),
    listProjects: mockBufferStoreListProjects,
    clear: vi.fn(async () => undefined),
    sizeSync: vi.fn(() => 0),
    replace: vi.fn(async () => ({ catchUpEntries: [], newSizeBytes: 0 })),
  } satisfies BufferStore)),
}));

// ── Mock pipeline ───────────────────────────────────────────────────────

vi.mock('../../src/collector/pipeline/index.js', () => ({
  createPipeline: vi.fn(() => ({
    process: vi.fn(async () => ({ event_id: 'test', stored: true })),
    extraction: {
      enqueue: vi.fn(),
      drain: vi.fn(async () => undefined),
      get active() { return 0; },
    },
  })),
}));

// ── Test helpers ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-compaction-wiring-'));
  vi.clearAllMocks();
  _capturedExtractionHandler = null;
  capturedCompactionHandler = null;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('Collector compaction wiring', () => {
  it('creates CompactionWorker when compactionEnabled: true', async () => {
    /**
     * **Validates: Requirements 12.1**
     *
     * When `compactionEnabled` is true and buffer mode is enabled,
     * `startCollector` should instantiate a CompactionWorker and wire
     * the BufferWatcher's `onCompaction` handler.
     */
    const { createCompactionWorker } = await import('../../src/collector/buffer/compaction.js');
    const { startCollector } = await import('../../src/collector/index.js');

    const bufferDir = path.join(tmpDir, 'buffers');

    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'test.db'),
      bufferEnabled: true,
      bufferDir,
      compactionEnabled: true,
      port: 0,
      embeddingEnabled: false,
    });

    // createCompactionWorker should have been called
    expect(createCompactionWorker).toHaveBeenCalledOnce();

    // The onCompaction handler should have been registered
    expect(capturedCompactionHandler).not.toBeNull();

    expect(handle).toBeDefined();
    await handle.close();
  });

  it('does NOT create CompactionWorker when compactionEnabled: false (default)', async () => {
    /**
     * **Validates: Requirements 12.1**
     *
     * When `compactionEnabled` is false (the default), `startCollector`
     * should NOT instantiate a CompactionWorker.
     */
    const { createCompactionWorker } = await import('../../src/collector/buffer/compaction.js');
    const { startCollector } = await import('../../src/collector/index.js');

    const bufferDir = path.join(tmpDir, 'buffers-no-compact');

    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'test.db'),
      bufferEnabled: true,
      bufferDir,
      // compactionEnabled defaults to false
      port: 0,
      embeddingEnabled: false,
    });

    // createCompactionWorker should NOT have been called
    expect(createCompactionWorker).not.toHaveBeenCalled();

    // No compaction handler should be registered
    expect(capturedCompactionHandler).toBeNull();

    expect(handle).toBeDefined();
    await handle.close();
  });

  it('shutdown drains CompactionWorker before closing storage', async () => {
    /**
     * **Validates: Requirements 12.2**
     *
     * When the collector shuts down with compaction enabled, it should:
     * 1. Close the receiver
     * 2. Drain the extraction worker
     * 3. Drain the compaction worker
     * 4. Close the buffer watcher
     * 5. Close storage
     *
     * We verify the drain is called and that storage.close() is called
     * after the compaction worker drain.
     */
    const { startCollector } = await import('../../src/collector/index.js');

    const bufferDir = path.join(tmpDir, 'buffers-shutdown');

    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'test-shutdown.db'),
      bufferEnabled: true,
      bufferDir,
      compactionEnabled: true,
      port: 0,
      embeddingEnabled: false,
    });

    // Track call order
    const callOrder: string[] = [];
    mockReceiverClose.mockImplementation(async () => { callOrder.push('receiver.close'); });
    mockExtractionDrain.mockImplementation(async () => { callOrder.push('extraction.drain'); });
    mockCompactionDrain.mockImplementation(async () => { callOrder.push('compaction.drain'); });
    mockWatcherClose.mockImplementation(() => { callOrder.push('watcher.close'); });
    (mockStorage.close as ReturnType<typeof vi.fn>).mockImplementation(async () => { callOrder.push('storage.close'); });

    await handle.close();

    // CompactionWorker.drain should have been called
    expect(mockCompactionDrain).toHaveBeenCalledOnce();

    // Verify ordering: receiver → extraction drain → compaction drain → watcher close → storage close
    expect(callOrder).toEqual([
      'receiver.close',
      'extraction.drain',
      'compaction.drain',
      'watcher.close',
      'storage.close',
    ]);
  });

  it('startup cleans up orphaned temp files', async () => {
    /**
     * **Validates: Requirements 16.3**
     *
     * When the collector starts with buffer mode enabled, it should
     * clean up orphaned temp files (matching `buffer.ndjson.*.tmp`)
     * in buffer directories. These can be left behind if the daemon
     * dies during a compaction replace.
     */
    const { startCollector } = await import('../../src/collector/index.js');

    const bufferDir = path.join(tmpDir, 'buffers-cleanup');

    // Create a project directory with orphaned temp files
    const projectId = 'abc123def456';
    const projectBufferDir = path.join(bufferDir, projectId);
    fs.mkdirSync(projectBufferDir, { recursive: true });

    // Create orphaned temp files matching the pattern buffer.ndjson.<timestamp>.tmp
    const orphanedTmp1 = path.join(projectBufferDir, 'buffer.ndjson.1700000000000.tmp');
    const orphanedTmp2 = path.join(projectBufferDir, 'buffer.ndjson.1700000001000.tmp');
    fs.writeFileSync(orphanedTmp1, '{"partial":"data"}\n', 'utf-8');
    fs.writeFileSync(orphanedTmp2, '{"partial":"data2"}\n', 'utf-8');

    // Also create a legitimate buffer file that should NOT be removed
    const bufferFile = path.join(projectBufferDir, 'buffer.ndjson');
    fs.writeFileSync(bufferFile, '{"event_id":"test"}\n', 'utf-8');

    // Start the collector — it should clean up orphaned temp files
    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'test-cleanup.db'),
      bufferEnabled: true,
      bufferDir,
      bufferIdleMs: 60_000, // long idle to prevent extraction during test
      port: 0,
      embeddingEnabled: false,
    });

    // Orphaned temp files should have been removed
    expect(fs.existsSync(orphanedTmp1)).toBe(false);
    expect(fs.existsSync(orphanedTmp2)).toBe(false);

    // The legitimate buffer file should still exist
    expect(fs.existsSync(bufferFile)).toBe(true);

    await handle.close();
  });

  it('startup re-arms compaction triggers for oversized buffers', async () => {
    /**
     * **Validates: Requirements 16.2**
     *
     * When the collector starts with buffer mode enabled, it should
     * scan existing buffer files and re-arm triggers for buffers
     * exceeding the compaction threshold. This is done by calling
     * `bufferWatcher.notifyAppend(projectId, size)` for each
     * non-empty buffer, which triggers the watcher's threshold checks
     * including the compaction threshold.
     */
    const { startCollector } = await import('../../src/collector/index.js');

    const bufferDir = path.join(tmpDir, 'buffers-rearm');

    // Mock the buffer store to report existing projects with oversized buffers
    const oversizedProjectId = 'oversized123';
    mockBufferStoreListProjects.mockResolvedValueOnce([oversizedProjectId]);
    // Report a size above the compaction threshold (default 1 MiB)
    mockBufferStoreSize.mockResolvedValueOnce(2_000_000);

    const handle = await startCollector({
      storagePath: path.join(tmpDir, 'test-rearm.db'),
      bufferEnabled: true,
      bufferDir,
      compactionEnabled: true,
      bufferIdleMs: 60_000, // long idle to prevent extraction during test
      port: 0,
      embeddingEnabled: false,
    });

    // The watcher's notifyAppend should have been called with the project's size
    // to re-arm triggers (including compaction threshold check)
    expect(mockNotifyAppend).toHaveBeenCalledWith(oversizedProjectId, 2_000_000);

    await handle.close();
  });
});
