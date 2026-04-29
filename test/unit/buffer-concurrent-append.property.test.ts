/**
 * Property-based test for BufferStore concurrent append safety.
 *
 * Feature: workspace-buffer-pipeline, Property 3: Concurrent append safety
 *
 * For any set of valid BufferEntry objects appended in parallel to the same
 * project buffer, the resulting buffer file is valid NDJSON where every
 * appended entry appears exactly once in the snapshot.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Property 3
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 1.3, 1.5
 */

import fc from 'fast-check';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createBufferStore } from '../../src/collector/buffer/store.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';
import { toBufferEntry } from '../../src/collector/buffer/types.js';
import { arbitraryCleanEvent } from '../helpers/arbitrary.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('Concurrent append safety (Property 3)', () => {
  it('parallel appends to the same buffer produce valid NDJSON where every entry appears exactly once', async () => {
    /**
     * **Validates: Requirements 1.3, 1.5**
     *
     * Multiple parallel appends to the same project buffer file produce
     * a valid NDJSON file where every appended entry appears exactly once
     * in the snapshot.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbitraryCleanEvent(), { minLength: 2, maxLength: 10 }),
        async (events) => {
          tmpDir = mkdtempSync(join(tmpdir(), 'buffer-concurrent-'));
          const store = createBufferStore(tmpDir);
          const projectId = 'test-project';

          const entries: BufferEntry[] = events.map(toBufferEntry);

          // Append all entries in parallel
          const results = await Promise.all(
            entries.map((e) => store.append(projectId, e)),
          );

          // Every append should return a positive byte count
          for (const bytes of results) {
            expect(bytes).toBeGreaterThan(0);
          }

          // Read snapshot
          const snapshot = await store.snapshot(projectId);

          // Snapshot should contain exactly the same number of entries
          expect(snapshot).toHaveLength(entries.length);

          // Sort both arrays by event_id for order-independent comparison
          const sortedEntries = [...entries].sort((a, b) =>
            a.event_id.localeCompare(b.event_id),
          );
          const sortedSnapshot = [...snapshot].sort((a, b) =>
            a.event_id.localeCompare(b.event_id),
          );

          // Every entry appears exactly once — deep equality
          expect(sortedSnapshot).toEqual(sortedEntries);

          // Clean up for next iteration
          rmSync(tmpDir, { recursive: true, force: true });
        },
      ),
      { numRuns: 50 },
    );
  });
});
