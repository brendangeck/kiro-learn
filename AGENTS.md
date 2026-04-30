# kiro-learn

Continuous learning for Kiro agent sessions on AWS. Passively captures tool-use events, extracts them into structured memory records via LLM, and injects relevant prior context into future sessions. Aligned with [Amazon Bedrock AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html) vocabulary so a future migration is a field-mapping exercise.

## Quick Reference

```bash
npm run build          # tsc -p tsconfig.build.json + vite build (UI) → dist/
npm run build:node     # tsc -p tsconfig.build.json → dist/ (no UI)
npm run build:ui       # vite build → dist/ui/
npm run typecheck      # tsc --noEmit against tsconfig.build.json + ui/tsconfig.json
npm run test           # vitest run — unit tests only (test/unit/)
npm run test:integ     # vitest run — integration tests (test/integ/), needs kiro-cli
npm run test:all       # both suites sequentially
npm run lint           # eslint
npm run format:check   # prettier --check
npm run dev:ui         # vite dev server for UI (proxies /healthz + /v1 to collector)
```

**Node ≥ 22 required.** ESM-only (`"type": "module"`). All imports use explicit `.js` extensions.

## Architecture

```text
Kiro CLI hooks → Shim (stdin JSON → Event → POST) ──→ Collector daemon → Storage
Kiro IDE hooks → IDE-Hook Shim (argv + env → Event → POST) ─┘         │
                   ↑                                                  │
                   └── stdout (retrieval context) ←───────────────────┘
                                                                      │
MCP Server (stdio JSON-RPC) ← search/save ← POST /v1/events ──────────┘
                                                                    │
Viewer UI (Cloudscape React) ← GET /v1/stats, /v1/events, /v1/memories
                               GET /ui/* (static assets) ───────────┘
```

Five layers, strict dependency direction:

| Layer | Location | What it does |
|---|---|---|
| **Shim (CLI)** | `src/shim/cli-agent/` | Reads Kiro CLI hook stdin, builds `KiroMemEvent`, POSTs to collector, writes retrieval context to stdout. Exits 0 always. |
| **Shim (IDE)** | `src/shim/ide-hook/` | Reads Kiro IDE hook event type from `argv[2]`, payload from `USER_PROMPT` env var. Same POST/stdout pattern. Exits 0 always. |
| **Collector** | `src/collector/` | HTTP daemon on `127.0.0.1:21100`. Pipeline: dedup → privacy scrub → storage → async extraction via ACP. Buffer: per-project NDJSON append-only files with batch extraction and compaction. Retrieval: FTS5 search with latency budget. Read API: stats, events, memories for the viewer UI. Static asset serving for the embedded UI bundle. |
| **MCP Server** | `src/mcp/` | Stdio-based MCP server exposing `search_memory`, `save_observation`, and `save_session_summary` tools. Derives namespace from `process.cwd()`, POSTs to the collector. |
| **Installer** | `src/installer/` | CLI (`init`/`start`/`stop`/`status`/`uninstall`). Bootstraps `~/.kiro-learn/`, writes agent configs, manages daemon, deploys UI assets. |

Shared types live in `src/types/`. The package entry point (`src/index.ts`) re-exports only the public API types. The viewer UI lives in `ui/` and builds to `dist/ui/`.

## Source Layout

```text
src/
  index.ts                          # package entry — re-exports public types only
  types/
    schemas.ts                      # Zod schemas: EventSchema, MemoryRecordSchema, parsers
    index.ts                        # re-exports + StorageBackend interface + SearchParams + StatsResult + ProjectInfo
  collector/
    index.ts                        # startCollector() — the ONLY file that imports from storage/sqlite/
    receiver/
      index.ts                      # node:http server, POST /v1/events, GET /healthz, read API endpoints
      static-handler.ts             # static asset serving for /ui/* with path-traversal protection + SPA fallback
    pipeline/
      index.ts                      # dedup, privacy scrub, extraction stage, pipeline composition
      acp-client.ts                 # ACP SDK wrapper — spawns kiro-cli acp, manages sessions
      xml-framer.ts                 # Event → <tool_observation> XML
      xml-parser.ts                 # <memory_record> XML → RawMemoryFields
    buffer/
      index.ts                      # barrel export for buffer subsystem
      types.ts                      # BufferEntry projection of KiroMemEvent, extractProjectId
      store.ts                      # createBufferStore() — NDJSON append-only file per project, flock-based locking
      watcher.ts                    # createBufferWatcher() — size/count triggers for extraction and compaction
      extraction.ts                 # createExtractionWorker() — batch XML framing → ACP → MemoryRecords
      compaction.ts                 # createCompactionWorker() — LLM-driven summarization + deterministic eviction
    query/index.ts                  # thin pass-through to storage.searchMemoryRecords
    retrieval/index.ts              # assembles context string from query results within latency budget
    storage/
      index.ts                      # re-exports StorageBackend interface
      sqlite/
        index.ts                    # openSqliteStorage() — the concrete backend
        statements.ts               # prepared SQL statements
        fts5.ts                     # FTS5 query sanitization
        migrations/                 # ordered DDL migrations (0001–0004)
  mcp/
    index.ts                        # MCP server entry — Server + StdioServerTransport, tool dispatch
    client.ts                       # HTTP client for collector (loadCollectorConfig, postMemory, searchMemories)
    namespace.ts                    # deriveNamespace() — same algorithm as shim (deliberate duplication)
    tools.ts                        # Tool handlers: handleSearchMemory, handleSaveObservation, handleSaveSessionSummary
  shim/
    shared/
      index.ts                      # loadConfig, session mgmt, buildEvent, truncateBody, postEvent
      project-root.ts               # detectProjectRoot() — upward walk for PROJECT_MARKERS, ceiling at $HOME
    cli-agent/index.ts              # main() — stdin parse, hook dispatch, stdout output
    ide-hook/index.ts               # main() — argv[2] event type, USER_PROMPT env, stdout output
  installer/
    bin.ts                          # CLI entry point — argv parsing, command dispatch
    index.ts                        # all command implementations + helpers

ui/
  index.html                        # Vite entry point
  vite.config.ts                    # Vite config — builds to dist/ui/, proxies /healthz + /v1 in dev
  tsconfig.json                     # Separate tsconfig for the UI (React JSX)
  src/
    main.tsx                        # React root mount
    App.tsx                         # Cloudscape AppLayout — health, stats, event tail, memory graph
    components/
      EventTail.tsx                 # Live event feed table
      MemoryGraph.tsx               # React Flow wrapper for the memory graph
      MemoryDetailPanel.tsx         # Slide-in detail panel for selected memory/concept
    graph/
      transform.ts                  # Pure transform: memories + projects → React Flow nodes/edges
      layout.ts                     # Dagre-based automatic graph layout
      theme.ts                      # Node color tokens (dark/light mode)
      ConceptNode.tsx               # Custom React Flow node for concepts
      MemoryNode.tsx                # Custom React Flow node for memory records
      ProjectNode.tsx               # Custom React Flow node for project hubs
      GraphLegend.tsx               # Legend overlay for node types
    types/
      api.ts                        # TypeScript types for collector read API responses
      health.ts                     # TypeScript types for /healthz response
```

## Key Conventions and Gotchas

### TypeScript strictness

- `exactOptionalPropertyTypes: true` — you cannot assign `undefined` to an optional field. Use `delete obj.field` or omit the key entirely.
- `noUncheckedIndexedAccess: true` — every `obj[key]` returns `T | undefined`. You must narrow before using.
- `verbatimModuleSyntax: true` — use `import type { ... }` for type-only imports. The linter enforces `@typescript-eslint/consistent-type-imports`.
- All imports use `.js` extensions (ESM resolution). Write `import { foo } from './bar.js'` even though the source file is `bar.ts`.

### Modularity boundaries (enforced by guard tests)

These are real tests that will fail CI if violated:

- **`src/collector/pipeline/`, `receiver/`, `retrieval/`, `query/`** must NOT import from `src/collector/storage/sqlite/`. Only `src/collector/index.ts` knows the concrete storage backend. Everything else gets `StorageBackend` via DI.
- **`src/collector/buffer/`** must NOT import from `src/collector/storage/sqlite/`. Buffer is storage-agnostic.
- **`src/collector/buffer/`** must NOT contain the string `<private>`. Privacy scrubbing is the pipeline's job.
- **`src/shim/`** must NOT import from `src/collector/` or `src/installer/`. The shim is a standalone HTTP client.
- **`src/shim/`** must NOT import from `src/collector/buffer/`. Buffer is collector-internal.
- **`src/shim/shared/`** must NOT import from `src/shim/cli-agent/` or `src/shim/ide-hook/`. Dependency direction is `cli-agent → shared` and `ide-hook → shared`, never reverse.
- **`src/shim/ide-hook/`** must NOT import from `src/shim/cli-agent/`. The two shims are siblings, not parent-child.
- **`src/installer/`** must NOT import from `src/shim/`.
- **`src/mcp/`** must NOT import from `src/collector/`, `src/shim/`, or `src/installer/`. It's a standalone MCP server that talks to the collector via HTTP.
- **`src/collector/storage/`** must NOT contain the string `<private>`. Privacy scrubbing is the pipeline's job, not storage's.
- **XML pipeline modules** (`acp-client.ts`, `xml-framer.ts`, `xml-parser.ts`) must NOT import from `src/collector/storage/`.
- **`ui/`** must NOT import from `src/`. The UI is a standalone Vite app.
- **`src/`** must NOT import from `ui/`. The backend has no UI dependency.

Guard test files: `test/unit/no-sqlite-in-pipeline.test.ts`, `test/unit/no-sqlite-in-buffer.test.ts`, `test/unit/no-collector-in-shim.test.ts`, `test/unit/no-buffer-in-shim.test.ts`, `test/unit/no-shim-in-installer.test.ts`, `test/unit/no-private-scrub.test.ts`, `test/unit/no-private-in-buffer.test.ts`, `test/unit/no-storage-in-xml-modules.test.ts`, `test/unit/no-cli-agent-in-ide-hook.test.ts`, `test/unit/no-ide-hook-in-shared.test.ts`, `test/unit/no-forbidden-imports-in-mcp.test.ts`, `test/unit/no-ui-in-src.test.ts`, `test/unit/no-src-in-ui.test.ts`.

### Event schema — the one-way door

The `EventSchema` in `src/types/schemas.ts` is the wire contract. Key validation rules:

- `event_id`: ULID, 26 chars, Crockford base32 (`/^[0-9A-HJKMNP-TV-Z]{26}$/`)
- `namespace`: must match `/^\/actor\/[^/]+\/project\/[^/]+\/$/` (trailing slash required)
- `schema_version`: literal `1` — no other value accepted
- `kind`: one of `prompt`, `tool_use`, `session_summary`, `note`
- `body`: discriminated union on `type` (`text`, `message`, `json`). Serialized size capped at 1 MiB.
- `valid_time`: ISO 8601 datetime with offset
- `content_hash`: optional, must match `/^sha256:[0-9a-f]{64}$/`
- `source.surface`: `'kiro-cli'` or `'kiro-ide'`
- `source.project_path`: optional, 1–2048 chars. The resolved absolute filesystem path the shim hashed to derive `project_id`. Carrier-only — no structural constraint. Always populated by current shims; absent on legacy events.

### MemoryRecord schema

- `record_id`: `mr_` prefix + ULID (`/^mr_[0-9A-HJKMNP-TV-Z]{26}$/`)
- `title`: 1–200 chars. `summary`: 1–4000 chars.
- `source_event_ids`: non-empty array of ULIDs
- `concepts`: array of strings (1–100 chars each)
- `files_touched`: array of strings (1–500 chars each)
- `observation_type`: one of `tool_use`, `decision`, `error`, `discovery`, `pattern`, `session_summary`

### SQLite storage

- Four migrations: `0001_init` (tables + indexes + FTS5), `0002_xml_extraction_fields` (added `concepts_json`, `files_touched_json`, `observation_type` columns), `0003_project_path` (added nullable `project_path` column + compound index on events), `0004_session_summary_type` (widened `observation_type` CHECK constraint to include `'session_summary'` via table rebuild).
- Tables are `STRICT`. FTS5 uses `porter unicode61 remove_diacritics 2` tokenizer.
- `putEvent` uses `INSERT OR IGNORE` for idempotency. `putMemoryRecord` rejects on PK collision.
- FTS5 queries are sanitized (quoted as phrase, `"` doubled). If FTS5 still rejects the query, falls back to `LIKE`-based search. This is intentional — availability over ranking quality.
- `transaction_time` is stamped by the storage layer on insert, not by the client.
- Read API methods: `getStats` (aggregate counts), `listProjects` (distinct namespaces with counts and project_path), `listMemoryRecords` (paginated, newest first), `listEvents` (last N, newest first).

### Extraction pipeline

- Uses `kiro-cli acp --agent kiro-learn-compressor` via the `@agentclientprotocol/sdk` (pinned at exact version `0.20.0`).
- Events are framed as `<tool_observation>` XML, responses parsed as `<memory_record>` XML blocks.
- Circuit breaker: retries up to 3 times on garbage responses (no `<memory_record>` or `<skip>` in output).
- Concurrency limit: 2 concurrent ACP sessions by default, FIFO queue depth 100.
- Per-extraction timeout: 30 seconds.
- Extraction is async — it runs after the ingest response is returned to the shim. A failed extraction does not lose the event; only the memory record is missing.

### Buffer pipeline

- Per-project append-only NDJSON files stored under `~/.kiro-learn/buffers/<project_id>.ndjson`.
- `BufferStore` handles append (with flock-based file locking), snapshot, size tracking, clear, and atomic replace.
- `BufferWatcher` monitors per-project buffer state and fires extraction/compaction triggers based on configurable byte-size and entry-count thresholds.
- `ExtractionWorker` reads a buffer snapshot, frames entries as batch XML, sends to ACP, parses memory records, stores them, and clears the buffer on success.
- `CompactionWorker` handles buffer overflow: sends existing memory records to ACP for LLM-driven summarization, applies deterministic eviction of oldest records, and replaces the buffer with compacted content.
- Buffer is wired into the collector pipeline after the privacy scrub stage. Events are projected to lightweight `BufferEntry` structs (dropping `schema_version`, `content_hash`, `parent_event_id`, `session_id`, full `source` block).

### MCP server

- Stdio-based MCP server using `@modelcontextprotocol/sdk`. Registered as `kiro-learn-memory`.
- Three tools: `search_memory` (query + optional limit), `save_observation` (structured observation with title, summary, observation_type, concepts, files_touched, facts), `save_session_summary` (structured session summary with request, investigated, learned, completed, next_steps, files_read, files_modified).
- Derives namespace from `process.cwd()` using the same algorithm as the shim (SHA-256 of `realpathSync(cwd)` + `os.userInfo().username`). This is a deliberate duplication — the MCP module cannot import from `src/shim/`.
- Loads collector config from `~/.kiro-learn/settings.json`. POSTs to the collector's HTTP API.
- Stdout is reserved for JSON-RPC; all errors go to stderr.

### Shim behavior

**CLI agent shim** (`src/shim/cli-agent/`):
- Reads stdin JSON from Kiro CLI hooks. Dispatches on `hook_event_name`: `agentSpawn`, `userPromptSubmit`, `postToolUse`, `stop`.

**IDE hook shim** (`src/shim/ide-hook/`):
- Reads event type from `process.argv[2]`, payload from `process.env.USER_PROMPT`, cwd from `process.cwd()`.
- Dispatches on event type: `promptSubmit` (builds prompt event, retrieves context to stdout), `postToolUse` (parses camelCase JSON, maps to snake_case tool_use event), `agentStop` (builds session_summary event, skips if empty).
- Sets `source.surface` to `'kiro-ide'` (vs `'kiro-cli'` for the CLI shim).

**Shared** (`src/shim/shared/`):
- `loadConfig`, `readSession`, `buildEvent`, `truncateBody`, `postEvent`.
- `detectProjectRoot()` in `project-root.ts`: walks upward from cwd looking for 15 `PROJECT_MARKERS`, stops at resolved `$HOME` as ceiling. Returns `{ projectRoot, projectPath, isGlobal }`. Populates `source.project_path` on every emitted event.
- Session ID stored at `/tmp/kiro-learn-session-<hash>` where hash = first 16 hex chars of MD5 of resolved cwd.
- `project_id` = hex SHA-256 of the detected project root (or `fs.realpathSync(cwd)` as fallback). Namespace = `/actor/<username>/project/<project_id>/`.
- Body truncation at 512 KiB. For JSON bodies, trims `tool_response.result` first.
- `os.userInfo()` can throw — there's a guard with fallback to `'unknown'`.
- **Both shims exit 0 always.** Every hook command also appends `|| true`. Never blocks the agent.

### Installer / agent config

- Agent configs are seeded from `kiro_default` via `kiro-cli agent create --from kiro_default --directory <dir> kiro-learn` with `EDITOR=true`. Then kiro-learn's `name`, `description`, and four hook triggers are merged on top. Non-owned hooks (e.g. `preToolUse`) and all other fields (`tools`, `prompt`, `mcpServers`) are preserved from the seed.
- If seeding fails, falls back to a minimal hooks-only config + stderr warning. Install still succeeds.
- The compressor agent (`kiro-learn-compressor.json`) is hand-authored — it is NOT seeded from `kiro_default`. It has zero tools and an XML extraction prompt.
- Scope detection walks from cwd upward looking for 15 project markers. Nearest marker wins. Walk stops before `$HOME`.
- `--global-only`, `--yes`/`-y`, `--no-set-default`, `--keep-data` flags exist.
- Installer deploys the built UI assets to `~/.kiro-learn/ui/`.

### Viewer UI

- Cloudscape Design System (React) single-page app built with Vite.
- Served by the collector daemon at `/ui/*` via the static asset handler in `src/collector/receiver/static-handler.ts`.
- Path-traversal protection (null byte check, decode + normalize, prefix check). SPA fallback for extensionless paths. Content-hash-aware caching (immutable for hashed assets, no-cache otherwise).
- Dashboard: health indicator, metric cards (total memories, events, projects, concepts), memory graph (React Flow + dagre layout), event tail table, memory detail panel.
- Three node types in the graph: project hubs (blue), concept nodes (green), memory nodes (pink). Edges: project→concept, memory→project, memory→concept.
- Polls `/healthz`, `/v1/stats`, `/v1/events?limit=50`, `/v1/memories?limit=500` every 10 seconds.
- Dark mode toggle persisted to localStorage.
- Dev mode: `npm run dev:ui` starts Vite on `127.0.0.1:5173` with proxy to collector at `:21100`.

### Privacy

- `<private>...</private>` tags in event bodies are stripped by the pipeline's privacy scrub stage and replaced with `[REDACTED]`.
- Handles nested tags (outermost pair wins) and unclosed tags (span extends to end of string).
- Scrub is applied centrally in the pipeline before storage, buffer, and extraction. The shim doesn't scrub. Storage doesn't scrub. Buffer doesn't scrub.

## Test Structure

```text
test/
  helpers/
    arbitrary.ts          # fast-check generators for Event, MemoryRecord, etc.
    fixtures.ts           # shared test fixtures
  unit/                   # 171 test files — run with `npm run test`
    *.test.ts             # example-based unit tests
    *.test.tsx            # React component tests (jsdom)
    *.property.test.ts    # property-based tests (fast-check)
  integ/                  # 3 test files — run with `npm run test:integ`
    extraction-pipeline.test.ts          # real kiro-cli ACP extraction
    buffer-extraction-pipeline.test.ts   # real kiro-cli ACP buffer extraction
    default-equivalent-agent.test.ts     # real kiro-cli agent create
```

Integration tests gate on `kiro-cli` availability and skip gracefully when it's absent. They need Bedrock credentials for the extraction tests.

Property-based tests use `fast-check`. Generators live in `test/helpers/arbitrary.ts`. When adding new types or modifying schemas, update the generators there.

Unit tests include `.tsx` files for React component smoke tests (using `@testing-library/react` + `jsdom`).

## Runtime Dependencies

| Package | Why |
|---|---|
| `better-sqlite3` ^12 | SQLite storage backend |
| `zod` ^3.23 | Schema validation for Event and MemoryRecord |
| `ulidx` ^2.4 | ULID generation for event_id and record_id |
| `@agentclientprotocol/sdk` 0.20.0 (pinned) | ACP protocol client for kiro-cli acp communication |
| `@modelcontextprotocol/sdk` 1.12.1 (pinned) | MCP server for search_memory / save_observation / save_session_summary tools |

No third-party LLM SDKs. All AI work goes through `kiro-cli` → Amazon Bedrock.

## Specs

Design documents live in `.kiro/specs/`. Each spec has `requirements.md`, `design.md`, and `tasks.md`. All fifteen specs are complete:

1. `event-schema-and-storage/` — types, Zod validators, StorageBackend interface, SQLite + FTS5
2. `collector-pipeline/` — HTTP receiver, pipeline stages, query, retrieval, daemon wiring
3. `shim-initial/` — CLI agent hook adapter, session management, event building, transport
4. `installer-initial/` — CLI commands, scope detection, payload deployment, agent configs, daemon lifecycle
5. `xml-extraction-pipeline/` — ACP client, XML framer/parser, extraction stage rewrite, schema extension
6. `default-equivalent-agent/` — seed-then-merge flow for inheriting kiro_default
7. `project-path-capture/` — project root detection, `source.project_path` field, migration 0003
8. `visualizer-scaffold/` — Vite + Cloudscape project scaffold, static asset handler, installer UI deploy
9. `visualizer-read-api/` — GET /v1/stats, /v1/events, /v1/memories endpoints, StorageBackend read methods
10. `visualizer-dashboard/` — metric cards, event tail, health indicator, dark mode
11. `visualizer-graph/` — React Flow memory graph, dagre layout, node types, detail panel
12. `kiro-ide-hook-shim/` — IDE hook adapter for `.kiro/hooks/*.kiro.hook`
13. `mcp-memory-server/` — MCP server with search_memory, save_observation, save_session_summary
14. `workspace-buffer-pipeline/` — per-project NDJSON buffers, extraction worker, watcher
15. `buffer-compaction-worker/` — LLM-driven compaction, deterministic eviction, buffer replace

## Milestones

> **Note on naming.** The `v0`, `v1`, `v2`, etc. labels below are **arbitrary milestone names** used for internal planning. They are **not** semantic version numbers of the published package and do not correspond to `0.x` / `1.0.0` / `2.0.0` releases on npm. The package itself is expected to remain on `0.x` for the indefinite future — breaking changes may occur on any minor bump. A semver `1.0.0` will only be cut once the public surface (event schema, storage format, installer layout, CLI flags) has been pressure-tested by real usage and is ready for a stability commitment.

### v0 — Local baseline (complete)

Kiro CLI hooks, local collector daemon, SQLite + FTS5 lexical search, XML extraction via ACP, seed-then-merge agent configs, CLI installer. Everything runs on a single machine with no cloud dependency beyond `kiro-cli` → Bedrock for extraction.

### v1 — Visualizer, IDE support, MCP, buffer pipeline (current, feature-complete)

- **Viewer UI** — Cloudscape React dashboard with metric cards, event tail, interactive memory graph (React Flow + dagre), memory detail panel, dark mode. Served by the collector at `/ui/*`.
- **Kiro IDE hook shim** — `src/shim/ide-hook/` adapter so memory works in the IDE via `.kiro/hooks/*.kiro.hook`, not just `kiro-cli`.
- **MCP tool wrappers** — `src/mcp/` exposes `search_memory`, `save_observation`, `save_session_summary` as MCP tools for agents that prefer pull-based retrieval.
- **Workspace buffer pipeline** — per-project NDJSON append-only buffers with batch extraction and LLM-driven compaction. Decouples event ingestion from extraction latency.
- **Project path capture** — shim detects project root via upward marker walk, populates `source.project_path` on events, migration 0003 adds indexed column.
- **Read API** — `GET /v1/stats`, `/v1/events`, `/v1/memories` endpoints for the viewer UI and external consumers.
- **Extensive test hardening** — 171 unit tests (example-based + property-based + React component), 3 integration tests.

### v2 — Hybrid search with local embeddings

Local implementation of the hybrid retrieval algorithm used by [Bedrock Knowledge Bases](https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html):

- **Embeddings** via Amazon Titan Text Embeddings V2 (through `kiro-cli`)
- **Local vector search** via `sqlite-vec` or a lightweight embedded vector index
- **Hybrid retrieval** — combine FTS5 lexical scores with semantic vector similarity and recency signals, then rerank. Same conceptual model as Bedrock KB's hybrid search so the algorithm is portable to the cloud path later.
- Bi-temporal query surface using the `valid_time` / `transaction_time` fields reserved since v0

### v3 — Remote KB sync with AWS cloud resources

- **Remote storage backend** — Aurora + pgvector or Bedrock AgentCore Memory as a drop-in replacement for local SQLite
- **Sync/fetch/pull** — local collector syncs memory records to a cloud-hosted knowledge base; retrieval can source from both local and remote stores
- **S3 cold archive** for old events
- IAM-scoped namespaces for access control on shared resources

### v4+ — Privacy hardening and team-level memory

- **Enhanced privacy protection** — configurable redaction policies beyond `<private>` tags, PII detection, audit logging for what was scrubbed and why
- **Team-level memory repo** — all memories push to a shared team-level repository (cloud KB or shared Aurora instance); individual developers can source context from the team repo alongside their own local memory
- **Namespace-based access control** — team members see shared project memory but not each other's private namespaces
- **Entity/edge extraction** — semantic graph strategy produces structured relationships between concepts, files, and decisions across team members' sessions
