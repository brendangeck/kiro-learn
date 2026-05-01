# Implementation Plan: v0 Documentation

## Overview

Write the actual content for all documentation pages and update the project README. Architecture pages are written first (source-derivable, no user input needed), then user-facing pages are drafted one at a time with review gates. The Mintlify scaffold (docs.json, logos, .mintignore) already exists — this spec only writes page content.

## Style Guide (established during Architecture Overview)

- **Mermaid over ASCII** for all diagrams
- **Design-level language** — describe what components do, not implementation type names (no `KiroMemEvent`, no "Cloudscape React")
- **Consistent naming** — "Kiro CLI Shim", "Kiro IDE Shim", "Collector", "Workers", "Database" (not "Storage", not "Buffer Pipeline")
- **Dashed lines = async/non-blocking** in sequence diagrams
- **No icons on individual pages** — icons belong on section headers in docs.json only
- **v0 version dropdown** in docs.json navigation
- **Page titles match sidebar and deep-dive cards**

## Tasks

- [x] 1. Scaffold verification
  - [x] 1.1 Confirm `docs/` directory exists with all MDX stubs and `docs.json`
  - [x] 1.2 Verify `docs.json` has correct navigation structure with v0 version dropdown

- [x] 2. Architecture Overview (`docs/architecture/overview.mdx`)
  - [x] 2.1 Read source entry points to confirm component responsibilities
  - [x] 2.2 Write the Architecture Overview page
    - Simplified system diagram (Developer → Kiro IDE/CLI → Daemon → Database)
    - Sequence diagram showing a full agent turn (prompt submit, tool uses, agent stop, async extraction)
    - Component descriptions (Kiro IDE/CLI, Collector, Workers, Database)
    - Deep dive cards linking to sub-pages
  - [x] 2.3 Notify user that Architecture Overview is done

- [x] 3. Kiro CLI Shim (`docs/architecture/cli-shim.mdx`)
  - [x] 3.1 Read `src/shim/cli-agent/index.ts` and `src/shim/shared/index.ts`
  - [x] 3.2 Write the Kiro CLI Shim page
    - What it does: translates Kiro CLI hook events into structured events for the daemon
    - How hooks reach the shim: stdin JSON from the Kiro CLI runtime
    - The four hook events and what each captures
    - Session management and project detection
    - Retrieval: how context flows back to the agent via stdout
    - "Exit 0 always" contract — never blocks the agent
    - _Requirements: 9.1, 9.2_

- [x] 4. Kiro IDE Shim (`docs/architecture/ide-shim.mdx`)
  - [x] 4.1 Read `src/shim/ide-hook/index.ts`
  - [x] 4.2 Write the Kiro IDE Shim page
    - What it does: translates Kiro IDE hook events into structured events for the daemon
    - How hooks reach the shim: argv for event type, environment variable for payload
    - The three hook events and what each captures
    - Why agentStop uses askAgent instead of runCommand
    - How it differs from the CLI shim (input format, event names, surface tag)
    - _Requirements: 9.1, 9.3_

- [x] 5. Projects concept page (`docs/concepts/projects.mdx`)
  - [x] 5.1 Read `src/shim/shared/project-root.ts` and `src/installer/index.ts` (scope detection)
  - [x] 5.2 Write the Projects page
    - What a project is: the unit of memory isolation (buffers, retrieval, namespace)
    - How project detection works: upward marker walk from cwd
    - The 15 project markers and why they exist
    - The global project: what happens when no marker is found (events collapse to one namespace per user)
    - Project init: `kiro-learn init` creates the project scope
    - How multiple agents (CLI, IDE, parallel sessions) share the same project memory
    - Namespace format: `/actor/<username>/project/<project_id>/`

- [x] 5b. Event Buffer concept page (`docs/concepts/event-buffer.mdx`)
  - [x] 5b.1 Read `src/collector/buffer/store.ts`, `src/collector/buffer/watcher.ts`, `src/collector/buffer/types.ts`
  - [x] 5b.2 Write the Event Buffer page
    - What the event buffer is: a per-project staging area between event ingestion and memory extraction
    - Why buffering exists: decouples ingestion speed from extraction latency
    - How events flow into the buffer (after cleaning, before extraction)
    - Per-project isolation: one NDJSON file per project
    - What triggers extraction: size and count thresholds
    - What triggers compaction: buffer overflow
    - Relationship to the extraction and compaction workers
    - How the buffer is cleared after successful extraction

- [ ] 6. Collector (`docs/architecture/collector.mdx`)
  - [ ] 6.1 Read `src/collector/pipeline/index.ts`, `src/collector/buffer/store.ts`, `src/collector/buffer/watcher.ts`, `src/collector/receiver/index.ts`
  - [ ] 6.2 Write the Collector page
    - What it does: receives events, cleans them, stores them, buffers them for extraction
    - HTTP API: the single endpoint shims POST to, plus the retrieval query path
    - Cleaning pipeline: dedup and privacy scrub — what gets removed and why
    - Buffer: per-project append-only files, why buffering exists (decouple ingestion from extraction)
    - Buffer watcher: what triggers extraction and compaction (size thresholds, idle timers)
    - Viewer UI: what it shows and where to access it
    - _Requirements: 9.1, 9.4_

- [ ] 7. Extraction (`docs/architecture/extraction.mdx`)
  - [ ] 7.1 Read `src/collector/pipeline/acp-client.ts`, `src/collector/pipeline/xml-framer.ts`, `src/collector/pipeline/xml-parser.ts`, `src/collector/buffer/extraction.ts`
  - [ ] 7.2 Write the Extraction page
    - What it does: turns raw events into structured memory records using an LLM
    - How it works: batch of events → LLM prompt → structured records back
    - Reliability: circuit breaker (retries on bad responses), concurrency limits, timeouts
    - Async design: extraction never blocks event ingestion
    - What a memory record contains (title, summary, concepts, files, observation type)
    - _Requirements: 9.1, 9.5_

- [ ] 7. Compaction (`docs/architecture/compaction.mdx`)
  - [ ] 7.1 Read `src/collector/buffer/compaction.ts`
  - [ ] 7.2 Write the Compaction page
    - What it does: prevents buffers from growing unbounded
    - When it fires: buffer overflow thresholds
    - How it works: LLM summarizes existing records, oldest records are evicted
    - The feedback loop: compaction writes back to the buffer
    - Relationship to extraction: compaction is the pressure valve when extraction can't keep up
    - _Requirements: 9.1, 9.6_

- [ ] 8. Summarization (`docs/architecture/summarization.mdx`)
  - [ ] 8.1 Read stop handlers in both shims and `src/mcp/tools.ts`
  - [ ] 8.2 Write the Summarization page
    - What it does: captures a structured summary of what happened in a session
    - Two paths: hook-based (automatic on agent stop) and MCP-based (explicit tool call)
    - What a session summary contains vs a regular observation
    - Why summaries exist alongside per-event extraction
    - _Requirements: 9.1, 9.7_

- [ ] 9. Retrieval (`docs/architecture/retrieval.mdx`)
  - [ ] 9.1 Read `src/collector/retrieval/index.ts`, `src/collector/storage/sqlite/fts5.ts`, `src/collector/query/index.ts`
  - [ ] 9.2 Write the Retrieval page
    - What it does: finds relevant memories and formats them for prompt injection
    - How search works: full-text search with fallback for robustness
    - Latency budget: retrieval has a time limit to avoid slowing down the agent
    - Context assembly: how matching records are formatted into a string the agent can use
    - _Requirements: 9.1, 9.8_

- [ ] 10. Database (`docs/architecture/storage.mdx`)
  - [ ] 10.1 Read `src/collector/storage/sqlite/index.ts`, `src/collector/storage/sqlite/statements.ts`, `src/collector/storage/sqlite/migrations/`
  - [ ] 10.2 Write the Database page
    - What it does: persists raw events and memory records locally
    - Schema: what tables exist and what they store
    - Full-text indexing: how memories become searchable
    - Migrations: how the schema evolves over time
    - Privacy: all data stays local, nothing leaves the machine except during extraction
    - _Requirements: 9.1, 9.9_

- [ ] 11. Checkpoint — Architecture pages complete
  - Notify user that all architecture pages are written
  - Ask if they want to adjust anything before moving to user-facing pages
  - _Requirements: 9.10_

- [ ] 12. Introduction page — DRAFT (`docs/introduction.mdx`)
  - [ ] 12.1 Draft the Introduction page
    - Problem statement, what kiro-learn does, "what you get" section, CTA to Getting Started
  - [ ] 12.2 **DRAFT-REVIEW GATE**: Present draft and ask for feedback on tagline, problem framing, tone
  - [ ] 12.3 Revise based on user feedback and finalize
  - _Requirements: 1.1–1.6_

- [ ] 13. How It Works page — DRAFT (`docs/how-it-works.mdx`)
  - [ ] 13.1 Draft the How It Works page
    - Three-phase cycle: Capture → Extract → Retrieve (Mermaid diagram)
    - Privacy model explanation
  - [ ] 13.2 **DRAFT-REVIEW GATE**: Present draft and ask about technical depth, diagram style, privacy detail
  - [ ] 13.3 Revise based on user feedback and finalize
  - _Requirements: 5.1–5.5_

- [ ] 14. Install page — DRAFT (`docs/getting-started/install.mdx`)
  - [ ] 14.1 Read `src/installer/index.ts` to confirm install flow
  - [ ] 14.2 Draft the Install page (prerequisites, commands, what init creates)
  - [ ] 14.3 **DRAFT-REVIEW GATE**: Present draft and ask about commands, prerequisites, AWS credentials
  - [ ] 14.4 Revise based on user feedback and finalize
  - _Requirements: 2.1–2.5_

- [ ] 15. Quickstart page — DRAFT (`docs/getting-started/quickstart.mdx`)
  - [ ] 15.1 Draft the Quickstart page (end-to-end walkthrough of one session)
  - [ ] 15.2 **DRAFT-REVIEW GATE**: Present draft and ask about the "aha moment", CLI vs IDE, example task
  - [ ] 15.3 Revise based on user feedback and finalize
  - _Requirements: 3.1–3.4_

- [ ] 16. Verify page (`docs/getting-started/verify.mdx`)
  - [ ] 16.1 Write the Verify page (factual commands, no draft-review gate)
    - Status check, health endpoint, dashboard URL, troubleshooting
  - [ ] 16.2 Notify user that Verify page is done
  - _Requirements: 4.1–4.3_

- [ ] 17. CLI Guide — DRAFT (`docs/guides/kiro-cli.mdx`)
  - [ ] 17.1 Draft the CLI Guide (hook lifecycle, agent config, retrieval flow, troubleshooting)
  - [ ] 17.2 **DRAFT-REVIEW GATE**: Present draft and ask about detail level, gotchas, troubleshooting coverage
  - [ ] 17.3 Revise based on user feedback and finalize
  - _Requirements: 6.1–6.5_

- [ ] 18. IDE Guide — DRAFT (`docs/guides/kiro-ide.mdx`)
  - [ ] 18.1 Draft the IDE Guide (hook files, MCP integration, retrieval flow, troubleshooting)
  - [ ] 18.2 **DRAFT-REVIEW GATE**: Present draft and ask about MCP prominence, gotchas, troubleshooting
  - [ ] 18.3 Revise based on user feedback and finalize
  - _Requirements: 7.1–7.5_

- [ ] 19. README update — DRAFT
  - [ ] 19.1 Draft the updated README.md (tagline, description, quick-start, docs link, comparison table)
  - [ ] 19.2 **DRAFT-REVIEW GATE**: Present draft and ask about positioning, badges, screenshots
  - [ ] 19.3 Revise based on user feedback and finalize
  - _Requirements: 10.1–10.5_

- [ ] 20. Final review
  - [ ] 20.1 Verify all pages render correctly
  - [ ] 20.2 Check all internal links between pages work
  - [ ] 20.3 Verify no page still contains "Coming soon." placeholder text
  - [ ] 20.4 Ask user for final sign-off
  - _Requirements: 11.1–11.5_

## Notes

- **Architecture pages** (tasks 3–10) follow the pattern established in the overview: describe what each component does and why, not how it's implemented. Use Mermaid diagrams. Keep implementation details (type names, file paths) minimal — readers who want code can follow source links.
- **Draft-review gates** (tasks 12–15, 17–19) are for user-facing pages that need the user's voice.
- **Task ordering**: architecture first (no blocking), then user-facing pages one at a time.
- **Each task is one page.** Keeps diffs small and feedback focused.
- **Consistent terminology**: use the component names from the overview diagram throughout all pages.
