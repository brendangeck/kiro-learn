/**
 * Unit tests for `writeKiroLearnAgent` in `src/installer/index.ts`.
 *
 * These tests use a real `os.tmpdir()` directory for `targetDir` and only
 * mock the child-process spawn (`execFileSync` — chosen in Task 4.1 for
 * shell-injection safety; see design § Security). All filesystem
 * operations — `unlinkSync`, `readFileSync`, `writeFileSync`, `existsSync`
 * — exercise the real fs layer so the five-step per-scope sequence
 * (delete → seed → read → validate → write/merge-or-fallback) is
 * observable end-to-end.
 *
 * The `execFileSync` mock simulates `kiro-cli agent create --from
 * kiro_default --directory <targetDir> kiro-learn` by extracting
 * `targetDir` from the argv array and writing a test-controlled seed
 * payload to `<targetDir>/kiro-learn.json`. Failure branches throw errors
 * shaped like what `execFileSync` actually produces (spawn ENOENT has no
 * `status`; non-zero exit has a numeric `status`; missing-file returns
 * normally but writes nothing).
 *
 * `process.stderr.write` is spied with a chunk-capturing implementation so
 * the Fallback_Warning lines can be asserted on.
 *
 * Validates: Requirements 2.1, 2.2, 2.3, 2.4, 5.1, 5.2, 6.1, 6.2, 6.3,
 *            6.4, 6.5, 11.1, 11.2, 11.3, 11.4, 11.5
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

// ── Mocks ───────────────────────────────────────────────────────────────

// Hoisted mock reference so the factory closure can bind to the same
// vi.fn() the tests configure per-test. vi.hoisted runs before vi.mock
// factory evaluation, which runs before the dynamic import below.
const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

// Mock `node:child_process` — only `execFileSync` matters here; the other
// exports exist so the installer module can load without pulling real
// implementations into these tests.
vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Import after mocks so vitest intercepts the modules.
const { writeKiroLearnAgent, KIRO_LEARN_DESCRIPTION, KIRO_LEARN_TRIGGERS } =
  await import('../../src/installer/index.js');

// ── Tmp dir lifecycle ───────────────────────────────────────────────────

// One shared parent tmp dir for the whole file; each test gets a fresh
// child dir beneath it so writes never bleed across tests.
const parentTmp: string = mkdtempSync(join(tmpdir(), 'kiro-learn-wkla-'));
let targetDir: string;
let targetFile: string;

// Captured stderr chunks — populated by the spy, reset per test.
let stderrChunks: string[];
// Typed loosely: `process.stderr.write` has overloaded signatures that
// make `ReturnType<typeof vi.spyOn<...>>` awkward to express. The concrete
// type isn't needed for these tests — only `.mockRestore()` and the
// spy-install side effect matter.
let stderrSpy: { mockRestore: () => void };

afterAll(() => {
  rmSync(parentTmp, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh per-test tmp dir so the merged/fallback file written by one
  // test cannot influence the next.
  targetDir = mkdtempSync(join(parentTmp, 'scope-'));
  targetFile = join(targetDir, 'kiro-learn.json');

  execFileSyncMock.mockReset();

  stderrChunks = [];
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(targetDir, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Configure the `execFileSync` mock to simulate `kiro-cli` writing the
 * given seed JSON string to `<targetDir>/kiro-learn.json`. The target dir
 * is extracted from the argv array (`--directory` flag) so the mock works
 * regardless of which tmp path the current test chose.
 */
function mockSpawnWrites(seedJson: string): void {
  execFileSyncMock.mockImplementation(
    (_cmd: string, args: readonly string[]) => {
      const dirIdx = args.indexOf('--directory');
      // Guard: if `--directory` is somehow missing, the test is broken —
      // throw so the failure surfaces in the right place.
      if (dirIdx === -1 || dirIdx === args.length - 1) {
        throw new Error('mockSpawnWrites: --directory not found in argv');
      }
      const dir = args[dirIdx + 1]!;
      writeFileSync(join(dir, 'kiro-learn.json'), seedJson);
      return Buffer.from('');
    },
  );
}

/**
 * Configure the `execFileSync` mock to throw with no `status` — simulates
 * OS-level spawn failure (e.g. `kiro-cli` not on PATH, ENOENT).
 */
function mockSpawnFailed(stderr: string = 'ENOENT: kiro-cli'): void {
  execFileSyncMock.mockImplementation(() => {
    throw Object.assign(new Error('spawn kiro-cli ENOENT'), {
      code: 'ENOENT',
      stderr,
    });
  });
}

/**
 * Configure the `execFileSync` mock to throw with a numeric `status` —
 * simulates `kiro-cli` running but exiting non-zero.
 */
function mockNonZeroExit(status: number, stderr: string = 'error: bad flag'): void {
  execFileSyncMock.mockImplementation(() => {
    throw Object.assign(new Error('Command failed'), {
      status,
      stderr,
    });
  });
}

/**
 * Configure the `execFileSync` mock to return normally but write no file
 * — simulates the defensive `missing-file` branch.
 */
function mockMissingFile(): void {
  execFileSyncMock.mockReturnValue(Buffer.from(''));
}

/**
 * Assert the stderr capture contains exactly one Fallback_Warning line
 * that starts with `[kiro-learn] warning:` and contains the given cause
 * substring.
 */
function expectSingleFallbackWarning(cause: string): void {
  expect(stderrChunks).toHaveLength(1);
  const line = stderrChunks[0]!;
  expect(line.startsWith('[kiro-learn] warning:')).toBe(true);
  expect(line).toContain(cause);
}

/**
 * Assert the file at `targetFile` contains the Fallback_Config shape:
 * top-level keys exactly `['name', 'description', 'hooks']`; hook triggers
 * exactly the four OWNED_TRIGGERS; each trigger deep-equals the
 * corresponding `KIRO_LEARN_TRIGGERS` entry; description equals
 * `KIRO_LEARN_DESCRIPTION`. Does not assert the full byte string — that
 * is Task 5.3's property test (P5).
 */
function expectFallbackShape(): void {
  const contents = readFileSync(targetFile, 'utf8');
  const parsed = JSON.parse(contents) as {
    name: string;
    description: string;
    hooks: Record<string, unknown>;
  };

  expect(Object.keys(parsed)).toEqual(['name', 'description', 'hooks']);
  expect(parsed.name).toBe('kiro-learn');
  expect(parsed.description).toBe(KIRO_LEARN_DESCRIPTION);

  expect(Object.keys(parsed.hooks)).toEqual([
    'agentSpawn',
    'userPromptSubmit',
    'postToolUse',
    'stop',
  ]);
  expect(parsed.hooks['agentSpawn']).toEqual(KIRO_LEARN_TRIGGERS.agentSpawn);
  expect(parsed.hooks['userPromptSubmit']).toEqual(
    KIRO_LEARN_TRIGGERS.userPromptSubmit,
  );
  expect(parsed.hooks['postToolUse']).toEqual(KIRO_LEARN_TRIGGERS.postToolUse);
  expect(parsed.hooks['stop']).toEqual(KIRO_LEARN_TRIGGERS.stop);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('writeKiroLearnAgent', () => {
  describe('happy path', () => {
    it('merges kiro-learn fields onto the seed and preserves all non-owned fields', () => {
      /**
       * Validates: Requirements 2.2, 3.4, 4.1, 4.2, 4.3, 4.4, 4.7, 5.1,
       *            5.2
       *
       * Seed carries `tools`, `prompt`, `mcpServers`, and a non-owned
       * `hooks.preToolUse`. After the call:
       *  - name → 'kiro-learn', description → KIRO_LEARN_DESCRIPTION
       *  - prompt, tools, mcpServers preserved verbatim
       *  - hooks.preToolUse preserved verbatim
       *  - hooks.{agentSpawn,userPromptSubmit,postToolUse,stop} →
       *    KIRO_LEARN_TRIGGERS entries
       *  - no stderr warning emitted on success
       */
      const mockSeed = {
        name: 'kiro_default',
        description: 'Seed description',
        prompt: 'You are the default agent.',
        tools: ['fs_read', 'fs_write'],
        mcpServers: { example: { command: 'example-mcp' } },
        hooks: { preToolUse: [{ matcher: '*', command: 'user-guard' }] },
      };
      mockSpawnWrites(JSON.stringify(mockSeed, null, 2));

      writeKiroLearnAgent(targetDir);

      const merged = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<
        string,
        unknown
      >;

      // Owned top-level fields overwritten.
      expect(merged['name']).toBe('kiro-learn');
      expect(merged['description']).toBe(KIRO_LEARN_DESCRIPTION);

      // Non-owned top-level fields preserved verbatim.
      expect(merged['prompt']).toBe('You are the default agent.');
      expect(merged['tools']).toEqual(['fs_read', 'fs_write']);
      expect(merged['mcpServers']).toEqual({
        example: { command: 'example-mcp' },
      });

      // Non-owned hook trigger preserved verbatim.
      const mergedHooks = merged['hooks'] as Record<string, unknown>;
      expect(mergedHooks['preToolUse']).toEqual([
        { matcher: '*', command: 'user-guard' },
      ]);

      // Owned triggers populated from KIRO_LEARN_TRIGGERS.
      expect(mergedHooks['agentSpawn']).toEqual(KIRO_LEARN_TRIGGERS.agentSpawn);
      expect(mergedHooks['userPromptSubmit']).toEqual(
        KIRO_LEARN_TRIGGERS.userPromptSubmit,
      );
      expect(mergedHooks['postToolUse']).toEqual(
        KIRO_LEARN_TRIGGERS.postToolUse,
      );
      expect(mergedHooks['stop']).toEqual(KIRO_LEARN_TRIGGERS.stop);

      // No warning on the success path.
      expect(stderrChunks).toEqual([]);
    });

    it('deletes any pre-existing kiro-learn.json before seeding (pre-seed delete)', () => {
      /**
       * Validates: Requirement 2.1
       *
       * Seed a pre-existing `<targetDir>/kiro-learn.json` with bogus
       * content, drive the happy path, and assert the bogus bytes are
       * gone — the unlink step must have run, otherwise `kiro-cli` would
       * have refused to write (or our mock would, via `writeFileSync`'s
       * implicit truncation, but semantically this proves (a) happened).
       */
      const bogus = '{"bogus":"legacy"}';
      writeFileSync(targetFile, bogus);
      expect(readFileSync(targetFile, 'utf8')).toBe(bogus);

      const mockSeed = { name: 'kiro_default', tools: ['fs_read'] };
      mockSpawnWrites(JSON.stringify(mockSeed, null, 2));

      writeKiroLearnAgent(targetDir);

      const merged = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<
        string,
        unknown
      >;

      // The bogus legacy content is gone — neither the sentinel key nor
      // its value survives in the merged output.
      expect(merged['bogus']).toBeUndefined();
      expect(JSON.stringify(merged)).not.toContain('legacy');

      // Merge still produced the expected owned overwrites.
      expect(merged['name']).toBe('kiro-learn');
      expect(merged['tools']).toEqual(['fs_read']);
    });

    it('does not throw when no pre-existing file is present (ENOENT tolerance)', () => {
      /**
       * Validates: Requirement 2.2 — the ENOENT branch of the pre-seed
       * unlink must be swallowed. Here we drive the spawn-failed branch
       * so the whole function exercises: (a) unlink with no file (ENOENT
       * swallowed) → (b) spawn fails → (e) fallback written. The
       * assertion is that the call returned normally and the fallback
       * was written.
       */
      expect(existsSync(targetFile)).toBe(false);

      mockSpawnFailed();

      expect(() => writeKiroLearnAgent(targetDir)).not.toThrow();

      expect(existsSync(targetFile)).toBe(true);
      expectFallbackShape();
    });
  });

  describe('fallback branches', () => {
    it('writes fallback and emits warning on spawn-failed (kiro-cli unavailable)', () => {
      /**
       * Validates: Requirements 6.1, 6.2, 6.3, 6.5, 11.1, 11.2, 11.5
       */
      mockSpawnFailed();

      writeKiroLearnAgent(targetDir);

      expectFallbackShape();
      expectSingleFallbackWarning('kiro-cli unavailable');
    });

    it('writes fallback and emits warning on non-zero-exit (seed command failed)', () => {
      /**
       * Validates: Requirements 6.1, 6.2, 6.3, 6.5, 11.1, 11.2, 11.5
       */
      mockNonZeroExit(1);

      writeKiroLearnAgent(targetDir);

      expectFallbackShape();
      expectSingleFallbackWarning('seed command failed');
    });

    it('writes fallback and emits warning on missing-file (spawn zero-exit but no file written)', () => {
      /**
       * Validates: Requirements 6.1, 6.2, 6.3, 6.5, 11.1, 11.2, 11.5
       *
       * Note: the mock returns normally without writing. The function's
       * defensive existsSync check catches this and routes to fallback.
       */
      mockMissingFile();

      writeKiroLearnAgent(targetDir);

      expectFallbackShape();
      expectSingleFallbackWarning('seed command failed');
    });

    it('writes fallback and emits warning on invalid-payload (spawn wrote "[1, 2, 3]")', () => {
      /**
       * Validates: Requirements 3.2, 3.3, 6.1, 6.2, 6.3, 6.5, 11.1,
       *            11.2, 11.5
       *
       * The seed file parses as valid JSON but is an array, not an
       * object — validateSeedPayload returns null and the function
       * routes to fallback with cause 'seed command failed'.
       */
      mockSpawnWrites('[1, 2, 3]');

      writeKiroLearnAgent(targetDir);

      expectFallbackShape();
      expectSingleFallbackWarning('seed command failed');
    });
  });

  describe('scope in warning', () => {
    it("uses 'project' scope label when targetDir is not ~/.kiro/agents", () => {
      /**
       * Validates: Requirement 11.5 — the `<scope>` segment of the
       * Fallback_Warning. Any tmp directory below os.tmpdir() will not
       * equal `path.join(homedir(), '.kiro', 'agents')`, so the warning
       * must say `for project scope`.
       *
       * We don't assert the global branch here because the target dir
       * is a mkdtemp path; that's covered by the integration tests in
       * Task 9 which run against a real tmp HOME.
       */
      mockSpawnFailed();

      writeKiroLearnAgent(targetDir);

      expect(stderrChunks).toHaveLength(1);
      expect(stderrChunks[0]).toContain('for project scope');
    });
  });

  describe('return value and idempotency', () => {
    it('returns void on every branch and always leaves a valid JSON file at targetFile', () => {
      /**
       * Validates: Requirement 6.5 — seed failure is not an install
       * failure. Every branch leaves `<targetDir>/kiro-learn.json`
       * present and parseable as JSON.
       */
      // Run four scenarios in sequence against fresh tmp dirs so each
      // branch is exercised independently.
      const scenarios: Array<{
        readonly name: string;
        readonly setup: () => void;
      }> = [
        {
          name: 'happy path',
          setup: () => mockSpawnWrites(JSON.stringify({ name: 'kiro_default' })),
        },
        { name: 'spawn-failed', setup: () => mockSpawnFailed() },
        { name: 'non-zero-exit', setup: () => mockNonZeroExit(1) },
        { name: 'missing-file', setup: () => mockMissingFile() },
        { name: 'invalid-payload', setup: () => mockSpawnWrites('[1, 2, 3]') },
      ];

      for (const scenario of scenarios) {
        const perScopeDir = mkdtempSync(join(parentTmp, 'ret-'));
        const perScopeFile = join(perScopeDir, 'kiro-learn.json');

        execFileSyncMock.mockReset();
        scenario.setup();

        const result: void = writeKiroLearnAgent(perScopeDir);

        expect(result).toBeUndefined();
        expect(existsSync(perScopeFile)).toBe(true);
        expect(() =>
          JSON.parse(readFileSync(perScopeFile, 'utf8')),
        ).not.toThrow();

        rmSync(perScopeDir, { recursive: true, force: true });
      }
    });
  });
});
