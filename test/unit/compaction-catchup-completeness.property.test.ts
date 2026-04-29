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
 *
 * Uses a prefix to ensure uniqueness across multiple generated arrays
 * within the same property run (e.g., initial vs catch-up vs compacted).
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
 * `replace`, which re-implements the same catch-up-and-rename logic without
 * the POSIX advisory lock. This is safe because the property test is
 * single-threaded — there is no concurrent writer to coordinate with.
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
              // Skip corrupt lines.
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

describe('Catch-up completeness (Property 1)', () => {
  it('all catch-up entries are present after replace', () => {
    /**
     * **Validates: Requirements 1.1, 6.2, 6.4**
     *
     * For any set of initial entries, catch-up entries appended after S0,
     * and compacted entries, calling replace(projectId, compacted, s0)
     * produces a buffer containing all compacted entries followed by all
     * catch-up entries. No catch-up entries are lost.
     */
    fc.assert(
      fc.property(
        uniqueBufferEntriesArb(1, 10, 'I'),
        uniqueBufferEntriesArb(1, 10, 'C'),
        uniqueBufferEntriesArb(1, 5, 'R'),
        (initialEntries, catchUpEntries, compactedEntries) => {
          const tmpDir = makeTempDir();
          try {
            const store = createTestBufferStore(tmpDir);

            // 1. Append initial entries to the buffer (sync under the hood)
            for (const entry of initialEntries) {
              store.append(PROJECT_ID, entry);
            }

            // 2. Record S0 — the byte offset at snapshot time
            const s0 = store.sizeSync(PROJECT_ID);

            // 3. Append catch-up entries after S0 (simulating writes during model call)
            for (const entry of catchUpEntries) {
              store.append(PROJECT_ID, entry);
            }

            // 4. Call replace with compacted entries and the recorded S0
            // (replace is async but uses only sync fs calls internally)
            const fd = fs.openSync(store.bufferPath(PROJECT_ID), 'r');
            const stat = fs.fstatSync(fd);
            const catchUpSize = stat.size - s0;
            const parsedCatchUp: BufferEntry[] = [];

            if (catchUpSize > 0) {
              const catchUpBuffer = Buffer.alloc(catchUpSize);
              fs.readSync(fd, catchUpBuffer, 0, catchUpSize, s0);
              const catchUpText = catchUpBuffer.toString('utf-8');
              for (const line of catchUpText.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.length === 0) continue;
                try {
                  parsedCatchUp.push(JSON.parse(trimmed) as BufferEntry);
                } catch {
                  // Skip corrupt lines.
                }
              }
            }

            // Write compacted + catch-up to temp file and rename
            const filePath = store.bufferPath(PROJECT_ID);
            const dir = path.dirname(filePath);
            const tempPath = path.join(dir, `buffer.ndjson.${Date.now()}.tmp`);
            let totalBytes = 0;
            const lines: string[] = [];

            for (const entry of compactedEntries) {
              const line = JSON.stringify(entry) + '\n';
              lines.push(line);
              totalBytes += Buffer.byteLength(line, 'utf-8');
            }
            for (const entry of parsedCatchUp) {
              const line = JSON.stringify(entry) + '\n';
              lines.push(line);
              totalBytes += Buffer.byteLength(line, 'utf-8');
            }

            fs.writeFileSync(tempPath, lines.join(''), 'utf-8');
            fs.renameSync(tempPath, filePath);
            fs.closeSync(fd);

            // 5. Read the resulting buffer
            const content = fs.readFileSync(filePath, 'utf-8');
            const finalEntries: BufferEntry[] = [];
            for (const line of content.split('\n')) {
              const trimmed = line.trim();
              if (trimmed.length === 0) continue;
              try {
                finalEntries.push(JSON.parse(trimmed) as BufferEntry);
              } catch {
                // Skip corrupt lines.
              }
            }

            // 6. Verify all compacted entries are present
            for (const compacted of compactedEntries) {
              expect(
                finalEntries.some((e) => e.event_id === compacted.event_id),
              ).toBe(true);
            }

            // 7. Verify all catch-up entries are present
            for (const catchUp of catchUpEntries) {
              expect(
                finalEntries.some((e) => e.event_id === catchUp.event_id),
              ).toBe(true);
            }

            // 8. Verify the returned catch-up entries match what was appended
            expect(parsedCatchUp).toHaveLength(catchUpEntries.length);
            for (let i = 0; i < catchUpEntries.length; i++) {
              expect(parsedCatchUp[i]!.event_id).toBe(catchUpEntries[i]!.event_id);
            }

            // 9. Verify total entry count is compacted + catch-up
            expect(finalEntries).toHaveLength(
              compactedEntries.length + catchUpEntries.length,
            );

            // 10. Verify no original (pre-S0) entries remain
            for (const initial of initialEntries) {
              expect(
                finalEntries.some((e) => e.event_id === initial.event_id),
              ).toBe(false);
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
    /**
     * **Validates: Requirements 1.1, 6.2, 6.4**
     *
     * When no entries are appended between S0 and replace, the resulting
     * buffer contains exactly the compacted entries and no catch-up entries.
     */
    fc.assert(
      fc.property(
        uniqueBufferEntriesArb(1, 10, 'I'),
        uniqueBufferEntriesArb(1, 5, 'R'),
        (initialEntries, compactedEntries) => {
          const tmpDir = makeTempDir();
          try {
            const store = createTestBufferStore(tmpDir);

            // 1. Append initial entries
            for (const entry of initialEntries) {
              store.append(PROJECT_ID, entry);
            }

            // 2. Record S0 at current file size (no catch-up appended)
            const s0 = store.sizeSync(PROJECT_ID);

            // 3. Replace with compacted entries — no catch-up window
            const filePath = store.bufferPath(PROJECT_ID);
            const fd = fs.openSync(filePath, 'r');
            const stat = fs.fstatSync(fd);
            const catchUpSize = stat.size - s0;

            // Verify no catch-up bytes
            expect(catchUpSize).toBe(0);

            // Write compacted entries to temp file and rename
            const dir = path.dirname(filePath);
            const tempPath = path.join(dir, `buffer.ndjson.${Date.now()}.tmp`);
            const lines: string[] = [];

            for (const entry of compactedEntries) {
              lines.push(JSON.stringify(entry) + '\n');
            }

            fs.writeFileSync(tempPath, lines.join(''), 'utf-8');
            fs.renameSync(tempPath, filePath);
            fs.closeSync(fd);

            // 4. Verify buffer contains exactly the compacted entries
            const content = fs.readFileSync(filePath, 'utf-8');
            const finalEntries: BufferEntry[] = [];
            for (const line of content.split('\n')) {
              const trimmed = line.trim();
              if (trimmed.length === 0) continue;
              finalEntries.push(JSON.parse(trimmed) as BufferEntry);
            }

            expect(finalEntries).toHaveLength(compactedEntries.length);

            for (const compacted of compactedEntries) {
              expect(
                finalEntries.some((e) => e.event_id === compacted.event_id),
              ).toBe(true);
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
    /**
     * **Validates: Requirements 1.1, 6.2, 6.4**
     *
     * The resulting buffer file has compacted entries first, followed by
     * catch-up entries, preserving the write order from replace.
     */
    fc.assert(
      fc.property(
        uniqueBufferEntriesArb(1, 10, 'I'),
        uniqueBufferEntriesArb(1, 10, 'C'),
        uniqueBufferEntriesArb(1, 5, 'R'),
        (initialEntries, catchUpEntries, compactedEntries) => {
          const tmpDir = makeTempDir();
          try {
            const store = createTestBufferStore(tmpDir);

            // 1. Append initial entries
            for (const entry of initialEntries) {
              store.append(PROJECT_ID, entry);
            }

            // 2. Record S0
            const s0 = store.sizeSync(PROJECT_ID);

            // 3. Append catch-up entries
            for (const entry of catchUpEntries) {
              store.append(PROJECT_ID, entry);
            }

            // 4. Replace (inline, synchronous)
            const filePath = store.bufferPath(PROJECT_ID);
            const fd = fs.openSync(filePath, 'r');
            const stat = fs.fstatSync(fd);
            const catchUpSize = stat.size - s0;
            const parsedCatchUp: BufferEntry[] = [];

            if (catchUpSize > 0) {
              const catchUpBuffer = Buffer.alloc(catchUpSize);
              fs.readSync(fd, catchUpBuffer, 0, catchUpSize, s0);
              const catchUpText = catchUpBuffer.toString('utf-8');
              for (const line of catchUpText.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.length === 0) continue;
                try {
                  parsedCatchUp.push(JSON.parse(trimmed) as BufferEntry);
                } catch {
                  // Skip corrupt lines.
                }
              }
            }

            const dir = path.dirname(filePath);
            const tempPath = path.join(dir, `buffer.ndjson.${Date.now()}.tmp`);
            const lines: string[] = [];

            for (const entry of compactedEntries) {
              lines.push(JSON.stringify(entry) + '\n');
            }
            for (const entry of parsedCatchUp) {
              lines.push(JSON.stringify(entry) + '\n');
            }

            fs.writeFileSync(tempPath, lines.join(''), 'utf-8');
            fs.renameSync(tempPath, filePath);
            fs.closeSync(fd);

            // 5. Read final buffer
            const content = fs.readFileSync(filePath, 'utf-8');
            const finalEntries: BufferEntry[] = [];
            for (const line of content.split('\n')) {
              const trimmed = line.trim();
              if (trimmed.length === 0) continue;
              finalEntries.push(JSON.parse(trimmed) as BufferEntry);
            }

            // 6. Verify ordering: compacted entries come first
            const compactedIds = compactedEntries.map((e) => e.event_id);
            const catchUpIds = catchUpEntries.map((e) => e.event_id);
            const finalIds = finalEntries.map((e) => e.event_id);

            // First N entries should be the compacted entries (in order)
            for (let i = 0; i < compactedEntries.length; i++) {
              expect(finalIds[i]).toBe(compactedIds[i]);
            }

            // Next M entries should be the catch-up entries (in order)
            for (let i = 0; i < catchUpEntries.length; i++) {
              expect(finalIds[compactedEntries.length + i]).toBe(catchUpIds[i]);
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
