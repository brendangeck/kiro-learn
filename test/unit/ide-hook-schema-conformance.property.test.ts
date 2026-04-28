/**
 * Property tests: P1 (Event Schema Conformance) + P2 (Surface Identification).
 *
 * Feature: kiro-ide-hook-shim, Property 1: Event Schema Conformance
 * Feature: kiro-ide-hook-shim, Property 2: Surface Identification Invariant
 *
 * P1: For any event type in {promptSubmit, postToolUse, agentStop} and any
 * USER_PROMPT string, the event produced by the IDE shim passes parseEvent()
 * validation.
 *
 * P2: For any event produced by the IDE shim, event.source.surface === 'kiro-ide'.
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 5.1, 5.4
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

// Mock homedir so buildEvent's detectProjectRoot doesn't walk the real fs
vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Mock postEvent to capture the event without making HTTP calls
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
  tmpHome = mkdtempSync(join(tmpdir(), 'kiro-learn-p1p2-home-'));
  tmpCwd = mkdtempSync(join(tmpHome, 'project-'));
  // Plant a marker so detectProjectRoot finds a project
  writeFileSync(join(tmpCwd, 'package.json'), '{}');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────

const IDE_EVENT_TYPES = ['promptSubmit', 'postToolUse', 'agentStop'] as const;

/** Run main() with the given event type and USER_PROMPT. */
async function runShim(eventType: string, userPrompt: string): Promise<KiroMemEvent | null> {
  capturedEvent = null;

  const origArgv = process.argv;
  const origEnv = process.env['USER_PROMPT'];
  const origCwd = process.cwd;

  try {
    process.argv = ['node', 'ide-shim', eventType];
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

// ── Property tests ──────────────────────────────────────────────────────

describe('IDE hook shim — P1 + P2 property tests', () => {
  it('P1: every event passes parseEvent() validation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...IDE_EVENT_TYPES),
        fc.string({ maxLength: 500 }),
        async (eventType, userPrompt) => {
          const event = await runShim(eventType, userPrompt);

          // Event should always be produced for valid event types
          expect(event).not.toBeNull();
          if (event !== null) {
            // P1: must pass Zod validation
            expect(() => parseEvent(event)).not.toThrow();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('P2: every event has source.surface === kiro-ide', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...IDE_EVENT_TYPES),
        fc.string({ maxLength: 500 }),
        async (eventType, userPrompt) => {
          const event = await runShim(eventType, userPrompt);

          expect(event).not.toBeNull();
          if (event !== null) {
            // P2: surface must always be 'kiro-ide'
            expect(event.source.surface).toBe('kiro-ide');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
