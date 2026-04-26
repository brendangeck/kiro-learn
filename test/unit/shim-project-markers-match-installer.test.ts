/**
 * Marker-list parity test.
 *
 * The shim's {@link PROJECT_MARKERS} in `src/shim/shared/project-root.ts`
 * is a deliberate byte-for-byte duplicate of the installer's
 * {@link PROJECT_MARKERS} in `src/installer/index.ts` (see the shim
 * module's TSDoc for the full rationale and Requirement N9). The two
 * lists MUST stay in lock-step — this test catches any drift at the
 * test layer without violating the production modularity boundary.
 *
 * Importing from `src/installer/` into `src/shim/` is forbidden by
 * `test/unit/no-shim-in-installer.test.ts`. This file is a test, not
 * production code, so it is free to import from either side.
 *
 * Validates: Requirements 1.4, N9
 */

import { describe, expect, it } from 'vitest';

import { PROJECT_MARKERS as INSTALLER_PROJECT_MARKERS } from '../../src/installer/index.js';
import { PROJECT_MARKERS as SHIM_PROJECT_MARKERS } from '../../src/shim/shared/project-root.js';

describe('Feature: project-path-capture — marker-list parity with installer', () => {
  it('shim PROJECT_MARKERS deep-equals installer PROJECT_MARKERS (same length, same strings, same order)', () => {
    expect(SHIM_PROJECT_MARKERS).toEqual(INSTALLER_PROJECT_MARKERS);
    // Redundant but explicit: assert length and order match too, so a
    // failure message pinpoints which invariant broke.
    expect(SHIM_PROJECT_MARKERS.length).toBe(INSTALLER_PROJECT_MARKERS.length);
    for (let i = 0; i < INSTALLER_PROJECT_MARKERS.length; i++) {
      expect(SHIM_PROJECT_MARKERS[i]).toBe(INSTALLER_PROJECT_MARKERS[i]);
    }
  });
});
