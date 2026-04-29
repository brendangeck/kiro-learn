/**
 * Property-based test for replace temp file cleanup.
 *
 * Feature: buffer-compaction-worker, Property 9: Replace temp file cleanup
 *
 * For any `BufferStore.replace()` call, whether successful or failed, no
 * orphaned temp files remain on disk after the operation completes.
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Property 9
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirements 6.7, 14.2, 14.3
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'temp-cleanup-'));
}

/** Best-effort cleanup of a temp directory. */
function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

/** Check if any `buffer.ndjson.*.tmp` files exist in the given directory. */
function findOrphanedTmpFiles(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir);
    return entries.filter((name) => /^buffer\.ndjson\.\d+\.tmp$/.test(name));
  } catch {
    return [];
  }
}

/**
 * Create a BufferStore with a lock-free `replace` and `append` for testing.
 */
function createTestBufferStore(bufferDir: string): BufferStore {
  const real = createBufferStore(bufferDir);

  return {
    async append(projectId: string, entry: BufferEntry): Promise<number> {
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

describe('Replace temp file cleanup (Property 9)', () => {
  it('no orphaned temp files remain after a successful replace', () => {
    fc.assert(
      fc.asyncProperty(
        uniqueBufferEntriesArb(1, 10, 'I'),
        uniqueBufferEntriesArb(0, 5, 'C'),
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

            const bufferDir = path.dirname(store.bufferPath(PROJECT_ID));
            const orphanedTmpFiles = findOrphanedTmpFiles(bufferDir);

            expect(orphanedTmpFiles).toEqual([]);
          } finally {
            cleanupTempDir(tmpDir);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('no orphaned temp files remain after a failed replace (rename failure)', () => {
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

            // Create a failing store that throws during rename
            const filePath = store.bufferPath(PROJECT_ID);
            const dir = path.dirname(filePath);
            const tempPath = path.join(dir, `buffer.ndjson.${Date.now()}.tmp`);

            const fd = fs.openSync(filePath, 'r');

            try {
              const stat = fs.fstatSync(fd);
              const catchUpSize = stat.size - s0;
              const lines: string[] = [];

              if (catchUpSize > 0) {
                const catchUpBuffer = Buffer.alloc(catchUpSize);
                fs.readSync(fd, catchUpBuffer, 0, catchUpSize, s0);
                const catchUpText = catchUpBuffer.toString('utf-8');
                for (const line of catchUpText.split('\n')) {
                  const trimmed = line.trim();
                  if (trimmed.length === 0) continue;
                  lines.push(JSON.stringify(JSON.parse(trimmed)) + '\n');
                }
              }

              for (const entry of compactedEntries) {
                lines.push(JSON.stringify(entry) + '\n');
              }

              fs.writeFileSync(tempPath, lines.join(''), 'utf-8');

              // Simulate rename failure
              throw new Error('simulated rename failure');
            } catch {
              // Expected — the replace "failed".
            } finally {
              fs.closeSync(fd);
              try {
                fs.unlinkSync(tempPath);
              } catch {
                // Already gone.
              }
            }

            const bufferDir = path.dirname(store.bufferPath(PROJECT_ID));
            const orphanedTmpFiles = findOrphanedTmpFiles(bufferDir);

            expect(orphanedTmpFiles).toEqual([]);
          } finally {
            cleanupTempDir(tmpDir);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('no orphaned temp files remain after replace with empty compacted entries', () => {
    fc.assert(
      fc.asyncProperty(
        uniqueBufferEntriesArb(1, 10, 'I'),
        uniqueBufferEntriesArb(0, 5, 'C'),
        async (initialEntries, catchUpEntries) => {
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

            await store.replace(PROJECT_ID, [], s0);

            const bufferDir = path.dirname(store.bufferPath(PROJECT_ID));
            const orphanedTmpFiles = findOrphanedTmpFiles(bufferDir);

            expect(orphanedTmpFiles).toEqual([]);
          } finally {
            cleanupTempDir(tmpDir);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
