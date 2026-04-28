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

  it('init flags are correctly parsed and dispatched', async () => {
    /**
     * Validates: Requirements 1.5
     */
    const { cmdInit } = await import('../../src/installer/index.js');

    await dispatch(['init', '--no-set-default', '--yes', '--global-only']);
    expect(cmdInit).toHaveBeenCalledWith({
      setDefault: false,
      yes: true,
      globalOnly: true,
    });

    vi.mocked(cmdInit).mockClear();
    await dispatch(['init', '-y']);
    expect(cmdInit).toHaveBeenCalledWith({
      setDefault: true,
      yes: true,
      globalOnly: false,
    });
  });

  it('uninstall flags are correctly parsed and dispatched', async () => {
    /**
     * Validates: Requirements 1.5
     */
    const { cmdUninstall } = await import('../../src/installer/index.js');

    await dispatch(['uninstall', '--keep-data']);
    expect(cmdUninstall).toHaveBeenCalledWith({ keepData: true });

    vi.mocked(cmdUninstall).mockClear();
    await dispatch(['uninstall']);
    expect(cmdUninstall).toHaveBeenCalledWith({ keepData: false });
  });
});
