/**
 * Collector HTTP client for the MCP memory server.
 *
 * A self-contained HTTP client using `node:http` that communicates with
 * the collector daemon. Follows the same config-loading pattern as the
 * shim's `loadConfig()` and the same HTTP transport pattern as `postEvent`.
 *
 * This module is deliberately self-contained — it does NOT import from
 * `src/collector/`, `src/shim/`, or `src/installer/`.
 *
 * @see Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, N8
 */

import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────

export interface CollectorClientConfig {
  host: string;
  port: number;
  timeoutMs: number;
}

export const DEFAULT_CLIENT_CONFIG: CollectorClientConfig = {
  host: '127.0.0.1',
  port: 21100,
  timeoutMs: 5000,
};

export interface MemoryRecordPayload {
  record_id: string;
  namespace: string;
  strategy: string;
  title: string;
  summary: string;
  facts: string[];
  source_event_ids: string[];
  created_at: string;
  concepts: string[];
  files_touched: string[];
  observation_type: string;
}

export interface CollectorError {
  type: 'connection_refused' | 'timeout' | 'http_error' | 'parse_error';
  message: string;
  statusCode?: number;
}

export interface PostMemoryResult {
  ok: true;
  record_id: string;
  stored: boolean;
}

export type PostMemoryResultOrError =
  | PostMemoryResult
  | { ok: false; error: CollectorError };

export interface SearchMemoriesParams {
  namespace: string;
  query: string;
  limit: number;
}

export type SearchMemoriesResult =
  | { ok: true; records: MemoryRecordPayload[] }
  | { ok: false; error: CollectorError };

// ── Configuration ───────────────────────────────────────────────────────

/**
 * Load collector host/port from `~/.kiro-learn/settings.json`, with defaults.
 *
 * Follows the shim's `loadConfig` pattern exactly: synchronous read,
 * JSON.parse, type-check each field, fall back to defaults on any error.
 */
export function loadCollectorConfig(): CollectorClientConfig {
  const defaults = { ...DEFAULT_CLIENT_CONFIG };

  try {
    const raw = readFileSync(
      join(homedir(), '.kiro-learn', 'settings.json'),
      'utf8',
    );
    const settings = JSON.parse(raw) as Record<string, unknown>;

    const collector = settings['collector'] as
      | Record<string, unknown>
      | undefined;

    return {
      host:
        typeof collector?.['host'] === 'string'
          ? collector['host']
          : defaults.host,
      port:
        typeof collector?.['port'] === 'number'
          ? collector['port']
          : defaults.port,
      timeoutMs: defaults.timeoutMs,
    };
  } catch {
    return defaults;
  }
}

// ── HTTP transport ──────────────────────────────────────────────────────

/**
 * POST /v1/memories — store a memory record.
 *
 * Returns a discriminated result with `ok: true` on success or
 * `ok: false` with a typed `CollectorError` on failure. Never throws.
 *
 * Uses `node:http.request` directly with an `AbortController` +
 * `setTimeout` for hard timeout enforcement (same pattern as shim's
 * `postEvent`).
 */
export async function postMemory(
  record: MemoryRecordPayload,
  config: CollectorClientConfig,
): Promise<PostMemoryResultOrError> {
  const payload = JSON.stringify(record);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.timeoutMs);

  try {
    const { statusCode, body } = await new Promise<{
      statusCode: number;
      body: string;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: config.host,
          port: config.port,
          path: '/v1/memories',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload, 'utf8'),
          },
          signal: ac.signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', reject);
        },
      );

      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    clearTimeout(timer);

    if (statusCode < 200 || statusCode >= 300) {
      return {
        ok: false,
        error: {
          type: 'http_error',
          message: `collector returned ${String(statusCode)}: ${body}`,
          statusCode,
        },
      };
    }

    try {
      const parsed = JSON.parse(body) as {
        record_id?: string;
        stored?: boolean;
      };
      return {
        ok: true,
        record_id: parsed.record_id ?? record.record_id,
        stored: parsed.stored ?? true,
      };
    } catch {
      return {
        ok: false,
        error: {
          type: 'parse_error',
          message: 'Unexpected response from collector',
        },
      };
    }
  } catch (err: unknown) {
    clearTimeout(timer);
    return { ok: false, error: classifyError(err) };
  }
}

/**
 * GET /v1/memories/search — search memory records.
 *
 * Returns a discriminated result with `ok: true` and the records array
 * on success, or `ok: false` with a typed `CollectorError` on failure.
 * Never throws.
 *
 * Uses `encodeURIComponent` for query string parameters (not string
 * concatenation) per N8.
 */
export async function searchMemories(
  params: SearchMemoriesParams,
  config: CollectorClientConfig,
): Promise<SearchMemoriesResult> {
  const queryString = [
    `namespace=${encodeURIComponent(params.namespace)}`,
    `query=${encodeURIComponent(params.query)}`,
    `limit=${encodeURIComponent(String(params.limit))}`,
  ].join('&');

  const path = `/v1/memories/search?${queryString}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.timeoutMs);

  try {
    const { statusCode, body } = await new Promise<{
      statusCode: number;
      body: string;
    }>((resolve, reject) => {
      const req = request(
        {
          hostname: config.host,
          port: config.port,
          path,
          method: 'GET',
          signal: ac.signal,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
          res.on('error', reject);
        },
      );

      req.on('error', reject);
      req.end();
    });

    clearTimeout(timer);

    if (statusCode < 200 || statusCode >= 300) {
      return {
        ok: false,
        error: {
          type: 'http_error',
          message: `collector returned ${String(statusCode)}: ${body}`,
          statusCode,
        },
      };
    }

    try {
      const records = JSON.parse(body) as MemoryRecordPayload[];
      return { ok: true, records };
    } catch {
      return {
        ok: false,
        error: {
          type: 'parse_error',
          message: 'Unexpected response from collector',
        },
      };
    }
  } catch (err: unknown) {
    clearTimeout(timer);
    return { ok: false, error: classifyError(err) };
  }
}

// ── Error classification ────────────────────────────────────────────────

/**
 * Classify a caught error into a typed `CollectorError`.
 *
 * Follows the same classification logic as the shim's `postEvent` catch
 * block: ECONNREFUSED → connection_refused, AbortError/ABORT_ERR/ETIMEDOUT
 * → timeout, everything else → connection_refused (generic transport error).
 */
function classifyError(err: unknown): CollectorError {
  const error = err as {
    code?: string;
    name?: string;
    message?: string;
  };

  if (error.code === 'ECONNREFUSED') {
    return {
      type: 'connection_refused',
      message: 'The kiro-learn collector is not running. Start it with `kiro-learn start`.',
    };
  }

  if (
    error.code === 'ETIMEDOUT' ||
    error.name === 'AbortError' ||
    error.code === 'ABORT_ERR'
  ) {
    return {
      type: 'timeout',
      message: 'Request to collector timed out after 5 seconds.',
    };
  }

  return {
    type: 'connection_refused',
    message: `Transport error: ${error.message ?? 'unknown'}`,
  };
}
