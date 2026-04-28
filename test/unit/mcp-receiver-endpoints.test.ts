/**
 * Example-based tests for the `POST /v1/memories` and `GET /v1/memories/search`
 * collector endpoints.
 *
 * Exercises the full stack: HTTP → receiver → storage (real SQLite).
 * Seeds a fresh SQLite database with memory records, then verifies
 * happy paths, validation failures, body size limits, search behaviour,
 * and method enforcement.
 *
 * @see .kiro/specs/mcp-memory-server/requirements.md § Requirements 8.1–8.5
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

// ── Valid memory record for happy-path tests ───────────────────────────

const VALID_RECORD = {
  record_id: 'mr_01JF8ZS4Z00000000000000099',
  namespace: '/actor/alice/project/aaa111bbb222ccc333ddd444eee555ff/',
  strategy: 'mcp_observation',
  title: 'Test observation',
  summary: 'A test observation for endpoint testing',
  facts: ['fact one'],
  source_event_ids: ['01JF8ZS4Y00000000000000099'],
  created_at: '2026-04-23T20:00:00.000Z',
  concepts: ['testing'],
  files_touched: ['src/test.ts'],
  observation_type: 'discovery',
};

// ── Scratch DB + receiver lifecycle ────────────────────────────────────

let tmpRoot: string;
let storage: StorageBackend;
let handle: ReceiverHandle;
let baseUrl: string;

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-mcp-endpoints-test-'));
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

// ── Tests ──────────────────────────────────────────────────────────────

describe('POST /v1/memories', () => {
  it('stores a valid memory record and returns { record_id, stored: true } (Req 8.1)', async () => {
    const res = await fetch(`${baseUrl}/v1/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_RECORD),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const data = await res.json() as { record_id: string; stored: boolean };
    expect(data.record_id).toBe(VALID_RECORD.record_id);
    expect(data.stored).toBe(true);
  });

  it('returns 400 with validation details for an invalid body (Req 8.2)', async () => {
    const invalidBody = {
      // Missing required fields: record_id, namespace, strategy, etc.
      title: 'Incomplete record',
    };

    const res = await fetch(`${baseUrl}/v1/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidBody),
    });

    expect(res.status).toBe(400);

    const data = await res.json() as { error: string; details: unknown[] };
    expect(data.error).toBe('validation failed');
    expect(Array.isArray(data.details)).toBe(true);
    expect(data.details.length).toBeGreaterThan(0);
  });

  it('rejects an oversized body (> 2 MiB) (Req 8.5)', async () => {
    // Build a body that exceeds the 2 MiB limit
    const oversizedSummary = 'x'.repeat(3 * 1024 * 1024);
    const oversizedRecord = { ...VALID_RECORD, summary: oversizedSummary };

    // The server destroys the socket after reading > maxBodyBytes, which may
    // cause fetch() to throw EPIPE/ECONNRESET before the 413 response arrives.
    // Either outcome (413 status OR a network error) confirms enforcement.
    try {
      const res = await fetch(`${baseUrl}/v1/memories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(oversizedRecord),
      });
      expect(res.status).toBe(413);
    } catch (err: unknown) {
      // EPIPE or ECONNRESET — the server rejected the oversized body
      expect(err).toBeInstanceOf(TypeError);
    }
  });
});

describe('GET /v1/memories/search', () => {
  const NS = '/actor/alice/project/aaa111bbb222ccc333ddd444eee555ff/';

  beforeAll(async () => {
    // Seed a record for search tests (use a different record_id to avoid PK collision)
    await storage.putMemoryRecord({
      record_id: 'mr_01JF8ZS4Z00000000000000088',
      namespace: NS,
      strategy: 'mcp_observation',
      title: 'Authentication flow uses JWT tokens',
      summary: 'The authentication flow in the project relies on JWT tokens for session management.',
      facts: ['JWT tokens expire after 1 hour'],
      source_event_ids: ['01JF8ZS4Y00000000000000088'],
      created_at: '2026-04-23T20:05:00.000Z',
      concepts: ['authentication', 'JWT'],
      files_touched: ['src/auth/index.ts'],
      observation_type: 'discovery',
    });
  });

  it('returns matching results for a valid search query (Req 8.3)', async () => {
    const query = 'authentication';
    const res = await fetch(
      `${baseUrl}/v1/memories/search?namespace=${encodeURIComponent(NS)}&query=${encodeURIComponent(query)}&limit=10`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const data = await res.json() as Array<{ record_id: string; title: string }>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]!.record_id).toBe('mr_01JF8ZS4Z00000000000000088');
    expect(data[0]!.title).toBe('Authentication flow uses JWT tokens');
  });

  it('returns 400 when query parameter is missing (Req 8.4)', async () => {
    const res = await fetch(
      `${baseUrl}/v1/memories/search?namespace=${encodeURIComponent(NS)}`,
    );

    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toBe('query parameter is required');
  });

  it('returns 400 for an invalid namespace format (Req 8.3)', async () => {
    const res = await fetch(
      `${baseUrl}/v1/memories/search?namespace=not-a-valid-namespace&query=test`,
    );

    expect(res.status).toBe(400);

    const data = await res.json() as { error: string };
    expect(data.error).toBe('invalid namespace');
  });
});

describe('Method enforcement on memory endpoints (Req 8.1, 8.3)', () => {
  it('DELETE on /v1/memories returns 405 with Allow: GET, POST', async () => {
    const res = await fetch(`${baseUrl}/v1/memories`, { method: 'DELETE' });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, POST');
  });

  it('POST on /v1/memories/search returns 405 with Allow: GET', async () => {
    const res = await fetch(`${baseUrl}/v1/memories/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});
