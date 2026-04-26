/**
 * Property-based test: dedup ignores `source.project_path`.
 *
 * Feature: project-path-capture, Property 11: Dedup ignores `source.project_path`
 *
 * The dedup stage keys exclusively on `event_id`. `source.project_path` is
 * NOT part of the dedup key: two events with identical `event_id` but
 * differing `source.project_path` values must collide — the second call
 * returns `{ action: 'halt', response: { stored: false, event_id } }`.
 *
 * This test guards against a future regression that starts incorporating
 * fields from `source` into the dedup key (e.g. hashing `event_id ||
 * project_path`). The pipeline's dedup semantics are unchanged by the
 * `project-path-capture` feature, and this property documents that.
 *
 * **Validates: Requirement 12.2**
 *
 * @see .kiro/specs/project-path-capture/design.md § Property 11
 * @see .kiro/specs/project-path-capture/requirements.md § Requirement 12.2
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createDedupStage } from '../../src/collector/pipeline/index.js';
import { arbitraryEvent, projectPathArb } from '../helpers/arbitrary.js';

// Feature: project-path-capture, Property 11: Dedup ignores `source.project_path`
describe('DedupStage — property: dedup ignores source.project_path (P11)', () => {
  it('second call with same event_id but different source.project_path halts', async () => {
    /**
     * **Validates: Requirement 12.2**
     *
     * For any pair `(e1, e2)` where `e1.event_id === e2.event_id` and
     * `e1.source.project_path !== e2.source.project_path`: after a fresh
     * dedup stage processes `e1` (returns `continue`) and then `e2`, the
     * second call SHALL return `{ action: 'halt', response: { stored:
     * false, event_id } }`. `project_path` is not part of the dedup key.
     */
    await fc.assert(
      fc.asyncProperty(
        arbitraryEvent(),
        projectPathArb(),
        projectPathArb(),
        async (baseEvent, firstProjectPath, secondProjectPath) => {
          // Skip vacuous runs where the two project paths happen to match.
          fc.pre(firstProjectPath !== secondProjectPath);

          const e1 = {
            ...baseEvent,
            source: { ...baseEvent.source, project_path: firstProjectPath },
          };
          const e2 = {
            ...baseEvent,
            source: { ...baseEvent.source, project_path: secondProjectPath },
          };

          // Sanity preconditions: same event_id, different project_path.
          expect(e1.event_id).toBe(e2.event_id);
          expect(e1.source.project_path).not.toBe(e2.source.project_path);

          const dedup = createDedupStage({ maxSize: 10_000 });

          // First submission — should continue.
          const first = await dedup.process(e1);
          expect(first.action).toBe('continue');
          if (first.action === 'continue') {
            expect(first.event).toEqual(e1);
          }

          // Second submission — same event_id, different project_path —
          // must halt. project_path is NOT part of the dedup key.
          const second = await dedup.process(e2);
          expect(second.action).toBe('halt');
          if (second.action === 'halt') {
            expect(second.response.stored).toBe(false);
            expect(second.response.event_id).toBe(e1.event_id);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});
