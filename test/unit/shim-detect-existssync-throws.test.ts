/**
 * Unit test for `detectProjectRoot` — per-marker `existsSync` throws.
 *
 * When `existsSync` throws at a directory during the walk (e.g.
 * permission denied on an ancestor), `detectProjectRoot` must:
 *
 *   1. Treat every marker at that directory as absent and continue
 *      walking upward silently (Requirement 7.3).
 *   2. NOT write anything to stderr. Per-directory marker-check
 *      failures are expected during normal walks and logging them
 *      would be noise (Requirement 7.3, 7.5).
 *
 * The scenario sets up a project marker (`.git`) at a grandparent
 * directory and arranges for `existsSync` to throw at the immediate
 * parent directory. A correct implementation walks past the throwing
 * parent without logging and finds the marker one level up.
 *
 * Validates: Requirements 7.3, 7.5
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

describe('detectProjectRoot — existsSync throws mid-walk', () => {
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

  it('silently continues past a throwing directory and finds a marker higher up', () => {
    const home = '/Users/alice';
    const grandparent = '/Users/alice/code/myrepo';
    const throwingDir = '/Users/alice/code/myrepo/src';
    const cwd = '/Users/alice/code/myrepo/src/components';

    // realpathSync: identity for every input.
    realpathSyncMock.mockImplementation((p: nodeFs.PathLike) =>
      typeof p === 'string' ? p : p.toString(),
    );

    // Place `.git` at the grandparent. Throw on every marker probe at
    // `throwingDir` to simulate permission denied. Every other probe
    // returns false.
    existsSyncMock.mockImplementation((p: nodeFs.PathLike) => {
      const s = typeof p === 'string' ? p : p.toString();
      if (s.startsWith(`${throwingDir}/`)) {
        throw new Error('EACCES: permission denied');
      }
      return s === `${grandparent}/.git`;
    });

    const originalHome = process.env['HOME'];
    process.env['HOME'] = home;

    try {
      const result = detectProjectRoot(cwd);

      // Walk found the marker at the grandparent despite `throwingDir`
      // throwing on every probe.
      expect(result).toEqual({
        projectRoot: grandparent,
        projectPath: grandparent,
        isGlobal: false,
      });

      // Zero stderr output — Requirement 7.3 is explicit that
      // per-marker-check failures are silent.
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
