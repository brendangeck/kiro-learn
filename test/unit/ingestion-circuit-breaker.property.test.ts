/**
 * Property-based test for the per-project reconciliation circuit
 * breaker — Property 24 from the reconciliation-engine design.
 *
 * **Property 24: Reconciliation circuit breaker state machine.** For
 * any sequence of judge outcomes and run-complete events on a given
 * `projectId`, the breaker:
 *
 *   (a) starts closed,
 *   (b) opens after the Nth consecutive failure (where `N` is the
 *       configured `maxConsecutiveFailures`, default 3),
 *   (c) re-closes after an ingestion run completes with zero judge
 *       failures — including trivially zero-invocation runs (the
 *       direct-commit fallback path self-heals the breaker), and
 *   (d) state is independent per `projectId`.
 *
 * ## Test strategy
 *
 * Rather than assert each clause in isolation, we encode the breaker
 * contract as a tiny pure reference implementation (`applyEvent`) and
 * replay the same event sequence against both the real breaker and
 * the reference. After every event the two states must agree.
 *
 * This captures the full state machine — not just "opens after 3
 * failures" but also "success mid-sequence resets the counter",
 * "success does NOT close an open breaker", "onRunComplete(pid,
 * false) closes and resets", and "onRunComplete(pid, true) is a
 * no-op". Any drift between the implementation and the reference
 * fails the property.
 *
 * ## Multi-project isolation
 *
 * A second property generates events interleaved across two project
 * ids (`p1`, `p2`) and asserts each project's state matches its own
 * independent reference simulation. This pins clause (d).
 *
 * 200 runs per property.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 8.3
 * @see .kiro/specs/reconciliation-engine/design.md § Correctness
 *   Properties — Property 24
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 12.1,
 *   12.2, 12.3
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createReconciliationCircuitBreaker } from '../../src/collector/ingestion/circuit-breaker.js';

// ── Reference model ─────────────────────────────────────────────────────

/** Reference state for a single project. */
interface RefState {
  consecutiveFailures: number;
  open: boolean;
}

/**
 * One event in a replayed breaker history. Mirrors the two
 * mutating methods on {@link ReconciliationCircuitBreaker}.
 */
type Event =
  | { readonly type: 'record'; readonly outcome: 'success' | 'failure' }
  | { readonly type: 'onRunComplete'; readonly anyJudgeFailure: boolean };

/**
 * Pure reference implementation of the breaker's state machine.
 *
 * This mirrors the contract in `circuit-breaker.ts` line-for-line:
 *
 * - `record(success)` resets `consecutiveFailures` to 0 but leaves
 *   `open` untouched.
 * - `record(failure)` increments the counter and opens when it
 *   reaches `maxConsecutiveFailures`. Once open, stays open —
 *   further failures bump the counter but cannot "un-open" anything.
 * - `onRunComplete(false)` fully resets: counter = 0, open = false.
 * - `onRunComplete(true)` is a no-op.
 */
function applyEvent(
  state: RefState,
  event: Event,
  maxConsecutiveFailures: number,
): RefState {
  if (event.type === 'record') {
    if (event.outcome === 'success') {
      return { consecutiveFailures: 0, open: state.open };
    }
    const cf = state.consecutiveFailures + 1;
    return {
      consecutiveFailures: cf,
      open: state.open || cf >= maxConsecutiveFailures,
    };
  }
  // event.type === 'onRunComplete'
  if (event.anyJudgeFailure) return state;
  return { consecutiveFailures: 0, open: false };
}

// ── Arbitrary generators ────────────────────────────────────────────────

/**
 * Arbitrary `Event` — 50/50 split between `record` and
 * `onRunComplete`. Outcomes inside each branch are also generated
 * uniformly so long runs naturally exercise both the
 * counter-incrementing and the counter-resetting paths.
 */
const arbEvent: fc.Arbitrary<Event> = fc.oneof(
  fc.record({
    type: fc.constant('record' as const),
    outcome: fc.constantFrom('success' as const, 'failure' as const),
  }),
  fc.record({
    type: fc.constant('onRunComplete' as const),
    anyJudgeFailure: fc.boolean(),
  }),
);

/**
 * Arbitrary event tagged with a project id — used by the multi-
 * project isolation property. The pool of project ids is small (`p1`,
 * `p2`) so generated sequences naturally interleave the two.
 */
const arbTaggedEvent: fc.Arbitrary<{
  readonly projectId: 'p1' | 'p2';
  readonly event: Event;
}> = fc.record({
  projectId: fc.constantFrom('p1' as const, 'p2' as const),
  event: arbEvent,
});

// ── Property 24, single-project form ────────────────────────────────────

describe('Property 24: reconciliation circuit breaker state machine', () => {
  it(
    'matches the reference state machine for any event sequence on one project',
    () => {
      /**
       * **Validates: Requirements 12.1, 12.2, 12.3**
       *
       * For any `maxConsecutiveFailures ∈ [1, 5]` and any sequence of
       * `Event`s (record success/failure, onRunComplete with or
       * without judge failure), the breaker's state after each event
       * equals the reference implementation's state. This captures:
       *
       * - Clause (a): both start at `{ consecutiveFailures: 0, open:
       *   false }` for the first-seen project id.
       * - Clause (b): the Nth consecutive failure opens the breaker,
       *   and anything lower does not.
       * - Clause (c): `onRunComplete(false)` fully resets to the
       *   starting state, including from an already-open breaker.
       *   Zero-invocation runs (sequences that never `record`) still
       *   trigger the reset.
       *
       * We sweep `maxConsecutiveFailures` from 1 to 5 so the property
       * exercises the threshold boundary more than once; the
       * requirement pins default 3 but the breaker's generalisation
       * is worth protecting against drift.
       */
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.array(arbEvent, { minLength: 0, maxLength: 50 }),
          (maxConsecutiveFailures, events) => {
            const breaker = createReconciliationCircuitBreaker(maxConsecutiveFailures);
            let refState: RefState = { consecutiveFailures: 0, open: false };

            // Starting invariant — clause (a).
            expect(breaker.isOpen('p1')).toBe(false);
            expect(breaker._state('p1')).toEqual(refState);

            for (const event of events) {
              if (event.type === 'record') {
                breaker.record('p1', event.outcome);
              } else {
                breaker.onRunComplete('p1', event.anyJudgeFailure);
              }
              refState = applyEvent(refState, event, maxConsecutiveFailures);

              expect(breaker._state('p1')).toEqual(refState);
              expect(breaker.isOpen('p1')).toBe(refState.open);
            }
          },
        ),
        { numRuns: 200 },
      );
    },
  );

  // ── Property 24, multi-project isolation form ──────────────────────

  it(
    'state is independent per projectId across interleaved sequences',
    () => {
      /**
       * **Validates: Requirements 12.1, 12.2, 12.3 — clause (d)**
       *
       * For any sequence of events tagged with project ids drawn from
       * `{ 'p1', 'p2' }`, replaying against the breaker yields a
       * state for each project id that matches that project's
       * independent reference simulation. An event tagged `p1` never
       * influences `p2`'s state and vice versa.
       */
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.array(arbTaggedEvent, { minLength: 0, maxLength: 80 }),
          (maxConsecutiveFailures, taggedEvents) => {
            const breaker = createReconciliationCircuitBreaker(maxConsecutiveFailures);
            const refStates = new Map<'p1' | 'p2', RefState>([
              ['p1', { consecutiveFailures: 0, open: false }],
              ['p2', { consecutiveFailures: 0, open: false }],
            ]);

            // Starting invariant for both projects.
            expect(breaker._state('p1')).toEqual(refStates.get('p1'));
            expect(breaker._state('p2')).toEqual(refStates.get('p2'));

            for (const { projectId, event } of taggedEvents) {
              if (event.type === 'record') {
                breaker.record(projectId, event.outcome);
              } else {
                breaker.onRunComplete(projectId, event.anyJudgeFailure);
              }
              const current = refStates.get(projectId);
              if (current === undefined) {
                throw new Error('unreachable — projectId drawn from constantFrom');
              }
              refStates.set(projectId, applyEvent(current, event, maxConsecutiveFailures));

              // Both projects are checked on every event so that a
              // cross-talk bug ("recording against p1 also moved
              // p2's counter") surfaces immediately.
              expect(breaker._state('p1')).toEqual(refStates.get('p1'));
              expect(breaker._state('p2')).toEqual(refStates.get('p2'));
            }
          },
        ),
        { numRuns: 200 },
      );
    },
  );
});
