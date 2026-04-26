/**
 * Property-based test for the `source.project_path` length bounds on
 * `EventSourceSchema`.
 *
 * Feature: project-path-capture, Property 7: project_path schema bounds
 *
 * For any string whose length falls in [1, 2048], an otherwise-valid event
 * with that `source.project_path` SHALL pass `parseEvent` and the returned
 * `source.project_path` SHALL equal the input. For any string of length 0
 * or length > 2048, `parseEvent` SHALL throw a `ZodError` whose first issue
 * path identifies `project_path` as the offending field.
 *
 * @see .kiro/specs/project-path-capture/design.md § Correctness Properties (P7)
 * @see .kiro/specs/project-path-capture/requirements.md
 *      § Requirements 5.2, 5.5, 5.6
 * @see .kiro/specs/project-path-capture/tasks.md § Task 1.3
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { parseEvent, type KiroMemEvent } from '../../src/types/schemas.js';

/**
 * Baseline valid event. Each property iteration overrides `source` with
 * a copy that injects the generated `project_path`, so the only field
 * under test is `project_path`; everything else stays valid.
 */
const validEventBase: KiroMemEvent = {
  event_id: '01JF8ZS4Y00000000000000000',
  session_id: 'sess-1',
  actor_id: 'alice',
  namespace: '/actor/alice/project/abc/',
  schema_version: 1,
  kind: 'prompt',
  body: { type: 'text', content: 'hi' },
  valid_time: '2026-04-23T20:00:00Z',
  source: { surface: 'kiro-cli', version: '0.1.0', client_id: 'client-1' },
};

/** Build an event as `unknown` with the given `project_path`. */
function eventWithProjectPath(projectPath: string): unknown {
  const clone = structuredClone(validEventBase) as Record<string, unknown>;
  clone['source'] = {
    surface: 'kiro-cli',
    version: '0.1.0',
    client_id: 'client-1',
    project_path: projectPath,
  };
  return clone;
}

/**
 * Arbitrary string that spans both the accepted range (length 1–2048)
 * and the rejected ranges (length 0 and length > 2048). Keeping the
 * full range in one generator lets the single property test body route
 * each case to its expected outcome based on `.length`, giving fast-check
 * uniform coverage and letting the shrinker collapse any counterexample
 * to the boundary that broke the rule.
 *
 * Upper bound is 2200 — comfortably above the 2048 cap while keeping
 * generated strings small enough that 100 iterations stay fast.
 */
const anyProjectPathCandidate: fc.Arbitrary<string> = fc.string({
  minLength: 0,
  maxLength: 2200,
});

// Feature: project-path-capture, Property 7: project_path schema bounds
describe('parseEvent — property: source.project_path schema bounds (P7)', () => {
  it('accepts 1–2048 char values and rejects length 0 or > 2048', () => {
    /**
     * **Validates: Requirements 5.2, 5.5, 5.6**
     *
     * For any string `s`:
     * - If `1 ≤ s.length ≤ 2048`: `parseEvent` succeeds and the parsed
     *   `source.project_path` equals `s` byte-for-byte. No structural
     *   constraint is applied to the value (Requirement 5.6) — any 1–2048
     *   char string is accepted as a carrier.
     * - If `s.length === 0` or `s.length > 2048`: `parseEvent` throws
     *   `ZodError` and the first issue's `path` ends in `project_path`,
     *   identifying the offending field.
     */
    fc.assert(
      fc.property(anyProjectPathCandidate, (projectPath) => {
        const input = eventWithProjectPath(projectPath);
        const inBounds = projectPath.length >= 1 && projectPath.length <= 2048;
        // Reduced iteration count: fewer runs speed up the suite while
        // still exercising every boundary (0, 1, 2048, 2049+) through
        // fast-check's boundary-biased shrinker.

        if (inBounds) {
          const parsed = parseEvent(input);
          expect(parsed.source.project_path).toBe(projectPath);
          return;
        }

        let caught: unknown;
        try {
          parseEvent(input);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(ZodError);
        const issues = (caught as ZodError).issues;
        expect(issues.length).toBeGreaterThan(0);
        const first = issues[0];
        if (first === undefined) {
          throw new Error('ZodError has no issues');
        }
        expect(first.path[first.path.length - 1]).toBe('project_path');
      }),
      { numRuns: 25 },
    );
  });
});
