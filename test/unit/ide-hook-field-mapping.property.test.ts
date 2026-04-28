/**
 * Property test: P3 (Tool-Use Field Mapping Completeness).
 *
 * Feature: kiro-ide-hook-shim, Property 3: Tool-Use Field Mapping Completeness
 *
 * For any valid camelCase postToolUse JSON payload, the event body contains
 * tool_name, tool_input, and tool_response with correctly mapped values.
 *
 * Validates: Requirements 7.2, 4.7
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import type { KiroMemEvent } from '../../src/types/index.js';
import { ideToolUsePayloadArb } from '../helpers/arbitrary.js';
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
  tmpHome = mkdtempSync(join(tmpdir(), 'kiro-learn-p3-home-'));
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

// ── Property test ───────────────────────────────────────────────────────

describe('IDE hook shim — P3 Tool-Use Field Mapping Completeness', () => {
  it('maps all camelCase fields to snake_case correctly', async () => {
    await fc.assert(
      fc.asyncProperty(
        ideToolUsePayloadArb(),
        async (payload) => {
          const event = await runToolUse(JSON.stringify(payload));

          expect(event).not.toBeNull();
          if (event === null) return;

          expect(event.kind).toBe('tool_use');
          expect(event.body.type).toBe('json');

          if (event.body.type !== 'json') return;

          const data = event.body.data as Record<string, unknown>;

          // P3: tool_name must be present and match toolName
          expect(data['tool_name']).toBe(payload.toolName);

          // P3: tool_input must be present and match toolArgs
          expect(data['tool_input']).toEqual(payload.toolArgs);

          // P3: tool_response must be present
          const toolResponse = data['tool_response'] as Record<string, unknown>;
          expect(toolResponse).toBeDefined();

          // tool_response.result maps from toolResult
          if (payload.toolResult !== undefined) {
            expect(toolResponse['result']).toBe(payload.toolResult);
          }

          // tool_response.success maps from toolSuccess
          if (payload.toolSuccess !== undefined) {
            expect(toolResponse['success']).toBe(payload.toolSuccess);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
