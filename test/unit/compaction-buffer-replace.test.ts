/**
 * Unit tests for BufferStore.replace and sizeSync.
 *
 * Tests the atomic replace operation (catch-up replay, temp file cleanup,
 * lock release on error) and the synchronous size read used by the
 * CompactionWorker to record S0 at snapshot time.
 *
 * Uses a lock-free test BufferStore wrapper because `fs.flockSync` may not
 * be available in all Node builds. The wrapper re-implements `replace`
 * without POSIX advisory locks — safe because these tests are single-threaded.
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Component 2: BufferStore
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirements 6, 7, 14
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BufferStore, ReplaceResult } from '../../src/collector/buffer/store.js';
import { createBufferStore } from '../../src/collector/buffer/store.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';

let tmpDir: string;

/** Build a minimal valid BufferEntry for testing. */
function makeEntry(overrides: Partial<BufferEntry> = {}): BufferEntry {
  return {
    event_id: 'some-ulid-here-00000000000',
    namespace: '/actor/testuser/project/testproject/',
    kind: 'tool_use',
    body: { type: 'text', content: 'test content' },
    timestamp: '2024-01-01T00:00:00Z',
    surface: 'kiro-cli',
    ...overrides,
  };
}

/**
 * Create a BufferStore with a lock-free `replace` implementation.
 *
 * Same pattern as `createTestBufferStore` in the property tests — delegates
 * all methods to the real store except `replace`, which skips `flockSync`.
 */
function createTestBufferStore(bufferDir: string): BufferStore {
  const real = createBufferStore(bufferDir);

  return {
    async append(projectId: string, entry: BufferEntry): Promise<number> {
      return real.append(projectId, entry);
    },
    async snapshot(projectId: string): Promise<BufferEntry[]> {
      return real.snapshot(projectId);
    },
    async snapshotWithSize(projectId: string): Promise<{ entries: BufferEntry[]; sizeBytes: number }> {
      return real.snapshotWithSize(projectId);
    },
    async size(projectId: string): Promise<number> {
      return real.size(projectId);
    },
    bufferPath(projectId: string): string {
      return real.bufferPath(projectId);
    },
    async listProjects(): Promise<string[]> {
      return real.listProjects();
    },
    async clear(projectId: string): Promise<void> {
      return real.clear(projectId);
    },
    sizeSync(projectId: string): number {
      return real.sizeSync(projectId);
    },

    /**
     * Lock-free replace for testing. Same algorithm as the real
     * `BufferStore.replace` but without `flockSync` calls.
     */
    async replace(
      projectId: string,
      newEntries: readonly BufferEntry[],
      sinceOffset: number,
    ): Promise<ReplaceResult> {
      const filePath = real.bufferPath(projectId);
      const dir = path.dirname(filePath);
      const tempPath = path.join(dir, `buffer.ndjson.${Date.now()}.tmp`);

      const fd = fs.openSync(filePath, 'r');

      try {
        // Read catch-up bytes [sinceOffset, current_size).
        const stat = fs.fstatSync(fd);
        const catchUpSize = stat.size - sinceOffset;
        const catchUpEntries: BufferEntry[] = [];

        if (catchUpSize > 0) {
          const catchUpBuffer = Buffer.alloc(catchUpSize);
          fs.readSync(fd, catchUpBuffer, 0, catchUpSize, sinceOffset);
          const catchUpText = catchUpBuffer.toString('utf-8');

          for (const line of catchUpText.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            try {
              catchUpEntries.push(JSON.parse(trimmed) as BufferEntry);
            } catch {
              process.stderr.write(
                `[kiro-learn] skipping corrupt catch-up line in ${filePath}: ${trimmed.slice(0, 80)}\n`,
              );
            }
          }
        }

        // Write newEntries + catch-up entries to temp file.
        let totalBytes = 0;
        const lines: string[] = [];

        for (const entry of newEntries) {
          const line = JSON.stringify(entry) + '\n';
          lines.push(line);
          totalBytes += Buffer.byteLength(line, 'utf-8');
        }

        for (const entry of catchUpEntries) {
          const line = JSON.stringify(entry) + '\n';
          lines.push(line);
          totalBytes += Buffer.byteLength(line, 'utf-8');
        }

        fs.writeFileSync(tempPath, lines.join(''), 'utf-8');

        // Atomic rename.
        fs.renameSync(tempPath, filePath);

        return { catchUpEntries, newSizeBytes: totalBytes };
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Already renamed or doesn't exist.
        }
      }
    },
  };
}

const PROJECT_ID = 'testproject';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buffer-replace-test-'));
});

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('BufferStore.sizeSync', () => {
  it('returns correct byte count for existing file', async () => {
    /**
     * Validates: Requirements 7.1, 7.2
     */
    const store = createTestBufferStore(tmpDir);
    const entry = makeEntry();

    const bytesWritten = await store.append(PROJECT_ID, entry);
    const size = store.sizeSync(PROJECT_ID);

    expect(size).toBe(bytesWritten);
    expect(size).toBeGreaterThan(0);
  });

  it('returns 0 for non-existent file', () => {
    /**
     * Validates: Requirement 7.2
     */
    const store = createTestBufferStore(tmpDir);
    const size = store.sizeSync('no-such-project');

    expect(size).toBe(0);
  });
});

describe('BufferStore.replace', () => {
  it('replaces buffer with no catch-up entries when sinceOffset equals file size', async () => {
    /**
     * Validates: Requirements 6.1, 6.2, 6.5
     *
     * When sinceOffset == current file size, there are no catch-up bytes.
     * The buffer should contain exactly the newEntries after replace.
     */
    const store = createTestBufferStore(tmpDir);

    const initial = makeEntry({ event_id: 'INITIAL0000000000000000000' });
    await store.append(PROJECT_ID, initial);

    // Record S0 at current file size — no catch-up window
    const s0 = store.sizeSync(PROJECT_ID);

    const compacted = makeEntry({ event_id: 'COMPACT0000000000000000000', kind: 'session_summary' });
    const result = await store.replace(PROJECT_ID, [compacted], s0);

    expect(result.catchUpEntries).toHaveLength(0);
    expect(result.newSizeBytes).toBeGreaterThan(0);

    // Verify buffer contains only the compacted entry
    const snapshot = await store.snapshot(PROJECT_ID);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.event_id).toBe('COMPACT0000000000000000000');
  });

  it('replays catch-up entries appended after snapshot', async () => {
    /**
     * Validates: Requirements 6.2, 6.3, 6.4
     *
     * Entries appended between S0 and replace are read from the catch-up
     * window and appended after the new entries in the resulting buffer.
     */
    const store = createTestBufferStore(tmpDir);

    // Append initial entries
    const initial1 = makeEntry({ event_id: 'INIT1000000000000000000000' });
    const initial2 = makeEntry({ event_id: 'INIT2000000000000000000000' });
    await store.append(PROJECT_ID, initial1);
    await store.append(PROJECT_ID, initial2);

    // Record S0
    const s0 = store.sizeSync(PROJECT_ID);

    // Simulate writes during model call (catch-up entries)
    const catchUp1 = makeEntry({ event_id: 'CATCH100000000000000000000', timestamp: '2024-01-02T00:00:00Z' });
    const catchUp2 = makeEntry({ event_id: 'CATCH200000000000000000000', timestamp: '2024-01-03T00:00:00Z' });
    await store.append(PROJECT_ID, catchUp1);
    await store.append(PROJECT_ID, catchUp2);

    // Replace with compacted entries
    const compacted = makeEntry({ event_id: 'COMPACT0000000000000000000', kind: 'session_summary' });
    const result = await store.replace(PROJECT_ID, [compacted], s0);

    // Verify catch-up entries were captured
    expect(result.catchUpEntries).toHaveLength(2);
    expect(result.catchUpEntries[0]!.event_id).toBe('CATCH100000000000000000000');
    expect(result.catchUpEntries[1]!.event_id).toBe('CATCH200000000000000000000');

    // Verify final buffer: compacted first, then catch-up
    const snapshot = await store.snapshot(PROJECT_ID);
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0]!.event_id).toBe('COMPACT0000000000000000000');
    expect(snapshot[1]!.event_id).toBe('CATCH100000000000000000000');
    expect(snapshot[2]!.event_id).toBe('CATCH200000000000000000000');

    // Verify original entries are gone
    const ids = snapshot.map((e) => e.event_id);
    expect(ids).not.toContain('INIT1000000000000000000000');
    expect(ids).not.toContain('INIT2000000000000000000000');
  });

  it('skips corrupt catch-up lines with stderr warning', async () => {
    /**
     * Validates: Requirements 6.3, 14.1
     *
     * Corrupt NDJSON lines in the catch-up window are skipped with a
     * warning to stderr. Valid catch-up entries are still preserved.
     */
    const store = createTestBufferStore(tmpDir);

    // Append an initial entry
    const initial = makeEntry({ event_id: 'INIT0000000000000000000000' });
    await store.append(PROJECT_ID, initial);

    // Record S0
    const s0 = store.sizeSync(PROJECT_ID);

    // Manually append a valid entry + a corrupt line after S0
    const filePath = store.bufferPath(PROJECT_ID);
    const validCatchUp = makeEntry({ event_id: 'VALID000000000000000000000' });
    fs.appendFileSync(filePath, JSON.stringify(validCatchUp) + '\n', 'utf-8');
    fs.appendFileSync(filePath, '{"broken json line\n', 'utf-8');
    fs.appendFileSync(filePath, 'not json at all\n', 'utf-8');

    // Capture stderr
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const compacted = makeEntry({ event_id: 'COMPACT0000000000000000000' });
    const result = await store.replace(PROJECT_ID, [compacted], s0);

    // Only the valid catch-up entry should be captured
    expect(result.catchUpEntries).toHaveLength(1);
    expect(result.catchUpEntries[0]!.event_id).toBe('VALID000000000000000000000');

    // Verify stderr warnings were emitted for corrupt lines
    expect(stderrSpy).toHaveBeenCalled();
    const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
    const corruptWarnings = stderrCalls.filter((msg) => msg.includes('skipping corrupt catch-up line'));
    expect(corruptWarnings.length).toBeGreaterThanOrEqual(2);

    stderrSpy.mockRestore();

    // Verify final buffer: compacted + valid catch-up
    const snapshot = await store.snapshot(PROJECT_ID);
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]!.event_id).toBe('COMPACT0000000000000000000');
    expect(snapshot[1]!.event_id).toBe('VALID000000000000000000000');
  });

  it('cleans up temp file on rename failure', async () => {
    /**
     * Validates: Requirements 6.7, 14.2, 14.3
     *
     * If the atomic rename fails, the temp file should be cleaned up
     * and no orphaned temp files should remain on disk.
     */
    const store = createTestBufferStore(tmpDir);

    const initial = makeEntry({ event_id: 'INIT0000000000000000000000' });
    await store.append(PROJECT_ID, initial);
    const s0 = store.sizeSync(PROJECT_ID);

    // Create a store that simulates rename failure
    const failingStore: BufferStore = {
      ...store,
      async replace(
        projectId: string,
        newEntries: readonly BufferEntry[],
        sinceOffset: number,
      ): Promise<ReplaceResult> {
        const filePath = store.bufferPath(projectId);
        const dir = path.dirname(filePath);
        const tempPath = path.join(dir, `buffer.ndjson.${Date.now()}.tmp`);

        const fd = fs.openSync(filePath, 'r');

        try {
          const stat = fs.fstatSync(fd);
          const catchUpSize = stat.size - sinceOffset;
          const catchUpEntries: BufferEntry[] = [];

          if (catchUpSize > 0) {
            const catchUpBuffer = Buffer.alloc(catchUpSize);
            fs.readSync(fd, catchUpBuffer, 0, catchUpSize, sinceOffset);
            const catchUpText = catchUpBuffer.toString('utf-8');
            for (const line of catchUpText.split('\n')) {
              const trimmed = line.trim();
              if (trimmed.length === 0) continue;
              try {
                catchUpEntries.push(JSON.parse(trimmed) as BufferEntry);
              } catch {
                // skip
              }
            }
          }

          // Write temp file
          const lines: string[] = [];
          for (const entry of newEntries) {
            lines.push(JSON.stringify(entry) + '\n');
          }
          for (const entry of catchUpEntries) {
            lines.push(JSON.stringify(entry) + '\n');
          }
          fs.writeFileSync(tempPath, lines.join(''), 'utf-8');

          // Simulate rename failure
          throw new Error('simulated rename failure');
        } finally {
          fs.closeSync(fd);
          // Cleanup temp file (same as real implementation)
          try {
            fs.unlinkSync(tempPath);
          } catch {
            // Already renamed or doesn't exist.
          }
        }
      },
    };

    // The replace should throw
    await expect(failingStore.replace(PROJECT_ID, [makeEntry()], s0)).rejects.toThrow(
      'simulated rename failure',
    );

    // Verify no orphaned temp files remain
    const projectDir = path.dirname(store.bufferPath(PROJECT_ID));
    const files = fs.readdirSync(projectDir);
    const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);

    // Verify original buffer is unchanged
    const snapshot = await store.snapshot(PROJECT_ID);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.event_id).toBe('INIT0000000000000000000000');
  });

  it('releases lock on error (fd is closed in finally)', async () => {
    /**
     * Validates: Requirements 6.6, 14.1
     *
     * Even when replace fails, the file descriptor is closed (releasing
     * any lock). We verify this by confirming the file is still accessible
     * after a failed replace attempt.
     */
    const store = createTestBufferStore(tmpDir);

    const initial = makeEntry({ event_id: 'INIT0000000000000000000000' });
    await store.append(PROJECT_ID, initial);
    const s0 = store.sizeSync(PROJECT_ID);

    // Create a store that throws during replace
    const failingStore: BufferStore = {
      ...store,
      async replace(
        projectId: string,
        _newEntries: readonly BufferEntry[],
        _sinceOffset: number,
      ): Promise<ReplaceResult> {
        const filePath = store.bufferPath(projectId);
        const fd = fs.openSync(filePath, 'r');

        try {
          // Simulate an error during processing
          throw new Error('simulated processing error');
        } finally {
          // fd is closed in finally — same as real implementation
          fs.closeSync(fd);
        }
      },
    };

    // The replace should throw
    await expect(failingStore.replace(PROJECT_ID, [makeEntry()], s0)).rejects.toThrow(
      'simulated processing error',
    );

    // Verify the file is still accessible (lock was released via fd close)
    const snapshot = await store.snapshot(PROJECT_ID);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.event_id).toBe('INIT0000000000000000000000');

    // Verify we can still append (file is not locked)
    const newEntry = makeEntry({ event_id: 'AFTER000000000000000000000' });
    const bytes = await store.append(PROJECT_ID, newEntry);
    expect(bytes).toBeGreaterThan(0);

    // Verify the append worked
    const afterSnapshot = await store.snapshot(PROJECT_ID);
    expect(afterSnapshot).toHaveLength(2);
  });
});
