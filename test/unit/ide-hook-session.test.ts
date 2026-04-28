/**
 * Unit tests for IDE hook shim session management.
 *
 * Verifies readSession is used (not createSession) for all hook types,
 * and session file path is derived from process.cwd().
 *
 * Test file: test/unit/ide-hook-session.test.ts
 * Requirements: 6.1, 6.2, 6.3, 6.4
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

let readSessionCalls: string[] = [];
let createSessionCalls: string[] = [];

vi.mock('../../src/shim/shared/index.js', async (importOriginal) => {
  const original = (await importOriginal()) as typeof sharedModule;
  return {
    ...original,
    readSession: vi.fn((cwd: string) => {
      readSessionCalls.push(cwd);
      return 'mock-session-id';
    }),
    createSession: vi.fn((cwd: string) => {
      createSessionCalls.push(cwd);
      return 'mock-session-id';
    }),
    postEvent: vi.fn(async (_event: KiroMemEvent) => {
      return { event_id: 'test', stored: true };
    }),
  };
});

const { main } = await import('../../src/shim/ide-hook/index.js');

// ── Setup / teardown ────────────────────────────────────────────────────

let origArgv: string[];
let origEnv: string | undefined;
let origCwd: () => string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'kiro-learn-session-home-'));
  tmpCwd = mkdtempSync(join(tmpHome, 'project-'));
  writeFileSync(join(tmpCwd, 'package.json'), '{}');
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  readSessionCalls = [];
  createSessionCalls = [];
  origArgv = process.argv;
  origEnv = process.env['USER_PROMPT'];
  origCwd = process.cwd;
  process.cwd = () => tmpCwd;
  process.env['USER_PROMPT'] = 'test';
});

afterEach(() => {
  process.argv = origArgv;
  if (origEnv === undefined) {
    delete process.env['USER_PROMPT'];
  } else {
    process.env['USER_PROMPT'] = origEnv;
  }
  process.cwd = origCwd;
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('IDE hook shim — session management', () => {
  it('uses readSession (not createSession) for promptSubmit', async () => {
    process.argv = ['node', 'ide-shim', 'promptSubmit'];

    await main();

    expect(readSessionCalls.length).toBe(1);
    expect(createSessionCalls.length).toBe(0);
  });

  it('uses readSession (not createSession) for postToolUse', async () => {
    process.argv = ['node', 'ide-shim', 'postToolUse'];
    process.env['USER_PROMPT'] = JSON.stringify({ toolName: 'test' });

    await main();

    expect(readSessionCalls.length).toBe(1);
    expect(createSessionCalls.length).toBe(0);
  });

  it('uses readSession (not createSession) for agentStop', async () => {
    process.argv = ['node', 'ide-shim', 'agentStop'];

    await main();

    expect(readSessionCalls.length).toBe(1);
    expect(createSessionCalls.length).toBe(0);
  });

  it('passes process.cwd() to readSession', async () => {
    process.argv = ['node', 'ide-shim', 'promptSubmit'];

    await main();

    expect(readSessionCalls[0]).toBe(tmpCwd);
  });
});
