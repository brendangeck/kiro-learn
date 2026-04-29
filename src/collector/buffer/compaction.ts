/**
 * Buffer compaction — CompactionWorker, XML response parser, and utilities.
 *
 * This module provides:
 * - `CompactionWorker` — background worker that summarizes oversized buffers
 *   via a cheap/fast model call, atomically replacing buffer contents with
 *   fewer, denser entries. Serial across projects with per-project reentrance
 *   guard and circuit breaker for model failures.
 * - `createCompactionWorker` — factory function accepting dependencies via DI.
 * - `parseCompactionResponse` — extracts summary strings from
 *   `<compacted_entry>` XML blocks returned by the compaction model.
 * - `deterministicEviction` — fallback compaction strategy that keeps
 *   the most recent half of buffer entries by timestamp.
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Components 1–4
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirements 1–5, 10, 13, 18
 *
 * @module
 */

import { ulid } from 'ulidx';

import { createAcpSession } from '../pipeline/acp-client.js';
import { frameBatch } from '../pipeline/xml-framer.js';

import type { BufferEntry } from './types.js';
import type { BufferStore } from './store.js';
import type { BufferWatcher } from './watcher.js';

// ── Regex patterns ──────────────────────────────────────────────────────

/** Matches `<compacted_entry>...</compacted_entry>` blocks (non-greedy). */
const COMPACTED_ENTRY_RE =
  /<compacted_entry>([\s\S]*?)<\/compacted_entry>/g;

// ── XML unescape ────────────────────────────────────────────────────────

/**
 * Convert XML entity references back to their original characters.
 *
 * Order matters: `&amp;` must be replaced **last** to avoid prematurely
 * converting `&amp;lt;` → `&lt;` → `<`.
 */
function unescapeXml(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Parse compaction model response text, extracting summary strings from
 * `<compacted_entry>` XML blocks.
 *
 * Returns an array of trimmed, XML-unescaped summary strings. Blocks
 * whose content is empty or whitespace-only after trimming are skipped.
 * Returns an empty array for empty input or input with no matching blocks.
 *
 * @see Requirements 10.1, 10.2, 10.3, 10.4
 */
export function parseCompactionResponse(responseText: string): string[] {
  const results: string[] = [];

  // Reset lastIndex for the global regex
  COMPACTED_ENTRY_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = COMPACTED_ENTRY_RE.exec(responseText)) !== null) {
    const content = match[1]?.trim();
    if (content) {
      results.push(unescapeXml(content));
    }
  }

  return results;
}

/**
 * Deterministic eviction fallback: keep the most recent half of buffer
 * entries by timestamp, dropping the oldest.
 *
 * This is used when model-based compaction fails repeatedly. It requires
 * no model call — entries are sorted by timestamp descending and the top
 * `Math.ceil(entries.length / 2)` are returned.
 *
 * The input array is not mutated. Returned entries are original references
 * from the input (no fabrication or duplication).
 *
 * @param entries - Non-empty readonly array of buffer entries.
 * @returns The most recent half of entries (rounded up).
 *
 * @see Requirements 4.1, 4.2, 4.3
 */
export function deterministicEviction(
  entries: readonly BufferEntry[],
): BufferEntry[] {
  const keepCount = Math.ceil(entries.length / 2);
  const sorted = [...entries].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  );
  return sorted.slice(0, keepCount);
}

// ── CompactionWorker types ──────────────────────────────────────────────

/**
 * Result of a single compaction operation.
 *
 * @see Requirements 1.3, 1.4, 4.4
 */
export interface CompactionResult {
  projectId: string;
  /** Number of entries in the original buffer snapshot. */
  entriesBefore: number;
  /** Number of entries after compaction (compacted + catch-up). */
  entriesAfter: number;
  /** Bytes saved by compaction. */
  bytesSaved: number;
  /** Duration of the model call in milliseconds. */
  modelDurationMs: number;
  /** Duration of the catch-up-and-rename step in milliseconds. */
  replaceDurationMs: number;
  /** Whether deterministic eviction was used instead of model compaction. */
  usedFallback: boolean;
}

/**
 * Configuration for the {@link CompactionWorker}.
 *
 * @see Requirements 3.5, 3.6, 5.3, 11.1, 11.2
 */
export interface CompactionWorkerConfig {
  /** Per-compaction timeout for the model call in milliseconds. Default 120_000 (2 min). */
  modelTimeoutMs: number;
  /** Maximum retry attempts for model-based compaction before falling back. Default 2. */
  maxModelRetries: number;
  /** Consecutive model failures before switching to deterministic eviction. Default 3. */
  maxConsecutiveModelFailures: number;
  /** Whether compaction is enabled. Default false (off for non-local models). */
  enabled: boolean;
}

/**
 * Background worker that summarizes oversized buffers via a cheap/fast
 * model call, atomically replacing buffer contents with fewer, denser
 * entries. Serial across projects with per-project reentrance guard.
 *
 * @see Requirements 1.1–1.6, 2.1–2.3
 */
export interface CompactionWorker {
  /**
   * Run compaction for a project buffer.
   * Reads snapshot, calls model for summarization, atomically replaces buffer.
   * Returns result with metrics. Acquires reentrance guard — concurrent
   * calls for any project are rejected immediately.
   */
  compact(projectId: string): Promise<CompactionResult>;

  /** Wait for any in-flight compaction to complete (with timeout). */
  drain(timeoutMs: number): Promise<void>;

  /** Whether a compaction is currently in-flight (any project). */
  readonly active: boolean;
}

// ── Default config ──────────────────────────────────────────────────────

const DEFAULT_COMPACTION_CONFIG: CompactionWorkerConfig = {
  modelTimeoutMs: 120_000,
  maxModelRetries: 2,
  maxConsecutiveModelFailures: 3,
  enabled: false,
};

// ── Dependencies ────────────────────────────────────────────────────────

/**
 * Dependencies injected into the compaction worker factory.
 */
export interface CompactionWorkerDeps {
  bufferStore: BufferStore;
  watcher: BufferWatcher;
  config?: Partial<CompactionWorkerConfig>;
}

// ── Compaction prompt ───────────────────────────────────────────────────

/**
 * Build the compaction prompt from framed XML observations.
 *
 * @see design.md § Compaction Agent Configuration
 */
function buildCompactionPrompt(xmlPayload: string): string {
  return [
    '<compaction_request>',
    '  <instructions>',
    '    Summarize the following tool observations into fewer, denser entries.',
    '    Preserve all important decisions, errors, patterns, and discoveries.',
    '    Merge related observations. Drop redundant or low-value entries.',
    '    Output each summary as a <compacted_entry> block.',
    '  </instructions>',
    '  <observations>',
    xmlPayload,
    '  </observations>',
    '</compaction_request>',
  ].join('\n');
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create a {@link CompactionWorker} that summarizes oversized buffers.
 *
 * Dependencies are injected via the `deps` parameter — the worker never
 * imports from `storage/sqlite/` directly.
 *
 * @see Requirements 1.1–1.6, 2.1–2.3, 3.1–3.6, 4.1–4.4, 5.1–5.4, 13.1–13.3, 17.1
 */
export function createCompactionWorker(deps: CompactionWorkerDeps): CompactionWorker {
  const { bufferStore, watcher } = deps;
  const config: CompactionWorkerConfig = { ...DEFAULT_COMPACTION_CONFIG, ...deps.config };

  // ── In-memory state ─────────────────────────────────────────────────
  let inFlight = false;
  let currentProjectId: string | null = null;
  const modelFailures = new Map<string, number>();

  // Promise that resolves when the current in-flight compaction completes.
  // Used by drain() to wait for completion.
  let inFlightPromise: Promise<CompactionResult> | null = null;

  /**
   * Attempt model-based compaction: frame entries as XML, send to the
   * `kiro-learn-compactor` ACP agent, parse response, and construct
   * BufferEntry objects from the summaries.
   *
   * Retries up to `config.maxModelRetries` times. On final failure, throws
   * so the caller can fall back to deterministic eviction.
   *
   * @see Requirements 3.1–3.6
   */
  async function modelCompaction(
    entries: readonly BufferEntry[],
  ): Promise<BufferEntry[]> {
    const firstEntry = entries[0]!;
    const namespace = firstEntry.namespace;
    const surface = firstEntry.surface;
    const latestTimestamp = entries.reduce(
      (latest, e) => (e.timestamp > latest ? e.timestamp : latest),
      firstEntry.timestamp,
    );

    // Frame entries as XML for the compaction prompt
    const xmlPayload = frameBatch(entries as BufferEntry[]);
    const prompt = buildCompactionPrompt(xmlPayload);

    // Retry loop
    for (let attempt = 0; attempt < config.maxModelRetries; attempt++) {
      let session: Awaited<ReturnType<typeof createAcpSession>> | null = null;
      try {
        session = await createAcpSession({
          agentName: 'kiro-learn-compactor',
          timeoutMs: config.modelTimeoutMs,
        });

        const responseText = await session.sendPrompt(prompt);

        // Parse response — expect <compacted_entry> blocks
        const compacted = parseCompactionResponse(responseText);

        if (compacted.length === 0) {
          throw new Error('model returned no compacted entries');
        }

        // Convert parsed summaries to BufferEntry objects
        return compacted.map((summary) => ({
          event_id: `compact_${ulid()}`,
          namespace,
          kind: 'session_summary' as const,
          body: { type: 'text' as const, content: summary },
          timestamp: latestTimestamp,
          surface,
        }));
      } catch (error: unknown) {
        if (attempt === config.maxModelRetries - 1) throw error;
        // Otherwise retry
      } finally {
        session?.destroy();
      }
    }

    // Should not reach here, but satisfy TypeScript
    throw new Error('model compaction failed after all retries');
  }

  /**
   * Core compaction flow for a single project.
   *
   * @see Requirements 1.1–1.5, 2.1–2.2, 4.1, 5.1–5.3, 13.1–13.3
   */
  async function doCompact(projectId: string): Promise<CompactionResult> {
    // 1. Read snapshot and record byte offset S0
    const entries = await bufferStore.snapshot(projectId);
    const s0 = bufferStore.sizeSync(projectId);

    if (entries.length === 0) {
      watcher.notifyCompactionResult(projectId, true, 0);
      return {
        projectId,
        entriesBefore: 0,
        entriesAfter: 0,
        bytesSaved: 0,
        modelDurationMs: 0,
        replaceDurationMs: 0,
        usedFallback: false,
      };
    }

    // 2. Attempt model-based compaction (or circuit-breaker fallback)
    let compactedEntries: BufferEntry[];
    let usedFallback = false;
    const modelStart = Date.now();

    const failures = modelFailures.get(projectId) ?? 0;
    if (failures >= config.maxConsecutiveModelFailures) {
      // Circuit breaker tripped — use deterministic eviction directly
      compactedEntries = deterministicEviction(entries);
      usedFallback = true;
    } else {
      try {
        compactedEntries = await modelCompaction(entries);
      } catch (error: unknown) {
        // Model failed — increment failure counter and fall back
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[kiro-learn] compaction model failed for project ${projectId}: ${message}\n`,
        );
        modelFailures.set(projectId, failures + 1);
        compactedEntries = deterministicEviction(entries);
        usedFallback = true;
      }
    }
    const modelDurationMs = Date.now() - modelStart;

    // 3. Atomic replace with catch-up
    const replaceStart = Date.now();
    const result = await bufferStore.replace(projectId, compactedEntries, s0);
    const replaceDurationMs = Date.now() - replaceStart;

    // 4. Reset model failure counter on success (if model was used)
    if (!usedFallback) {
      modelFailures.set(projectId, 0);
    }

    const entriesAfter = compactedEntries.length + result.catchUpEntries.length;
    const bytesSaved = s0 - result.newSizeBytes;

    // 5. Notify watcher of success
    watcher.notifyCompactionResult(projectId, true, result.newSizeBytes);

    return {
      projectId,
      entriesBefore: entries.length,
      entriesAfter,
      bytesSaved: Math.max(0, bytesSaved),
      modelDurationMs,
      replaceDurationMs,
      usedFallback,
    };
  }

  return {
    get active(): boolean {
      return inFlight;
    },

    /**
     * Run compaction for a project buffer.
     *
     * Acquires the reentrance guard — concurrent calls are rejected
     * immediately. The guard is released in the `finally` block even
     * if the compaction fails.
     *
     * @see Requirements 1.1–1.5, 2.1–2.3
     */
    compact(projectId: string): Promise<CompactionResult> {
      // Reentrance guard: reject if any compaction is already in-flight
      if (inFlight) {
        return Promise.reject(
          new Error(`compaction already in-flight for project ${currentProjectId ?? 'unknown'}`),
        );
      }

      inFlight = true;
      currentProjectId = projectId;

      const promise = doCompact(projectId)
        .catch((error: unknown) => {
          // Notify watcher of failure
          watcher.notifyCompactionResult(projectId, false);

          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(
            `[kiro-learn] compaction failed for project ${projectId}: ${message}\n`,
          );

          throw error;
        })
        .finally(() => {
          inFlight = false;
          currentProjectId = null;
          inFlightPromise = null;
        });

      inFlightPromise = promise;
      return promise;
    },

    /**
     * Wait for any in-flight compaction to complete or until the
     * specified timeout expires.
     *
     * @see Requirement 1.6
     */
    drain(drainTimeoutMs: number): Promise<void> {
      if (inFlightPromise === null) {
        return Promise.resolve();
      }

      const allDone = inFlightPromise.then(
        () => { /* resolved */ },
        () => { /* swallow rejection — drain should not throw */ },
      );

      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, drainTimeoutMs);
      });

      return Promise.race([allDone, timeout]);
    },
  };
}
