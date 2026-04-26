/**
 * Unit test for `detectProjectRoot` — homedir `realpathSync` throws.
 *
 * When `realpathSync(homedir())` throws (pathological — `$HOME` should
 * always resolve, but we still guard), the function must:
 *
 *   1. Log exactly one `[kiro-learn] homedir/realpath failed` line to
 *      stderr (Requirement 7.5).
 *   2. Continue the walk with the *unresolved* `homedir()` value as
 *      the Walk_Ceiling (Requirement 7.2).
 *
 * The cwd `realpathSync` call must succeed in this scenario — we want
 * to prove the walk proceeds. We arrange a cwd under the unresolved
 * homedir with a project marker planted at a known depth so the walk
 * has something to find, proving it actually ran.
 *
 * Validates: Requirements 7.2, 7.5
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

describe('detectProjectRoot — homedir realpathSync throws', () => {
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

  it('logs exactly one homedir-failure line and walks with the unresolved ceiling', () => {
    const home = '/Users/alice';
    const projectRoot = '/Users/alice/code/myrepo';
    const cwd = '/Users/alice/code/myrepo/src';

    // realpathSync throws on the homedir input; every other input
    // passes through. Use `homedir()` as the sentinel because that's
    // what Phase 1a passes to realpathSync.
    realpathSyncMock.mockImplementation((p: nodeFs.PathLike) => {
      const s = typeof p === 'string' ? p : p.toString();
      if (s === home) {
        throw new Error('EACCES: permission denied');
      }
      return s;
    });

    // Plant a `.git` marker at the project root. existsSync returns
    // true only for `<projectRoot>/.git`; every other path returns
    // false. That proves the walk ran past cwd and climbed to
    // projectRoot before terminating.
    existsSyncMock.mockImplementation((p: nodeFs.PathLike) => {
      const s = typeof p === 'string' ? p : p.toString();
      return s === `${projectRoot}/.git`;
    });

    const originalHome = process.env['HOME'];
    process.env['HOME'] = home;

    try {
      const result = detectProjectRoot(cwd);

      // Walk found the marker using the unresolved ceiling; returned
      // result reflects the discovered project root.
      expect(result).toEqual({
        projectRoot,
        projectPath: projectRoot,
        isGlobal: false,
      });

      // Exactly one stderr line, and it's the homedir-failure line.
      const combined = stderrChunks.join('');
      const lines = combined.split('\n').filter((l) => l.length > 0);
      expect(lines).toEqual(['[kiro-learn] homedir/realpath failed']);
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    }
  });
});
