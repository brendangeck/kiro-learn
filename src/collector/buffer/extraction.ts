/**
 * ExtractionWorker — reads per-project buffer snapshots, sends batch XML
 * prompts to the compressor agent via ACP, parses the response into memory
 * records, and stores them.
 *
 * Replaces the per-event {@link ExtractionStage} as the extraction mechanism
 * when buffer mode is enabled. Uses the same semaphore-based concurrency
 * pattern as the existing stage.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Component 3: ExtractionWorker
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 10, 11
 */

import { ulid } from 'ulidx';

import { parseMemoryRecord } from '../../types/index.js';
import type { StorageBackend } from '../../types/index.js';
import { createAcpSession } from '../pipeline/acp-client.js';
import type { AcpSession } from '../pipeline/acp-client.js';
import { frameEvent } from '../pipeline/xml-framer.js';
import { parseMemoryXml, isGarbageResponse } from '../pipeline/xml-parser.js';
import type { RawMemoryFields } from '../pipeline/xml-parser.js';
import type { BufferStore } from './store.js';
import type { BufferEntry } from './types.js';
import type { BufferWatcher } from './watcher.js';

// ── Public types ────────────────────────────────────────────────────────

/**
 * Result of a single project extraction.
 *
 * @see Requirements 10.1–10.8
 */
export interface ExtractionResult {
  projectId: string;
  eventsProcessed: number;
  memoriesCreated: number;
  durationMs: number;
}

/**
 * Configuration for the {@link ExtractionWorker}.
 *
 * @see Requirements 11.1, 11.2, 11.3, 18.2
 */
export interface ExtractionWorkerConfig {
  /** Maximum concurrent extractions across all projects. Default 2. */
  concurrency: number;
  /** Per-extraction timeout in milliseconds. Default 60_000. */
  timeoutMs: number;
  /** Maximum retry attempts for transient failures. Default 3. */
  maxRetries: number;
}

/**
 * Batch extraction worker that reads buffer snapshots and produces memory
 * records via ACP.
 *
 * @see Requirements 10.1–10.8, 11.1–11.4
 */
export interface ExtractionWorker {
  /** Run extraction for a project. Reads buffer, calls LLM, stores memories. */
  extract(projectId: string): Promise<ExtractionResult>;
  /** Wait for all in-flight extractions to complete (with timeout). */
  drain(timeoutMs: number): Promise<void>;
  /** Number of currently active extractions. Exposed for testing. */
  readonly active: number;
}

// ── Default config ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: ExtractionWorkerConfig = {
  concurrency: 2,
  timeoutMs: 60_000,
  maxRetries: 3,
};

// ── Dependencies ────────────────────────────────────────────────────────

/**
 * Dependencies injected into the extraction worker factory.
 */
export interface ExtractionWorkerDeps {
  bufferStore: BufferStore;
  watcher: BufferWatcher;
  storage: StorageBackend;
  config?: Partial<ExtractionWorkerConfig>;
}

// ── Implementation ──────────────────────────────────────────────────────


/**
 * Frame a batch of buffer entries as a concatenated XML prompt.
 *
 * Each entry is converted to a synthetic `KiroMemEvent` shape and framed
 * individually via the existing `frameEvent` function. The results are
 * concatenated with newlines. Task 7.1 will add a dedicated `frameBatch`
 * function; for now we concatenate individual frames.
 *
 * @see Requirements 10.2
 */
function frameBatchXml(entries: readonly BufferEntry[]): string {
  return entries
    .map((entry) => {
      // Build a minimal KiroMemEvent-shaped object for frameEvent.
      // frameEvent only reads `body` and `valid_time` (plus `body.data`
      // fields for json bodies), so we provide just enough.
      const syntheticEvent = {
        event_id: entry.event_id,
        namespace: entry.namespace,
        schema_version: 1 as const,
        kind: entry.kind,
        body: entry.body,
        valid_time: entry.timestamp,
        session_id: '',
        actor_id: '',
        source: { surface: entry.surface as 'kiro-cli' | 'kiro-ide', version: '', client_id: '' },
      };
      return frameEvent(syntheticEvent);
    })
    .join('\n');
}

/**
 * Invoke the compressor agent via ACP for a batch of buffer entries.
 *
 * Creates an ACP session, sends the batch XML prompt, parses the response,
 * and retries on garbage or transient errors up to `maxRetries` times.
 * Each attempt creates and destroys its own ACP session.
 *
 * @see Requirements 10.2, 10.3, 11.2, 11.3
 */
async function invokeBatchCompressor(
  xmlPayload: string,
  timeoutMs: number,
  maxRetries: number,
): Promise<RawMemoryFields[]> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let session: AcpSession | null = null;
    try {
      session = await createAcpSession({
        agentName: 'kiro-learn-compressor',
        timeoutMs,
      });

      const responseText = await session.sendPrompt(xmlPayload);

      // Empty response = valid skip (compressor intentionally declined).
      if (!responseText.trim()) {
        return [];
      }

      // Explicit skip token.
      if (/<skip\b/.test(responseText)) {
        return [];
      }

      // Check for garbage (conversational response).
      if (isGarbageResponse(responseText)) {
        lastError = new Error(
          `compressor returned non-XML response (attempt ${String(attempt + 1)}/${String(maxRetries)})`,
        );
        process.stderr.write(
          `[kiro-learn] extraction garbage detected: ${lastError.message}\n`,
        );
        continue;
      }

      const records = parseMemoryXml(responseText);

      // Response contained <memory_record> markers but no parseable records.
      if (records.length === 0) {
        lastError = new Error(
          `compressor returned <memory_record> markers but no parseable records (attempt ${String(attempt + 1)}/${String(maxRetries)})`,
        );
        process.stderr.write(
          `[kiro-learn] extraction produced no valid records: ${lastError.message}\n`,
        );
        continue;
      }

      return records;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      process.stderr.write(
        `[kiro-learn] extraction attempt ${String(attempt + 1)}/${String(maxRetries)} failed: ${lastError.message}\n`,
      );
    } finally {
      session?.destroy();
    }
  }

  throw lastError ?? new Error('extraction failed after all retries');
}

/**
 * Create an {@link ExtractionWorker} with semaphore-based concurrency control.
 *
 * The worker reads buffer snapshots, frames them as batch XML, sends to the
 * compressor agent via ACP, parses the response, stores memory records, and
 * clears the buffer on success.
 *
 * @param deps - Injected dependencies: BufferStore, BufferWatcher, StorageBackend
 *
 * @see Requirements 10.1–10.8, 11.1–11.4
 */
export function createExtractionWorker(deps: ExtractionWorkerDeps): ExtractionWorker {
  const { bufferStore, watcher, storage } = deps;
  const config: ExtractionWorkerConfig = { ...DEFAULT_CONFIG, ...deps.config };

  // ── Semaphore state ─────────────────────────────────────────────────
  let active = 0;
  const waitQueue: Array<() => void> = [];

  // ── In-flight tracking for drain ────────────────────────────────────
  const inFlight = new Set<Promise<ExtractionResult>>();

  /**
   * Acquire a semaphore slot. Resolves immediately if a slot is available,
   * otherwise queues the caller until a slot is released.
   */
  function acquireSemaphore(): Promise<void> {
    if (active < config.concurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waitQueue.push(resolve);
    });
  }

  /**
   * Release a semaphore slot. If callers are waiting, the next one is
   * unblocked immediately.
   */
  function releaseSemaphore(): void {
    const next = waitQueue.shift();
    if (next !== undefined) {
      // Hand the slot directly to the next waiter (active count stays the same).
      next();
    } else {
      active -= 1;
    }
  }

  /**
   * Run extraction for a single project.
   *
   * 1. Acquire semaphore slot
   * 2. Read buffer snapshot
   * 3. If empty, release semaphore, notify success, return early
   * 4. Frame entries as batch XML
   * 5. Send to ACP, parse response
   * 6. Store memory records
   * 7. Clear buffer on success
   * 8. Notify watcher of result
   * 9. Release semaphore slot
   *
   * @see Requirements 10.1–10.8, 11.1–11.3
   */
  async function doExtract(projectId: string): Promise<ExtractionResult> {
    const startTime = Date.now();

    await acquireSemaphore();

    try {
      // 1. Read buffer snapshot
      const entries = await bufferStore.snapshot(projectId);

      // 2. If empty, return early
      if (entries.length === 0) {
        watcher.notifyExtractionResult(projectId, true);
        return {
          projectId,
          eventsProcessed: 0,
          memoriesCreated: 0,
          durationMs: Date.now() - startTime,
        };
      }

      // 3. Derive namespace from the first entry (all share the same namespace)
      const firstEntry = entries[0];
      if (firstEntry === undefined) {
        watcher.notifyExtractionResult(projectId, true);
        return {
          projectId,
          eventsProcessed: 0,
          memoriesCreated: 0,
          durationMs: Date.now() - startTime,
        };
      }
      const namespace = firstEntry.namespace;

      // 4. Collect all event_ids for source_event_ids
      const sourceEventIds = entries.map((e) => e.event_id);

      // 5. Frame entries as batch XML
      const xmlPayload = frameBatchXml(entries);

      // 6. Send to ACP with retry logic
      const rawRecords = await invokeBatchCompressor(
        xmlPayload,
        config.timeoutMs,
        config.maxRetries,
      );

      // 7. Store each memory record
      let memoriesCreated = 0;
      for (let i = 0; i < rawRecords.length; i++) {
        const raw = rawRecords[i]!;
        const recordId = `mr_${ulid()}`;

        const enriched = {
          record_id: recordId,
          namespace,
          strategy: 'llm-summary',
          source_event_ids: sourceEventIds,
          created_at: new Date().toISOString(),
          title: raw.title,
          summary: raw.summary,
          facts: raw.facts,
          concepts: raw.concepts,
          files_touched: raw.files,
          observation_type: raw.type,
        };

        const record = parseMemoryRecord(enriched);
        await storage.putMemoryRecord(record);
        memoriesCreated += 1;
      }

      // 8. Clear buffer on success
      await bufferStore.clear(projectId);

      // 9. Notify watcher of success
      watcher.notifyExtractionResult(projectId, true);

      return {
        projectId,
        eventsProcessed: entries.length,
        memoriesCreated,
        durationMs: Date.now() - startTime,
      };
    } catch (error: unknown) {
      // Extraction failed — do NOT clear buffer
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[kiro-learn] extraction failed for project ${projectId}: ${message}\n`,
      );

      // Notify watcher of failure (drives circuit breaker)
      watcher.notifyExtractionResult(projectId, false);

      return {
        projectId,
        eventsProcessed: 0,
        memoriesCreated: 0,
        durationMs: Date.now() - startTime,
      };
    } finally {
      releaseSemaphore();
    }
  }

  return {
    get active(): number {
      return active;
    },

    extract(projectId: string): Promise<ExtractionResult> {
      const promise = doExtract(projectId);
      inFlight.add(promise);
      promise.finally(() => {
        inFlight.delete(promise);
      });
      return promise;
    },

    /**
     * Wait for all in-flight extractions to complete or until the
     * specified timeout expires.
     *
     * @see Requirement 11.4
     */
    drain(drainTimeoutMs: number): Promise<void> {
      if (inFlight.size === 0) {
        return Promise.resolve();
      }

      const allDone = Promise.allSettled([...inFlight]).then(() => {
        /* resolved */
      });

      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, drainTimeoutMs);
      });

      return Promise.race([allDone, timeout]);
    },
  };
}
