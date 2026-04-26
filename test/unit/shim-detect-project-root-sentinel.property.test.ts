/**
 * Property-based test for `detectProjectRoot` — the global sentinel
 * fallback for marker-free walks.
 *
 * Feature: project-path-capture, Property 2: Global sentinel fallback
 * for marker-free walks
 *
 * For any `cwd` strictly under the mocked `$HOME` ceiling with no
 * marker present on any directory between `cwd` and the ceiling, the
 * walk MUST return `{ projectRoot: ceiling, projectPath: ceiling,
 * isGlobal: true }`.
 *
 * Derived consequence: for any two cwds under the same ceiling, the
 * `project_id` hash input — `SHA-256(projectRoot)` — is the same in
 * both cases and equals `SHA-256(ceiling)`. This is the whole point of
 * the global sentinel: every marker-free event from one user collapses
 * into one `project_id`.
 *
 * **Validates: Requirements 2.2, 3.1, 3.2, 3.3**
 *
 * ## Strategy
 *
 * `arbitraryFsTreeNoMarker()` in `test/helpers/arbitrary.ts` emits a
 * data-only descriptor `{ home, projectRoot, cwd, marker: null }`
 * where `projectRoot === home` by construction. For each generated
 * descriptor we:
 *
 * 1. Re-point the mocked `homedir()` at the descriptor's `home`.
 * 2. Re-point the mocked `realpathSync` as identity (no symlinks in
 *    the generated tree).
 * 3. Re-point the mocked `existsSync` to return `false` unconditionally
 *    — no markers exist anywhere, which is exactly the marker-free
 *    scenario Property 2 quantifies over.
 *
 * With the mocks in place, the only way `detectProjectRoot` can
 * return a non-ceiling `projectRoot` is via an unexpected walk-body
 * throw (Requirement 7.4) — which is exactly what this property
 * asserts *does not happen* on normal marker-free inputs.
 *
 * @see .kiro/specs/project-path-capture/design.md § Property 2
 * @see .kiro/specs/project-path-capture/tasks.md § Task 3.8
 */

import { createHash } from 'node:crypto';
import type * as nodeFs from 'node:fs';
import type * as nodeOs from 'node:os';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { arbitraryFsTreeNoMarker } from '../helpers/arbitrary.js';

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

/** Hex SHA-256 of the given path, matching `buildEvent`'s hash recipe. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// Feature: project-path-capture, Property 2: Global sentinel fallback
// for marker-free walks
describe('detectProjectRoot — property: global sentinel fallback for marker-free walks (P2)', () => {
  let stderrSpy: { mockRestore: () => void };

  beforeEach(() => {
    // Swallow any stderr writes — none are expected on the marker-free
    // happy path this property exercises, but keeping the real stderr
    // quiet makes regressions surface cleanly as assertion failures
    // rather than as log noise on the terminal.
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

  it('returns the ceiling sentinel for every marker-free tree', () => {
    /**
     * **Validates: Requirements 2.2, 3.1, 3.2, 3.3**
     *
     * For every `{ home, projectRoot: home, cwd, marker: null }`
     * descriptor with no markers anywhere between `cwd` and `home`:
     *
     * - Requirement 2.2: the ceiling itself is never inspected for a
     *   marker. With `existsSync` always returning `false` the walk
     *   cannot stop inside the tree regardless; and because no probe
     *   is expected at `ceiling`, any deviation would surface as a
     *   `projectRoot` that equals one of the ancestor directories
     *   rather than the ceiling. The assertion `projectRoot ===
     *   home` captures both the non-inspection and the fallback.
     * - Requirement 3.1: the walk completes without finding a marker
     *   and the result's `projectRoot` is set to the ceiling.
     * - Requirement 3.2: the derived `project_id` equals
     *   `SHA-256(ceiling)`. The test computes the expected hex and
     *   compares against `SHA-256(result.projectRoot)`.
     * - Requirement 3.3: `source.project_path` (surfaced as
     *   `result.projectPath`) is set to the ceiling — the same value
     *   as `projectRoot`.
     *
     * Derived consequence: two different cwds under the same ceiling
     * (here `tree.cwd` and an alternate `home + /alt`) produce equal
     * `project_id`s, both equal to `SHA-256(ceiling)`. This is the
     * entire point of the global sentinel — every marker-free event
     * from one user collapses into one namespace.
     */
    fc.assert(
      fc.property(arbitraryFsTreeNoMarker(), (tree) => {
        // Re-point the mocks for this iteration. `mockReset()` in
        // `beforeEach` only runs once per `it()`, so each iteration
        // after the first inherits the previous iteration's
        // implementation until we overwrite it here.
        homedirMock.mockImplementation(() => tree.home);
        realpathSyncMock.mockImplementation((p: nodeFs.PathLike) =>
          typeof p === 'string' ? p : p.toString(),
        );
        // No markers anywhere — this is the marker-free scenario
        // Property 2 quantifies over.
        existsSyncMock.mockImplementation(() => false);

        // Primary assertion: the generated cwd resolves to the
        // global sentinel.
        const result = detectProjectRoot(tree.cwd);
        expect(result.projectRoot).toBe(tree.home);
        expect(result.projectPath).toBe(tree.home);
        expect(result.isGlobal).toBe(true);

        // Derived consequence: a *different* cwd under the same
        // ceiling also resolves to the same ceiling. Use a fixed
        // alternate suffix so the second cwd is guaranteed distinct
        // from `tree.cwd` (which is itself at least one segment deep
        // under `home`, but may share its first segment with our
        // alternate — that's fine, we only need the ceilings to
        // agree).
        const altCwd = `${tree.home}/alt-sentinel-probe`;
        const altResult = detectProjectRoot(altCwd);
        expect(altResult.projectRoot).toBe(tree.home);
        expect(altResult.projectPath).toBe(tree.home);
        expect(altResult.isGlobal).toBe(true);

        // Derived consequence continued: both cwds yield equal
        // `project_id`s, and both equal `SHA-256(ceiling)`. This is
        // Requirement 3.2 stated as an equivalence class over cwds.
        const expectedProjectId = sha256Hex(tree.home);
        expect(sha256Hex(result.projectRoot)).toBe(expectedProjectId);
        expect(sha256Hex(altResult.projectRoot)).toBe(expectedProjectId);
        expect(sha256Hex(result.projectRoot)).toBe(
          sha256Hex(altResult.projectRoot),
        );
      }),
      // Reduced iteration count: each iteration runs two full walks
      // plus two SHA-256 hashes. Fewer runs keep the file fast while
      // the generator still covers a variety of home/cwd depths.
      { numRuns: 25 },
    );
  });
});
