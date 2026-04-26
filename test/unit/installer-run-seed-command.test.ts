/**
 * Unit tests for `runSeedCommand` in `src/installer/index.ts`.
 *
 * Mocks `node:child_process.execFileSync` and `node:fs.existsSync` so these
 * tests exercise the tagged-union branching logic (spawn-failed /
 * non-zero-exit / missing-file / ok) without spawning real processes or
 * touching the filesystem. The argv-array form of execFileSync is the
 * implementation choice from Task 4.1 (shell-injection safety — see design
 * § Security); these tests assert the argv shape verbatim.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
 */

import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────

// Hoisted mock references so the factory closures below can bind to the
// same vi.fn() instances the tests will inspect. vi.hoisted runs before
// vi.mock factory evaluation, which runs before the top-level dynamic
// import of the module under test.
const { execFileSyncMock, existsSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

// Mock `node:child_process`. `runSeedCommand` uses `execFileSync`; other
// symbols (`execSync`, `spawn`) are imported at module scope by other
// installer helpers, so we provide inert stubs for them to keep the module
// load happy.
vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Mock `node:fs` but preserve every other fs export — `runSeedCommand`
// only touches `existsSync`, yet the installer module imports a long list
// of fs functions at module scope (readFileSync, writeFileSync, etc.) and
// those must continue to resolve to the real implementations.
vi.mock('node:fs', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('node:fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
  return {
    ...original,
    existsSync: existsSyncMock,
  };
});

// Import after mocks so vitest intercepts the modules.
const { runSeedCommand } = await import('../../src/installer/index.js');

// ── Constants ───────────────────────────────────────────────────────────

const targetDir = '/tmp/kiro-learn-test-agents';
const targetFile = path.join(targetDir, 'kiro-learn.json');

// ── Tests ───────────────────────────────────────────────────────────────

describe('runSeedCommand', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    existsSyncMock.mockReset();
  });

  it('returns { ok: true, targetFile } on happy path and invokes kiro-cli with the expected argv and env', () => {
    // Arrange: spawn exits 0, file appears on disk.
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    existsSyncMock.mockReturnValue(true);

    // Act.
    const result = runSeedCommand(targetDir);

    // Assert: result.
    expect(result).toEqual({ ok: true, targetFile });

    // Assert: exactly one spawn call.
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);

    // Assert: argv0, args, and options.
    const [cmd, args, options] = execFileSyncMock.mock.calls[0]!;
    expect(cmd).toBe('kiro-cli');
    expect(args).toEqual([
      'agent',
      'create',
      '--from',
      'kiro_default',
      '--directory',
      targetDir,
      'kiro-learn',
    ]);

    // Assert: stdio and env.
    const opts = options as {
      env: NodeJS.ProcessEnv;
      stdio: readonly ['ignore', 'pipe', 'pipe'];
    };
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(opts.env.EDITOR).toBe('true');

    // Spot-check: PATH and HOME are preserved from process.env.
    expect(opts.env.PATH).toBe(process.env.PATH);
    expect(opts.env.HOME).toBe(process.env.HOME);

    // Assert: the existsSync check ran against the expected target path.
    expect(existsSyncMock).toHaveBeenCalledWith(targetFile);
  });

  it('returns spawn-failed when execFileSync throws with no numeric status', () => {
    // Arrange: simulate ENOENT on kiro-cli — no `status` property.
    const err = Object.assign(new Error('spawn kiro-cli ENOENT'), {
      code: 'ENOENT',
      stderr: 'ENOENT: kiro-cli',
    });
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    // Act.
    const result = runSeedCommand(targetDir);

    // Assert.
    expect(result).toEqual({
      ok: false,
      reason: 'spawn-failed',
      stderr: 'ENOENT: kiro-cli',
    });

    // existsSync must not be consulted on the failure path.
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('returns non-zero-exit when execFileSync throws with status: 1', () => {
    // Arrange: kiro-cli ran but rejected the command.
    const err = Object.assign(new Error('Command failed'), {
      status: 1,
      stderr: 'error: unknown flag',
    });
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    // Act.
    const result = runSeedCommand(targetDir);

    // Assert.
    expect(result).toEqual({
      ok: false,
      reason: 'non-zero-exit',
      stderr: 'error: unknown flag',
    });
    expect(existsSyncMock).not.toHaveBeenCalled();
  });

  it('decodes a Buffer stderr as UTF-8 on non-zero exit (status: 2)', () => {
    // Arrange: stderr arrives as a Buffer, as execFileSync produces when
    // stdio is ['ignore', 'pipe', 'pipe'] without `encoding: 'utf8'`.
    const err = Object.assign(new Error('Command failed'), {
      status: 2,
      stderr: Buffer.from('buffer stderr', 'utf8'),
    });
    execFileSyncMock.mockImplementation(() => {
      throw err;
    });

    // Act.
    const result = runSeedCommand(targetDir);

    // Assert: stderr decoded to the UTF-8 string.
    expect(result).toEqual({
      ok: false,
      reason: 'non-zero-exit',
      stderr: 'buffer stderr',
    });
  });

  it('returns missing-file when execFileSync succeeds but existsSync is false', () => {
    // Arrange: spawn returns normally, but the expected file was not
    // written.
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    existsSyncMock.mockReturnValue(false);

    // Act.
    const result = runSeedCommand(targetDir);

    // Assert: stderr is an empty string for this defensive branch.
    expect(result).toEqual({
      ok: false,
      reason: 'missing-file',
      stderr: '',
    });
    expect(existsSyncMock).toHaveBeenCalledWith(targetFile);
  });
});
