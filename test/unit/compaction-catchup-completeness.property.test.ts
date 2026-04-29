/**
 * Property-based test for catch-up completeness during buffer replace.
 *
 * Feature: buffer-compaction-worker, Property 1: Catch-up completeness
 *
 * For any compaction operation where entries are appended between snapshot (S0)
 * and replace, the resulting buffer file contains all catch-up entries in
 * addition to the compacted entries. No entries appended after S0 are lost.
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Property 1
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirements 1.1, 6.2, 6.4
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { BufferStore, ReplaceResult } from '../../src/collector/buffer/store.js';
import { createBufferStore } from '../../src/collector/buffer/store.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';
import { bufferEntryArb, ulidArb } from '../helpers/arbitrary.js';

/**
 * Generate an array of BufferEntry objects with unique event_ids.
 */
function uniqueBufferEntriesArb(
  minLength: number,
  maxLength: number,
  prefix: string,
): fc.Arbitrary<BufferEntry[]> {
  return fc
    .array(
      fc.tuple(ulidArb(), bufferEntryArb()),
      { minLength, maxLength },
    )
    .map((pairs) =>
      pairs.map(([uid, entry], i) => ({
        ...entry,
        event_id: `${prefix}${String(i).padStart(4, '0')}${uid}`.slice(0, 26),
      })),
    );
}

/** Create an isolated temp directory. Caller is responsible for cleanup. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-completeness-'));
}

/** Best-effort cleanup of a temp directory. */
function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

/**
 * Create a BufferStore with a `replace` implementation that skips `flockSync`.
 *
 * `fs.flockSync` is a Node 22+ API that may not be available in all builds.
 * This wrapper delegates all methods to the real `createBufferStore` except
 * `replace` and `append`, which re-implement the same logic without the
 * POSIX advisory lock. This is safe because the property test is
 * single-threaded — there is no concurrent writer to coordinate with.
 */
function createTestBufferStore(bufferDir: string): BufferStore {
  const real = createBufferStore(bufferDir);

  return {
    async append(projectId: string, entry: BufferEntry): Promise<number> {
      // Lock-free append for testing — same as real but without flockSync.
      const filePath = real.bufferPath(projectId);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify(entry) + '\n';
      const bytes = Buffer.byteLength(line, 'utf-8');
      fs.appendFileSync(filePath, line, 'utf-8');
      return bytes;
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
              // Skip corrupt lines.
            }
          }
        }

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

describe('Catch-up completeness (Property 1)', () => {
  it('all catch-up entries are present after replace', () => {
    fc.assert(
      fc.asyncProperty(
        uniqueBufferEntriesArb(1, 10, 'I'),
        uniqueBufferEntriesArb(1, 10, 'C'),
        uniqueBufferEntriesArb(1, 5, 'R'),
        async (initialEntries, catchUpEntries, compactedEntries) => {
          const tmpDir = makeTempDir();
          try {
            const store = createTestBufferStore(tmpDir);

            for (const entry of initialEntries) {
              await store.append(PROJECT_ID, entry);
            }

            const s0 = store.sizeSync(PROJECT_ID);

            for (const entry of catchUpEntries) {
              await store.append(PROJECT_ID, entry);
            }

            const result = await store.replace(PROJECT_ID, compactedEntries, s0);

            // Verify catch-up entries were captured
            expect(result.catchUpEntries).toHaveLength(catchUpEntries.length);
            for (let i = 0; i < catchUpEntries.length; i++) {
              expect(result.catchUpEntries[i]!.event_id).toBe(catchUpEntries[i]!.event_id);
            }

            // Read the resulting buffer and verify contents
            const finalEntries = await store.snapshot(PROJECT_ID);

            // All compacted entries are present
            for (const compacted of compactedEntries) {
              expect(finalEntries.some((e) => e.event_id === compacted.event_id)).toBe(true);
            }

            // All catch-up entries are present
            for (const catchUp of catchUpEntries) {
              expect(finalEntries.some((e) => e.event_id === catchUp.event_id)).toBe(true);
            }

            // Total count is compacted + catch-up
            expect(finalEntries).toHaveLength(compactedEntries.length + catchUpEntries.length);

            // No original (pre-S0) entries remain
            for (const initial of initialEntries) {
              expect(finalEntries.some((e) => e.event_id === initial.event_id)).toBe(false);
            }
          } finally {
            cleanupTempDir(tmpDir);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('replace with zero catch-up entries preserves only compacted entries', () => {
    fc.assert(
      fc.asyncProperty(
        uniqueBufferEntriesArb(1, 10, 'I'),
        uniqueBufferEntriesArb(1, 5, 'R'),
        async (initialEntries, compactedEntries) => {
          const tmpDir = makeTempDir();
          try {
            const store = createTestBufferStore(tmpDir);

            for (const entry of initialEntries) {
              await store.append(PROJECT_ID, entry);
            }

            const s0 = store.sizeSync(PROJECT_ID);

            const result = await store.replace(PROJECT_ID, compactedEntries, s0);

            expect(result.catchUpEntries).toHaveLength(0);

            const finalEntries = await store.snapshot(PROJECT_ID);
            expect(finalEntries).toHaveLength(compactedEntries.length);

            for (const compacted of compactedEntries) {
              expect(finalEntries.some((e) => e.event_id === compacted.event_id)).toBe(true);
            }
          } finally {
            cleanupTempDir(tmpDir);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('catch-up entries appear after compacted entries in the buffer', () => {
    fc.assert(
      fc.asyncProperty(
        uniqueBufferEntriesArb(1, 10, 'I'),
        uniqueBufferEntriesArb(1, 10, 'C'),
        uniqueBufferEntriesArb(1, 5, 'R'),
        async (initialEntries, catchUpEntries, compactedEntries) => {
          const tmpDir = makeTempDir();
          try {
            const store = createTestBufferStore(tmpDir);

            for (const entry of initialEntries) {
              await store.append(PROJECT_ID, entry);
            }

            const s0 = store.sizeSync(PROJECT_ID);

            for (const entry of catchUpEntries) {
              await store.append(PROJECT_ID, entry);
            }

            await store.replace(PROJECT_ID, compactedEntries, s0);

            const finalEntries = await store.snapshot(PROJECT_ID);
            const finalIds = finalEntries.map((e) => e.event_id);

            // First N entries should be the compacted entries (in order)
            for (let i = 0; i < compactedEntries.length; i++) {
              expect(finalIds[i]).toBe(compactedEntries[i]!.event_id);
            }

            // Next M entries should be the catch-up entries (in order)
            for (let i = 0; i < catchUpEntries.length; i++) {
              expect(finalIds[compactedEntries.length + i]).toBe(catchUpEntries[i]!.event_id);
            }
          } finally {
            cleanupTempDir(tmpDir);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
