# kiro-learn

Continuous learning for Kiro agent sessions on AWS. Inspired by and largely based on [claude-mem](https://github.com/thedotmack/claude-mem) by Alex Newman, rebuilt for the Kiro + AWS ecosystem.

kiro-learn seamlessly preserves context across Kiro sessions by passively capturing tool-use events, extracting them into long-term memory records, and injecting the relevant prior context into future sessions. The agent maintains continuity of knowledge about your projects across sessions, even after the session ends or reconnects.

## North Star

A local-first, AWS-native continuous learning layer for Kiro that follows the same conceptual model as [Amazon Bedrock AgentCore Memory](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory.html). One collector, one event schema, plug-in storage. Zero external API keys — all AI work goes through `kiro-cli` (Amazon Bedrock). Designed so the same system that runs on a developer's laptop can later run as a shared team service on AWS without schema changes — and so that a future migration to AgentCore Memory itself is a field-mapping exercise, not a rewrite.

## Architecture

```
┌─────────────────────────────┐
│         Kiro CLI            │
│   ~/.kiro/agents/*.json     │
│  hooks fire shim commands   │
└──────────────┬──────────────┘
               │
               │  POST /v1/events    (capture + optional enrichment)
               ▼
┌─────────────────────────────┐
│          Shim               │      thin per-client adapter
│   normalizes hook input     │      builds a canonical Event
│   → Event JSON              │      ships to collector
└──────────────┬──────────────┘      blocks briefly on enrichment
               │                     returns injected context to agent
               ▼
┌─────────────────────────────┐
│        Collector            │      local daemon, long-running
│                             │
│  receiver ──▶ pipeline      │      validate, dedup, scrub privacy
│                 │           │      apply memory strategy: extract
│                 ▼           │      memory records via kiro-cli
│             storage         │      enrich with prior context
│                 │           │
│                 ▼           │
│        enrichment/query     │      retrieve relevant memory records
└──────────────┬──────────────┘      for the live session
               │
               ▼
┌─────────────────────────────┐
│          Storage            │      pluggable backend
│   SQLite + FTS5  (v1)       │      zero-dep local
│   pgvector       (v4)       │      Aurora-compatible cloud path
│   AgentCore KB   (v4)       │      managed service
└─────────────────────────────┘
```

### The three layers

**Shim** — a tiny per-client adapter. In v1 this is a Kiro CLI agent hook shim only. Its job: read whatever the host surface gives it (env vars, stdin JSON), build a canonical `Event`, POST it to the collector, return the enrichment context back to the agent runtime. It owns no state, makes no decisions, exits 0 always, and spools to a local file if the collector is down.

**Collector** — a long-running local daemon. Receives events on an HTTP endpoint, runs them through a processor pipeline (dedup → privacy scrub → memory strategy extraction via `kiro-cli` → storage), and answers enrichment requests synchronously with a bounded latency budget. One canonical ingest endpoint, one schema version, one storage interface.

**Storage** — pluggable behind an interface. v1 ships SQLite + FTS5 for zero-dependency local use. Future backends include pgvector (matches Aurora exactly) and Amazon Bedrock AgentCore Memory (managed). No claim is made about the storage backend's topology beyond the interface contract.

## Vocabulary

kiro-learn uses [AgentCore Memory's vocabulary](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-terminology.html) directly. Keeping this aligned means a future migration to AgentCore Memory is a field-mapping exercise, not a rewrite.

| Term                | Meaning                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Event**           | The fundamental wire-level ingest unit. Immutable, timestamped, represents a discrete interaction (prompt, tool use, session boundary). Posted via `POST /v1/events`. Short-term memory. |
| **Memory record**   | A structured unit of long-term memory extracted from one or more events. Stored under a namespace. What gets retrieved and injected as context.                                          |
| **Session**         | A continuous interaction between a user and a Kiro agent, identified by `sessionId`. Groups all events from one agent run.                                                               |
| **Actor**           | The entity interacting with the agent — in v1 the developer, identified by `actorId`.                                                                                                    |
| **Namespace**       | Hierarchical path used to scope memory records. e.g. `/actor/{actorId}/project/{projectId}/`. Used for scoped retrieval and (in the future) IAM-scoped access.                           |
| **Memory strategy** | The configurable rule that determines how events become memory records — the extraction pipeline. v1 has one strategy: LLM summarization of tool-use observations.                       |

## The Event Schema (v1)

This is a [one-way-door](https://aws.amazon.com/blogs/enterprise-strategy/making-the-right-decisions/) decision. Designed to absorb future use cases without breaking changes: semantic graph extraction, bi-temporal reasoning, multi-client sources, team/shared memory, migration to AgentCore Memory itself. Draws directly from [AgentCore Memory's Event model](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-terminology.html) and OpenTelemetry's span/resource model.

```jsonc
// POST /v1/events
{
  // Identity
  "event_id": "01JF8ZS4Y0...", // ULID, client-generated, idempotency key
  "parent_event_id": "01JF8ZS4XR...", // optional: e.g. a tool_use inside a prompt turn
  "session_id": "kiro-1747...", // groups events from one agent session
  "actor_id": "alice", // who generated the event
  "namespace": "/actor/alice/project/<projectId>/",
  "schema_version": 1,

  // Content (discriminated union)
  "kind": "prompt | tool_use | session_summary | note",
  "body": {
    "type": "text | message | json",
    "content": "...", // or turns[], or data{}
  },

  // Temporal (bi-temporal reserved from day one)
  "valid_time": "2026-04-23T20:00:00Z", // when the interaction occurred
  // transaction_time: assigned by the collector on receipt

  // Provenance — who emitted this event
  "source": {
    "surface": "kiro-cli", // kiro-cli | kiro-ide (future)
    "version": "2.0.1",
    "client_id": "<install-uuid>",
  },

  // Optional: skip body parse on idempotent retry
  "content_hash": "sha256:...", // collector derives if omitted
}
```

**Key properties:**

- **Client only describes the event.** No pipeline hints, no extraction flags, no privacy flags, no resource attributes. The collector owns every processing decision (whether to extract, how to redact, which memory strategy to run). The shim just says _what happened_, _where it happened_, and _who did it_.
- **`event_id` is the idempotency key.** Shims retry safely; collector dedups.
- **`parent_event_id` captures causal structure.** A `tool_use` inside a prompt turn points to that prompt. It's the only structural edge captured at ingest time — any further semantic relationships between memory records are derived later by the memory strategy, not declared by the client.
- **`kind` + typed `body`** gives us room to add new event shapes without schema churn.
- **`valid_time` + collector-assigned `transaction_time`** = bi-temporal model. Reserved from day one; point-in-time queries come later.
- **`namespace`** matches AgentCore's namespacing model exactly, including the trailing-slash convention for prefix-safe IAM scoping in future multi-tenant deployments. This is the only scoping mechanism — no free-form tags, no `resource` block.

**Project identity — how `namespace` is resolved:**

The shim derives `project_id` from its own `cwd` at event-emission time. Kiro invokes hooks with the working directory set to the agent's project root — if the agent came from `<workspace>/.kiro/agents/kiro-learn.json`, cwd is that workspace; if from the global `~/.kiro/agents/kiro-learn.json` while the user ran `kiro-cli chat` in a workspace, cwd is still that workspace. The shim treats cwd as ground truth:

```
project_id = sha256(realpath(process.cwd()))
namespace  = `/actor/${actor_id}/project/${project_id}/`
```

No tree walk, no `.kiro/` discovery, no registration file. Project identity is a direct consequence of where the hook runs. Two events from the same session in the same workspace always agree, because they share cwd. If the user runs Kiro outside any project directory, the resulting namespace is still coherent — it just scopes to that directory's hash.

**The collector's response:**

```jsonc
// 202 Accepted (or 200 OK with enrichment)
{
  "event_id": "01JF...",
  "stored": true,
  "enrichment": {
    // present when shim requested sync enrichment
    "context": "Prior observations: ...",
    "records": ["mr_01J...", "mr_01J..."],
    "latency_ms": 47,
  },
}
```

## Key Concepts

**Capture.** Every hook fire produces one event. Shims are fire-and-retry-on-failure with local spool. Capture is eventually consistent and must never block the agent.

**Memory strategy (extraction).** The pipeline processor that turns raw events into memory records. In v1 this is a single strategy: an LLM (via `kiro-cli` → Amazon Bedrock) distills each event into a structured memory record with title, facts, concepts, files touched, and observation type. Extraction runs asynchronously after capture. Future versions add multiple strategies running in parallel (semantic summarization, entity extraction, procedural memory).

**Enrichment.** When a new `prompt` event arrives, the shim requests synchronous enrichment. The collector retrieves relevant memory records (v1: lexical FTS5 search; v2: hybrid with semantic vector search) and returns formatted context. The shim returns that context to the Kiro runtime, which injects it into the agent's context window before the model runs. This is how memory is _used_, not just stored. Enrichment has a hard latency budget (default 500ms); whatever we have at deadline is what we return.

**Privacy.** Events can carry `<private>...</private>` tags. The privacy processor strips tagged spans before anything reaches storage or LLM extraction. Applied centrally in the pipeline, not scattered per-client.

## Relationship to kiro-cli knowledge

`kiro-cli knowledge` and `kiro-learn` are independent systems. They are **not interoperable, not shared, and do not communicate**. They solve different problems.

**`kiro-cli knowledge`** is a user-curated, document-oriented knowledge base. You explicitly add files or directories to it, and the agent can query it mid-turn via the `knowledge` tool when the model decides the query is relevant. It is long-term reference material, scoped to a single Kiro agent, stored per-agent under the OS data directory (e.g., `~/Library/Application Support/kiro-cli/knowledge_bases/<agent_name>_<hash>/`), indexed with an HNSW vector graph over document chunks.

**`kiro-learn`** is a different primitive: passive, session-scoped memory of agent interactions. It captures events automatically when Kiro lifecycle hooks fire (prompt submit, tool use, session stop), extracts structured memory records continuously in the background, and injects relevant context into the next prompt _before the model runs_ — no tool call required. Its scope is the project (cwd at hook-execution time), not the agent. Storage lives under `~/.kiro-learn/`, separate from and unaware of the knowledge base storage.

|               | kiro-cli knowledge                                        | kiro-learn                                                   |
| ------------- | --------------------------------------------------------- | ---------------------------------------------------------- |
| **Unit**      | Document                                                  | Event / memory record                                      |
| **Ingest**    | User-triggered file add                                   | Passive hook capture                                       |
| **Trigger**   | Model tool-use during chat                                | Agent lifecycle hooks                                      |
| **Scope**     | Per-agent KB directory                                    | Per-project namespace (cwd-derived)                        |
| **Retrieval** | Agent calls tool mid-turn                                 | Synchronous enrichment at prompt-time, injected as context |
| **Use case**  | "Search this codebase I indexed"                          | "Remember what happened in past sessions on this project"  |
| **Storage**   | `~/Library/Application Support/kiro-cli/knowledge_bases/` | `~/.kiro-learn/`                                             |

**Explicit non-interop contract:**

- kiro-learn does **not** read from, write to, or call into `kiro-cli knowledge`.
- `kiro-cli knowledge` has no awareness of kiro-learn events or memory records.
- The two systems do not share storage, indexes, embeddings, or APIs.
- Events captured by kiro-learn are never indexed into a knowledge base. Files indexed into a knowledge base are never ingested as kiro-learn events.
- A user who uses both systems simultaneously will see them operate completely independently, each unaware of the other.

This is deliberate: the two primitives address complementary problems, and attempting to unify them would compromise both. If Kiro ever adds a native equivalent of kiro-learn, that becomes the migration target — not the knowledge tool.

## Distribution

kiro-learn ships as an npm package that bootstraps a local install under `~/.kiro-learn/`. The npm package is the delivery mechanism; the installed directory is the runtime.

### Install flow

```bash
npx kiro-learn@latest init
```

The `init` command:

1. Creates `~/.kiro-learn/` if missing.
2. Copies the package's compiled `lib/` (shim, collector, installer, types) into `~/.kiro-learn/lib/`.
3. Installs runtime dependencies (`better-sqlite3`, etc.) into `~/.kiro-learn/node_modules/` via a nested production install.
4. Writes `bin/` wrapper scripts (`shim`, `collector`, `kiro-learn`) that are shebang-executable Node entrypoints.
5. Writes the global CLI agent at `~/.kiro/agents/kiro-learn.json` (and, when a project is detected, `<projectRoot>/.kiro/agents/kiro-learn.json`). Each file is seeded from Kiro's built-in `kiro_default` agent via `kiro-cli agent create --from kiro_default` so the installed agent inherits whatever tools, prompt, and MCP servers `kiro-cli` ships today, then kiro-learn's four lifecycle hook triggers (`agentSpawn`, `userPromptSubmit`, `postToolUse`, `stop`) are merged on top with hook commands pointing at absolute paths under `~/.kiro-learn/bin/`. If `kiro-cli` is unavailable or seeding fails, the installer falls back to a minimal hooks-only config for the affected scope and emits a single `[kiro-learn] warning:` line to stderr — install still succeeds.
6. Starts the collector daemon and writes its PID to `~/.kiro-learn/collector.pid`.

Once installed, `~/.kiro-learn/` is runtime-independent of the npm package. The npx cache is disposable; the installed copy is the source of truth for hook invocations.

### Installed layout

```
~/.kiro-learn/
├── bin/
│   ├── kiro-learn            # CLI entry: `kiro-learn status|start|stop|uninstall`
│   ├── shim                # hook entry: invoked on every Kiro hook fire
│   └── collector           # daemon entry: the long-running local process
├── lib/                    # compiled payload (our dist/ copied here)
│   ├── shim/
│   ├── collector/
│   ├── installer/
│   └── types/
├── node_modules/           # runtime deps, installed once at init
├── kiro-learn.db             # SQLite store (events + memory records + FTS5 index)
├── settings.json           # user-editable config
├── collector.pid           # PID of the running daemon
└── logs/
    ├── collector-YYYY-MM-DD.log
    └── shim-YYYY-MM-DD.log

~/.kiro/agents/
└── kiro-learn.json           # global CLI agent; hook commands → ~/.kiro-learn/bin/shim
```

### Upgrade flow

```bash
npx kiro-learn@latest init
```

Same command as initial install. When a prior install is detected, the installer:

1. Stops the running daemon (if any) via the PID file.
2. Replaces `~/.kiro-learn/lib/` and `~/.kiro-learn/node_modules/` with the new payload.
3. Preserves `kiro-learn.db`, `settings.json`, and `logs/`.
4. Rewrites `bin/` wrappers (usually unchanged).
5. Restarts the daemon.

Users who want to pin a version use `npx kiro-learn@0.2 init`. Default is latest.

### Uninstall flow

```bash
kiro-learn uninstall
```

Reverses everything init did: stops the daemon, removes `~/.kiro-learn/`, removes `~/.kiro/agents/kiro-learn.json`. `settings.json` and database are deleted unless the user passes `--keep-data`.

### Why this shape

- **Fast hook invocation.** Hooks fire on every user prompt and tool use. They must be millisecond-latency. Resolving through npm/npx on each invocation is too slow; a fixed absolute path under `~/.kiro-learn/bin/` is not.
- **No global pollution.** The npm package doesn't need to be installed globally or remain in the npm cache. `npx` is purely the bootstrap.
- **Clean upgrade semantics.** Re-running `init` is idempotent and preserves user data. No version drift between the package, the installed payload, and the running daemon.
- **Transferable.** The entire installed footprint is one directory. Auditing, backing up, or moving kiro-learn is a matter of inspecting or copying `~/.kiro-learn/`.

### v1 constraints

- **npm only.** Homebrew, winget, standalone compiled binaries, and shell install scripts are v3+ nice-to-haves. v1 requires the user to have Node 22 LTS installed.
- **Single-machine install.** No remote daemon, no network transport. The collector is always `127.0.0.1` on a settings-configured port.
- **Happy-path upgrades.** "Stop first, then re-init" is acceptable for v1. Graceful online upgrades (drain requests, hot-swap collector binary) are out of scope.

## Milestones

### v1 — Baseline

Smallest thing that makes the vision real. Happy-path only.

- **Clients:** Kiro CLI only, via `.kiro/agents/<name>.json` hooks.
- **Shim:** one thin Node adapter, no platform abstraction yet.
- **Collector:** local HTTP daemon, single ingest endpoint (`POST /v1/events`).
- **Pipeline:** dedup → privacy scrub → kiro-cli extraction → storage.
- **Storage:** SQLite + FTS5. No embeddings yet.
- **Retrieval:** lexical search (FTS5) on memory records, scoped by namespace.
- **Enrichment:** synchronous context injection on `prompt` events.
- **Installer:** `kiro-learn init` installs once per machine — deploys scripts, writes the global agent at `~/.kiro/agents/kiro-learn.json`, starts the daemon. No per-project setup required. Uninstall inverts cleanly.

**Explicitly not in v1:**

- Kiro IDE hook support
- Embeddings or semantic (vector) search
- MCP tool wrappers
- Remote/cloud storage
- Team/shared memory
- Semantic-graph extraction (entities + edges)
- Bi-temporal queries (fields exist but we don't query on them yet)

### v2 — Semantic retrieval

- Embeddings via Amazon Titan Text Embeddings V2 (through `kiro-cli`)
- Local vector search via `sqlite-vec` or pgvector
- Hybrid retrieval (FTS5 + vector + recency) with reranking

### v3 — Multi-surface + MCP

- Kiro IDE hook shim (`.kiro/hooks/*.kiro.hook`)
- MCP tool wrappers for agents that prefer pull-based retrieval
- Viewer UI

### v4 — Cloud path

- Aurora + pgvector as a storage exporter (drop-in, same schema)
- **Bedrock AgentCore Memory** as an optional managed backend — the migration is essentially a field-mapping, since kiro-learn's v1 wire schema is a subset of AgentCore's Event model
- S3 cold archive for old events
- IAM-scoped team memory using AgentCore's namespace pattern

### v5+ — Semantic graph extraction

- Entity/edge extraction strategy produces a semantic graph from events
- Graph traversal retrieval alongside hybrid search
- Point-in-time temporal queries using the bi-temporal fields reserved in v1

## Principles

1. **One event schema, forever.** The v1 Event shape is the contract. Additions are additive (new `kind` values, new optional fields). Breaking changes require a `schema_version` bump with transitional support.

2. **Shim is dumb, collector is smart.** All business logic lives in the collector. Shims only normalize and ship.

3. **Never block the agent.** Capture is fire-and-forget. Enrichment has a hard deadline and returns partial results before it returns errors.

4. **Pluggable storage, fixed interface.** The storage layer exposes a small interface (`putEvent`, `putMemoryRecord`, `search`). v1 ships SQLite. Swapping to pgvector or AgentCore Memory later means writing an adapter, not rewriting the collector.

5. **AWS-native, no third-party providers.** Extraction via `kiro-cli` → Bedrock. Future managed retrieval via Bedrock AgentCore Memory. No OpenAI, Anthropic direct, Gemini, or other vendor SDKs in the dependency graph.

6. **AgentCore-aligned vocabulary.** We use the same terms as Amazon Bedrock AgentCore Memory (`Event`, `memory record`, `session`, `actor`, `namespace`, `memory strategy`) so a future migration to AgentCore is a field-mapping, not a rewrite.

7. **Local-first.** The developer experience is a single-process daemon with no cloud account required. Cloud is a v4+ story. The local schema is wire-compatible with the cloud path when we get there.

8. **Global by default, workspace-local to override.** The v1 install writes one CLI agent at `~/.kiro/agents/kiro-learn.json` so memory works in every Kiro session by default. Users can drop a workspace-local `.kiro/agents/kiro-learn.json` in any project to override behavior — to disable memory capture for that project, adjust hook configuration, or customize the namespace. This follows Kiro's own precedence model: local agents win over global ones with the same name. No per-project install command is required.

## Repo Layout (target)

```
src/
  shim/                # per-client adapters
    cli-agent/         # v1: Kiro CLI agent hook adapter
    ide-hook/          # v3: Kiro IDE .kiro.hook adapter
    shared/            # Event builder, transport, local spool
  collector/           # the daemon
    receiver/          # HTTP ingest, validation
    pipeline/          # dedup, privacy, extraction (memory strategies)
    storage/           # interface + SQLite implementation
      sqlite/
      pgvector/        # v4
      agentcore/       # v4
    enrichment/        # synchronous context-assembly endpoint
    query/             # retrieval strategies (FTS5 v1, hybrid v2+)
  mcp/                 # v3: MCP tool wrappers over query
  installer/           # npx kiro-learn init/start/stop/status/uninstall
  viewer/              # v3: React UI
  types/               # shared Event + MemoryRecord schemas, storage interface
```

## Relationship to claude-mem

kiro-learn started as a fork of [claude-mem](https://github.com/thedotmack/claude-mem). The selling point and the core insight — passive tool-use capture + LLM extraction + injected semantic context — come directly from claude-mem. What's different:

- Targeted at Kiro + AWS only (not Claude Code or other agent frameworks)
- Uses `kiro-cli` as the sole extraction backend (no API keys required)
- Event-based architecture aligned with Bedrock AgentCore Memory vocabulary
- Designed from day one for the local → cloud → team path on AWS, with a migration target of AgentCore Memory in the long run
