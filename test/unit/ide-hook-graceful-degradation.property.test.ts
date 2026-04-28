/**
 * Property test: P4 (Graceful Degradation on Malformed Input).
 *
 * Feature: kiro-ide-hook-shim, Property 4: Graceful Degradation
 *
 * For any non-JSON string as USER_PROMPT when event type is postToolUse,
 * the shim produces a valid event with defaults and does not throw.
 *
 * Validates: Requirements 4.9, 7.5, 11.1
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import type { KiroMemEvent } from '../../src/types/index.js';
import { parseEvent } from '../../src/types/index.js';
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

let capturedEvent: KiroMemEvent | null = null;

vi.mock('../../src/shim/shared/index.js', async (importOriginal) => {
  const original = (await importOriginal()) as typeof sharedModule;
  return {
    ...original,
    postEvent: vi.fn(async (event: KiroMemEvent) => {
      capturedEvent = event;
      return { event_id: event.event_id, stored: true };
    }),
  };
});

const { main } = await import('../../src/shim/ide-hook/index.js');

// ── Setup / teardown ────────────────────────────────────────────────────

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'kiro-learn-p4-home-'));
  tmpCwd = mkdtempSync(join(tmpHome, 'project-'));
  writeFileSync(join(tmpCwd, 'package.json'), '{}');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────

async function runToolUse(userPrompt: string): Promise<KiroMemEvent | null> {
  capturedEvent = null;

  const origArgv = process.argv;
  const origEnv = process.env['USER_PROMPT'];
  const origCwd = process.cwd;

  try {
    process.argv = ['node', 'ide-shim', 'postToolUse'];
    process.env['USER_PROMPT'] = userPrompt;
    process.cwd = () => tmpCwd;

    await main();

    return capturedEvent;
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

/**
 * Generate strings that are NOT valid JSON. Filters out any string that
 * JSON.parse would accept.
 */
function nonJsonStringArb(): fc.Arbitrary<string> {
  return fc.string({ maxLength: 500 }).filter((s) => {
    try {
      JSON.parse(s);
      return false; // valid JSON — reject
    } catch {
      return true; // not JSON — keep
    }
  });
}

// ── Property test ───────────────────────────────────────────────────────

describe('IDE hook shim — P4 Graceful Degradation on Malformed Input', () => {
  it('produces a valid event with defaults for any non-JSON USER_PROMPT', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonJsonStringArb(),
        async (malformedInput) => {
          const event = await runToolUse(malformedInput);

          // Must always produce an event (never throw)
          expect(event).not.toBeNull();
          if (event === null) return;

          // Must pass Zod validation
          expect(() => parseEvent(event)).not.toThrow();

          // Must have correct defaults
          expect(event.kind).toBe('tool_use');
          expect(event.body.type).toBe('json');

          if (event.body.type !== 'json') return;

          const data = event.body.data as Record<string, unknown>;

          // tool_name defaults to "unknown"
          expect(data['tool_name']).toBe('unknown');

          // tool_input defaults to {}
          expect(data['tool_input']).toEqual({});

          // tool_response defaults to {}
          expect(data['tool_response']).toEqual({});

          // Surface must be kiro-ide
          expect(event.source.surface).toBe('kiro-ide');
        },
      ),
      { numRuns: 100 },
    );
  });
});
