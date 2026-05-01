// Feature: mcp-agent-config-fix, Property 1: Bug Condition — Agent config missing kiro-learn-memory MCP server
/**
 * Bug condition exploration test for the missing `kiro-learn-memory` MCP
 * server entry in agent configs written by `writeKiroLearnAgent()`.
 *
 * This test encodes the **expected** (correct) behavior: every
 * `kiro-learn.json` written by `writeKiroLearnAgent()` must contain a
 * `mcpServers` object with a `kiro-learn-memory` entry whose `command` is
 * `path.join(INSTALL_DIR, 'bin', 'mcp-server')` and whose `args` is `[]`.
 *
 * On UNFIXED code this test is expected to FAIL — failure confirms the bug
 * exists. After the fix is applied, the same test validates the fix.
 *
 * Four concrete scenarios from the design are covered:
 *   1. Seed success with no `mcpServers` in the seed
 *   2. Seed success with existing other MCP servers in the seed
 *   3. Seed failure (fallback path)
 *   4. Seed success with `mcpServers: null` in the seed
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4**
 *
 * @see .kiro/specs/mcp-agent-config-fix/design.md § Bug Condition
 * @see .kiro/specs/mcp-agent-config-fix/bugfix.md § Expected Behavior
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

const { writeKiroLearnAgent, INSTALL_DIR } = await import(
  '../../src/installer/index.js'
);

// ── Expected MCP server entry ───────────────────────────────────────────

const EXPECTED_MCP_COMMAND = path.join(INSTALL_DIR, 'bin', 'mcp-server');

// ── Tmp-dir lifecycle ───────────────────────────────────────────────────

const parentTmp: string = mkdtempSync(join(tmpdir(), 'kiro-learn-mcpbug-'));
let targetDir: string;
let targetFile: string;

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

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Configure the `execFileSync` mock to simulate `kiro-cli` writing the
 * given seed JSON string to `<targetDir>/kiro-learn.json`.
 */
function mockSpawnWrites(seedJson: string): void {
  execFileSyncMock.mockImplementation(
    (_cmd: string, args: readonly string[]) => {
      const dirIdx = args.indexOf('--directory');
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
 * Configure the `execFileSync` mock to throw — simulates seed failure
 * (kiro-cli unavailable).
 */
function mockSpawnFailed(): void {
  execFileSyncMock.mockImplementation(() => {
    throw Object.assign(new Error('spawn kiro-cli ENOENT'), {
      code: 'ENOENT',
      stderr: '',
    });
  });
}

/**
 * Read and parse the written `kiro-learn.json`, then assert the
 * `mcpServers['kiro-learn-memory']` entry is present and correct.
 */
function assertMcpServerEntry(): void {
  const contents = readFileSync(targetFile, 'utf8');
  const config = JSON.parse(contents) as Record<string, unknown>;

  // mcpServers must be a non-null, non-array object
  const mcpServers = config['mcpServers'];
  expect(mcpServers).toBeDefined();
  expect(mcpServers).not.toBeNull();
  expect(typeof mcpServers).toBe('object');
  expect(Array.isArray(mcpServers)).toBe(false);

  // kiro-learn-memory entry must exist
  const mcpObj = mcpServers as Record<string, unknown>;
  const entry = mcpObj['kiro-learn-memory'];
  expect(entry).toBeDefined();

  // command and args must match
  const entryObj = entry as Record<string, unknown>;
  expect(entryObj['command']).toBe(EXPECTED_MCP_COMMAND);
  expect(entryObj['args']).toEqual([]);
}

// ── Bug Condition Exploration Tests ─────────────────────────────────────

describe('Bug Condition — kiro-learn-memory MCP server in agent config', () => {
  it('Scenario 1: seed success with no mcpServers — config must contain kiro-learn-memory', () => {
    /**
     * Validates: Requirements 1.1, 2.1, 2.3
     *
     * Seed returns a config with tools, prompt, hooks but no mcpServers.
     * The written kiro-learn.json must contain mcpServers['kiro-learn-memory'].
     */
    const seed = {
      name: 'kiro_default',
      description: 'Default agent',
      prompt: 'You are the default agent.',
      tools: ['fs_read', 'fs_write'],
      hooks: { preToolUse: [{ matcher: '*', command: 'guard' }] },
    };
    mockSpawnWrites(JSON.stringify(seed, null, 2));

    writeKiroLearnAgent(targetDir);

    assertMcpServerEntry();
  });

  it('Scenario 2: seed success with existing other MCP servers — config must contain both', () => {
    /**
     * Validates: Requirements 1.2, 2.2, 2.3
     *
     * Seed returns a config with mcpServers containing another server.
     * The written kiro-learn.json must contain both the existing server
     * AND kiro-learn-memory.
     */
    const seed = {
      name: 'kiro_default',
      description: 'Default agent',
      tools: ['fs_read'],
      mcpServers: {
        'some-other-server': { command: '/usr/bin/other', args: ['--flag'] },
      },
      hooks: {},
    };
    mockSpawnWrites(JSON.stringify(seed, null, 2));

    writeKiroLearnAgent(targetDir);

    assertMcpServerEntry();

    // Also verify the other server is preserved
    const contents = readFileSync(targetFile, 'utf8');
    const config = JSON.parse(contents) as Record<string, unknown>;
    const mcpObj = config['mcpServers'] as Record<string, unknown>;
    expect(mcpObj['some-other-server']).toEqual({
      command: '/usr/bin/other',
      args: ['--flag'],
    });
  });

  it('Scenario 3: seed failure (fallback path) — fallback config must contain kiro-learn-memory', () => {
    /**
     * Validates: Requirements 1.4, 2.4
     *
     * Seed command fails (kiro-cli unavailable). The fallback config
     * must include mcpServers['kiro-learn-memory'].
     */
    mockSpawnFailed();

    writeKiroLearnAgent(targetDir);

    assertMcpServerEntry();
  });

  it('Scenario 4: seed success with mcpServers: null — config must contain kiro-learn-memory', () => {
    /**
     * Validates: Requirements 1.3, 2.3
     *
     * Seed returns a config where mcpServers is explicitly null.
     * The written kiro-learn.json must replace null with an object
     * containing kiro-learn-memory.
     */
    const seed = {
      name: 'kiro_default',
      description: 'Default agent',
      tools: ['fs_read'],
      mcpServers: null,
      hooks: {},
    };
    mockSpawnWrites(JSON.stringify(seed, null, 2));

    writeKiroLearnAgent(targetDir);

    assertMcpServerEntry();
  });
});
