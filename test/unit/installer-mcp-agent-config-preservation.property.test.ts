// Feature: mcp-agent-config-fix, Property 2: Preservation — Seed fields and non-mcpServers behavior unchanged
/**
 * Preservation property tests for `writeKiroLearnAgent()`.
 *
 * These tests verify that the existing (pre-fix) behavior of
 * `writeKiroLearnAgent()` is preserved after the mcpServers fix is applied.
 * They use fast-check to generate random seed configs with varying
 * combinations of fields and assert that all non-mcpServers behavior
 * remains unchanged.
 *
 * **IMPORTANT**: These tests are written against UNFIXED code and must PASS.
 * They establish the baseline behavior that the fix must not break.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**
 *
 * @see .kiro/specs/mcp-agent-config-fix/design.md § Preservation Requirements
 * @see .kiro/specs/mcp-agent-config-fix/bugfix.md § Unchanged Behavior
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import fc from 'fast-check';

// ── Mocks ───────────────────────────────────────────────────────────────

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

const {
  writeKiroLearnAgent,
  KIRO_LEARN_DESCRIPTION,
  KIRO_LEARN_TRIGGERS,
  KIRO_LEARN_PROMPT_SUFFIX,
  OWNED_TRIGGERS,
} = await import('../../src/installer/index.js');

// ── Tmp-dir lifecycle ───────────────────────────────────────────────────

const parentTmp: string = mkdtempSync(join(tmpdir(), 'kiro-learn-preserve-'));
let targetDir: string;
let targetFile: string;

let stderrChunks: string[];
let stderrSpy: { mockRestore: () => void };

afterAll(() => {
  rmSync(parentTmp, { recursive: true, force: true });
});

beforeEach(() => {
  targetDir = mkdtempSync(join(parentTmp, 'scope-'));
  targetFile = join(targetDir, 'kiro-learn.json');

  execFileSyncMock.mockReset();

  stderrChunks = [];
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
      );
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
 * Configure the `execFileSync` mock to throw — simulates seed failure.
 */
function mockSpawnFailed(): void {
  execFileSyncMock.mockImplementation(() => {
    throw Object.assign(new Error('spawn kiro-cli ENOENT'), {
      code: 'ENOENT',
      stderr: '',
    });
  });
}

// ── fast-check arbitraries ──────────────────────────────────────────────

/** Arbitrary safe string for JSON field values. */
const safeStringArb = fc.string({ minLength: 0, maxLength: 50 });

/** Arbitrary non-empty safe string for field keys. */
const safeKeyArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter(
    (s) =>
      s.length > 0 &&
      // Avoid keys that collide with owned fields
      s !== 'name' &&
      s !== 'description' &&
      s !== 'hooks' &&
      s !== 'prompt' &&
      s !== 'mcpServers',
  );

/** Arbitrary tools array (array of strings). */
const toolsArb = fc.array(fc.string({ minLength: 1, maxLength: 30 }), {
  minLength: 0,
  maxLength: 5,
});

/** Arbitrary allowedTools array (array of strings). */
const allowedToolsArb = fc.array(
  fc.string({ minLength: 1, maxLength: 30 }),
  { minLength: 0, maxLength: 5 },
);

/** Arbitrary prompt string. */
const promptArb = fc.string({ minLength: 1, maxLength: 200 });

/**
 * Arbitrary non-owned hook trigger name — any string that is NOT one of
 * the four owned triggers.
 */
const nonOwnedTriggerNameArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter(
    (s) =>
      s.length > 0 &&
      s !== 'agentSpawn' &&
      s !== 'userPromptSubmit' &&
      s !== 'postToolUse' &&
      s !== 'stop',
  );

/** Arbitrary hook entry (command + optional matcher). */
const hookEntryArb = fc.record({
  command: fc.string({ minLength: 1, maxLength: 50 }),
  matcher: fc.option(fc.string({ minLength: 1, maxLength: 20 }), {
    nil: undefined,
  }),
});

/** Arbitrary non-owned hook trigger entries. */
const nonOwnedHooksArb = fc.dictionary(
  nonOwnedTriggerNameArb,
  fc.array(hookEntryArb, { minLength: 1, maxLength: 3 }),
  { minKeys: 0, maxKeys: 3 },
);

/** Arbitrary extra fields (keys that don't collide with known fields). */
const extraFieldsArb = fc.dictionary(
  safeKeyArb,
  fc.oneof(safeStringArb, fc.integer(), fc.boolean(), fc.constant(null)),
  { minKeys: 0, maxKeys: 3 },
);

/**
 * Arbitrary MCP server entry for non-kiro-learn-memory servers.
 */
const otherMcpServerArb = fc.record({
  command: fc.string({ minLength: 1, maxLength: 50 }),
  args: fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
    minLength: 0,
    maxLength: 3,
  }),
});

/**
 * Arbitrary mcpServers object with entries other than kiro-learn-memory.
 */
const otherMcpServersArb = fc.dictionary(
  fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => s.length > 0 && s !== 'kiro-learn-memory'),
  otherMcpServerArb,
  { minKeys: 1, maxKeys: 3 },
);

/**
 * Arbitrary seed config with varying combinations of fields.
 * Always includes `name` (as kiro_default would).
 */
const seedConfigArb = fc
  .record({
    tools: fc.option(toolsArb, { nil: undefined }),
    prompt: fc.option(promptArb, { nil: undefined }),
    allowedTools: fc.option(allowedToolsArb, { nil: undefined }),
    nonOwnedHooks: nonOwnedHooksArb,
    extraFields: extraFieldsArb,
  })
  .map(({ tools, prompt, allowedTools, nonOwnedHooks, extraFields }) => {
    const seed: Record<string, unknown> = {
      name: 'kiro_default',
      description: 'Default agent',
      ...extraFields,
    };
    if (tools !== undefined) seed['tools'] = tools;
    if (prompt !== undefined) seed['prompt'] = prompt;
    if (allowedTools !== undefined) seed['allowedTools'] = allowedTools;

    // Build hooks with non-owned triggers
    if (Object.keys(nonOwnedHooks).length > 0) {
      seed['hooks'] = { ...nonOwnedHooks };
    }

    return seed;
  });

// ── Property Tests ──────────────────────────────────────────────────────

describe('Preservation — seed fields and non-mcpServers behavior unchanged', () => {
  it('merged.name is always "kiro-learn"', () => {
    /**
     * **Validates: Requirements 3.2**
     *
     * For any seed config, the output name is always overwritten to 'kiro-learn'.
     */
    fc.assert(
      fc.property(seedConfigArb, (seed) => {
        mockSpawnWrites(JSON.stringify(seed, null, 2));
        writeKiroLearnAgent(targetDir);

        const config = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<
          string,
          unknown
        >;
        expect(config['name']).toBe('kiro-learn');
      }),
      { numRuns: 50 },
    );
  });

  it('merged.description is always KIRO_LEARN_DESCRIPTION', () => {
    /**
     * **Validates: Requirements 3.2**
     *
     * For any seed config, the output description is always overwritten
     * to KIRO_LEARN_DESCRIPTION.
     */
    fc.assert(
      fc.property(seedConfigArb, (seed) => {
        mockSpawnWrites(JSON.stringify(seed, null, 2));
        writeKiroLearnAgent(targetDir);

        const config = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<
          string,
          unknown
        >;
        expect(config['description']).toBe(KIRO_LEARN_DESCRIPTION);
      }),
      { numRuns: 50 },
    );
  });

  it('the four owned hook triggers match KIRO_LEARN_TRIGGERS', () => {
    /**
     * **Validates: Requirements 3.2**
     *
     * For any seed config, the four owned hook triggers are always
     * overwritten to match KIRO_LEARN_TRIGGERS exactly.
     */
    fc.assert(
      fc.property(seedConfigArb, (seed) => {
        mockSpawnWrites(JSON.stringify(seed, null, 2));
        writeKiroLearnAgent(targetDir);

        const config = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<
          string,
          unknown
        >;
        const hooks = config['hooks'] as Record<string, unknown>;
        expect(hooks).toBeDefined();

        for (const trigger of OWNED_TRIGGERS) {
          expect(hooks[trigger]).toEqual(KIRO_LEARN_TRIGGERS[trigger]);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('non-owned seed fields (tools, allowedTools, extra keys) are preserved unchanged', () => {
    /**
     * **Validates: Requirements 3.1**
     *
     * For any seed config with tools, allowedTools, and arbitrary extra
     * fields, those fields are preserved unchanged in the output.
     */
    fc.assert(
      fc.property(seedConfigArb, (seed) => {
        mockSpawnWrites(JSON.stringify(seed, null, 2));
        writeKiroLearnAgent(targetDir);

        const config = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<
          string,
          unknown
        >;

        // tools preserved
        if (seed['tools'] !== undefined) {
          expect(config['tools']).toEqual(seed['tools']);
        }

        // allowedTools preserved
        if (seed['allowedTools'] !== undefined) {
          expect(config['allowedTools']).toEqual(seed['allowedTools']);
        }

        // Extra fields preserved (keys that aren't name, description,
        // hooks, prompt, mcpServers, tools, allowedTools)
        const ownedKeys = new Set([
          'name',
          'description',
          'hooks',
          'prompt',
          'mcpServers',
          'tools',
          'allowedTools',
        ]);
        for (const key of Object.keys(seed)) {
          if (!ownedKeys.has(key)) {
            expect(config[key]).toEqual(seed[key]);
          }
        }
      }),
      { numRuns: 50 },
    );
  });

  it('non-owned hook triggers (e.g. preToolUse) from the seed are preserved unchanged', () => {
    /**
     * **Validates: Requirements 3.1, 3.2**
     *
     * For any seed config with non-owned hook triggers, those triggers
     * are preserved unchanged in the output.
     */
    const seedWithNonOwnedHooksArb = fc
      .record({
        nonOwnedHooks: fc.dictionary(
          nonOwnedTriggerNameArb,
          fc.array(hookEntryArb, { minLength: 1, maxLength: 3 }),
          { minKeys: 1, maxKeys: 3 },
        ),
      })
      .map(({ nonOwnedHooks }) => ({
        name: 'kiro_default',
        description: 'Default agent',
        hooks: { ...nonOwnedHooks },
      }));

    fc.assert(
      fc.property(seedWithNonOwnedHooksArb, (seed) => {
        mockSpawnWrites(JSON.stringify(seed, null, 2));
        writeKiroLearnAgent(targetDir);

        const config = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<
          string,
          unknown
        >;
        const hooks = config['hooks'] as Record<string, unknown>;
        const seedHooks = seed['hooks'] as Record<string, unknown>;

        // Every non-owned trigger from the seed must be preserved
        for (const key of Object.keys(seedHooks)) {
          if (
            key !== 'agentSpawn' &&
            key !== 'userPromptSubmit' &&
            key !== 'postToolUse' &&
            key !== 'stop'
          ) {
            expect(hooks[key]).toEqual(seedHooks[key]);
          }
        }
      }),
      { numRuns: 50 },
    );
  });

  it('when seed has mcpServers with other entries, those entries are preserved in the output', () => {
    /**
     * **Validates: Requirements 3.1**
     *
     * When the seed has mcpServers with entries other than
     * kiro-learn-memory, those entries are preserved via mergeHooks
     * shallow copy.
     */
    fc.assert(
      fc.property(otherMcpServersArb, (otherServers) => {
        const seed = {
          name: 'kiro_default',
          description: 'Default agent',
          tools: ['fs_read'],
          mcpServers: otherServers,
          hooks: {},
        };
        mockSpawnWrites(JSON.stringify(seed, null, 2));
        writeKiroLearnAgent(targetDir);

        const config = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<
          string,
          unknown
        >;
        const mcpServers = config['mcpServers'] as Record<string, unknown>;

        // All other MCP server entries from the seed must be preserved
        for (const [key, value] of Object.entries(otherServers)) {
          expect(mcpServers[key]).toEqual(value);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('the fallback path still emits the [kiro-learn] warning: message to stderr', () => {
    /**
     * **Validates: Requirements 3.5**
     *
     * When the seed fails, the fallback path emits a warning to stderr.
     */
    mockSpawnFailed();
    writeKiroLearnAgent(targetDir);

    expect(stderrChunks.length).toBeGreaterThanOrEqual(1);
    const warning = stderrChunks[0]!;
    expect(warning).toContain('[kiro-learn] warning:');
    expect(warning).toContain('kiro-cli unavailable');
  });

  it('the prompt suffix append logic works (seed prompt ends with KIRO_LEARN_PROMPT_SUFFIX)', () => {
    /**
     * **Validates: Requirements 3.6**
     *
     * When the seed has a string prompt, the output prompt ends with
     * KIRO_LEARN_PROMPT_SUFFIX.
     */
    fc.assert(
      fc.property(promptArb, (seedPrompt) => {
        const seed = {
          name: 'kiro_default',
          description: 'Default agent',
          prompt: seedPrompt,
          hooks: {},
        };
        mockSpawnWrites(JSON.stringify(seed, null, 2));
        writeKiroLearnAgent(targetDir);

        const config = JSON.parse(readFileSync(targetFile, 'utf8')) as Record<
          string,
          unknown
        >;
        const outputPrompt = config['prompt'] as string;
        expect(typeof outputPrompt).toBe('string');
        expect(outputPrompt.endsWith(KIRO_LEARN_PROMPT_SUFFIX)).toBe(true);
        // Also verify the original prompt is still at the beginning
        expect(outputPrompt.startsWith(seedPrompt)).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});
