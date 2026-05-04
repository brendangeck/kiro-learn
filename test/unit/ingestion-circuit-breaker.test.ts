/**
 * Unit tests for the per-project reconciliation circuit breaker.
 *
 * The breaker is a tiny state machine — four methods, one integer
 * counter per project id, one boolean flag. These tests pin down
 * each state transition in isolation:
 *
 * - Fresh breakers start closed for every project id.
 * - Exactly `maxConsecutiveFailures` failures trip the breaker; one
 *   fewer does not.
 * - `record(pid, 'success')` mid-sequence resets the counter to 0,
 *   so reaching the threshold again requires a fresh streak.
 * - `record(pid, 'success')` does NOT close an already-tripped
 *   breaker — closing is reserved for `onRunComplete(pid, false)`.
 * - `onRunComplete(pid, false)` closes the breaker and resets the
 *   counter, including the "direct-commit had zero judge
 *   invocations" self-heal path (Requirement 12.3).
 * - `onRunComplete(pid, true)` is a no-op — the per-call
 *   `record(...)` invocations during the run already moved the
 *   counter.
 * - Per-project isolation: failures recorded against `p1` never
 *   influence the breaker for `p2`.
 * - The default `maxConsecutiveFailures === 3`, but a custom value
 *   (e.g. 2) works: the breaker opens after exactly that many
 *   consecutive failures.
 * - `_state(unknown_project)` returns the implicit starting state
 *   `{ consecutiveFailures: 0, open: false }`.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 8.2
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 12.1,
 *   12.2, 12.3
 */

import { describe, expect, it } from 'vitest';

import { createReconciliationCircuitBreaker } from '../../src/collector/ingestion/circuit-breaker.js';

describe('createReconciliationCircuitBreaker', () => {
  it('starts closed for an unseen project', () => {
    const breaker = createReconciliationCircuitBreaker();
    expect(breaker.isOpen('p1')).toBe(false);
  });

  it('opens after 3 consecutive failures at the default threshold', () => {
    const breaker = createReconciliationCircuitBreaker();

    breaker.record('p1', 'failure');
    expect(breaker.isOpen('p1')).toBe(false);

    breaker.record('p1', 'failure');
    expect(breaker.isOpen('p1')).toBe(false);

    breaker.record('p1', 'failure');
    expect(breaker.isOpen('p1')).toBe(true);
  });

  it('2 failures do not open the breaker at the default threshold', () => {
    const breaker = createReconciliationCircuitBreaker();

    breaker.record('p1', 'failure');
    breaker.record('p1', 'failure');

    expect(breaker.isOpen('p1')).toBe(false);
    expect(breaker._state('p1')).toEqual({ consecutiveFailures: 2, open: false });
  });

  it('record(success) mid-sequence resets consecutiveFailures to 0', () => {
    const breaker = createReconciliationCircuitBreaker();

    breaker.record('p1', 'failure');
    breaker.record('p1', 'failure');
    breaker.record('p1', 'success');

    expect(breaker._state('p1')).toEqual({ consecutiveFailures: 0, open: false });

    // Two more failures are not enough to trip the breaker — the
    // successful call reset the streak so 3 fresh failures are
    // required.
    breaker.record('p1', 'failure');
    breaker.record('p1', 'failure');
    expect(breaker.isOpen('p1')).toBe(false);

    breaker.record('p1', 'failure');
    expect(breaker.isOpen('p1')).toBe(true);
  });

  it('record(success) does NOT close an already-open breaker', () => {
    const breaker = createReconciliationCircuitBreaker();

    breaker.record('p1', 'failure');
    breaker.record('p1', 'failure');
    breaker.record('p1', 'failure');
    expect(breaker.isOpen('p1')).toBe(true);

    // Success resets the counter but leaves the breaker tripped —
    // closing is reserved for `onRunComplete(pid, false)` so the
    // breaker only reopens/recloses at whole-run granularity.
    breaker.record('p1', 'success');
    expect(breaker._state('p1')).toEqual({ consecutiveFailures: 0, open: true });
    expect(breaker.isOpen('p1')).toBe(true);
  });

  it('onRunComplete(pid, false) closes the breaker and resets the counter', () => {
    const breaker = createReconciliationCircuitBreaker();

    breaker.record('p1', 'failure');
    breaker.record('p1', 'failure');
    breaker.record('p1', 'failure');
    expect(breaker.isOpen('p1')).toBe(true);

    breaker.onRunComplete('p1', false);
    expect(breaker._state('p1')).toEqual({ consecutiveFailures: 0, open: false });
    expect(breaker.isOpen('p1')).toBe(false);
  });

  it('onRunComplete(pid, false) on an unseen project leaves state at the implicit default', () => {
    // The direct-commit fallback path has zero judge invocations, so
    // end-of-run always reports `anyJudgeFailure === false`. Even for
    // a project the breaker has never seen, the call must not raise
    // and the state must stay at the closed default.
    const breaker = createReconciliationCircuitBreaker();
    breaker.onRunComplete('p-never-seen', false);
    expect(breaker._state('p-never-seen')).toEqual({
      consecutiveFailures: 0,
      open: false,
    });
  });

  it('onRunComplete(pid, true) does NOT close an open breaker', () => {
    const breaker = createReconciliationCircuitBreaker();

    breaker.record('p1', 'failure');
    breaker.record('p1', 'failure');
    breaker.record('p1', 'failure');
    expect(breaker.isOpen('p1')).toBe(true);

    breaker.onRunComplete('p1', true);
    // State is unchanged — `anyJudgeFailure === true` means the
    // individual `record(...)` calls already did the bookkeeping.
    expect(breaker._state('p1')).toEqual({ consecutiveFailures: 3, open: true });
    expect(breaker.isOpen('p1')).toBe(true);
  });

  it('onRunComplete(pid, true) is a no-op on a closed breaker too', () => {
    const breaker = createReconciliationCircuitBreaker();

    breaker.record('p1', 'failure');
    breaker.onRunComplete('p1', true);

    // `onRunComplete(pid, true)` should not mutate state regardless
    // of whether the breaker is open or closed — it exists to signal
    // "the run had at least one judge failure, but I already told
    // you via record(...)". The counter must be preserved.
    expect(breaker._state('p1')).toEqual({ consecutiveFailures: 1, open: false });
  });

  it('state is independent per project id', () => {
    const breaker = createReconciliationCircuitBreaker();

    // Trip p1.
    breaker.record('p1', 'failure');
    breaker.record('p1', 'failure');
    breaker.record('p1', 'failure');

    expect(breaker.isOpen('p1')).toBe(true);
    expect(breaker.isOpen('p2')).toBe(false);
    expect(breaker._state('p2')).toEqual({ consecutiveFailures: 0, open: false });

    // p2 can now fail twice without tripping — p1's streak does not
    // carry over.
    breaker.record('p2', 'failure');
    breaker.record('p2', 'failure');
    expect(breaker.isOpen('p2')).toBe(false);

    // p1 stays tripped.
    expect(breaker.isOpen('p1')).toBe(true);
  });

  it('supports a custom maxConsecutiveFailures threshold', () => {
    const breaker = createReconciliationCircuitBreaker(2);

    breaker.record('p1', 'failure');
    expect(breaker.isOpen('p1')).toBe(false);

    breaker.record('p1', 'failure');
    expect(breaker.isOpen('p1')).toBe(true);
  });

  it('_state(unknown_project) returns the implicit starting state', () => {
    const breaker = createReconciliationCircuitBreaker();
    expect(breaker._state('never-seen')).toEqual({
      consecutiveFailures: 0,
      open: false,
    });
  });

  it('_state returns a defensive copy — mutating it does not affect the breaker', () => {
    const breaker = createReconciliationCircuitBreaker();

    breaker.record('p1', 'failure');

    const snapshot = breaker._state('p1');
    snapshot.consecutiveFailures = 999;
    snapshot.open = true;

    // Internal state is untouched.
    expect(breaker._state('p1')).toEqual({ consecutiveFailures: 1, open: false });
    expect(breaker.isOpen('p1')).toBe(false);
  });
});
