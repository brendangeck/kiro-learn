/**
 * Property-based test for `detectProjectRoot` — the upward walk finds
 * the nearest marker-bearing ancestor.
 *
 * Feature: project-path-capture, Property 1: Walk finds the nearest
 * marker-bearing ancestor
 *
 * For any marker-bearing directory `D` under the mocked `$HOME`
 * ceiling and any `cwd` at or under `D` (with no marker-bearing
 * directory strictly between `cwd` and `D`), the walk MUST return
 * `projectRoot === D` and `isGlobal === false`.
 *
 * **Validates: Requirements 1.3, 1.5, 4.3**
 *
 * ## Strategy
 *
 * `arbitraryFsTreeWithMarker()` in `test/helpers/arbitrary.ts` emits a
 * data-only descriptor `{ home, projectRoot, cwd, marker }`. For each
 * generated descriptor we:
 *
 * 1. Re-point the mocked `homedir()` at the descriptor's `home`.
 * 2. Re-point the mocked `realpathSync` as identity (no symlinks in
 *    the generated tree).
 * 3. Re-point the mocked `existsSync(join(dir, m))` to return `true`
 *    iff `dir === projectRoot && m === descriptor.marker`. Every
 *    other probe — including probes at ancestors between `cwd` and
 *    `projectRoot`, and probes for other markers at `projectRoot` —
 *    returns `false`.
 *
 * With the mocks in place, the only way `detectProjectRoot` can
 * satisfy `projectRoot === D` is by walking from `cwd` upward and
 * stopping at the first directory whose marker probe succeeds — which
 * is `projectRoot` itself by construction.
 *
 * @see .kiro/specs/project-path-capture/design.md § Property 1
 * @see .kiro/specs/project-path-capture/tasks.md § Task 3.7
 */

import type * as nodeFs from 'node:fs';
import type * as nodeOs from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { arbitraryFsTreeWithMarker } from '../helpers/arbitrary.js';

// Hoisted mock references so they exist before the mocked modules are
// imported. Each iteration of the property re-programs these via
// `mockImplementation` — the module-level `vi.mock` call is invoked
// once, and per-iteration behaviour is steered through the hoisted refs.
const { realpathSyncMock, existsSyncMock, homedirMock } = vi.hoisted(() => ({
  realpathSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
  homedirMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeFs;
  return {
    ...original,
    realpathSync: realpathSyncMock,
    existsSync: existsSyncMock,
  };
});

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: homedirMock,
  };
});

// Import after the mocks so vitest intercepts them inside
// `detectProjectRoot`.
const { detectProjectRoot } = await import(
  '../../src/shim/shared/project-root.js'
);

// Feature: project-path-capture, Property 1: Walk finds the nearest
// marker-bearing ancestor
describe('detectProjectRoot — property: walk finds the nearest marker-bearing ancestor (P1)', () => {
  let stderrSpy: { mockRestore: () => void };

  beforeEach(() => {
    // Swallow any stderr writes — none are expected on the happy path
    // this property exercises, but keeping the real stderr quiet makes
    // regressions surface cleanly as assertion failures rather than as
    // log noise on the terminal.
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    realpathSyncMock.mockReset();
    existsSyncMock.mockReset();
    homedirMock.mockReset();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('returns the marker-bearing directory for every generated tree', () => {
    /**
     * **Validates: Requirements 1.3, 1.5, 4.3**
     *
     * For every `{ home, projectRoot, cwd, marker }` descriptor:
     *
     * - Requirement 1.3: the walk stops at the first directory
     *   containing a marker and returns that directory.
     * - Requirement 1.5: the directory's identity — not the marker's —
     *   is what the result carries. The test uses any of the 15
     *   markers at `projectRoot` and asserts only on the path.
     * - Requirement 4.3: two cwds that walk to the same `projectRoot`
     *   yield the same `projectRoot` value (implicit — the property
     *   quantifies over every cwd under `projectRoot`).
     */
    fc.assert(
      fc.property(arbitraryFsTreeWithMarker(), (tree) => {
        // Re-point the mocks for this iteration. `mockReset()` in
        // `beforeEach` only runs once per `it()`, so each iteration
        // after the first inherits the previous iteration's
        // implementation until we overwrite it here.
        homedirMock.mockImplementation(() => tree.home);
        realpathSyncMock.mockImplementation((p: nodeFs.PathLike) =>
          typeof p === 'string' ? p : p.toString(),
        );
        existsSyncMock.mockImplementation((p: nodeFs.PathLike) => {
          const s = typeof p === 'string' ? p : p.toString();
          // True iff the probe is for the planted marker at the
          // generated `projectRoot`. Every other probe — ancestors
          // between `cwd` and `projectRoot`, and other markers at
          // `projectRoot` — must report absent, forcing the walk to
          // rely on the planted marker alone.
          return s === join(tree.projectRoot, tree.marker as string);
        });

        const result = detectProjectRoot(tree.cwd);

        expect(result.projectRoot).toBe(tree.projectRoot);
        expect(result.projectPath).toBe(tree.projectRoot);
        expect(result.isGlobal).toBe(false);
      }),
      // Reduced iteration count: each iteration re-programs the
      // `existsSync` mock and invokes the full walk, so keeping the
      // run count modest keeps this file under a few hundred ms.
      { numRuns: 25 },
    );
  });
});
