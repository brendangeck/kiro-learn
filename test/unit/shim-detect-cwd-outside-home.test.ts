/**
 * Unit test for `detectProjectRoot` — cwd not under the Walk_Ceiling.
 *
 * Requirement 2.5: when the resolved cwd is not under the resolved
 * `$HOME` (e.g. `/tmp`, `/private/var`, or any sibling path), the
 * shim must skip the walk entirely and treat the event as a
 * Global_Event — returning the global sentinel:
 *
 *   { projectRoot: ceiling, projectPath: ceiling, isGlobal: true }
 *
 * The shim never fails: every event must still produce a valid
 * namespace. "Skip the walk entirely" is observable — `existsSync`
 * must not be called for any marker probe.
 *
 * Validates: Requirement 2.5
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

describe('detectProjectRoot — resolvedCwd not under ceiling', () => {
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

  it('returns the global sentinel for cwd outside $HOME and does not enter the walk', () => {
    const home = '/Users/alice';
    const cwd = '/tmp/scratch';

    // realpathSync: identity for every input. Both paths resolve
    // cleanly; the cwd just happens to live outside the ceiling.
    realpathSyncMock.mockImplementation((p: nodeFs.PathLike) =>
      typeof p === 'string' ? p : p.toString(),
    );

    // If the walk is entered by mistake, every probe returns false so
    // we would fall through to the "walk completed, no marker" branch
    // — which is also the global sentinel. The call-count assertion
    // below is what distinguishes the two branches.
    existsSyncMock.mockReturnValue(false);

    const originalHome = process.env['HOME'];
    process.env['HOME'] = home;

    try {
      const result = detectProjectRoot(cwd);

      // Global sentinel: ceiling used as both projectRoot and
      // projectPath, isGlobal true.
      expect(result).toEqual({
        projectRoot: home,
        projectPath: home,
        isGlobal: true,
      });

      // Walk was skipped — no marker probes were issued.
      expect(existsSyncMock).not.toHaveBeenCalled();

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
