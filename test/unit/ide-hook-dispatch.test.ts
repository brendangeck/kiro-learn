/**
 * Unit tests for IDE hook shim dispatch logic.
 *
 * Tests event type dispatch: promptSubmit, postToolUse, agentStop,
 * unknown type, missing argument.
 *
 * Test file: test/unit/ide-hook-dispatch.test.ts
 * Requirements: 4.1, 4.5, 11.4
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KiroMemEvent } from '../../src/types/index.js';
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
let capturedOpts: { retrieve: boolean } | null = null;

vi.mock('../../src/shim/shared/index.js', async (importOriginal) => {
  const original = (await importOriginal()) as typeof sharedModule;
  return {
    ...original,
    postEvent: vi.fn(async (event: KiroMemEvent, opts: { retrieve: boolean }) => {
      capturedEvent = event;
      capturedOpts = opts;
      return { event_id: event.event_id, stored: true };
    }),
  };
});

const { main } = await import('../../src/shim/ide-hook/index.js');

// ── Setup / teardown ────────────────────────────────────────────────────

let origArgv: string[];
let origEnv: string | undefined;
let origCwd: () => string;
let stderrChunks: string[];
let origStderrWrite: typeof process.stderr.write;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'kiro-learn-dispatch-home-'));
  tmpCwd = mkdtempSync(join(tmpHome, 'project-'));
  writeFileSync(join(tmpCwd, 'package.json'), '{}');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  capturedEvent = null;
  capturedOpts = null;
  origArgv = process.argv;
  origEnv = process.env['USER_PROMPT'];
  origCwd = process.cwd;
  stderrChunks = [];
  origStderrWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  process.cwd = () => tmpCwd;
});

afterEach(() => {
  process.argv = origArgv;
  if (origEnv === undefined) {
    delete process.env['USER_PROMPT'];
  } else {
    process.env['USER_PROMPT'] = origEnv;
  }
  process.cwd = origCwd;
  process.stderr.write = origStderrWrite;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('IDE hook shim — dispatch', () => {
  it('dispatches promptSubmit to prompt handler', async () => {
    process.argv = ['node', 'ide-shim', 'promptSubmit'];
    process.env['USER_PROMPT'] = 'test prompt';

    await main();

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent!.kind).toBe('prompt');
    expect(capturedOpts).toEqual({ retrieve: true });
  });

  it('dispatches postToolUse to tool-use handler', async () => {
    process.argv = ['node', 'ide-shim', 'postToolUse'];
    process.env['USER_PROMPT'] = JSON.stringify({ toolName: 'readFile' });

    await main();

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent!.kind).toBe('tool_use');
    expect(capturedOpts).toEqual({ retrieve: false });
  });

  it('dispatches agentStop to stop handler', async () => {
    process.argv = ['node', 'ide-shim', 'agentStop'];
    process.env['USER_PROMPT'] = 'session summary';

    await main();

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent!.kind).toBe('session_summary');
    expect(capturedOpts).toEqual({ retrieve: false });
  });

  it('logs warning for unknown event type', async () => {
    process.argv = ['node', 'ide-shim', 'unknownEvent'];
    process.env['USER_PROMPT'] = '';

    await main();

    expect(capturedEvent).toBeNull();
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('[kiro-learn] unrecognized IDE hook event: unknownEvent');
  });

  it('logs warning for missing event type argument', async () => {
    process.argv = ['node', 'ide-shim'];
    process.env['USER_PROMPT'] = '';

    await main();

    expect(capturedEvent).toBeNull();
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('[kiro-learn] missing IDE hook event type argument');
  });
});
