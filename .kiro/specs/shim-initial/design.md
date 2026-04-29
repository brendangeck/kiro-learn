# Design Document: Kiro CLI Agent Shim

## Overview

This spec defines the kiro-learn shim — the thin per-client adapter that bridges Kiro CLI agent hooks and the collector daemon. The shim is invoked as a subprocess on every hook fire, reads JSON from stdin, constructs a canonical `KiroMemEvent`, POSTs it to the collector, and returns retrieval context to the Kiro runtime via stdout.

The shim builds on the contracts established in [event-schema-and-storage](../event-schema-and-storage/design.md) (the canonical `KiroMemEvent` type) and [collector-pipeline](../collector-pipeline/design.md) (the `POST /v1/events` endpoint and `EventIngestResponse` shape). Those are consumed here, not redefined.

**Design principle: shim is dumb, collector is smart.** The shim owns no business logic. It normalizes hook input into a canonical event, ships it, and exits. All processing decisions (dedup, privacy scrub, extraction, retrieval ranking) live in the collector. The shim is a translator, not a thinker.

**In scope:** Stdin parsing, event construction, session management, HTTP transport, stdout output, error handling, body truncation, configuration loading.

**Out of scope:** Collector implementation, storage, extraction, installer/CLI dispatch, daemon lifecycle, IDE hook support (v3), local spool/retry (v2+).

## Architecture

### Component context

```
┌─────────────────────────────┐
│      Kiro CLI Runtime       │
│  fires hook → stdin JSON    │
│  captures stdout → context  │
└──────────────┬──────────────┘
               │ stdin
               ▼
┌─────────────────────────────┐
│   CLI Agent Shim            │  ◄── this spec (green)
│   src/shim/cli-agent/       │
│                             │
│   parse stdin → dispatch    │
│   by hook_event_name        │
│         │                   │
│         ▼                   │
│   Shared Shim               │  ◄── this spec (green)
│   src/shim/shared/          │
│                             │
│   session mgmt, event       │
│   builder, truncation,      │
│   HTTP transport, config    │
└──────────────┬──────────────┘
               │ POST /v1/events
               ▼
┌─────────────────────────────┐
│   Collector Daemon          │  ◄── prior spec (grey)
│   127.0.0.1:21100           │
│                             │
│   → EventIngestResponse     │
│     (with optional           │
│      retrieval context)     │
└─────────────────────────────┘

Side effects:
  /tmp/kiro-learn-session-<hash>   session file (read/write)
  ~/.kiro-learn/settings.json      config file (read only)
```

### End-to-end sequence (userPromptSubmit with retrieval)

```
Kiro CLI Runtime          CLI Agent Shim           Shared Module            Session File         Collector
     │                         │                        │                       │                    │
     │──stdin JSON────────────▶│                        │                       │                    │
     │                         │──readSession(cwd)─────▶│                       │                    │
     │                         │                        │──read────────────────▶│                    │
     │                         │                        │◀─session UUID─────────│                    │
     │                         │◀─sessionId─────────────│                       │                    │
     │                         │──buildEvent(...)───────▶│                       │                    │
     │                         │◀─KiroMemEvent──────────│                       │                    │
     │                         │──postEvent(evt,true)───▶│                       │                    │
     │                         │                        │──POST /v1/events?retrieve=true────────────▶│
     │                         │                        │◀─{ event_id, stored, retrieval }───────────│
     │                         │◀─EventIngestResponse───│                       │                    │
     │◀─stdout: context────────│                        │                       │                    │
     │◀─exit 0─────────────────│                        │                       │                    │
```

### End-to-end sequence (agentSpawn)

```
Kiro CLI Runtime          CLI Agent Shim           Shared Module            Session File         Collector
     │                         │                        │                       │                    │
     │──stdin JSON────────────▶│                        │                       │                    │
     │                         │──createSession(cwd)───▶│                       │                    │
     │                         │                        │──randomUUID()         │                    │
     │                         │                        │──write───────────────▶│                    │
     │                         │◀─sessionId─────────────│                       │                    │
     │                         │──buildEvent(...)───────▶│                       │                    │
     │                         │◀─KiroMemEvent──────────│                       │                    │
     │                         │──postEvent(evt,false)──▶│                       │                    │
     │                         │                        │──POST /v1/events─────────────────────────▶│
     │                         │                        │◀─{ event_id, stored }─────────────────────│
     │                         │◀─EventIngestResponse───│                       │                    │
     │◀─stdout: session id─────│                        │                       │                    │
     │◀─exit 0─────────────────│                        │                       │                    │
```

## Module Structure

### Dependency direction

```
src/shim/cli-agent/index.ts
    └── imports from → src/shim/shared/index.ts
                            └── imports from → src/types/index.ts
```

| Module | May import from | Must NOT import from |
|--------|----------------|---------------------|
| `src/shim/cli-agent/` | `src/shim/shared/`, `src/types/` | `src/collector/`, `src/installer/` |
| `src/shim/shared/` | `src/types/` | `src/collector/`, `src/installer/`, `src/shim/cli-agent/` |

The shim is a standalone HTTP client of the collector. It shares types but has no code-level dependency on the collector or installer.

## Components and Interfaces

### Component 1: Shared Shim Module (`src/shim/shared/index.ts`)

**Purpose.** Reusable core logic for any shim surface: event building, HTTP transport, session file management, configuration loading, body truncation.

**Interface.**

```typescript
import type { KiroMemEvent, EventIngestResponse } from '../../types/index.js';

// ── Configuration ──

export interface ShimConfig {
  collectorHost: string;    // default '127.0.0.1'
  collectorPort: number;    // default 21100
  timeoutMs: number;        // default 2000
  maxBodyBytes: number;     // default 524_288 (512 KiB)
}

export const DEFAULT_SHIM_CONFIG: ShimConfig;

/**
 * Load configuration from ~/.kiro-learn/settings.json, merged with defaults.
 * Returns defaults if the file is missing or unreadable. Synchronous — the
 * shim has a 3-second total budget and async config loading adds complexity
 * for no benefit on a local JSON file.
 */
export function loadConfig(): ShimConfig;

// ── Session management ──

/**
 * Derive the session file path from a resolved cwd.
 * Returns /tmp/kiro-learn-session-<first 16 hex chars of MD5(realpath(cwd))>
 *
 * MD5 is used here (not SHA-256) because the session file path needs to be
 * short and human-readable in /tmp/. This is not a security use — it is
 * deterministic path derivation. SHA-256 is used for project_id in the
 * namespace because that is a long-lived identity.
 */
export function sessionFilePath(cwd: string): string;

/**
 * Generate a new session ID (crypto.randomUUID()), write it to the session
 * file, and return it.
 */
export function createSession(cwd: string): string;

/**
 * Read the session ID from the session file. If the file is missing or
 * unreadable, generate a fallback UUID, write it, and return it.
 */
export function readSession(cwd: string): string;

// ── Event building ──

export interface EventBuildParams {
  kind: KiroMemEvent['kind'];
  body: KiroMemEvent['body'];
  sessionId: string;
  cwd: string;
  parentEventId?: string;
}

/**
 * Build a canonical KiroMemEvent from the given parameters.
 * Generates event_id (ULID), derives namespace from cwd,
 * sets actor_id, source, valid_time, schema_version.
 */
export function buildEvent(params: EventBuildParams): KiroMemEvent;

// ── Body truncation ──

/**
 * Ensure the serialized body does not exceed maxBytes.
 * For text bodies: truncate content string.
 * For message bodies: truncate the last turn's content.
 * For json bodies (tool_use): truncate tool_response.result first.
 * Appends [truncated by kiro-learn] marker when truncation occurs.
 * Returns the original body unchanged if within budget.
 */
export function truncateBody(
  body: KiroMemEvent['body'],
  maxBytes: number,
): KiroMemEvent['body'];

// ── HTTP transport ──

export interface PostEventOptions {
  retrieve: boolean;
}

/**
 * POST an event to the collector. Returns the parsed response on success,
 * or null on any failure (timeout, connection refused, non-2xx, parse error).
 * Logs warnings to stderr on failure. Never throws.
 */
export function postEvent(
  event: KiroMemEvent,
  opts: PostEventOptions,
  config: ShimConfig,
): Promise<EventIngestResponse | null>;
```

**Key design decisions:**

1. **`postEvent` returns `null` on failure, never throws.** The caller does not need to distinguish failure modes — all failures mean "collector did not accept the event, move on." Warnings go to stderr for observability.

2. **`truncateBody` is a pure function.** It takes a body and a byte limit, returns a new body. No side effects. Trivially testable.

3. **`loadConfig` is synchronous.** `fs.readFileSync` on a local JSON file is sub-millisecond. Async adds complexity for no benefit within the shim's 3-second budget.

4. **Session file uses MD5 of realpath for the path, SHA-256 for project_id.** Different hash functions for different purposes: MD5 gives a short, human-readable temp file name; SHA-256 gives a collision-resistant project identity for the namespace.

### Component 2: CLI Agent Shim (`src/shim/cli-agent/index.ts`)

**Purpose.** Kiro CLI-specific adapter. Reads stdin, dispatches by hook type, calls shared module functions, writes stdout.

**Interface.**

```typescript
import type { KiroMemEvent } from '../../types/index.js';

// ── Hook input types ──

/** Base fields present in all hook inputs. */
export interface HookInputBase {
  hook_event_name: string;
  cwd: string;
}

export interface AgentSpawnInput extends HookInputBase {
  hook_event_name: 'agentSpawn';
}

export interface UserPromptSubmitInput extends HookInputBase {
  hook_event_name: 'userPromptSubmit';
  prompt?: string;
}

export interface PostToolUseInput extends HookInputBase {
  hook_event_name: 'postToolUse';
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: {
    success?: boolean;
    result?: unknown;
  };
}

export interface StopInput extends HookInputBase {
  hook_event_name: 'stop';
  assistant_response?: string;
}

export type HookInput =
  | AgentSpawnInput
  | UserPromptSubmitInput
  | PostToolUseInput
  | StopInput;

// ── Handler functions ──

/**
 * Handle the agentSpawn hook.
 * 1. Generate session ID, write to session file.
 * 2. Build a "note" event with "session started" body.
 * 3. POST to collector (no retrieval).
 * 4. Write session ID to stdout.
 */
export function handleSpawn(input: AgentSpawnInput): Promise<void>;

/**
 * Handle the userPromptSubmit hook.
 * 1. Read session ID from session file.
 * 2. Build a "prompt" event with the user's prompt as body.
 * 3. POST to collector with retrieve=true.
 * 4. Write retrieval context to stdout (if present).
 */
export function handlePrompt(input: UserPromptSubmitInput): Promise<void>;

/**
 * Handle the postToolUse hook.
 * 1. Read session ID from session file.
 * 2. Build a "tool_use" event with tool_name, tool_input, tool_response as JSON body.
 * 3. POST to collector (no retrieval).
 * 4. No stdout output.
 */
export function handleObserve(input: PostToolUseInput): Promise<void>;

/**
 * Handle the stop hook.
 * 1. Read session ID from session file.
 * 2. Build a "session_summary" event with assistant_response as body.
 * 3. POST to collector (no retrieval).
 * 4. No stdout output.
 */
export function handleSummarize(input: StopInput): Promise<void>;

/**
 * Main entry point. Reads stdin, parses JSON, dispatches to the
 * appropriate handler. Wrapped in top-level try/catch — always exits 0.
 */
export function main(): Promise<void>;
```

**Hook-to-event mapping:**

| Hook | `kind` | `body.type` | `body.content` / `body.data` | `retrieve` |
|------|--------|-------------|------------------------------|------------|
| `agentSpawn` | `note` | `text` | `"session started"` | `false` |
| `userPromptSubmit` | `prompt` | `text` | `input.prompt` (or `""`) | `true` |
| `postToolUse` | `tool_use` | `json` | `{ tool_name, tool_input, tool_response }` | `false` |
| `stop` | `session_summary` | `text` | `input.assistant_response` (or `""`) | `false` |

**Stdout output rules:**

| Hook | Stdout |
|------|--------|
| `agentSpawn` | `"kiro-learn session <uuid>\n"` |
| `userPromptSubmit` | Retrieval context string (if non-empty), else nothing |
| `postToolUse` | Nothing |
| `stop` | Nothing |

## Algorithms

### Algorithm: main()

```pascal
ALGORITHM main()

BEGIN
  TRY
    config ← loadConfig()
    raw ← readStdin()

    IF raw is empty THEN
      RETURN  // no input, nothing to do
    END IF

    TRY
      input ← JSON.parse(raw)
    CATCH
      LOG stderr "[kiro-learn] failed to parse stdin JSON"
      RETURN
    END TRY

    IF input.cwd is missing THEN
      LOG stderr "[kiro-learn] missing cwd in hook input"
      RETURN
    END IF

    SWITCH input.hook_event_name
      CASE 'agentSpawn':
        AWAIT handleSpawn(input)
      CASE 'userPromptSubmit':
        AWAIT handlePrompt(input)
      CASE 'postToolUse':
        AWAIT handleObserve(input)
      CASE 'stop':
        AWAIT handleSummarize(input)
      DEFAULT:
        LOG stderr "[kiro-learn] unrecognized hook: {input.hook_event_name}"
    END SWITCH

  CATCH error
    LOG stderr "[kiro-learn] unexpected error: {error.message}"
  END TRY

  // Always exit 0 — handled by the caller (installer bin.ts)
END
```

**Notes:**
- `readStdin()` reads all of stdin synchronously. In Node this is `fs.readFileSync('/dev/stdin', 'utf8')` or equivalent buffered read. The shim is a short-lived process; there is no benefit to streaming.
- The top-level try/catch is the "never crash the agent" guarantee. Any unhandled error is logged and swallowed.

### Algorithm: handleSpawn()

```pascal
ALGORITHM handleSpawn(input)
INPUT: input ∈ AgentSpawnInput

BEGIN
  config ← loadConfig()
  sessionId ← createSession(input.cwd)

  body ← { type: 'text', content: 'session started' }

  event ← buildEvent({
    kind: 'note',
    body: body,
    sessionId: sessionId,
    cwd: input.cwd,
  })

  AWAIT postEvent(event, { retrieve: false }, config)

  process.stdout.write('kiro-learn session ' + sessionId + '\n')
END
```

### Algorithm: handlePrompt()

```pascal
ALGORITHM handlePrompt(input)
INPUT: input ∈ UserPromptSubmitInput

BEGIN
  config ← loadConfig()
  sessionId ← readSession(input.cwd)

  promptText ← input.prompt ?? ''
  body ← { type: 'text', content: promptText }
  body ← truncateBody(body, config.maxBodyBytes)

  event ← buildEvent({
    kind: 'prompt',
    body: body,
    sessionId: sessionId,
    cwd: input.cwd,
  })

  response ← AWAIT postEvent(event, { retrieve: true }, config)

  IF response ≠ null
    AND response.retrieval ≠ undefined
    AND response.retrieval.context ≠ ''
  THEN
    process.stdout.write(response.retrieval.context)
  END IF
END
```

### Algorithm: handleObserve()

```pascal
ALGORITHM handleObserve(input)
INPUT: input ∈ PostToolUseInput

BEGIN
  config ← loadConfig()
  sessionId ← readSession(input.cwd)

  data ← {
    tool_name: input.tool_name ?? 'unknown',
    tool_input: input.tool_input ?? {},
    tool_response: input.tool_response ?? {},
  }
  body ← { type: 'json', data: data }
  body ← truncateBody(body, config.maxBodyBytes)

  event ← buildEvent({
    kind: 'tool_use',
    body: body,
    sessionId: sessionId,
    cwd: input.cwd,
  })

  AWAIT postEvent(event, { retrieve: false }, config)
  // No stdout output
END
```

### Algorithm: handleSummarize()

```pascal
ALGORITHM handleSummarize(input)
INPUT: input ∈ StopInput

BEGIN
  config ← loadConfig()
  sessionId ← readSession(input.cwd)

  responseText ← input.assistant_response ?? ''
  body ← { type: 'text', content: responseText }
  body ← truncateBody(body, config.maxBodyBytes)

  event ← buildEvent({
    kind: 'session_summary',
    body: body,
    sessionId: sessionId,
    cwd: input.cwd,
  })

  AWAIT postEvent(event, { retrieve: false }, config)
  // No stdout output
END
```

### Algorithm: buildEvent()

```pascal
ALGORITHM buildEvent(params)
INPUT: params ∈ EventBuildParams
OUTPUT: KiroMemEvent

BEGIN
  resolvedCwd ← fs.realpathSync(params.cwd)
  projectId ← sha256hex(resolvedCwd)
  actorId ← os.userInfo().username
  namespace ← '/actor/' + actorId + '/project/' + projectId + '/'

  RETURN {
    event_id: ulid(),
    session_id: params.sessionId,
    actor_id: actorId,
    namespace: namespace,
    schema_version: 1,
    kind: params.kind,
    body: params.body,
    valid_time: new Date().toISOString(),
    source: {
      surface: 'kiro-cli',
      version: PACKAGE_VERSION,
      client_id: os.hostname(),
    },
    parent_event_id: params.parentEventId,
  }
END
```

**Notes:**
- `PACKAGE_VERSION` is a build-time constant or read from the installed package's version. The shim runs from `~/.kiro-learn/lib/`, so the version is baked in at install time.
- `ulid()` comes from the `ulidx` package. It produces monotonic, timestamp-ordered ULIDs.
- `os.hostname()` is used for `client_id`. It is stable across invocations on the same machine, which is all v1 needs.
- `parent_event_id` is omitted from the output when `undefined` — Zod's `.optional()` handles this correctly.

### Algorithm: truncateBody()

```pascal
ALGORITHM truncateBody(body, maxBytes)
INPUT: body ∈ EventBody, maxBytes ∈ number
OUTPUT: EventBody (possibly truncated)

CONST MARKER = ' [truncated by kiro-learn]'

BEGIN
  serialized ← JSON.stringify(body)
  IF byteLength(serialized) <= maxBytes THEN
    RETURN body  // no truncation needed
  END IF

  SWITCH body.type
    CASE 'text':
      content ← body.content
      // Iterative trim: remove 10% each pass until under budget
      WHILE byteLength(JSON.stringify({ type: 'text', content })) > maxBytes DO
        content ← content.substring(0, floor(content.length * 0.9))
      END WHILE
      RETURN { type: 'text', content: content + MARKER }

    CASE 'message':
      // Truncate the last turn's content (most likely to be large)
      turns ← deep copy of body.turns
      lastTurn ← turns[turns.length - 1]
      WHILE byteLength(JSON.stringify({ type: 'message', turns })) > maxBytes DO
        lastTurn.content ← lastTurn.content.substring(0, floor(lastTurn.content.length * 0.9))
      END WHILE
      lastTurn.content ← lastTurn.content + MARKER
      RETURN { type: 'message', turns }

    CASE 'json':
      data ← structuredClone(body.data)
      // For tool_use: truncate tool_response.result first (largest field)
      IF typeof data.tool_response?.result === 'string' THEN
        WHILE byteLength(JSON.stringify({ type: 'json', data })) > maxBytes DO
          data.tool_response.result ← data.tool_response.result.substring(0, floor(data.tool_response.result.length * 0.9))
        END WHILE
        data.tool_response.result ← data.tool_response.result + MARKER
      ELSE
        // Fallback: stringify the whole data object, truncate as string
        str ← JSON.stringify(data)
        WHILE byteLength(JSON.stringify({ type: 'json', data: str })) > maxBytes DO
          str ← str.substring(0, floor(str.length * 0.9))
        END WHILE
        data ← { _truncated: str + MARKER }
      END IF
      RETURN { type: 'json', data }
  END SWITCH
END
```

**Notes:**
- The iterative 10% trim converges quickly. For a 1 MiB body that needs to fit in 512 KiB, it takes ~7 iterations. Each iteration is a `JSON.stringify` + `Buffer.byteLength` — fast for this size.
- `byteLength` uses `Buffer.byteLength(str, 'utf8')` to count actual bytes, not JS string length (which counts UTF-16 code units).
- The marker is appended after the trim loop, so the final size may slightly exceed `maxBytes` by the marker length. This is acceptable — the marker is 26 bytes, and the collector's 2 MiB limit has ample headroom over the shim's 512 KiB cap.

### Algorithm: postEvent()

```pascal
ALGORITHM postEvent(event, opts, config)
INPUT: event ∈ KiroMemEvent, opts ∈ PostEventOptions, config ∈ ShimConfig
OUTPUT: EventIngestResponse | null

BEGIN
  path ← '/v1/events'
  IF opts.retrieve THEN
    path ← path + '?retrieve=true'
  END IF

  payload ← JSON.stringify(event)

  TRY
    response ← AWAIT httpPost({
      hostname: config.collectorHost,
      port: config.collectorPort,
      path: path,
      headers: { 'Content-Type': 'application/json' },
      timeout: config.timeoutMs,
      body: payload,
    })

    IF response.statusCode < 200 OR response.statusCode >= 300 THEN
      LOG stderr "[kiro-learn] collector returned {response.statusCode}"
      RETURN null
    END IF

    RETURN JSON.parse(response.body)
  CATCH error
    IF error.code = 'ECONNREFUSED' THEN
      LOG stderr "[kiro-learn] collector not reachable (is it running?)"
    ELSE IF error.code = 'ETIMEDOUT' OR error is timeout THEN
      LOG stderr "[kiro-learn] collector request timed out"
    ELSE
      LOG stderr "[kiro-learn] transport error: {error.message}"
    END IF
    RETURN null
  END TRY
END
```

**Notes:**
- Uses `node:http.request` directly. The request is a single `write` + `end` — no streaming needed for payloads under 512 KiB.
- The timeout is set via `http.request`'s `timeout` option, which fires on socket inactivity. An `AbortController` with `setTimeout` provides the hard deadline.

### Algorithm: sessionFilePath()

```pascal
ALGORITHM sessionFilePath(cwd)
INPUT: cwd ∈ string
OUTPUT: string (absolute path to session file)

BEGIN
  resolved ← fs.realpathSync(cwd)
  hash ← md5hex(resolved)
  prefix ← hash.substring(0, 16)
  RETURN '/tmp/kiro-learn-session-' + prefix
END
```

### Algorithm: loadConfig()

```pascal
ALGORITHM loadConfig()
OUTPUT: ShimConfig

BEGIN
  defaults ← {
    collectorHost: '127.0.0.1',
    collectorPort: 21100,
    timeoutMs: 2000,
    maxBodyBytes: 524288,
  }

  TRY
    raw ← fs.readFileSync(homedir + '/.kiro-learn/settings.json', 'utf8')
    settings ← JSON.parse(raw)

    RETURN {
      collectorHost: settings.collector?.host ?? defaults.collectorHost,
      collectorPort: settings.collector?.port ?? defaults.collectorPort,
      timeoutMs: settings.shim?.timeoutMs ?? defaults.timeoutMs,
      maxBodyBytes: defaults.maxBodyBytes,  // not user-configurable in v1
    }
  CATCH
    RETURN defaults
  END TRY
END
```

## Data Models

### Hook Input (from Kiro, via stdin)

The shim does not validate hook input with Zod — it is a best-effort parser. Missing fields get defaults, unexpected fields are ignored. The shim never fails on malformed input; it degrades gracefully.

```typescript
// Base shape (all hooks)
{ hook_event_name: string; cwd: string }

// agentSpawn — no extra fields
{ hook_event_name: 'agentSpawn'; cwd: string }

// userPromptSubmit
{ hook_event_name: 'userPromptSubmit'; cwd: string; prompt?: string }

// postToolUse
{
  hook_event_name: 'postToolUse';
  cwd: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: { success?: boolean; result?: unknown };
}

// stop
{ hook_event_name: 'stop'; cwd: string; assistant_response?: string }
```

### Settings file (`~/.kiro-learn/settings.json`)

```jsonc
{
  "collector": {
    "host": "127.0.0.1",  // default
    "port": 21100          // default
  },
  "shim": {
    "timeoutMs": 2000      // default
  }
}
```

The shim reads this file synchronously on each invocation. Missing keys use defaults. The file is optional.

### Agent configuration (`~/.kiro/agents/kiro-learn.json`)

This file is written by the installer, not the shim. Included here for reference — it defines the hooks that invoke the shim.

```jsonc
{
  "hooks": {
    "agentSpawn": [
      { "command": "kiro-learn spawn" }
    ],
    "userPromptSubmit": [
      { "command": "kiro-learn prompt" }
    ],
    "postToolUse": [
      { "command": "kiro-learn observe", "matcher": "*" }
    ],
    "stop": [
      { "command": "kiro-learn summarize" }
    ]
  }
}
```

### Constructed event examples

**agentSpawn → note event:**
```json
{
  "event_id": "01JF8ZS4Y0EXAMPLE00000000",
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "actor_id": "bgeck",
  "namespace": "/actor/bgeck/project/e3b0c44298fc1c14.../",
  "schema_version": 1,
  "kind": "note",
  "body": { "type": "text", "content": "session started" },
  "valid_time": "2026-04-24T20:00:00.000Z",
  "source": { "surface": "kiro-cli", "version": "0.3.0", "client_id": "bgeck-mbp" }
}
```

**userPromptSubmit → prompt event:**
```json
{
  "event_id": "01JF8ZS4Y1EXAMPLE00000000",
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "actor_id": "bgeck",
  "namespace": "/actor/bgeck/project/e3b0c44298fc1c14.../",
  "schema_version": 1,
  "kind": "prompt",
  "body": { "type": "text", "content": "fix the login bug in auth.ts" },
  "valid_time": "2026-04-24T20:00:01.000Z",
  "source": { "surface": "kiro-cli", "version": "0.3.0", "client_id": "bgeck-mbp" }
}
```

**postToolUse → tool_use event:**
```json
{
  "event_id": "01JF8ZS4Y2EXAMPLE00000000",
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "actor_id": "bgeck",
  "namespace": "/actor/bgeck/project/e3b0c44298fc1c14.../",
  "schema_version": 1,
  "kind": "tool_use",
  "body": {
    "type": "json",
    "data": {
      "tool_name": "fs_write",
      "tool_input": { "path": "/Users/bgeck/workspace/project/src/auth.ts" },
      "tool_response": { "success": true, "result": "File written successfully" }
    }
  },
  "valid_time": "2026-04-24T20:00:02.000Z",
  "source": { "surface": "kiro-cli", "version": "0.3.0", "client_id": "bgeck-mbp" }
}
```

**stop → session_summary event:**
```json
{
  "event_id": "01JF8ZS4Y3EXAMPLE00000000",
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "actor_id": "bgeck",
  "namespace": "/actor/bgeck/project/e3b0c44298fc1c14.../",
  "schema_version": 1,
  "kind": "session_summary",
  "body": { "type": "text", "content": "Fixed the login bug by updating the token validation..." },
  "valid_time": "2026-04-24T20:00:30.000Z",
  "source": { "surface": "kiro-cli", "version": "0.3.0", "client_id": "bgeck-mbp" }
}
```

## Correctness Properties

### Property 1: Session continuity

*For any* sequence of hook invocations from the same `cwd` starting with `agentSpawn`, all subsequent hooks SHALL use the same `session_id` as the spawn event. The session ID read from the session file SHALL equal the session ID written by the most recent `agentSpawn` for that `cwd`.

**Validates: Requirements 2.1, 2.2, 2.3, 2.5**

### Property 2: Namespace determinism

*For any* two events constructed from the same `cwd` (after symlink resolution), the `namespace` field SHALL be identical. Conversely, for any two events from different resolved `cwd` paths, the `namespace` field SHALL differ (with overwhelming probability, given SHA-256).

**Validates: Requirements 3.4, 8.1, 8.2, 8.3, 8.4**

### Property 3: Event schema compliance

*For any* hook input that the shim processes successfully, the constructed `KiroMemEvent` SHALL pass `parseEvent` validation. The shim never produces an event that the collector would reject on schema grounds.

**Validates: Requirements 3.1–3.9, 4.1–4.5**

### Property 4: Body size bound

*For any* hook input, the serialized event body after `truncateBody` SHALL not exceed the configured `maxBodyBytes` limit (plus the truncation marker length). `Buffer.byteLength(JSON.stringify(event.body), 'utf8')` SHALL be ≤ `maxBodyBytes + 26` (marker length).

**Validates: Requirements 10.1, 10.2, 10.3, 10.4**

### Property 5: Exit code invariant

*For any* hook input (valid, malformed, empty, or adversarial), the shim process SHALL exit with code 0. No input can cause a non-zero exit.

**Validates: Requirements 7.1, 7.2, 7.3**

### Property 6: Stdout isolation

*For any* hook invocation, stdout SHALL contain only the intended output (retrieval context for `userPromptSubmit`, session ID line for `agentSpawn`, nothing for others). No diagnostic messages, warnings, or error text SHALL appear on stdout.

**Validates: Requirements 6.1–6.5**

### Property 7: Truncation preserves body type

*For any* event body, `truncateBody(body, limit).type` SHALL equal `body.type`. Truncation never changes the body variant.

**Validates: Requirements 10.2, 10.3, 10.4**

## Error Handling

### Error: Empty stdin

**Condition.** Stdin is empty (EOF immediately).
**Behavior.** Return silently, exit 0. This can happen if Kiro invokes the hook with no input.
**Recovery.** None needed.

### Error: Invalid JSON on stdin

**Condition.** `JSON.parse` throws `SyntaxError`.
**Behavior.** Log `[kiro-learn] failed to parse stdin JSON` to stderr, exit 0.
**Recovery.** Kiro runtime issue — not actionable by the shim.

### Error: Missing cwd

**Condition.** Parsed JSON has no `cwd` field.
**Behavior.** Log `[kiro-learn] missing cwd in hook input` to stderr, exit 0.
**Recovery.** Kiro runtime issue.

### Error: Unrecognized hook type

**Condition.** `hook_event_name` is not one of the four expected values.
**Behavior.** Log `[kiro-learn] unrecognized hook: <name>` to stderr, exit 0.
**Recovery.** None — the shim only handles registered hooks.

### Error: Session file missing (non-spawn hook)

**Condition.** A non-spawn hook fires but the session file does not exist.
**Behavior.** Generate a fallback UUID, write it to the session file, continue. No stderr output (this is a normal edge case on first use or after `/tmp` cleanup).
**Recovery.** Automatic.

### Error: Collector unreachable

**Condition.** HTTP POST fails with `ECONNREFUSED`, `ETIMEDOUT`, or similar.
**Behavior.** Log `[kiro-learn] collector not reachable (is it running?)` to stderr, exit 0.
**Recovery.** User starts the collector via `kiro-learn start`.

### Error: Collector returns non-2xx

**Condition.** HTTP response status is not in 200–299 range.
**Behavior.** Log `[kiro-learn] collector returned <status>` to stderr, exit 0.
**Recovery.** Depends on status — 400 means malformed event (shim bug), 500 means collector bug.

### Error: Collector response not parseable

**Condition.** Response body is not valid JSON.
**Behavior.** Log `[kiro-learn] failed to parse collector response` to stderr, exit 0. No retrieval context is injected.
**Recovery.** Collector bug.

### Error: Total execution timeout

**Condition.** The shim has been running for more than 3 seconds.
**Behavior.** Abort any in-flight HTTP request, exit 0.
**Recovery.** Automatic. The event is lost for this invocation.

### Error: cwd does not exist or is not resolvable

**Condition.** `fs.realpathSync(cwd)` throws because the path does not exist.
**Behavior.** Log `[kiro-learn] cannot resolve cwd: <cwd>` to stderr, exit 0.
**Recovery.** Kiro runtime issue — the project directory was deleted or moved.

## Dependencies

### New production dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `ulidx` | ULID generation for `event_id` | ~2 KB, ESM-native, monotonic |

### Existing Node.js built-ins used

| Module | Purpose |
|--------|---------|
| `node:http` | HTTP POST to collector |
| `node:crypto` | `createHash('md5')` for session file path, `createHash('sha256')` for project ID, `randomUUID()` for session ID |
| `node:fs` | Session file read/write, config file read, `realpathSync` |
| `node:os` | `userInfo().username` for actor ID, `hostname()` for client ID |

### No new dev dependencies

The existing `vitest` and `fast-check` are sufficient for testing.
