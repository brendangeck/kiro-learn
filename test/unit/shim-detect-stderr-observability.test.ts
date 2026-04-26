/**
 * Consolidated stderr observability test for `detectProjectRoot`.
 *
 * Requirement N6 (restated by Requirement 7.5) requires that warning
 * messages emitted by `detectProjectRoot` never include the path value
 * as a substring. Project paths are not secrets, but the existing shim
 * observability convention avoids leaking them through stderr, and a
 * future regression that interpolates the path into the warning would
 * violate both the stated contract and reviewer expectations.
 *
 * This test triggers each of the three fallback branches that produce
 * a warning (Requirements 7.1, 7.2, 7.4 — not 7.3, which is silent)
 * and asserts for each that none of the path values involved appear
 * anywhere in the captured stderr output.
 *
 * Validates: Requirements N6, 7.5
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

vi.mock('node:path', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodePath;
  return {
    ...original,
    dirname: dirnameMock,
  };
});

const { detectProjectRoot } = await import('../../src/shim/shared/project-root.js');

/**
 * Distinctive path fragments used across every scenario. If any of
 * them appears in the captured stderr output, the observability
 * invariant has been violated.
 */
const SENTINEL_HOME = '/Users/alice-sentinel-homedir-9c1f';
const SENTINEL_CWD = '/Users/alice-sentinel-homedir-9c1f/workspace/sentinel-cwd-4aed';

describe('detectProjectRoot — stderr observability (N6)', () => {
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
    // Default: `dirname` passes through. Individual tests that want
    // `dirname` to throw override this mock.
    dirnameMock.mockImplementation((p: string) => {
      const idx = p.lastIndexOf('/');
      if (idx <= 0) return '/';
      return p.slice(0, idx);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  function assertNoPathInOutput(): void {
    const combined = stderrChunks.join('');
    // Every distinct path fragment used in the scenarios below must be
    // absent from the captured stderr output. We check both the full
    // path and the nontrivial basename so a partial interpolation
    // ('...at alice-sentinel-homedir-9c1f...') is caught too.
    const forbiddenFragments = [
      SENTINEL_HOME,
      SENTINEL_CWD,
      'alice-sentinel-homedir-9c1f',
      'sentinel-cwd-4aed',
    ];
    for (const fragment of forbiddenFragments) {
      expect(
        combined,
        `stderr leaked path fragment "${fragment}"`,
      ).not.toContain(fragment);
    }
  }

  it('cwd-realpath-failed warning does not include the path', () => {
    // Requirement 7.1 branch. homedir resolves cleanly; cwd throws.
    realpathSyncMock.mockImplementation((p: nodeFs.PathLike) => {
      const s = typeof p === 'string' ? p : p.toString();
      if (s === SENTINEL_CWD) {
        throw new Error('ENOENT');
      }
      return s;
    });

    const originalHome = process.env['HOME'];
    process.env['HOME'] = SENTINEL_HOME;

    try {
      detectProjectRoot(SENTINEL_CWD);

      expect(stderrChunks.join('')).toContain('[kiro-learn] cwd realpath failed');
      assertNoPathInOutput();
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    }
  });

  it('homedir-realpath-failed warning does not include the path', () => {
    // Requirement 7.2 branch. homedir throws; cwd resolves cleanly.
    // To keep the scenario self-contained the walk finds a marker
    // quickly (at the cwd itself) and exits before dirname is called.
    realpathSyncMock.mockImplementation((p: nodeFs.PathLike) => {
      const s = typeof p === 'string' ? p : p.toString();
      if (s === SENTINEL_HOME) {
        throw new Error('EACCES');
      }
      return s;
    });
    existsSyncMock.mockImplementation((p: nodeFs.PathLike) => {
      const s = typeof p === 'string' ? p : p.toString();
      // Marker at cwd so the walk terminates on its first iteration.
      return s === `${SENTINEL_CWD}/.git`;
    });

    const originalHome = process.env['HOME'];
    process.env['HOME'] = SENTINEL_HOME;

    try {
      detectProjectRoot(SENTINEL_CWD);

      expect(stderrChunks.join('')).toContain(
        '[kiro-learn] homedir/realpath failed',
      );
      assertNoPathInOutput();
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    }
  });

  it('walk-error warning does not include the path', () => {
    // Requirement 7.4 branch. Both realpathSync calls succeed; the
    // walk body throws via a dirname fault.
    realpathSyncMock.mockImplementation((p: nodeFs.PathLike) =>
      typeof p === 'string' ? p : p.toString(),
    );
    existsSyncMock.mockReturnValue(false);
    dirnameMock.mockImplementation(() => {
      throw new Error('injected dirname failure');
    });

    const originalHome = process.env['HOME'];
    process.env['HOME'] = SENTINEL_HOME;

    try {
      detectProjectRoot(SENTINEL_CWD);

      expect(stderrChunks.join('')).toContain('[kiro-learn] walk error');
      assertNoPathInOutput();
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    }
  });
});
