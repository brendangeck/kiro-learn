/**
 * Unit test for `detectProjectRoot` — cwd equals the Walk_Ceiling.
 *
 * Requirement 2.4: when the resolved cwd equals the resolved `$HOME`
 * (the Walk_Ceiling), `detectProjectRoot` must skip the marker walk
 * entirely and return the global sentinel:
 *
 *   { projectRoot: ceiling, projectPath: ceiling, isGlobal: true }
 *
 * "Skip the walk entirely" is observable: `existsSync` must never be
 * called for any marker probe. We assert on both the result shape and
 * the absence of `existsSync` invocations to catch a regression that
 * would inadvertently inspect the ceiling directory itself (which
 * would also violate Requirement 2.2).
 *
 * Validates: Requirement 2.4
 */

import type * as nodeFs from 'node:fs';
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

describe('detectProjectRoot — resolvedCwd === ceiling', () => {
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

  it('returns the global sentinel and does not enter the walk', () => {
    const home = '/Users/alice';

    // Both `realpathSync(homedir())` and `realpathSync(cwd)` resolve
    // to the same path — the user is running kiro-cli directly in
    // `$HOME`.
    realpathSyncMock.mockImplementation((p: nodeFs.PathLike) =>
      typeof p === 'string' ? p : p.toString(),
    );

    // `existsSync` should not be called in this scenario. If the walk
    // is entered by mistake this returns `false` so the walk would
    // proceed harmlessly, but the call-count assertion below catches
    // the regression.
    existsSyncMock.mockReturnValue(false);

    const originalHome = process.env['HOME'];
    process.env['HOME'] = home;

    try {
      const result = detectProjectRoot(home);

      // Global sentinel: both projectRoot and projectPath are the
      // ceiling, isGlobal is true.
      expect(result).toEqual({
        projectRoot: home,
        projectPath: home,
        isGlobal: true,
      });

      // Walk was skipped — no marker probes were issued.
      expect(existsSyncMock).not.toHaveBeenCalled();

      // No warnings expected — this is a normal code path, not a
      // fallback branch.
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
