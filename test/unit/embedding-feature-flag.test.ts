/**
 * End-to-end feature-flag-off unit tests (task 11.4).
 *
 * Exercises the full flag-off path: `embeddingEnabled: false` →
 * model never loaded (no `pipeline(...)` instantiation) → extractions
 * write records with NULL embedding and trigger NO embed-related
 * warnings → searches are lexical-only and behave identically to the
 * pre-spec FTS5 baseline.
 *
 * Distinct from degraded mode:
 *
 *   - Degraded mode: the embedder is constructed (flag is on) but
 *     fails to load. Consumers see `embedder !== null` and
 *     `isReady() === false`. Writes log a "degraded mode" warning
 *     per affected record (Req 14.3).
 *   - Flag off: the embedder is never constructed. Consumers see
 *     `embedder === null`. Writes go silently to the lexical
 *     storage surface and emit NO embed-related warnings (Req
 *     14.2). Reads are indistinguishable from the pre-spec baseline
 *     (Req 16.3).
 *
 * Strategy:
 *
 *   - The `@huggingface/transformers` module is mocked so we can
 *     assert that `pipeline` was never called — the strongest
 *     signal that the model was not loaded (Req 12.5).
 *   - `ExtractionWorker` and `QueryLayer` are driven directly with
 *     `embedder: null` against a real SQLite backend, exercising the
 *     exact code paths `startCollector` wires when
 *     `embeddingEnabled === false`.
 *   - Task 11.3 (`embedding-collector-wiring.test.ts`) separately
 *     covers the `startCollector`-level wiring; this file validates
 *     observable behaviour once the flag-off configuration is live.
 *
 * Validates: Requirements 2.2, 12.4, 12.5, 14.2
 *
 * @see src/collector/embedding/onnx-embedder.ts
 * @see src/collector/buffer/extraction.ts
 * @see src/collector/query/index.ts
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md § Feature flag
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryLayer } from '../../src/collector/query/index.js';
import { createIngestionPipeline } from '../../src/collector/ingestion/index.js';
import { createReconciliationCircuitBreaker } from '../../src/collector/ingestion/circuit-breaker.js';
import { createBufferStore } from '../../src/collector/buffer/store.js';
import { createBufferWatcher } from '../../src/collector/buffer/watcher.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { StorageBackend, MemoryRecord } from '../../src/types/index.js';

// ── Mock ACP ─────────────────────────────────────────────────────────────

const SINGLE_RECORD_XML = `
<memory_record type="tool_use">
  <title>Reads src/test.ts</title>
  <summary>Agent read the file at src/test.ts for inspection</summary>
  <facts>
    <fact>src/test.ts is 42 lines long</fact>
  </facts>
  <concepts>
    <concept>typescript</concept>
  </concepts>
  <files>
    <file>src/test.ts</file>
  </files>
</memory_record>
`.trim();

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() =>
    Promise.resolve({
      sendPrompt: vi.fn(() => Promise.resolve(SINGLE_RECORD_XML)),
      destroy: vi.fn(),
    }),
  ),
}));

// ── Mock `@huggingface/transformers` — assert `pipeline` is NEVER called ─

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(async () => {
    // Intentionally throw — no test should ever reach this path.
    throw new Error('pipeline() called despite embeddingEnabled === false');
  }),
  env: {} as Record<string, unknown>,
}));

// ── Test lifecycle ──────────────────────────────────────────────────────

const NAMESPACE = '/actor/alice/project/abc/';
const PROJECT_ID = 'abc123def456';

let tmpRoot: string;
let dbPath: string;
let bufferDir: string;
let storage: StorageBackend;
let capturedStderr: string[];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-flagoff-'));
  dbPath = join(tmpRoot, 'kiro-learn.db');
  bufferDir = join(tmpRoot, 'buffers');
  storage = openSqliteStorage({ dbPath });

  capturedStderr = [];
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      capturedStderr.push(String(chunk));
      return true;
    });
});

afterEach(async () => {
  stderrSpy.mockRestore();
  try {
    await storage.close();
  } catch {
    /* swallow */
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeBufferEntry(): {
  event_id: string;
  namespace: string;
  kind: 'tool_use';
  body: { type: 'json'; data: Record<string, unknown> };
  timestamp: string;
  surface: string;
} {
  return {
    event_id: '01JF8ZS4Y00000000000000000',
    namespace: NAMESPACE,
    kind: 'tool_use',
    body: {
      type: 'json',
      data: {
        tool_name: 'readFile',
        tool_input: { path: 'src/test.ts' },
        tool_response: 'file contents here',
      },
    },
    timestamp: '2026-04-23T20:00:00.000Z',
    surface: 'kiro-cli',
  };
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    record_id: 'mr_01JF8ZS4Z00000000000000001',
    namespace: NAMESPACE,
    strategy: 'llm-summary',
    title: 'A record about typescript',
    summary: 'A summary discussing typescript',
    facts: ['typescript is great'],
    source_event_ids: ['01JF8ZS4Y00000000000000000'],
    created_at: '2026-04-23T20:00:00.000Z',
    concepts: ['typescript'],
    files_touched: ['src/index.ts'],
    observation_type: 'tool_use',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('End-to-end feature-flag-off', () => {
  it('model is never loaded — `pipeline(...)` is not invoked when embedder is not constructed', async () => {
    /**
     * **Validates: Requirement 12.5**
     *
     * This is the contract enforcement: a flag-off daemon never
     * instantiates the ONNX pipeline. Given the mock transformers
     * module throws if called, any accidental instantiation would
     * blow up the test. We also assert call count for clarity.
     */
    const { pipeline } = await import('@huggingface/transformers');

    // The IngestionPipeline and QueryLayer both take `embedder:
    // null` in the flag-off path. Exercise both without ever
    // constructing `createOnnxEmbedder`.
    const bufferStore = createBufferStore(bufferDir);
    const watcher = createBufferWatcher({
      idleMs: 60_000,
      extractionSizeThreshold: 262_144,
      bufferMaxBytes: 4_194_304,
      maxConsecutiveFailures: 3,
      compactionSizeThreshold: 1_048_576,
    });

    const queryLayer = createQueryLayer({ storage, embedder: null });
    const circuitBreaker = createReconciliationCircuitBreaker();

    const pipelineHandle = createIngestionPipeline({
      bufferStore,
      watcher,
      storage,
      embedder: null,
      query: queryLayer,
      circuitBreaker,
      config: {
        reconciliationEnabled: false,
        intraBatchSimilarityThreshold: 0.85,
        neighborSimilarityThreshold: 0.8,
        neighborPoolMaxSize: 10,
        judgeModelTimeoutMs: 30_000,
        extractionConcurrency: 1,
        extractionTimeoutMs: 60_000,
        extractionMaxRetries: 3,
        debug: false,
      },
    });

    await bufferStore.append(PROJECT_ID, makeBufferEntry());
    await pipelineHandle.run(PROJECT_ID);
    await queryLayer.search(NAMESPACE, 'typescript', 10);

    expect(pipeline).not.toHaveBeenCalled();

    watcher.close();
  });

  it('IngestionPipeline stores records with NULL embedding and emits no embed-related warnings', async () => {
    /**
     * **Validates: Requirements 12.4, 14.2**
     *
     * Flag-off writes must persist the `MemoryRecord` exactly as
     * pre-spec extraction would, leave `embedding` NULL, and emit
     * no embed-related stderr noise. The "degraded mode: skipping
     * embed" warning is reserved for the degraded-mode path —
     * flag-off is a conscious operator choice and does not warrant
     * per-record logs.
     */
    const bufferStore = createBufferStore(bufferDir);
    const watcher = createBufferWatcher({
      idleMs: 60_000,
      extractionSizeThreshold: 262_144,
      bufferMaxBytes: 4_194_304,
      maxConsecutiveFailures: 3,
      compactionSizeThreshold: 1_048_576,
    });

    const putEmbeddingSpy = vi.spyOn(storage, 'putEmbedding');

    const queryLayer = createQueryLayer({ storage, embedder: null });
    const circuitBreaker = createReconciliationCircuitBreaker();

    const pipelineHandle = createIngestionPipeline({
      bufferStore,
      watcher,
      storage,
      embedder: null,
      query: queryLayer,
      circuitBreaker,
      config: {
        reconciliationEnabled: false,
        intraBatchSimilarityThreshold: 0.85,
        neighborSimilarityThreshold: 0.8,
        neighborPoolMaxSize: 10,
        judgeModelTimeoutMs: 30_000,
        extractionConcurrency: 1,
        extractionTimeoutMs: 60_000,
        extractionMaxRetries: 3,
        debug: false,
      },
    });

    await bufferStore.append(PROJECT_ID, makeBufferEntry());
    const result = await pipelineHandle.run(PROJECT_ID);

    expect(result.directCommittedRecords).toBe(1);

    // Record stored, no embedding.
    const { items } = await storage.listMemoryRecords({
      namespace: NAMESPACE,
      limit: 10,
      offset: 0,
    });
    expect(items.length).toBe(1);
    expect(await storage.getEmbedding(items[0]!.record_id)).toBeNull();

    const stats = await storage.getStats(NAMESPACE);
    expect(stats.embeddings_present).toBe(0);
    expect(stats.embeddings_missing).toBe(1);

    // Nobody called `putEmbedding`.
    expect(putEmbeddingSpy).not.toHaveBeenCalled();

    // No embed-related log lines at all.
    const stderrOut = capturedStderr.join('');
    expect(stderrOut).not.toMatch(/degraded mode/);
    expect(stderrOut).not.toMatch(/embedding failed/);
    expect(stderrOut).not.toMatch(/hybrid search falling back/);

    watcher.close();
  });

  it('QueryLayer.search returns the lexical-only ordering identical to pre-spec behaviour', async () => {
    /**
     * **Validates: Requirements 12.4, 16.3**
     *
     * With `embedder: null`, the `QueryLayer.search` result must
     * equal the pure lexical top-`limit` ordering returned by
     * `storage.searchMemoryRecordsLexical`. This is the strictly-
     * additive guarantee — feature flag off preserves pre-spec
     * behaviour byte-for-byte on the read path.
     */
    // Seed a small corpus whose FTS5 ranking is deterministic:
    // record 1 matches "typescript" twice, record 2 once, record 3
    // doesn't match at all.
    await storage.putMemoryRecord(
      makeRecord({
        record_id: 'mr_01JF8ZS4Z00000000000000001',
        title: 'typescript typescript',
        summary: 'primarily about typescript',
        facts: ['typescript'],
        concepts: ['typescript'],
        created_at: '2026-04-23T20:00:00.000Z',
      }),
    );
    await storage.putMemoryRecord(
      makeRecord({
        record_id: 'mr_01JF8ZS4Z00000000000000002',
        title: 'build config',
        summary: 'some typescript mention here',
        facts: ['tsconfig.json'],
        concepts: ['build'],
        created_at: '2026-04-23T20:01:00.000Z',
      }),
    );
    await storage.putMemoryRecord(
      makeRecord({
        record_id: 'mr_01JF8ZS4Z00000000000000003',
        title: 'nothing interesting',
        summary: 'a record about rust programming',
        facts: ['cargo'],
        concepts: ['rust'],
        created_at: '2026-04-23T20:02:00.000Z',
      }),
    );

    const queryLayer = createQueryLayer({ storage, embedder: null });

    // Hybrid-eligible query — embedder is null, so it collapses to
    // the lexical path.
    const results = await queryLayer.search(NAMESPACE, 'typescript', 10);
    const resultIds = results.map((r) => r.record_id);

    // Expected baseline from the storage's lexical surface.
    const lexical = await storage.searchMemoryRecordsLexical({
      namespace: NAMESPACE,
      query: 'typescript',
      limit: 10,
    });
    const lexicalIds = lexical.map((l) => l.record.record_id);

    expect(resultIds).toEqual(lexicalIds);

    // Sanity — our seeded corpus matched two records and left the
    // rust-only record out.
    expect(resultIds).toContain('mr_01JF8ZS4Z00000000000000001');
    expect(resultIds).toContain('mr_01JF8ZS4Z00000000000000002');
    expect(resultIds).not.toContain('mr_01JF8ZS4Z00000000000000003');

    // No embed-related log.
    const stderrOut = capturedStderr.join('');
    expect(stderrOut).not.toMatch(/hybrid search falling back/);
    expect(stderrOut).not.toMatch(/degraded mode/);

    // Empty-token query short-circuits to `[]` without touching
    // storage. Same as pre-spec.
    const empty = await queryLayer.search(NAMESPACE, '   ', 10);
    expect(empty).toEqual([]);
  });
});
