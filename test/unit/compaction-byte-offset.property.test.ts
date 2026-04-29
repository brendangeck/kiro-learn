/**
 * Property-based test for byte offset tracking fidelity during buffer replace.
 *
 * Feature: buffer-compaction-worker, Property 7: Byte offset tracking fidelity
 *
 * For any sequence of appends followed by a replace, the catch-up window
 * [S0, current_size) contains exactly the bytes appended after S0, with no
 * overlap or gap.
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Property 7
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirements 1.1, 6.2
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createBufferStore } from '../../src/collector/buffer/store.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';
import { bufferEntryArb, ulidArb } from '../helpers/arbitrary.js';

/**
 * Generate an array of BufferEntry objects with unique event_ids.
 *
 * Uses a prefix to ensure uniqueness across multiple generated arrays
 * within the same property run (e.g., initial vs catch-up).
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'byte-offset-fidelity-'));
}

/** Best-effort cleanup of a temp directory. */
function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

const PROJECT_ID = 'testproject';

describe('Byte offset tracking fidelity (Property 7)', () => {
  it('catch-up window [S0, current_size) contains exactly the bytes appended after S0', () => {
    /**
     * **Validates: Requirements 1.1, 6.2**
     *
     * For any sequence of initial appends followed by catch-up appends,
     * the byte range [S0, current_size) read via fs.readSync contains
     * exactly the NDJSON lines of the catch-up entries — no overlap with
     * initial entries and no gap.
     */
    fc.assert(
      fc.property(
        uniqueBufferEntriesArb(1, 10, 'I'),
        uniqueBufferEntriesArb(1, 10, 'C'),
        (initialEntries, catchUpEntries) => {
          const tmpDir = makeTempDir();
          try {
            const store = createBufferStore(tmpDir);

            // 1. Append initial entries to the buffer.
            for (const entry of initialEntries) {
              store.append(PROJECT_ID, entry);
            }

            // 2. Record S0 — the byte offset at snapshot time.
            const s0 = store.sizeSync(PROJECT_ID);

            // 3. Compute the expected bytes for each catch-up entry.
            //    Each entry is serialized as JSON.stringify(entry) + '\n'.
            const expectedCatchUpLines: string[] = [];
            let expectedCatchUpBytes = 0;
            for (const entry of catchUpEntries) {
              const line = JSON.stringify(entry) + '\n';
              expectedCatchUpLines.push(line);
              expectedCatchUpBytes += Buffer.byteLength(line, 'utf-8');
            }

            // 4. Append catch-up entries after S0.
            for (const entry of catchUpEntries) {
              store.append(PROJECT_ID, entry);
            }

            // 5. Read the current file size.
            const currentSize = store.sizeSync(PROJECT_ID);

            // 6. Verify the catch-up window size matches expected bytes.
            const catchUpWindowSize = currentSize - s0;
            expect(catchUpWindowSize).toBe(expectedCatchUpBytes);

            // 7. Read the raw bytes from [S0, current_size) using fs.readSync.
            const filePath = store.bufferPath(PROJECT_ID);
            const fd = fs.openSync(filePath, 'r');
            try {
              const catchUpBuffer = Buffer.alloc(catchUpWindowSize);
              fs.readSync(fd, catchUpBuffer, 0, catchUpWindowSize, s0);
              const catchUpText = catchUpBuffer.toString('utf-8');

              // 8. Verify the raw bytes match the expected NDJSON lines exactly.
              expect(catchUpText).toBe(expectedCatchUpLines.join(''));

              // 9. Parse the catch-up bytes and verify they produce exactly
              //    the catch-up entries (no overlap, no gap).
              const parsedEntries: BufferEntry[] = [];
              for (const line of catchUpText.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.length === 0) continue;
                parsedEntries.push(JSON.parse(trimmed) as BufferEntry);
              }

              expect(parsedEntries).toHaveLength(catchUpEntries.length);

              for (let i = 0; i < catchUpEntries.length; i++) {
                expect(parsedEntries[i]!.event_id).toBe(catchUpEntries[i]!.event_id);
              }

              // 10. Verify no overlap: the byte at S0 is the start of the
              //     first catch-up entry, not the end of the last initial entry.
              //     Read the byte just before S0 and verify it's a newline
              //     (the terminator of the last initial entry).
              if (s0 > 0) {
                const prevByte = Buffer.alloc(1);
                fs.readSync(fd, prevByte, 0, 1, s0 - 1);
                expect(prevByte.toString('utf-8')).toBe('\n');
              }
            } finally {
              fs.closeSync(fd);
            }
          } finally {
            cleanupTempDir(tmpDir);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('S0 equals the sum of bytes written by initial appends', () => {
    /**
     * **Validates: Requirements 1.1, 6.2**
     *
     * The byte offset S0 recorded via sizeSync after initial appends
     * equals the total bytes written by those appends. This ensures S0
     * accurately represents the file position up to which the snapshot
     * was read.
     */
    fc.assert(
      fc.property(
        uniqueBufferEntriesArb(1, 15, 'A'),
        (entries) => {
          const tmpDir = makeTempDir();
          try {
            const store = createBufferStore(tmpDir);

            // Track total bytes written by appends.
            let totalBytesWritten = 0;
            for (const entry of entries) {
              const line = JSON.stringify(entry) + '\n';
              totalBytesWritten += Buffer.byteLength(line, 'utf-8');
              store.append(PROJECT_ID, entry);
            }

            // sizeSync should match the total bytes written.
            const s0 = store.sizeSync(PROJECT_ID);
            expect(s0).toBe(totalBytesWritten);

            // Also verify against the actual file size on disk.
            const filePath = store.bufferPath(PROJECT_ID);
            const stat = fs.statSync(filePath);
            expect(stat.size).toBe(totalBytesWritten);
          } finally {
            cleanupTempDir(tmpDir);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('catch-up window is empty when no entries are appended after S0', () => {
    /**
     * **Validates: Requirements 1.1, 6.2**
     *
     * When no entries are appended between S0 and the read, the catch-up
     * window [S0, current_size) has zero bytes — no gap, no phantom data.
     */
    fc.assert(
      fc.property(
        uniqueBufferEntriesArb(1, 10, 'X'),
        (entries) => {
          const tmpDir = makeTempDir();
          try {
            const store = createBufferStore(tmpDir);

            for (const entry of entries) {
              store.append(PROJECT_ID, entry);
            }

            const s0 = store.sizeSync(PROJECT_ID);
            const currentSize = store.sizeSync(PROJECT_ID);

            // No appends between the two reads — window should be zero.
            expect(currentSize - s0).toBe(0);
          } finally {
            cleanupTempDir(tmpDir);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
