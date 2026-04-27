/**
 * HTTP receiver — the collector's public ingest surface.
 *
 * Exposes `POST /v1/events` for shims to submit canonical Events, and
 * `GET /healthz` for health checks. Validates schema, delegates
 * processing to the pipeline, and optionally triggers synchronous
 * retrieval for prompt events.
 *
 * Uses `node:http` only — no Express, Fastify, or other framework.
 *
 * @see Requirements 1.1–1.9, 2.1–2.2, 3.1–3.5, 15.1–15.3, 20.1–20.2
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZodError } from 'zod';

import { resolveAsset, serveAsset } from './static-handler.js';

import { parseEvent } from '../../types/index.js';
import type { EventIngestResponse } from '../../types/index.js';
import type { Pipeline } from '../pipeline/index.js';
import type { RetrievalAssembler } from '../retrieval/index.js';

// ── Version resolution ───────────────────────────────────────────────────

/**
 * Read the package version once at module load. The compiled receiver
 * lives at `dist/collector/receiver/index.js`, so `../../../package.json`
 * resolves to the root `package.json`.
 *
 * @see Requirements 10.1, 10.2, 10.3, 10.4
 */
function loadDaemonVersion(): string {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', '..', 'package.json',
    );
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    process.stderr.write('[kiro-learn] could not read package version\n');
    return 'unknown';
  }
}

/** Cached daemon version — read once, never re-read. */
const daemonVersion: string = loadDaemonVersion();

// ── Interfaces ──────────────────────────────────────────────────────────

/**
 * Dependencies injected into the receiver.
 */
export interface ReceiverDeps {
  pipeline: Pipeline;
  retrieval: RetrievalAssembler;
}

/**
 * Configuration for the HTTP receiver.
 */
export interface ReceiverOptions {
  /** Bind address. Default `'127.0.0.1'`. */
  host: string;
  /** Bind port. Default `21100`. */
  port: number;
  /** Maximum request body size in bytes. Default `2 * 1024 * 1024` (2 MiB). */
  maxBodyBytes: number;
  /** Latency budget for retrieval assembly in milliseconds. Default `500`. */
  retrievalBudgetMs: number;
}

/**
 * Handle returned by {@link startReceiver}. Provides access to the
 * underlying `node:http` server and a graceful shutdown method.
 */
export interface ReceiverHandle {
  /** The underlying node:http Server, for testing. */
  server: Server;
  /** Gracefully close: stop accepting, drain in-flight. */
  close(): Promise<void>;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Write a JSON response with the given status code.
 */
function jsonResponse(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Read the request body incrementally, aborting with 413 if the
 * accumulated size exceeds `maxBytes`.
 *
 * Returns the raw body string on success, or `null` if the response
 * was already sent (413).
 */
function readBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;

      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        aborted = true;
        jsonResponse(res, 413, { error: 'request body too large' });
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', () => {
      if (aborted) return;
      aborted = true;
      jsonResponse(res, 400, { error: 'request read error' });
      resolve(null);
    });
  });
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Start the HTTP receiver. Binds to `opts.host:opts.port` and begins
 * accepting requests.
 *
 * @see Requirements 1.1, 15.1, 20.1
 */
export function startReceiver(
  deps: ReceiverDeps,
  opts: ReceiverOptions,
): Promise<ReceiverHandle> {
  const { pipeline, retrieval } = deps;
  const { maxBodyBytes, retrievalBudgetMs } = opts;

  // ── Static-asset root (computed once at startup) ────────────────
  const assetRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui',
  );
  const uiBundleAvailable = existsSync(assetRoot);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? '';

    // ── Health check ──────────────────────────────────────────────
    if (method === 'GET' && pathname === '/healthz') {
      jsonResponse(res, 200, { status: 'ok', version: daemonVersion });
      return;
    }

    // ── Ingest endpoint ───────────────────────────────────────────
    if (method === 'POST' && pathname === '/v1/events') {
      // Enforce Content-Type when header is present
      const contentType = req.headers['content-type'];
      if (contentType !== undefined && !contentType.startsWith('application/json')) {
        jsonResponse(res, 415, { error: 'unsupported content type' });
        return;
      }

      // Read body incrementally with size limit
      const body = await readBody(req, res, maxBodyBytes);
      if (body === null) return; // 413 already sent

      // Parse JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        jsonResponse(res, 400, { error: 'invalid JSON' });
        return;
      }

      // Validate via parseEvent (Zod)
      let event;
      try {
        event = parseEvent(parsed);
      } catch (err: unknown) {
        if (err instanceof ZodError) {
          jsonResponse(res, 400, {
            error: 'validation failed',
            details: err.issues,
          });
          return;
        }
        // Unexpected validation error — no stack traces
        jsonResponse(res, 400, { error: 'validation failed' });
        return;
      }

      // Delegate to pipeline
      let response: EventIngestResponse;
      try {
        response = await pipeline.process(event);
      } catch {
        jsonResponse(res, 500, { error: 'internal error' });
        return;
      }

      // Retrieval gating: only when retrieve=true AND kind=prompt
      const retrieveParam = url.searchParams.get('retrieve');
      if (retrieveParam === 'true' && event.kind === 'prompt') {
        try {
          const result = await retrieval.assemble(event, retrievalBudgetMs);
          response = { ...response, retrieval: result };
        } catch {
          // Retrieval failure should not affect the ingest response
          // The event is already stored; we just skip retrieval
        }
      }

      jsonResponse(res, 200, response);
      return;
    }

    // ── Static UI serving ────────────────────────────────────────
    if (pathname === '/ui' || pathname === '/ui/' || pathname.startsWith('/ui/')) {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        jsonResponse(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!uiBundleAvailable) {
        jsonResponse(res, 404, { error: 'not found' });
        return;
      }
      const urlPath = pathname === '/ui' || pathname === '/ui/'
        ? '/'
        : pathname.slice('/ui'.length);
      const resolution = resolveAsset(urlPath, assetRoot);
      await serveAsset(resolution, res);
      return;
    }

    // ── Everything else → 404 ─────────────────────────────────────
    jsonResponse(res, 404, { error: 'not found' });
  });

  return new Promise<ReceiverHandle>((resolve, reject) => {
    server.on('error', reject);

    server.listen(opts.port, opts.host, () => {
      // Remove the one-shot error listener now that we're listening
      server.removeListener('error', reject);

      resolve({
        server,
        close(): Promise<void> {
          return new Promise<void>((resolveClose) => {
            server.close(() => {
              resolveClose();
            });
          });
        },
      });
    });
  });
}
