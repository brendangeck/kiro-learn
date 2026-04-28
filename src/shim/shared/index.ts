/**
 * Shared shim internals — configuration, session management, event builder,
 * body truncation, and HTTP transport.
 *
 * Consumed by surface-specific shims (cli-agent, ide-hook). No host-surface
 * logic lives here. The shim is a standalone HTTP client of the collector —
 * it shares types but has no code-level dependency on the collector or
 * installer modules.
 *
 * @see Requirements 11.1, 11.3, 11.4
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EventIngestResponse, KiroMemEvent } from '../../types/index.js';
import { ulid } from 'ulidx';

import { detectProjectRoot } from './project-root.js';

// ── Package version ─────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Package version read from the nearest `package.json`. In development this
 * resolves to the repo root; in the installed layout under
 * `~/.kiro-learn/lib/` the installer places a `package.json` at the lib root.
 *
 * Falls back to `'0.0.0'` if the file is unreadable — version is
 * informational, not load-bearing.
 */
const PACKAGE_VERSION: string = (() => {
  try {
    const raw = readFileSync(
      join(__dirname, '..', '..', '..', 'package.json'),
      'utf8',
    );
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

// ── Configuration ───────────────────────────────────────────────────────

/**
 * Shim configuration. All fields have sensible defaults so that zero-config
 * operation works out of the box.
 *
 * @see Requirements 9.1, 9.4
 */
export interface ShimConfig {
  /** Collector bind address. Default `'127.0.0.1'`. */
  collectorHost: string;
  /** Collector bind port. Default `21100`. */
  collectorPort: number;
  /** HTTP request timeout in milliseconds. Default `2000`. */
  timeoutMs: number;
  /** Maximum serialized body size in bytes. Default `524_288` (512 KiB). */
  maxBodyBytes: number;
}

/**
 * Default configuration values for the shim.
 *
 * @see Requirements 9.1
 */
export const DEFAULT_SHIM_CONFIG: ShimConfig = {
  collectorHost: '127.0.0.1',
  collectorPort: 21100,
  timeoutMs: 2000,
  maxBodyBytes: 524_288,
};

/**
 * Load configuration from `~/.kiro-learn/settings.json`, merged with
 * defaults. Returns defaults if the file is missing or unreadable.
 *
 * Synchronous — the shim has a 3-second total budget and async config
 * loading adds complexity for no benefit on a local JSON file.
 *
 * @see Requirements 9.1, 9.2, 9.3, 9.4
 */
export function loadConfig(): ShimConfig {
  const defaults = { ...DEFAULT_SHIM_CONFIG };

  try {
    const raw = readFileSync(
      join(homedir(), '.kiro-learn', 'settings.json'),
      'utf8',
    );
    const settings = JSON.parse(raw) as Record<string, unknown>;

    const collector = settings['collector'] as
      | Record<string, unknown>
      | undefined;
    const shim = settings['shim'] as Record<string, unknown> | undefined;

    return {
      collectorHost:
        typeof collector?.['host'] === 'string'
          ? collector['host']
          : defaults.collectorHost,
      collectorPort:
        typeof collector?.['port'] === 'number'
          ? collector['port']
          : defaults.collectorPort,
      timeoutMs:
        typeof shim?.['timeoutMs'] === 'number'
          ? shim['timeoutMs']
          : defaults.timeoutMs,
      maxBodyBytes: defaults.maxBodyBytes, // not user-configurable in v1
    };
  } catch {
    return defaults;
  }
}

// ── Session management ──────────────────────────────────────────────────

/**
 * Derive the session file path from a working directory.
 *
 * Resolves `cwd` via {@link realpathSync} to normalise symlinks, then
 * takes the first 16 hex characters of the MD5 hash of the resolved path.
 *
 * MD5 is used here (not SHA-256) because the session file path needs to be
 * short and human-readable in `/tmp/`. This is not a security use — it is
 * deterministic path derivation.
 *
 * @see Requirements 2.2, 2.6
 */
export function sessionFilePath(cwd: string): string {
  const resolved = realpathSync(cwd);
  const hash = createHash('md5').update(resolved).digest('hex');
  const prefix = hash.substring(0, 16);
  return '/tmp/kiro-learn-session-' + prefix;
}

/**
 * Generate a new session ID, write it to the session file derived from
 * `cwd`, and return it.
 *
 * Called on `agentSpawn` to start a fresh session.
 *
 * @see Requirements 2.1, 2.2
 */
export function createSession(cwd: string): string {
  const id = randomUUID();
  writeFileSync(sessionFilePath(cwd), id, 'utf8');
  return id;
}

/**
 * Read the session ID from the session file derived from `cwd`.
 *
 * If the file is missing, unreadable, or contains an invalid value
 * (empty or non-UUID), generates a fallback UUID, writes it to the
 * session file, and returns it. This ensures non-spawn hooks always
 * have a usable session ID.
 *
 * @see Requirements 2.3, 2.4
 */
export function readSession(cwd: string): string {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  try {
    const value = readFileSync(sessionFilePath(cwd), 'utf8').trim();
    if (value !== '' && UUID_RE.test(value)) {
      return value;
    }
  } catch {
    // File missing or unreadable — fall through to regeneration.
  }
  const fallback = randomUUID();
  writeFileSync(sessionFilePath(cwd), fallback, 'utf8');
  return fallback;
}

// ── Event building ──────────────────────────────────────────────────────

/**
 * Parameters accepted by {@link buildEvent}.
 *
 * @see Requirements 3.1–3.9
 */
export interface EventBuildParams {
  /** Discriminated event kind. */
  kind: KiroMemEvent['kind'];
  /** Typed event body (text, message, or json). */
  body: KiroMemEvent['body'];
  /** Session ID obtained from session management. */
  sessionId: string;
  /** Working directory — used to derive project identity and namespace. */
  cwd: string;
  /** Optional parent event ID for causal linking. */
  parentEventId?: string;
  /** Source surface identifier. Defaults to `'kiro-cli'` when omitted. */
  surface?: 'kiro-cli' | 'kiro-ide';
}

/**
 * Build a canonical {@link KiroMemEvent} from the given parameters.
 *
 * Generates `event_id` (ULID via `ulidx`), derives `namespace` from the
 * project root detected under `cwd` (SHA-256 of the resolved project
 * root path), sets `actor_id` from the OS username, and populates the
 * `source` provenance block — including `source.project_path`, which
 * mirrors the hash input so the preimage is observable downstream.
 *
 * Project-root detection — including all filesystem error handling and
 * fallbacks — is delegated to {@link detectProjectRoot}. `buildEvent`
 * itself adds no try/catch around it; the total function guarantees a
 * usable result for every input.
 *
 * When `parentEventId` is `undefined` the returned object omits the
 * `parent_event_id` key entirely (required by `exactOptionalPropertyTypes`).
 * `source.project_path` is always populated by the updated shim — its
 * optionality in the schema exists only for backward compatibility with
 * older stored events.
 *
 * @see Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.1, 4.2, 4.5, 6.1, 6.2, 6.3, 6.4, 8.1, 8.2, 8.3, 8.4
 */
export function buildEvent(params: EventBuildParams): KiroMemEvent {
  const { projectRoot, projectPath } = detectProjectRoot(params.cwd);
  const projectId = createHash('sha256').update(projectRoot).digest('hex');

  let actorId: string;
  try {
    actorId = userInfo().username;
  } catch {
    actorId = process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown';
  }

  const namespace = `/actor/${actorId}/project/${projectId}/`;

  const event: KiroMemEvent = {
    event_id: ulid(),
    session_id: params.sessionId,
    actor_id: actorId,
    namespace,
    schema_version: 1,
    kind: params.kind,
    body: params.body,
    valid_time: new Date().toISOString(),
    source: {
      surface: params.surface ?? 'kiro-cli',
      version: PACKAGE_VERSION,
      client_id: hostname(),
      project_path: projectPath,
    },
  };

  if (params.parentEventId !== undefined) {
    return { ...event, parent_event_id: params.parentEventId };
  }

  return event;
}

// ── Body truncation ─────────────────────────────────────────────────────

/** Marker appended to truncated content. */
const TRUNCATION_MARKER = ' [truncated by kiro-learn]';

/**
 * Ensure the serialized body does not exceed `maxBytes`.
 *
 * - **text** bodies: iteratively trim `content` by 10% until under budget,
 *   then append the truncation marker.
 * - **message** bodies: trim the last turn's `content` by 10% iteratively,
 *   then append the marker.
 * - **json** bodies: if `data.tool_response.result` is a string, trim it
 *   first; otherwise stringify the entire `data` object and truncate as a
 *   string wrapped in a `{ _truncated }` envelope.
 *
 * Returns the original body unchanged when it already fits within budget.
 * Never mutates the input — always returns a new object when truncation
 * occurs.
 *
 * @see Requirements 10.1, 10.2, 10.3, 10.4
 */
export function truncateBody(
  body: KiroMemEvent['body'],
  maxBytes: number,
): KiroMemEvent['body'] {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return body;
  }

  switch (body.type) {
    case 'text': {
      let content = body.content;
      while (
        Buffer.byteLength(
          JSON.stringify({ type: 'text' as const, content }),
          'utf8',
        ) > maxBytes
      ) {
        const trimmed = content.substring(0, Math.floor(content.length * 0.9));
        if (trimmed.length === content.length) break; // can't trim further
        content = trimmed;
      }
      return { type: 'text', content: content + TRUNCATION_MARKER };
    }

    case 'message': {
      const turns = structuredClone(body.turns);
      // Trim turns from the end until under budget. Start with the last
      // turn's content; if that's exhausted, move to earlier turns.
      for (let t = turns.length - 1; t >= 0; t--) {
        const turn = turns[t]!;
        while (
          Buffer.byteLength(
            JSON.stringify({ type: 'message' as const, turns }),
            'utf8',
          ) > maxBytes
        ) {
          const trimmed = turn.content.substring(
            0,
            Math.floor(turn.content.length * 0.9),
          );
          if (trimmed.length === turn.content.length) break; // can't trim this turn further
          turn.content = trimmed;
        }
        if (
          Buffer.byteLength(
            JSON.stringify({ type: 'message' as const, turns }),
            'utf8',
          ) <= maxBytes
        ) {
          break; // under budget
        }
      }
      const lastTurn = turns[turns.length - 1]!;
      lastTurn.content = lastTurn.content + TRUNCATION_MARKER;
      return { type: 'message', turns };
    }

    case 'json': {
      const data = structuredClone(body.data);
      const record = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : null;
      const toolResponse = (
        record as { tool_response?: { result?: unknown } } | null
      )?.tool_response;

      if (typeof toolResponse?.result === 'string') {
        let result: string = toolResponse.result;
        while (
          Buffer.byteLength(
            JSON.stringify({ type: 'json' as const, data }),
            'utf8',
          ) > maxBytes
        ) {
          const trimmed = result.substring(0, Math.floor(result.length * 0.9));
          if (trimmed.length === result.length) break; // can't trim further
          result = trimmed;
          toolResponse.result = result;
        }
        toolResponse.result = result + TRUNCATION_MARKER;
        return { type: 'json', data };
      }

      let str = JSON.stringify(data);
      while (
        Buffer.byteLength(
          JSON.stringify({
            type: 'json' as const,
            data: { _truncated: str + TRUNCATION_MARKER },
          }),
          'utf8',
        ) > maxBytes
      ) {
        const trimmed = str.substring(0, Math.floor(str.length * 0.9));
        if (trimmed.length === str.length) break; // can't trim further
        str = trimmed;
      }
      return { type: 'json', data: { _truncated: str + TRUNCATION_MARKER } };
    }
  }
}

// ── HTTP transport ──────────────────────────────────────────────────────

/**
 * Options for {@link postEvent}.
 *
 * @see Requirements 5.2
 */
export interface PostEventOptions {
  /** When `true`, append `?retrieve=true` to the request URL. */
  retrieve: boolean;
}

/**
 * POST an event to the collector daemon.
 *
 * Returns the parsed {@link EventIngestResponse} on success (2xx), or
 * `null` on any failure — timeout, connection refused, non-2xx status, or
 * JSON parse error. Logs warnings to stderr with a `[kiro-learn]` prefix
 * for observability. Never throws.
 *
 * Uses `node:http.request` directly with an {@link AbortController} +
 * `setTimeout` for hard timeout enforcement.
 *
 * @see Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 7.5
 */
export async function postEvent(
  event: KiroMemEvent,
  opts: PostEventOptions,
  config: ShimConfig,
): Promise<EventIngestResponse | null> {
  let path = '/v1/events';
  if (opts.retrieve) {
    path += '?retrieve=true';
  }

  const payload = JSON.stringify(event);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.timeoutMs);

  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = request(
        {
          hostname: config.collectorHost,
          port: config.collectorPort,
          path,
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
            const statusCode = res.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(
                Object.assign(
                  new Error(`collector returned ${String(statusCode)}`),
                  { statusCode },
                ),
              );
              return;
            }
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
          res.on('error', reject);
        },
      );

      req.on('error', reject);
      req.write(payload);
      req.end();
    });

    clearTimeout(timer);
    return JSON.parse(body) as EventIngestResponse;
  } catch (err: unknown) {
    clearTimeout(timer);

    const error = err as { code?: string; statusCode?: number; message?: string; name?: string };

    if (error.statusCode !== undefined) {
      // Non-2xx response — already formatted in the reject above
      process.stderr.write(`[kiro-learn] collector returned ${String(error.statusCode)}\n`);
    } else if (error.code === 'ECONNREFUSED') {
      process.stderr.write(
        '[kiro-learn] collector not reachable (is it running?)\n',
      );
    } else if (
      error.code === 'ETIMEDOUT' ||
      error.name === 'AbortError' ||
      error.code === 'ABORT_ERR'
    ) {
      process.stderr.write('[kiro-learn] collector request timed out\n');
    } else {
      process.stderr.write(
        `[kiro-learn] transport error: ${error.message ?? 'unknown'}\n`,
      );
    }

    return null;
  }
}
