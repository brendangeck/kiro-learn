/**
 * Unit tests for the MCP collector HTTP client from `src/mcp/client.ts`.
 *
 * Uses a real `node:http` server for request verification and `vi.mock('node:fs')`
 * for config-loading tests.
 *
 * @see Requirements 6.1–6.6
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CollectorClientConfig, MemoryRecordPayload } from '../../src/mcp/client.js';

// ── Config loading tests (mock node:fs) ─────────────────────────────────

describe('loadCollectorConfig', () => {
  it('valid settings.json → correct host/port', async () => {
    vi.doMock('node:fs', () => ({
      readFileSync: vi.fn().mockReturnValue(
        JSON.stringify({
          collector: { host: '10.0.0.1', port: 9999 },
        }),
      ),
    }));

    // Dynamic import to pick up the mock
    const { loadCollectorConfig } = await import('../../src/mcp/client.js');
    const config = loadCollectorConfig();

    expect(config.host).toBe('10.0.0.1');
    expect(config.port).toBe(9999);
    expect(config.timeoutMs).toBe(5000);

    vi.doUnmock('node:fs');
  });

  it('missing file → defaults (127.0.0.1:21100)', async () => {
    vi.doMock('node:fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => {
        throw new Error('ENOENT');
      }),
    }));

    const { loadCollectorConfig } = await import('../../src/mcp/client.js');
    const config = loadCollectorConfig();

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(21100);
    expect(config.timeoutMs).toBe(5000);

    vi.doUnmock('node:fs');
  });
});

// ── HTTP transport tests (real local server) ────────────────────────────

describe('HTTP transport', () => {
  let server: Server;
  let port: number;
  let lastRequest: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  };

  function makeConfig(): CollectorClientConfig {
    return { host: '127.0.0.1', port, timeoutMs: 5000 };
  }

  function makeRecord(): MemoryRecordPayload {
    return {
      record_id: 'mr_01JXYZ01JXYZ01JXYZ01JXYZ01',
      namespace: '/actor/testuser/project/abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234/',
      strategy: 'mcp_observation',
      title: 'Test title',
      summary: 'Test summary',
      facts: ['fact one'],
      source_event_ids: ['01JXYZ01JXYZ01JXYZ01JXYZ01'],
      created_at: '2025-01-15T10:30:00.000Z',
      concepts: ['testing'],
      files_touched: ['src/test.ts'],
      observation_type: 'discovery',
    };
  }

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        lastRequest = {
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers: req.headers as Record<string, string | string[] | undefined>,
          body: Buffer.concat(chunks).toString('utf8'),
        };

        // Route responses
        if (req.url?.startsWith('/v1/memories/search')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify([makeRecord()]));
        } else if (req.url === '/v1/memories' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ record_id: 'mr_01JXYZ01JXYZ01JXYZ01JXYZ01', stored: true }));
        } else if (req.url === '/v1/error-endpoint') {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('postMemory', () => {
    it('sends correct path, method, headers, and body', async () => {
      // Use the real (unmocked) client module
      const { postMemory } = await import('../../src/mcp/client.js');
      const record = makeRecord();
      const result = await postMemory(record, makeConfig());

      expect(result.ok).toBe(true);
      expect(lastRequest.method).toBe('POST');
      expect(lastRequest.url).toBe('/v1/memories');
      expect(lastRequest.headers['content-type']).toBe('application/json');
      expect(lastRequest.headers['content-length']).toBeDefined();

      const sentBody = JSON.parse(lastRequest.body) as MemoryRecordPayload;
      expect(sentBody.record_id).toBe(record.record_id);
      expect(sentBody.namespace).toBe(record.namespace);
    });
  });

  describe('searchMemories', () => {
    it('sends correct path, query params, and encoding', async () => {
      const { searchMemories } = await import('../../src/mcp/client.js');
      const result = await searchMemories(
        {
          namespace: '/actor/testuser/project/abcd1234/',
          query: 'auth flow & tokens',
          limit: 5,
        },
        makeConfig(),
      );

      expect(result.ok).toBe(true);
      expect(lastRequest.method).toBe('GET');
      expect(lastRequest.url).toContain('/v1/memories/search?');
      // Verify query params are properly encoded
      expect(lastRequest.url).toContain('namespace=');
      expect(lastRequest.url).toContain('query=');
      expect(lastRequest.url).toContain('limit=5');
      // The '&' in the query should be encoded, not treated as a param separator
      expect(lastRequest.url).toContain(encodeURIComponent('auth flow & tokens'));
    });
  });

  describe('error handling', () => {
    it('non-2xx response → typed error with type "http_error"', async () => {
      // Create a config pointing to a special error endpoint
      // We'll use postMemory with a server that returns 500
      const { postMemory } = await import('../../src/mcp/client.js');

      // Spin up a small server that always returns 500
      const errorServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
      });

      const errorPort = await new Promise<number>((resolve) => {
        errorServer.listen(0, '127.0.0.1', () => {
          resolve((errorServer.address() as AddressInfo).port);
        });
      });

      try {
        const result = await postMemory(makeRecord(), {
          host: '127.0.0.1',
          port: errorPort,
          timeoutMs: 5000,
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.type).toBe('http_error');
          expect(result.error.statusCode).toBe(500);
        }
      } finally {
        await new Promise<void>((resolve) => {
          errorServer.close(() => resolve());
        });
      }
    });

    it('connection refused → typed error with type "connection_refused"', async () => {
      const { postMemory } = await import('../../src/mcp/client.js');

      // Use a port that nothing is listening on
      const result = await postMemory(makeRecord(), {
        host: '127.0.0.1',
        port: 19999,
        timeoutMs: 5000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe('connection_refused');
      }
    });
  });
});
