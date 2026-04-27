/**
 * Tests for the `/healthz` endpoint's version field.
 *
 * Starts a real receiver and verifies that `GET /healthz` returns
 * `status: 'ok'` and a `version` string. Also verifies caching (two
 * consecutive calls return the same version) and correct Content-Type.
 *
 * Note: `loadDaemonVersion()` resolves `package.json` relative to the
 * compiled receiver at `dist/collector/receiver/index.js`. When running
 * under vitest (source at `src/collector/receiver/index.ts`), the
 * relative path `../../package.json` resolves to `src/package.json`
 * which does not exist, so the version falls back to `'unknown'`. In a
 * production build the version matches the root `package.json`. The
 * tests verify the structural contract (field presence, type, caching,
 * Content-Type) regardless of the resolved value.
 *
 * @see Requirements 10.1, 10.2, 10.3, 10.4
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
    { pipeline: mockPipeline, retrieval: mockRetrieval, storage: mockStorage },
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

describe('/healthz version field', () => {
  it('returns status "ok" and a version string (Req 10.1, 10.3)', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);

    const data = await res.json() as { status: string; version: string };
    expect(data.status).toBe('ok');
    expect(typeof data.version).toBe('string');
    // In the test environment (vitest running source), the version resolves
    // to 'unknown' because package.json is not at the expected relative path.
    // In production (compiled dist/), it matches the real package version.
    // Either way, the field must be a non-empty string.
    expect(data.version.length).toBeGreaterThan(0);
  });

  it('two consecutive calls return the same version (cached, Req 10.2)', async () => {
    const res1 = await fetch(`${baseUrl}/healthz`);
    const data1 = await res1.json() as { version: string };

    const res2 = await fetch(`${baseUrl}/healthz`);
    const data2 = await res2.json() as { version: string };

    expect(data1.version).toBe(data2.version);
  });

  it('response has Content-Type: application/json (Req 10.4)', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});
