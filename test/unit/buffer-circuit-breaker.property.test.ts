/**
 * Property-based test for circuit breaker monotonicity and reset.
 *
 * Feature: workspace-buffer-pipeline, Property 6: Circuit breaker monotonicity and reset
 *
 * For any sequence of `notifyExtractionResult(id, success)` calls, the
 * consecutive failure counter increases by 1 on each `false` call and resets
 * to 0 on each `true` call. After exactly `maxConsecutiveFailures` consecutive
 * `false` calls, `extractionDisabled` is `true`. A single `true` call at any
 * point resets the counter to 0 and sets `extractionDisabled` to `false`.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Property 6
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 8.1, 8.2, 8.3, 8.4
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createBufferWatcher } from '../../src/collector/buffer/watcher.js';

const PROJECT_ID = 'test-project-circuit-breaker';
const MAX_CONSECUTIVE_FAILURES = 3;

describe('Circuit breaker monotonicity and reset (Property 6)', () => {
  it('failure counter increases by 1 on false, resets to 0 on true, and trips after maxConsecutiveFailures', () => {
    /**
     * **Validates: Requirements 8.1, 8.2, 8.3, 8.4**
     *
     * For any sequence of boolean values representing extraction results:
     * - false increments consecutiveFailures by 1
     * - true resets consecutiveFailures to 0 and extractionDisabled to false
     * - After exactly maxConsecutiveFailures consecutive false calls, extractionDisabled is true
     */
    fc.assert(
      fc.property(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 50 }),
        (results) => {
          const watcher = createBufferWatcher({
            maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
          });

          let expectedFailures = 0;

          for (const success of results) {
            watcher.notifyExtractionResult(PROJECT_ID, success);
            const state = watcher._getState(PROJECT_ID);
            expect(state).toBeDefined();

            if (success) {
              // Requirement 8.2: true resets consecutive failure counter to 0
              expectedFailures = 0;
              expect(state!.consecutiveFailures).toBe(0);
              // A single true resets extractionDisabled to false
              expect(state!.extractionDisabled).toBe(false);
            } else {
              // Requirement 8.1: false increments consecutive failure counter by 1
              expectedFailures += 1;
              expect(state!.consecutiveFailures).toBe(expectedFailures);

              // Requirement 8.3: after exactly maxConsecutiveFailures, extractionDisabled is true
              if (expectedFailures >= MAX_CONSECUTIVE_FAILURES) {
                expect(state!.extractionDisabled).toBe(true);
              } else {
                expect(state!.extractionDisabled).toBe(false);
              }
            }
          }

          // Clean up timers
          watcher.close();
        },
      ),
      { numRuns: 200 },
    );
  });
});
