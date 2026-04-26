/**
 * Unit tests for `writeAgentConfigs` scope matrix.
 *
 * Exercises the per-scope fan-out that `writeAgentConfigs` performs
 * after Task 7.1 wired `writeKiroLearnAgent` into the orchestrator:
 *
 *  - Global scope is always written (Requirement 9.1).
 *  - Project scope is written iff `scope.projectRoot !== undefined`
 *    (Requirements 9.2, 9.3).
 *  - `kiro-learn-compressor.json` is written once globally per
 *    invocation and never at project scope (Requirements 8.3, 9.4).
 *
 * `node:child_process` is mocked so `runSeedCommand` takes the
 * spawn-failed branch, routing every `writeKiroLearnAgent` call into
 * the Fallback_Config path. That keeps these tests focused on file
 * presence/absence — the scope matrix — rather than on merged content,
 * which is the subject of
 * `installer-write-kiro-learn-agent.test.ts` (unit) and
 * `installer-init-integration.test.ts` (integration-style).
 *
 * Validates: Requirements 8.3, 9.1, 9.2, 9.3, 9.4
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
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Tmp HOME setup ──────────────────────────────────────────────────────

// Resolve symlinks so paths match realpathSync inside the module (macOS
// wraps /tmp behind /private/tmp).
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-wac-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Force the fallback branch of `writeKiroLearnAgent` — `execFileSync`
// throws with no `status` so `runSeedCommand` returns
// `{ ok: false, reason: 'spawn-failed', ... }`. These tests assert which
// files land where, not what their contents are, so fallback is fine.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => {
    throw Object.assign(new Error('spawn kiro-cli ENOENT'), { code: 'ENOENT' });
  }),
  execSync: vi.fn(() => Buffer.from('')),
  spawn: vi.fn(() => ({
    pid: 99999,
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

// Import after mocks so vitest intercepts them.
const { writeAgentConfigs, INSTALL_DIR } = await import(
  '../../src/installer/index.js'
);

// ── Lifecycle ───────────────────────────────────────────────────────────

// Track per-test project dirs so we can clean them up without racing the
// global tmpHome cleanup.
let projectDir: string | undefined;

beforeEach(() => {
  // Suppress the Fallback_Warning lines so they don't pollute test output.
  // Installed per-test because vitest's `restoreMocks: true` clears spies
  // between tests. Warning content is asserted in
  // `installer-write-kiro-learn-agent.test.ts` — here we only care about
  // file placement.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  // `createLayout` normally creates these directories; unit tests call
  // `writeAgentConfigs` directly, so we have to create them by hand.
  mkdirSync(join(tmpHome, '.kiro', 'agents'), { recursive: true });

  // INSTALL_DIR/bin is referenced via the shim path embedded in
  // `KIRO_LEARN_TRIGGERS` — not required to exist on disk for the
  // fallback write, but we create it for parity with the real install
  // layout and to avoid surprises if `writeAgentConfigs` ever grows a
  // shim-presence assertion.
  mkdirSync(join(INSTALL_DIR, 'bin'), { recursive: true });
});

afterEach(() => {
  // Clean up per-test artefacts: the global agents tree under tmpHome,
  // INSTALL_DIR, and any project dir the test created.
  rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });
  rmSync(INSTALL_DIR, { recursive: true, force: true });
  if (projectDir !== undefined) {
    rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  }
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('writeAgentConfigs scope matrix', () => {
  describe('global-only scope (scope.projectRoot === undefined)', () => {
    it('writes only the global kiro-learn.json — no project file at any path', () => {
      /**
       * Validates: Requirements 9.1, 9.4
       *
       * With no project root, `writeAgentConfigs` must write the global
       * `kiro-learn.json` and the global `kiro-learn-compressor.json`,
       * and must NOT touch any project-scoped path. To prove the
       * negative, we construct a sibling tmp "project" directory BEFORE
       * the call, create its `.kiro/agents/` dir, and then assert
       * afterwards that no kiro-learn files were written there.
       */
      // Sibling tmp dir acting as a would-be project root. Created under
      // the tmp HOME so our `afterEach` cleanup doesn't need to hunt
      // anywhere special.
      projectDir = mkdtempSync(join(tmpHome, 'not-a-project-'));
      mkdirSync(join(projectDir, '.kiro', 'agents'), { recursive: true });

      writeAgentConfigs({
        global: true,
        projectRoot: undefined,
        detectedMarker: undefined,
      });

      // Global kiro-learn.json exists.
      expect(
        existsSync(join(tmpHome, '.kiro', 'agents', 'kiro-learn.json')),
      ).toBe(true);

      // Global compressor exists — written once per invocation,
      // globally only (Requirement 9.4).
      expect(
        existsSync(
          join(tmpHome, '.kiro', 'agents', 'kiro-learn-compressor.json'),
        ),
      ).toBe(true);

      // No project-scoped kiro-learn.json was written — the fan-out did
      // not touch the sibling directory.
      expect(
        existsSync(join(projectDir, '.kiro', 'agents', 'kiro-learn.json')),
      ).toBe(false);

      // And certainly no project-scoped compressor (Requirement 8.3).
      expect(
        existsSync(
          join(projectDir, '.kiro', 'agents', 'kiro-learn-compressor.json'),
        ),
      ).toBe(false);
    });
  });

  describe('global + project scope (scope.projectRoot defined)', () => {
    it('writes both kiro-learn.json files and only the global compressor', () => {
      /**
       * Validates: Requirements 8.3, 9.2, 9.3, 9.4
       *
       * With a project root, both the global and project-scoped
       * `kiro-learn.json` must be written (each through its own
       * seed-then-merge-or-fallback cycle), the global compressor must
       * still be written exactly once, and the project scope must NOT
       * receive a compressor file.
       */
      projectDir = mkdtempSync(join(tmpHome, 'project-'));
      // `createLayout` would normally mkdir this — do it ourselves for
      // the unit test (see the equivalent in installer-wrappers.test.ts).
      mkdirSync(join(projectDir, '.kiro', 'agents'), { recursive: true });

      writeAgentConfigs({
        global: true,
        projectRoot: projectDir,
        detectedMarker: '.git',
      });

      // Both kiro-learn.json files exist — each had its own
      // merge-or-fallback outcome (both fallback here per the mock).
      expect(
        existsSync(join(tmpHome, '.kiro', 'agents', 'kiro-learn.json')),
      ).toBe(true);
      expect(
        existsSync(join(projectDir, '.kiro', 'agents', 'kiro-learn.json')),
      ).toBe(true);

      // Compressor written globally.
      expect(
        existsSync(
          join(tmpHome, '.kiro', 'agents', 'kiro-learn-compressor.json'),
        ),
      ).toBe(true);

      // Compressor NOT written at the project scope (Requirement 8.3).
      expect(
        existsSync(
          join(projectDir, '.kiro', 'agents', 'kiro-learn-compressor.json'),
        ),
      ).toBe(false);
    });
  });
});
