/**
 * Unit tests for the insert-path binding of `source.project_path` into
 * the denormalised `events.project_path` column.
 *
 * Covers task 6.4 in the project-path-capture spec:
 *
 * - `putEvent` with `source.project_path` present binds the value into
 *   the new `project_path` column AND preserves it in `source_json`.
 * - `putEvent` with `source.project_path` absent leaves the column
 *   NULL AND emits a `source_json` object with no `project_path` key.
 *
 * The assertions probe the raw SQLite rows directly (via a second
 * `better-sqlite3` handle on the same on-disk file) rather than going
 * through `getEventById`. The read path intentionally does *not* read
 * the new column — it reconstitutes `source.project_path` from
 * `source_json` — so a test that round-trips via `getEventById` would
 * be blind to a regression where the write path stopped binding the
 * column. Raw SELECTs are the only way to see the denormalised
 * projection directly.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { StorageBackend } from '../../src/types/index.js';

import { makeValidEvent } from '../helpers/fixtures.js';

/**
 * Shape of the raw row returned by the test's SELECT. Matches the two
 * columns we probe — the denormalised `project_path` column and the
 * serialised `source_json` — nothing more.
 */
interface RawEventRow {
  project_path: string | null;
  source_json: string;
}

let tmpRoot: string;
let dbPath: string;
let storage: StorageBackend;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-insert-bind-'));
  dbPath = join(tmpRoot, 'kiro-learn.db');
  storage = openSqliteStorage({ dbPath });
});

afterEach(async () => {
  try {
    await storage.close();
  } catch {
    // swallow; cleanup must not mask the real test failure
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Read the `project_path` and `source_json` columns for a single event
 * via a sibling readonly `better-sqlite3` handle. Going through a second
 * handle (instead of the backend under test) keeps the probe honest:
 * the backend's read path does not read the new column, so the only way
 * to observe it is from outside the backend.
 */
function readRawRow(eventId: string): RawEventRow | undefined {
  const probe = new Database(dbPath, { readonly: true });
  try {
    return probe
      .prepare<[string], RawEventRow>(
        'SELECT project_path, source_json FROM events WHERE event_id = ?',
      )
      .get(eventId);
  } finally {
    probe.close();
  }
}

describe('SQLite insert — project_path column binding (task 6.4)', () => {
  /**
   * Task 6.4 test 1 — `source.project_path` present.
   *
   * The backend must bind the value into both persistence paths: the
   * dedicated `project_path` column (for future indexed aggregation
   * queries, Requirement 9.1/9.2) and the `source_json` blob (the
   * authoritative source of truth for round-tripping, Requirement 9.4).
   *
   * Validates: Requirements 9.1, 9.2, 9.4.
   */
  it('binds source.project_path into both the column and source_json', async () => {
    const projectPath = '/Users/alice/code/proj';
    const event = makeValidEvent({
      event_id: '01JF8ZS4Y00000000000000040',
      source: {
        surface: 'kiro-cli',
        version: '0.1.0',
        client_id: 'client-1',
        project_path: projectPath,
      },
    });

    await storage.putEvent(event);

    const row = readRawRow(event.event_id);
    expect(row).toBeDefined();
    expect(row!.project_path).toBe(projectPath);

    const parsedSource = JSON.parse(row!.source_json) as { project_path?: string };
    expect(parsedSource.project_path).toBe(projectPath);
  });

  /**
   * Task 6.4 test 2 — `source.project_path` absent.
   *
   * Backward compatibility with pre-spec shims (and with older events
   * replayed through the new backend) requires that an absent
   * `project_path` produces a NULL in the column and, crucially, does
   * not materialise the key in `source_json`. Under
   * `exactOptionalPropertyTypes`, the wire type treats absence and
   * `undefined` as distinct; the stored `source_json` must reflect the
   * same distinction so the read path in turn reconstitutes an event
   * whose `source` has no `project_path` key at all (Requirement 9.3,
   * 10.2, 11.3).
   *
   * The `source` literal here deliberately omits the `project_path` key
   * — it is not set to `undefined`. `JSON.stringify` would elide
   * `undefined` values anyway, but constructing the key-absent shape
   * directly mirrors what the schema actually validates and what the
   * backward-compat path exercises.
   *
   * Validates: Requirements 9.3, 9.4.
   */
  it('writes NULL and omits project_path from source_json when absent', async () => {
    const event = makeValidEvent({
      event_id: '01JF8ZS4Y00000000000000041',
      // Explicitly construct a source object with no project_path key at
      // all — not `project_path: undefined`.
      source: {
        surface: 'kiro-cli',
        version: '0.1.0',
        client_id: 'client-1',
      },
    });

    await storage.putEvent(event);

    const row = readRawRow(event.event_id);
    expect(row).toBeDefined();
    expect(row!.project_path).toBeNull();

    const parsedSource = JSON.parse(row!.source_json) as Record<string, unknown>;
    expect('project_path' in parsedSource).toBe(false);
  });
});
