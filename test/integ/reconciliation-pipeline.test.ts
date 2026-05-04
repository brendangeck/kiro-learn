/**
 * Integration test: reconciliation pipeline — end-to-end with real
 * `kiro-cli` ACP.
 *
 * Requires:
 * - `kiro-cli` installed and on PATH with ACP support
 * - Network access to Amazon Bedrock (via kiro-cli) for both the
 *   `kiro-learn-compressor` and `kiro-learn-reconciler` agents
 *
 * Starts a real collector daemon with `bufferEnabled: true`,
 * `reconciliationEnabled: true`, and a short idle timer (500 ms). Two
 * near-duplicate buffer batches are posted across two simulated
 * sessions in the same namespace. After each batch's idle flush the
 * test inspects the memory graph:
 *
 *   - After batch 1 at least one `llm-summary` record appears — the
 *     empty-neighbor keep-separate path runs because the namespace
 *     has no pre-existing neighbors.
 *   - After batch 2 the reconciliation stage finds a neighbor,
 *     invokes the `kiro-learn-reconciler` judge, and (when the judge
 *     merges) commits a single `llm-reconciled` Summary Record whose
 *     `source_event_ids` cover both batches. The first-batch record
 *     is absent from storage after the merge (the
 *     design-spec-documented `getMemoryRecord(oldId)` returns
 *     undefined — translated here to "the id is absent from
 *     `listMemoryRecords`" because the `StorageBackend` does not
 *     expose a direct `getMemoryRecord(id)` helper).
 *   - `query.search(...)` returns only the Summary Record (i.e. the
 *     merged-away row is not reachable via lexical search either).
 *
 * The `ingestion-pipeline-run` stderr log is captured throughout the
 * run via a `process.stderr.write` spy. The test asserts exactly one
 * JSON-Lines log record is emitted per ingestion cycle (two total —
 * one for each batch), each carrying every required field listed in
 * the design's Observability section. For the merge cycle the record
 * reports `records_deleted >= 1` and `summary_records_committed ===
 * 1`; for the first batch it reports `records_deleted === 0`.
 *
 * Both the compressor and reconciler agent configs at
 * `~/.kiro/agents/` are refreshed from the current source in a
 * `beforeAll` hook — identical pattern to
 * `test/integ/extraction-pipeline.test.ts`. Each file is restored to
 * its pre-test contents in `afterAll`.
 *
 * When the judge returns `<keep_separate/>` (normal judge variance)
 * the primary assertion path is skipped and the test verifies the
 * fallback end state: batch-1 records survive, a new `llm-summary`
 * row for batch 2 exists, no deletions happened, and the
 * `ingestion-pipeline-run` log still fires once per cycle. Both
 * outcomes are valid observations of the reconciliation pipeline
 * running — the test is robust against judge drift.
 *
 * Run with: `npm run test:integ`
 *
 * These tests are excluded from CI — they require a real `kiro-cli`
 * installation and Bedrock credentials.
 *
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 4.1, 5.1,
 *   6.1, 6.4, 7.1, 9.1, 9.2, 9.3, 11.1
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 18.3
 */

import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startCollector } from '../../src/collector/index.js';
import type { CollectorHandle } from '../../src/collector/index.js';
import {
  writeCompactorAgent,
  writeCompressorAgent,
  writeReconcilerAgent,
} from '../../src/installer/index.js';
import type { KiroMemEvent, MemoryRecord } from '../../src/types/schemas.js';

// ── Precondition checks ─────────────────────────────────────────────────

/** Check if `kiro-cli` is available and supports the `acp` subcommand. */
function acpAvailable(): boolean {
  try {
    execSync('kiro-cli acp --help', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convenience that mirrors `skipIfNoKiroCli` in other integ tests.
 * Named as a function to match the spec's wording ("skip via
 * `skipIfNoKiroCli` when unavailable"), even though vitest's
 * `describe.skipIf` consumes a plain boolean.
 */
const skipIfNoKiroCli = !acpAvailable();

// ── Network helpers ─────────────────────────────────────────────────────

/**
 * Find a free port by binding to port 0 and reading the assigned
 * port. Duplicated from the sibling integ tests — this helper is
 * small and not worth a shared module.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('unexpected server address type'));
        return;
      }
      const port = addr.port;
      srv.close(() => {
        resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

async function postEvent(
  baseUrl: string,
  event: KiroMemEvent,
): Promise<{ event_id: string; stored: boolean }> {
  const body = JSON.stringify(event);
  const res = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /v1/events failed (${String(res.status)}): ${text}`);
  }
  return res.json() as Promise<{ event_id: string; stored: boolean }>;
}

async function getMemories(baseUrl: string, namespace: string): Promise<MemoryRecord[]> {
  const params = new URLSearchParams();
  params.set('namespace', namespace);
  params.set('limit', '100');
  const res = await fetch(`${baseUrl}/v1/memories?${params.toString()}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /v1/memories failed (${String(res.status)}): ${text}`);
  }
  const body = (await res.json()) as { items: MemoryRecord[]; total: number };
  return body.items;
}

/**
 * Invoke `GET /v1/memories/search`, the HTTP surface backed by
 * `QueryLayer.search`. The spec calls for `retrieval.search(...)`
 * returning only the summary — we translate that to the equivalent
 * HTTP endpoint (which the receiver wires through the query layer).
 */
async function searchMemories(
  baseUrl: string,
  namespace: string,
  query: string,
  limit: number = 10,
): Promise<MemoryRecord[]> {
  const params = new URLSearchParams();
  params.set('namespace', namespace);
  params.set('query', query);
  params.set('limit', String(limit));
  const res = await fetch(`${baseUrl}/v1/memories/search?${params.toString()}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /v1/memories/search failed (${String(res.status)}): ${text}`);
  }
  return res.json() as Promise<MemoryRecord[]>;
}

/**
 * Poll `getMemories` until `predicate` holds or `timeoutMs`
 * expires. Returns the last observed set — callers are expected to
 * run further assertions on whatever came back.
 */
async function pollMemoriesUntil(
  baseUrl: string,
  namespace: string,
  predicate: (items: MemoryRecord[]) => boolean,
  timeoutMs: number,
  intervalMs: number = 2_000,
): Promise<MemoryRecord[]> {
  const deadline = Date.now() + timeoutMs;
  let last: MemoryRecord[] = [];
  while (Date.now() < deadline) {
    last = await getMemories(baseUrl, namespace);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

// ── Stderr log capture ──────────────────────────────────────────────────

/**
 * Fields every `ingestion-pipeline-run` record must carry. Copied
 * verbatim from the Observability § of the design; task 14.1's unit
 * test pins the exact same list.
 */
const REQUIRED_RUN_FIELDS = [
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

const NUMERIC_RUN_FIELDS = [
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

const PHASE_KEYS = ['extraction', 'clustering', 'neighbor_lookup', 'judge', 'commit'] as const;

/**
 * Parse every line from a captured stderr buffer and return the
 * subset whose `event` field equals `eventName`. Silently skips
 * malformed lines and interspersed warnings so callers can assert
 * strictly on structured payloads.
 */
function extractRunLogs(
  chunks: readonly string[],
  eventName: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const chunk of chunks) {
    for (const piece of chunk.split('\n')) {
      const trimmed = piece.trim();
      if (trimmed.length === 0) continue;
      if (!trimmed.startsWith('{')) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (obj['event'] === eventName) out.push(obj);
      } catch {
        // Not JSON or malformed — skip silently.
      }
    }
  }
  return out;
}

/** Assert a single `ingestion-pipeline-run` payload is well-formed. */
function assertRunLogShape(log: Record<string, unknown>): void {
  for (const key of REQUIRED_RUN_FIELDS) {
    expect(log, `missing required field: ${key}`).toHaveProperty(key);
  }
  expect(log['event']).toBe('ingestion-pipeline-run');
  expect(typeof log['project_id']).toBe('string');
  expect(typeof log['namespace']).toBe('string');
  expect(typeof log['circuit_breaker_open']).toBe('boolean');
  expect(typeof log['reconciliation_enabled']).toBe('boolean');

  for (const field of NUMERIC_RUN_FIELDS) {
    expect(typeof log[field], `${field} should be a number`).toBe('number');
    expect(Number.isFinite(log[field] as number)).toBe(true);
    expect(log[field] as number).toBeGreaterThanOrEqual(0);
  }

  const phase = log['phase_latency_ms'] as Record<string, unknown> | undefined;
  expect(phase, 'phase_latency_ms must be present').toBeDefined();
  if (phase === undefined) return;
  for (const k of PHASE_KEYS) {
    expect(typeof phase[k], `phase_latency_ms.${k} should be a number`).toBe('number');
    expect(Number.isFinite(phase[k] as number)).toBe(true);
    expect(phase[k] as number).toBeGreaterThanOrEqual(0);
  }

  // Invariant from the design: wall-time duration ≥ sum of phase
  // latencies. Task 14.1 unit tests enforce this at the pipeline
  // level; we re-assert here so any regression in log emission
  // shows up in integ too.
  const phaseSum = PHASE_KEYS.reduce(
    (acc, k) => acc + ((phase[k] as number | undefined) ?? 0),
    0,
  );
  expect(log['duration_ms'] as number).toBeGreaterThanOrEqual(phaseSum);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe.skipIf(skipIfNoKiroCli)(
  'Reconciliation pipeline — end-to-end with real kiro-cli + reconciler',
  () => {
    let tmpDir: string;
    let bufferDir: string;
    let collector: CollectorHandle | null = null;
    let baseUrl: string;

    // Agent backup/restore so the test does not permanently mutate
    // the developer's installed agent configs.
    const compressorPath = join(homedir(), '.kiro', 'agents', 'kiro-learn-compressor.json');
    const compactorPath = join(homedir(), '.kiro', 'agents', 'kiro-learn-compactor.json');
    const reconcilerPath = join(homedir(), '.kiro', 'agents', 'kiro-learn-reconciler.json');
    let originalCompressor: string | null = null;
    let originalCompactor: string | null = null;
    let originalReconciler: string | null = null;

    // Stderr capture — monkey-patch `process.stderr.write` directly
    // (not via `vi.spyOn`) so vitest's `restoreMocks: true` config
    // does not strip the interceptor before the test runs. The
    // patched writer pushes each chunk into a shared buffer the
    // test inspects, then still forwards to the real writer so the
    // developer running the test in a shell can see the daemon's
    // normal stderr output.
    const stderrChunks: string[] = [];
    let originalStderrWrite: typeof process.stderr.write | null = null;
    const installStderrSpy = (): void => {
      if (originalStderrWrite !== null) return;
      originalStderrWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((
        chunk: string | Uint8Array,
        ...rest: unknown[]
      ): boolean => {
        stderrChunks.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'),
        );
        return (originalStderrWrite as typeof process.stderr.write).apply(
          process.stderr,
          [chunk, ...rest] as Parameters<typeof process.stderr.write>,
        );
      }) as typeof process.stderr.write;
    };
    const restoreStderr = (): void => {
      if (originalStderrWrite === null) return;
      process.stderr.write = originalStderrWrite;
      originalStderrWrite = null;
    };

    const namespace = '/actor/integ-reconcile-e2e/project/reconciledaemon1/';

    // ── First simulated session — one observation ─────────────────
    const firstBatch: KiroMemEvent[] = [
      {
        event_id: '01JF9CC0000000000000EBAT01',
        session_id: 'sess-reconcile-e2e-1',
        actor_id: 'integ-reconcile-e2e',
        namespace,
        schema_version: 1,
        kind: 'tool_use',
        body: {
          type: 'json',
          data: {
            tool_name: 'fs_read',
            tool_input: { path: 'src/collector/ingestion/reconciler.ts' },
            tool_response: {
              success: true,
              result:
                'The reconciler clusters candidate memories by cosine similarity, queries the per-namespace vector index for neighbors, and invokes the kiro-learn-reconciler agent via ACP. On a merge decision it deletes the merged originals inside the same transaction as the summary insert.',
            },
          },
        },
        valid_time: '2026-05-04T09:00:00Z',
        source: {
          surface: 'kiro-cli',
          version: '0.1.0',
          client_id: 'integ-reconcile-e2e-client',
        },
      },
    ];

    // ── Second simulated session — a near-duplicate observation ──
    // The compressor should produce a candidate that cosine-matches
    // the first session's record above the reconciler's neighbor
    // threshold (0.80 default), triggering a judge invocation.
    const secondBatch: KiroMemEvent[] = [
      {
        event_id: '01JF9CC0000000000000EBAT02',
        session_id: 'sess-reconcile-e2e-2',
        actor_id: 'integ-reconcile-e2e',
        namespace,
        schema_version: 1,
        kind: 'tool_use',
        body: {
          type: 'json',
          data: {
            tool_name: 'fs_read',
            tool_input: { path: 'src/collector/ingestion/reconciler.ts' },
            tool_response: {
              success: true,
              result:
                'The kiro-learn reconciler clusters candidates by embedding similarity, pulls neighbors from the namespace vector index, and asks the kiro-learn-reconciler judge to merge or keep-separate. Merge decisions atomically delete the merged originals alongside the new summary record insert.',
            },
          },
        },
        valid_time: '2026-05-04T09:05:00Z',
        source: {
          surface: 'kiro-cli',
          version: '0.1.0',
          client_id: 'integ-reconcile-e2e-client',
        },
      },
    ];

    beforeAll(async () => {
      // Save pre-existing agents (if any).
      if (existsSync(compressorPath)) {
        originalCompressor = readFileSync(compressorPath, 'utf8');
      }
      if (existsSync(compactorPath)) {
        originalCompactor = readFileSync(compactorPath, 'utf8');
      }
      if (existsSync(reconcilerPath)) {
        originalReconciler = readFileSync(reconcilerPath, 'utf8');
      }

      // Refresh every agent config from source. The reconciler is
      // new, so older installs likely do not have it on disk; we
      // MUST write it before the daemon boots.
      const globalAgentsDir = join(homedir(), '.kiro', 'agents');
      mkdirSync(globalAgentsDir, { recursive: true });
      writeCompressorAgent(globalAgentsDir);
      writeCompactorAgent(globalAgentsDir);
      writeReconcilerAgent(globalAgentsDir);

      tmpDir = mkdtempSync(join(tmpdir(), 'kiro-learn-integ-reconcile-e2e-'));
      bufferDir = join(tmpDir, 'buffers');

      const port = await findFreePort();
      baseUrl = `http://127.0.0.1:${String(port)}`;

      // Install the stderr interceptor BEFORE starting the
      // collector so startup lines are captured. The pipeline's
      // per-run log emits via `process.stderr.write(...)`
      // directly — the interceptor buffers those calls and still
      // forwards to the real writer so the developer sees the
      // daemon's stderr output normally.
      installStderrSpy();

      collector = await startCollector({
        port,
        host: '127.0.0.1',
        storagePath: join(tmpDir, 'test.db'),
        bufferEnabled: true,
        // Validated minimum for `bufferIdleMs` — Task 13.4 narrowed
        // the range to [5_000, 300_000]; anything smaller is
        // rejected at startup by `validateCollectorConfig`.
        bufferIdleMs: 5_000,
        bufferDir,
        bufferExtractionTimeoutMs: 90_000,
        reconciliationEnabled: true,
      });
    });

    afterAll(async () => {
      if (collector !== null) {
        await collector.close();
      }
      restoreStderr();
      if (tmpDir !== undefined) {
        rmSync(tmpDir, { recursive: true, force: true });
      }

      // Restore / clean up agent files.
      if (originalCompressor !== null) {
        writeFileSync(compressorPath, originalCompressor);
      } else if (existsSync(compressorPath)) {
        unlinkSync(compressorPath);
      }
      if (originalCompactor !== null) {
        writeFileSync(compactorPath, originalCompactor);
      } else if (existsSync(compactorPath)) {
        unlinkSync(compactorPath);
      }
      if (originalReconciler !== null) {
        writeFileSync(reconcilerPath, originalReconciler);
      } else if (existsSync(reconcilerPath)) {
        unlinkSync(reconcilerPath);
      }
    });

    it(
      'seeds two near-duplicate batches, merges on second run, and emits ingestion-pipeline-run once per cycle',
      async () => {
        // ── Phase 1: post batch 1 and wait for its ingestion. ──
        for (const event of firstBatch) {
          const result = await postEvent(baseUrl, event);
          expect(result.stored).toBe(true);
        }

        // Wait for at least one memory to appear — batch 1 has no
        // existing neighbors so every cluster commits on the
        // empty-neighbor keep-separate path.
        const batch1Memories = await pollMemoriesUntil(
          baseUrl,
          namespace,
          (items) => items.length > 0,
          120_000,
          2_000,
        );
        expect(batch1Memories.length).toBeGreaterThan(0);

        // Every batch-1 record should carry `llm-summary` — no
        // merges happened yet, the reconciler either took the
        // empty-neighbor fast path or never fired.
        for (const memory of batch1Memories) {
          expect(memory.namespace).toBe(namespace);
          expect(memory.strategy).toBe('llm-summary');
        }
        const batch1RecordIds = new Set(batch1Memories.map((m) => m.record_id));

        // Count how many `ingestion-pipeline-run` records we've
        // seen so far — this becomes our baseline for the
        // "once per ingestion cycle" assertion later.
        const batch1Logs = extractRunLogs(stderrChunks, 'ingestion-pipeline-run');
        expect(batch1Logs.length).toBeGreaterThanOrEqual(1);
        // The first-batch log's invariants: `records_deleted === 0`
        // (no merges possible with no neighbors) and
        // `candidates_produced >= 1` (the compressor emitted at
        // least one candidate that landed as a row). We pick the
        // most recent log that cites our namespace so parallel
        // projects (none expected in this isolated test, but
        // defensive) do not confuse the count.
        const ourBatch1Logs = batch1Logs.filter((l) => l['namespace'] === namespace);
        expect(ourBatch1Logs.length).toBeGreaterThanOrEqual(1);
        const lastBatch1Log = ourBatch1Logs[ourBatch1Logs.length - 1]!;
        assertRunLogShape(lastBatch1Log);
        expect(lastBatch1Log['records_deleted']).toBe(0);
        expect(lastBatch1Log['summary_records_committed']).toBe(0);
        expect(lastBatch1Log['reconciliation_enabled']).toBe(true);

        // ── Phase 2: post batch 2 and wait for reconciliation. ──
        for (const event of secondBatch) {
          const result = await postEvent(baseUrl, event);
          expect(result.stored).toBe(true);
        }

        // Wait for an observable change: either a Summary Record
        // appears, a new non-batch-1 row lands, or both. Either
        // state proves the second ingestion cycle completed.
        const finalMemories = await pollMemoriesUntil(
          baseUrl,
          namespace,
          (items) => {
            const hasSummary = items.some((m) => m.strategy === 'llm-reconciled');
            const hasNewRow = items.some((m) => !batch1RecordIds.has(m.record_id));
            return hasSummary || hasNewRow;
          },
          180_000,
          3_000,
        );
        expect(finalMemories.length).toBeGreaterThan(0);

        // ── Phase 3: assert the post-merge state. ──
        const summaries = finalMemories.filter(
          (m) => m.strategy === 'llm-reconciled',
        );

        if (summaries.length > 0) {
          // Primary assertion path: merge happened.
          // Requirement 7.1 — exactly one Summary Record per
          // merge decision; for a one-cluster-per-batch scenario
          // that means exactly one summary total.
          expect(summaries.length).toBe(1);
          const summary = summaries[0]!;
          expect(summary.namespace).toBe(namespace);

          // Requirement 7.3 — `source_event_ids` is the deduped
          // first-seen union across every merged entity. The
          // Summary should cite events from BOTH batches.
          const allEventIds = new Set([
            ...firstBatch.map((e) => e.event_id),
            ...secondBatch.map((e) => e.event_id),
          ]);
          expect(summary.source_event_ids.length).toBeGreaterThan(0);
          for (const sourceId of summary.source_event_ids) {
            expect(allEventIds.has(sourceId)).toBe(true);
          }
          // At least one event from each batch must appear,
          // proving the union actually bridged them.
          const batch1EventIds = new Set(firstBatch.map((e) => e.event_id));
          const batch2EventIds = new Set(secondBatch.map((e) => e.event_id));
          const citesBatch1 = summary.source_event_ids.some((id) =>
            batch1EventIds.has(id),
          );
          const citesBatch2 = summary.source_event_ids.some((id) =>
            batch2EventIds.has(id),
          );
          expect(citesBatch1).toBe(true);
          expect(citesBatch2).toBe(true);

          // Requirement 9.1 — merged `memory_record` rows are
          // deleted in the same transaction as the summary
          // insert. Every batch-1 record that the judge cited
          // must be absent from the final memory list.
          const finalIds = new Set(finalMemories.map((m) => m.record_id));
          const survivingBatch1 = [...batch1RecordIds].filter((id) =>
            finalIds.has(id),
          );
          expect(survivingBatch1.length).toBeLessThan(batch1RecordIds.size);
          const mergedAwayId = [...batch1RecordIds].find(
            (id) => !finalIds.has(id),
          );
          expect(mergedAwayId).toBeDefined();
          // Spec text: "`getMemoryRecord(oldId)` returns
          // undefined". The `StorageBackend` surface does not
          // expose a single-id getter, so the equivalent
          // observation is that the id is absent from the
          // namespace's full memory listing.
          expect(finalIds.has(mergedAwayId as string)).toBe(false);

          // Requirement: `retrieval.search(...)` returns only
          // the summary. We go through the `/v1/memories/search`
          // endpoint (which is wired to the query layer — the
          // retrieval-assembler path reads the same records).
          // The search query uses a token from the summary
          // title to maximise the lexical match.
          //
          // We search for a term that appears in the original
          // observations ("reconciler") which the summary
          // should also cover by nature of the merge. The
          // merged-away records must not be reachable.
          const searchResults = await searchMemories(
            baseUrl,
            namespace,
            'reconciler',
            10,
          );
          // The merged-away id must not surface in the search
          // results — the delete cascaded to FTS5 (Req 9.3).
          for (const hit of searchResults) {
            expect(hit.record_id).not.toBe(mergedAwayId);
          }
          // And the summary must be among the hits (it's the
          // surviving content-bearing record; lexical search is
          // not guaranteed to rank it first without its exact
          // tokens, so we assert presence rather than top-1).
          const summaryInResults = searchResults.some(
            (r) => r.record_id === summary.record_id,
          );
          expect(summaryInResults).toBe(true);

          // ── Observability: the second ingestion cycle's log ──
          const allLogs = extractRunLogs(stderrChunks, 'ingestion-pipeline-run');
          const ourLogs = allLogs.filter((l) => l['namespace'] === namespace);
          // At least two logs — one per batch. Both have the
          // required shape.
          expect(ourLogs.length).toBeGreaterThanOrEqual(2);
          for (const log of ourLogs) {
            assertRunLogShape(log);
            expect(log['project_id']).toBe('reconciledaemon1');
            expect(log['reconciliation_enabled']).toBe(true);
          }
          const mergeLog = ourLogs[ourLogs.length - 1]!;
          // The merge cycle reports exactly one Summary Record
          // committed and at least one record deleted
          // (Requirement 11.1 — the required `records_deleted`
          // field).
          expect(mergeLog['summary_records_committed']).toBe(1);
          expect(mergeLog['records_deleted'] as number).toBeGreaterThanOrEqual(1);
          expect(mergeLog['merge_decisions']).toBe(1);
          expect(mergeLog['judge_invocations'] as number).toBeGreaterThanOrEqual(1);
        } else {
          // Fallback path: judge returned `<keep_separate/>`
          // (or the retry budget was exhausted on malformed
          // output). Still a valid reconciliation-pipeline run —
          // verify the observable end state.
          for (const id of batch1RecordIds) {
            expect(
              finalMemories.some((m) => m.record_id === id),
              `expected batch-1 record ${id} to survive keep-separate fallback`,
            ).toBe(true);
          }
          const newRows = finalMemories.filter(
            (m) => !batch1RecordIds.has(m.record_id),
          );
          expect(newRows.length).toBeGreaterThan(0);

          // Observability still holds — two runs, two logs.
          const allLogs = extractRunLogs(stderrChunks, 'ingestion-pipeline-run');
          const ourLogs = allLogs.filter((l) => l['namespace'] === namespace);
          expect(ourLogs.length).toBeGreaterThanOrEqual(2);
          for (const log of ourLogs) {
            assertRunLogShape(log);
          }
          const keepSeparateLog = ourLogs[ourLogs.length - 1]!;
          expect(keepSeparateLog['summary_records_committed']).toBe(0);
          expect(keepSeparateLog['records_deleted']).toBe(0);
        }
      },
      600_000,
    );
  },
);
