/**
 * Unit test for `detectProjectRoot` — walk body throws unexpectedly.
 *
 * The walk body is wrapped in a defensive try/catch (Requirement 7.4).
 * When anything other than the tightly-scoped per-marker `existsSync`
 * failure throws inside the walk, the function must:
 *
 *   1. Log exactly one `[kiro-learn] walk error` line to stderr
 *      (Requirement 7.5).
 *   2. Fall back to today's pre-spec behaviour — hash the resolved
 *      cwd. The returned shape is `{ projectRoot: resolvedCwd,
 *      projectPath: resolvedCwd, isGlobal: false }` (Requirement 7.4).
 *
 * To inject a fault into the walk body without touching production
 * code, we mock `node:path.dirname` so that it throws. `dirname` is
 * called both in the while-loop condition and at the end of each
 * iteration — either invocation lands in the defensive catch, since
 * neither is inside the per-marker inner try/catch.
 *
 * Validates: Requirements 7.4, 7.5
 */

import type * as nodeFs from 'node:fs';
import type * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { realpathSyncMock, existsSyncMock, dirnameMock } = vi.hoisted(() => ({
  realpathSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  dirnameMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeFs;
  return {
    ...original,
    realpathSync: realpathSyncMock,
    existsSync: existsSyncMock,
  };
});

// Mock `node:path` so we can inject a fault into `dirname`. The other
// exports pass through untouched — `join` and `sep` are used by the
// module under test and must still work.
vi.mock('node:path', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodePath;
  return {
    ...original,
    dirname: dirnameMock,
  };
});

const { detectProjectRoot } = await import('../../src/shim/shared/project-root.js');

describe('detectProjectRoot — walk body throws', () => {
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
    dirnameMock.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('logs exactly one walk-error line and falls back to resolved cwd when dirname throws', () => {
    const home = '/Users/alice';
    const cwd = '/Users/alice/code/myrepo/src';

    // realpathSync: identity for every input. Both cwd and homedir
    // resolve cleanly — the failure must come from inside the walk
    // body itself.
    realpathSyncMock.mockImplementation((p: nodeFs.PathLike) =>
      typeof p === 'string' ? p : p.toString(),
    );

    // Every marker probe returns false so the walk cannot short-circuit
    // via a marker match before `dirname` is called.
    existsSyncMock.mockReturnValue(false);

    // `dirname` always throws. Both the while-loop condition and the
    // end-of-iteration assignment call it; the first to fire lands in
    // the defensive outer catch.
    dirnameMock.mockImplementation(() => {
      throw new Error('injected dirname failure');
    });

    const originalHome = process.env['HOME'];
    process.env['HOME'] = home;

    try {
      const result = detectProjectRoot(cwd);

      // Fallback: hash the resolved cwd (today's pre-spec behaviour).
      expect(result).toEqual({
        projectRoot: cwd,
        projectPath: cwd,
        isGlobal: false,
      });

      // Exactly one stderr line, and it's the walk-error line.
      const combined = stderrChunks.join('');
      const lines = combined.split('\n').filter((l) => l.length > 0);
      expect(lines).toEqual(['[kiro-learn] walk error']);
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    }
  });
});
