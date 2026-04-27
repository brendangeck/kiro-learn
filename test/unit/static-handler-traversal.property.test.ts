/**
 * Property-based test: path-traversal containment (Property 1).
 *
 * For all generated URL paths from `arbitraryUrlPath()`,
 * `resolveAsset(path, fixtureAssetRoot)` either produces a
 * `serve`/`spa-fallback` with a path inside `fixtureAssetRoot`,
 * or produces a `reject`. No accepted path resolves outside.
 *
 * This is the most important test in the visualizer-scaffold spec —
 * it validates the security boundary of the static handler.
 *
 * @see .kiro/specs/visualizer-scaffold/design.md § Property 1
 * @see .kiro/specs/visualizer-scaffold/requirements.md § Requirement 7.5
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveAsset } from '../../src/collector/receiver/static-handler.js';
import { arbitraryUrlPath } from '../helpers/arbitrary.js';

// ── Fixture setup ───────────────────────────────────────────────────────

let fixtureAssetRoot: string;

beforeAll(() => {
  fixtureAssetRoot = mkdtempSync(join(tmpdir(), 'traversal-prop-'));
  // SPA fallback requires index.html
  writeFileSync(join(fixtureAssetRoot, 'index.html'), '<html></html>');
});

afterAll(() => {
  rmSync(fixtureAssetRoot, { recursive: true, force: true });
});

// ── Property test ───────────────────────────────────────────────────────

describe('resolveAsset — property: path-traversal containment (Property 1)', () => {
  it('never resolves an accepted path outside the asset root', () => {
    /**
     * **Validates: Requirements 7.5**
     *
     * For any URL path string (including `..` segments, percent-encoded
     * variants, null bytes, mixed separators, overlong paths, non-ASCII
     * bytes), `resolveAsset` either:
     * - returns `serve` with `absolutePath` inside `assetRoot`
     * - returns `spa-fallback` with `indexPath` inside `assetRoot`
     * - returns `reject`
     *
     * No accepted request resolves outside `assetRoot`.
     */
    fc.assert(
      fc.property(arbitraryUrlPath(), (urlPath) => {
        const result = resolveAsset(urlPath, fixtureAssetRoot);

        if (result.kind === 'serve') {
          // absolutePath must start with assetRoot + separator
          expect(result.absolutePath.startsWith(fixtureAssetRoot + sep)).toBe(true);
        } else if (result.kind === 'spa-fallback') {
          // indexPath must start with assetRoot (it's assetRoot/index.html)
          expect(result.indexPath.startsWith(fixtureAssetRoot)).toBe(true);
        }
        // kind === 'reject' is always acceptable — no assertion needed
      }),
    );
  });
});
