/**
 * Unit tests for `extractCandidates` and `toMemoryRecord` from the
 * ingestion/candidate module.
 *
 * Tests cover:
 *
 * - Zero writes: a spy `StorageBackend` sees no `putMemoryRecord` /
 *   `putEmbedding` calls across an end-to-end extraction run
 *   (Req 3.1).
 * - Candidate shape: every emitted candidate has a valid `record_id`,
 *   namespace, `source_event_ids`, and either a `Float32Array(384)`
 *   or `null` for `embedding` (Req 3.2, 3.5).
 * - Embedder failure path: with a failing embedder, every candidate
 *   has `embedding === null` and a stderr warning was emitted per
 *   candidate (Req 3.4).
 * - `toMemoryRecord` stamps `created_at` (ISO datetime with offset)
 *   and does not include an `embedding` field on the output
 *   (Req 7.7).
 * - `toMemoryRecord` preserves all other candidate fields.
 *
 * CRITICAL: All ACP interactions are mocked — no real `kiro-cli`
 * processes are spawned. The mock `createAcpSession` returns a fake
 * session with a controllable `sendPrompt` response.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 5.2
 * @see .kiro/specs/reconciliation-engine/requirements.md § Requirements 3.1–3.5, 7.7
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageBackend } from '../../src/types/index.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';
import type { Embedder } from '../../src/collector/embedding/index.js';
import type { CandidateMemory } from '../../src/types/index.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

/**
 * Queue of responses the mock ACP session will return from `sendPrompt`.
 * Each call to `createAcpSession` shifts the next response from the queue.
 */
const responseQueue: Array<string | Error> = [];

/**
 * Tracks every mock session created so tests can inspect `destroy()`
 * calls and assert the "single-use session" contract.
 */
const mockSessions: Array<{
  sendPrompt: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}> = [];

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
    mockSessions.push(session);
    return Promise.resolve(session);
  }),
}));

// ── Helpers ─────────────────────────────────────────────────────────────

/** Valid XML response with a single memory record. */
const SINGLE_RECORD_XML = `
<memory_record type="tool_use">
  <title>Test Memory</title>
  <summary>A test summary for the memory record</summary>
  <facts>
    <fact>fact one</fact>
  </facts>
  <concepts>
    <concept>testing</concept>
  </concepts>
  <files>
    <file>src/test.ts</file>
  </files>
</memory_record>
`.trim();

/** Valid XML response with two memory records. */
const MULTI_RECORD_XML = `
<memory_record type="tool_use">
  <title>First Memory</title>
  <summary>First summary for the memory record</summary>
  <facts>
    <fact>fact one</fact>
  </facts>
  <concepts>
    <concept>testing</concept>
  </concepts>
  <files>
    <file>src/a.ts</file>
  </files>
</memory_record>
<memory_record type="discovery">
  <title>Second Memory</title>
  <summary>Second summary for the memory record</summary>
  <facts>
    <fact>fact two</fact>
  </facts>
  <concepts>
    <concept>discovery</concept>
  </concepts>
  <files>
    <file>src/b.ts</file>
  </files>
</memory_record>
`.trim();

/**
 * Create a mock `StorageBackend` whose every write method is a vi.fn()
 * spy so tests can assert zero-write invariants.
 *
 * Only the methods `extractCandidates` might reasonably be tempted to
 * call are spied — `putMemoryRecord`, `putEmbedding`, and
 * `deleteMemoryRecord`. Every other method is a no-op default that keeps
 * the `StorageBackend` interface shape complete.
 */
function createSpyStorage(): StorageBackend & {
  putMemoryRecord: ReturnType<typeof vi.fn>;
  putEmbedding: ReturnType<typeof vi.fn>;
  deleteMemoryRecord: ReturnType<typeof vi.fn>;
} {
  return {
    putEvent: vi.fn().mockResolvedValue(undefined),
    getEventById: vi.fn().mockResolvedValue(null),
    putMemoryRecord: vi.fn().mockResolvedValue(undefined),
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
    deleteMemoryRecord: vi.fn().mockResolvedValue(undefined),
    withTransaction: vi.fn(async (fn) => {
      // Minimal pass-through — tests that use withTransaction will override.
      const tx = {
        putMemoryRecord: vi.fn(),
        putEmbedding: vi.fn(),
        deleteMemoryRecord: vi.fn(),
      };
      return fn(tx);
    }),
  };
}

/**
 * Build a valid `BufferEntry` with overridable fields.
 */
function makeBufferEntry(overrides: Partial<BufferEntry> = {}): BufferEntry {
  return {
    event_id: '01JF8ZS4Y00000000000000000',
    namespace: '/actor/alice/project/abc/',
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
    ...overrides,
  };
}

/**
 * Make a fake Embedder whose `embed` always resolves to a deterministic
 * vector. The vector is a 384-dim array of a constant value so tests
 * can both assert the shape and ignore the numeric content.
 */
function makeFakeReadyEmbedder(): Embedder & {
  embed: ReturnType<typeof vi.fn>;
} {
  const vec = new Float32Array(384);
  for (let i = 0; i < 384; i++) vec[i] = 0.1;
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    embed: vi.fn(async () => {
      // Return a fresh Float32Array so candidates don't share storage.
      return Float32Array.from(vec);
    }),
    dim: 384,
  };
}

/** Embedder that is configured but not ready (degraded mode). */
function makeNotReadyEmbedder(): Embedder {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => false),
    embed: vi.fn(async () => {
      throw new Error('not ready');
    }),
    dim: 384,
  };
}

/** Embedder that is ready but always fails per call. */
function makeFailingEmbedder(): Embedder & {
  embed: ReturnType<typeof vi.fn>;
} {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    embed: vi.fn(async () => {
      throw new Error('embed failed');
    }),
    dim: 384,
  };
}

beforeEach(() => {
  responseQueue.length = 0;
  mockSessions.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('extractCandidates', () => {
  /**
   * Test 1 — extraction never writes.
   *
   * Validates: Requirement 3.1 — "THE Extraction_Stage SHALL emit an
   * in-memory list of Candidate Memories and SHALL NOT call
   * `StorageBackend.putMemoryRecord` or `StorageBackend.putEmbedding`."
   */
  it('never calls putMemoryRecord or putEmbedding on the storage backend', async () => {
    responseQueue.push(MULTI_RECORD_XML);

    const { extractCandidates } = await import(
      '../../src/collector/ingestion/candidate.js'
    );

    const storage = createSpyStorage();
    const embedder = makeFakeReadyEmbedder();

    const entries: BufferEntry[] = [
      makeBufferEntry({ event_id: '01JF8ZS4Y00000000000000001' }),
      makeBufferEntry({ event_id: '01JF8ZS4Y00000000000000002' }),
    ];

    const candidates = await extractCandidates(
      entries,
      { timeoutMs: 30_000, maxRetries: 3 },
      { storage, embedder },
    );

    expect(candidates).toHaveLength(2);
    expect(storage.putMemoryRecord).not.toHaveBeenCalled();
    expect(storage.putEmbedding).not.toHaveBeenCalled();
    expect(storage.deleteMemoryRecord).not.toHaveBeenCalled();
  });

  /**
   * Test 2 — candidate shape is valid.
   *
   * Validates: Requirements 3.2, 3.5 — every candidate has a valid
   * `record_id`, `namespace` (carried from the buffer entry),
   * `source_event_ids` (every event id from the snapshot), and an
   * embedding shape that is either `Float32Array(384)` or `null`.
   */
  it('emits candidates with valid record_id, namespace, source_event_ids, and embedding shape', async () => {
    responseQueue.push(MULTI_RECORD_XML);

    const { extractCandidates } = await import(
      '../../src/collector/ingestion/candidate.js'
    );

    const storage = createSpyStorage();
    const embedder = makeFakeReadyEmbedder();

    const entries: BufferEntry[] = [
      makeBufferEntry({ event_id: '01JF8ZS4Y00000000000000001' }),
      makeBufferEntry({ event_id: '01JF8ZS4Y00000000000000002' }),
    ];

    const candidates = await extractCandidates(
      entries,
      { timeoutMs: 30_000, maxRetries: 3 },
      { storage, embedder },
    );

    expect(candidates).toHaveLength(2);

    for (const c of candidates) {
      expect(c.record_id).toMatch(/^mr_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(c.namespace).toBe('/actor/alice/project/abc/');
      expect(c.source_event_ids).toEqual([
        '01JF8ZS4Y00000000000000001',
        '01JF8ZS4Y00000000000000002',
      ]);
      expect(c.strategy).toBe('llm-summary');
      // Embedding is either a 384-dim Float32Array or null.
      if (c.embedding === null) {
        // allowed under Req 3.4; not the expected branch here though.
        expect(c.embedding).toBeNull();
      } else {
        expect(c.embedding).toBeInstanceOf(Float32Array);
        expect(c.embedding.length).toBe(384);
      }
    }

    // With a ready, succeeding embedder, we expect both to be populated.
    expect(candidates[0]!.embedding).toBeInstanceOf(Float32Array);
    expect(candidates[1]!.embedding).toBeInstanceOf(Float32Array);
  });

  /**
   * Test 3 — embedder failure yields null embeddings with stderr warning.
   *
   * Validates: Requirement 3.4 — "IF the Embedder is not ready or fails
   * for a given Candidate Memory, THEN THE Extraction_Stage SHALL emit
   * the Candidate Memory with a null embedding and log a warning
   * identifying the candidate's `record_id`."
   */
  it('emits null embedding and warns per record when embedder fails', async () => {
    responseQueue.push(MULTI_RECORD_XML);

    const { extractCandidates } = await import(
      '../../src/collector/ingestion/candidate.js'
    );

    const storage = createSpyStorage();
    const embedder = makeFailingEmbedder();

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const entries: BufferEntry[] = [
      makeBufferEntry({ event_id: '01JF8ZS4Y00000000000000001' }),
    ];

    const candidates = await extractCandidates(
      entries,
      { timeoutMs: 30_000, maxRetries: 3 },
      { storage, embedder },
    );

    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.embedding).toBeNull();
    }

    // A per-record warning should have been written, each mentioning
    // the candidate's record_id.
    const warnings = stderrSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((m) => m.includes('embedding failed for candidate'));
    expect(warnings).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      expect(warnings[i]).toContain(candidates[i]!.record_id);
    }

    stderrSpy.mockRestore();
  });

  /**
   * Test 3b — not-ready embedder yields null embeddings with degraded-
   * mode warning.
   *
   * The "not ready" branch exercises Req 3.4's "IF the Embedder is not
   * ready" clause separately from the per-call failure clause above.
   */
  it('emits null embedding and warns per record when embedder is not ready', async () => {
    responseQueue.push(SINGLE_RECORD_XML);

    const { extractCandidates } = await import(
      '../../src/collector/ingestion/candidate.js'
    );

    const storage = createSpyStorage();
    const embedder = makeNotReadyEmbedder();

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const candidates = await extractCandidates(
      [makeBufferEntry()],
      { timeoutMs: 30_000, maxRetries: 3 },
      { storage, embedder },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.embedding).toBeNull();

    const degradedWarnings = stderrSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((m) => m.includes('degraded mode') && m.includes('embedder not ready'));
    expect(degradedWarnings.length).toBeGreaterThan(0);

    stderrSpy.mockRestore();
  });

  /**
   * Test 4 — null embedder yields null embeddings without warning.
   *
   * When the collector is configured without an embedder (operator
   * choice), extraction still produces candidates but with
   * `embedding: null` and NO per-record warning — the degraded-mode
   * warning is reserved for the "configured but not ready" case.
   */
  it('emits null embedding when embedder is null (no warning)', async () => {
    responseQueue.push(SINGLE_RECORD_XML);

    const { extractCandidates } = await import(
      '../../src/collector/ingestion/candidate.js'
    );

    const storage = createSpyStorage();

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const candidates = await extractCandidates(
      [makeBufferEntry()],
      { timeoutMs: 30_000, maxRetries: 3 },
      { storage, embedder: null },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.embedding).toBeNull();

    const warnings = stderrSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((m) => m.includes('embedding') || m.includes('degraded mode'));
    expect(warnings).toHaveLength(0);

    stderrSpy.mockRestore();
  });

  /**
   * Test 5 — empty input returns empty output.
   *
   * An empty buffer snapshot must produce zero candidates and never
   * create an ACP session.
   */
  it('returns empty array on empty input and does not create ACP session', async () => {
    const { extractCandidates } = await import(
      '../../src/collector/ingestion/candidate.js'
    );

    const storage = createSpyStorage();
    const embedder = makeFakeReadyEmbedder();

    const candidates = await extractCandidates(
      [],
      { timeoutMs: 30_000, maxRetries: 3 },
      { storage, embedder },
    );

    expect(candidates).toEqual([]);
    expect(mockSessions).toHaveLength(0);
  });
});

describe('toMemoryRecord', () => {
  /**
   * Test 6 — `toMemoryRecord` stamps a well-formed `created_at`.
   *
   * Validates: Requirement 7.7 — "THE Summary_Record SHALL set
   * `created_at` to the current wall-clock time at commit." The same
   * contract applies to keep-separate commits that run through
   * `toMemoryRecord`.
   */
  it('stamps created_at as an ISO 8601 datetime with offset', async () => {
    const { toMemoryRecord } = await import(
      '../../src/collector/ingestion/candidate.js'
    );

    const candidate: CandidateMemory = {
      record_id: 'mr_01JF8ZS4Y00000000000000000',
      namespace: '/actor/alice/project/abc/',
      strategy: 'llm-summary',
      source_event_ids: ['01JF8ZS4Y00000000000000001'],
      title: 'Test',
      summary: 'Summary',
      facts: ['fact one'],
      concepts: ['concept one'],
      files_touched: ['src/test.ts'],
      observation_type: 'tool_use',
      embedding: new Float32Array(384),
    };

    const before = Date.now();
    const record = toMemoryRecord(candidate);
    const after = Date.now();

    // Must parse as a real date.
    const parsed = Date.parse(record.created_at);
    expect(Number.isFinite(parsed)).toBe(true);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);

    // Zod's datetime({offset:true}) accepts either trailing `Z` or a
    // numeric offset like `+00:00`. `toISOString()` always emits `Z`.
    expect(record.created_at).toMatch(/[Zz]|[+-]\d{2}:\d{2}$/);
  });

  /**
   * Test 7 — `toMemoryRecord` does not carry the transient `embedding`
   * field onto the committable record.
   */
  it('does not include an embedding field on the output', async () => {
    const { toMemoryRecord } = await import(
      '../../src/collector/ingestion/candidate.js'
    );

    const candidate: CandidateMemory = {
      record_id: 'mr_01JF8ZS4Y00000000000000000',
      namespace: '/actor/alice/project/abc/',
      strategy: 'llm-summary',
      source_event_ids: ['01JF8ZS4Y00000000000000001'],
      title: 'Test',
      summary: 'Summary',
      facts: [],
      concepts: [],
      files_touched: [],
      observation_type: 'tool_use',
      embedding: new Float32Array(384),
    };

    const record = toMemoryRecord(candidate);

    expect(Object.keys(record)).not.toContain('embedding');
    expect((record as unknown as Record<string, unknown>)['embedding']).toBeUndefined();
  });

  /**
   * Test 8 — `toMemoryRecord` preserves every non-transient field.
   */
  it('preserves all non-transient candidate fields verbatim', async () => {
    const { toMemoryRecord } = await import(
      '../../src/collector/ingestion/candidate.js'
    );

    const candidate: CandidateMemory = {
      record_id: 'mr_01JF8ZS4Y00000000000000042',
      namespace: '/actor/bob/project/xyz/',
      strategy: 'llm-reconciled',
      source_event_ids: [
        '01JF8ZS4Y00000000000000001',
        '01JF8ZS4Y00000000000000002',
      ],
      title: 'Preserved title',
      summary: 'Preserved summary with detail',
      facts: ['fact a', 'fact b'],
      concepts: ['concept x'],
      files_touched: ['src/a.ts', 'src/b.ts'],
      observation_type: 'decision',
      embedding: null,
    };

    const record = toMemoryRecord(candidate);

    expect(record.record_id).toBe(candidate.record_id);
    expect(record.namespace).toBe(candidate.namespace);
    expect(record.strategy).toBe(candidate.strategy);
    expect(record.source_event_ids).toEqual(candidate.source_event_ids);
    expect(record.title).toBe(candidate.title);
    expect(record.summary).toBe(candidate.summary);
    expect(record.facts).toEqual(candidate.facts);
    expect(record.concepts).toEqual(candidate.concepts);
    expect(record.files_touched).toEqual(candidate.files_touched);
    expect(record.observation_type).toBe(candidate.observation_type);
  });

  /**
   * Test 9 — `toMemoryRecord` output passes `parseMemoryRecord`.
   *
   * Ensures the stamped record is valid per the wire-contract schema,
   * so keep-separate commits feeding directly into `putMemoryRecord`
   * will not be rejected by the Zod parser.
   */
  it('produces a record that passes parseMemoryRecord', async () => {
    const { toMemoryRecord } = await import(
      '../../src/collector/ingestion/candidate.js'
    );
    const { parseMemoryRecord } = await import('../../src/types/index.js');

    const candidate: CandidateMemory = {
      record_id: 'mr_01JF8ZS4Y00000000000000000',
      namespace: '/actor/alice/project/abc/',
      strategy: 'llm-summary',
      source_event_ids: ['01JF8ZS4Y00000000000000001'],
      title: 'Test',
      summary: 'Summary',
      facts: ['fact one'],
      concepts: ['concept one'],
      files_touched: ['src/test.ts'],
      observation_type: 'tool_use',
      embedding: new Float32Array(384),
    };

    const record = toMemoryRecord(candidate);
    // Should not throw.
    expect(() => parseMemoryRecord(record)).not.toThrow();
  });
});
