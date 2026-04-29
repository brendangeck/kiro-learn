/**
 * Property-based test for project ID extraction determinism.
 *
 * Feature: workspace-buffer-pipeline, Property 5: Project ID extraction determinism
 *
 * For any string, `extractProjectId` is a pure function: calling it twice on
 * the same input returns the same output. For namespace-pattern strings
 * (`/actor/<id>/project/<pid>/`), the output equals the `<pid>` segment. For
 * non-matching strings, the output equals the full input.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Property 5
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 4.1, 4.2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { extractProjectId } from '../../src/collector/buffer/types.js';
import { namespaceArb } from '../helpers/arbitrary.js';

/** Regex matching the namespace pattern — duplicated from production code for test-side verification. */
const NAMESPACE_RE = /^\/actor\/([^/]+)\/project\/([^/]+)\/$/;

describe('Project ID extraction determinism (Property 5)', () => {
  it('is deterministic: same input always produces the same output', () => {
    /**
     * **Validates: Requirements 4.1, 4.2**
     *
     * For any string, calling `extractProjectId` twice yields the same result.
     */
    fc.assert(
      fc.property(fc.string(), (input) => {
        const first = extractProjectId(input);
        const second = extractProjectId(input);
        expect(first).toBe(second);
      }),
      { numRuns: 200 },
    );
  });

  it('extracts the project ID segment from namespace-pattern strings', () => {
    /**
     * **Validates: Requirements 4.1, 4.2**
     *
     * For any namespace matching `/actor/<actor>/project/<pid>/`, the output
     * equals the `<pid>` segment extracted via regex.
     */
    fc.assert(
      fc.property(namespaceArb(), (namespace) => {
        const result = extractProjectId(namespace);
        const match = NAMESPACE_RE.exec(namespace);
        expect(match).not.toBeNull();
        expect(result).toBe(match?.[2]);
      }),
      { numRuns: 200 },
    );
  });

  it('returns the full input for non-matching strings', () => {
    /**
     * **Validates: Requirements 4.1, 4.2**
     *
     * For arbitrary strings that don't match the namespace pattern, the output
     * equals the full input string.
     */
    fc.assert(
      fc.property(
        fc.string().filter((s) => !NAMESPACE_RE.test(s)),
        (input) => {
          const result = extractProjectId(input);
          expect(result).toBe(input);
        },
      ),
      { numRuns: 200 },
    );
  });
});
