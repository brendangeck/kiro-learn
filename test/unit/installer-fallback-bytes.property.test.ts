// Feature: default-equivalent-agent, Property 5: Fallback output matches the current bare config byte-for-byte
/**
 * Property-based test: the Fallback_Config bytes written by
 * `writeKiroLearnAgent` are byte-for-byte identical to the config the
 * pre-spec `writeAgentConfigs` produced, across every failure branch.
 *
 * Despite the "property test" label, this file is parameterised over a
 * fixed four-element set of failure reasons (`spawn-failed`,
 * `non-zero-exit`, `missing-file`, `invalid-payload`) rather than a
 * fast-check generator — the property holds universally over that finite
 * set, and there is no randomness to sample beyond it. The test still
 * carries the property label / `Validates: Requirements` footer for the
 * traceability chain.
 *
 * The "golden" fallback bytes are reconstructed in-test from
 * `KIRO_LEARN_DESCRIPTION` and the known shim path derived from
 * `INSTALL_DIR`. `KIRO_LEARN_TRIGGERS` is deliberately NOT imported —
 * importing it would make the test a tautology against the same constant
 * the implementation uses. Rebuilding the expected shape from primitives
 * means if the shim path or description ever drifts, this test fails
 * loudly and the intent of Requirement 6.2 stays honest.
 *
 * **Validates: Requirements 6.1, 6.2**
 *
 * @see .kiro/specs/default-equivalent-agent/design.md § Correctness Properties — Property 5
 * @see test/unit/installer-write-kiro-learn-agent.test.ts — same execFileSync mocking pattern
 */

import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────

// Hoisted mock reference so the `vi.mock` factory and each test share the
// same `vi.fn()` instance — `vi.hoisted` runs before the factory, which
// runs before the dynamic import below.
const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

// Mock `node:child_process` — only `execFileSync` is called by
// `runSeedCommand`; the other exports are listed so the installer module
// can load without pulling real implementations into the test.
vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Import after mocks so vitest intercepts the modules. We deliberately do
// NOT import `KIRO_LEARN_TRIGGERS` — the golden constant is rebuilt in
// this file from primitives (see module-level comment).
const { writeKiroLearnAgent, KIRO_LEARN_DESCRIPTION, INSTALL_DIR } =
  await import('../../src/installer/index.js');

// ── Golden constant ─────────────────────────────────────────────────────

/**
 * The shim path the installer bakes into every hook entry. Reconstructed
 * here from `INSTALL_DIR` rather than imported, so a drift in either
 * `INSTALL_DIR` or the `bin/shim` layout makes this test fail loudly
 * rather than silently agreeing with the implementation.
 */
const shimPath = path.join(INSTALL_DIR, 'bin', 'shim');

/**
 * The shim path wrapped in double quotes for safe inclusion in a shell
 * command — matches the existing inline construction in the pre-spec
 * `writeAgentConfigs`.
 */
const quotedShim = `"${shimPath}"`;

/**
 * The Fallback_Config object, laid out with the exact key order
 * documented in the Data Models section of the design:
 *   top level   → name, description, hooks
 *   hooks keys  → agentSpawn, userPromptSubmit, postToolUse, stop
 *
 * `JSON.stringify` serialises object literals in insertion order, so the
 * key order here is load-bearing for the byte-for-byte assertion. Each
 * hook entry is also constructed inline (not referenced from
 * `KIRO_LEARN_TRIGGERS`) so that a drift in the hook shape is caught
 * here, not silently absorbed.
 */
const goldenFallback = {
  name: 'kiro-learn',
  description: KIRO_LEARN_DESCRIPTION,
  hooks: {
    agentSpawn: [{ command: quotedShim + ' || true' }],
    userPromptSubmit: [{ command: quotedShim + ' || true' }],
    postToolUse: [{ matcher: '*', command: quotedShim + ' || true' }],
    stop: [{ command: quotedShim + ' || true' }],
  },
};

/** The exact bytes the installer should write in every failure branch. */
const goldenBytes: string = JSON.stringify(goldenFallback, null, 2) + '\n';

// ── Tmp-dir lifecycle ───────────────────────────────────────────────────

// One shared parent tmp dir for the whole file; each test gets its own
// child dir so writes never bleed across the parameterised cases.
const parentTmp: string = mkdtempSync(join(tmpdir(), 'kiro-learn-fb-'));
let targetDir: string;
let targetFile: string;

// Silenced stderr spy — the warning line is covered by Task 5.2; here we
// only need to suppress it from polluting test output.
let stderrSpy: { mockRestore: () => void };

afterAll(() => {
  rmSync(parentTmp, { recursive: true, force: true });
});

beforeEach(() => {
  targetDir = mkdtempSync(join(parentTmp, 'scope-'));
  targetFile = join(targetDir, 'kiro-learn.json');

  execFileSyncMock.mockReset();

  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(targetDir, { recursive: true, force: true });
});

// ── Failure-reason drivers ─────────────────────────────────────────────

/** The four failure reasons that exercise the fallback branch. */
type FailureReason =
  | 'spawn-failed'
  | 'non-zero-exit'
  | 'missing-file'
  | 'invalid-payload';

/**
 * Configure the `execFileSync` mock to drive the given failure branch.
 * Each driver matches the corresponding scenario in the design:
 *   spawn-failed    → thrown error with no `status` (OS-level spawn failure)
 *   non-zero-exit   → thrown error with numeric `status` (kiro-cli rejected)
 *   missing-file    → returns normally, writes no file (defensive branch)
 *   invalid-payload → returns normally, writes `[1, 2, 3]` (not an object)
 */
function driveFailure(reason: FailureReason): void {
  switch (reason) {
    case 'spawn-failed': {
      execFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('spawn kiro-cli ENOENT'), {
          code: 'ENOENT',
          stderr: '',
        });
      });
      return;
    }
    case 'non-zero-exit': {
      execFileSyncMock.mockImplementation(() => {
        throw Object.assign(new Error('Command failed'), {
          status: 1,
          stderr: 'error: bad flag',
        });
      });
      return;
    }
    case 'missing-file': {
      execFileSyncMock.mockReturnValue(Buffer.from(''));
      return;
    }
    case 'invalid-payload': {
      execFileSyncMock.mockImplementation(
        (_cmd: string, args: readonly string[]) => {
          // Extract `--directory <targetDir>` from argv so the mock writes
          // into the current test's tmp dir regardless of which one it is.
          const dirIdx = args.indexOf('--directory');
          if (dirIdx === -1 || dirIdx === args.length - 1) {
            throw new Error(
              'driveFailure(invalid-payload): --directory not in argv',
            );
          }
          const dir = args[dirIdx + 1]!;
          writeFileSync(join(dir, 'kiro-learn.json'), '[1, 2, 3]');
          return Buffer.from('');
        },
      );
      return;
    }
  }
}

// ── Property 5 ──────────────────────────────────────────────────────────

describe('Installer — property: Fallback_Config bytes are invariant across failure reasons (P5)', () => {
  const reasons: readonly FailureReason[] = [
    'spawn-failed',
    'non-zero-exit',
    'missing-file',
    'invalid-payload',
  ];

  it.each(reasons)(
    'writes the golden Fallback_Config bytes when the seed fails with reason=%s',
    (reason) => {
      driveFailure(reason);

      writeKiroLearnAgent(targetDir);

      const written = readFileSync(targetFile, 'utf8');
      expect(written).toBe(goldenBytes);
    },
  );
});
