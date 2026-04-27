/**
 * Example-based tests for the `GET /v1/events` endpoint.
 *
 * Exercises the full stack: HTTP → receiver → storage (real SQLite).
 * Seeds a fresh SQLite database with events, then verifies the events
 * response shape, ordering, missing/invalid namespace rejection, limit
 * clamping, non-integer limit rejection, and total-vs-items semantics.
 *
 * @see .kiro/specs/visualizer-read-api/requirements.md § Requirements 3.1–3.8, 4.2, 5.1
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-events-test-'));
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

/**
 * Helper to build a KiroMemEvent with a given index for unique ids and
 * staggered valid_time values. Index 1 is the oldest, higher = newer.
 */
function makeEvent(index: number): KiroMemEvent {
  const padded = String(index).padStart(3, '0');
  const minute = String(index).padStart(2, '0');
  return {
    event_id: `01JF8ZS4Y000000000000000${padded}`,
    session_id: 'sess-1',
    actor_id: 'alice',
    namespace: NS_A,
    schema_version: 1,
    kind: 'prompt',
    body: { type: 'text', content: `event ${padded}` },
    valid_time: `2026-04-23T20:${minute}:00Z`,
    source: { surface: 'kiro-cli', version: '0.1.0', client_id: 'c1' },
  };
}

// Build 5 events with staggered valid_time values for ordering tests.
// Event 1 = oldest (20:01), Event 5 = newest (20:05).
const EVENTS: KiroMemEvent[] = [
  makeEvent(1),
  makeEvent(2),
  makeEvent(3),
  makeEvent(4),
  makeEvent(5),
];

// ── Helpers ────────────────────────────────────────────────────────────

async function seedData(): Promise<void> {
  for (const event of EVENTS) {
    await storage.putEvent(event);
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('GET /v1/events', () => {
  beforeAll(async () => {
    await seedData();
  });

  it('returns events for a namespace with correct items and total (Req 3.1, 3.4, 3.6, 3.7)', async () => {
    const res = await fetch(`${baseUrl}/v1/events?namespace=${encodeURIComponent(NS_A)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const data = (await res.json()) as { items: Array<Record<string, unknown>>; total: number };

    // Default limit is 50, we have 5 events — all should be returned
    expect(data.total).toBe(5);
    expect(data.items).toHaveLength(5);

    // Verify each item has the expected KiroMemEvent fields (Req 3.4)
    for (const item of data.items) {
      expect(item.event_id).toBeDefined();
      expect(item.session_id).toBeDefined();
      expect(item.actor_id).toBeDefined();
      expect(item.namespace).toBe(NS_A);
      expect(item.schema_version).toBeDefined();
      expect(item.kind).toBeDefined();
      expect(item.body).toBeDefined();
      expect(item.valid_time).toBeDefined();
      expect(item.source).toBeDefined();
    }
  });

  it('returns all events when namespace is omitted (Req 2.1 — visualizer-dashboard)', async () => {
    const res = await fetch(`${baseUrl}/v1/events`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { items: unknown[]; total: number };
    // All 5 events should be returned (default limit 50)
    expect(data.total).toBe(5);
    expect(data.items).toHaveLength(5);
  });

  it('returns 400 with error message for invalid namespace (Req 4.1)', async () => {
    const res = await fetch(`${baseUrl}/v1/events?namespace=not-a-valid-namespace`);
    expect(res.status).toBe(400);

    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('invalid namespace');
  });

  it('clamps limit=0 to 1 and limit=999 to 200 (Req 3.3)', async () => {
    // limit=0 → clamped to 1
    const resLow = await fetch(
      `${baseUrl}/v1/events?namespace=${encodeURIComponent(NS_A)}&limit=0`,
    );
    expect(resLow.status).toBe(200);
    const dataLow = (await resLow.json()) as { items: unknown[]; total: number };
    expect(dataLow.items).toHaveLength(1);
    expect(dataLow.total).toBe(5); // total is still the full count

    // limit=999 → clamped to 200 (we only have 5 events, so items.length = 5)
    const resHigh = await fetch(
      `${baseUrl}/v1/events?namespace=${encodeURIComponent(NS_A)}&limit=999`,
    );
    expect(resHigh.status).toBe(200);
    const dataHigh = (await resHigh.json()) as { items: unknown[]; total: number };
    expect(dataHigh.items).toHaveLength(5); // only 5 events exist
    expect(dataHigh.total).toBe(5);
  });

  it('returns 400 for non-integer limit (Req 4.2)', async () => {
    const res = await fetch(
      `${baseUrl}/v1/events?namespace=${encodeURIComponent(NS_A)}&limit=abc`,
    );
    expect(res.status).toBe(400);

    const data = (await res.json()) as { error: string };
    expect(data.error).toBe('limit must be an integer');

    // Also test a float
    const resFloat = await fetch(
      `${baseUrl}/v1/events?namespace=${encodeURIComponent(NS_A)}&limit=2.5`,
    );
    expect(resFloat.status).toBe(400);

    const dataFloat = (await resFloat.json()) as { error: string };
    expect(dataFloat.error).toBe('limit must be an integer');
  });

  it('returns events ordered by valid_time descending — newest first (Req 3.5)', async () => {
    const res = await fetch(`${baseUrl}/v1/events?namespace=${encodeURIComponent(NS_A)}`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as { items: Array<{ valid_time: string; event_id: string }> };
    expect(data.items).toHaveLength(5);

    // Newest first: event 5 (20:05) → event 4 (20:04) → ... → event 1 (20:01)
    const timestamps = data.items.map((item) => new Date(item.valid_time).getTime());
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i - 1]!).toBeGreaterThanOrEqual(timestamps[i]!);
    }

    // Verify the first item is the newest event
    expect(data.items[0]!.event_id).toBe(EVENTS[4]!.event_id);
    // Verify the last item is the oldest event
    expect(data.items[4]!.event_id).toBe(EVENTS[0]!.event_id);
  });

  it('total reflects full count, not just the returned slice (Req 3.6)', async () => {
    // Request only 2 events, but total should still be 5
    const res = await fetch(
      `${baseUrl}/v1/events?namespace=${encodeURIComponent(NS_A)}&limit=2`,
    );
    expect(res.status).toBe(200);

    const data = (await res.json()) as { items: unknown[]; total: number };
    expect(data.items).toHaveLength(2);
    expect(data.total).toBe(5);
  });
});
