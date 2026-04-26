/**
 * Unit test for `detectProjectRoot` — symlink resolution.
 *
 * Requirement 1.2: `detectProjectRoot` must resolve the input cwd via
 * `realpathSync` before starting the upward marker walk, so a
 * symlinked working directory is normalised to its real path. Walking
 * from the real path finds the marker-bearing ancestor of the real
 * directory, not the ancestor of the symlinked path.
 *
 * The test exercises this against a real filesystem (no `node:fs`
 * mocks): we plant a `.git` marker directory at a real project root,
 * create a subdirectory inside it, and make a symlink from an
 * unrelated location to that subdirectory. Invoking
 * `detectProjectRoot` on the symlink path must return the real
 * project directory — not the symlink's parent, which has no marker
 * and would resolve to the global sentinel.
 *
 * `node:os` `homedir()` is mocked to point at the enclosing temp
 * directory so the Walk_Ceiling sits above the project (without this,
 * the walk would reach `$HOME` before finding our temp tree on
 * typical developer machines and the test would be meaningless).
 *
 * On macOS `os.tmpdir()` lives behind the `/tmp → /private/tmp`
 * symlink. We resolve the temp base via `realpathSync` up front so
 * every expected value is compared against the canonical real path.
 *
 * Validates: Requirement 1.2
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Resolve symlinks on the temp base (macOS `/tmp` → `/private/tmp`).
// Every expected path downstream is derived from this resolved value
// so we do not trip over the platform-level symlink ourselves.
const tmpBase: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-symlink-')),
);

// Mock `homedir()` to point at the temp base. This makes the
// Walk_Ceiling (`realpath(homedir())`) the parent of our project
// tree, so the walk has a well-defined terminator above the project
// root but below any real filesystem root.
vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpBase,
  };
});

// Import after the mock so vitest intercepts `homedir()` calls inside
// `detectProjectRoot`.
const { detectProjectRoot } = await import('../../src/shim/shared/project-root.js');

describe('detectProjectRoot — symlink resolution', () => {
  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('walks from the real project directory, not the symlinked ancestor', () => {
    // Real project layout:
    //   $tmpBase/workspaces/real-project/        ← marker lives here
    //   $tmpBase/workspaces/real-project/.git/   ← the marker
    //   $tmpBase/workspaces/real-project/src/    ← walk starts here
    const workspacesDir = join(tmpBase, 'workspaces');
    const realProject = join(workspacesDir, 'real-project');
    const realSubdir = join(realProject, 'src');
    mkdirSync(realSubdir, { recursive: true });
    mkdirSync(join(realProject, '.git'));

    // Symlinked entry point under an unrelated parent. If
    // `detectProjectRoot` walked from this path without resolving the
    // symlink first, the walk would ascend through `$tmpBase/links/`
    // (no markers) and fall off the ceiling into the global sentinel.
    const linksDir = join(tmpBase, 'links');
    mkdirSync(linksDir);
    const symlinkPath = join(linksDir, 'project-src');
    symlinkSync(realSubdir, symlinkPath);

    const result = detectProjectRoot(symlinkPath);

    // Symlink was resolved before the walk; the walk found the .git
    // marker at the real project directory, not at the link's
    // ancestor. `projectPath` always equals `projectRoot` by contract.
    expect(result).toEqual({
      projectRoot: realProject,
      projectPath: realProject,
      isGlobal: false,
    });
  });
});
