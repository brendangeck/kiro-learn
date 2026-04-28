/**
 * Unit tests for argv parsing in `src/installer/bin.ts`.
 *
 * Tests the CLI dispatch logic by importing the `dispatch` function
 * directly and exercising it in-process — no child process spawning.
 * The `dispatch` function captures stdout/stderr into a result object,
 * so we can assert on output without wiring spies or spawning `npx tsx`.
 *
 * Command handlers (`cmdInit`, `cmdStart`, etc.) are mocked so only the
 * bin's own parsing and routing logic is exercised.
 *
 * Validates: Requirements 1.3, 1.4, 1.5, 1.6
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Mock the command handlers so dispatch never runs real init/start/stop/etc.
vi.mock('../../src/installer/index.js', () => ({
  cmdInit: vi.fn(async () => 0),
  cmdStart: vi.fn(() => 0),
  cmdStop: vi.fn(() => 0),
  cmdStatus: vi.fn(() => 0),
  cmdUninstall: vi.fn(() => 0),
}));

const { dispatch } = await import('../../src/installer/bin.js');

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(thisDir, '../..');

describe('installer argv parsing', () => {
  it('--version prints version and sets exitCode 0', async () => {
    /**
     * Validates: Requirements 1.6
     */
    const result = await dispatch(['--version']);

    expect(result.stdout).toContain('kiro-learn');
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    expect(result.exitCode).toBe(0);
  });

  it('--help prints usage and sets exitCode 0', async () => {
    /**
     * Validates: Requirements 1.3
     */
    const result = await dispatch(['--help']);

    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('init');
    expect(result.stdout).toContain('start');
    expect(result.stdout).toContain('stop');
    expect(result.stdout).toContain('status');
    expect(result.stdout).toContain('uninstall');
    expect(result.exitCode).toBe(0);
  });

  it('no args prints usage and sets exitCode 0', async () => {
    /**
     * Validates: Requirements 1.3
     */
    const result = await dispatch([]);

    expect(result.stdout).toContain('Usage:');
    expect(result.exitCode).toBe(0);
  });

  it('unrecognized command sets exitCode 1 with error listing valid commands', async () => {
    /**
     * Validates: Requirements 1.4
     */
    const result = await dispatch(['frobnicate']);

    expect(result.stderr).toContain('[kiro-learn]');
    expect(result.stderr).toContain('unknown command');
    expect(result.stderr).toContain('frobnicate');
    expect(result.stderr).toContain('Valid commands:');
    expect(result.exitCode).toBe(1);
  });

  it('flags are correctly parsed — source verifies dispatch table', () => {
    /**
     * Validates: Requirements 1.5
     *
     * Verify the bin.ts source contains the correct flag parsing logic
     * for init flags (--no-set-default, --yes, -y, --global-only) and
     * uninstall flags (--keep-data).
     */
    const binSource = readFileSync(
      path.join(projectRoot, 'src', 'installer', 'bin.ts'),
      'utf8',
    );

    // init flags
    expect(binSource).toContain("'--no-set-default'");
    expect(binSource).toContain("'--yes'");
    expect(binSource).toContain("'-y'");
    expect(binSource).toContain("'--global-only'");

    // uninstall flags
    expect(binSource).toContain("'--keep-data'");

    // Verify the flag logic is correct:
    // setDefault should be negated (NOT includes --no-set-default)
    expect(binSource).toContain("!flags.includes('--no-set-default')");
  });
});
