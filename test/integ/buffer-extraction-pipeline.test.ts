/**
 * Integration test: buffer extraction pipeline with real kiro-cli ACP.
 *
 * Requires:
 * - kiro-cli installed and on PATH with ACP support
 * - Network access to Amazon Bedrock (via kiro-cli)
 *
 * Starts a real collector daemon with `bufferEnabled: true` and a short idle
 * timer (500 ms). Posts several events to `POST /v1/events`, waits for the
 * idle timer to fire batch extraction, then verifies that memory records
 * appear in SQLite storage with correct `namespace` and `source_event_ids`
 * referencing the posted events, and that the buffer file is cleared after
 * successful extraction.
 *
 * The compressor agent config at `~/.kiro/agents/kiro-learn-compressor.json`
 * is refreshed from the current source in a `beforeAll` hook — same pattern
 * as `test/integ/extraction-pipeline.test.ts`.
 *
 * Run with: npm run test:integ
 *
 * These tests are excluded from CI — they require a real kiro-cli installation
 * and Bedrock credentials.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 10, 12, 13, 16
 */

import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startCollector } from '../../src/collector/index.js';
import type { CollectorHandle } from '../../src/collector/index.js';
import { writeCompressorAgent } from '../../src/installer/index.js';
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

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Find a free port by briefly binding to port 0 and reading the assigned port.
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

/** POST a JSON body to the collector and return the parsed response. */
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

/** GET memories from the collector, optionally filtered by namespace. */
async function getMemories(
  baseUrl: string,
  namespace?: string,
): Promise<{ items: MemoryRecord[]; total: number }> {
  const params = new URLSearchParams();
  if (namespace !== undefined) {
    params.set('namespace', namespace);
  }
  params.set('limit', '100');
  const res = await fetch(`${baseUrl}/v1/memories?${params.toString()}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /v1/memories failed (${String(res.status)}): ${text}`);
  }
  return res.json() as Promise<{ items: MemoryRecord[]; total: number }>;
}

/**
 * Poll for memories until at least one appears or timeout is reached.
 * Returns the memories found, or an empty array on timeout.
 */
async function pollForMemories(
  baseUrl: string,
  namespace: string,
  timeoutMs: number,
  intervalMs: number = 2_000,
): Promise<MemoryRecord[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await getMemories(baseUrl, namespace);
    if (result.items.length > 0) {
      return result.items;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return [];
}

// ── Tests ───────────────────────────────────────────────────────────────

const canRun = acpAvailable();

describe.skipIf(!canRun)(
  'Buffer extraction pipeline — end-to-end with real ACP',
  () => {
    // Temp directories for isolation
    let tmpDir: string;
    let bufferDir: string;
    let collector: CollectorHandle | null = null;
    let baseUrl: string;

    // Compressor agent backup/restore
    const compressorPath = join(homedir(), '.kiro', 'agents', 'kiro-learn-compressor.json');
    let originalCompressor: string | null = null;

    // Namespace shared by all test events
    const namespace = '/actor/integ-buffer-test/project/buffertest123/';

    // Sample events to post — three events in the same project namespace
    const events: KiroMemEvent[] = [
      {
        event_id: '01JF9AA0000000000000000001',
        session_id: 'sess-buffer-integ-1',
        actor_id: 'integ-buffer-test',
        namespace,
        schema_version: 1,
        kind: 'tool_use',
        body: {
          type: 'json',
          data: {
            tool_name: 'fs_read',
            tool_input: { path: 'src/collector/buffer/store.ts' },
            tool_response: {
              success: true,
              result:
                'The file contains the BufferStore implementation with append, snapshot, size, bufferPath, listProjects, and clear methods for managing per-project NDJSON buffer files.',
            },
          },
        },
        valid_time: '2026-05-01T10:00:00Z',
        source: {
          surface: 'kiro-cli',
          version: '0.1.0',
          client_id: 'integ-buffer-client',
        },
      },
      {
        event_id: '01JF9AA0000000000000000002',
        session_id: 'sess-buffer-integ-1',
        actor_id: 'integ-buffer-test',
        namespace,
        schema_version: 1,
        kind: 'prompt',
        body: {
          type: 'text',
          content:
            'The user asked how the buffer watcher idle timer works and when extraction is triggered for accumulated events.',
        },
        valid_time: '2026-05-01T10:01:00Z',
        source: {
          surface: 'kiro-cli',
          version: '0.1.0',
          client_id: 'integ-buffer-client',
        },
      },
      {
        event_id: '01JF9AA0000000000000000003',
        session_id: 'sess-buffer-integ-1',
        actor_id: 'integ-buffer-test',
        namespace,
        schema_version: 1,
        kind: 'tool_use',
        body: {
          type: 'json',
          data: {
            tool_name: 'fs_write',
            tool_input: { path: 'src/collector/buffer/watcher.ts', content: '...' },
            tool_response: {
              success: true,
              result:
                'Wrote the BufferWatcher implementation with idle timer, size threshold, circuit breaker, and hard size ceiling logic.',
            },
          },
        },
        valid_time: '2026-05-01T10:02:00Z',
        source: {
          surface: 'kiro-cli',
          version: '0.1.0',
          client_id: 'integ-buffer-client',
        },
      },
    ];

    beforeAll(async () => {
      // Save whatever compressor config is on disk (or note its absence).
      if (existsSync(compressorPath)) {
        originalCompressor = readFileSync(compressorPath, 'utf8');
      }

      // Refresh compressor agent from the current source.
      const globalAgentsDir = join(homedir(), '.kiro', 'agents');
      mkdirSync(globalAgentsDir, { recursive: true });
      writeCompressorAgent(globalAgentsDir);

      // Create temp directory for DB and buffers.
      tmpDir = mkdtempSync(join(tmpdir(), 'kiro-learn-integ-buffer-'));
      bufferDir = join(tmpDir, 'buffers');

      // Find a free port to avoid conflicts.
      const port = await findFreePort();
      baseUrl = `http://127.0.0.1:${String(port)}`;

      // Start collector with buffer mode enabled and a short idle timer.
      // Idle timer is the validated minimum (5 s) introduced by the
      // reconciliation-engine spec; anything lower fails
      // `validateCollectorConfig` on startup. 5 s is still short
      // enough that the test completes in well under the 180 s
      // timeout below.
      collector = await startCollector({
        port,
        host: '127.0.0.1',
        storagePath: join(tmpDir, 'test.db'),
        bufferEnabled: true,
        bufferIdleMs: 5_000,
        bufferDir,
        bufferExtractionTimeoutMs: 90_000,
      });
    });

    afterAll(async () => {
      // Shut down collector.
      if (collector !== null) {
        await collector.close();
      }

      // Clean up temp directory.
      if (tmpDir !== undefined) {
        rmSync(tmpDir, { recursive: true, force: true });
      }

      // Restore the original compressor config, or remove if it didn't exist.
      if (originalCompressor !== null) {
        writeFileSync(compressorPath, originalCompressor);
      } else if (existsSync(compressorPath)) {
        rmSync(compressorPath);
      }
    });

    it('posts events, waits for buffer extraction, and verifies memories appear', async () => {
      // Post all events to the collector.
      for (const event of events) {
        const result = await postEvent(baseUrl, event);
        expect(result.stored).toBe(true);
        expect(result.event_id).toBe(event.event_id);
      }

      // Wait for the idle timer to fire extraction (500 ms idle + ACP time).
      // Poll for up to 120 seconds since ACP extraction can be slow.
      const memories = await pollForMemories(baseUrl, namespace, 120_000, 2_000);

      // Verify at least one memory record was created.
      expect(memories.length).toBeGreaterThan(0);

      // Verify namespace matches on all memories.
      for (const memory of memories) {
        expect(memory.namespace).toBe(namespace);
      }

      // Verify source_event_ids references the posted events.
      const postedEventIds = new Set(events.map((e) => e.event_id));
      for (const memory of memories) {
        expect(memory.source_event_ids.length).toBeGreaterThan(0);
        for (const sourceId of memory.source_event_ids) {
          expect(postedEventIds.has(sourceId)).toBe(true);
        }
      }

      // Verify memory record fields are well-formed.
      for (const memory of memories) {
        expect(memory.record_id).toMatch(/^mr_[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(memory.title.length).toBeGreaterThan(0);
        expect(memory.title.length).toBeLessThanOrEqual(200);
        expect(memory.summary.length).toBeGreaterThan(0);
        expect(memory.summary.length).toBeLessThanOrEqual(4000);
        expect(memory.strategy).toBe('llm-summary');
        expect([
          'tool_use',
          'decision',
          'error',
          'discovery',
          'pattern',
        ]).toContain(memory.observation_type);
      }

      // Verify the buffer file is cleared after successful extraction.
      const bufferFile = join(bufferDir, 'buffertest123', 'buffer.ndjson');
      // Give a small grace period for the clear to complete.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(existsSync(bufferFile)).toBe(false);
    }, 180_000);
  },
);

// ── Rollback-safety case: reconciliationEnabled: false ─────────────────
//
// Task 18.1 — when the reconciliation feature flag is off, the
// IngestionPipeline's direct-commit fallback must produce the same
// byte-for-byte write sequence as the pre-reconciliation
// ExtractionWorker did: every Candidate Memory becomes a standalone
// `memory_record` with `strategy === 'llm-summary'`, no Summary
// Records, no deletions, and the buffer is cleared after a successful
// run. Property 4 in the unit suite pins the write-sequence equality
// at the call level; this integ run pins the observable end-state:
// every record that lands in storage looks the same as before the
// feature existed.
//
// Validates: Requirements 1.6, 13.2.

describe.skipIf(!canRun)(
  'Buffer extraction pipeline — reconciliationEnabled: false rollback behaviour',
  () => {
    let tmpDir: string;
    let bufferDir: string;
    let collector: CollectorHandle | null = null;
    let baseUrl: string;

    // Isolated compressor-agent backup/restore so this block does not
    // interfere with the primary block's beforeAll if they run in
    // sequence within the same vitest process.
    const compressorPath = join(homedir(), '.kiro', 'agents', 'kiro-learn-compressor.json');
    let originalCompressor: string | null = null;

    // Distinct project id + namespace so there is no collision with
    // the first suite's buffer directory or DB rows.
    const namespace = '/actor/integ-buffer-test/project/bufferflagoff1/';

    const events: KiroMemEvent[] = [
      {
        event_id: '01JF9AA000000000000000F0F1',
        session_id: 'sess-buffer-integ-flagoff-1',
        actor_id: 'integ-buffer-test',
        namespace,
        schema_version: 1,
        kind: 'tool_use',
        body: {
          type: 'json',
          data: {
            tool_name: 'fs_read',
            tool_input: { path: 'src/collector/ingestion/index.ts' },
            tool_response: {
              success: true,
              result:
                'IngestionPipeline wires extractCandidates + reconcile; when the feature flag is off every candidate goes direct-commit without invoking the judge.',
            },
          },
        },
        valid_time: '2026-05-02T10:00:00Z',
        source: {
          surface: 'kiro-cli',
          version: '0.1.0',
          client_id: 'integ-buffer-flagoff-client',
        },
      },
      {
        event_id: '01JF9AA000000000000000F0F2',
        session_id: 'sess-buffer-integ-flagoff-1',
        actor_id: 'integ-buffer-test',
        namespace,
        schema_version: 1,
        kind: 'prompt',
        body: {
          type: 'text',
          content:
            'Confirm that with reconciliationEnabled: false the pipeline behaves byte-for-byte like the pre-reconciliation extraction worker — every candidate becomes its own memory_record.',
        },
        valid_time: '2026-05-02T10:01:00Z',
        source: {
          surface: 'kiro-cli',
          version: '0.1.0',
          client_id: 'integ-buffer-flagoff-client',
        },
      },
    ];

    beforeAll(async () => {
      if (existsSync(compressorPath)) {
        originalCompressor = readFileSync(compressorPath, 'utf8');
      }
      const globalAgentsDir = join(homedir(), '.kiro', 'agents');
      mkdirSync(globalAgentsDir, { recursive: true });
      writeCompressorAgent(globalAgentsDir);

      tmpDir = mkdtempSync(join(tmpdir(), 'kiro-learn-integ-buffer-flagoff-'));
      bufferDir = join(tmpDir, 'buffers');

      const port = await findFreePort();
      baseUrl = `http://127.0.0.1:${String(port)}`;

      // Explicit feature flag OFF. Everything else mirrors the
      // primary suite — same idle timer, same timeouts — so the
      // only variable being probed is the rollback path. The 5 s
      // idle is the validated minimum introduced by the
      // reconciliation-engine spec (Task 13.4) —
      // `validateCollectorConfig` rejects values below 5_000.
      collector = await startCollector({
        port,
        host: '127.0.0.1',
        storagePath: join(tmpDir, 'test.db'),
        bufferEnabled: true,
        bufferIdleMs: 5_000,
        bufferDir,
        bufferExtractionTimeoutMs: 90_000,
        reconciliationEnabled: false,
      });
    });

    afterAll(async () => {
      if (collector !== null) {
        await collector.close();
      }
      if (tmpDir !== undefined) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
      if (originalCompressor !== null) {
        writeFileSync(compressorPath, originalCompressor);
      } else if (existsSync(compressorPath)) {
        rmSync(compressorPath);
      }
    });

    it(
      'posts events with reconciliationEnabled: false and emits standalone memory_records (no summary, strategy llm-summary)',
      async () => {
        for (const event of events) {
          const result = await postEvent(baseUrl, event);
          expect(result.stored).toBe(true);
          expect(result.event_id).toBe(event.event_id);
        }

        // Wait for the idle timer → direct-commit fallback.
        const memories = await pollForMemories(baseUrl, namespace, 120_000, 2_000);
        expect(memories.length).toBeGreaterThan(0);

        // The old-behaviour invariants are all about what the
        // records look like:
        //
        // - `strategy === 'llm-summary'` — no Summary Records
        //   (those carry `'llm-reconciled'`).
        // - `namespace` matches the batch.
        // - `source_event_ids` cite only the posted events.
        // - Fields are schema-valid (ULID id, title/summary caps,
        //   known observation type).
        const postedEventIds = new Set(events.map((e) => e.event_id));
        for (const memory of memories) {
          expect(memory.namespace).toBe(namespace);

          expect(memory.strategy).toBe('llm-summary');

          expect(memory.source_event_ids.length).toBeGreaterThan(0);
          for (const sourceId of memory.source_event_ids) {
            expect(postedEventIds.has(sourceId)).toBe(true);
          }

          expect(memory.record_id).toMatch(/^mr_[0-9A-HJKMNP-TV-Z]{26}$/);
          expect(memory.title.length).toBeGreaterThan(0);
          expect(memory.title.length).toBeLessThanOrEqual(200);
          expect(memory.summary.length).toBeGreaterThan(0);
          expect(memory.summary.length).toBeLessThanOrEqual(4000);
          expect([
            'tool_use',
            'decision',
            'error',
            'discovery',
            'pattern',
          ]).toContain(memory.observation_type);
        }

        // No Summary Records leaked in under the flag-off path —
        // there is no LLM-reconciled strategy anywhere in the
        // returned set. This is the load-bearing rollback
        // assertion: the direct-commit fallback never produces a
        // merged-summary row.
        const reconciledCount = memories.filter(
          (m) => m.strategy === 'llm-reconciled',
        ).length;
        expect(reconciledCount).toBe(0);

        // Buffer cleared after the run, matching pre-reconciliation
        // extraction-worker semantics.
        const bufferFile = join(bufferDir, 'bufferflagoff1', 'buffer.ndjson');
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(existsSync(bufferFile)).toBe(false);
      },
      180_000,
    );
  },
);
