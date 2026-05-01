# Requirements: v0 Documentation

## Introduction

This document defines the requirements for the kiro-learn documentation site and project README. The site is deployed at `https://kiro-learn.mintlify.app/` and organized into three navigation groups: **Getting started**, **Concepts**, and **Architecture**.

The documentation has two audiences:

- **Users** — developers who want to install and use kiro-learn with Kiro CLI or Kiro IDE. They need clear, fast onboarding. They land on the Introduction page and read through Install.
- **Contributors and curious developers** — people who want to understand the internals before adopting, extending, or migrating the tool. They need accurate technical depth. They land on the Architecture overview or a specific Concept page.

This document has been **reverse-spec'd** to match the site that ships. Requirements 1, 3, 4, 6, 7, and 8 describe pages that have already been written. Requirements 2 and 9 describe pages that still need to be written. The full history of drafted-then-cut pages (a separate How It Works page, a Verify page, separate Quickstart, and two Guides) is not preserved here — the spec reflects the site that exists.

## Glossary

- **User-facing page** — A page primarily for users who want to install and use kiro-learn. Introduction and Install.
- **Concept page** — A page explaining a domain idea (projects, event types, event buffer, privacy) at design-level rather than implementation-level.
- **Architecture page** — A page primarily for contributors or curious developers who want to understand internals. Nine pages under Architecture/.
- **User voice** — Tone, pitch, and framing decisions that only the project owner can make — how to describe the project to strangers, what to emphasize, what analogies to use.
- **Source-derivable content** — Technical content that can be accurately written by reading the source code and AGENTS.md without additional user input.
- **Draft-review gate** — A task checkpoint where a draft is written and presented to the user for feedback before finalizing.

## Requirements

### Requirement 1: Introduction page

**User Story:** As a developer landing on the docs for the first time, I want to immediately understand what kiro-learn is, why it exists, and what I get from it, so that I can decide whether to keep reading.

Location: `docs/getting-started/introduction.mdx` (inside the Getting started group, not a separate Overview group).

#### Acceptance Criteria

1.1 The Introduction page SHALL open with an H1 that matches the tagline "Continuous learning for Kiro agents" with no subtitle text between the H1 and the first content section.

1.2 The Introduction page SHALL contain a "The problem" section with 2–3 paragraphs explaining the problem kiro-learn solves (agent sessions lose context, manual memory tools decay) and how it solves it (passive capture → extraction → retrieval, with the agent picking up preferences, coding style, and repo conventions over time).

1.3 The Introduction page SHALL contain a "What you get" section presenting capabilities as a `<CardGroup>` — memory across sessions, local and private, visual dashboard, MCP tools, CLI and IDE support, per-project isolation.

1.4 The Introduction page SHALL contain a clear call-to-action pointing to the Install page.

1.5 The Introduction page SHALL NOT contain installation instructions (those belong on Install), privacy detail beyond a passing phrase (detail belongs on the Privacy concept page), or references to comparable tools (those belong on the README).

1.6 BECAUSE the Introduction page establishes the project's voice and pitch, it SHALL go through a draft-review gate with the user before finalizing.

### Requirement 2: Install and quickstart page

**User Story:** As a developer who decided to try kiro-learn, I want a single page that walks me from install through a working session, so that I see value without hunting across multiple pages.

Location: `docs/getting-started/install.mdx`.

The original spec split this into three pages (Install, Quickstart, Verify). During Introduction review the user requested merging them into a single page — the Install page now owns the full onboarding arc. Verify content (health check, troubleshooting) is folded into the troubleshooting section of this page. Quickstart content (end-to-end walkthrough) flows immediately after install commands.

#### Acceptance Criteria

2.1 The page SHALL list prerequisites: Node.js 22 or later, Kiro CLI or Kiro IDE, AWS credentials for extraction.

2.2 The page SHALL provide the exact install commands as a `<Steps>` component: `npm install -g kiro-learn`, `kiro-learn init`, `kiro-learn start`.

2.3 The page SHALL explain what `kiro-learn init` does: scope detection via upward marker walk, agent config creation via seed-then-merge from `kiro_default`, hook file deployment, compressor agent installation, UI asset copy.

2.4 The page SHALL explain the difference between project-scoped installs and `--global-only`.

2.5 The page SHALL include an end-to-end walkthrough: start a Kiro session, run one simple task, observe the event tail in the dashboard, wait for extraction to produce a memory record, start a new session and see retrieved context in the agent's prompt.

2.6 The page SHALL link to the viewer UI at `http://127.0.0.1:21100/ui/` and include a screenshot or description of what the dashboard shows.

2.7 The page SHALL include a short troubleshooting section covering: daemon won't start (port conflict), no events appearing (hooks not wired, agent config not pointing to kiro-learn), extraction silently failing (`kiro-cli` missing or Bedrock credentials unavailable).

2.8 BECAUSE this page is the primary hands-on experience, it SHALL go through a draft-review gate with the user to confirm commands, the "aha moment", and whether to show CLI, IDE, or both.

### Requirement 3: Projects concept page

**User Story:** As a contributor or curious user, I want to understand how kiro-learn decides which project an event belongs to, so that I can reason about memory isolation and debug unexpected scoping.

Location: `docs/concepts/projects.mdx`.

#### Acceptance Criteria

3.1 The page SHALL describe a project as the unit of memory isolation — buffers, retrieval, and storage all scope to it.

3.2 The page SHALL explain the upward marker walk algorithm from the current working directory with `$HOME` as the ceiling.

3.3 The page SHALL enumerate all 15 project markers in a table with their associated ecosystems.

3.4 The page SHALL explain the global project fallback when no marker is found before the ceiling.

3.5 The page SHALL explain how `kiro-learn init` creates a project scope (by writing a `.kiro` directory, which is itself a marker).

3.6 The page SHALL explain how multiple agents (CLI, IDE, parallel sessions) in the same project share memory automatically via deterministic project ID derivation.

3.7 The page SHALL document the namespace format: `/actor/<username>/project/<project_id>/`.

### Requirement 4: Event types concept page

**User Story:** As a contributor, I want a reference for every event kind kiro-learn emits and every body shape it carries, so that I can write integrations, inspect the event log, or extend the schema without guessing.

Location: `docs/concepts/event-types.mdx`.

#### Acceptance Criteria

4.1 The page SHALL enumerate the four event kinds (`prompt`, `tool_use`, `session_summary`, `note`) with a table showing when each fires, whether it drives retrieval, and typical body shape.

4.2 The page SHALL document each kind's trigger source in both the CLI shim and the IDE shim.

4.3 The page SHALL enumerate the three body shapes (`text`, `message`, `json`) with example payloads and a mapping of which kinds use which shapes.

4.4 The page SHALL document the 1 MiB serialized cap and the 512 KiB shim-side truncation behavior for each body shape.

4.5 The page SHALL enumerate the envelope fields every event carries regardless of kind (`event_id`, `namespace`, `actor_id`, `session_id`, `valid_time`, `source.surface`, `source.version`, `source.project_path`, `schema_version`, `content_hash`, `parent_event_id`).

4.6 The page SHALL include a Mermaid diagram showing how different kinds map to the collector pipeline, highlighting that only `prompt` events trigger inline retrieval.

4.7 The page SHALL explain the design rationale for having four distinct kinds instead of one opaque "event" type.

### Requirement 5: Event buffer concept page

**User Story:** As a contributor debugging a slow or stuck extraction, I want to understand what the event buffer is, where it lives, and what triggers the workers that read from it, so that I can diagnose issues and reason about backpressure.

Location: `docs/concepts/event-buffer.mdx`.

#### Acceptance Criteria

5.1 The page SHALL describe the buffer as a per-project staging area between event ingestion and memory extraction.

5.2 The page SHALL explain why buffering exists: decoupling ingestion speed from extraction latency.

5.3 The page SHALL describe how events flow into the buffer (after dedup and privacy scrub) and the projection applied (dropping `schema_version`, `content_hash`, `parent_event_id`, `session_id`, full `source` block).

5.4 The page SHALL explain per-project isolation with the file layout at `~/.kiro-learn/buffers/<project_id>/buffer.ndjson`.

5.5 The page SHALL document what triggers extraction (size threshold, idle timer) and what triggers compaction (overflow threshold, hard ceiling).

5.6 The page SHALL describe how the buffer is cleared after successful extraction and how it is retained on failure (with circuit breaker disabling further extraction after N failures).

5.7 The page SHALL describe resilience properties: crash recovery via NDJSON line-oriented format, concurrent access safety via `flock`, circuit breaker behavior.

### Requirement 6: Privacy concept page

**User Story:** As a developer evaluating kiro-learn, I want a clear, specific statement of what data lives on my machine, what leaves, and how to keep sensitive content out, so that I can decide whether to adopt it without guessing.

Location: `docs/concepts/privacy.mdx`.

#### Acceptance Criteria

6.1 The page SHALL tabulate what kiro-learn stores locally: raw events and memory records in `~/.kiro-learn/kiro-learn.db`, buffers under `~/.kiro-learn/buffers/<project_id>/buffer.ndjson`, config at `~/.kiro-learn/settings.json`, viewer UI assets at `~/.kiro-learn/ui/`, session markers under `/tmp/`.

6.2 The page SHALL state that the collector binds to `127.0.0.1:21100` and is not reachable from other machines on the network.

6.3 The page SHALL identify extraction as the only outbound path, explain that it goes through `kiro-cli` to Amazon Bedrock using the user's own AWS credentials, and link to Bedrock's data-protection documentation.

6.4 The page SHALL document the `<private>...</private>` tag mechanics: where redaction happens (collector's cleaning pipeline, not shim, not storage), paired tag behavior, nested tag behavior, unclosed tag behavior.

6.5 The page SHALL enumerate escape hatches: deleting memory for a project, uninstalling with `--keep-data=false`, running without extraction by not configuring `kiro-cli`.

6.6 The page SHALL list every field stored per event, flagging `source.project_path` as the one field that explicitly captures a filesystem location.

### Requirement 7: Architecture overview

**User Story:** As a contributor or curious developer, I want a high-level map of the system's components and how they interact, so that I can orient myself before diving into specific architecture pages.

Location: `docs/architecture/overview.mdx`.

#### Acceptance Criteria

7.1 The page SHALL include a simplified system diagram (Developer → Kiro IDE/CLI → Daemon → Database) rendered in Mermaid.

7.2 The page SHALL include a sequence diagram showing a full agent turn: prompt submit with retrieval, tool use events, agent stop with turn summary, asynchronous extraction when the buffer reaches threshold.

7.3 The page SHALL describe the four top-level components (Kiro IDE/CLI, Collector, Workers, Database) with their responsibilities.

7.4 The page SHALL provide deep-dive cards linking to all eight sub-pages (two shim pages, Collector, Extraction, Compaction, Summarization, Retrieval, Database).

### Requirement 8: Architecture deep-dive pages (8 pages)

**User Story:** As a contributor, I want detailed technical documentation for each subsystem, so that I can understand design decisions, trace behavior through the codebase, and extend the system safely.

#### Acceptance Criteria

Each architecture deep-dive page SHALL cover: what the component does, how it works internally, key design decisions with rationale, and a "Related pages" card group linking to adjacent components.

8.1 **Kiro CLI Shim** (`docs/architecture/kiro-cli-shim.mdx`) SHALL cover stdin JSON parsing, hook dispatch for the four hook events, event building, session management, project root detection, the retrieval-via-stdout pattern, and the "exit 0 always" contract.

8.2 **Kiro IDE Shim** (`docs/architecture/kiro-ide-shim.mdx`) SHALL cover `argv[2]` event-type parsing, `USER_PROMPT` env payload parsing, the three hook events, the `source.surface = 'kiro-ide'` tagging, the `askAgent` pattern for agentStop, and how it differs from the CLI shim.

8.3 **Collector** (`docs/architecture/collector.mdx`) SHALL cover the HTTP API surface, the cleaning pipeline (dedup + privacy scrub), the buffer append stage, the retrieval path, and the viewer UI static-asset serving.

8.4 **Extraction** (`docs/architecture/extraction.mdx`) SHALL cover the ACP client wrapping `kiro-cli acp`, batch XML framing, circuit breaker (3 retries on garbage responses), concurrency limits (2 sessions, depth-100 queue), 30-second per-extraction timeout, and the async-after-ingest-response design.

8.5 **Compaction** (`docs/architecture/compaction.mdx`) SHALL cover when it fires (buffer overflow), LLM-driven summarization of existing memory records, deterministic oldest-record eviction, atomic buffer replace with catch-up window, and the relationship to extraction as a pressure valve.

8.6 **Summarization** (`docs/architecture/summarization.mdx`) SHALL cover the hook path (agent stop → session_summary event), the MCP path (explicit `save_session_summary` tool call), the content of a session summary vs a regular observation, and `observation_type = 'session_summary'`.

8.7 **Retrieval** (`docs/architecture/retrieval.mdx`) SHALL cover FTS5 tokenization (porter unicode61 remove_diacritics 2), query construction with quote escaping, the LIKE fallback when FTS5 rejects a query, the latency budget on retrieval assembly, and the format of the injected context string.

8.8 **Database** (`docs/architecture/database.mdx`) SHALL cover the SQLite schema (events, memory_records, events_fts), STRICT tables, migrations 0001–0004 with their purposes, FTS5 configuration, the `StorageBackend` DI interface, `putEvent` idempotency via `INSERT OR IGNORE`, and `putMemoryRecord` PK collision rejection.

### Requirement 9: README update

**User Story:** As a developer finding kiro-learn on GitHub, I want the README to give me a clear picture of what this is, how to get started, and how it compares to similar tools, so that I can evaluate it quickly without clicking through to the docs.

Location: `README.md` at the repo root.

#### Acceptance Criteria

9.1 The README SHALL open with a tagline matching the Introduction page ("Continuous learning for Kiro agents.").

9.2 The README SHALL contain a 1–2 paragraph description of what kiro-learn does.

9.3 The README SHALL contain a quick-start snippet: `npm install -g kiro-learn`, `kiro-learn init`, `kiro-learn start`.

9.4 The README SHALL link prominently to the published docs site.

9.5 The README SHALL contain a comparison section referencing mem0, Graphiti, Letta, and claude-mem with one-line characterizations of each and a paragraph positioning kiro-learn against them (Kiro-native, local-by-default, passive, AWS/Bedrock-aware).

9.6 The README SHALL credit `claude-mem` as the original inspiration.

9.7 The README SHALL include license information.

9.8 BECAUSE the README is the project's public face on GitHub, it SHALL go through a draft-review gate with the user.

## Non-functional Requirements

### Tone

- N1. User-facing pages (Introduction, Install) SHALL use a developer-casual tone — direct, practical, no marketing fluff.
- N2. Concept pages SHALL use a technical-but-readable tone — precise terminology, but accessible to a reader who hasn't read the source.
- N3. Architecture pages SHALL use a technical-but-readable tone with slightly more implementation detail than Concept pages — precise terminology and code pointers, but not academic.
- N4. All pages SHALL prefer short sentences and active voice.

### Structure

- N5. Every page SHALL use frontmatter (`title`, `description`) consumed by Mintlify for the page title, SEO snippet, and sidebar label.
- N6. Every page SHALL start body headings at H2 — the frontmatter `title` is the H1.
- N7. Every non-trivial page SHALL end with a "Related pages" `<CardGroup>` linking to adjacent Concept or Architecture pages.
- N8. Diagrams SHALL use Mermaid, not ASCII art.

### Maintainability

- N9. Architecture pages SHALL reference source file paths so readers can navigate to the code.
- N10. No page SHALL hardcode version numbers that will go stale. Reference "current" or link to `package.json`.
- N11. No page SHALL contain the placeholder text "Coming soon." when this spec is complete.
- N12. All internal links SHALL resolve — no dangling references to deleted pages (`/how-it-works`, `/getting-started/quickstart`, `/getting-started/verify`, `/guides/*`).

### Privacy

- N13. No page SHALL include real usernames, file paths, or project names from actual user sessions. Use generic examples.

## Out of Scope

- **A dedicated "How it works" page.** Originally planned as Requirement 5; content was absorbed into the Architecture overview (for the data flow) and the Privacy concept page (for the data-lives-locally story). The page itself is deleted.
- **A dedicated "Verify your install" page.** Originally planned as Requirement 4; factual commands (status check, health endpoint, troubleshooting) are folded into the Install page.
- **Separate CLI and IDE usage guides.** Originally planned as Requirements 6 and 7; the corresponding Architecture shim pages (`kiro-cli-shim.mdx`, `kiro-ide-shim.mdx`) cover the usage content at the right level of depth for this audience.
- **API reference section.** Deferred to a later milestone.
- **Blog posts.** Deferred to a later milestone.
- **"For AWS Teams" section.** Deferred to a later milestone.
- **Mintlify scaffold changes.** The `docs.json`, logos, favicon, and `.mintignore` are complete. This spec only covers page content and navigation entries.
- **`AGENTS.md` update.** Tracked separately.
