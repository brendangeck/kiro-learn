/**
 * Integration tests for the static-asset routes wired into the receiver.
 *
 * Starts a real receiver with a fixture `ui/` directory at the path the
 * receiver resolves from `import.meta.url`, then exercises every routing
 * branch: index serving, asset serving, SPA fallback, 404 for missing
 * assets with extensions, 405 for non-GET methods, and graceful 404 when
 * the Asset_Root is absent.
 *
 * @see Requirements 6.1, 6.2, 6.3, 6.6, 9.1, 9.2, N18, N20
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startReceiver } from '../../src/collector/receiver/index.js';
import type { ReceiverHandle } from '../../src/collector/receiver/index.js';
import type { KiroMemEvent, EventIngestResponse, StorageBackend } from '../../src/types/index.js';
import type { Pipeline } from '../../src/collector/pipeline/index.js';
import type { RetrievalAssembler } from '../../src/collector/retrieval/index.js';

// ── Fixture constants ───────────────────────────────────────────────────

/**
 * The receiver computes assetRoot as:
 *   path.resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui')
 *
 * When vitest loads `src/collector/receiver/index.ts` directly,
 * import.meta.url points to that source file, so assetRoot resolves to
 * `src/ui/`. We create a fixture directory there.
 */
const RECEIVER_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'src', 'collector', 'receiver',
);
const ASSET_ROOT = path.resolve(RECEIVER_DIR, '..', '..', 'ui');

const INDEX_HTML = '<!DOCTYPE html><html><body>scaffold</body></html>';
const TEST_JS = 'console.log("test");';

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
  listMemoryRecords() { return Promise.resolve([]); },
  listEvents() { return Promise.resolve({ items: [], total: 0 }); },
};

const deps = { pipeline: mockPipeline, retrieval: mockRetrieval, storage: mockStorage };
const opts = { host: '127.0.0.1', port: 0, maxBodyBytes: 2 * 1024 * 1024, retrievalBudgetMs: 500 };

// ── Helpers ─────────────────────────────────────────────────────────────

function createFixtureDir(): void {
  mkdirSync(path.join(ASSET_ROOT, 'assets'), { recursive: true });
  writeFileSync(path.join(ASSET_ROOT, 'index.html'), INDEX_HTML, 'utf8');
  writeFileSync(path.join(ASSET_ROOT, 'assets', 'test.js'), TEST_JS, 'utf8');
}

function removeFixtureDir(): void {
  if (existsSync(ASSET_ROOT)) {
    rmSync(ASSET_ROOT, { recursive: true, force: true });
  }
}

function baseUrlFrom(handle: ReceiverHandle): string {
  const addr = handle.server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('unexpected server address type');
  }
  return `http://127.0.0.1:${String(addr.port)}`;
}

// ── Tests: receiver WITH Asset_Root present ─────────────────────────────

describe('Receiver static routes — Asset_Root present', () => {
  let handle: ReceiverHandle;
  let baseUrl: string;

  beforeAll(async () => {
    // Ensure clean state, then create fixture
    removeFixtureDir();
    createFixtureDir();

    handle = await startReceiver(deps, opts);
    baseUrl = baseUrlFrom(handle);
  });

  afterAll(async () => {
    await handle.close();
    removeFixtureDir();
  });

  it('GET /ui → 200, serves index.html with text/html', async () => {
    const res = await fetch(`${baseUrl}/ui`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toBe(INDEX_HTML);
  });

  it('GET /ui/ → 200, same as GET /ui', async () => {
    const res = await fetch(`${baseUrl}/ui/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toBe(INDEX_HTML);
  });

  it('GET /ui/assets/test.js → 200, correct MIME and body', async () => {
    const res = await fetch(`${baseUrl}/ui/assets/test.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript');
    const body = await res.text();
    expect(body).toBe(TEST_JS);
  });

  it('GET /ui/nonexistent-route (extensionless) → 200, SPA fallback', async () => {
    const res = await fetch(`${baseUrl}/ui/nonexistent-route`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toBe(INDEX_HTML);
  });

  it('GET /ui/missing.css → 404', async () => {
    const res = await fetch(`${baseUrl}/ui/missing.css`);
    expect(res.status).toBe(404);
  });

  it('POST /ui → 405 with Allow: GET header', async () => {
    const res = await fetch(`${baseUrl}/ui`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });

  it('GET /healthz still works (N18)', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('status', 'ok');
  });
});

// ── Tests: receiver WITHOUT Asset_Root ──────────────────────────────────

describe('Receiver static routes — Asset_Root absent', () => {
  let handle: ReceiverHandle;
  let baseUrl: string;

  beforeAll(async () => {
    // Ensure the fixture directory does NOT exist
    removeFixtureDir();

    handle = await startReceiver(deps, opts);
    baseUrl = baseUrlFrom(handle);
  });

  afterAll(async () => {
    await handle.close();
  });

  it('GET /ui → 404 when Asset_Root absent (Req 6.6)', async () => {
    const res = await fetch(`${baseUrl}/ui`);
    expect(res.status).toBe(404);
  });

  it('GET /healthz still works when Asset_Root absent (N20)', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('status', 'ok');
  });
});
