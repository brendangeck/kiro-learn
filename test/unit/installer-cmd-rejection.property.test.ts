/**
 * Property-based test: Unrecognized command rejection.
 *
 * Feature: installer, Property 1: Unrecognized command rejection
 *
 * For any string not in {init, start, stop, status, uninstall, --help, --version},
 * the CLI produces exit code 1 and stderr lists valid commands.
 *
 * Uses the exported in-process {@link dispatch} function from
 * `src/installer/bin.ts` so fast-check can explore a hundred+ invalid
 * argv strings in milliseconds rather than spawning a fresh `npx tsx`
 * per iteration.
 *
 * **Validates: Requirements 1.4**
 *
 * @see .kiro/specs/installer/design.md § Property 1
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { dispatch } from '../../src/installer/bin.js';

/** The set of valid commands and flags that the CLI recognizes. */
const VALID_COMMANDS = new Set([
  'init',
  'start',
  'stop',
  'status',
  'uninstall',
  '--help',
  '--version',
]);

describe('Installer — property: unrecognized command rejection (P1)', () => {
  it('any non-valid command string produces exit 1 and stderr lists valid commands', async () => {
    /**
     * **Validates: Requirements 1.4**
     */
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 30 })
          .filter((s) => !VALID_COMMANDS.has(s) && !s.includes('\0') && !s.includes('\n')),
        async (cmd) => {
          const result = await dispatch([cmd]);
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain('Valid commands:');
        },
      ),
      { numRuns: 100 },
    );
  });
});
