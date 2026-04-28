// Feature: mcp-memory-server, Property 9: Namespace derivation produces a valid namespace

/**
 * Property-based test for namespace derivation.
 *
 * @see .kiro/specs/mcp-memory-server/design.md § Property 9
 * @see .kiro/specs/mcp-memory-server/requirements.md § 12.1
 */

import { createHash } from 'node:crypto';
import type * as nodeFs from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeFs;
  return {
    ...original,
    realpathSync: vi.fn((p: string) => p),
  };
});

import { deriveNamespace } from '../../src/mcp/namespace.js';

/** Pattern: /actor/<id>/project/<64-hex-chars>/ */
const NAMESPACE_PATTERN = /^\/actor\/[^/]+\/project\/[0-9a-f]{64}\/$/;

describe('Namespace derivation — property tests', () => {
  it('Property 9: deriveNamespace produces a string matching /actor/<id>/project/<64-hex>/', () => {
    /**
     * **Validates: Requirements 12.1**
     *
     * For any absolute path, `deriveNamespace` produces a string matching
     * `/actor/<id>/project/<64-hex-chars>/`.
     */
    const absolutePathArb = fc
      .array(
        fc.stringMatching(/^[a-zA-Z0-9._-]{1,20}$/).filter((s) => s.length >= 1),
        { minLength: 1, maxLength: 6 },
      )
      .map((segments) => '/' + segments.join('/'));

    fc.assert(
      fc.property(absolutePathArb, (absPath) => {
        const ns = deriveNamespace(absPath);

        // Must match the namespace pattern
        expect(ns).toMatch(NAMESPACE_PATTERN);

        // The project ID portion must be the SHA-256 of the input path
        // (since realpathSync is mocked to return the input)
        const expectedHash = createHash('sha256').update(absPath).digest('hex');
        expect(ns).toContain(`/project/${expectedHash}/`);
      }),
      { numRuns: 100 },
    );
  });
});
