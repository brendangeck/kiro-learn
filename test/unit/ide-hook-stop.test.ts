/**
 * Unit tests for IDE hook shim stop handler.
 *
 * Tests text passthrough, empty USER_PROMPT, no stdout output.
 *
 * Test file: test/unit/ide-hook-stop.test.ts
 * Requirements: 7.3, 4.8, 8.4
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

let origArgv: string[];
let origEnv: string | undefined;
let origCwd: () => string;
let stdoutChunks: string[];
let origStdoutWrite: typeof process.stdout.write;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'kiro-learn-stop-home-'));
  tmpCwd = mkdtempSync(join(tmpHome, 'project-'));
  writeFileSync(join(tmpCwd, 'package.json'), '{}');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  capturedEvent = null;
  origArgv = process.argv;
  origEnv = process.env['USER_PROMPT'];
  origCwd = process.cwd;
  stdoutChunks = [];
  origStdoutWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.argv = ['node', 'ide-shim', 'agentStop'];
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
  process.stdout.write = origStdoutWrite;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('IDE hook shim — stop handler', () => {
  it('passes USER_PROMPT text through to event body', async () => {
    process.env['USER_PROMPT'] = 'session summary text';

    await main();

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent!.kind).toBe('session_summary');
    expect(capturedEvent!.body).toEqual({ type: 'text', content: 'session summary text' });
  });

  it('uses empty string when USER_PROMPT is empty', async () => {
    process.env['USER_PROMPT'] = '';

    await main();

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent!.body).toEqual({ type: 'text', content: '' });
  });

  it('produces no stdout output', async () => {
    process.env['USER_PROMPT'] = 'summary';

    await main();

    expect(stdoutChunks.join('')).toBe('');
  });

  it('handles JSON-like USER_PROMPT as-is (plain text)', async () => {
    process.env['USER_PROMPT'] = '{"key": "value"}';

    await main();

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent!.kind).toBe('session_summary');
    // agentStop treats USER_PROMPT as plain text regardless of format
    expect(capturedEvent!.body).toEqual({ type: 'text', content: '{"key": "value"}' });
  });
});
