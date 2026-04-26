/**
 * Property-based test: Error message prefix.
 *
 * Feature: installer, Property 5: Error message prefix
 *
 * For any error condition that causes stderr output, the output contains
 * the [kiro-learn] prefix.
 *
 * Uses the exported in-process {@link dispatch} function from
 * `src/installer/bin.ts` for the unrecognized-command property so
 * fast-check doesn't have to spawn a subprocess per iteration. The
 * `cmdStart` / `cmdStatus` cases still run in-process and spy on
 * `process.stderr.write` the way they always did.
 *
 * **Validates: Requirements 13.5**
 *
 * @see .kiro/specs/installer/design.md § Property 5
 */

import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, describe, expect, it, vi } from 'vitest';

// ── Mocked homedir tests for not-installed errors ───────────────────────

const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-errpfx-prop-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

const { cmdStart, cmdStatus } = await import('../../src/installer/index.js');
const { dispatch } = await import('../../src/installer/bin.js');

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Valid commands that the CLI recognizes. */
const VALID_COMMANDS = new Set([
  'init',
  'start',
  'stop',
  'status',
  'uninstall',
  '--help',
  '--version',
]);

describe('Installer — property: error message prefix (P5)', () => {
  it('unrecognized commands produce stderr with [kiro-learn] prefix', async () => {
    /**
     * **Validates: Requirements 13.5**
     *
     * Generate random invalid command strings and verify stderr contains
     * the [kiro-learn] prefix.
     */
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter(
            (s) =>
              !VALID_COMMANDS.has(s) &&
              !s.includes('\0') &&
              !s.includes('\n'),
          ),
        async (cmd) => {
          const result = await dispatch([cmd]);
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain('[kiro-learn]');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('cmdStart when not installed produces stderr with [kiro-learn] prefix', () => {
    /**
     * **Validates: Requirements 13.5**
     *
     * When kiro-learn is not installed, cmdStart writes to stderr with
     * the [kiro-learn] prefix.
     */
    const chunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const exitCode = cmdStart();
      expect(exitCode).toBe(1);

      const stderr = chunks.join('');
      expect(stderr).toContain('[kiro-learn]');
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it('cmdStatus when not installed produces stderr with [kiro-learn] prefix', () => {
    /**
     * **Validates: Requirements 13.5**
     *
     * When kiro-learn is not installed, cmdStatus writes to stderr with
     * the [kiro-learn] prefix.
     */
    const chunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const exitCode = cmdStatus();
      expect(exitCode).toBe(1);

      const stderr = chunks.join('');
      expect(stderr).toContain('[kiro-learn]');
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });
});
