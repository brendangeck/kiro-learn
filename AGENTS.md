# kiro-learn

Continuous learning for Kiro agent sessions on AWS. Passively captures tool-use events, extracts them into structured memory records via LLM, and injects relevant prior context into future sessions. Aligned with [Amazon Bedrock AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html) vocabulary so a future migration is a field-mapping exercise.

## Quick Reference

```bash
npm run build          # tsc -p tsconfig.build.json → dist/
npm run typecheck      # tsc --noEmit (strict mode, exactOptionalPropertyTypes)
npm run test           # vitest run — unit tests only (test/unit/)
npm run test:integ     # vitest run — integration tests (test/integ/), needs kiro-cli
npm run test:all       # both suites sequentially
npm run lint           # eslint
npm run format:check   # prettier --check
```

**Node ≥ 22 required.** ESM-only (`"type": "module"`). All imports use explicit `.js` extensions.

## Architecture

```text
Kiro CLI hooks → Shim (stdin JSON → Event → POST) → Collector daemon → Storage
                   ↑                                      │
                   └── stdout (retrieval context) ←───────┘
```

Three layers, strict dependency direction:

| Layer | Location | What it does |
|---|---|---|
| **Shim** | `src/shim/` | Reads hook stdin, builds `KiroMemEvent`, POSTs to collector, writes retrieval context to stdout. Exits 0 always. |
| **Collector** | `src/collector/` | HTTP daemon on `127.0.0.1:21100`. Pipeline: dedup → privacy scrub → storage → async extraction via ACP. Retrieval: FTS5 search with latency budget. |
| **Installer** | `src/installer/` | CLI (`init`/`start`/`stop`/`status`/`uninstall`). Bootstraps `~/.kiro-learn/`, writes agent configs, manages daemon. |

Shared types live in `src/types/`. The package entry point (`src/index.ts`) re-exports only the public API types.

## Source Layout

```text
src/
  index.ts                          # package entry — re-exports public types only
  types/
    schemas.ts                      # Zod schemas: EventSchema, MemoryRecordSchema, parsers
    index.ts                        # re-exports + StorageBackend interface + SearchParams
  collector/
    index.ts                        # startCollector() — the ONLY file that imports from storage/sqlite/
    receiver/index.ts               # node:http server, POST /v1/events, GET /healthz
    pipeline/
      index.ts                      # dedup, privacy scrub, extraction stage, pipeline composition
      acp-client.ts                 # ACP SDK wrapper — spawns kiro-cli acp, manages sessions
      xml-framer.ts                 # Event → <tool_observation> XML
      xml-parser.ts                 # <memory_record> XML → RawMemoryFields
    query/index.ts                  # thin pass-through to storage.searchMemoryRecords
    retrieval/index.ts              # assembles context string from query results within latency budget
    storage/
      index.ts                      # re-exports StorageBackend interface
      sqlite/
        index.ts                    # openSqliteStorage() — the concrete backend
        statements.ts               # prepared SQL statements
        fts5.ts                     # FTS5 query sanitization
        migrations/                 # ordered DDL migrations (0001_init, 0002_xml_extraction_fields)
  shim/
    shared/index.ts                 # loadConfig, session mgmt, buildEvent, truncateBody, postEvent
    cli-agent/index.ts              # main() — stdin parse, hook dispatch, stdout output
  installer/
    bin.ts                          # CLI entry point — argv parsing, command dispatch
    index.ts                        # all command implementations + helpers
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
- **`src/shim/`** must NOT import from `src/collector/` or `src/installer/`. The shim is a standalone HTTP client.
- **`src/shim/shared/`** must NOT import from `src/shim/cli-agent/`. Dependency direction is `cli-agent → shared`, never reverse.
- **`src/installer/`** must NOT import from `src/shim/`.
- **`src/collector/storage/`** must NOT contain the string `<private>`. Privacy scrubbing is the pipeline's job, not storage's.
- **XML pipeline modules** (`acp-client.ts`, `xml-framer.ts`, `xml-parser.ts`) must NOT import from `src/collector/storage/`.

Guard test files: `test/unit/no-sqlite-in-pipeline.test.ts`, `test/unit/no-collector-in-shim.test.ts`, `test/unit/no-shim-in-installer.test.ts`, `test/unit/no-private-scrub.test.ts`, `test/unit/no-storage-in-xml-modules.test.ts`.

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

### MemoryRecord schema

- `record_id`: `mr_` prefix + ULID (`/^mr_[0-9A-HJKMNP-TV-Z]{26}$/`)
- `title`: 1–200 chars. `summary`: 1–4000 chars.
- `source_event_ids`: non-empty array of ULIDs
- `concepts`: array of strings (1–100 chars each)
- `files_touched`: array of strings (1–500 chars each)
- `observation_type`: one of `tool_use`, `decision`, `error`, `discovery`, `pattern`

### SQLite storage

- Two migrations: `0001_init` (tables + indexes + FTS5) and `0002_xml_extraction_fields` (added `concepts_json`, `files_touched_json`, `observation_type` columns).
- Tables are `STRICT`. FTS5 uses `porter unicode61 remove_diacritics 2` tokenizer.
- `putEvent` uses `INSERT OR IGNORE` for idempotency. `putMemoryRecord` rejects on PK collision.
- FTS5 queries are sanitized (quoted as phrase, `"` doubled). If FTS5 still rejects the query, falls back to `LIKE`-based search. This is intentional — availability over ranking quality.
- `transaction_time` is stamped by the storage layer on insert, not by the client.

### Extraction pipeline

- Uses `kiro-cli acp --agent kiro-learn-compressor` via the `@agentclientprotocol/sdk` (pinned at exact version `0.20.0`).
- Events are framed as `<tool_observation>` XML, responses parsed as `<memory_record>` XML blocks.
- Circuit breaker: retries up to 3 times on garbage responses (no `<memory_record>` or `<skip>` in output).
- Concurrency limit: 2 concurrent ACP sessions by default, FIFO queue depth 100.
- Per-extraction timeout: 30 seconds.
- Extraction is async — it runs after the ingest response is returned to the shim. A failed extraction does not lose the event; only the memory record is missing.

### Shim behavior

- Reads stdin JSON from Kiro hooks. Dispatches on `hook_event_name`: `agentSpawn`, `userPromptSubmit`, `postToolUse`, `stop`.
- Session ID stored at `/tmp/kiro-learn-session-<hash>` where hash = first 16 hex chars of MD5 of resolved cwd.
- `project_id` = hex SHA-256 of `fs.realpathSync(cwd)`. Namespace = `/actor/<username>/project/<project_id>/`.
- Body truncation at 512 KiB. For JSON bodies, trims `tool_response.result` first.
- `os.userInfo()` can throw — there's a guard with fallback to `'unknown'`.
- **Exits 0 always.** Every hook command also appends `|| true`. Never blocks the agent.

### Installer / agent config

- Agent configs are seeded from `kiro_default` via `kiro-cli agent create --from kiro_default --directory <dir> kiro-learn` with `EDITOR=true`. Then kiro-learn's `name`, `description`, and four hook triggers are merged on top. Non-owned hooks (e.g. `preToolUse`) and all other fields (`tools`, `prompt`, `mcpServers`) are preserved from the seed.
- If seeding fails, falls back to a minimal hooks-only config + stderr warning. Install still succeeds.
- The compressor agent (`kiro-learn-compressor.json`) is hand-authored — it is NOT seeded from `kiro_default`. It has zero tools and an XML extraction prompt.
- Scope detection walks from cwd upward looking for 15 project markers. Nearest marker wins. Walk stops before `$HOME`.
- `--global-only`, `--yes`/`-y`, `--no-set-default`, `--keep-data` flags exist.

### Privacy

- `<private>...</private>` tags in event bodies are stripped by the pipeline's privacy scrub stage and replaced with `[REDACTED]`.
- Handles nested tags (outermost pair wins) and unclosed tags (span extends to end of string).
- Scrub is applied centrally in the pipeline before storage and extraction. The shim doesn't scrub. Storage doesn't scrub.

## Test Structure

```text
test/
  helpers/
    arbitrary.ts          # fast-check generators for Event, MemoryRecord, etc.
    fixtures.ts           # shared test fixtures
  unit/                   # 68 test files — run with `npm run test`
    *.test.ts             # example-based unit tests
    *.property.test.ts    # property-based tests (fast-check)
  integ/                  # 2 test files — run with `npm run test:integ`
    extraction-pipeline.test.ts    # real kiro-cli ACP extraction
    default-equivalent-agent.test.ts  # real kiro-cli agent create
```

Integration tests gate on `kiro-cli` availability and skip gracefully when it's absent. They need Bedrock credentials for the extraction test.

Property-based tests use `fast-check`. Generators live in `test/helpers/arbitrary.ts`. When adding new types or modifying schemas, update the generators there.

## Runtime Dependencies

| Package | Why |
|---|---|
| `better-sqlite3` ^12 | SQLite storage backend |
| `zod` ^3.23 | Schema validation for Event and MemoryRecord |
| `ulidx` ^2.4 | ULID generation for event_id and record_id |
| `@agentclientprotocol/sdk` 0.20.0 (pinned) | ACP protocol client for kiro-cli acp communication |

No third-party LLM SDKs. All AI work goes through `kiro-cli` → Amazon Bedrock.

## Specs

Design documents live in `.kiro/specs/`. Each spec has `requirements.md`, `design.md`, and `tasks.md`. All six specs are complete:

1. `event-schema-and-storage/` — types, Zod validators, StorageBackend interface, SQLite + FTS5
2. `collector-pipeline/` — HTTP receiver, pipeline stages, query, retrieval, daemon wiring
3. `shim/` — CLI agent hook adapter, session management, event building, transport
4. `installer/` — CLI commands, scope detection, payload deployment, agent configs, daemon lifecycle
5. `xml-extraction-pipeline/` — ACP client, XML framer/parser, extraction stage rewrite, schema extension
6. `default-equivalent-agent/` — seed-then-merge flow for inheriting kiro_default

## Milestones

### v0 — Local baseline (current, feature-complete)

Kiro CLI hooks, local collector daemon, SQLite + FTS5 lexical search, XML extraction via ACP, seed-then-merge agent configs, CLI installer. Everything runs on a single machine with no cloud dependency beyond `kiro-cli` → Bedrock for extraction.

### v1 — Visualizer, IDE support, hardened testing

- **Viewer UI** — browse events, memory records, and retrieval results locally
- **Kiro IDE hook shim** — `.kiro/hooks/*.kiro.hook` adapter so memory works in the IDE, not just `kiro-cli`
- **MCP tool wrappers** — expose query/retrieval as MCP tools for agents that prefer pull-based retrieval
- **Extensive test hardening** — end-to-end integration tests, chaos/fault-injection tests, performance benchmarks for the ingest and retrieval paths

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
