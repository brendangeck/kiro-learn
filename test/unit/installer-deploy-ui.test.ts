/**
 * Test: deployPayload copies `ui/` when present, skips when absent.
 *
 * Uses a temp directory as HOME (mock homedir via vi.mock).
 * Mocks cpSync to create destination directories without needing real
 * dist/ content. Creates a temporary `src/ui` directory to simulate
 * a post-visualizer build (deployPayload resolves distDir from
 * import.meta.url → `src/` when running under vitest).
 *
 * Validates: Requirements 5.1, 5.2, 5.3, N19
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// Resolve symlinks so paths are consistent with realpathSync inside the module.
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-deploy-ui-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Mock child_process so no external commands run (deployPayload doesn't
// use child_process, but the installer module imports it at the top level).
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => Buffer.from('')),
  execFileSync: vi.fn(() => Buffer.from('')),
  spawn: vi.fn(() => ({
    pid: 99999,
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

/**
 * Track which source→destination pairs cpSync was called with.
 */
const cpSyncCalls: Array<{ src: string; dst: string }> = [];

vi.mock('node:fs', async (importOriginal) => {
  const original = (await importOriginal()) as typeof import('node:fs'); // eslint-disable-line @typescript-eslint/consistent-type-imports
  return {
    ...original,
    cpSync: vi.fn((src: string, dst: string) => {
      cpSyncCalls.push({ src, dst });
      original.mkdirSync(dst, { recursive: true });
    }),
  };
});

// Import after mocks so vitest intercepts the modules.
const { deployPayload, INSTALL_DIR } = await import(
  '../../src/installer/index.js'
);

// Suppress stdout/stderr noise
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

// ── Setup / Teardown ────────────────────────────────────────────────────

afterEach(() => {
  cpSyncCalls.length = 0;
  // Clean up lib/ between tests so each test starts fresh
  const libDir = join(INSTALL_DIR, 'lib');
  if (existsSync(libDir)) {
    rmSync(libDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────

/** Extract the last path segment (subdirectory name) from each cpSync destination. */
function copiedSubdirNames(): string[] {
  return cpSyncCalls.map((c) => c.dst.replace(/\/$/, '').split('/').pop()!);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('deployPayload — ui/ subdirectory handling', () => {
  it('copies ui/ to lib/ui/ when dist/ui/ exists alongside other subdirectories', () => {
    // Under vitest, the installer module is at src/installer/index.ts,
    // so deployPayload computes distDir = <repo>/src. The real repo has
    // src/shim, src/collector, src/installer, src/types but NOT src/ui.
    // Create a temporary src/ui directory to simulate a post-visualizer build.
    const fakeUiSrc = join(process.cwd(), 'src', 'ui');
    mkdirSync(fakeUiSrc, { recursive: true });

    try {
      deployPayload();

      const copied = copiedSubdirNames();

      // All five subdirectories should have been copied
      for (const subdir of ['shim', 'collector', 'installer', 'types', 'ui']) {
        expect(copied, `${subdir} should have been copied`).toContain(subdir);
      }

      // lib/ui/ should exist as a destination directory
      expect(
        existsSync(join(INSTALL_DIR, 'lib', 'ui')),
        'lib/ui/ should exist after deploy',
      ).toBe(true);
    } finally {
      rmSync(fakeUiSrc, { recursive: true, force: true });
    }
  });

  it('skips ui/ without error when dist/ui/ does not exist', () => {
    // src/ui does not exist in the real repo — this simulates a
    // pre-visualizer build where dist/ui/ was never produced.
    expect(() => deployPayload()).not.toThrow();

    const copied = copiedSubdirNames();

    // The four original subdirectories should still be copied
    for (const subdir of ['shim', 'collector', 'installer', 'types']) {
      expect(copied, `${subdir} should have been copied`).toContain(subdir);
    }

    // ui/ should NOT have been copied
    expect(copied, 'ui should NOT have been copied').not.toContain('ui');
  });

  it('creates lib/ directory structure even when ui/ is absent', () => {
    deployPayload();

    expect(existsSync(join(INSTALL_DIR, 'lib'))).toBe(true);
    for (const subdir of ['shim', 'collector', 'installer', 'types']) {
      expect(
        existsSync(join(INSTALL_DIR, 'lib', subdir)),
        `lib/${subdir} should exist`,
      ).toBe(true);
    }
  });
});
