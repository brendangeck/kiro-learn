/**
 * Integration test: fresh init flow.
 *
 * Uses a temp directory as HOME (mock homedir via vi.mock).
 * Mocks node:child_process so that checkKiroCli, installDeps, startDaemon,
 * setDefaultAgent, and runSeedCommand don't actually spawn processes.
 * The `execFileSync` mock simulates `kiro-cli agent create --from
 * kiro_default` writing a known seed payload to `<targetDir>/kiro-learn.json`,
 * which routes `writeKiroLearnAgent` down the merge path so the
 * integration test exercises seed-then-merge end-to-end (not just the
 * Fallback_Config branch).
 * Mocks cpSync so deployPayload creates lib/ subdirs without needing a
 * real dist/ directory.
 *
 * Creates a project directory with a .git marker under the temp home,
 * calls cmdInit with { setDefault: true, yes: true, globalOnly: false },
 * and verifies the full directory layout, bin wrappers, agent configs,
 * and settings.
 *
 * Validates: Requirements 2.1–2.6, 3.1–3.4, 5.1–5.5, 6.1–6.10, 14.1
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Resolve symlinks so paths are consistent with realpathSync inside the module.
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-init-integ-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Mock child_process so execSync/spawn/execFileSync don't actually run
// external commands.
// - checkKiroCli calls execSync('kiro-cli --version')
// - installDeps calls execSync('npm install --production')
// - setDefaultAgent calls execSync('kiro-cli agent set-default kiro-learn')
// - startDaemon calls spawn(process.execPath, [...])
// - writeKiroLearnAgent → runSeedCommand calls
//   execFileSync('kiro-cli', ['agent', 'create', '--from', 'kiro_default', ...])
//
// The execFileSync mock simulates `kiro-cli agent create --from
// kiro_default --directory <dir> kiro-learn` writing a seed payload. This
// routes `writeKiroLearnAgent` down the merge path (not the fallback
// path), so the integration test exercises the happy path of the
// seed-then-merge flow.
vi.mock('node:child_process', async () => {
  const { writeFileSync: realWriteFileSync } = (await vi.importActual(
    'node:fs',
  )) as typeof import('node:fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports

  const seedJson = JSON.stringify(
    {
      name: 'kiro_default',
      description: 'Default agent',
      prompt: 'You are the default agent.',
      tools: ['fs_read', 'fs_write'],
    },
    null,
    2,
  );

  return {
    execSync: vi.fn(() => Buffer.from('')),
    execFileSync: vi.fn((_cmd: string, args: readonly string[]) => {
      const dirIdx = args.indexOf('--directory');
      if (dirIdx !== -1 && dirIdx < args.length - 1) {
        const dir = args[dirIdx + 1]!;
        realWriteFileSync(`${dir}/kiro-learn.json`, seedJson);
      }
      return Buffer.from('');
    }),
    spawn: vi.fn(() => ({
      pid: 99999,
      unref: vi.fn(),
      on: vi.fn(),
    })),
  };
});

// Mock cpSync so deployPayload creates lib/ subdirs without needing
// a real dist/ directory. Other fs functions remain real.
vi.mock('node:fs', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('node:fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
  return {
    ...original,
    cpSync: vi.fn((_src: string, dst: string) => {
      original.mkdirSync(dst, { recursive: true });
    }),
  };
});

// Import after mocks so vitest intercepts the modules.
const { cmdInit, INSTALL_DIR, OWNED_TRIGGERS, KIRO_LEARN_DESCRIPTION } = await import(
  '../../src/installer/index.js'
);

// Suppress stdout/stderr noise from cmdInit progress messages
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

// ── Setup ───────────────────────────────────────────────────────────────

let projectDir: string;

beforeAll(async () => {
  // Create a project directory with a .git marker under the temp home
  projectDir = join(tmpHome, 'my-project');
  mkdirSync(join(projectDir, '.git'), { recursive: true });

  // Override cwd to point at the project directory
  vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

  // Run cmdInit
  const exitCode = await cmdInit({ setDefault: true, yes: true, globalOnly: false });
  expect(exitCode).toBe(0);
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('fresh init flow — integration', () => {
  it('creates ~/.kiro-learn/ directory', () => {
    expect(existsSync(INSTALL_DIR)).toBe(true);
  });

  it('creates bin/, lib/, logs/ subdirectories', () => {
    expect(existsSync(join(INSTALL_DIR, 'bin'))).toBe(true);
    expect(existsSync(join(INSTALL_DIR, 'lib'))).toBe(true);
    expect(existsSync(join(INSTALL_DIR, 'logs'))).toBe(true);
  });

  it('creates ~/.kiro/agents/ directory', () => {
    expect(existsSync(join(tmpHome, '.kiro', 'agents'))).toBe(true);
  });

  it('deploys payload — lib/ has shim/, collector/, installer/, types/ subdirs', () => {
    for (const subdir of ['shim', 'collector', 'installer', 'types']) {
      expect(
        existsSync(join(INSTALL_DIR, 'lib', subdir)),
        `lib/${subdir} should exist`,
      ).toBe(true);
    }
  });

  it('writes bin wrappers that are executable', () => {
    for (const name of ['shim', 'collector', 'kiro-learn']) {
      const binPath = join(INSTALL_DIR, 'bin', name);
      expect(existsSync(binPath), `bin/${name} should exist`).toBe(true);

      // Check executable permission (owner execute bit)
      const stat = statSync(binPath);
      expect(stat.mode & 0o111, `bin/${name} should be executable`).toBeGreaterThan(0);
    }
  });

  it('shim wrapper has correct shebang and import', () => {
    const content = readFileSync(join(INSTALL_DIR, 'bin', 'shim'), 'utf8');
    expect(content).toContain('#!/usr/bin/env node');
    expect(content).toContain('../lib/shim/cli-agent/index.js');
  });

  it('collector wrapper has SIGTERM/SIGINT handlers', () => {
    const content = readFileSync(join(INSTALL_DIR, 'bin', 'collector'), 'utf8');
    expect(content).toContain('#!/usr/bin/env node');
    expect(content).toContain('SIGTERM');
    expect(content).toContain('SIGINT');
  });

  it('kiro-learn wrapper imports from installer/bin.js', () => {
    const content = readFileSync(join(INSTALL_DIR, 'bin', 'kiro-learn'), 'utf8');
    expect(content).toContain('#!/usr/bin/env node');
    expect(content).toContain('../lib/installer/bin.js');
  });

  it('writes kiro-learn.json agent config globally with merged seed payload', () => {
    /**
     * Validates the seed-then-merge flow ran end-to-end at global scope:
     * mocked `kiro-cli` writes a seed containing `name: 'kiro_default'`,
     * a custom `description`, `prompt`, and `tools`; `writeKiroLearnAgent`
     * merges kiro-learn's owned fields (name, description, four hook
     * triggers) onto the seed and writes the result back. The presence
     * of `tools` in the final file proves the merge branch ran — the
     * Fallback_Config does not carry that key.
     */
    const configPath = join(tmpHome, '.kiro', 'agents', 'kiro-learn.json');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      name: string;
      description: string;
      prompt?: string;
      tools?: string[];
      hooks: Record<string, unknown[]>;
    };

    // Owned top-level fields overwritten by the merge.
    expect(config.name).toBe('kiro-learn');
    expect(config.description).toBe(KIRO_LEARN_DESCRIPTION);

    // Non-owned seed fields survive — this is the merge-branch witness.
    expect(config.prompt).toBe('You are the default agent.');
    expect(config.tools).toEqual(['fs_read', 'fs_write']);

    // All four owned hook triggers present.
    for (const trigger of OWNED_TRIGGERS) {
      expect(config.hooks).toHaveProperty(trigger);
    }
  });

  it('writes kiro-learn-compressor.json agent config globally', () => {
    const configPath = join(
      tmpHome,
      '.kiro',
      'agents',
      'kiro-learn-compressor.json',
    );
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      prompt: string;
      tools: string[];
      allowedTools: string[];
    };
    expect(config.prompt).toContain('memory extraction agent');
    expect(config.tools).toEqual([]);
    expect(config.allowedTools).toEqual([]);
  });

  it('writes kiro-learn.json agent config at project scope with merged seed payload', () => {
    /**
     * Mirrors the global-scope assertion: the project-scope file must
     * also be the output of the merge branch (same mocked seed, same
     * merge helper), so `tools` and `prompt` survive end-to-end.
     */
    const configPath = join(projectDir, '.kiro', 'agents', 'kiro-learn.json');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      name: string;
      description: string;
      prompt?: string;
      tools?: string[];
      hooks: Record<string, unknown[]>;
    };

    expect(config.name).toBe('kiro-learn');
    expect(config.description).toBe(KIRO_LEARN_DESCRIPTION);
    expect(config.prompt).toBe('You are the default agent.');
    expect(config.tools).toEqual(['fs_read', 'fs_write']);
    for (const trigger of OWNED_TRIGGERS) {
      expect(config.hooks).toHaveProperty(trigger);
    }
  });

  it('creates settings.json with defaults', () => {
    const settingsPath = join(INSTALL_DIR, 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      collector: { host: string; port: number };
      shim: { timeoutMs: number };
    };
    expect(settings.collector.host).toBe('127.0.0.1');
    expect(settings.collector.port).toBe(21100);
    expect(settings.shim.timeoutMs).toBe(2000);
  });
});
