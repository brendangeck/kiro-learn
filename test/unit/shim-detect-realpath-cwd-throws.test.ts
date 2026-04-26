/**
 * Unit test for `detectProjectRoot` — cwd `realpathSync` throws.
 *
 * When `realpathSync(cwd)` throws (e.g. cwd deleted between process
 * start and the walk, or points at an unreadable symlink), the
 * function must:
 *
 *   1. Log exactly one `[kiro-learn] cwd realpath failed` line to
 *      stderr (Requirement 7.5).
 *   2. Return `{ projectRoot: cwd, projectPath: cwd, isGlobal: false }`
 *      with the raw (unresolved) cwd as both hash input and emitted
 *      wire value (Requirement 7.1).
 *
 * The `homedir()` call is allowed to succeed here — the point of this
 * test is exclusively the cwd-realpath fallback. `realpathSync(cwd)`
 * happens *after* `realpathSync(homedir())` in Phase 1, so the stderr
 * assertion must tolerate no `homedir/realpath` warning appearing.
 *
 * Validates: Requirements 7.1, 7.5
 */

import type * as nodeFs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mock reference — shared between the vi.mock factory below and
// the per-test configuration. vi.hoisted runs before the factory, which
// runs before the dynamic import of the module under test.
const { realpathSyncMock, existsSyncMock } = vi.hoisted(() => ({
  realpathSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

// Mock `node:fs` but preserve every other fs export. `detectProjectRoot`
// imports `realpathSync` and `existsSync`; nothing else in this module
// needs stubbing.
vi.mock('node:fs', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeFs;
  return {
    ...original,
    realpathSync: realpathSyncMock,
    existsSync: existsSyncMock,
  };
});

// Import after mocks so vitest intercepts the module.
const { detectProjectRoot } = await import('../../src/shim/shared/project-root.js');

describe('detectProjectRoot — cwd realpathSync throws', () => {
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

  it('returns raw cwd and logs exactly one cwd-failure line when realpathSync(cwd) throws', () => {
    const cwd = '/some/unresolvable/cwd';
    const home = '/Users/alice';

    // homedir resolves cleanly, cwd realpath throws. Any unexpected
    // third call is left to the default no-op which would surface as
    // `undefined` and make downstream logic fail loudly.
    realpathSyncMock.mockImplementation((p: nodeFs.PathLike) => {
      const s = typeof p === 'string' ? p : p.toString();
      if (s === cwd) {
        throw new Error('ENOENT: no such file or directory');
      }
      // Any other path (e.g. the homedir) passes through.
      return s;
    });

    // Simulate a HOME env so `homedir()` returns a predictable value.
    // `os.homedir()` reads `$HOME` on POSIX; falling back to the real
    // value is fine — we only care that the cwd branch throws.
    const originalHome = process.env['HOME'];
    process.env['HOME'] = home;

    try {
      const result = detectProjectRoot(cwd);

      expect(result).toEqual({
        projectRoot: cwd,
        projectPath: cwd,
        isGlobal: false,
      });

      // Exactly one stderr line, and it's the cwd-failure line. Joining
      // chunks guards against write() being invoked in pieces.
      const combined = stderrChunks.join('');
      const lines = combined.split('\n').filter((l) => l.length > 0);
      expect(lines).toEqual(['[kiro-learn] cwd realpath failed']);
    } finally {
      if (originalHome === undefined) {
        delete process.env['HOME'];
      } else {
        process.env['HOME'] = originalHome;
      }
    }
  });
});
