/**
 * Property-based tests for candidate construction — Properties 3, 10,
 * 11, 12 from the reconciliation-engine design.
 *
 * These properties pin down the Extraction Stage's contract:
 *
 * - **Property 3: Extraction never writes.** A run of `extractCandidates`
 *   against any buffer snapshot makes zero `putMemoryRecord`,
 *   `putEmbedding`, or `deleteMemoryRecord` calls on the storage backend.
 * - **Property 10: Candidate embedding input parity.** The string passed
 *   to `embedder.embed(...)` equals `composeEmbeddingInput(record)` where
 *   `record` is any `MemoryRecord` carrying the same `title`, `summary`,
 *   `facts`, `concepts` fields as the emitted candidate. (Those are the
 *   only fields `composeEmbeddingInput` reads — `created_at` and other
 *   provenance fields are irrelevant.)
 * - **Property 11: Null-embedding propagation on embedder failure.** With
 *   a failing embedder, every emitted candidate has `embedding === null`
 *   and the full candidate list is returned (no drops).
 * - **Property 12: Record ID format and uniqueness.** Every candidate's
 *   `record_id` matches `/^mr_[0-9A-HJKMNP-TV-Z]{26}$/` and no two
 *   collide within a single extraction run.
 *
 * All tests mock the ACP session so no real `kiro-cli` is spawned. The
 * mock accepts whatever batch XML it is handed and returns a scripted
 * response containing one `<memory_record>` block per generated buffer
 * entry — that way the number of candidates produced equals the number
 * of entries, which is a useful shape-invariant for the assertions.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 5.3
 * @see .kiro/specs/reconciliation-engine/design.md § Correctness Properties — Properties 3, 10, 11, 12
 * @see .kiro/specs/reconciliation-engine/requirements.md § Requirements 3.1, 3.3, 3.4, 3.5, 7.2
 */

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StorageBackend } from '../../src/types/index.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';
import type { Embedder } from '../../src/collector/embedding/index.js';
import { bufferEntryArb } from '../helpers/arbitrary.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

/**
 * Per-test scripted response supplier. Each test sets this to a function
 * that, given the prompt, returns the XML the mock session should emit.
 * The default (set in `beforeEach`) echoes N identical `<memory_record>`
 * blocks where N equals the number of `<tool_observation>` blocks in the
 * prompt — matching the input cardinality so property assertions about
 * "one candidate per emitted record" are easy to express.
 */
let scriptedResponseFor: (prompt: string) => string | Error = () => '';

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() => {
    const session = {
      sendPrompt: vi.fn((prompt: string) => {
        const resp = scriptedResponseFor(prompt);
        if (resp instanceof Error) {
          return Promise.reject(resp);
        }
        return Promise.resolve(resp);
      }),
      destroy: vi.fn(),
    };
    return Promise.resolve(session);
  }),
}));

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Produce a deterministic response that contains exactly `count` minimal
 * `<memory_record>` blocks — enough for `parseMemoryXml` to emit `count`
 * `RawMemoryFields` entries without running into the length caps.
 */
function scriptedNRecords(count: number): string {
  const blocks: string[] = [];
  for (let i = 0; i < count; i++) {
    blocks.push(`
<memory_record type="tool_use">
  <title>Title ${String(i)}</title>
  <summary>Summary for record ${String(i)}</summary>
  <facts>
    <fact>fact ${String(i)}</fact>
  </facts>
  <concepts>
    <concept>concept ${String(i)}</concept>
  </concepts>
  <files>
    <file>src/${String(i)}.ts</file>
  </files>
</memory_record>
`.trim());
  }
  return blocks.join('\n');
}

/**
 * Count the number of `<tool_observation>` blocks in the prompt so the
 * scripted response can size its output to match the input cardinality.
 * Useful for property tests that want `candidates.length === n`.
 */
function countObservations(prompt: string): number {
  const matches = prompt.match(/<tool_observation>/g);
  return matches === null ? 0 : matches.length;
}

/**
 * Spy storage whose write methods are vi.fn()s.
 */
function createSpyStorage(): StorageBackend & {
  putMemoryRecord: ReturnType<typeof vi.fn>;
  putEmbedding: ReturnType<typeof vi.fn>;
  deleteMemoryRecord: ReturnType<typeof vi.fn>;
  withTransaction: ReturnType<typeof vi.fn>;
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
 * A ready embedder whose every call records the input it was asked to
 * embed. Returns a deterministic vector so downstream shape assertions
 * are stable across runs.
 */
function makeRecordingEmbedder(): {
  embedder: Embedder;
  inputs: string[];
} {
  const inputs: string[] = [];
  const vec = new Float32Array(384);
  for (let i = 0; i < 384; i++) vec[i] = 0.01;
  const embedder: Embedder = {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    embed: vi.fn(async (input: string) => {
      inputs.push(input);
      return Float32Array.from(vec);
    }),
    dim: 384,
  };
  return { embedder, inputs };
}

/** Embedder that always fails per call. */
function makeFailingEmbedder(): Embedder {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    embed: vi.fn(async () => {
      throw new Error('embed failed');
    }),
    dim: 384,
  };
}

/**
 * Force all generated entries to share a single namespace (matching the
 * runtime invariant that buffer snapshots are per-project, not
 * per-event). Also force the `body` to a small `text` variant so the
 * framed XML stays bounded and test runtime stays reasonable under
 * 100 fast-check iterations.
 */
function sharedNamespaceEntriesArb(
  ns: string,
): fc.Arbitrary<BufferEntry[]> {
  return fc
    .array(bufferEntryArb(), { minLength: 1, maxLength: 5 })
    .map((entries) =>
      entries.map((e) => ({
        ...e,
        namespace: ns,
        // Keep bodies small and well-formed so framing + XML parsing is
        // fast. Use a text body with short content; the compressor mock
        // ignores the payload anyway.
        body: { type: 'text' as const, content: 'ok' },
      })),
    );
}

beforeEach(() => {
  // Default: emit as many memory records as there are tool_observation
  // blocks in the prompt.
  scriptedResponseFor = (prompt) => scriptedNRecords(countObservations(prompt));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('Candidate construction — Property 3: extraction never writes', () => {
  it('never calls putMemoryRecord, putEmbedding, or deleteMemoryRecord for any valid batch', async () => {
    /**
     * **Validates: Requirement 3.1**
     *
     * For any non-empty list of valid `BufferEntry` objects sharing a
     * namespace, `extractCandidates` returns an array of candidates
     * while making zero write calls on the backend.
     */
    const { extractCandidates } = await import(
      '../../src/collector/ingestion/candidate.js'
    );

    await fc.assert(
      fc.asyncProperty(
        sharedNamespaceEntriesArb('/actor/alice/project/p1/'),
        async (entries) => {
          const storage = createSpyStorage();
          const { embedder } = makeRecordingEmbedder();

          await extractCandidates(
            entries,
            { timeoutMs: 30_000, maxRetries: 3 },
            { storage, embedder },
          );

          expect(storage.putMemoryRecord).not.toHaveBeenCalled();
          expect(storage.putEmbedding).not.toHaveBeenCalled();
          expect(storage.deleteMemoryRecord).not.toHaveBeenCalled();
          // Also prove extraction doesn't sneak writes in through a
          // transaction handle — a future regression that opened
          // one via `storage.withTransaction((tx) => tx.putMemoryRecord(...))`
          // would slip past the three assertions above.
          expect(storage.withTransaction).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Candidate construction — Property 10: embedding input parity', () => {
  it('embedder.embed receives composeEmbeddingInput of the emitted candidate', async () => {
    /**
     * **Validates: Requirements 3.3, 3.5**
     *
     * For every emitted candidate, the string passed to
     * `embedder.embed(...)` equals
     * `composeEmbeddingInput(<MemoryRecord with the candidate's text
     * fields>)`. `composeEmbeddingInput` only reads `title`, `summary`,
     * `facts`, `concepts` — so we recompute it from the candidate
     * alone (created_at and other provenance fields are irrelevant).
     */
    const { extractCandidates } = await import(
      '../../src/collector/ingestion/candidate.js'
    );
    const { composeEmbeddingInput } = await import(
      '../../src/collector/embedding/index.js'
    );

    await fc.assert(
      fc.asyncProperty(
        sharedNamespaceEntriesArb('/actor/alice/project/p1/'),
        async (entries) => {
          const storage = createSpyStorage();
          const { embedder, inputs } = makeRecordingEmbedder();

          const candidates = await extractCandidates(
            entries,
            { timeoutMs: 30_000, maxRetries: 3 },
            { storage, embedder },
          );

          // Every candidate should have been embedded exactly once.
          expect(inputs).toHaveLength(candidates.length);

          for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i]!;
            // Reconstruct the input the composer would have built.
            // `composeEmbeddingInput` reads only text fields; the
            // other `MemoryRecord` fields are carrier-only, so the
            // placeholder `created_at` value does not affect the
            // output.
            const expected = composeEmbeddingInput({
              record_id: c.record_id,
              namespace: c.namespace,
              strategy: c.strategy,
              source_event_ids: c.source_event_ids,
              created_at: '2020-01-01T00:00:00.000Z',
              title: c.title,
              summary: c.summary,
              facts: c.facts,
              concepts: c.concepts,
              files_touched: c.files_touched,
              observation_type: c.observation_type,
            });
            expect(inputs[i]).toBe(expected);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Candidate construction — Property 11: null-embedding propagation', () => {
  it('every candidate has null embedding when embedder fails, and the full list is returned', async () => {
    /**
     * **Validates: Requirement 3.4**
     *
     * With a failing embedder, every emitted candidate has
     * `embedding === null` (no crash, no drop). The candidate array
     * length equals the number of `<memory_record>` blocks in the
     * scripted response — no candidates are silently dropped.
     */
    const { extractCandidates } = await import(
      '../../src/collector/ingestion/candidate.js'
    );

    // Silence the per-record stderr warning this property emits.
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      await fc.assert(
        fc.asyncProperty(
          sharedNamespaceEntriesArb('/actor/alice/project/p1/'),
          async (entries) => {
            const storage = createSpyStorage();
            const embedder = makeFailingEmbedder();

            const candidates = await extractCandidates(
              entries,
              { timeoutMs: 30_000, maxRetries: 3 },
              { storage, embedder },
            );

            // The scripted response emits one record per buffer entry,
            // so the candidate count equals the input size.
            expect(candidates.length).toBe(entries.length);
            for (const c of candidates) {
              expect(c.embedding).toBeNull();
            }
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('Candidate construction — Property 12: record_id format + uniqueness', () => {
  it('every candidate record_id matches the ULID pattern and ids are unique within a run', async () => {
    /**
     * **Validates: Requirement 7.2**
     *
     * For every run of `extractCandidates`, every emitted candidate
     * carries a `record_id` of the form `mr_<ULID>` and no two
     * candidates share the same id within a single run.
     */
    const { extractCandidates } = await import(
      '../../src/collector/ingestion/candidate.js'
    );

    await fc.assert(
      fc.asyncProperty(
        sharedNamespaceEntriesArb('/actor/alice/project/p1/'),
        async (entries) => {
          const storage = createSpyStorage();
          const { embedder } = makeRecordingEmbedder();

          const candidates = await extractCandidates(
            entries,
            { timeoutMs: 30_000, maxRetries: 3 },
            { storage, embedder },
          );

          const ids = new Set<string>();
          for (const c of candidates) {
            // Format check.
            expect(c.record_id).toMatch(/^mr_[0-9A-HJKMNP-TV-Z]{26}$/);
            // Uniqueness check.
            expect(ids.has(c.record_id)).toBe(false);
            ids.add(c.record_id);
          }
          expect(ids.size).toBe(candidates.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});
