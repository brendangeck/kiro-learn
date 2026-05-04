/**
 * Property-based test for the `ingestion-pipeline-run` structured
 * log — reconciliation-engine Task 14.4, Property 22.
 *
 * ## Property 22 — Ingestion-run log structural conformance
 *
 * For any ingestion run (any snapshot shape, any extraction outcome,
 * any reconciliation outcome), exactly one JSON-Lines record is
 * written to stderr whose parsed object is a **superset** of the
 * required keys:
 *
 * - `event: 'ingestion-pipeline-run'`
 * - `project_id`, `namespace`
 * - `events_processed`, `candidates_produced`, `clusters_formed`
 * - `judge_invocations`, `merge_decisions`, `keep_separate_decisions`
 * - `summary_records_committed`, `records_deleted`,
 *   `direct_committed_records`
 * - `circuit_breaker_open`, `reconciliation_enabled`
 * - `duration_ms`, `phase_latency_ms: { extraction, clustering,
 *   neighbor_lookup, judge, commit }`
 *
 * Every numeric field is a non-negative integer-valued number.
 * `duration_ms >= extraction + clustering + neighbor_lookup + judge
 * + commit`.
 *
 * ## Mocking strategy
 *
 * `extractCandidates` and `reconcile` are mocked via `vi.mock` so
 * we can drive the pipeline through every control-flow arm (zero
 * candidates, direct commit, full reconciliation with arbitrary
 * decision counts, all-clusters-failed). Storage is a spy — no real
 * SQLite — because the log comes from the pipeline, not from
 * storage; the pipeline is what we're testing.
 *
 * 100 runs.
 *
 * **Validates: Requirements 11.1, 11.2**
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 14.4
 * @see .kiro/specs/reconciliation-engine/design.md § Correctness Properties — Property 22
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BufferEntry } from '../../src/collector/buffer/types.js';
import type { QueryLayer } from '../../src/collector/query/index.js';
import type { ReconciliationOutcome } from '../../src/collector/ingestion/reconciler.js';
import type { CandidateMemory, StorageBackend } from '../../src/types/index.js';

// ── Mocks ───────────────────────────────────────────────────────────────

const reconcileMock = vi.fn<
  (
    candidates: readonly CandidateMemory[],
    ctx: unknown,
  ) => Promise<ReconciliationOutcome>
>();

const extractCandidatesMock = vi.fn<
  (entries: readonly BufferEntry[], config: unknown, deps: unknown) => Promise<CandidateMemory[]>
>();

vi.mock('../../src/collector/ingestion/reconciler.js', () => ({
  reconcile: reconcileMock,
}));

vi.mock('../../src/collector/ingestion/candidate.js', async () => {
  const actual = (await vi.importActual(
    '../../src/collector/ingestion/candidate.js',
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  )) as typeof import('../../src/collector/ingestion/candidate.js');
  return {
    ...actual,
    extractCandidates: extractCandidatesMock,
  };
});

// ── Helpers ─────────────────────────────────────────────────────────────

function makeCandidate(seed: number): CandidateMemory {
  return {
    record_id: `mr_01JF8ZS4Y0000000000CAN${String(seed).padStart(5, '0')}`,
    namespace: '/actor/alice/project/prop22/',
    strategy: 'llm-summary',
    source_event_ids: [`01JF8ZS4Y000000000EV${String(seed).padStart(6, '0')}`],
    title: `Candidate ${String(seed)}`,
    summary: `Summary body for candidate number ${String(seed)} long enough for schema`,
    facts: [`fact ${String(seed)}`],
    concepts: [`concept ${String(seed)}`],
    files_touched: [`src/file${String(seed)}.ts`],
    observation_type: 'tool_use',
    embedding: null,
  };
}

function makeBufferEntry(seed: number): BufferEntry {
  const id = `01JF8ZS4Y000000000EV${String(seed).padStart(6, '0')}`;
  return {
    event_id: id,
    namespace: '/actor/alice/project/prop22/',
    kind: 'tool_use',
    body: {
      type: 'json',
      data: { tool_name: 'readFile', tool_input: { path: `src/x${String(seed)}.ts` } },
    },
    timestamp: '2026-04-23T20:00:00.000Z',
    surface: 'kiro-cli',
  };
}

function makeMockStorage(): StorageBackend {
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
    withTransaction: vi
      .fn()
      .mockImplementation((fn: (tx: unknown) => unknown) =>
        Promise.resolve(
          fn({
            putMemoryRecord: vi.fn(),
            putEmbedding: vi.fn(),
            deleteMemoryRecord: vi.fn(),
          }),
        ),
      ),
  };
}

function makeMockQuery(): QueryLayer {
  return {
    search: vi.fn().mockResolvedValue([]),
    invalidateNamespace: vi.fn(),
    getVectorIndex: vi.fn().mockResolvedValue({ entries: [] }),
    lookupNeighbors: vi.fn().mockResolvedValue([]),
  };
}

// ── Test environment — shared, reset per-iteration ──────────────────────

let tmpDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;
const stderrLines: string[] = [];

beforeEach(() => {
  reconcileMock.mockReset();
  extractCandidatesMock.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingestion-obs-prop-'));
  stderrLines.length = 0;
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });
});

afterEach(() => {
  stderrSpy.mockRestore();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Collect every `ingestion-pipeline-run` JSON-Lines record written to
 * stderr during the current test. Empty chunks and non-JSON lines
 * are skipped. Returns an array preserving emission order.
 */
function parseIngestionRunLogs(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const chunk of stderrLines) {
    for (const piece of chunk.split('\n')) {
      const trimmed = piece.trim();
      if (trimmed.length === 0 || !trimmed.startsWith('{')) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (obj['event'] === 'ingestion-pipeline-run') out.push(obj);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

// ── Fast-check arbitraries ──────────────────────────────────────────────

/**
 * Arbitrary outcome summary — integer phase latencies (milliseconds)
 * and non-negative decision counts. The pipeline sums these into the
 * log's `phase_latency_ms` and `duration_ms` assertions.
 */
function reconciliationOutcomeArb(): fc.Arbitrary<ReconciliationOutcome> {
  const nonNegInt = fc.nat({ max: 100 });
  return fc.record({
    summaryRecordsCommitted: nonNegInt,
    recordsDeleted: nonNegInt,
    keepSeparateCommitted: nonNegInt,
    judgeInvocations: nonNegInt,
    mergeDecisions: nonNegInt,
    keepSeparateDecisions: nonNegInt,
    clustersFailed: nonNegInt,
    phaseLatencyMs: fc.record({
      clustering: fc.nat({ max: 500 }),
      neighborLookup: fc.nat({ max: 500 }),
      judge: fc.nat({ max: 500 }),
      commit: fc.nat({ max: 500 }),
    }),
    anyJudgeFailure: fc.boolean(),
  });
}

/** Shape of one iteration's scripted state. */
interface Scenario {
  /** Number of buffer entries to seed — drives `events_processed`. */
  numEntries: number;
  /** Number of candidates extraction returns — drives `candidates_produced`. */
  numCandidates: number;
  /** When true, flip the feature flag off → direct-commit path. */
  reconciliationEnabled: boolean;
  /** When true (only valid when `reconciliationEnabled === true`), make extraction throw. */
  extractionFails: boolean;
  /** The reconciliation outcome to inject on the full-reconcile path. */
  outcome: ReconciliationOutcome;
}

function scenarioArb(): fc.Arbitrary<Scenario> {
  return fc
    .tuple(
      fc.nat({ max: 3 }),
      fc.nat({ max: 5 }),
      fc.boolean(),
      fc.boolean(),
      reconciliationOutcomeArb(),
    )
    .map(([numEntries, numCandidates, reconciliationEnabled, extractionFails, outcome]) => ({
      numEntries: numEntries + 1, // at least one entry so the pipeline doesn't take the zero-snapshot fast path
      numCandidates,
      reconciliationEnabled,
      extractionFails,
      outcome,
    }));
}

// ── Required keys ───────────────────────────────────────────────────────

const REQUIRED_TOP_LEVEL_KEYS = [
  'event',
  'project_id',
  'namespace',
  'events_processed',
  'candidates_produced',
  'clusters_formed',
  'judge_invocations',
  'merge_decisions',
  'keep_separate_decisions',
  'summary_records_committed',
  'records_deleted',
  'direct_committed_records',
  'circuit_breaker_open',
  'reconciliation_enabled',
  'duration_ms',
  'phase_latency_ms',
] as const;

const REQUIRED_NON_NEG_INT_FIELDS = [
  'events_processed',
  'candidates_produced',
  'clusters_formed',
  'judge_invocations',
  'merge_decisions',
  'keep_separate_decisions',
  'summary_records_committed',
  'records_deleted',
  'direct_committed_records',
  'duration_ms',
] as const;

const REQUIRED_PHASE_KEYS = [
  'extraction',
  'clustering',
  'neighbor_lookup',
  'judge',
  'commit',
] as const;

// ── Property test ───────────────────────────────────────────────────────

describe('Property 22: Ingestion-run log structural conformance', () => {
  it('emits exactly one JSON-Lines record per run that is a superset of required keys, with non-negative integer numerics and duration_ms ≥ Σ phase_latency_ms', async () => {
    const { createIngestionPipeline } = await import('../../src/collector/ingestion/index.js');
    const { createBufferStore } = await import('../../src/collector/buffer/store.js');
    const { createBufferWatcher } = await import('../../src/collector/buffer/watcher.js');
    const { createReconciliationCircuitBreaker } = await import(
      '../../src/collector/ingestion/circuit-breaker.js'
    );

    await fc.assert(
      fc.asyncProperty(scenarioArb(), async (scenario) => {
        // Reset per-iteration state.
        reconcileMock.mockReset();
        extractCandidatesMock.mockReset();
        stderrLines.length = 0;

        // Program the extraction + reconcile mocks.
        if (scenario.extractionFails && scenario.reconciliationEnabled) {
          extractCandidatesMock.mockRejectedValueOnce(new Error('extract boom'));
        } else {
          const candidates = Array.from({ length: scenario.numCandidates }, (_, i) =>
            makeCandidate(i),
          );
          extractCandidatesMock.mockResolvedValueOnce(candidates);
        }
        reconcileMock.mockResolvedValue(scenario.outcome);

        // Fresh infrastructure per iteration.
        const perIterDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'ingestion-obs-prop-iter-'),
        );
        const bufferStore = createBufferStore(perIterDir);
        const watcher = createBufferWatcher({
          idleMs: 999_999,
          maxConsecutiveFailures: 999,
        });
        const storage = makeMockStorage();
        const query = makeMockQuery();
        const circuitBreaker = createReconciliationCircuitBreaker();

        try {
          // Seed the buffer.
          const projectId = 'prop22-project';
          const namespace = '/actor/alice/project/prop22/';
          for (let i = 0; i < scenario.numEntries; i += 1) {
            await bufferStore.append(projectId, makeBufferEntry(i));
          }

          const pipeline = createIngestionPipeline({
            bufferStore,
            watcher,
            storage,
            embedder: null,
            query,
            circuitBreaker,
            config: {
              reconciliationEnabled: scenario.reconciliationEnabled,
              intraBatchSimilarityThreshold: 0.85,
              neighborSimilarityThreshold: 0.8,
              neighborPoolMaxSize: 10,
              judgeModelTimeoutMs: 30_000,
              extractionConcurrency: 2,
              extractionTimeoutMs: 60_000,
              extractionMaxRetries: 3,
              debug: false,
            },
          });

          await pipeline.run(projectId);

          const logs = parseIngestionRunLogs();

          // ── Conformance assertions ──────────────────────────

          // Exactly one log record — Property 22 core claim.
          expect(logs).toHaveLength(1);
          const log = logs[0]!;

          // Log is a superset of the required keys (ownKeys ⊇ required).
          const actualKeys = new Set(Object.keys(log));
          for (const key of REQUIRED_TOP_LEVEL_KEYS) {
            expect(actualKeys.has(key), `missing required key: ${key}`).toBe(true);
          }

          // Required string + boolean shapes.
          expect(log['event']).toBe('ingestion-pipeline-run');
          expect(typeof log['project_id']).toBe('string');
          expect(typeof log['namespace']).toBe('string');
          expect(typeof log['circuit_breaker_open']).toBe('boolean');
          expect(typeof log['reconciliation_enabled']).toBe('boolean');

          // Every required numeric field is a finite non-negative
          // integer-valued number. (JSON.stringify collapses integer-
          // valued floats to JSON integers; `Number.isFinite +
          // Number.isInteger` covers both the numeric-type check and
          // the non-NaN / non-Infinity check.)
          for (const key of REQUIRED_NON_NEG_INT_FIELDS) {
            const v = log[key];
            expect(typeof v, `${key} should be number`).toBe('number');
            const n = v as number;
            expect(Number.isFinite(n), `${key} should be finite`).toBe(true);
            expect(Number.isInteger(n), `${key} should be integer`).toBe(true);
            expect(n).toBeGreaterThanOrEqual(0);
          }

          // `phase_latency_ms` shape.
          const phase = log['phase_latency_ms'];
          expect(phase).not.toBeNull();
          expect(typeof phase).toBe('object');
          const phaseObj = phase as Record<string, unknown>;
          for (const k of REQUIRED_PHASE_KEYS) {
            const v = phaseObj[k];
            expect(typeof v, `phase_latency_ms.${k} should be number`).toBe('number');
            const n = v as number;
            expect(Number.isFinite(n), `phase_latency_ms.${k} should be finite`).toBe(true);
            expect(Number.isInteger(n), `phase_latency_ms.${k} should be integer`).toBe(true);
            expect(n).toBeGreaterThanOrEqual(0);
          }

          // `duration_ms >= Σ phase_latency_ms`.
          const phaseSum =
            (phaseObj['extraction'] as number) +
            (phaseObj['clustering'] as number) +
            (phaseObj['neighbor_lookup'] as number) +
            (phaseObj['judge'] as number) +
            (phaseObj['commit'] as number);
          expect(log['duration_ms'] as number).toBeGreaterThanOrEqual(phaseSum);

          // Consistency guardrail — `reconciliation_enabled`
          // reflects the config we passed in. This is cheap and
          // catches any accidental drift between the log payload
          // and the input config.
          expect(log['reconciliation_enabled']).toBe(scenario.reconciliationEnabled);

          // Unused intentionally — we use it to emit a useful
          // shrink-level message if an assertion fails; fc's
          // default failure messages already include the
          // scenario, so this is belt-and-braces.
          void namespace;
        } finally {
          watcher.close();
          fs.rmSync(perIterDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});
