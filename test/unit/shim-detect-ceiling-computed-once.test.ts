/**
 * Unit test for `detectProjectRoot` — ceiling is computed exactly once.
 *
 * Requirement 2.1: the shim must compute the Walk_Ceiling once at walk
 * start as `realpathSync(homedir())`. Recomputing the ceiling at each
 * iteration of the upward walk would be wasteful and, more importantly,
 * would mean a transient filesystem change during the walk could shift
 * the ceiling mid-flight — a correctness hazard.
 *
 * This test mocks `realpathSync` and asserts:
 *
 *   1. `realpathSync` is called at most once with the `homedir()`
 *      value per `detectProjectRoot` invocation (Requirement 2.1).
 *   2. The only other `realpathSync` call is the cwd resolution in
 *      Phase 1b — never during the walk itself.
 *
 * To ensure the walk actually runs (and therefore has the chance to
 * wrongly recompute the ceiling if buggy), the scenario places a cwd
 * several directories deep under the ceiling with no marker until
 * very close to the ceiling, forcing multiple walk iterations.
 *
 * Validates: Requirement 2.1
 */

import type * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { realpathSyncMock, existsSyncMock } = vi.hoisted(() => ({
  realpathSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeFs;
  return {
    ...original,
    realpathSync: realpathSyncMock,
    existsSync: existsSyncMock,
  };
});

const { detectProjectRoot } = await import('../../src/shim/shared/project-root.js');

describe('detectProjectRoot — ceiling computed once (Requirement 2.1)', () => {
  let stderrChunks: string[];
  let stderrSpy: { mockRestore: () => void };

  beforeEach(() => {
    stderrChunks = [];
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        stderrChunks.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
        );
        return true;
      });
    realpathSyncMock.mockReset();
    existsSyncMock.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('calls realpathSync(homedir()) at most once per invocation', () => {
    const home = '/Users/alice';
    // Deep cwd so the walk must iterate several times.
    const cwd = '/Users/alice/code/org/team/service/module/submodule/leaf';

    // Identity realpath — nothing is a symlink in this scenario.
    realpathSyncMock.mockImplementation((p: nodeFs.PathLike) =>
      typeof p === 'string' ? p : p.toString(),
    );

    // No markers anywhere — the walk runs to completion without
    // terminating early. This maximises the walk's opportunity to
    // (incorrectly) recompute the ceiling. `existsSync` will be
    // called many times, but `realpathSync` should still be called
    // exactly twice: once for homedir, once for cwd.
    existsSyncMock.mockReturnValue(false);

    const originalHome = process.env['HOME'];
    process.env['HOME'] = home;

    try {
      // Sanity: the test harness must line up with the mocked $HOME so
      // that the homedir() value passed to realpathSync is predictable.
      expect(homedir()).toBe(home);

      detectProjectRoot(cwd);

      // Calls made with the homedir() value as argument. Collect them
      // all and assert we saw exactly one.
      const homedirCalls = realpathSyncMock.mock.calls.filter(
        ([p]) => (typeof p === 'string' ? p : (p as { toString(): string }).toString()) === home,
      );
      expect(homedirCalls).toHaveLength(1);

      // The total call count is exactly two: homedir + cwd. A higher
      // number would indicate the ceiling is being recomputed during
      // the walk, which is the regression this test guards against.
      expect(realpathSyncMock).toHaveBeenCalledTimes(2);

      // The walk really ran — existsSync was invoked many times (at
      // least one marker probe per ancestor directory). This proves
      // the ceiling-once guarantee holds even when the walk is long.
      expect(existsSyncMock.mock.calls.length).toBeGreaterThan(0);

      // Normal code path — no warnings expected.
      expect(stderrChunks.join('')).toBe('');
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    }
  });
});
