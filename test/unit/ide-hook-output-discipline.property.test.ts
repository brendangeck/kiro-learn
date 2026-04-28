/**
 * Property test: P8 (Output Channel Discipline).
 *
 * Feature: kiro-ide-hook-shim, Property 8: Output Channel Discipline
 *
 * For any postToolUse or agentStop event, and for any error during
 * promptSubmit, stdout remains empty; all diagnostics go to stderr
 * with [kiro-learn] prefix.
 *
 * Validates: Requirements 8.4, 11.4, 11.5
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import type * as sharedModule from '../../src/shim/shared/index.js';

// ── Test-scoped state ───────────────────────────────────────────────────

let tmpHome: string;
let tmpCwd: string;

// ── Mocks ───────────────────────────────────────────────────────────────

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

let postEventShouldThrow = false;

vi.mock('../../src/shim/shared/index.js', async (importOriginal) => {
  const original = (await importOriginal()) as typeof sharedModule;
  return {
    ...original,
    postEvent: vi.fn(async () => {
      if (postEventShouldThrow) {
        throw new Error('simulated failure');
      }
      return { event_id: 'test', stored: true };
    }),
  };
});

const { main } = await import('../../src/shim/ide-hook/index.js');

// ── Setup / teardown ────────────────────────────────────────────────────

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'kiro-learn-p8-home-'));
  tmpCwd = mkdtempSync(join(tmpHome, 'project-'));
  writeFileSync(join(tmpCwd, 'package.json'), '{}');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── Stdout/stderr capture ───────────────────────────────────────────────

let stdoutChunks: string[];
let stderrChunks: string[];
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  origStdoutWrite = process.stdout.write;
  origStderrWrite = process.stderr.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  postEventShouldThrow = false;
});

// ── Helpers ─────────────────────────────────────────────────────────────

async function runShim(eventType: string, userPrompt: string): Promise<void> {
  const origArgv = process.argv;
  const origEnv = process.env['USER_PROMPT'];
  const origCwd = process.cwd;

  try {
    process.argv = ['node', 'ide-shim', eventType];
    process.env['USER_PROMPT'] = userPrompt;
    process.cwd = () => tmpCwd;

    await main();
  } finally {
    process.argv = origArgv;
    if (origEnv === undefined) {
      delete process.env['USER_PROMPT'];
    } else {
      process.env['USER_PROMPT'] = origEnv;
    }
    process.cwd = origCwd;
  }
}

// ── Property tests ──────────────────────────────────────────────────────

describe('IDE hook shim — P8 Output Channel Discipline', () => {
  it('postToolUse never writes to stdout', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 500 }),
        async (userPrompt) => {
          stdoutChunks = [];
          stderrChunks = [];

          await runShim('postToolUse', userPrompt);

          // P8: stdout must remain empty for postToolUse
          expect(stdoutChunks.join('')).toBe('');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('agentStop never writes to stdout', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 500 }),
        async (userPrompt) => {
          stdoutChunks = [];
          stderrChunks = [];

          await runShim('agentStop', userPrompt);

          // P8: stdout must remain empty for agentStop
          expect(stdoutChunks.join('')).toBe('');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('promptSubmit error writes nothing to stdout, diagnostics to stderr with prefix', async () => {
    postEventShouldThrow = true;

    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 500 }),
        async (userPrompt) => {
          stdoutChunks = [];
          stderrChunks = [];

          await runShim('promptSubmit', userPrompt);

          // P8: stdout must remain empty on error
          expect(stdoutChunks.join('')).toBe('');

          // P8: all stderr output must have [kiro-learn] prefix
          const stderrOutput = stderrChunks.join('');
          if (stderrOutput.length > 0) {
            for (const line of stderrOutput.split('\n').filter((l) => l.length > 0)) {
              expect(line).toMatch(/^\[kiro-learn\]/);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
