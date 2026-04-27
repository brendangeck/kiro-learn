/**
 * Example-based tests for the `GET /v1/memories` endpoint.
 *
 * Exercises the full stack: HTTP → receiver → storage (real SQLite).
 * Seeds a fresh SQLite database with events and memories, then verifies
 * the memories response shape, ordering, missing/invalid namespace
 * rejection, and empty-namespace behaviour.
 *
 * @see .kiro/specs/visualizer-read-api/requirements.md § Requirements 2.1–2.7, 4.1, 5.1
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import { startReceiver } from '../../src/collector/receiver/index.js';
import type { ReceiverHandle } from '../../src/collector/receiver/index.js';
import type { StorageBackend, KiroMemEvent, EventIngestResponse } from '../../src/types/index.js';
import type { Pipeline } from '../../src/collector/pipeline/index.js';
import type { RetrievalAssembler } from '../../src/collector/retrieval/index.js';

// ── Mock pipeline & retrieval (not under test) ─────────────────────────

const mockPipeline: Pipeline = {
  process(event: KiroMemEvent): Promise<EventIngestResponse> {
    return Promise.resolve({ event_id: event.event_id, stored: true });
  },
  extraction: {
    enqueue() {},
    drain() {
      return Promise.resolve();
    },
    get active() {
      return 0;
    },
  },
};

const mockRetrieval: RetrievalAssembler = {
  assemble() {
    return Promise.resolve({ context: '', records: [], latency_ms: 0 });
  },
};

// ── Scratch DB + receiver lifecycle ────────────────────────────────────

let tmpRoot: string;
let storage: StorageBackend;
let handle: ReceiverHandle;
let baseUrl: string;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-memories-test-'));
  const dbPath = join(tmpRoot, 'kiro-learn.db');
  storage = openSqliteStorage({ dbPath });

  handle = await startReceiver(
    { pipeline: mockPipeline, retrieval: mockRetrieval, storage },
    { host: '127.0.0.1', port: 0, maxBodyBytes: 2 * 1024 * 1024, retrievalBudgetMs: 500 },
  );
  const addr = handle.server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('unexpected server address type');
  }
  baseUrl = `http://127.0.0.1:${String(addr.port)}`;
});

afterAll(async () => {
  await handle.close();
  await storage.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Test data ──────────────────────────────────────────────────────────

const NS_A = '/actor/alice/project/aaa111bbb222ccc333ddd444eee555ff/';
const NS_B = '/actor/bob/project/fff555eee444ddd333ccc222bbb111aa/';

const EVENT_A1: KiroMemEvent = {
  event_id: '01JF8ZS4Y00000000000000001',
  session_id: 'sess-1',
  actor_id: 'alice',
  namespace: NS_A,
  schema_version: 1,
  kind: 'prompt',
  body: { type: 'text', content: 'hello from A' },
  valid_time: '2026-04-23T20:00:00Z',
  source: { surface: 'kiro-cli', version: '0.1.0', client_id: 'c1' },
};

const EVENT_B1: KiroMemEvent = {
  event_id: '01JF8ZS4Y00000000000000003',
  session_id: 'sess-2',
  actor_id: 'bob',
  namespace: NS_B,
  schema_version: 1,
  kind: 'session_summary',
  body: { type: 'text', content: 'summary from B' },
  valid_time: '2026-04-23T21:00:00Z',
  source: { surface: 'kiro-ide', version: '0.2.0', client_id: 'c2' },
};

// ── Helpers ────────────────────────────────────────────────────────────

async function seedData(): Promise<void> {
  // Events (needed so namespaces exist in the DB)
  await storage.putEvent(EVENT_A1);
  await storage.putEvent(EVENT_B1);

  // Memory records — NS_A gets three, NS_B gets one.
  // Deliberately use different created_at values to test ordering.
  await storage.putMemoryRecord({
    record_id: 'mr_01JF8ZS4Z00000000000000001',
    namespace: NS_A,
    strategy: 'llm-summary',
    title: 'Memory A1 (oldest)',
    summary: 'First memory in namespace A.',
    facts: ['fact-a1'],
    source_event_ids: ['01JF8ZS4Y00000000000000001'],
    created_at: '2026-04-23T20:05:00Z',
    concepts: ['typescript', 'testing'],
    files_touched: ['src/index.ts'],
    observation_type: 'tool_use',
  });

  await storage.putMemoryRecord({
    record_id: 'mr_01JF8ZS4Z00000000000000002',
    namespace: NS_A,
    strategy: 'llm-summary',
    title: 'Memory A2 (middle)',
    summary: 'Second memory in namespace A.',
    facts: ['fact-a2'],
    source_event_ids: ['01JF8ZS4Y00000000000000001'],
    created_at: '2026-04-23T20:10:00Z',
    concepts: ['typescript', 'vitest'],
    files_touched: ['test/unit/foo.test.ts'],
    observation_type: 'discovery',
  });

  await storage.putMemoryRecord({
    record_id: 'mr_01JF8ZS4Z00000000000000003',
    namespace: NS_A,
    strategy: 'llm-summary',
    title: 'Memory A3 (newest)',
    summary: 'Third memory in namespace A.',
    facts: ['fact-a3'],
    source_event_ids: ['01JF8ZS4Y00000000000000001'],
    created_at: '2026-04-23T20:15:00Z',
    concepts: ['node', 'http'],
    files_touched: ['src/server.ts'],
    observation_type: 'pattern',
  });

  await storage.putMemoryRecord({
    record_id: 'mr_01JF8ZS4Z00000000000000004',
    namespace: NS_B,
    strategy: 'llm-summary',
    title: 'Memory B1',
    summary: 'First memory in namespace B.',
    facts: ['fact-b1'],
    source_event_ids: ['01JF8ZS4Y00000000000000003'],
    created_at: '2026-04-23T21:05:00Z',
    concepts: ['python', 'flask'],
    files_touched: ['app.py'],
    observation_type: 'error',
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('GET /v1/memories', () => {
  beforeAll(async () => {
    await seedData();
  });

  it('returns memories for a namespace with correct items and total (Req 2.1, 2.3, 2.5, 2.6)', async () => {
    const res = await fetch(`${baseUrl}/v1/memories?namespace=${encodeURIComponent(NS_A)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const data = (await res.json()) as { items: Array<Record<string, unknown>>; total: number };

    // NS_A has 3 memories
    expect(data.total).toBe(3);
    expect(data.items).toHaveLength(3);

    // Verify each item has the expected MemoryRecord fields (Req 2.3)
    for (const item of data.items) {
      expect(item.record_id).toBeDefined();
      expect(item.namespace).toBe(NS_A);
      expect(item.strategy).toBeDefined();
      expect(item.title).toBeDefined();
      expect(item.summary).toBeDefined();
      expect(item.facts).toBeDefined();
      expect(item.source_event_ids).toBeDefined();
      expect(item.created_at).toBeDefined();
      expect(item.concepts).toBeDefined();
      expect(item.files_touched).toBeDefined();
      expect(item.observation_type).toBeDefined();
    }

    // Verify namespace isolation — no NS_B items leak in (Req 7.1)
    for (const item of data.items) {
      expect(item.namespace).toBe(NS_A);
    }
  });

  it('returns all memories when namespace is omitted (Req 1.1 — visualizer-dashboard)', async () => {
    const res = await fetch(`${baseUrl}/v1/memories`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { items: unknown[]; total: number; limit: number; offset: number };
    // NS_A has 3 memories, NS_B has 1 → total 4
    expect(data.total).toBe(4);
    expect(data.items).toHaveLength(4);
    expect(data.limit).toBe(100);
    expect(data.offset).toBe(0);
  });

  it('returns 400 with error message for invalid namespace (Req 4.1)', async () => {
    const res = await fetch(`${baseUrl}/v1/memories?namespace=not-a-valid-namespace`);
    expect(res.status).toBe(400);

    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('invalid namespace');
  });

  it('returns empty items and total=0 for a valid namespace with no memories (Req 5.1)', async () => {
    const emptyNs = '/actor/nobody/project/00000000000000000000000000000000/';
    const res = await fetch(`${baseUrl}/v1/memories?namespace=${encodeURIComponent(emptyNs)}`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { items: unknown[]; total: number };
    expect(data.items).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('pagination: limit and offset return correct slice and total (Req 1.2, 1.4)', async () => {
    // Request 2 items starting at offset 1
    const res = await fetch(`${baseUrl}/v1/memories?limit=2&offset=1`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { items: unknown[]; total: number; limit: number; offset: number };
    // Total is still 4 (all memories across both namespaces)
    expect(data.total).toBe(4);
    expect(data.items).toHaveLength(2);
    expect(data.limit).toBe(2);
    expect(data.offset).toBe(1);
  });

  it('offset beyond total returns empty items array but correct total (Req 1.4)', async () => {
    const res = await fetch(`${baseUrl}/v1/memories?offset=100`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { items: unknown[]; total: number; limit: number; offset: number };
    expect(data.items).toEqual([]);
    expect(data.total).toBe(4);
    expect(data.limit).toBe(100);
    expect(data.offset).toBe(100);
  });

  it('returns memories ordered by created_at descending — newest first (Req 2.4)', async () => {
    const res = await fetch(`${baseUrl}/v1/memories?namespace=${encodeURIComponent(NS_A)}`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { items: Array<{ created_at: string; title: string }> };
    expect(data.items).toHaveLength(3);

    // Newest first: A3 (20:15) → A2 (20:10) → A1 (20:05)
    expect(data.items[0]!.title).toBe('Memory A3 (newest)');
    expect(data.items[1]!.title).toBe('Memory A2 (middle)');
    expect(data.items[2]!.title).toBe('Memory A1 (oldest)');

    // Also verify created_at values are in descending order
    const timestamps = data.items.map((item) => new Date(item.created_at).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]!).toBeGreaterThanOrEqual(timestamps[i]!);
    }
  });
});
