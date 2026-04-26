/**
 * Property-based test for SQLite round-trip integrity with `project_path`.
 *
 * Covers Task 6.5 in the project-path-capture spec, which anchors
 * Correctness Property 8: the denormalised `project_path` column added by
 * migration 0003 must not affect the round-trip equality of events. The
 * read path reconstitutes `source` from `source_json`, never from the new
 * column, so a `putEvent` / `getEventById` cycle must be lossless whether
 * or not `source.project_path` is present.
 *
 * The extended `arbitraryEvent()` (Task 2.2) emits events with and
 * without `source.project_path`, so a single property covers both shapes.
 * Each iteration:
 *
 *   1. Puts the generated event via the SQLite backend.
 *   2. Reads it back via `getEventById`.
 *   3. Asserts the retrieved event deep-equals the original.
 *   4. Asserts the `project_path` key is present iff it was present on
 *      the input — under `exactOptionalPropertyTypes`, absence means the
 *      key is not on the object, not `project_path: undefined`.
 *
 * `numRuns` is capped at 25 to keep wall-clock reasonable: every
 * iteration opens a fresh temp directory and SQLite file so no
 * cross-iteration state can mask a regression.
 *
 * @see .kiro/specs/project-path-capture/design.md § Property 8
 * @see .kiro/specs/project-path-capture/requirements.md § Requirements 9.5, 10.1, 10.2, 10.3, 11.3, 12.4
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { KiroMemEvent, StorageBackend } from '../../src/types/index.js';

import { arbitraryEvent } from '../helpers/arbitrary.js';

interface Scratch {
  tmpRoot: string;
  dbPath: string;
  storage: StorageBackend;
}

function openScratch(): Scratch {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-pbt-pp-'));
  const dbPath = join(tmpRoot, 'kiro-learn.db');
  const storage = openSqliteStorage({ dbPath });
  return { tmpRoot, dbPath, storage };
}

async function cleanupScratch(s: Scratch): Promise<void> {
  try {
    await s.storage.close();
  } catch {
    // ignore: cleanup failures must not mask the property's real failure.
  }
  rmSync(s.tmpRoot, { recursive: true, force: true });
}

describe('Feature: project-path-capture, Property 8: Round-trip integrity with project_path', () => {
  it('putEvent → getEventById deep-equals the original and preserves project_path presence/absence', async () => {
    /**
     * **Validates: Requirements 9.5, 10.1, 10.2, 10.3, 11.3, 12.4**
     *
     * For any event `e` produced by `arbitraryEvent()` (which sometimes
     * populates `source.project_path` and sometimes omits it):
     *
     *   (1) `getEventById(e.event_id)` returns an event deep-equal to `e`.
     *   (2) When `e.source.project_path` is defined, the retrieved
     *       event's `source.project_path` equals it byte-for-byte.
     *   (3) When `e.source.project_path` is absent, the retrieved
     *       event's `source` has no `project_path` key at all — the
     *       `exactOptionalPropertyTypes` discipline means `in` must
     *       return `false`, not just that the value is `undefined`.
     */
    await fc.assert(
      fc.asyncProperty(arbitraryEvent(), async (event: KiroMemEvent) => {
        const s = openScratch();
        try {
          await s.storage.putEvent(event);
          const retrieved = await s.storage.getEventById(event.event_id);

          expect(retrieved).not.toBeNull();
          // (1) Full deep-equal round-trip.
          expect(retrieved).toEqual(event);

          // (2)/(3) project_path presence must match byte-for-byte.
          const inputProjectPath = event.source.project_path;
          const retrievedSource = retrieved!.source;
          if (inputProjectPath !== undefined) {
            expect(retrievedSource.project_path).toBe(inputProjectPath);
          } else {
            expect('project_path' in retrievedSource).toBe(false);
          }
        } finally {
          await cleanupScratch(s);
        }
      }),
      { numRuns: 25 },
    );
  });
});
