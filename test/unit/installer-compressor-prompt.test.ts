/**
 * Unit tests for the updated XML-based compressor agent prompt.
 *
 * Verifies the prompt written by writeAgentConfigs() instructs the model
 * to accept <tool_observation> XML input and respond with <memory_record>
 * XML output, and does not reference the old JSON output format.
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5
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
  mkdtempSync(join(tmpdir(), 'kiro-learn-compressor-prompt-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Mock `node:child_process` so `writeAgentConfigs` → `writeKiroLearnAgent`
// → `runSeedCommand` does not spawn real `kiro-cli` during unit tests.
// `execFileSync` throws with no `status` property, which forces the
// `spawn-failed` branch and routes to the Fallback_Config writer.
// This test only cares about the compressor agent prompt, not kiro-learn agent.
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

// Import after mocks so vitest intercepts the modules.
const { writeAgentConfigs, INSTALL_DIR } = await import(
  '../../src/installer/index.js'
);

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Read the compressor config prompt from the temp agents directory. */
function readCompressorPrompt(): string {
  const configPath = join(tmpHome, '.kiro', 'agents', 'kiro-learn-compressor.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { prompt: string };
  return config.prompt;
}

describe('compressor agent XML prompt', () => {
  beforeEach(() => {
    mkdirSync(join(INSTALL_DIR, 'bin'), { recursive: true });
    mkdirSync(join(tmpHome, '.kiro', 'agents'), { recursive: true });
    // Suppress the `[kiro-learn] warning:` line the fallback writer emits.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writeAgentConfigs({
      global: true,
      projectRoot: undefined,
      detectedMarker: undefined,
    });
  });

  afterEach(() => {
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });
  });

  it('instructs the model to accept <tool_observation> XML input', () => {
    /**
     * Validates: Requirement 7.1
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toContain('<tool_observation>');
  });

  it('instructs the model to respond with <memory_record> XML output', () => {
    /**
     * Validates: Requirement 7.1
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toContain('<memory_record');
    expect(prompt).toContain('</memory_record>');
  });

  it('specifies all allowed type attribute values', () => {
    /**
     * Validates: Requirement 7.2
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toContain('tool_use');
    expect(prompt).toContain('decision');
    expect(prompt).toContain('error');
    expect(prompt).toContain('discovery');
    expect(prompt).toContain('pattern');
  });

  it('specifies required child elements', () => {
    /**
     * Validates: Requirement 7.3
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toContain('<title>');
    expect(prompt).toContain('<summary>');
    expect(prompt).toContain('<facts>');
    expect(prompt).toContain('<fact>');
    expect(prompt).toContain('<concepts>');
    expect(prompt).toContain('<concept>');
    expect(prompt).toContain('<files>');
    expect(prompt).toContain('<file>');
  });

  it('instructs that empty responses are valid skip signals', () => {
    /**
     * Validates: Requirement 7.4
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toMatch(/empty response.*skip/i);
  });

  it('documents the <skip/> token as an alternative skip signal', () => {
    /**
     * Validates: Requirement 7.4 (and consistency with isGarbageResponse,
     * which treats `<skip>` as a non-garbage signal).
     *
     * The runtime path (invokeCompressor + isGarbageResponse) recognises
     * `<skip/>` as a valid skip signal alongside an empty body. Without
     * documenting it in the prompt, the model would never intentionally
     * emit it — the token would be dead code. This test fails if the
     * prompt stops mentioning `<skip`.
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toContain('<skip');
  });

  it('instructs that non-XML text is discarded', () => {
    /**
     * Validates: Requirement 7.5
     */
    const prompt = readCompressorPrompt();
    expect(prompt).toContain('Non-XML text is discarded');
  });

  it('does not reference JSON output format', () => {
    /**
     * Validates: Requirements 7.1, 7.5
     *
     * The old prompt instructed the model to output JSON. The new prompt
     * must not contain any JSON output instructions.
     */
    const prompt = readCompressorPrompt();
    expect(prompt).not.toMatch(/JSON object/i);
    expect(prompt).not.toMatch(/Required JSON fields/i);
    expect(prompt).not.toMatch(/markdown fencing/i);
    expect(prompt).not.toContain('Just the JSON');
  });
});
