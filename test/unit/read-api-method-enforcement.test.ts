/**
 * Method enforcement tests for the read API routes.
 *
 * Verifies that non-GET requests to `/v1/stats` and `/v1/memories`
 * return 405 (or 404), and that `GET /v1/events` is not blocked by the
 * existing `POST /v1/events` handler.
 *
 * Uses a mock storage backend — no real SQLite needed since we're only
 * testing routing / method enforcement.
 *
 * @see Requirements 5.2
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startReceiver } from '../../src/collector/receiver/index.js';
import type { ReceiverHandle } from '../../src/collector/receiver/index.js';
import type { KiroMemEvent, EventIngestResponse, StorageBackend } from '../../src/types/index.js';
import type { Pipeline } from '../../src/collector/pipeline/index.js';
import type { RetrievalAssembler } from '../../src/collector/retrieval/index.js';

// ── Mock deps ───────────────────────────────────────────────────────────

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

const mockStorage: StorageBackend = {
  putEvent() { return Promise.resolve(); },
  getEventById() { return Promise.resolve(null); },
  putMemoryRecord() { return Promise.resolve(); },
  searchMemoryRecords() { return Promise.resolve([]); },
  close() { return Promise.resolve(); },
  getStats() {
    return Promise.resolve({
      total_events: 0, total_memories: 0, total_projects: 0,
      total_concepts: 0, observation_types: {}, event_kinds: {},
    });
  },
  listProjects() { return Promise.resolve([]); },
  listMemoryRecords() { return Promise.resolve({ items: [], total: 0 }); },
  listEvents() { return Promise.resolve({ items: [], total: 0 }); },
};

// ── Server lifecycle ────────────────────────────────────────────────────

let handle: ReceiverHandle;
let baseUrl: string;

beforeAll(async () => {
  handle = await startReceiver(
    {
      pipeline: mockPipeline,
      retrieval: mockRetrieval,
      storage: mockStorage,
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
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('Method enforcement on read API routes (Req 5.2)', () => {
  it('POST /v1/stats returns 405 with Allow: GET header', async () => {
    const res = await fetch(`${baseUrl}/v1/stats`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('DELETE /v1/memories returns 405 with Allow: GET, POST header', async () => {
    const res = await fetch(`${baseUrl}/v1/memories`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST');
  });

  it('DELETE /v1/stats returns 405 with Allow: GET header', async () => {
    const res = await fetch(`${baseUrl}/v1/stats`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('DELETE /v1/events returns 405 with Allow: GET, POST header', async () => {
    const ns = '/actor/alice/project/aaa111bbb222ccc333ddd444eee555ff/';
    const res = await fetch(`${baseUrl}/v1/events?namespace=${encodeURIComponent(ns)}`, { method: 'DELETE' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST');
  });

  it('GET /v1/events still works and is not blocked by POST /v1/events handler', async () => {
    const ns = '/actor/alice/project/aaa111bbb222ccc333ddd444eee555ff/';
    const res = await fetch(`${baseUrl}/v1/events?namespace=${encodeURIComponent(ns)}`);
    expect(res.status).toBe(200);

    const data = await res.json() as { items: unknown[]; total: number };
    expect(data.items).toEqual([]);
    expect(data.total).toBe(0);
  });
});
