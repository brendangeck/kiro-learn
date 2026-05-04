/**
 * Per-project buffer watcher with idle timer, size threshold, circuit breaker,
 * and hard size ceiling.
 *
 * Monitors buffer activity per project and fires extraction triggers. Runs
 * inside the daemon process. Purely internal — no HTTP surface.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Component 2: BufferWatcher
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 5–9
 */

/**
 * Configuration for the {@link BufferWatcher}.
 *
 * @see Requirements 18.1, 18.2
 */
export interface BufferWatcherConfig {
  /** Idle period before extraction fires (ms). Default 30_000. */
  idleMs: number;
  /** Buffer byte-size threshold for extraction trigger. Default 256 KiB. */
  extractionSizeThreshold: number;
  /** Hard ceiling on buffer size (bytes). Appends are refused above this. Default 4 MiB. */
  bufferMaxBytes: number;
  /** Consecutive extraction failures before circuit breaker trips. Default 3. */
  maxConsecutiveFailures: number;
  /** Buffer byte-size threshold for compaction trigger. Default 1_048_576 (1 MiB). */
  compactionSizeThreshold: number;
}

/**
 * Per-project in-memory state tracked by the watcher.
 *
 * @see design.md § Model 2: BufferWatcherState
 */
export interface ProjectBufferState {
  projectId: string;
  /** Accumulated buffer bytes since last extraction. */
  currentBytes: number;
  /** Node.js timer handle for idle detection. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Whether extraction is currently in-flight. */
  extractionInFlight: boolean;
  /** Timestamp of last append notification. */
  lastActivity: string;
  /** Consecutive extraction failures for circuit breaker. Reset to 0 on success. */
  consecutiveFailures: number;
  /** When true, extraction is disabled for this buffer (circuit breaker tripped). */
  extractionDisabled: boolean;
  /** When true, the hard size ceiling has been hit and a warning was already logged. */
  sizeCeilingWarningLogged: boolean;
  /** Whether compaction is currently in-flight for this project. */
  compactionInFlight: boolean;
  /** Consecutive compaction model failures. Reset on success. */
  compactionModelFailures: number;
}

/**
 * Monitors buffer activity per project and fires extraction triggers.
 *
 * @see Requirements 5.1–5.3, 6.1–6.2, 7.1–7.2, 8.1–8.6, 9.1–9.5
 */
export interface BufferWatcher {
  /**
   * Notify the watcher that bytes have been durably appended to a project
   * buffer. Accumulates bytes, resets the idle timer, and checks the size
   * threshold. Always returns `true` — callers should call
   * {@link wouldExceedCeiling} before the write to decide whether to skip.
   */
  notifyAppend(projectId: string, appendedBytes: number): boolean;

  /**
   * Check whether appending `bytes` to the project buffer would exceed
   * the hard size ceiling. Does not accumulate bytes or reset timers.
   * Logs a warning to stderr on the first ceiling hit per project
   * (sets `sizeCeilingWarningLogged`).
   * Used by the pipeline to gate the write before committing bytes.
   */
  wouldExceedCeiling(projectId: string, bytes: number): boolean;

  /**
   * Report the result of an extraction attempt. Used by ExtractionWorker
   * to drive the circuit breaker: consecutive failures increment the
   * counter; a success resets it to 0.
   */
  notifyExtractionResult(projectId: string, success: boolean): void;

  /** Register a listener for extraction triggers. */
  onExtraction(handler: (projectId: string) => void): void;

  /** Register a listener for compaction triggers. */
  onCompaction(handler: (projectId: string) => void): void;

  /**
   * Report the result of a compaction attempt.
   * On success: updates byte counter to reflect compacted size.
   * On failure: marks compaction as no longer in-flight.
   */
  notifyCompactionResult(projectId: string, success: boolean, newSizeBytes?: number): void;

  /** Shut down all timers and pending triggers. */
  close(): void;

  /**
   * Retrieve the internal per-project state for testing.
   * Prefixed with underscore to indicate test-only usage.
   */
  _getState(projectId: string): ProjectBufferState | undefined;
}

const DEFAULT_CONFIG: BufferWatcherConfig = {
  idleMs: 30_000,
  extractionSizeThreshold: 262_144,
  bufferMaxBytes: 4_194_304,
  maxConsecutiveFailures: 3,
  compactionSizeThreshold: 1_048_576,
};

/**
 * Create a {@link BufferWatcher} that monitors per-project buffer activity.
 *
 * @param config - Partial configuration merged with defaults.
 *
 * @see Requirements 5.1–5.3, 6.1–6.2, 7.1–7.2, 8.1–8.6, 9.1–9.5
 */
export function createBufferWatcher(
  config?: Partial<BufferWatcherConfig>,
): BufferWatcher {
  const resolved: BufferWatcherConfig = { ...DEFAULT_CONFIG, ...config };
  const projects = new Map<string, ProjectBufferState>();
  let extractionHandler: ((projectId: string) => void) | null = null;
  let compactionHandler: ((projectId: string) => void) | null = null;

  /**
   * Get or create the per-project state entry.
   */
  function getOrCreate(projectId: string): ProjectBufferState {
    let state = projects.get(projectId);
    if (state === undefined) {
      state = {
        projectId,
        currentBytes: 0,
        idleTimer: null,
        extractionInFlight: false,
        lastActivity: new Date().toISOString(),
        consecutiveFailures: 0,
        extractionDisabled: false,
        sizeCeilingWarningLogged: false,
        compactionInFlight: false,
        compactionModelFailures: 0,
      };
      projects.set(projectId, state);
    }
    return state;
  }

  /**
   * Internal helper: fire extraction trigger for a project.
   * Skips if extraction is already in-flight or disabled by circuit breaker.
   */
  function fireExtraction(projectId: string): void {
    const state = projects.get(projectId);
    if (state === undefined) return;
    if (state.extractionInFlight || state.extractionDisabled) return;

    state.extractionInFlight = true;

    if (extractionHandler !== null) {
      extractionHandler(projectId);
    }
  }

  /**
   * Internal helper: fire compaction trigger for a project.
   * Skips if compaction is already in-flight.
   */
  function fireCompaction(projectId: string): void {
    const state = projects.get(projectId);
    if (state === undefined) return;
    if (state.compactionInFlight) return;

    state.compactionInFlight = true;

    if (compactionHandler !== null) {
      compactionHandler(projectId);
    }
  }

  return {
    /**
     * Check whether appending `bytes` would exceed the hard size ceiling.
     * Does not accumulate bytes or reset timers. Logs a warning to stderr
     * on the first ceiling hit per project (sets `sizeCeilingWarningLogged`).
     *
     * @see Requirements 9.1, 9.2
     */
    wouldExceedCeiling(projectId: string, bytes: number): boolean {
      const state = getOrCreate(projectId);
      const wouldExceed = state.currentBytes + bytes > resolved.bufferMaxBytes;
      if (wouldExceed && !state.sizeCeilingWarningLogged) {
        process.stderr.write(
          `[kiro-learn] buffer size ceiling hit for project ${projectId} (${state.currentBytes + bytes} bytes) — skipping buffer append\n`,
        );
        state.sizeCeilingWarningLogged = true;
      }
      return wouldExceed;
    },

    /**
     * Notify the watcher of a pending buffer append.
     *
     * 1. Get or create project state
     * 2. Check hard size ceiling — return false if exceeded
     * 3. Accumulate bytes
     * 4. Reset idle timer
     * 5. Check size threshold — fire extraction if crossed
     * 6. Return true
     *
     * @see Requirements 5.1, 6.1, 6.2, 9.1, 9.2, 9.3
     */
    notifyAppend(projectId: string, appendedBytes: number): boolean {
      const state = getOrCreate(projectId);

      // Accumulate bytes.
      state.currentBytes += appendedBytes;
      state.lastActivity = new Date().toISOString();

      // Reset idle timer.
      if (state.idleTimer !== null) {
        clearTimeout(state.idleTimer);
      }
      state.idleTimer = setTimeout(() => {
        state.idleTimer = null;
        fireExtraction(projectId);
      }, resolved.idleMs);

      // Check size threshold — fire extraction if crossed.
      if (state.currentBytes >= resolved.extractionSizeThreshold) {
        fireExtraction(projectId);
      }

      // Check compaction threshold — fire compaction if crossed (independent of extraction).
      if (state.currentBytes > resolved.compactionSizeThreshold) {
        fireCompaction(projectId);
      }

      return true;
    },

    /**
     * Report the result of an extraction attempt.
     *
     * On success: reset failure counter, byte counter, warning flag,
     * and mark extraction as no longer in-flight.
     *
     * On failure: increment failure counter, trip circuit breaker if
     * threshold reached.
     *
     * @see Requirements 7.2, 8.1, 8.2, 8.3, 8.4, 9.5
     */
    notifyExtractionResult(projectId: string, success: boolean): void {
      const state = getOrCreate(projectId);

      state.extractionInFlight = false;

      if (success) {
        state.consecutiveFailures = 0;
        state.extractionDisabled = false;
        state.currentBytes = 0;
        state.sizeCeilingWarningLogged = false;
      } else {
        state.consecutiveFailures += 1;

        if (state.consecutiveFailures >= resolved.maxConsecutiveFailures) {
          state.extractionDisabled = true;
          process.stderr.write(
            `[kiro-learn] circuit breaker tripped for project ${projectId} after ${state.consecutiveFailures} consecutive extraction failures — extraction disabled\n`,
          );
        }
      }
    },

    /**
     * Register a listener for extraction triggers.
     *
     * @see Requirements 5.2, 6.1
     */
    onExtraction(handler: (projectId: string) => void): void {
      extractionHandler = handler;
    },

    /**
     * Register a listener for compaction triggers.
     *
     * @see Requirements 8.1, 8.2
     */
    onCompaction(handler: (projectId: string) => void): void {
      compactionHandler = handler;
    },

    /**
     * Report the result of a compaction attempt.
     *
     * On success: update `currentBytes` to `newSizeBytes`, mark compaction
     * as no longer in-flight.
     *
     * On failure: mark compaction as no longer in-flight.
     *
     * @see Requirements 9.1, 9.2, 9.3
     */
    notifyCompactionResult(projectId: string, success: boolean, newSizeBytes?: number): void {
      const state = getOrCreate(projectId);

      state.compactionInFlight = false;

      if (success) {
        if (newSizeBytes !== undefined) {
          state.currentBytes = newSizeBytes;
        }
      }
    },

    /**
     * Shut down all timers and pending triggers.
     *
     * @see Requirement 13.4, 12.3
     */
    close(): void {
      for (const state of projects.values()) {
        if (state.idleTimer !== null) {
          clearTimeout(state.idleTimer);
          state.idleTimer = null;
        }
        state.compactionInFlight = false;
        state.compactionModelFailures = 0;
      }
    },

    /**
     * Retrieve the internal per-project state for testing.
     */
    _getState(projectId: string): ProjectBufferState | undefined {
      return projects.get(projectId);
    },
  };
}
