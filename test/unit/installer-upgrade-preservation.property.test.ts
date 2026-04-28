/**
 * Property-based test: Upgrade data preservation.
 *
 * Feature: installer, Property 2: Upgrade data preservation
 *
 * For any existing install with random file contents in kiro-learn.db,
 * settings.json, and logs/, running the upgrade-relevant functions preserves
 * byte-identical contents of those files while replacing lib/, bin/.
 *
 * **Validates: Requirements 2.7, 12.5**
 *
 * @see .kiro/specs/installer/design.md § Property 2
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve symlinks (macOS /var → /private/var).
// tmpHome is set once and never reassigned — INSTALL_DIR is computed at
// module load time from homedir(), so it must remain stable.
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-upgrade-prop-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Mock `node:child_process` so `writeAgentConfigs` → `writeKiroLearnAgent`
// → `runSeedCommand` does not spawn real `kiro-cli` during unit tests.
// `execFileSync` throws with no `status` property, which forces the
// `spawn-failed` branch and routes to the Fallback_Config writer.
// This test only cares about data file preservation, not agent config content.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => {
    throw Object.assign(new Error('spawn kiro-cli ENOENT'), {
      code: 'ENOENT',
    });
  }),
  execSync: vi.fn(() => Buffer.from('')),
  spawn: vi.fn(() => ({
    pid: 99999,
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

// Import after mocks so vitest intercepts the modules.
const { writeBinWrappers, writeAgentConfigs, INSTALL_DIR } = await import(
  '../../src/installer/index.js'
);

beforeEach(() => {
  // Clean up any leftover state from previous test
  rmSync(INSTALL_DIR, { recursive: true, force: true });
  rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });
  // Suppress the `[kiro-learn] warning:` line the fallback writer emits.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('Installer — property: upgrade data preservation (P2)', () => {
  it('data files are byte-identical after upgrade operations', () => {
    /**
     * **Validates: Requirements 2.7, 12.5**
     *
     * Simulate an existing install with random data files, then run the
     * upgrade-relevant functions (writeBinWrappers, writeAgentConfigs)
     * and verify data files are preserved.
     */
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 512 }),
        fc.uint8Array({ minLength: 0, maxLength: 256 }),
        fc.uint8Array({ minLength: 0, maxLength: 128 }),
        (dbData, settingsData, logData) => {
          // Clean up from previous iteration
          rmSync(INSTALL_DIR, { recursive: true, force: true });
          rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });

          // Create the initial install directory structure
          mkdirSync(join(INSTALL_DIR, 'bin'), { recursive: true });
          mkdirSync(join(INSTALL_DIR, 'lib'), { recursive: true });
          mkdirSync(join(INSTALL_DIR, 'logs'), { recursive: true });
          mkdirSync(join(INSTALL_DIR, 'node_modules'), { recursive: true });
          mkdirSync(join(tmpHome, '.kiro', 'agents'), { recursive: true });

          // Write random data files
          writeFileSync(join(INSTALL_DIR, 'kiro-learn.db'), dbData);
          writeFileSync(join(INSTALL_DIR, 'settings.json'), settingsData);
          writeFileSync(
            join(INSTALL_DIR, 'logs', 'collector-2025-01-01.log'),
            logData,
          );

          // Run upgrade-relevant functions (these should NOT touch data files)
          writeBinWrappers();
          writeAgentConfigs({
            global: true,
            projectRoot: undefined,
            detectedMarker: undefined,
          });

          // Verify data files are byte-identical
          const dbAfter = readFileSync(join(INSTALL_DIR, 'kiro-learn.db'));
          const settingsAfter = readFileSync(join(INSTALL_DIR, 'settings.json'));
          const logAfter = readFileSync(
            join(INSTALL_DIR, 'logs', 'collector-2025-01-01.log'),
          );

          expect(Buffer.from(dbAfter)).toEqual(Buffer.from(dbData));
          expect(Buffer.from(settingsAfter)).toEqual(Buffer.from(settingsData));
          expect(Buffer.from(logAfter)).toEqual(Buffer.from(logData));

          // Verify bin wrappers were written (upgrade replaced them)
          expect(existsSync(join(INSTALL_DIR, 'bin', 'shim'))).toBe(true);
          expect(existsSync(join(INSTALL_DIR, 'bin', 'collector'))).toBe(true);
          expect(existsSync(join(INSTALL_DIR, 'bin', 'kiro-learn'))).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});
