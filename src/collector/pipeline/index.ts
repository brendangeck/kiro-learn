/**
 * Pipeline — the chain of processors an Event traverses between the receiver
 * and storage.
 *
 * Stages (v1):
 *   dedup → privacy scrub → storage → async extraction
 *
 * Each processor is a pure input → output transform that conforms to the
 * {@link PipelineProcessor} interface. Stages are composed by
 * {@link createPipeline} into an ordered chain.
 */

import { ulid } from 'ulidx';

import { parseMemoryRecord } from '../../types/index.js';
import type {
  KiroMemEvent,
  StorageBackend,
  EventIngestResponse,
} from '../../types/index.js';
import { toBufferEntry, extractProjectId } from '../buffer/types.js';
import type { BufferStore } from '../buffer/store.js';
import type { BufferWatcher } from '../buffer/watcher.js';
import { createAcpSession } from './acp-client.js';
import type { AcpSession } from './acp-client.js';
import { frameEvent } from './xml-framer.js';
import { parseMemoryXml, isGarbageResponse } from './xml-parser.js';
import type { RawMemoryFields } from './xml-parser.js';

// ── Stage result ────────────────────────────────────────────────────────

/**
 * Result of a single pipeline stage.
 * - `continue`: pass the (possibly transformed) event to the next stage.
 * - `halt`: stop processing; return the halt reason to the caller.
 */
export type StageResult =
  | { action: 'continue'; event: KiroMemEvent }
  | { action: 'halt'; response: EventIngestResponse };

// ── Processor interface ─────────────────────────────────────────────────

/**
 * A single processor in the pipeline chain. Each stage receives an event,
 * transforms or filters it, and returns a {@link StageResult}.
 *
 * Stages are independently testable: instantiate with mock deps, call
 * `process()`, assert the result.
 *
 * @see Requirements 17.1, 17.4
 */
export interface PipelineProcessor {
  readonly name: string;
  process(event: KiroMemEvent): StageResult | Promise<StageResult>;
}

// ── Pipeline interface ──────────────────────────────────────────────────

/**
 * The composed pipeline. Runs stages in order, writes to storage on
 * success, and fires async extraction.
 *
 * @see Requirements 17.2, 17.3
 */
export interface Pipeline {
  process(event: KiroMemEvent): Promise<EventIngestResponse>;
  /** The extraction stage, exposed for drain on shutdown. */
  readonly extraction: ExtractionStage;
}

// ── Pipeline options ────────────────────────────────────────────────────

/**
 * Configuration for {@link createPipeline}. All numeric fields have
 * sensible defaults documented inline.
 *
 * @see Requirements 4.1
 */
export interface PipelineOptions {
  storage: StorageBackend;
  /** Maximum concurrent `kiro-cli` extraction processes. Default `2`. */
  extractionConcurrency: number;
  /** Maximum queued extractions before oldest is dropped. Default `100`. */
  extractionQueueDepth: number;
  /** Per-extraction timeout in milliseconds. Default `30_000`. */
  extractionTimeout: number;
  /** Maximum entries in the in-memory dedup set. Default `10_000`. */
  dedupMaxSize: number;
  /** Buffer store for per-project NDJSON buffer files. Required when buffer mode is enabled. */
  bufferStore?: BufferStore;
  /** Buffer watcher for idle timer and size threshold triggers. Required when buffer mode is enabled. */
  bufferWatcher?: BufferWatcher;
  /** Whether buffer mode is enabled. When true, events are appended to project buffers instead of per-event extraction. */
  bufferEnabled?: boolean;
}

// ── Extraction stage interface ──────────────────────────────────────────

/**
 * Configuration for {@link createExtractionStage}.
 *
 * @see Requirements 6.7, 8.1, 9.1, 9.2, 9.3, 18.1, 18.3
 */
export interface ExtractionStageOptions {
  storage: StorageBackend;
  /** Maximum concurrent ACP extraction processes. Default `2`. */
  concurrency: number;
  /** Maximum queued extractions before oldest is dropped. Default `100`. */
  queueDepth: number;
  /** Per-extraction timeout in milliseconds. Default `30_000`. */
  timeoutMs: number;
  /** Maximum retry attempts for garbage/transient failures. Default `3`. */
  maxRetries?: number;
}

/**
 * Async extraction stage that enqueues events for background LLM
 * summarisation via `kiro-cli`.
 */
export interface ExtractionStage {
  /** Enqueue an event for async extraction. Returns immediately. */
  enqueue(event: KiroMemEvent): void;
  /** Wait for all pending extractions to complete (with timeout). */
  drain(timeoutMs: number): Promise<void>;
  /** Number of currently active `kiro-cli` processes. Exposed for testing. */
  readonly active: number;
}

// ── Dedup stage ─────────────────────────────────────────────────────────

/**
 * Configuration for {@link createDedupStage}.
 *
 * @see Requirements 5.4
 */
export interface DedupStageOptions {
  /** Maximum entries in the in-memory dedup set. Default `10_000`. */
  maxSize: number;
}

/**
 * A {@link PipelineProcessor} augmented with a read-only view of the
 * internal dedup set size, exposed for testing.
 */
export interface DedupStage extends PipelineProcessor {
  /** Current number of event_ids tracked in the dedup set. */
  readonly size: number;
  /** Remove an event_id from the set (rollback on downstream failure). */
  rollback(eventId: string): void;
}

/**
 * Create a bounded LRU dedup stage backed by a `Map<string, true>`.
 *
 * `Map` preserves insertion order, so eviction of the oldest entry is
 * `map.keys().next()` followed by `map.delete()`. Lookup and insert are
 * both O(1) amortized.
 *
 * @see Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 */
export function createDedupStage(
  opts: DedupStageOptions = { maxSize: 10_000 },
): DedupStage {
  if (!Number.isInteger(opts.maxSize) || opts.maxSize <= 0) {
    throw new RangeError('maxSize must be a positive integer');
  }

  const seen = new Map<string, true>();

  return {
    name: 'dedup',

    get size(): number {
      return seen.size;
    },

    rollback(eventId: string): void {
      seen.delete(eventId);
    },

    process(event: KiroMemEvent): StageResult {
      if (seen.has(event.event_id)) {
        return {
          action: 'halt',
          response: { event_id: event.event_id, stored: false },
        };
      }

      if (seen.size >= opts.maxSize) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }

      seen.set(event.event_id, true);
      return { action: 'continue', event };
    },
  };
}

// ── Privacy scrub stage ─────────────────────────────────────────────────

/** Opening tag for private spans. */
const OPEN_TAG = '<private>';

/** Closing tag for private spans. */
const CLOSE_TAG = '</private>';

/** Replacement text for redacted spans. */
const REPLACEMENT = '[REDACTED]';

/**
 * Core scrub function. Exported for direct testing.
 *
 * Replaces all `<private>...</private>` spans with `[REDACTED]`.
 * Handles nested tags (outermost pair is the boundary) and unclosed tags
 * (span extends to end of string). Produces a new string — the input is
 * never mutated.
 *
 * @see Requirements 6.1, 6.5, 6.6
 */
export function scrubPrivateSpans(input: string): string {
  let result = '';
  let pos = 0;

  while (pos < input.length) {
    const openIdx = input.indexOf(OPEN_TAG, pos);

    if (openIdx === -1) {
      // No more <private> tags; append remainder
      result += input.substring(pos);
      break;
    }

    // Append text before the opening tag
    result += input.substring(pos, openIdx);
    result += REPLACEMENT;

    // Find the matching close tag, handling nesting
    let depth = 1;
    let searchPos = openIdx + OPEN_TAG.length;

    while (depth > 0 && searchPos < input.length) {
      const nextOpen = input.indexOf(OPEN_TAG, searchPos);
      const nextClose = input.indexOf(CLOSE_TAG, searchPos);

      if (nextClose === -1) {
        // Unclosed tag: treat as extending to end of string
        searchPos = input.length;
        depth = 0;
      } else if (nextOpen !== -1 && nextOpen < nextClose) {
        // Nested open tag
        depth += 1;
        searchPos = nextOpen + OPEN_TAG.length;
      } else {
        // Close tag found
        depth -= 1;
        searchPos = nextClose + CLOSE_TAG.length;
      }
    }

    pos = searchPos;
  }

  return result;
}

/**
 * Recursively walk a JSON value and apply {@link scrubPrivateSpans} to
 * every string leaf. Returns a new value tree — the input is never mutated.
 */
function scrubJsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrubPrivateSpans(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[scrubPrivateSpans(k)] = scrubJsonValue(v);
    }
    return out;
  }
  // numbers, booleans, null — pass through unchanged
  return value;
}

/**
 * Create a privacy scrub pipeline stage.
 *
 * Dispatches on `event.body.type`:
 * - `text` → scrub `body.content`
 * - `message` → scrub each turn's `content`
 * - `json` → recursive walk of all string values in `body.data`
 *
 * Produces a new event object (immutability — never mutates the original).
 *
 * @see Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */
export function createPrivacyScrubStage(): PipelineProcessor {
  return {
    name: 'privacy-scrub',

    process(event: KiroMemEvent): StageResult {
      const body = event.body;
      let scrubbedBody: KiroMemEvent['body'];

      switch (body.type) {
        case 'text': {
          scrubbedBody = {
            ...body,
            content: scrubPrivateSpans(body.content),
          };
          break;
        }
        case 'message': {
          scrubbedBody = {
            ...body,
            turns: body.turns.map((turn) => ({
              ...turn,
              content: scrubPrivateSpans(turn.content),
            })),
          };
          break;
        }
        case 'json': {
          scrubbedBody = {
            ...body,
            data: scrubJsonValue(body.data),
          };
          break;
        }
      }

      return {
        action: 'continue',
        event: { ...event, body: scrubbedBody },
      };
    },
  };
}

// ── Extraction stage ────────────────────────────────────────────────────

/**
 * Invoke the compressor agent via ACP + XML framing.
 *
 * Frames the event as XML, creates an ACP session, sends the prompt,
 * parses the XML response, and retries on garbage or transient errors
 * up to `maxRetries` times. Each attempt creates and destroys its own
 * ACP session.
 *
 * @see Requirements 6.1, 6.2, 6.3, 6.6, 6.8
 */
export async function invokeCompressor(
  event: KiroMemEvent,
  timeoutMs: number,
  maxRetries: number,
): Promise<RawMemoryFields[]> {
  const xmlPayload = frameEvent(event);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let session: AcpSession | null = null;
    try {
      session = await createAcpSession({
        agentName: 'kiro-learn-compressor',
        timeoutMs,
      });

      const responseText = await session.sendPrompt(xmlPayload);

      // Empty response = valid skip (compressor intentionally declined
      // to emit a record). Return [] so the outer loop does nothing.
      if (!responseText.trim()) {
        return [];
      }

      // Explicit skip token — the compressor may emit `<skip/>` (or a
      // `<skip ...>` variant) instead of an empty body. Treat the same
      // as an empty response.
      if (/<skip\b/.test(responseText)) {
        return [];
      }

      // Check for garbage (conversational response). isGarbageResponse
      // returns true only for non-empty text that contains neither
      // `<memory_record` nor `<skip` — so reaching this branch means
      // the model produced prose instead of structured XML.
      if (isGarbageResponse(responseText)) {
        lastError = new Error(
          `compressor returned non-XML response (attempt ${String(attempt + 1)}/${String(maxRetries)})`,
        );
        console.warn(
          `extraction garbage detected for event ${event.event_id}: ${lastError.message}`,
        );
        continue;
      }

      const records = parseMemoryXml(responseText);

      // The response contained `<memory_record` markers (otherwise
      // isGarbageResponse above would have returned true) but the
      // parser extracted zero valid records. This means every block
      // failed validation — invalid `type` attribute, missing/empty
      // `title` or `summary`, or malformed/truncated XML. Returning []
      // here would silently drop what the model clearly intended to be
      // output; instead we treat it as a retryable failure so the
      // circuit breaker gets a chance to try again.
      if (records.length === 0) {
        lastError = new Error(
          `compressor returned <memory_record> markers but no parseable records (attempt ${String(attempt + 1)}/${String(maxRetries)})`,
        );
        console.warn(
          `extraction produced no valid records for event ${event.event_id}: ${lastError.message}`,
        );
        continue;
      }

      return records;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(
        `extraction attempt ${String(attempt + 1)}/${String(maxRetries)} failed for event ${event.event_id}: ${lastError.message}`,
      );
    } finally {
      session?.destroy();
    }
  }

  throw lastError ?? new Error('extraction failed after all retries');
}

/**
 * Create an extraction stage with semaphore-based concurrency control.
 *
 * Events are enqueued into a bounded FIFO queue. Up to `concurrency`
 * extractions run in parallel. When the queue overflows, the oldest
 * pending event is dropped with a warning.
 *
 * @see Requirements 6.1–6.8, 8.1–8.8, 9.1–9.3
 */
export function createExtractionStage(
  opts: ExtractionStageOptions,
): ExtractionStage {
  const { storage, concurrency, queueDepth, timeoutMs } = opts;
  const maxRetries = opts.maxRetries ?? 3;

  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new RangeError('concurrency must be a positive integer');
  }
  if (!Number.isInteger(queueDepth) || queueDepth < 1) {
    throw new RangeError('queueDepth must be a positive integer');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive integer');
  }
  if (!Number.isInteger(maxRetries) || maxRetries <= 0) {
    throw new RangeError('maxRetries must be a positive integer');
  }

  let active = 0;
  const queue: KiroMemEvent[] = [];

  // Listeners waiting for all work to drain
  let drainResolvers: Array<() => void> = [];

  function notifyDrain(): void {
    if (active === 0 && queue.length === 0) {
      for (const resolve of drainResolvers) {
        resolve();
      }
      drainResolvers = [];
    }
  }

  async function runExtraction(event: KiroMemEvent): Promise<void> {
    try {
      const rawRecords = await invokeCompressor(event, timeoutMs, maxRetries);

      for (let i = 0; i < rawRecords.length; i++) {
        const raw = rawRecords[i]!;
        const recordId = `mr_${ulid()}`;

        const enriched = {
          record_id: recordId,
          namespace: event.namespace,
          strategy: 'llm-summary',
          source_event_ids: [event.event_id],
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
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `extraction failed for event ${event.event_id}: ${message}`,
      );
    }
  }

  function tryRunNext(): void {
    while (active < concurrency && queue.length > 0) {
      const event = queue.shift()!;
      active += 1;
      runExtraction(event).finally(() => {
        active -= 1;
        tryRunNext();
        notifyDrain();
      });
    }
  }

  return {
    get active(): number {
      return active;
    },

    enqueue(event: KiroMemEvent): void {
      if (queue.length >= queueDepth) {
        const dropped = queue.shift()!;
        console.warn(
          `extraction queue full, dropping event ${dropped.event_id}`,
        );
      }
      queue.push(event);
      tryRunNext();
    },

    drain(drainTimeoutMs: number): Promise<void> {
      // If nothing is pending, resolve immediately
      if (active === 0 && queue.length === 0) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          // Remove this resolver from the list on timeout
          drainResolvers = drainResolvers.filter((r) => r !== wrappedResolve);
          resolve();
        }, drainTimeoutMs);

        const wrappedResolve = (): void => {
          clearTimeout(timer);
          resolve();
        };

        drainResolvers.push(wrappedResolve);
      });
    },
  };
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create a composed pipeline that runs dedup → privacy scrub → storage,
 * then fires async extraction.
 *
 * @see Requirements 4.1, 4.2, 4.3, 4.4, 17.2, 17.3, 16.1, 16.2, 19.1, 19.2, 19.3
 */
export function createPipeline(opts: PipelineOptions): Pipeline {
  const { storage } = opts;
  const useBuffer =
    opts.bufferEnabled === true &&
    opts.bufferStore !== undefined &&
    opts.bufferWatcher !== undefined;

  // 1. Create stages
  const dedupStage = createDedupStage({ maxSize: opts.dedupMaxSize });
  const privacyScrubStage = createPrivacyScrubStage();
  const extractionStage = createExtractionStage({
    storage,
    concurrency: opts.extractionConcurrency,
    queueDepth: opts.extractionQueueDepth,
    timeoutMs: opts.extractionTimeout,
  });

  return {
    extraction: extractionStage,

    async process(event: KiroMemEvent): Promise<EventIngestResponse> {
      try {
        // 2a. Run dedup stage
        const dedupResult = await dedupStage.process(event);
        if (dedupResult.action === 'halt') {
          return dedupResult.response;
        }

        // 2b. Run privacy scrub stage
        const scrubResult = await privacyScrubStage.process(dedupResult.event);
        if (scrubResult.action === 'halt') {
          return scrubResult.response;
        }

        const scrubbedEvent = scrubResult.event;

        // 2c. Store the scrubbed event
        await storage.putEvent(scrubbedEvent);

        // 2d. Build response
        const response: EventIngestResponse = {
          event_id: event.event_id,
          stored: true,
        };

        if (useBuffer) {
          // 2e-buffer. Check ceiling, write durably, then advance watcher state.
          // The ceiling check is read-only; byte accumulation happens only
          // after the durable write succeeds, so a failed append never
          // leaves stale byte counts in the watcher.
          try {
            const entry = toBufferEntry(scrubbedEvent);
            const projectId = extractProjectId(scrubbedEvent.namespace);
            const line = JSON.stringify(entry) + '\n';
            const bytesWritten = Buffer.byteLength(line, 'utf-8');

            // Pre-write ceiling check (read-only).
            if (opts.bufferWatcher!.wouldExceedCeiling(projectId, bytesWritten)) {
              // Ceiling hit — skip append. Event is already in SQLite.
            } else {
              // Durable write first.
              await opts.bufferStore!.append(projectId, entry);
              // Write succeeded — now advance watcher state (accumulate bytes, reset timer).
              opts.bufferWatcher!.notifyAppend(projectId, bytesWritten);
            }
          } catch (bufferError: unknown) {
            const message =
              bufferError instanceof Error
                ? bufferError.message
                : String(bufferError);
            process.stderr.write(
              `[kiro-learn] buffer append failed for event ${scrubbedEvent.event_id}: ${message}\n`,
            );
          }
        } else {
          // 2e-legacy. Fire async extraction (don't await)
          extractionStage.enqueue(scrubbedEvent);
        }

        // 2f. Return the response
        return response;
      } catch (error: unknown) {
        // Roll back the dedup set entry so a retry is not falsely rejected.
        // The event was not durably stored, so the id must not be remembered.
        dedupStage.rollback(event.event_id);

        const message =
          error instanceof Error ? error.message : String(error);
        console.error(
          `pipeline error for event ${event.event_id}: ${message}`,
        );
        throw error;
      }
    },
  };
}
