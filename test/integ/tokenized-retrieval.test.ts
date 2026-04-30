/**
 * Integration test: tokenized FTS5 retrieval through the full HTTP layer.
 *
 * Exercises the complete retrieval flow:
 *   POST /v1/events?retrieve=true → receiver → retrieval assembler →
 *   query layer → storage → FTS5 → response with context.
 *
 * Does NOT require kiro-cli or Bedrock credentials — it only exercises the
 * collector's HTTP layer and SQLite storage, both of which are local.
 *
 * Run with: npm run test:integ
 *
 * @see .kiro/specs/fts5-query-tokenization/requirements.md § Requirements 13.1, 13.2, 13.3
 */

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startCollector } from '../../src/collector/index.js';
import type { CollectorHandle } from '../../src/collector/index.js';
import type { KiroMemEvent, MemoryRecord } from '../../src/types/schemas.js';

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

/** POST a memory record to the collector. */
async function postMemory(
  baseUrl: string,
  record: MemoryRecord,
): Promise<{ record_id: string; stored: boolean }> {
  const res = await fetch(`${baseUrl}/v1/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /v1/memories failed (${String(res.status)}): ${text}`);
  }
  return res.json() as Promise<{ record_id: string; stored: boolean }>;
}

/** POST a prompt event with retrieve=true and return the parsed response. */
async function postPromptWithRetrieval(
  baseUrl: string,
  event: KiroMemEvent,
): Promise<{
  event_id: string;
  stored: boolean;
  retrieval?: { context: string; records: string[]; latency_ms: number };
}> {
  const res = await fetch(`${baseUrl}/v1/events?retrieve=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /v1/events?retrieve=true failed (${String(res.status)}): ${text}`);
  }
  return res.json() as Promise<{
    event_id: string;
    stored: boolean;
    retrieval?: { context: string; records: string[]; latency_ms: number };
  }>;
}

// ── Test data ────────────────────────────────────────────────────────────

const namespace = '/actor/integ-retrieval-test/project/tokenizedretrieval/';

/** Memory records with distinctive tokens that won't appear in normal text. */
const seedRecords: MemoryRecord[] = [
  {
    record_id: 'mr_01JF9BB0000000000000000001',
    namespace,
    strategy: 'llm-summary',
    title: 'Discovered syzygy alignment algorithm',
    summary: 'The syzygy alignment algorithm uses celestial body positions to compute optimal scheduling windows for batch processing.',
    facts: ['syzygy alignment reduces scheduling conflicts by 40%'],
    source_event_ids: ['01JF9BB0000000000000000010'],
    created_at: '2026-06-01T10:00:00Z',
    concepts: ['syzygy', 'scheduling', 'alignment'],
    files_touched: ['src/scheduler/syzygy.ts'],
    observation_type: 'discovery',
  },
  {
    record_id: 'mr_01JF9BB0000000000000000002',
    namespace,
    strategy: 'llm-summary',
    title: 'Quasar emission pattern for log analysis',
    summary: 'The quasar emission pattern detects anomalous log bursts by comparing frequency distributions against a baseline.',
    facts: ['quasar pattern detects anomalies within 200ms'],
    source_event_ids: ['01JF9BB0000000000000000020'],
    created_at: '2026-06-01T11:00:00Z',
    concepts: ['quasar', 'log-analysis', 'anomaly-detection'],
    files_touched: ['src/monitoring/quasar.ts'],
    observation_type: 'pattern',
  },
  {
    record_id: 'mr_01JF9BB0000000000000000003',
    namespace,
    strategy: 'llm-summary',
    title: 'Zephyr caching strategy for edge nodes',
    summary: 'The zephyr caching strategy pre-warms edge node caches using predictive access patterns derived from historical request logs.',
    facts: ['zephyr caching improves p99 latency by 60%'],
    source_event_ids: ['01JF9BB0000000000000000030'],
    created_at: '2026-06-01T12:00:00Z',
    concepts: ['zephyr', 'caching', 'edge-computing'],
    files_touched: ['src/cache/zephyr.ts'],
    observation_type: 'decision',
  },
];

/** Counter for generating unique event IDs. */
let eventCounter = 0;

/** A prompt event that contains one of the seeded tokens. */
function makePromptEvent(content: string): KiroMemEvent {
  eventCounter += 1;
  // Generate a unique ULID-like event_id for each call (26 chars, Crockford base32).
  // 01JF9CC0000000000000000000 is 26 chars; replace last few with counter.
  const base = '01JF9CC000000000000000000';  // 25 chars
  const id = base + String(eventCounter);     // 26 chars for single-digit counter
  return {
    event_id: id,
    session_id: 'sess-retrieval-integ-1',
    actor_id: 'integ-retrieval-test',
    namespace,
    schema_version: 1,
    kind: 'prompt',
    body: {
      type: 'text',
      content,
    },
    valid_time: '2026-06-01T13:00:00Z',
    source: {
      surface: 'kiro-cli',
      version: '0.1.0',
      client_id: 'integ-retrieval-client',
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Tokenized retrieval — full HTTP path', () => {
  let tmpDir: string;
  let collector: CollectorHandle | null = null;
  let baseUrl: string;

  beforeAll(async () => {
    // Create temp directory for the SQLite DB.
    tmpDir = mkdtempSync(join(tmpdir(), 'kiro-learn-integ-retrieval-'));

    // Find a free port to avoid conflicts.
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${String(port)}`;

    // Start collector with buffer mode disabled (we don't need extraction).
    collector = await startCollector({
      port,
      host: '127.0.0.1',
      storagePath: join(tmpDir, 'test.db'),
      bufferEnabled: false,
    });

    // Seed memory records via POST /v1/memories.
    for (const record of seedRecords) {
      const result = await postMemory(baseUrl, record);
      expect(result.stored).toBe(true);
    }
  });

  afterAll(async () => {
    // Shut down collector cleanly.
    if (collector !== null) {
      await collector.close();
    }

    // Clean up temp directory.
    if (tmpDir !== undefined) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('retrieves matching context when prompt contains a seeded token', async () => {
    // POST a prompt event containing "syzygy" — should match the first seeded record.
    const response = await postPromptWithRetrieval(
      baseUrl,
      makePromptEvent('tell me about syzygy'),
    );

    expect(response.stored).toBe(true);
    expect(response.retrieval).toBeDefined();
    expect(response.retrieval!.context).toBeTruthy();
    expect(response.retrieval!.context).toContain('## Prior observations from kiro-learn');
    expect(response.retrieval!.context).toContain('Discovered syzygy alignment algorithm');
  });

  it('returns empty retrieval when prompt contains no seeded tokens', async () => {
    // POST a prompt event with tokens that don't appear in any seeded record.
    const response = await postPromptWithRetrieval(
      baseUrl,
      makePromptEvent('completely unrelated xylophone'),
    );

    expect(response.stored).toBe(true);

    // Either no retrieval field, or retrieval with empty context.
    if (response.retrieval !== undefined) {
      expect(response.retrieval.context).toBe('');
    }
  });
});
