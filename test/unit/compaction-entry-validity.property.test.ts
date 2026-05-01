/**
 * Property test: Compacted entry validity (Property 8).
 *
 * For any successful model compaction, every returned BufferEntry has
 * `event_id` prefixed with `compact_`, `kind` of `session_summary`,
 * `body` of type `text`, `timestamp` equal to the latest input timestamp,
 * and `namespace`/`surface` preserved from input entries.
 *
 * **Validates: Requirements 3.4, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6**
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Property 8
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirements 3, 18
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

import type { BufferStore, ReplaceResult } from '../../src/collector/buffer/store.js';
import type { BufferWatcher } from '../../src/collector/buffer/watcher.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';
import { namespaceArb, isoDateArb } from '../helpers/arbitrary.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

/**
 * Factory that controls what `createAcpSession` returns. Each test sets
 * this before calling `compact()`.
 */
let sessionFactory: () => Promise<{
  sendPrompt: (content: string) => Promise<string>;
  destroy: () => void;
}>;

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() => sessionFactory()),
}));

// ── Fake dependencies ───────────────────────────────────────────────────

/** Captured entries passed to `BufferStore.replace()`. */
let replacedEntries: readonly BufferEntry[];

function createFakeBufferStore(entries: BufferEntry[]): BufferStore {
  const serialized = entries.map((e) => JSON.stringify(e) + '\n').join('');
  const sizeBytes = Buffer.byteLength(serialized, 'utf-8');

  return {
    append: vi.fn().mockResolvedValue(0),
    snapshot: vi.fn().mockResolvedValue(entries),
    snapshotWithSize: vi.fn().mockResolvedValue({ entries, sizeBytes }),
    size: vi.fn().mockResolvedValue(sizeBytes),
    bufferPath: vi.fn().mockReturnValue('/fake/buffer.ndjson'),
    listProjects: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
    sizeSync: vi.fn().mockReturnValue(sizeBytes),
    replace: vi.fn().mockImplementation(
      (_projectId: string, newEntries: readonly BufferEntry[]) => {
        replacedEntries = newEntries;
        return Promise.resolve({
          catchUpEntries: [],
          newSizeBytes: 100,
        } satisfies ReplaceResult);
      },
    ),
  };
}

function createFakeWatcher(): BufferWatcher {
  return {
    notifyAppend: vi.fn().mockReturnValue(true),
    wouldExceedCeiling: vi.fn().mockReturnValue(false),
    notifyExtractionResult: vi.fn(),
    onExtraction: vi.fn(),
    onCompaction: vi.fn(),
    notifyCompactionResult: vi.fn(),
    close: vi.fn(),
    _getState: vi.fn().mockReturnValue(undefined),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Build a valid `<compacted_entry>` XML response from summary strings.
 */
function buildModelResponse(summaries: string[]): string {
  return summaries
    .map((s) => `<compacted_entry>${s}</compacted_entry>`)
    .join('\n');
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Property 8: Compacted entry validity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replacedEntries = [];
  });

  /**
   * Property 8: For any successful model compaction, every returned
   * BufferEntry has:
   * - `event_id` starting with `compact_`
   * - `kind === 'session_summary'`
   * - `body.type === 'text'`
   * - `timestamp` equal to the latest timestamp from input entries
   * - `namespace` preserved from input entries
   * - `surface` preserved from input entries
   *
   * **Validates: Requirements 3.4, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6**
   */
  it('compacted entries have correct event_id prefix, kind, body type, timestamp, namespace, and surface', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a shared namespace and surface so all entries in the
        // batch share them (as they would in a real per-project buffer)
        namespaceArb(),
        fc.constantFrom('kiro-cli' as const, 'kiro-ide' as const),
        // Generate 1–5 timestamps, then build entries from them
        fc.array(isoDateArb(), { minLength: 1, maxLength: 5 }),
        // Generate 1–3 summary strings for the model response.
        // Must be non-empty after trimming — whitespace-only strings are
        // legitimately skipped by parseCompactionResponse.
        // Must not contain XML-special characters that would break the
        // synthetic <compacted_entry> wrapper built by buildModelResponse.
        fc.array(
          fc.string({ minLength: 1, maxLength: 200 }).filter(
            (s) =>
              s.trim().length > 0 &&
              !s.includes('<') &&
              !s.includes('>') &&
              !s.includes('&'),
          ),
          { minLength: 1, maxLength: 3 },
        ),
        async (namespace, surface, timestamps, summaries) => {
          // Build entries that share the same namespace and surface
          const entries: BufferEntry[] = timestamps.map((ts, i) => ({
            event_id: `EVT${String(i).padStart(23, '0')}`,
            namespace,
            kind: 'tool_use' as const,
            body: { type: 'text' as const, content: `observation ${String(i)}` },
            timestamp: ts,
            surface,
          }));

          // Compute the expected latest timestamp
          const latestTimestamp = entries.reduce(
            (latest, e) => (e.timestamp > latest ? e.timestamp : latest),
            entries[0]!.timestamp,
          );

          // Mock the ACP session to return valid compacted entries
          sessionFactory = () =>
            Promise.resolve({
              sendPrompt: vi.fn(() =>
                Promise.resolve(buildModelResponse(summaries)),
              ),
              destroy: vi.fn(),
            });

          const store = createFakeBufferStore(entries);
          const watcher = createFakeWatcher();

          const { createCompactionWorker } = await import(
            '../../src/collector/buffer/compaction.js'
          );

          const worker = createCompactionWorker({
            bufferStore: store,
            watcher,
            config: { enabled: true },
          });

          const result = await worker.compact('test-project');

          // Model compaction should have been used (not fallback)
          expect(result.usedFallback).toBe(false);

          // Inspect the entries passed to BufferStore.replace()
          expect(replacedEntries.length).toBe(summaries.length);

          for (const entry of replacedEntries) {
            // event_id starts with 'compact_'
            expect(entry.event_id).toMatch(/^compact_/);

            // kind is 'session_summary'
            expect(entry.kind).toBe('session_summary');

            // body is of type 'text'
            expect(entry.body.type).toBe('text');

            // timestamp equals the latest input timestamp
            expect(entry.timestamp).toBe(latestTimestamp);

            // namespace is preserved from input entries
            expect(entry.namespace).toBe(namespace);

            // surface is preserved from input entries
            expect(entry.surface).toBe(surface);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * Property 8 (body content): The text content of each compacted entry
   * matches the corresponding summary string from the model response.
   *
   * **Validates: Requirements 18.1, 18.5**
   */
  it('compacted entry body content matches model response summaries', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate 1–4 summary strings that:
        // - are non-empty after trimming (whitespace-only blocks are skipped by the parser)
        // - don't contain XML-special characters (which would be altered by unescape)
        fc.array(
          fc.string({ minLength: 1, maxLength: 100 }).filter(
            (s) =>
              s.trim().length > 0 &&
              !s.includes('<') &&
              !s.includes('>') &&
              !s.includes('&') &&
              !s.includes("'") &&
              !s.includes('"'),
          ),
          { minLength: 1, maxLength: 4 },
        ),
        async (summaries) => {
          // Build a minimal set of entries
          const entries: BufferEntry[] = [
            {
              event_id: 'EVT00000000000000000000000',
              namespace: '/actor/test/project/proj/',
              kind: 'tool_use' as const,
              body: { type: 'text' as const, content: 'observation' },
              timestamp: '2025-01-01T00:00:00.000Z',
              surface: 'kiro-cli',
            },
          ];

          sessionFactory = () =>
            Promise.resolve({
              sendPrompt: vi.fn(() =>
                Promise.resolve(buildModelResponse(summaries)),
              ),
              destroy: vi.fn(),
            });

          const store = createFakeBufferStore(entries);
          const watcher = createFakeWatcher();

          const { createCompactionWorker } = await import(
            '../../src/collector/buffer/compaction.js'
          );

          const worker = createCompactionWorker({
            bufferStore: store,
            watcher,
            config: { enabled: true },
          });

          await worker.compact('test-project');

          expect(replacedEntries.length).toBe(summaries.length);

          for (let i = 0; i < summaries.length; i++) {
            const entry = replacedEntries[i]!;
            const expected = summaries[i]!.trim();
            expect(entry.body).toEqual({
              type: 'text',
              content: expected,
            });
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
