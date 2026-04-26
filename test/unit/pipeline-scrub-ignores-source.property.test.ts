/**
 * Property-based test: privacy scrub does not touch `source`.
 *
 * Feature: project-path-capture, Property 10: Privacy scrub does not touch `source`
 *
 * The privacy scrub stage only redacts `<private>...</private>` spans inside
 * `event.body`. It MUST NOT visit `event.source`. This test guards against a
 * future regression that starts applying `scrubPrivateSpans` to `source`.
 *
 * Events are constructed synthetically (bypassing `detectProjectRoot`) so the
 * shim is not involved — we directly inject private-span literals into
 * `source.project_path` and assert byte-level preservation through the stage.
 *
 * **Validates: Requirements 12.1, N8**
 *
 * @see .kiro/specs/project-path-capture/design.md § Property 10
 * @see .kiro/specs/project-path-capture/requirements.md § Requirement 12.1, N8
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createPrivacyScrubStage } from '../../src/collector/pipeline/index.js';
import { arbitraryEvent } from '../helpers/arbitrary.js';

/**
 * Arbitrary `source.project_path` value that is guaranteed to contain at
 * least one `<private>...</private>` literal substring. Three variants are
 * produced — simple, nested, and unclosed — so the scrub stage's three
 * distinct code paths would all be exercised *if* the stage mistakenly
 * visited `source`. The final length is clamped to the 2048-char schema
 * bound so the resulting event remains parseable by downstream consumers.
 */
function projectPathWithPrivateArb(): fc.Arbitrary<string> {
  // Safe filler that cannot accidentally contain `<private>` or `</private>`
  // substrings — stripped post-generation so the only tags present are the
  // ones we inject explicitly.
  const filler = fc
    .string({ maxLength: 40 })
    .map((s) => s.replace(/<\/?private>/g, ''));

  const simple = fc
    .tuple(filler, filler, filler)
    .map(([a, secret, b]) => `${a}<private>${secret}</private>${b}`);

  const nested = fc
    .tuple(filler, filler, filler, filler)
    .map(
      ([a, outer, inner, b]) =>
        `${a}<private>${outer}<private>${inner}</private></private>${b}`,
    );

  const unclosed = fc
    .tuple(filler, filler)
    .map(([a, secret]) => `${a}<private>${secret}`);

  return fc
    .oneof(simple, nested, unclosed)
    .map((s) => {
      // Clamp to the EventSource.project_path schema bound (1–2048).
      if (s.length === 0) return '<private>x</private>';
      return s.length > 2048 ? s.slice(0, 2048) : s;
    });
}

// Feature: project-path-capture, Property 10: Privacy scrub does not touch `source`
describe('PrivacyScrubStage — property: scrub does not touch source (P10)', () => {
  it('scrubbing an event whose source.project_path contains <private> spans leaves source byte-identical', async () => {
    /**
     * **Validates: Requirements 12.1, N8**
     *
     * For any valid `KiroMemEvent` whose `source.project_path` contains the
     * literal substring `<private>...</private>` (simple, nested, or
     * unclosed), applying the privacy scrub stage SHALL produce an event
     * whose `source.project_path` is byte-identical to the input's, and
     * whose `source` object as a whole deep-equals the input's.
     *
     * Scrub operates on `body` only — `source` is never visited.
     */
    const stage = createPrivacyScrubStage();

    await fc.assert(
      fc.asyncProperty(
        arbitraryEvent(),
        projectPathWithPrivateArb(),
        async (event, projectPathWithPrivate) => {
          // Synthesise the input: override source.project_path with a
          // value that contains a literal `<private>...</private>` span.
          // Bypasses detectProjectRoot entirely — this is a pipeline-layer
          // test, not a shim-layer test.
          const inputEvent = {
            ...event,
            source: {
              ...event.source,
              project_path: projectPathWithPrivate,
            },
          };

          // Sanity precondition: the value really does contain a private tag.
          expect(inputEvent.source.project_path).toContain('<private>');

          const result = await stage.process(inputEvent);

          // The scrub stage always continues (never halts).
          expect(result.action).toBe('continue');
          if (result.action !== 'continue') return;

          // Byte-identical preservation of source.project_path.
          expect(result.event.source.project_path).toBe(projectPathWithPrivate);

          // And the rest of `source` is untouched too.
          expect(result.event.source).toStrictEqual(inputEvent.source);
        },
      ),
      { numRuns: 25 },
    );
  });
});
