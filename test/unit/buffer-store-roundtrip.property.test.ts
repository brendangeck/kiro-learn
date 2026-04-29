/**
 * Property-based test for BufferStore append/snapshot round-trip.
 *
 * Feature: workspace-buffer-pipeline, Property 1: Append/snapshot round-trip
 *
 * For any sequence of valid BufferEntry objects appended to a project buffer,
 * reading a snapshot yields the same set of entries (compared order-independently
 * by `event_id` and field equality).
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Property 1
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 1.1, 1.4, 1.5, 3.1
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

describe('Append/snapshot round-trip (Property 1)', () => {
  it('appending entries and reading a snapshot yields the same set, order-independent by event_id', async () => {
    /**
     * **Validates: Requirements 1.1, 1.4, 1.5, 3.1**
     *
     * For any sequence of valid BufferEntry objects appended to a project
     * buffer, reading a snapshot yields the same set (order-independent
     * by event_id).
     */
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbitraryCleanEvent(), { minLength: 1, maxLength: 20 }),
        async (events) => {
          tmpDir = mkdtempSync(join(tmpdir(), 'buffer-test-'));
          const store = createBufferStore(tmpDir);
          const projectId = 'test-project';

          const entries: BufferEntry[] = events.map(toBufferEntry);

          // Append all entries
          for (const entry of entries) {
            const bytes = await store.append(projectId, entry);
            expect(bytes).toBeGreaterThan(0);
          }

          // Read snapshot
          const snapshot = await store.snapshot(projectId);

          // Sort both arrays by event_id for order-independent comparison
          const sortedEntries = [...entries].sort((a, b) =>
            a.event_id.localeCompare(b.event_id),
          );
          const sortedSnapshot = [...snapshot].sort((a, b) =>
            a.event_id.localeCompare(b.event_id),
          );

          expect(sortedSnapshot).toEqual(sortedEntries);

          // Clean up for next iteration
          rmSync(tmpDir, { recursive: true, force: true });
        },
      ),
      { numRuns: 50 },
    );
  });
});
