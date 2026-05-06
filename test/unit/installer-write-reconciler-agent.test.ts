/**
 * Unit tests for {@link writeReconcilerAgent} and the reconciler-agent
 * cleanup hook in `cmdUninstall`.
 *
 * `writeReconcilerAgent` is the third hand-authored agent helper
 * (alongside `writeCompressorAgent` and `writeCompactorAgent`) and
 * follows the same contract:
 *
 * - Writes `kiro-learn-reconciler.json` into the given agents dir.
 * - Unconditional `writeFileSync` — idempotent across re-runs.
 * - Config shape: `{ name, description, prompt, tools: [], allowedTools: [] }`.
 * - Prompt body documents the `<reconciliation_request>` grammar and the
 *   `<merge>` / `<keep_separate/>` response shapes consumed by
 *   `src/collector/ingestion/judge-xml.ts`.
 *
 * These tests also cover that `cmdUninstall` includes the new config in
 * its agent-cleanup list.
 *
 * Validates: Requirements 6.1 (reconciliation-engine spec)
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

// Resolve symlinks so paths match realpathSync inside the installer
// module (macOS wraps /tmp behind /private/tmp).
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-wra-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Stub `node:child_process` so nothing these tests do tries to spawn a
// real `kiro-cli` (the uninstall test calls `stopDaemon`, which would
// otherwise poke at process signals).
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
const { writeReconcilerAgent, cmdUninstall, INSTALL_DIR } = await import(
  '../../src/installer/index.js'
);

// Suppress console noise from installer status lines and fallback
// warnings. Tests that need to assert on stderr content re-spy in the
// `it` block.
const stdoutSpy = vi.spyOn(process.stdout, 'write');
const stderrSpy = vi.spyOn(process.stderr, 'write');

beforeEach(() => {
  stdoutSpy.mockImplementation(() => true);
  stderrSpy.mockImplementation(() => true);

  // Fresh global agents dir per test.
  const agentsDir = join(tmpHome, '.kiro', 'agents');
  rmSync(agentsDir, { recursive: true, force: true });
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });
  rmSync(INSTALL_DIR, { recursive: true, force: true });
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── Tests: writeReconcilerAgent ─────────────────────────────────────────

describe('writeReconcilerAgent', () => {
  it('creates kiro-learn-reconciler.json at the specified directory', () => {
    const agentsDir = join(tmpHome, '.kiro', 'agents');

    writeReconcilerAgent(agentsDir);

    expect(
      existsSync(join(agentsDir, 'kiro-learn-reconciler.json')),
    ).toBe(true);
  });

  it('writes config with the expected shape (name, description, tools, allowedTools)', () => {
    const agentsDir = join(tmpHome, '.kiro', 'agents');

    writeReconcilerAgent(agentsDir);

    const raw = readFileSync(
      join(agentsDir, 'kiro-learn-reconciler.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as {
      name: unknown;
      description: unknown;
      prompt: unknown;
      tools: unknown;
      allowedTools: unknown;
      model: unknown;
    };

    expect(parsed.name).toBe('kiro-learn-reconciler');
    expect(typeof parsed.description).toBe('string');
    expect(String(parsed.description).length).toBeGreaterThan(0);
    expect(typeof parsed.prompt).toBe('string');
    expect(String(parsed.prompt).length).toBeGreaterThan(0);
    expect(parsed.tools).toEqual([]);
    expect(parsed.allowedTools).toEqual([]);
    // Pinned to the cheapest Claude tier. The judge is a bounded
    // XML-in / XML-out decision with zero tools — running it on
    // `"auto"` would let kiro-cli pick a pricier model by default.
    expect(parsed.model).toBe('claude-haiku-4.5');
  });

  it('prompt body references the request and response grammar verbatim', () => {
    const agentsDir = join(tmpHome, '.kiro', 'agents');

    writeReconcilerAgent(agentsDir);

    const raw = readFileSync(
      join(agentsDir, 'kiro-learn-reconciler.json'),
      'utf8',
    );
    const { prompt } = JSON.parse(raw) as { prompt: string };

    // Request grammar.
    expect(prompt).toContain('<reconciliation_request>');
    expect(prompt).toContain('<candidate_cluster>');
    expect(prompt).toContain('<neighbor_pool>');

    // Response grammar.
    expect(prompt).toContain('<merge>');
    expect(prompt).toContain('<keep_separate/>');
    expect(prompt).toContain('<merged_record_id>');

    // XML-only contract rule must be spelled out so the judge
    // doesn't emit conversational text.
    expect(prompt.toLowerCase()).toContain('xml only');
  });

  it('is idempotent — calling twice overwrites with the same content', () => {
    const agentsDir = join(tmpHome, '.kiro', 'agents');
    const configPath = join(agentsDir, 'kiro-learn-reconciler.json');

    expect(() => writeReconcilerAgent(agentsDir)).not.toThrow();
    const firstContent = readFileSync(configPath, 'utf8');

    expect(() => writeReconcilerAgent(agentsDir)).not.toThrow();
    const secondContent = readFileSync(configPath, 'utf8');

    expect(secondContent).toBe(firstContent);
  });
});

// ── Tests: uninstall removes kiro-learn-reconciler.json ─────────────────

describe('cmdUninstall — removes kiro-learn-reconciler.json', () => {
  beforeEach(() => {
    // Build a minimal install so `cmdUninstall` short-circuits the
    // "not installed" path and actually walks the cleanup routine.
    mkdirSync(join(INSTALL_DIR, 'bin'), { recursive: true });
    mkdirSync(join(INSTALL_DIR, 'lib'), { recursive: true });
    mkdirSync(join(INSTALL_DIR, 'logs'), { recursive: true });
    writeFileSync(
      join(INSTALL_DIR, 'package.json'),
      JSON.stringify({ name: 'kiro-learn-runtime', version: '0.0.0' }),
    );

    // Seed the three hand-authored agent configs so we can confirm
    // every one is removed on uninstall.
    const agentsDir = join(tmpHome, '.kiro', 'agents');
    writeFileSync(
      join(agentsDir, 'kiro-learn.json'),
      '{"name":"kiro-learn"}',
    );
    writeFileSync(
      join(agentsDir, 'kiro-learn-compressor.json'),
      '{"name":"kiro-learn-compressor"}',
    );
    writeFileSync(
      join(agentsDir, 'kiro-learn-compactor.json'),
      '{"name":"kiro-learn-compactor"}',
    );
    writeFileSync(
      join(agentsDir, 'kiro-learn-reconciler.json'),
      '{"name":"kiro-learn-reconciler"}',
    );

    // Point cwd at tmpHome so scope detection stays global-only.
    vi.spyOn(process, 'cwd').mockReturnValue(tmpHome);
  });

  it('removes kiro-learn-reconciler.json along with the other agent configs', () => {
    const agentsDir = join(tmpHome, '.kiro', 'agents');

    const exit = cmdUninstall({ keepData: false });

    expect(exit).toBe(0);
    expect(
      existsSync(join(agentsDir, 'kiro-learn-reconciler.json')),
    ).toBe(false);
    // Sanity: the other hand-authored configs are cleaned up too.
    expect(
      existsSync(join(agentsDir, 'kiro-learn.json')),
    ).toBe(false);
    expect(
      existsSync(join(agentsDir, 'kiro-learn-compressor.json')),
    ).toBe(false);
    expect(
      existsSync(join(agentsDir, 'kiro-learn-compactor.json')),
    ).toBe(false);
  });

  it('removes kiro-learn-reconciler.json even when keepData is true', () => {
    const agentsDir = join(tmpHome, '.kiro', 'agents');

    const exit = cmdUninstall({ keepData: true });

    expect(exit).toBe(0);
    expect(
      existsSync(join(agentsDir, 'kiro-learn-reconciler.json')),
    ).toBe(false);
  });
});
