/**
 * Unit tests for IDE hook shim tool-use handler.
 *
 * Tests camelCase → snake_case field mapping, partial payloads,
 * JSON parse failure fallback.
 *
 * Test file: test/unit/ide-hook-tool-use.test.ts
 * Requirements: 7.2, 4.7, 4.9, 8.4
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
let stderrChunks: string[];
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'kiro-learn-tooluse-home-'));
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
  process.argv = ['node', 'ide-shim', 'postToolUse'];
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
  process.stderr.write = origStderrWrite;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('IDE hook shim — tool-use handler', () => {
  it('maps full camelCase payload to snake_case', async () => {
    process.env['USER_PROMPT'] = JSON.stringify({
      toolName: 'readFile',
      toolArgs: { path: 'src/index.ts' },
      toolResult: 'file contents here',
      toolSuccess: true,
    });

    await main();

    expect(capturedEvent).not.toBeNull();
    expect(capturedEvent!.kind).toBe('tool_use');
    expect(capturedEvent!.body.type).toBe('json');

    const data = (capturedEvent!.body as { type: 'json'; data: unknown }).data as Record<string, unknown>;
    expect(data['tool_name']).toBe('readFile');
    expect(data['tool_input']).toEqual({ path: 'src/index.ts' });

    const resp = data['tool_response'] as Record<string, unknown>;
    expect(resp['result']).toBe('file contents here');
    expect(resp['success']).toBe(true);
  });

  it('handles missing toolResult and toolSuccess', async () => {
    process.env['USER_PROMPT'] = JSON.stringify({
      toolName: 'writeFile',
      toolArgs: { path: 'out.txt', content: 'hello' },
    });

    await main();

    expect(capturedEvent).not.toBeNull();
    const data = (capturedEvent!.body as { type: 'json'; data: unknown }).data as Record<string, unknown>;
    expect(data['tool_name']).toBe('writeFile');
    expect(data['tool_input']).toEqual({ path: 'out.txt', content: 'hello' });
    // tool_response should be empty object when no result/success
    expect(data['tool_response']).toEqual({});
  });

  it('handles missing toolArgs', async () => {
    process.env['USER_PROMPT'] = JSON.stringify({
      toolName: 'listDir',
      toolResult: 'file1.ts\nfile2.ts',
      toolSuccess: true,
    });

    await main();

    expect(capturedEvent).not.toBeNull();
    const data = (capturedEvent!.body as { type: 'json'; data: unknown }).data as Record<string, unknown>;
    expect(data['tool_name']).toBe('listDir');
    expect(data['tool_input']).toEqual({});
    const resp = data['tool_response'] as Record<string, unknown>;
    expect(resp['result']).toBe('file1.ts\nfile2.ts');
    expect(resp['success']).toBe(true);
  });

  it('falls back to defaults on JSON parse failure', async () => {
    process.env['USER_PROMPT'] = 'not valid json at all';

    await main();

    expect(capturedEvent).not.toBeNull();
    const data = (capturedEvent!.body as { type: 'json'; data: unknown }).data as Record<string, unknown>;
    expect(data['tool_name']).toBe('unknown');
    expect(data['tool_input']).toEqual({});
    expect(data['tool_response']).toEqual({});

    // Should log parse failure to stderr
    const stderr = stderrChunks.join('');
    expect(stderr).toContain('[kiro-learn] failed to parse USER_PROMPT JSON');
  });

  it('produces no stdout output', async () => {
    process.env['USER_PROMPT'] = JSON.stringify({ toolName: 'test' });

    await main();

    expect(stdoutChunks.join('')).toBe('');
  });

  it('handles toolSuccess: false', async () => {
    process.env['USER_PROMPT'] = JSON.stringify({
      toolName: 'exec',
      toolArgs: { command: 'npm test' },
      toolResult: 'FAIL',
      toolSuccess: false,
    });

    await main();

    expect(capturedEvent).not.toBeNull();
    const data = (capturedEvent!.body as { type: 'json'; data: unknown }).data as Record<string, unknown>;
    const resp = data['tool_response'] as Record<string, unknown>;
    expect(resp['success']).toBe(false);
    expect(resp['result']).toBe('FAIL');
  });
});
