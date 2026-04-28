/**
 * Property test: P5 (Exit Code Safety).
 *
 * Feature: kiro-ide-hook-shim, Property 5: Exit Code Safety
 *
 * For any input combination and any collector state (success, connection
 * refused, timeout, non-2xx), the shim exits with code 0 (main() resolves
 * without throwing).
 *
 * Validates: Requirements 11.1, 11.2
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

// postEvent mock that simulates various failure modes
let postEventBehavior: 'success' | 'null' | 'throw' | 'timeout' = 'success';

vi.mock('../../src/shim/shared/index.js', async (importOriginal) => {
  const original = (await importOriginal()) as typeof sharedModule;
  return {
    ...original,
    postEvent: vi.fn(async () => {
      switch (postEventBehavior) {
        case 'success':
          return { event_id: 'test', stored: true };
        case 'null':
          return null;
        case 'throw':
          throw new Error('connection refused');
        case 'timeout':
          throw new Error('request timed out');
        default:
          return null;
      }
    }),
  };
});

const { main } = await import('../../src/shim/ide-hook/index.js');

// ── Setup / teardown ────────────────────────────────────────────────────

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'kiro-learn-p5-home-'));
  tmpCwd = mkdtempSync(join(tmpHome, 'project-'));
  writeFileSync(join(tmpCwd, 'package.json'), '{}');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────

const ALL_EVENT_TYPES = [
  'promptSubmit',
  'postToolUse',
  'agentStop',
  'unknownType',
  undefined,
] as const;

const COLLECTOR_STATES = ['success', 'null', 'throw', 'timeout'] as const;

async function runShim(eventType: string | undefined, userPrompt: string): Promise<void> {
  const origArgv = process.argv;
  const origEnv = process.env['USER_PROMPT'];
  const origCwd = process.cwd;

  try {
    if (eventType !== undefined) {
      process.argv = ['node', 'ide-shim', eventType];
    } else {
      process.argv = ['node', 'ide-shim'];
    }
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

// ── Property test ───────────────────────────────────────────────────────

describe('IDE hook shim — P5 Exit Code Safety', () => {
  it('main() resolves without throwing for any input × collector state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_EVENT_TYPES),
        fc.string({ maxLength: 500 }),
        fc.constantFrom(...COLLECTOR_STATES),
        async (eventType, userPrompt, collectorState) => {
          postEventBehavior = collectorState;

          // P5: main() must resolve without throwing — never exits non-zero
          await expect(runShim(eventType, userPrompt)).resolves.toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});
