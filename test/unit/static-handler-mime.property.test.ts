/**
 * Property-based test: MIME correctness (Property 2).
 *
 * For all extensions in MIME_TABLE, when a file with that extension
 * exists in the fixture, `resolveAsset` returns the matching
 * Content-Type.
 *
 * @see .kiro/specs/visualizer-scaffold/design.md § Property 2
 * @see .kiro/specs/visualizer-scaffold/requirements.md § Requirement 8.3
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  resolveAsset,
  MIME_TABLE,
} from '../../src/collector/receiver/static-handler.js';

// ── Fixture setup ───────────────────────────────────────────────────────

let fixtureAssetRoot: string;

beforeAll(() => {
  fixtureAssetRoot = mkdtempSync(join(tmpdir(), 'mime-prop-'));

  // Create index.html for SPA fallback
  writeFileSync(join(fixtureAssetRoot, 'index.html'), '<html></html>');

  // Create a file for every extension in MIME_TABLE
  for (const ext of Object.keys(MIME_TABLE)) {
    const filename = `testfile${ext}`;
    writeFileSync(join(fixtureAssetRoot, filename), `content for ${ext}`);
  }
});

afterAll(() => {
  rmSync(fixtureAssetRoot, { recursive: true, force: true });
});

// ── Property test ───────────────────────────────────────────────────────

describe('resolveAsset — property: MIME correctness (Property 2)', () => {
  it('returns the correct Content-Type for every MIME_TABLE extension', () => {
    /**
     * **Validates: Requirements 8.3**
     *
     * For any file extension in MIME_TABLE, when a file with that
     * extension exists in the asset root, `resolveAsset` returns
     * `{ kind: 'serve', mimeType: MIME_TABLE[ext] }`.
     */
    const extensions = Object.keys(MIME_TABLE);

    fc.assert(
      fc.property(
        fc.constantFrom(...extensions),
        (ext) => {
          const result = resolveAsset(`/testfile${ext}`, fixtureAssetRoot);

          expect(result.kind).toBe('serve');
          if (result.kind === 'serve') {
            expect(result.mimeType).toBe(MIME_TABLE[ext]);
          }
        },
      ),
    );
  });
});
