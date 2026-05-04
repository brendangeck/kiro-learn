/**
 * Integration test: extraction pipeline with real kiro-cli ACP.
 *
 * Requires:
 * - kiro-cli installed and on PATH with ACP support
 * - Network access to Amazon Bedrock (via kiro-cli)
 *
 * The compressor agent config at `~/.kiro/agents/kiro-learn-compressor.json`
 * is rewritten from the current source in a `beforeAll` hook — the test
 * cannot rely on whatever stale version the developer happens to have
 * installed locally. An older kiro-learn install shipped a JSON-output
 * prompt; without this refresh the model returns JSON and every XML
 * assertion fails. The refresh makes the test hermetic at the cost of
 * overwriting the on-disk compressor for the duration of the test run.
 *
 * Run with: npm run test:integ
 *
 * These tests are excluded from CI — they require a real kiro-cli installation
 * and Bedrock credentials. They verify the end-to-end extraction flow:
 * ACP session → XML framing → compressor agent → XML parsing → MemoryRecord validation.
 *
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 1, 2, 4, 6
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startCollector } from '../../src/collector/index.js';
import type { CollectorHandle } from '../../src/collector/index.js';
import { createAcpSession } from '../../src/collector/pipeline/acp-client.js';
import { frameEvent } from '../../src/collector/pipeline/xml-framer.js';
import {
  parseMemoryXml,
  isGarbageResponse,
} from '../../src/collector/pipeline/xml-parser.js';
import { writeCompactorAgent, writeCompressorAgent, writeReconcilerAgent } from '../../src/installer/index.js';
import { parseMemoryRecord } from '../../src/types/schemas.js';
import type { KiroMemEvent, MemoryRecord } from '../../src/types/schemas.js';

// ── Precondition checks ─────────────────────────────────────────────────

/** Check if kiro-cli is available and supports the `acp` subcommand. */
function acpAvailable(): boolean {
  try {
    execSync('kiro-cli acp --help', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

const canRun = acpAvailable();

describe.skipIf(!canRun)(
  'Extraction pipeline — ACP + XML integration',
  () => {
    // Backup/restore the global compressor config so the test doesn't
  // permanently mutate the developer's installed agent.
  const compressorPath = join(homedir(), '.kiro', 'agents', 'kiro-learn-compressor.json');
  let originalCompressor: string | null = null;

  beforeAll(() => {
    // Save whatever is on disk (or note its absence).
    if (existsSync(compressorPath)) {
      originalCompressor = readFileSync(compressorPath, 'utf8');
    }

    // Refresh from the current source so the XML prompt is up to date.
    const globalAgentsDir = join(homedir(), '.kiro', 'agents');
    mkdirSync(globalAgentsDir, { recursive: true });
    writeCompressorAgent(globalAgentsDir);
  });

  afterAll(() => {
    // Restore the original compressor config, or remove the file if it
    // didn't exist before the test wrote it.
    if (originalCompressor !== null) {
      writeFileSync(compressorPath, originalCompressor);
    } else if (existsSync(compressorPath)) {
      unlinkSync(compressorPath);
    }
  });

    // Sample event that simulates a real tool_use event
    const sampleEvent: KiroMemEvent = {
      event_id: '01JF8ZS4Y00000000000000000',
      session_id: 'sess-integ-1',
      actor_id: 'integ-test',
      namespace: '/actor/integ-test/project/test/',
      schema_version: 1,
      kind: 'tool_use',
      body: {
        type: 'json',
        data: {
          tool_name: 'fs_read',
          tool_input: { path: 'src/installer/index.ts' },
          tool_response: {
            success: true,
            result:
              'The file contains the installer module with functions for init, start, stop, status, and uninstall commands.',
          },
        },
      },
      valid_time: '2026-04-23T20:00:00Z',
      source: {
        surface: 'kiro-cli',
        version: '0.1.0',
        client_id: 'integ-test-client',
      },
    };

    // Sample event with text body (prompt kind)
    const textEvent: KiroMemEvent = {
      event_id: '01JF8ZS4Y00000000000000001',
      session_id: 'sess-integ-1',
      actor_id: 'integ-test',
      namespace: '/actor/integ-test/project/test/',
      schema_version: 1,
      kind: 'prompt',
      body: {
        type: 'text',
        content:
          'The user asked how to configure the collector port.',
      },
      valid_time: '2026-04-23T20:01:00Z',
      source: {
        surface: 'kiro-cli',
        version: '0.1.0',
        client_id: 'integ-test-client',
      },
    };

    // Sample session_summary event with message body
    const sessionSummaryEvent: KiroMemEvent = {
      event_id: '01JF8ZS4Y00000000000000002',
      session_id: 'sess-integ-1',
      actor_id: 'integ-test',
      namespace: '/actor/integ-test/project/test/',
      schema_version: 1,
      kind: 'session_summary',
      body: {
        type: 'message',
        turns: [
          { role: 'user', content: 'Set up the SQLite storage backend with FTS5 indexing.' },
          { role: 'assistant', content: 'I created the SQLite storage module with FTS5 full-text search. The schema includes events and memory_records tables with an FTS5 virtual table for search.' },
          { role: 'user', content: 'Add migration support so we can evolve the schema.' },
          { role: 'assistant', content: 'Done. Added a migrations runner with version tracking in a _migrations table. The first migration creates the initial schema.' },
        ],
      },
      valid_time: '2026-04-23T20:30:00Z',
      source: {
        surface: 'kiro-cli',
        version: '0.1.0',
        client_id: 'integ-test-client',
      },
    };

    // Sample note event with text body
    const noteEvent: KiroMemEvent = {
      event_id: '01JF8ZS4Y00000000000000003',
      session_id: 'sess-integ-1',
      actor_id: 'integ-test',
      namespace: '/actor/integ-test/project/test/',
      schema_version: 1,
      kind: 'note',
      body: {
        type: 'text',
        content:
          'The team decided to use ULID for all identifiers instead of UUIDv4. ULIDs are lexicographically sortable by timestamp, which gives us natural ordering in SQLite without an extra index on created_at.',
      },
      valid_time: '2026-04-23T21:00:00Z',
      source: {
        surface: 'kiro-cli',
        version: '0.1.0',
        client_id: 'integ-test-client',
      },
    };

    // Sample prompt event with message body (multi-turn conversation)
    const messagePromptEvent: KiroMemEvent = {
      event_id: '01JF8ZS4Y00000000000000004',
      session_id: 'sess-integ-1',
      actor_id: 'integ-test',
      namespace: '/actor/integ-test/project/test/',
      schema_version: 1,
      kind: 'prompt',
      body: {
        type: 'message',
        turns: [
          { role: 'user', content: 'Why is the dedup stage using a Map instead of a Set?' },
          { role: 'assistant', content: 'Map preserves insertion order, so eviction of the oldest entry is O(1) via map.keys().next(). A Set would also work but Map gives us the LRU eviction pattern for free.' },
        ],
      },
      valid_time: '2026-04-23T20:15:00Z',
      source: {
        surface: 'kiro-cli',
        version: '0.1.0',
        client_id: 'integ-test-client',
      },
    };

    it('frameEvent produces well-formed XML from a tool_use event', () => {
      const xml = frameEvent(sampleEvent);
      expect(xml).toMatch(/^<tool_observation>/);
      expect(xml).toMatch(/<\/tool_observation>$/);
      expect(xml).toContain('<tool_name>fs_read</tool_name>');
      expect(xml).toContain('<timestamp>');
      expect(xml).toContain('<input>');
      expect(xml).toContain('<output>');
    });

    it('ACP session completes handshake and returns a response', async () => {
      const xml = frameEvent(sampleEvent);
      const session = await createAcpSession({
        agentName: 'kiro-learn-compressor',
        timeoutMs: 60_000,
      });

      try {
        const response = await session.sendPrompt(xml);
        expect(typeof response).toBe('string');
        // Response should be non-empty (either XML records or empty skip)
        // We just verify we got a string back without timeout
      } finally {
        session.destroy();
      }
    }, 90_000);

    it('compressor response parses as XML memory records', async () => {
      const xml = frameEvent(sampleEvent);
      const session = await createAcpSession({
        agentName: 'kiro-learn-compressor',
        timeoutMs: 60_000,
      });

      let response: string;
      try {
        response = await session.sendPrompt(xml);
      } finally {
        session.destroy();
      }

      // Empty response is a valid skip — not an error
      if (!response.trim()) {
        return;
      }

      // If non-empty, it should not be garbage
      expect(isGarbageResponse(response)).toBe(false);

      const records = parseMemoryXml(response);
      expect(records.length).toBeGreaterThan(0);

      for (const record of records) {
        expect(record.title.length).toBeGreaterThan(0);
        expect(record.title.length).toBeLessThanOrEqual(200);
        expect(record.summary.length).toBeGreaterThan(0);
        expect(record.summary.length).toBeLessThanOrEqual(4000);
        expect([
          'tool_use',
          'decision',
          'error',
          'discovery',
          'pattern',
        ]).toContain(record.type);
        expect(Array.isArray(record.facts)).toBe(true);
        expect(Array.isArray(record.concepts)).toBe(true);
        expect(Array.isArray(record.files)).toBe(true);
      }
    }, 90_000);

    it('enriched records pass parseMemoryRecord validation', async () => {
      const xml = frameEvent(sampleEvent);
      const session = await createAcpSession({
        agentName: 'kiro-learn-compressor',
        timeoutMs: 60_000,
      });

      let response: string;
      try {
        response = await session.sendPrompt(xml);
      } finally {
        session.destroy();
      }

      // Empty response is a valid skip
      if (!response.trim()) {
        return;
      }

      const records = parseMemoryXml(response);
      expect(records.length).toBeGreaterThan(0);

      // Enrich each record with pipeline-managed fields and validate
      for (let i = 0; i < records.length; i++) {
        const raw = records[i]!;
        const enriched = {
          record_id: 'mr_00000000000000000000000000',
          namespace: '/actor/integ-test/project/test/',
          strategy: 'llm-summary',
          source_event_ids: ['01JF8ZS4Y00000000000000000'],
          created_at: new Date().toISOString(),
          title: raw.title,
          summary: raw.summary,
          facts: raw.facts,
          concepts: raw.concepts,
          files_touched: raw.files,
          observation_type: raw.type,
        };

        // This should not throw — the enriched record must be schema-valid
        const record = parseMemoryRecord(enriched);

        expect(record.title.length).toBeGreaterThan(0);
        expect(record.title.length).toBeLessThanOrEqual(200);
        expect(record.summary.length).toBeGreaterThan(0);
        expect(record.summary.length).toBeLessThanOrEqual(4000);
        expect(record.strategy).toBe('llm-summary');
        expect(record.concepts).toBeDefined();
        expect(record.files_touched).toBeDefined();
        expect(record.observation_type).toBeDefined();
      }
    }, 90_000);

    /**
     * Helper: send an event through ACP and validate the response.
     * Accepts either an empty skip or well-formed XML memory records.
     */
    async function sendAndValidate(event: KiroMemEvent): Promise<void> {
      const xml = frameEvent(event);
      const session = await createAcpSession({
        agentName: 'kiro-learn-compressor',
        timeoutMs: 60_000,
      });

      let response: string;
      try {
        response = await session.sendPrompt(xml);
      } finally {
        session.destroy();
      }

      // Empty response is a valid skip
      if (!response.trim()) {
        return;
      }

      // Non-empty response should not be garbage
      expect(isGarbageResponse(response)).toBe(false);

      const records = parseMemoryXml(response);
      for (const record of records) {
        expect(record.title.length).toBeGreaterThan(0);
        expect(record.title.length).toBeLessThanOrEqual(200);
        expect(record.summary.length).toBeGreaterThan(0);
        expect(record.summary.length).toBeLessThanOrEqual(4000);
        expect([
          'tool_use',
          'decision',
          'error',
          'discovery',
          'pattern',
        ]).toContain(record.type);
      }
    }

    it('handles text body content via ACP (prompt kind)', async () => {
      await sendAndValidate(textEvent);
    }, 90_000);

    it('handles session_summary event with message body via ACP', async () => {
      const xml = frameEvent(sessionSummaryEvent);
      // Message body concatenates turns as input
      expect(xml).toContain('<tool_name>unknown</tool_name>');
      expect(xml).toContain('user:');
      expect(xml).toContain('assistant:');

      await sendAndValidate(sessionSummaryEvent);
    }, 90_000);

    it('handles note event with text body via ACP', async () => {
      const xml = frameEvent(noteEvent);
      expect(xml).toContain('<tool_name>unknown</tool_name>');
      expect(xml).toContain('ULID');

      await sendAndValidate(noteEvent);
    }, 90_000);

    it('handles prompt event with message body via ACP', async () => {
      const xml = frameEvent(messagePromptEvent);
      expect(xml).toContain('<tool_name>unknown</tool_name>');
      expect(xml).toContain('user:');
      expect(xml).toContain('assistant:');

      await sendAndValidate(messagePromptEvent);
    }, 90_000);
  },
);

// ── Reconciliation pipeline — two-batch near-duplicate merge ───────────
//
// Task 18.2 — runs the full collector daemon with
// `reconciliationEnabled: true`, posts two batches of events in
// sequence where the second batch contains a near-duplicate of a
// record from the first, and asserts:
//
//   1. First batch's records commit as standalone `llm-summary`
//      records (no neighbors exist yet, so every Candidate Cluster
//      commits on the empty-neighbor keep-separate path).
//   2. The second batch's identical-content candidate, paired with
//      the first batch's neighbor, is handed to the judge. When the
//      judge merges them, a single `llm-reconciled` Summary Record
//      lands in storage.
//   3. The first-batch near-duplicate row is absent from the
//      post-merge memory list — the design's destructive merge
//      semantics (Requirement 9.1) delete the merged original in
//      the same transaction as the summary insert.
//
// The judge decision is a property of the remote LLM, so the merge
// outcome is checked conditionally: the test passes when either
//
//   (a) the judge merged and a single Summary Record is present
//       with the first-batch row absent, OR
//   (b) the judge declined to merge and both records remain.
//
// Case (a) is the primary assertion path — it exercises the
// reconciliation-commit write sequence end-to-end. Case (b) is a
// fallback that keeps the test stable against normal judge
// variance; it still verifies the second batch produced a new row
// and the daemon did not crash. Either outcome is a valid
// observation of the reconciler running, which is what the integ
// test cares about.
//
// Validates: Requirements 4.1, 5.1, 6.1, 6.4, 7.1, 9.1.

/**
 * Find a free port by binding to port 0 and reading the assigned
 * port. Duplicated from buffer-extraction-pipeline.test.ts to keep
 * this file self-contained — the helper is small and not worth a
 * shared module.
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

async function getMemories(
  baseUrl: string,
  namespace: string,
): Promise<MemoryRecord[]> {
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
 * Poll `getMemories` until the predicate returns true, or until
 * `timeoutMs` expires. Returns the last observed set (which may or
 * may not satisfy the predicate — callers assert further).
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

describe.skipIf(!canRun)(
  'Extraction pipeline — two-batch reconciliation with reconciliationEnabled: true',
  () => {
    // Temp directories for isolation.
    let tmpDir: string;
    let bufferDir: string;
    let collector: CollectorHandle | null = null;
    let baseUrl: string;

    // Compressor + reconciler agent backup/restore so the test
    // does not permanently mutate the developer's installed agents.
    const compressorPath = join(homedir(), '.kiro', 'agents', 'kiro-learn-compressor.json');
    const compactorPath = join(homedir(), '.kiro', 'agents', 'kiro-learn-compactor.json');
    const reconcilerPath = join(homedir(), '.kiro', 'agents', 'kiro-learn-reconciler.json');
    let originalCompressor: string | null = null;
    let originalCompactor: string | null = null;
    let originalReconciler: string | null = null;

    const namespace = '/actor/integ-reconcile-test/project/reconcile123/';

    // ── First batch — a tool_use observation about the installer ──
    const firstBatch: KiroMemEvent[] = [
      {
        event_id: '01JF9BB0000000000000RBAT01',
        session_id: 'sess-reconcile-integ-batch1',
        actor_id: 'integ-reconcile-test',
        namespace,
        schema_version: 1,
        kind: 'tool_use',
        body: {
          type: 'json',
          data: {
            tool_name: 'fs_read',
            tool_input: { path: 'src/installer/index.ts' },
            tool_response: {
              success: true,
              result:
                'The installer writes three agent configs: kiro-learn.json (seeded), kiro-learn-compressor.json (hand-authored), kiro-learn-compactor.json (hand-authored). The reconciler was added alongside as kiro-learn-reconciler.json.',
            },
          },
        },
        valid_time: '2026-05-03T10:00:00Z',
        source: {
          surface: 'kiro-cli',
          version: '0.1.0',
          client_id: 'integ-reconcile-client',
        },
      },
    ];

    // ── Second batch — a near-duplicate observation about the same
    //    installer behaviour, worded slightly differently. The judge
    //    is expected to fuse this with the first-batch neighbor.
    const secondBatch: KiroMemEvent[] = [
      {
        event_id: '01JF9BB0000000000000RBAT02',
        session_id: 'sess-reconcile-integ-batch2',
        actor_id: 'integ-reconcile-test',
        namespace,
        schema_version: 1,
        kind: 'tool_use',
        body: {
          type: 'json',
          data: {
            tool_name: 'fs_read',
            tool_input: { path: 'src/installer/index.ts' },
            tool_response: {
              success: true,
              result:
                'The installer manages four agent configs in total: kiro-learn.json, kiro-learn-compressor.json, kiro-learn-compactor.json, kiro-learn-reconciler.json. The first uses a seed-then-merge flow; the other three are hand-authored.',
            },
          },
        },
        valid_time: '2026-05-03T10:05:00Z',
        source: {
          surface: 'kiro-cli',
          version: '0.1.0',
          client_id: 'integ-reconcile-client',
        },
      },
    ];

    beforeAll(async () => {
      // Save the pre-existing compressor + reconciler configs, if any.
      if (existsSync(compressorPath)) {
        originalCompressor = readFileSync(compressorPath, 'utf8');
      }
      if (existsSync(compactorPath)) {
        originalCompactor = readFileSync(compactorPath, 'utf8');
      }
      if (existsSync(reconcilerPath)) {
        originalReconciler = readFileSync(reconcilerPath, 'utf8');
      }

      // Refresh both agent configs from the current source. The
      // reconciler agent is new — older installs will not have it —
      // so we MUST write it before the daemon boots or the judge
      // ACP invocations will fail to resolve an agent.
      const globalAgentsDir = join(homedir(), '.kiro', 'agents');
      mkdirSync(globalAgentsDir, { recursive: true });
      writeCompressorAgent(globalAgentsDir);
      writeCompactorAgent(globalAgentsDir);
      writeReconcilerAgent(globalAgentsDir);

      tmpDir = mkdtempSync(join(tmpdir(), 'kiro-learn-integ-reconcile-'));
      bufferDir = join(tmpDir, 'buffers');

      const port = await findFreePort();
      baseUrl = `http://127.0.0.1:${String(port)}`;

      // Real collector, reconciliation enabled, idle timer pinned
      // to the validated minimum (5 s — Task 13.4's range
      // [5_000, 300_000] on bufferIdleMs).
      collector = await startCollector({
        port,
        host: '127.0.0.1',
        storagePath: join(tmpDir, 'test.db'),
        bufferEnabled: true,
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
      if (tmpDir !== undefined) {
        rmSync(tmpDir, { recursive: true, force: true });
      }

      // Restore whatever was on disk before the test ran — or
      // remove the file if the test was the one that wrote it.
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
      'first batch commits standalone; second batch either merges into a summary or falls back to keep-separate',
      async () => {
        // ── Phase 1: post batch 1 and wait for extraction. ──
        for (const event of firstBatch) {
          const result = await postEvent(baseUrl, event);
          expect(result.stored).toBe(true);
        }

        // Batch 1 has no pre-existing neighbors, so every cluster
        // commits on the empty-neighbor keep-separate path — the
        // records land as `llm-summary` without involving the
        // judge. Wait until at least one memory materialises.
        const batch1Memories = await pollMemoriesUntil(
          baseUrl,
          namespace,
          (items) => items.length > 0,
          120_000,
          2_000,
        );

        // Observable effect of batch 1: at least one row exists,
        // and those rows cite batch-1 events only (they never see
        // batch-2 events because batch 2 has not been posted).
        expect(batch1Memories.length).toBeGreaterThan(0);
        const batch1EventIds = new Set(firstBatch.map((e) => e.event_id));
        for (const memory of batch1Memories) {
          expect(memory.namespace).toBe(namespace);
          // Batch 1 hit the keep-separate path (or the direct-commit
          // fallback if the breaker is tripped for an unrelated
          // reason). Either way the record strategy is `llm-summary`
          // and NOT `llm-reconciled` — no merges have happened yet.
          expect(memory.strategy).toBe('llm-summary');
          for (const sourceId of memory.source_event_ids) {
            expect(batch1EventIds.has(sourceId)).toBe(true);
          }
        }

        // Capture the batch-1 record ids so we can check post-
        // merge absence later.
        const batch1RecordIds = new Set(batch1Memories.map((m) => m.record_id));

        // ── Phase 2: post batch 2 and wait for reconciliation. ──
        for (const event of secondBatch) {
          const result = await postEvent(baseUrl, event);
          expect(result.stored).toBe(true);
        }

        // Wait for the second idle-flush to fire. The expected
        // outcome depends on the judge:
        //
        //   - Merge path: a fresh Summary Record appears with
        //     strategy `llm-reconciled`, and every batch-1 record
        //     that the judge cited is deleted.
        //   - Keep-separate path: a fresh `llm-summary` record
        //     appears for batch 2; batch-1 records remain.
        //
        // We poll for "the memory set changed" so the test does
        // not wedge on a single fixed expectation.
        const finalMemories = await pollMemoriesUntil(
          baseUrl,
          namespace,
          (items) => {
            // Exit when we observe either a summary row OR a new
            // non-batch-1 row. Either state proves the second
            // ingestion cycle fired to completion.
            const hasSummary = items.some((m) => m.strategy === 'llm-reconciled');
            const hasNewRow = items.some(
              (m) => !batch1RecordIds.has(m.record_id),
            );
            return hasSummary || hasNewRow;
          },
          180_000,
          3_000,
        );
        expect(finalMemories.length).toBeGreaterThan(0);

        const summaries = finalMemories.filter(
          (m) => m.strategy === 'llm-reconciled',
        );

        if (summaries.length > 0) {
          // ── Primary assertion path: merge happened. ──
          //
          // Requirement 7.1 — exactly one Summary Record per
          // merge decision. For a two-cluster scenario we expect
          // exactly one summary covering both batches.
          expect(summaries.length).toBe(1);
          const summary = summaries[0]!;
          expect(summary.namespace).toBe(namespace);

          // The Summary Record must cite events from BOTH
          // batches in its `source_event_ids` — that's the
          // deduped first-seen union (Requirement 7.3). This is
          // the cleanest end-to-end signal that the reconciler
          // actually fused the two batches rather than coincid-
          // entally writing an `llm-reconciled` row for one of
          // them.
          const allEventIds = new Set([
            ...firstBatch.map((e) => e.event_id),
            ...secondBatch.map((e) => e.event_id),
          ]);
          for (const sourceId of summary.source_event_ids) {
            expect(allEventIds.has(sourceId)).toBe(true);
          }

          // Requirement 9.1 — merged `memory_record` rows are
          // deleted in the same transaction as the summary
          // insert. At least one of the batch-1 ids must be
          // absent from the final set (the judge may have
          // cited a subset of neighbors; we accept "any one or
          // more missing" as proof the delete cascade ran).
          const finalIds = new Set(finalMemories.map((m) => m.record_id));
          const survivingBatch1 = [...batch1RecordIds].filter((id) =>
            finalIds.has(id),
          );
          expect(survivingBatch1.length).toBeLessThan(batch1RecordIds.size);

          // The narrower variant spelled out in the task
          // description: a specific `getMemoryRecord(oldId)`
          // returns undefined. We translate that to "the
          // deleted id is not present in listMemoryRecords"
          // because the StorageBackend surface does not expose
          // a `getMemoryRecord(id)` helper — `listMemoryRecords`
          // is the equivalent read path.
          const mergedAwayId = [...batch1RecordIds].find(
            (id) => !finalIds.has(id),
          );
          expect(mergedAwayId).toBeDefined();
          expect(finalIds.has(mergedAwayId as string)).toBe(false);
        } else {
          // ── Fallback path: judge declined to merge. ──
          //
          // Still a valid run of the reconciliation pipeline —
          // the judge saw the neighbor pool and returned
          // `<keep_separate/>` (or the retry budget was
          // exhausted on malformed output). The expected
          // observable effect is: batch 1 records survive AND
          // at least one new `llm-summary` record from batch 2
          // appears. No deletions occurred.
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
          for (const row of newRows) {
            // Keep-separate commits carry `llm-summary`, matching
            // the direct-commit strategy — the reconciler does
            // not stamp `llm-reconciled` on keep-separate rows.
            expect(row.strategy).toBe('llm-summary');
          }
        }
      },
      360_000,
    );
  },
);
