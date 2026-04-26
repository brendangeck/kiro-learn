/**
 * Unit tests for bin wrapper content and agent config generation.
 *
 * Uses a temp directory as INSTALL_DIR and HOME. Calls writeBinWrappers()
 * and writeAgentConfigs() with the temp directory setup.
 *
 * INSTALL_DIR is computed once at module load time from homedir(), so we
 * set tmpHome before the import and keep it stable across all tests.
 *
 * `node:child_process` is mocked so `writeKiroLearnAgent` takes the
 * Fallback_Config branch (no real `kiro-cli` spawn). The fallback bytes
 * are structurally identical to the pre-spec hand-authored output, so
 * the hook-shape assertions below are valid guards for the fallback path
 * specifically. The merge path is exercised in
 * `installer-init-integration.test.ts` and
 * `installer-write-kiro-learn-agent.test.ts`.
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.5, 6.3, 6.4, 6.5, 6.8, 6.9
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve symlinks so paths are consistent with realpathSync inside the module.
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-wrappers-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Mock `node:child_process` so `writeKiroLearnAgent` → `runSeedCommand`
// does not spawn real `kiro-cli` during unit tests. `execFileSync` throws
// with no `status` property, which forces the `spawn-failed` branch and
// routes `writeAgentConfigs` to the Fallback_Config writer. The bare
// hooks-only bytes that the Fallback_Config produces are byte-for-byte
// identical to the pre-spec hand-authored output, so the existing
// assertions on hook shape still hold — and this file becomes a
// load-bearing guard for the fallback path (Requirements 6.2, 8.3).
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

// Suppress the `[kiro-learn] warning:` line the fallback writer emits so
// it doesn't clutter test output. Installed per-test because vitest's
// `restoreMocks: true` (see vitest.config.ts) clears spies before each
// test. The warning itself is asserted explicitly in
// `installer-write-kiro-learn-agent.test.ts`.
beforeEach(() => {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

// Import after mocks so vitest intercepts the modules.
const { writeBinWrappers, writeAgentConfigs, INSTALL_DIR, OWNED_TRIGGERS } = await import(
  '../../src/installer/index.js'
);

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('writeBinWrappers', () => {
  beforeEach(() => {
    // Ensure the bin directory exists for each test
    mkdirSync(join(INSTALL_DIR, 'bin'), { recursive: true });
  });

  afterEach(() => {
    // Clean up the install dir contents between tests
    rmSync(INSTALL_DIR, { recursive: true, force: true });
  });

  it('shim wrapper has correct shebang and import path', () => {
    /**
     * Validates: Requirements 5.1, 5.5
     */
    writeBinWrappers();

    const shimContent = readFileSync(join(INSTALL_DIR, 'bin', 'shim'), 'utf8');

    expect(shimContent).toContain('#!/usr/bin/env node');
    expect(shimContent).toContain('../lib/shim/cli-agent/index.js');
  });

  it('collector wrapper has SIGTERM/SIGINT handlers', () => {
    /**
     * Validates: Requirements 5.2
     */
    writeBinWrappers();

    const collectorContent = readFileSync(
      join(INSTALL_DIR, 'bin', 'collector'),
      'utf8',
    );

    expect(collectorContent).toContain('#!/usr/bin/env node');
    expect(collectorContent).toContain('SIGTERM');
    expect(collectorContent).toContain('SIGINT');
    expect(collectorContent).toContain('handle.close()');
  });

  it('kiro-learn wrapper imports from ../lib/installer/bin.js', () => {
    /**
     * Validates: Requirements 5.3
     */
    writeBinWrappers();

    const cliContent = readFileSync(
      join(INSTALL_DIR, 'bin', 'kiro-learn'),
      'utf8',
    );

    expect(cliContent).toContain('#!/usr/bin/env node');
    expect(cliContent).toContain('../lib/installer/bin.js');
  });
});

describe('writeAgentConfigs', () => {
  beforeEach(() => {
    mkdirSync(join(INSTALL_DIR, 'bin'), { recursive: true });
    mkdirSync(join(tmpHome, '.kiro', 'agents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });
  });

  it('kiro-learn.json has all four hooks with absolute shim path and || true', () => {
    /**
     * Validates: Requirements 6.3, 6.4
     */
    writeAgentConfigs({
      global: true,
      projectRoot: undefined,
      detectedMarker: undefined,
    });

    const configPath = join(tmpHome, '.kiro', 'agents', 'kiro-learn.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      hooks: Record<string, Array<{ command: string; matcher?: string }>>;
    };

    // All four hooks must be present
    for (const trigger of OWNED_TRIGGERS) {
      expect(config.hooks).toHaveProperty(trigger);
    }

    // Every command must use absolute path (quoted) and end with || true
    const shimPath = join(INSTALL_DIR, 'bin', 'shim');
    for (const [, hookEntries] of Object.entries(config.hooks)) {
      for (const entry of hookEntries) {
        expect(entry.command).toContain(shimPath);
        expect(entry.command).toContain('"');
        expect(entry.command).toMatch(/\|\| true$/);
      }
    }
  });

  it('kiro-learn-compressor.json has extraction prompt and empty tools', () => {
    /**
     * Validates: Requirements 6.8, 6.9
     */
    writeAgentConfigs({
      global: true,
      projectRoot: undefined,
      detectedMarker: undefined,
    });

    const configPath = join(
      tmpHome,
      '.kiro',
      'agents',
      'kiro-learn-compressor.json',
    );
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      prompt: string;
      tools: string[];
      allowedTools: string[];
    };

    expect(config.prompt).toContain('memory extraction agent');
    expect(config.tools).toEqual([]);
    expect(config.allowedTools).toEqual([]);
  });

  it('postToolUse hook has matcher: "*"', () => {
    /**
     * Validates: Requirements 6.5
     */
    writeAgentConfigs({
      global: true,
      projectRoot: undefined,
      detectedMarker: undefined,
    });

    const configPath = join(tmpHome, '.kiro', 'agents', 'kiro-learn.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      hooks: {
        postToolUse: Array<{ matcher?: string; command: string }>;
      };
    };

    expect(config.hooks.postToolUse).toHaveLength(1);
    expect(config.hooks.postToolUse[0]!.matcher).toBe('*');
  });
});
