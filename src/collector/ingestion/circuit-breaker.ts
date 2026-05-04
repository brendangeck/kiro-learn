/**
 * Per-project reconciliation circuit breaker.
 *
 * The reconciler invokes the `kiro-learn-reconciler` judge over ACP
 * for every Candidate Cluster that has at least one neighbor. Judge
 * calls can fail in two ways: they can time out (Requirement 6.6) or
 * return non-XML / unparseable output after the retry budget
 * (Requirements 6.7, 12.2). Both failure modes feed this circuit
 * breaker so that a persistently sick judge degrades gracefully into
 * the direct-commit fallback path (Requirement 1.6) rather than
 * stalling the ingestion pipeline indefinitely.
 *
 * ## Contract
 *
 * - Per-project state: each project id carries an independent
 *   `{ consecutiveFailures, open }` pair. Failures on one project
 *   never influence another (Requirement 12 — per-project isolation).
 * - Fresh projects start closed: `isOpen(pid) === false` until the
 *   first call records a state transition.
 * - {@link ReconciliationCircuitBreaker.record | record}`(pid,
 *   'failure')` increments `consecutiveFailures`. When the counter
 *   reaches `maxConsecutiveFailures` (default 3 — Requirement 12.3),
 *   the breaker opens.
 * - `record(pid, 'success')` resets `consecutiveFailures` to 0 but
 *   does NOT close an already-open breaker. Closing is reserved for
 *   {@link ReconciliationCircuitBreaker.onRunComplete | onRunComplete}
 *   so the breaker can only reopen-and-reclose at ingestion-run
 *   granularity. This matches Requirement 12.3's "one subsequent
 *   ingestion-pipeline run completes without a Judge Model failure"
 *   wording: the reset is anchored to whole runs, not to individual
 *   judge calls mid-run.
 * - {@link ReconciliationCircuitBreaker.onRunComplete | onRunComplete}
 *   is called by the `IngestionPipeline` at the end of every
 *   successful run. When `anyJudgeFailure === false` the breaker
 *   closes (`open = false`, `consecutiveFailures = 0`). A trivially
 *   zero-judge-invocation run — which happens on the direct-commit
 *   fallback path because that path bypasses the judge entirely —
 *   still counts as "no judge failure" and closes the breaker. That
 *   self-healing property is what lets a tripped breaker recover
 *   after one clean direct-commit run (Requirement 12.3).
 * - `onRunComplete(pid, true)` is a no-op: the per-call `record(...)`
 *   invocations already moved the counter, so no additional
 *   bookkeeping is needed.
 *
 * ## Purity
 *
 * This module performs no I/O, no logging, and has no imports beyond
 * the TypeScript standard library. It sits at
 * `src/collector/ingestion/` and MUST NOT import from
 * `src/collector/storage/sqlite/` — the modularity-guard test suite
 * pins this constraint for every leaf module under `ingestion/`.
 *
 * @see .kiro/specs/reconciliation-engine/design.md § Components and
 *   Interfaces — `circuit-breaker.ts` — per-project reconciliation
 *   circuit breaker
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 12.1,
 *   12.2, 12.3
 * @module
 */

// ── Public types ────────────────────────────────────────────────────────

/**
 * Per-project judge circuit breaker exposed by
 * {@link createReconciliationCircuitBreaker}.
 *
 * The interface is intentionally tiny — four methods — because the
 * reconciler is the only caller and every method maps directly to a
 * control-flow edge in `IngestionPipeline.run`. The final `_state`
 * accessor is reserved for tests and debug logs and SHOULD NOT be
 * used in production code paths.
 */
export interface ReconciliationCircuitBreaker {
  /**
   * `true` when this project's breaker is tripped and the
   * `IngestionPipeline` should take the direct-commit fallback path
   * for the upcoming run (Requirement 12.3).
   *
   * Unknown project ids are treated as closed (`false`). This matches
   * the "closed at start" invariant: the breaker carries no state for
   * a project it has never seen.
   */
  isOpen(projectId: string): boolean;

  /**
   * Record a single judge outcome for the project's current ingestion
   * run.
   *
   * - `'failure'` increments the per-project consecutive-failure
   *   counter. When it reaches `maxConsecutiveFailures` (default 3)
   *   the breaker opens.
   * - `'success'` resets the counter to 0. It does NOT close an
   *   already-open breaker — a tripped breaker only self-heals via
   *   {@link ReconciliationCircuitBreaker.onRunComplete | onRunComplete}
   *   at end-of-run.
   */
  record(projectId: string, outcome: 'success' | 'failure'): void;

  /**
   * End-of-run hook called by `IngestionPipeline` after each
   * successful run. When `anyJudgeFailure` is `false` the breaker
   * closes for this project (including the direct-commit trivially-
   * zero-invocation case — Requirement 12.3).
   *
   * When `anyJudgeFailure` is `true` this is a no-op: the per-call
   * `record(...)` invocations already carried the counter forward.
   */
  onRunComplete(projectId: string, anyJudgeFailure: boolean): void;

  /**
   * Test-only accessor returning a defensive copy of the internal
   * state for a project. Unknown project ids return the implicit
   * starting state `{ consecutiveFailures: 0, open: false }`.
   *
   * The returned object is a fresh allocation — callers cannot
   * mutate internal state through it.
   */
  _state(projectId: string): { consecutiveFailures: number; open: boolean };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Create a fresh reconciliation circuit breaker with independent
 * state per project id.
 *
 * @param maxConsecutiveFailures - The number of consecutive judge
 *   failures that trips the breaker. Defaults to 3 to match
 *   Requirement 12.3 ("3 consecutive Judge Model failures"). Values
 *   `<= 0` would make the breaker trip on the first failure, which is
 *   legal but should only be used in tests; the function does not
 *   validate the argument.
 * @returns A new breaker — starts closed for every project id.
 */
export function createReconciliationCircuitBreaker(
  maxConsecutiveFailures = 3,
): ReconciliationCircuitBreaker {
  /**
   * Per-project state. Unknown projects are implicitly
   * `{ consecutiveFailures: 0, open: false }` — the map is populated
   * lazily on first `record(...)` or `onRunComplete(...)` call.
   */
  const projects = new Map<string, { consecutiveFailures: number; open: boolean }>();

  /**
   * Fetch (or lazily create) the mutable state object for a project.
   *
   * Returning a reference to the in-map object is fine here because
   * the only callers are this module's own methods — external callers
   * go through `_state(...)`, which returns a defensive copy.
   */
  function getOrInit(projectId: string): {
    consecutiveFailures: number;
    open: boolean;
  } {
    let state = projects.get(projectId);
    if (state === undefined) {
      state = { consecutiveFailures: 0, open: false };
      projects.set(projectId, state);
    }
    return state;
  }

  return {
    isOpen(projectId: string): boolean {
      return projects.get(projectId)?.open ?? false;
    },

    record(projectId: string, outcome: 'success' | 'failure'): void {
      const state = getOrInit(projectId);
      if (outcome === 'success') {
        // Reset the counter but leave `open` alone. An already-tripped
        // breaker stays tripped until an end-of-run reset arrives via
        // `onRunComplete(pid, false)` — see the contract note in the
        // module header for why this is intentional.
        state.consecutiveFailures = 0;
        return;
      }
      // outcome === 'failure'
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures >= maxConsecutiveFailures) {
        state.open = true;
      }
    },

    onRunComplete(projectId: string, anyJudgeFailure: boolean): void {
      if (anyJudgeFailure) {
        // Per-run bookkeeping only — the individual `record(...)`
        // calls during the run already moved the counter.
        return;
      }
      // Clean run → close the breaker and reset the counter. This
      // path fires on both "reconciliation ran and every judge call
      // succeeded" and "run took the direct-commit fallback so the
      // judge was never invoked" — both satisfy Requirement 12.3's
      // "one subsequent ingestion-pipeline run completes without a
      // Judge Model failure".
      const state = getOrInit(projectId);
      state.consecutiveFailures = 0;
      state.open = false;
    },

    _state(projectId: string): { consecutiveFailures: number; open: boolean } {
      const state = projects.get(projectId);
      if (state === undefined) {
        return { consecutiveFailures: 0, open: false };
      }
      // Defensive copy so tests cannot mutate internal state through
      // this accessor.
      return { consecutiveFailures: state.consecutiveFailures, open: state.open };
    },
  };
}
