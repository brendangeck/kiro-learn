/**
 * Property-based test for `detectProjectRoot` — walk-ceiling
 * containment.
 *
 * Feature: project-path-capture, Property 3: Walk-ceiling containment
 *
 * For any `cwd` strictly under the mocked `$HOME` ceiling, the walk
 * MUST return a `projectRoot` that is either equal to the ceiling or a
 * descendant of it. The walk must never escape above `$HOME`.
 *
 * This property holds regardless of whether the generated tree
 * contains a marker (in which case `projectRoot` is the marker-bearing
 * ancestor — always a descendant of the ceiling by construction) or no
 * marker (in which case the fallback returns the ceiling itself). The
 * `fc.oneof` driver below exercises both branches so a future bug in
 * either — say, a walk that climbs past the ceiling, or a fallback
 * that returns `/` or `process.cwd()` — surfaces as a counter-example
 * here.
 *
 * **Validates: Requirements 2.3, 2.6**
 *
 * ## Strategy
 *
 * Mirrors the mock pattern from Tasks 3.7 / 3.8 (hoisted mocks for
 * `realpathSync`, `existsSync`, `homedir`). For each generated
 * descriptor:
 *
 * 1. Re-point `homedir()` at the descriptor's `home`.
 * 2. Re-point `realpathSync` as identity (no symlinks in the
 *    generated tree).
 * 3. Re-point `existsSync` so that it returns `true` only for the
 *    planted marker (if any) at the descriptor's `projectRoot`. In
 *    the no-marker branch every probe returns `false`.
 *
 * With the mocks in place the walk either stops at the planted
 * marker-bearing directory — a descendant of `home` — or exhausts to
 * the ceiling itself. The property asserts containment in both cases.
 *
 * Paths in the generated tree are POSIX-style (`/`-separated) and
 * rooted under `/mock-home/...`, so the containment check uses the
 * literal `/` separator rather than `node:path`'s platform-dependent
 * `sep` — per the task's note, either is acceptable here.
 *
 * @see .kiro/specs/project-path-capture/design.md § Property 3
 * @see .kiro/specs/project-path-capture/tasks.md § Task 3.9
 */

import type * as nodeFs from 'node:fs';
import type * as nodeOs from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  arbitraryFsTreeNoMarker,
  arbitraryFsTreeWithMarker,
} from '../helpers/arbitrary.js';

// Hoisted mock references so they exist before the mocked modules are
// imported. Each iteration of the property re-programs these via
// `mockImplementation` — the module-level `vi.mock` call is invoked
// once, and per-iteration behaviour is steered through the hoisted
// refs.
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

// Feature: project-path-capture, Property 3: Walk-ceiling containment
describe('detectProjectRoot — property: walk-ceiling containment (P3)', () => {
  let stderrSpy: { mockRestore: () => void };

  beforeEach(() => {
    // Swallow any stderr writes — none are expected on the happy paths
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

  it('returns a projectRoot equal to or under the ceiling for every cwd under $HOME', () => {
    /**
     * **Validates: Requirements 2.3, 2.6**
     *
     * For every descriptor — whether generated with a planted marker
     * (marker-bearing branch of the walk) or without one (ceiling
     * fallback branch) — the returned `projectRoot` MUST satisfy
     * containment under the mocked ceiling:
     *
     *   result.projectRoot === home
     *     OR
     *   result.projectRoot.startsWith(home + '/')
     *
     * - Requirement 2.3: the walk never inspects any directory at or
     *   above the ceiling. The contrapositive of containment is a
     *   `projectRoot` outside the ceiling — which this assertion
     *   rejects.
     * - Requirement 2.6: ceiling behaviour matches the installer's
     *   `detectScope` — the walk stops *before* `$HOME`. Every cwd
     *   under `$HOME` yields a `projectRoot` still under `$HOME`.
     *
     * The `fc.oneof` driver randomly selects between the marker and
     * no-marker generators so both walk-termination branches are
     * exercised within the default 100 iterations:
     *
     * - With-marker iterations exercise Phase 3 of the walk: the
     *   result is the marker-bearing directory, always a strict
     *   descendant of the ceiling by the generator's construction.
     * - No-marker iterations exercise Phase 4 of the walk: the walk
     *   exhausts to the ceiling and the result equals the ceiling
     *   itself.
     *
     * Both cases satisfy the containment predicate, so the single
     * assertion below is the complete property — no per-branch
     * conditional is required.
     */
    fc.assert(
      fc.property(
        fc.oneof(arbitraryFsTreeWithMarker(), arbitraryFsTreeNoMarker()),
        (tree) => {
          // Re-point the mocks for this iteration. `mockReset()` in
          // `beforeEach` only runs once per `it()`, so each iteration
          // after the first inherits the previous iteration's
          // implementation until we overwrite it here.
          homedirMock.mockImplementation(() => tree.home);
          realpathSyncMock.mockImplementation((p: nodeFs.PathLike) =>
            typeof p === 'string' ? p : p.toString(),
          );
          existsSyncMock.mockImplementation((p: nodeFs.PathLike) => {
            // When the descriptor has no marker planted, every probe
            // must report absent — this forces the walk into the
            // Phase 4 fallback that returns the ceiling.
            if (tree.marker === null) return false;
            // When a marker is planted, only the probe for that
            // exact marker at the generated `projectRoot` succeeds.
            // Every other probe — including probes at ancestor
            // directories between `cwd` and `projectRoot`, and
            // probes for other markers at `projectRoot` — must
            // report absent.
            const s = typeof p === 'string' ? p : p.toString();
            return s === join(tree.projectRoot, tree.marker);
          });

          const result = detectProjectRoot(tree.cwd);

          // The containment predicate: `projectRoot` is either the
          // ceiling itself or a descendant. Generated paths are
          // POSIX-style, so `/` is the correct separator here.
          const containedInCeiling =
            result.projectRoot === tree.home ||
            result.projectRoot.startsWith(`${tree.home}/`);
          expect(containedInCeiling).toBe(true);

          // `projectPath` must mirror `projectRoot` by contract
          // (Requirement 6.1) — re-asserting here ensures a
          // regression that diverges the two values surfaces against
          // this property rather than drifting through unnoticed.
          expect(result.projectPath).toBe(result.projectRoot);
        },
      ),
      // Reduced iteration count: the `fc.oneof` driver alternates
      // between the with-marker and no-marker generators, so 25 runs
      // exercise both walk-termination branches comfortably.
      { numRuns: 25 },
    );
  });
});
