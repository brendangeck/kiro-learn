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
import { homedir } from 'node:os';
import path, { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ZodError } from 'zod';

import { resolveAsset, serveAsset } from './static-handler.js';

import { NAMESPACE_RE, parseEvent, parseMemoryRecord } from '../../types/index.js';
import type { EventIngestResponse, StorageBackend } from '../../types/index.js';
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
  storage: StorageBackend;
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

// ── Read-API helpers ────────────────────────────────────────────────────

/**
 * Extract the project_id hex segment from a namespace string.
 * Namespace pattern: `/actor/<actor_id>/project/<project_id>/`.
 * Returns the full namespace as fallback if the pattern doesn't match.
 *
 * @see Requirements 8.2, 8.3
 */
function extractProjectId(namespace: string): string {
  const match = namespace.match(/^\/actor\/[^/]+\/project\/([^/]+)\/$/);
  return match?.[1] ?? namespace;
}

/**
 * Derive a human-readable display name from a project_path or namespace.
 * Strips the `$HOME/` prefix from project_path when present; falls back
 * to the first 12 hex chars of the project_id segment.
 *
 * @see Requirements 8.2, 8.3, 8.4
 */
function deriveDisplayName(namespace: string, projectPath: string | null): string {
  if (projectPath !== null) {
    const home = homedir();
    if (projectPath.startsWith(home + sep)) {
      return projectPath.slice(home.length + 1);
    }
    return projectPath;
  }
  // Fallback: first 12 hex chars of project_id
  return extractProjectId(namespace).slice(0, 12);
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
  const { pipeline, retrieval, storage } = deps;
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

    // ── GET /v1/stats ─────────────────────────────────────────────
    if (method === 'GET' && pathname === '/v1/stats') {
      const ns = url.searchParams.get('namespace') ?? undefined;
      if (ns !== undefined && (ns.length > 500 || !NAMESPACE_RE.test(ns))) {
        jsonResponse(res, 400, { error: ns.length > 500 ? 'parameter too long' : 'invalid namespace' });
        return;
      }
      try {
        const stats = await storage.getStats(ns);
        const projects = await storage.listProjects();
        const projectsWithDisplay = projects.map((p) => ({
          namespace: p.namespace,
          project_id: extractProjectId(p.namespace),
          display_name: deriveDisplayName(p.namespace, p.project_path),
          event_count: p.event_count,
          memory_count: p.memory_count,
        }));
        jsonResponse(res, 200, { ...stats, projects: projectsWithDisplay });
      } catch {
        jsonResponse(res, 500, { error: 'internal error' });
      }
      return;
    }

    // ── GET /v1/memories ──────────────────────────────────────────
    if (method === 'GET' && pathname === '/v1/memories') {
      const ns = url.searchParams.get('namespace') ?? undefined;
      if (ns !== undefined) {
        if (ns.length > 500) {
          jsonResponse(res, 400, { error: 'parameter too long' });
          return;
        }
        if (!NAMESPACE_RE.test(ns)) {
          jsonResponse(res, 400, { error: 'invalid namespace' });
          return;
        }
      }

      // Parse limit (default 100, clamped to [1, 500])
      const rawLimit = url.searchParams.get('limit');
      let limit = 100;
      if (rawLimit !== null) {
        const parsed = Number(rawLimit);
        if (!Number.isInteger(parsed)) {
          jsonResponse(res, 400, { error: 'limit must be an integer' });
          return;
        }
        limit = Math.max(1, Math.min(500, parsed));
      }

      // Parse offset (default 0, clamped to [0, ∞))
      const rawOffset = url.searchParams.get('offset');
      let offset = 0;
      if (rawOffset !== null) {
        const parsed = Number(rawOffset);
        if (!Number.isInteger(parsed)) {
          jsonResponse(res, 400, { error: 'offset must be an integer' });
          return;
        }
        offset = Math.max(0, parsed);
      }

      try {
        const params: { namespace?: string; limit: number; offset: number } = { limit, offset };
        if (ns !== undefined) {
          params.namespace = ns;
        }
        const result = await storage.listMemoryRecords(params);
        jsonResponse(res, 200, { items: result.items, total: result.total, limit, offset });
      } catch {
        jsonResponse(res, 500, { error: 'internal error' });
      }
      return;
    }

    // ── GET /v1/events (read) ─────────────────────────────────────
    if (method === 'GET' && pathname === '/v1/events') {
      const ns = url.searchParams.get('namespace') ?? undefined;
      if (ns !== undefined) {
        if (ns.length > 500) {
          jsonResponse(res, 400, { error: 'parameter too long' });
          return;
        }
        if (!NAMESPACE_RE.test(ns)) {
          jsonResponse(res, 400, { error: 'invalid namespace' });
          return;
        }
      }
      const rawLimit = url.searchParams.get('limit');
      let limit = 50;
      if (rawLimit !== null) {
        const parsed = Number(rawLimit);
        if (!Number.isInteger(parsed)) {
          jsonResponse(res, 400, { error: 'limit must be an integer' });
          return;
        }
        limit = Math.max(1, Math.min(200, parsed));
      }
      try {
        const params: { namespace?: string; limit: number } = { limit };
        if (ns !== undefined) {
          params.namespace = ns;
        }
        const result = await storage.listEvents(params);
        jsonResponse(res, 200, result);
      } catch {
        jsonResponse(res, 500, { error: 'internal error' });
      }
      return;
    }

    // ── POST /v1/memories (ingest memory record) ────────────────
    if (method === 'POST' && pathname === '/v1/memories') {
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

      // Validate via parseMemoryRecord (Zod)
      let record;
      try {
        record = parseMemoryRecord(parsed);
      } catch (err: unknown) {
        if (err instanceof ZodError) {
          jsonResponse(res, 400, {
            error: 'validation failed',
            details: err.issues,
          });
          return;
        }
        jsonResponse(res, 400, { error: 'validation failed' });
        return;
      }

      // Store via storage backend
      try {
        await storage.putMemoryRecord(record);
      } catch {
        jsonResponse(res, 500, { error: 'internal error' });
        return;
      }

      jsonResponse(res, 200, { record_id: record.record_id, stored: true });
      return;
    }

    // ── GET /v1/memories/search ───────────────────────────────────
    if (method === 'GET' && pathname === '/v1/memories/search') {
      const ns = url.searchParams.get('namespace');
      if (ns === null || ns === '') {
        jsonResponse(res, 400, { error: 'namespace parameter is required' });
        return;
      }
      if (ns.length > 500) {
        jsonResponse(res, 400, { error: 'parameter too long' });
        return;
      }
      if (!NAMESPACE_RE.test(ns)) {
        jsonResponse(res, 400, { error: 'invalid namespace' });
        return;
      }

      const query = url.searchParams.get('query');
      if (query === null || query === '') {
        jsonResponse(res, 400, { error: 'query parameter is required' });
        return;
      }

      // Parse limit (default 10, clamped to [1, 100])
      const rawLimit = url.searchParams.get('limit');
      let limit = 10;
      if (rawLimit !== null) {
        const parsed = Number(rawLimit);
        if (!Number.isInteger(parsed)) {
          jsonResponse(res, 400, { error: 'limit must be an integer' });
          return;
        }
        limit = Math.max(1, Math.min(100, parsed));
      }

      try {
        const results = await storage.searchMemoryRecords({ namespace: ns, query, limit });
        jsonResponse(res, 200, results);
      } catch {
        jsonResponse(res, 500, { error: 'internal error' });
      }
      return;
    }

    // ── Method enforcement for read routes ────────────────────────
    if (pathname === '/v1/stats') {
      res.setHeader('Allow', 'GET');
      jsonResponse(res, 405, { error: 'method not allowed' });
      return;
    }
    if (pathname === '/v1/memories') {
      res.setHeader('Allow', 'GET, POST');
      jsonResponse(res, 405, { error: 'method not allowed' });
      return;
    }
    if (pathname === '/v1/memories/search') {
      res.setHeader('Allow', 'GET');
      jsonResponse(res, 405, { error: 'method not allowed' });
      return;
    }
    if (pathname === '/v1/events') {
      res.setHeader('Allow', 'GET, POST');
      jsonResponse(res, 405, { error: 'method not allowed' });
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
