/**
 * Example-based tests for the `GET /v1/stats` endpoint.
 *
 * Exercises the full stack: HTTP → receiver → storage (real SQLite).
 * Seeds a fresh SQLite database with events and memories, then verifies
 * the stats response shape, counts, breakdowns, project list, namespace
 * scoping, empty-DB behaviour, and invalid-namespace rejection.
 *
 * @see .kiro/specs/visualizer-read-api/requirements.md § Requirements 1.1–1.7, 4.1, 5.1
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-stats-test-'));
  const dbPath = join(tmpRoot, 'kiro-learn.db');
  storage = openSqliteStorage({ dbPath });

  handle = await startReceiver(
    {
      pipeline: mockPipeline,
      retrieval: mockRetrieval,
      storage,
      query: { search: () => Promise.resolve([]), invalidateNamespace: () => {} },
    },
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
  source: { surface: 'kiro-cli', version: '0.1.0', client_id: 'c1', project_path: '/home/testuser/projects/my-app' },
};

const EVENT_A2: KiroMemEvent = {
  event_id: '01JF8ZS4Y00000000000000002',
  session_id: 'sess-1',
  actor_id: 'alice',
  namespace: NS_A,
  schema_version: 1,
  kind: 'tool_use',
  body: { type: 'text', content: 'tool call in A' },
  valid_time: '2026-04-23T20:01:00Z',
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
  // Events
  await storage.putEvent(EVENT_A1);
  await storage.putEvent(EVENT_A2);
  await storage.putEvent(EVENT_B1);

  // Memory records
  await storage.putMemoryRecord({
    record_id: 'mr_01JF8ZS4Z00000000000000001',
    namespace: NS_A,
    strategy: 'llm-summary',
    title: 'Memory A1',
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
    title: 'Memory A2',
    summary: 'Second memory in namespace A.',
    facts: ['fact-a2'],
    source_event_ids: ['01JF8ZS4Y00000000000000002'],
    created_at: '2026-04-23T20:10:00Z',
    concepts: ['typescript', 'vitest'],
    files_touched: ['test/unit/foo.test.ts'],
    observation_type: 'discovery',
  });

  await storage.putMemoryRecord({
    record_id: 'mr_01JF8ZS4Z00000000000000003',
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

describe('GET /v1/stats', () => {
  // Seed once before all tests in this describe block.
  beforeAll(async () => {
    await seedData();
  });

  it('returns global stats with correct counts, observation_types, event_kinds, and projects (Req 1.1–1.5, 1.7)', async () => {
    const res = await fetch(`${baseUrl}/v1/stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const data = await res.json() as Record<string, unknown>;

    // Counts (Req 1.1)
    expect(data.total_events).toBe(3);
    expect(data.total_memories).toBe(3);
    expect(data.total_projects).toBe(2);
    // Distinct concepts: typescript, testing, vitest, python, flask = 5
    expect(data.total_concepts).toBe(5);

    // Observation types breakdown (Req 1.2)
    const obsTypes = data.observation_types as Record<string, number>;
    expect(obsTypes.tool_use).toBe(1);
    expect(obsTypes.discovery).toBe(1);
    expect(obsTypes.error).toBe(1);

    // Event kinds breakdown (Req 1.3)
    const eventKinds = data.event_kinds as Record<string, number>;
    expect(eventKinds.prompt).toBe(1);
    expect(eventKinds.tool_use).toBe(1);
    expect(eventKinds.session_summary).toBe(1);

    // Projects array (Req 1.4, 1.5)
    const projects = data.projects as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(2);

    // Projects ordered by event_count DESC — NS_A has 2 events, NS_B has 1
    const projA = projects[0]!;
    expect(projA.namespace).toBe(NS_A);
    expect(projA.event_count).toBe(2);
    expect(projA.memory_count).toBe(2);
    expect(projA.project_id).toBe('aaa111bbb222ccc333ddd444eee555ff');
    // display_name derived from project_path
    expect(typeof projA.display_name).toBe('string');
    expect((projA.display_name as string).length).toBeGreaterThan(0);

    const projB = projects[1]!;
    expect(projB.namespace).toBe(NS_B);
    expect(projB.event_count).toBe(1);
    expect(projB.memory_count).toBe(1);
    expect(projB.project_id).toBe('fff555eee444ddd333ccc222bbb111aa');
    // No project_path on EVENT_B1 → fallback to first 12 hex chars of project_id
    expect(projB.display_name).toBe('fff555eee444');
  });

  it('returns scoped stats when namespace query param is provided (Req 1.6)', async () => {
    const res = await fetch(`${baseUrl}/v1/stats?namespace=${encodeURIComponent(NS_A)}`);
    expect(res.status).toBe(200);

    const data = await res.json() as Record<string, unknown>;

    // Scoped counts — only NS_A data
    expect(data.total_events).toBe(2);
    expect(data.total_memories).toBe(2);
    // Scoped mode: exactly 1 project
    expect(data.total_projects).toBe(1);
    // Distinct concepts in NS_A: typescript, testing, vitest = 3
    expect(data.total_concepts).toBe(3);

    // Observation types scoped to NS_A
    const obsTypes = data.observation_types as Record<string, number>;
    expect(obsTypes.tool_use).toBe(1);
    expect(obsTypes.discovery).toBe(1);
    expect(obsTypes.error).toBeUndefined(); // error is only in NS_B

    // Event kinds scoped to NS_A
    const eventKinds = data.event_kinds as Record<string, number>;
    expect(eventKinds.prompt).toBe(1);
    expect(eventKinds.tool_use).toBe(1);
    expect(eventKinds.session_summary).toBeUndefined(); // only in NS_B

    // Projects array still contains ALL projects regardless of namespace filter (Req 1.6)
    const projects = data.projects as Array<Record<string, unknown>>;
    expect(projects).toHaveLength(2);
  });

  it('returns 400 for invalid namespace (Req 4.1)', async () => {
    const res = await fetch(`${baseUrl}/v1/stats?namespace=not-a-valid-namespace`);
    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toBe('invalid namespace');
  });
});

describe('GET /v1/stats — empty database', () => {
  let emptyTmpRoot: string;
  let emptyStorage: StorageBackend;
  let emptyHandle: ReceiverHandle;
  let emptyBaseUrl: string;

  beforeAll(async () => {
    emptyTmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-stats-empty-'));
    const dbPath = join(emptyTmpRoot, 'kiro-learn.db');
    emptyStorage = openSqliteStorage({ dbPath });

    emptyHandle = await startReceiver(
      {
        pipeline: mockPipeline,
        retrieval: mockRetrieval,
        storage: emptyStorage,
        query: { search: () => Promise.resolve([]), invalidateNamespace: () => {} },
      },
      { host: '127.0.0.1', port: 0, maxBodyBytes: 2 * 1024 * 1024, retrievalBudgetMs: 500 },
    );
    const addr = emptyHandle.server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('unexpected server address type');
    }
    emptyBaseUrl = `http://127.0.0.1:${String(addr.port)}`;
  });

  afterAll(async () => {
    await emptyHandle.close();
    await emptyStorage.close();
    rmSync(emptyTmpRoot, { recursive: true, force: true });
  });

  it('returns all counts as 0 and empty projects array (Req 1.1, 1.4, 5.1)', async () => {
    const res = await fetch(`${emptyBaseUrl}/v1/stats`);
    expect(res.status).toBe(200);

    const data = await res.json() as Record<string, unknown>;
    expect(data.total_events).toBe(0);
    expect(data.total_memories).toBe(0);
    expect(data.total_projects).toBe(0);
    expect(data.total_concepts).toBe(0);
    expect(data.observation_types).toEqual({});
    expect(data.event_kinds).toEqual({});

    const projects = data.projects as unknown[];
    expect(projects).toEqual([]);
  });
});
