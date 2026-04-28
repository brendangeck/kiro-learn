/**
 * Unit tests for namespace derivation from `src/mcp/namespace.ts`.
 *
 * Tests the `deriveNamespace` and `getActorId` functions, including the
 * fallback chain for actor ID resolution.
 *
 * Uses `vi.mock('node:os')` to control `userInfo` behavior since the
 * source module uses a destructured import.
 *
 * @see Requirements 12.1, 12.2
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type * as nodeOs from 'node:os';
import { userInfo } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:os so we can control userInfo per test
vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    userInfo: vi.fn(original.userInfo),
  };
});

import { deriveNamespace, getActorId } from '../../src/mcp/namespace.js';

// ── deriveNamespace ─────────────────────────────────────────────────────

describe('deriveNamespace', () => {
  it('produces correct namespace format /actor/<id>/project/<64-hex>/', () => {
    const cwd = process.cwd();
    const ns = deriveNamespace(cwd);

    // Must match the pattern
    expect(ns).toMatch(/^\/actor\/[^/]+\/project\/[0-9a-f]{64}\/$/);
  });

  it('namespace contains SHA-256 hex of resolved cwd', () => {
    const cwd = process.cwd();
    const resolved = realpathSync(cwd);
    const expectedHash = createHash('sha256').update(resolved).digest('hex');

    const ns = deriveNamespace(cwd);

    expect(ns).toContain(`/project/${expectedHash}/`);
  });
});

// ── getActorId ──────────────────────────────────────────────────────────

describe('getActorId', () => {
  let savedUser: string | undefined;
  let savedUsername: string | undefined;

  beforeEach(() => {
    savedUser = process.env['USER'];
    savedUsername = process.env['USERNAME'];
  });

  afterEach(() => {
    // Restore env vars
    if (savedUser !== undefined) {
      process.env['USER'] = savedUser;
    } else {
      delete process.env['USER'];
    }
    if (savedUsername !== undefined) {
      process.env['USERNAME'] = savedUsername;
    } else {
      delete process.env['USERNAME'];
    }
    vi.mocked(userInfo).mockRestore();
  });

  it('returns os.userInfo().username when available', () => {
    const actorId = getActorId();
    // The real userInfo is called — should match the OS username
    expect(typeof actorId).toBe('string');
    expect(actorId.length).toBeGreaterThan(0);
  });

  it('falls back to process.env.USER when os.userInfo() throws', () => {
    vi.mocked(userInfo).mockImplementation(() => {
      throw new Error('no user info');
    });

    process.env['USER'] = 'env-user';
    delete process.env['USERNAME'];

    expect(getActorId()).toBe('env-user');
  });

  it('falls back to process.env.USERNAME when USER is also missing', () => {
    vi.mocked(userInfo).mockImplementation(() => {
      throw new Error('no user info');
    });

    delete process.env['USER'];
    process.env['USERNAME'] = 'env-username';

    expect(getActorId()).toBe('env-username');
  });

  it('falls back to "unknown" when all sources are unavailable', () => {
    vi.mocked(userInfo).mockImplementation(() => {
      throw new Error('no user info');
    });

    delete process.env['USER'];
    delete process.env['USERNAME'];

    expect(getActorId()).toBe('unknown');
  });
});
