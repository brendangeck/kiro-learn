/**
 * Property-based test: SPA fallback determinism (Property 3).
 *
 * For all extensionless paths that pass traversal validation,
 * `resolveAsset` returns `serve` or `spa-fallback`, never
 * `reject` with 404.
 *
 * @see .kiro/specs/visualizer-scaffold/design.md § Property 3
 * @see .kiro/specs/visualizer-scaffold/requirements.md § Requirement 9.4
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveAsset } from '../../src/collector/receiver/static-handler.js';

// ── Fixture setup ───────────────────────────────────────────────────────

let fixtureAssetRoot: string;

beforeAll(() => {
  fixtureAssetRoot = mkdtempSync(join(tmpdir(), 'spa-prop-'));
  // SPA fallback requires index.html
  writeFileSync(join(fixtureAssetRoot, 'index.html'), '<html></html>');
});

afterAll(() => {
  rmSync(fixtureAssetRoot, { recursive: true, force: true });
});

// ── Generator: extensionless paths ──────────────────────────────────────

/**
 * Generate extensionless URL paths: paths where the final segment
 * after the last `/` contains no `.` character.
 *
 * These are the paths that should trigger SPA fallback (or serve an
 * existing file) — never a 404.
 */
function extensionlessPathArb(): fc.Arbitrary<string> {
  return fc
    .array(
      fc.stringMatching(/^[a-z0-9]{1,12}$/),
      { minLength: 1, maxLength: 4 },
    )
    .map((segments) => '/' + segments.join('/'));
}

// ── Property test ───────────────────────────────────────────────────────

describe('resolveAsset — property: SPA fallback determinism (Property 3)', () => {
  it('never returns 404 for extensionless paths that pass traversal validation', () => {
    /**
     * **Validates: Requirements 9.4**
     *
     * For all extensionless URL path strings that pass traversal
     * validation, `resolveAsset` returns either `serve` (file exists)
     * or `spa-fallback` (file doesn't exist). Never
     * `{ kind: 'reject', status: 404 }`.
     */
    fc.assert(
      fc.property(extensionlessPathArb(), (urlPath) => {
        const result = resolveAsset(urlPath, fixtureAssetRoot);

        // Filter out paths rejected by traversal validation (400 or 403)
        // — those are not in scope for this property.
        if (result.kind === 'reject' && (result.status === 400 || result.status === 403)) {
          return; // Skip — traversal rejection is fine
        }

        // The result must be 'serve' or 'spa-fallback', never 404
        expect(result.kind).not.toBe('reject');
        if (result.kind === 'reject') {
          // This branch is unreachable if the above assertion passes,
          // but provides a clear failure message if it doesn't.
          expect(result.status).not.toBe(404);
        }
      }),
    );
  });
});
