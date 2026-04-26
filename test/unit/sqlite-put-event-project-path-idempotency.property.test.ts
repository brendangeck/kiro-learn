/**
 * Property-based test for SQLite `putEvent` idempotency with respect to
 * the denormalised `project_path` column.
 *
 * Covers Task 6.6 in the project-path-capture spec, which anchors
 * Correctness Property 9: `putEvent` uses `INSERT OR IGNORE`, so a retry
 * against an existing `event_id` is a no-op on every column — including
 * the new `project_path` column added by migration 0003. First-write
 * wins; the second insert's `source.project_path` must never overwrite
 * the stored value.
 *
 * Each iteration:
 *
 *   1. Generates a base event `e1` via `arbitraryEvent()`.
 *   2. Derives `e2` by shallow-copying `e1` and overwriting
 *      `source.project_path` with a distinct string.
 *   3. Puts `e1`, then puts `e2`, against the same SQLite backend.
 *   4. Reads the row back via `getEventById(e1.event_id)`.
 *   5. Asserts the retrieved event's `source.project_path` equals
 *      `e1.source.project_path` — the first write — and is not the
 *      value `e2` tried to introduce.
 *
 * `numRuns` is capped at 25 to keep wall-clock reasonable: every
 * iteration opens a fresh temp directory and SQLite file so no
 * cross-iteration state can mask a regression.
 *
 * @see .kiro/specs/project-path-capture/design.md § Property 9
 * @see .kiro/specs/project-path-capture/requirements.md § Requirement 9.6
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { KiroMemEvent, StorageBackend } from '../../src/types/index.js';

import { arbitraryEvent, projectPathArb } from '../helpers/arbitrary.js';

interface Scratch {
  tmpRoot: string;
  dbPath: string;
  storage: StorageBackend;
}

function openScratch(): Scratch {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-pbt-pp-idem-'));
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

describe('Feature: project-path-capture, Property 9: putEvent idempotency preserves stored project_path', () => {
  it('first-write wins: a second putEvent with a different project_path does not overwrite the stored value', async () => {
    /**
     * **Validates: Requirement 9.6**
     *
     * For any two events `e1` and `e2` sharing an `event_id` but
     * differing in `source.project_path`:
     *
     *   (1) `putEvent(e1)` seeds the row with `project_path = P1`.
     *   (2) `putEvent(e2)` is absorbed by `INSERT OR IGNORE`; no
     *       column — including `project_path` — is rewritten.
     *   (3) `getEventById(e1.event_id)` returns an event whose
     *       `source.project_path` equals `e1.source.project_path`.
     *
     * The generator pairs a generated event with a fresh
     * `projectPathArb()` draw, then filters out runs where the draw
     * happens to equal the original `e1.source.project_path` so the two
     * events genuinely differ on this field.
     */
    await fc.assert(
      fc.asyncProperty(
        arbitraryEvent(),
        projectPathArb(),
        async (e1Raw: KiroMemEvent, secondProjectPath: string) => {
          // Guarantee `e1.source.project_path` is defined so we have a
          // concrete "first" value to compare against. The generator
          // sometimes omits the field; when it does, we inject one drawn
          // from the same arbitrary so the invariant under test — that
          // the stored column is preserved — is meaningful on every run.
          const firstProjectPath =
            e1Raw.source.project_path ?? `${secondProjectPath}-first`;
          const e1: KiroMemEvent = {
            ...e1Raw,
            source: { ...e1Raw.source, project_path: firstProjectPath },
          };

          // The two events must differ on `source.project_path`;
          // otherwise the property is vacuous (same value on both writes
          // cannot distinguish first-write-wins from last-write-wins).
          fc.pre(firstProjectPath !== secondProjectPath);

          const e2: KiroMemEvent = {
            ...e1,
            source: { ...e1.source, project_path: secondProjectPath },
          };

          const s = openScratch();
          try {
            await s.storage.putEvent(e1);
            await s.storage.putEvent(e2);

            const retrieved = await s.storage.getEventById(e1.event_id);
            expect(retrieved).not.toBeNull();
            expect(retrieved!.source.project_path).toBe(firstProjectPath);
            // And explicitly not the second value.
            expect(retrieved!.source.project_path).not.toBe(secondProjectPath);
          } finally {
            await cleanupScratch(s);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
