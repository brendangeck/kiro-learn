/**
 * Property-based test for write-path safety of the ExtractionWorker's
 * embedding integration.
 *
 * Feature: local-embeddings-and-hybrid-search, Property 15: Write-path
 * safety.
 *
 * The contract under test — copied from
 * `.kiro/specs/local-embeddings-and-hybrid-search/design.md` § Property 15
 * — is:
 *
 *   *For any* memory record, if the embedder is slow or failing, the
 *   `storage.putMemoryRecord(record)` call in the extraction worker
 *   completes without waiting on the embedder. Formally: in a trace of
 *   worker operations for a record, the `putMemoryRecord` completion
 *   event precedes any dependency on the `embed` result.
 *
 * Equivalently: the memory record is stored within a tight, embedder-
 * independent bound even when `embed` hangs until its timeout.
 *
 * The extraction worker's embed path is strictly sequential:
 *
 *   1. `await storage.putMemoryRecord(record)`
 *   2. `await embedder.embed(input)`
 *   3. `await storage.putEmbedding(record.record_id, vec)`
 *
 * Because each step is awaited, step (1)'s promise must have resolved
 * before step (2) is even invoked. The property therefore checks:
 *
 *   (a) **Ordering.** For every stored record, `putMemoryRecord`'s
 *       `mock.invocationCallOrder[i]` is strictly less than the
 *       corresponding `embed`'s `invocationCallOrder[i]` — the record
 *       insert is sequenced before the embed call.
 *   (b) **Temporal independence.** The wall-clock timestamp captured
 *       right before the `putMemoryRecord` spy resolves is strictly
 *       earlier than the timestamp captured right before `embed` is
 *       even invoked. (Ordering implies this on a sequential worker,
 *       but we assert it explicitly so a regression that fired
 *       `embed` concurrently with `putMemoryRecord` would be caught.)
 *   (c) **Bounded wait.** With a fake embedder that hangs for a real
 *       500 ms then rejects with a timeout-shaped error, the entire
 *       `worker.extract` call STILL completes (the failure is absorbed
 *       by the embed-path `try/catch`), and the elapsed time from
 *       extract start to `putMemoryRecord` resolution is bounded well
 *       under the embedder's 500 ms delay — proving that the record
 *       insert does not wait on the embed result.
 *
 * To keep wall time bounded: 30 runs × 500 ms (embedder delay) ≈ 15 s
 * minimum. The `it` timeout is set to 60 s to leave slack for slow CI.
 *
 * ACP is mocked (same pattern as `embedding-extraction-worker.test.ts`
 * and `buffer-extraction-worker.test.ts`); storage and embedder are
 * vi-backed fakes. No real `kiro-cli`, no real ONNX pipeline.
 *
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md § Property 15
 * @see .kiro/specs/local-embeddings-and-hybrid-search/requirements.md
 *      §§ Requirements 3.4, 3.5
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Embedder } from '../../src/collector/embedding/index.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';
import type { StorageBackend } from '../../src/types/index.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

/**
 * Queue of responses the mocked ACP session returns from `sendPrompt`.
 * The property test pushes one `SINGLE_RECORD_XML` per iteration so
 * the mocked ACP session always has exactly one response ready.
 */
const responseQueue: Array<string | Error> = [];

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() => {
    const response = responseQueue.shift();
    const session = {
      sendPrompt: vi.fn(() => {
        if (response instanceof Error) {
          return Promise.reject(response);
        }
        return Promise.resolve(response ?? '');
      }),
      destroy: vi.fn(),
    };
    return Promise.resolve(session);
  }),
}));

// ── Fixture: compressor XML ─────────────────────────────────────────────

/**
 * Template used to construct a valid compressor response containing a
 * single memory record. The iteration's generated `title`, `summary`,
 * `fact`, and `concept` values are interpolated via
 * {@link buildSingleRecordXml} so each run exercises a different record
 * payload while keeping the XML shape fixed (the XML parser is not
 * under test here — the write-path ordering is).
 */
function buildSingleRecordXml(fields: {
  title: string;
  summary: string;
  fact: string;
  concept: string;
}): string {
  // The values are bounded in the generator below to avoid any
  // characters that could confuse the XML parser or blow past the
  // wire-schema caps. Simple alphanumerics + spaces only.
  return `
<memory_record type="tool_use">
  <title>${fields.title}</title>
  <summary>${fields.summary}</summary>
  <facts>
    <fact>${fields.fact}</fact>
  </facts>
  <concepts>
    <concept>${fields.concept}</concept>
  </concepts>
  <files>
    <file>src/test.ts</file>
  </files>
</memory_record>
`.trim();
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a mock `StorageBackend` whose `putMemoryRecord` spy records a
 * wall-clock timestamp the moment its resolving promise fires. The
 * timestamp is used by clause (b) of the property — temporal
 * independence from `embed` — and by clause (c) — bounded wait.
 */
interface TimedStorage extends StorageBackend {
  putMemoryRecord: ReturnType<typeof vi.fn>;
  putEmbedding: ReturnType<typeof vi.fn>;
  /** Timestamps captured inside the `putMemoryRecord` spy body, one per call. */
  putRecordCompleteTimes: number[];
}

function createTimedStorage(): TimedStorage {
  const putRecordCompleteTimes: number[] = [];
  const putMemoryRecord = vi.fn(async () => {
    // Capture the wall-clock time the moment this call resolves.
    // Because the worker does `await storage.putMemoryRecord(record)`,
    // this timestamp is an upper bound on when the promise's
    // microtask fires — which is in turn an upper bound on the
    // earliest moment the worker can begin the embed step.
    putRecordCompleteTimes.push(Date.now());
  });
  const storage: TimedStorage = {
    putEvent: vi.fn().mockResolvedValue(undefined),
    getEventById: vi.fn().mockResolvedValue(null),
    putMemoryRecord,
    searchMemoryRecords: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockResolvedValue({
      total_events: 0,
      total_memories: 0,
      total_projects: 0,
      total_concepts: 0,
      observation_types: {},
      event_kinds: {},
    }),
    listProjects: vi.fn().mockResolvedValue([]),
    listMemoryRecords: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listEvents: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    putEmbedding: vi.fn().mockResolvedValue(undefined),
    getEmbedding: vi.fn().mockResolvedValue(null),
    listEmbeddings: vi.fn().mockResolvedValue([]),
    listRecordsWithoutEmbedding: vi.fn().mockResolvedValue([]),
    searchMemoryRecordsLexical: vi.fn().mockResolvedValue([]),
    putRecordCompleteTimes,
  };
  return storage;
}

/**
 * Fake embedder that hangs for `delayMs` (a real `setTimeout` delay,
 * keeping the test's wall time bounded at `numRuns × delayMs`) and
 * then rejects with a timeout-shaped error. Captures the wall-clock
 * time right at entry to `embed` so clause (b) can compare
 * "putMemoryRecord resolved" vs "embed invoked".
 *
 * The shape of the rejection matches what the real `OnnxEmbedder`
 * produces via `Promise.race`; the worker is agnostic to the reason
 * but matching the shape makes the test's intent (simulating the
 * hung-model timeout case) unambiguous.
 */
interface TimedHangingEmbedder extends Embedder {
  embed: ReturnType<typeof vi.fn>;
  isReady: ReturnType<typeof vi.fn>;
  ready: ReturnType<typeof vi.fn>;
  /** Timestamps captured at the *start* of each `embed` call. */
  embedStartTimes: number[];
}

function createHangingEmbedder(delayMs: number): TimedHangingEmbedder {
  const embedStartTimes: number[] = [];
  const embedder: TimedHangingEmbedder = {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    embed: vi.fn(async () => {
      embedStartTimes.push(Date.now());
      await new Promise((r) => setTimeout(r, delayMs));
      throw new Error(`embed timeout after ${String(delayMs)}ms`);
    }),
    dim: 384 as const,
    embedStartTimes,
  };
  return embedder;
}

/** Build a valid `BufferEntry` for the worker's input buffer. */
function makeBufferEntry(eventId: string): BufferEntry {
  return {
    event_id: eventId,
    namespace: '/actor/alice/project/abc/',
    kind: 'tool_use',
    body: {
      type: 'json',
      data: {
        tool_name: 'readFile',
        tool_input: { path: 'src/test.ts' },
        tool_response: 'file contents',
      },
    },
    timestamp: '2026-04-23T20:00:00.000Z',
    surface: 'kiro-cli',
  };
}

// ── Test-lifecycle scaffolding ──────────────────────────────────────────

let tmpDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  responseQueue.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-write-safety-'));

  // Silence stderr — the hanging embedder is *expected* to produce
  // "embedding failed" warnings on every iteration. Leaving those on
  // stderr would clutter test output but they're part of the
  // contract (Req 3.4).
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((): boolean => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Constants ───────────────────────────────────────────────────────────

/**
 * Wall-clock delay of the hanging fake embedder. The design calls for
 * "a real 500 ms delay to keep wall time bounded"; 30 runs × 500 ms =
 * 15 s minimum. The `it` timeout is set well above that.
 */
const EMBEDDER_DELAY_MS = 500;

/**
 * Upper bound on how long the `putMemoryRecord` → its-own-resolution
 * leg of the worker is allowed to take. On a sequential worker this
 * should be a few milliseconds — a couple of awaits over the mocked
 * buffer store and ACP session — but CI machines can be slow, so we
 * pick a bound that is (a) comfortably under `EMBEDDER_DELAY_MS` so
 * the property is meaningful, and (b) generous enough to survive CI
 * jitter without flaking.
 */
const PUT_RECORD_COMPLETE_BUDGET_MS = 200;

// ── Tests ───────────────────────────────────────────────────────────────

describe('Feature: local-embeddings-and-hybrid-search, Property 15: Write-path safety', () => {
  /**
   * **Validates: Requirements 3.4, 3.5**
   *
   * For any memory record, a slow (500 ms delay then timeout) embedder
   * must not delay or block `storage.putMemoryRecord`. Every iteration
   * instantiates a fresh worker with a hanging embedder, feeds the
   * buffer one synthetic entry, lets the mocked compressor return one
   * record, and asserts all three clauses (ordering, temporal
   * independence, bounded wait). See the file-level comment for the
   * full rationale.
   */
  it('putMemoryRecord completes before embed is invoked and within a tight bound even when the embedder hangs', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Bounded alphanumeric + whitespace strings. These are
        // interpolated directly into the XML fixture; keeping them
        // free of `<`, `>`, `&`, and multi-line content avoids any
        // interaction with the XML parser, which is not under test
        // here. The bounds stay well inside the wire-schema caps
        // (title ≤ 200, summary ≤ 4 000, fact ≤ 500, concept ≤ 100).
        fc.record({
          title: fc
            .string({ minLength: 1, maxLength: 60 })
            .map((s) => s.replace(/[<>&\r\n]/g, ' '))
            .filter((s) => s.trim().length > 0),
          summary: fc
            .string({ minLength: 1, maxLength: 200 })
            .map((s) => s.replace(/[<>&\r\n]/g, ' '))
            .filter((s) => s.trim().length > 0),
          fact: fc
            .string({ minLength: 1, maxLength: 80 })
            .map((s) => s.replace(/[<>&\r\n]/g, ' '))
            .filter((s) => s.trim().length > 0),
          concept: fc
            .string({ minLength: 1, maxLength: 40 })
            .map((s) => s.replace(/[<>&\r\n]/g, ' '))
            .filter((s) => s.trim().length > 0),
        }),
        async (fields) => {
          // Per-iteration isolation: fresh buffer directory, fresh
          // mocks, fresh response queue entry. Any cross-iteration
          // leakage would corrupt the call-order assertions below.
          const iterTmpDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'embed-write-safety-iter-'),
          );

          try {
            responseQueue.length = 0;
            responseQueue.push(buildSingleRecordXml(fields));

            // Import lazily so the vi.mock at module scope applies.
            const { createExtractionWorker } = await import(
              '../../src/collector/buffer/extraction.js'
            );
            const { createBufferStore } = await import(
              '../../src/collector/buffer/store.js'
            );
            const { createBufferWatcher } = await import(
              '../../src/collector/buffer/watcher.js'
            );

            const bufferStore = createBufferStore(iterTmpDir);
            const watcher = createBufferWatcher({ idleMs: 999_999 });
            const storage = createTimedStorage();
            const embedder = createHangingEmbedder(EMBEDDER_DELAY_MS);

            const projectId = 'write-path-safety-project';
            await bufferStore.append(
              projectId,
              makeBufferEntry('01JF8ZS4Y00000000000000001'),
            );

            const worker = createExtractionWorker({
              bufferStore,
              watcher,
              storage,
              embedder,
              config: {
                concurrency: 2,
                // Large ACP timeout; irrelevant here since ACP is
                // mocked and returns synchronously.
                timeoutMs: 30_000,
                maxRetries: 3,
              },
            });

            const extractStart = Date.now();
            const result = await worker.extract(projectId);
            watcher.close();

            // Sanity: exactly one record emerged from the mocked
            // compressor and the worker attempted to embed it.
            // Without these, the ordering/timing assertions below
            // would be vacuous.
            expect(result.memoriesCreated).toBe(1);
            expect(storage.putMemoryRecord).toHaveBeenCalledTimes(1);
            expect(embedder.embed).toHaveBeenCalledTimes(1);

            // The hanging embedder always throws — so
            // `putEmbedding` must never have been reached.
            // (This is the negative complement of ordering: not
            // only does the insert come first, but a failed embed
            // never backfills the embedding column either.)
            expect(storage.putEmbedding).not.toHaveBeenCalled();

            // Clause (a): ordering via Vitest's
            // `invocationCallOrder`. A monotonically increasing
            // global counter shared across all spies — so a strict
            // `<` here is a strict happens-before on the shared
            // timeline. If the worker ever fired `embed`
            // concurrently with `putMemoryRecord` (e.g., via
            // `Promise.all`), this would fail.
            const putRecordOrder =
              storage.putMemoryRecord.mock.invocationCallOrder[0];
            const embedOrder = embedder.embed.mock.invocationCallOrder[0];
            expect(putRecordOrder).toBeDefined();
            expect(embedOrder).toBeDefined();
            expect(putRecordOrder!).toBeLessThan(embedOrder!);

            // Clause (b): temporal independence. The timestamp
            // captured inside the `putMemoryRecord` spy body must
            // be strictly earlier than the timestamp captured at
            // the start of the `embed` body. Same-millisecond
            // cases are allowed (the event-loop can resolve both
            // inside one ms on a fast host) — `<=` is the correct
            // relation here.
            const putRecordTime = storage.putRecordCompleteTimes[0];
            const embedStartTime = embedder.embedStartTimes[0];
            expect(putRecordTime).toBeDefined();
            expect(embedStartTime).toBeDefined();
            expect(putRecordTime!).toBeLessThanOrEqual(embedStartTime!);

            // Clause (c): bounded wait. Time from `worker.extract`
            // start to `putMemoryRecord`'s resolution must be well
            // under the embedder's 500 ms hang — proving the
            // record insert is not waiting on the embed result.
            // This is the load-bearing property for Requirements
            // 3.4 ("log a warning, not block") and 3.5 ("SHALL
            // NOT block, drop, or delay the record insert").
            const timeToRecordStored = putRecordTime! - extractStart;
            expect(timeToRecordStored).toBeLessThan(
              PUT_RECORD_COMPLETE_BUDGET_MS,
            );
            // And the entire extract call itself is bounded by the
            // embedder timeout + a small margin — confirming that
            // the worker tolerates the hang rather than escalating
            // it.
            const totalExtractMs = Date.now() - extractStart;
            expect(totalExtractMs).toBeGreaterThanOrEqual(EMBEDDER_DELAY_MS);
            expect(totalExtractMs).toBeLessThan(EMBEDDER_DELAY_MS + 2_000);
          } finally {
            fs.rmSync(iterTmpDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 30 },
    );
    // 30 iterations × ~500 ms embedder hang = ~15 s minimum; cap the
    // test well above that to survive CI jitter without flaking.
  }, 60_000);
});
