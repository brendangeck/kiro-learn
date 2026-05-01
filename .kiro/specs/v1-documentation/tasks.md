# Implementation Plan: v1 Documentation

## Overview

Write the actual content for all 16 pages of the kiro-learn documentation site and update the project README. Architecture pages are written first (source-derivable, no user input needed), then user-facing pages are drafted one at a time with review gates. The Mintlify scaffold (docs.json, logos, .mintignore) already exists — this spec only writes page content.

## Tasks

- [x] 1. Scaffold verification
  - [x] 1.1 Confirm `docs/` directory exists with all 16 MDX stubs and `docs.json`
    - If missing, recreate the scaffold from the deployed site structure
    - Verify docs.json navigation matches the agreed page list
    - _Requirements: all — prerequisite for everything_
  - [x] 1.2 Verify `docs.json` has correct navigation structure
    - Sections: Overview (Introduction), Getting Started (Install, Quickstart, Verify), Concepts (How It Works), Guides (CLI, IDE), Architecture (Overview + 8 pages)
    - _Requirements: all_

- [x] 2. Architecture Overview (`docs/architecture/overview.mdx`)
  - [x] 2.1 Read `src/collector/index.ts`, `src/shim/cli-agent/index.ts`, `src/shim/ide-hook/index.ts`, `src/mcp/index.ts`, `src/installer/index.ts` to confirm current layer responsibilities
  - [x] 2.2 Write the Architecture Overview page
    - Five-layer diagram (Shim CLI, Shim IDE, Collector, MCP Server, Installer)
    - Dependency direction and modularity boundaries
    - Brief description of each layer's responsibility
    - Link to each detailed architecture page
    - _Requirements: 8.1, 8.2, 8.3_
  - [x] 2.3 Notify user that Architecture Overview is done

- [ ] 3. Architecture — CLI Shim (`docs/architecture/cli-shim.mdx`)
  - [ ] 3.1 Read `src/shim/cli-agent/index.ts` and `src/shim/shared/index.ts`
  - [ ] 3.2 Write the CLI Shim page
    - stdin JSON parsing, hook dispatch table (agentSpawn, userPromptSubmit, postToolUse, stop)
    - Event building via shared module, session management
    - "Exit 0 always" contract, body truncation at 512 KiB
    - Code pointers to source files
    - _Requirements: 9.1, 9.2_

- [ ] 4. Architecture — IDE Shim (`docs/architecture/ide-shim.mdx`)
  - [ ] 4.1 Read `src/shim/ide-hook/index.ts`
  - [ ] 4.2 Write the IDE Shim page
    - argv[2] event type, USER_PROMPT env var
    - Three event types: promptSubmit, postToolUse, agentStop
    - source.surface = 'kiro-ide' distinction
    - askAgent pattern for agentStop (why it uses askAgent not runCommand)
    - Code pointers
    - _Requirements: 9.1, 9.3_

- [ ] 5. Architecture — Buffer Pipeline (`docs/architecture/buffer-pipeline.mdx`)
  - [ ] 5.1 Read `src/collector/buffer/store.ts`, `src/collector/buffer/watcher.ts`, `src/collector/buffer/types.ts`
  - [ ] 5.2 Write the Buffer Pipeline page
    - NDJSON append-only design, per-project files under ~/.kiro-learn/buffers/
    - flock-based file locking
    - BufferEntry projection (what fields are dropped from KiroMemEvent)
    - BufferWatcher: size/count triggers for extraction and compaction
    - Why buffering exists (decouple ingestion from extraction latency)
    - Code pointers
    - _Requirements: 9.1, 9.4_

- [ ] 6. Architecture — Extraction (`docs/architecture/extraction.mdx`)
  - [ ] 6.1 Read `src/collector/pipeline/acp-client.ts`, `src/collector/pipeline/xml-framer.ts`, `src/collector/pipeline/xml-parser.ts`, `src/collector/buffer/extraction.ts`
  - [ ] 6.2 Write the Extraction page
    - ACP client: kiro-cli acp --agent kiro-learn-compressor, session management
    - XML framing: event → <tool_observation> XML
    - XML parsing: <memory_record> XML → RawMemoryFields
    - Circuit breaker: 3 retries on garbage responses
    - Concurrency limit: 2 concurrent ACP sessions, FIFO queue depth 100
    - 30-second per-extraction timeout
    - Async after ingest response (failed extraction doesn't lose the event)
    - Code pointers
    - _Requirements: 9.1, 9.5_

- [ ] 7. Architecture — Compaction (`docs/architecture/compaction.mdx`)
  - [ ] 7.1 Read `src/collector/buffer/compaction.ts`
  - [ ] 7.2 Write the Compaction page
    - When compaction fires (buffer overflow thresholds)
    - LLM-driven summarization of existing memory records
    - Deterministic eviction of oldest records
    - Atomic buffer replace
    - Relationship to extraction (compaction runs after extraction fails to reduce buffer size)
    - Code pointers
    - _Requirements: 9.1, 9.6_

- [ ] 8. Architecture — Summarization (`docs/architecture/summarization.mdx`)
  - [ ] 8.1 Read `src/shim/cli-agent/index.ts` (stop handler), `src/shim/ide-hook/index.ts` (agentStop handler), `src/mcp/tools.ts` (save_session_summary)
  - [ ] 8.2 Write the Summarization page
    - Session summary flow: agentStop hook → session_summary event
    - Pre-aggregated data approach (shim builds the summary, not the LLM)
    - How summaries differ from observations (observation_type, strategy, field mapping)
    - MCP save_session_summary as an alternative path
    - Code pointers
    - _Requirements: 9.1, 9.7_

- [ ] 9. Architecture — Retrieval (`docs/architecture/retrieval.mdx`)
  - [ ] 9.1 Read `src/collector/retrieval/index.ts`, `src/collector/storage/sqlite/fts5.ts`, `src/collector/query/index.ts`
  - [ ] 9.2 Write the Retrieval page
    - FTS5 tokenization: porter unicode61 remove_diacritics 2
    - Query construction: quoted as phrase, " doubled
    - LIKE fallback when FTS5 rejects the query
    - Latency budget on the retrieval assembler
    - Context string assembly (how records are formatted for injection)
    - Code pointers
    - _Requirements: 9.1, 9.8_

- [ ] 10. Architecture — Storage (`docs/architecture/storage.mdx`)
  - [ ] 10.1 Read `src/collector/storage/sqlite/index.ts`, `src/collector/storage/sqlite/statements.ts`, `src/collector/storage/sqlite/migrations/`
  - [ ] 10.2 Write the Storage page
    - SQLite schema: events table, memory_records table, events_fts virtual table
    - STRICT tables
    - Migrations 0001–0004 (what each adds)
    - FTS5 configuration (porter unicode61 remove_diacritics 2)
    - StorageBackend interface (DI pattern — only collector/index.ts knows the concrete backend)
    - putEvent idempotency (INSERT OR IGNORE), putMemoryRecord PK collision rejection
    - transaction_time stamped by storage layer on insert
    - Read API methods: getStats, listProjects, listMemoryRecords, listEvents
    - Code pointers
    - _Requirements: 9.1, 9.9_

- [ ] 11. Checkpoint — Architecture pages complete
  - All 9 architecture pages written
  - Notify user that architecture section is done and ready for a quick scan
  - Ask user if they want to adjust anything before moving to user-facing pages
  - _Requirements: 9.10_

- [ ] 12. Introduction page — DRAFT (`docs/introduction.mdx`)
  - [ ] 12.1 Draft the Introduction page based on the design outline
    - Use placeholder tagline and pitch that can be refined
    - Include "What you get" card grid, problem statement, CTA to Getting Started
  - [ ] 12.2 **DRAFT-REVIEW GATE**: Present draft to user and ask for feedback on:
    - Tagline / one-liner — does it land?
    - Problem framing — is this how you'd describe the pain?
    - "What you get" items — right set? Right emphasis?
    - Tone — too casual? Too formal? Just right?
    - Anything missing or anything to cut?
    - _Requirements: 1.1–1.6_
  - [ ] 12.3 Revise based on user feedback and finalize

- [ ] 13. How It Works page — DRAFT (`docs/how-it-works.mdx`)
  - [ ] 13.1 Draft the How It Works page
    - Three-phase cycle: Capture → Extract → Retrieve
    - Data flow diagram (Mermaid)
    - Privacy model explanation
    - Buffer pipeline brief mention
  - [ ] 13.2 **DRAFT-REVIEW GATE**: Present draft to user and ask:
    - Right level of technical depth? Too much? Too little?
    - Diagram style — Mermaid OK or prefer something else?
    - Privacy section — enough detail here or save for a dedicated page later?
    - _Requirements: 5.1–5.5_
  - [ ] 13.3 Revise based on user feedback and finalize

- [ ] 14. Install page — DRAFT (`docs/getting-started/install.mdx`)
  - [ ] 14.1 Read `src/installer/index.ts` to confirm exact install commands and flow
  - [ ] 14.2 Draft the Install page
    - Prerequisites, install commands, what init creates, project vs global
  - [ ] 14.3 **DRAFT-REVIEW GATE**: Present draft to user and ask:
    - Are the install commands correct? (npm install -g kiro-learn → init → start)
    - Any prerequisites I'm missing?
    - Should we mention AWS credentials / Bedrock access?
    - _Requirements: 2.1–2.5_
  - [ ] 14.4 Revise based on user feedback and finalize

- [ ] 15. Quickstart page — DRAFT (`docs/getting-started/quickstart.mdx`)
  - [ ] 15.1 Draft the Quickstart page
    - End-to-end walkthrough: start session → do work → check dashboard → see memory → new session with context
  - [ ] 15.2 **DRAFT-REVIEW GATE**: Present draft to user and ask:
    - Is this the right "aha moment"?
    - CLI or IDE for the quickstart? Or both?
    - Any specific example task that works well for demos?
    - _Requirements: 3.1–3.4_
  - [ ] 15.3 Revise based on user feedback and finalize

- [ ] 16. Verify page (`docs/getting-started/verify.mdx`)
  - [ ] 16.1 Write the Verify page (no draft-review gate — factual commands)
    - Status check, healthz curl, dashboard URL, troubleshooting accordion
    - _Requirements: 4.1–4.3_
  - [ ] 16.2 Notify user that Verify page is done

- [ ] 17. CLI Guide — DRAFT (`docs/guides/kiro-cli.mdx`)
  - [ ] 17.1 Read `src/shim/cli-agent/index.ts`, `src/shim/shared/index.ts` for hook lifecycle details
  - [ ] 17.2 Draft the CLI Guide
    - Hook lifecycle, agent config structure, retrieval flow, troubleshooting
  - [ ] 17.3 **DRAFT-REVIEW GATE**: Present draft to user and ask:
    - Right level of detail on agent config?
    - Any CLI-specific gotchas to add?
    - Troubleshooting section — covering the right issues?
    - _Requirements: 6.1–6.5_
  - [ ] 17.4 Revise based on user feedback and finalize

- [ ] 18. IDE Guide — DRAFT (`docs/guides/kiro-ide.mdx`)
  - [ ] 18.1 Read `src/shim/ide-hook/index.ts`, `src/mcp/index.ts`, `src/mcp/tools.ts` for IDE integration details
  - [ ] 18.2 Draft the IDE Guide
    - Hook files, MCP integration, retrieval flow, troubleshooting
  - [ ] 18.3 **DRAFT-REVIEW GATE**: Present draft to user and ask:
    - How prominent should MCP be vs hooks?
    - Any IDE-specific gotchas to add?
    - Troubleshooting section — covering the right issues?
    - _Requirements: 7.1–7.5_
  - [ ] 18.4 Revise based on user feedback and finalize

- [ ] 19. README update — DRAFT
  - [ ] 19.1 Draft the updated README.md
    - Tagline (reuse from Introduction), description, quick-start snippet
    - Link to Mintlify docs
    - Comparison table with comparable tools
    - Credit to claude-mem
  - [ ] 19.2 **DRAFT-REVIEW GATE**: Present draft to user and ask:
    - How to position vs graphiti, claude-mem, mem0?
    - Any badges to include?
    - Screenshot/GIF of dashboard?
    - _Requirements: 10.1–10.5_
  - [ ] 19.3 Revise based on user feedback and finalize

- [ ] 20. Final review
  - [ ] 20.1 Run `mint dev` or verify all pages render correctly on the live site
  - [ ] 20.2 Check all internal links between pages work
  - [ ] 20.3 Verify no page still contains "Coming soon." placeholder text
  - [ ] 20.4 Ask user for final sign-off
  - _Requirements: 11.1–11.5_

## Notes

- **Draft-review gates** are the key mechanism for getting user input. Tasks 12–15, 17–19 all have them. The pattern is: draft → present to user with specific questions → revise → finalize.
- **Architecture pages** (tasks 2–10) skip the draft-review gate because they're source-derivable. The user gets a notification when they're done and can request changes.
- **Task ordering** is deliberate: architecture first (builds momentum, no blocking on user input), then user-facing pages one at a time (each blocks on user review).
- **Each task is one page.** This keeps diffs small and feedback focused.
- **Content sources** are listed in the design document's Content Sources table.
- All pages must use consistent terminology from AGENTS.md and include appropriate Mintlify components.
- All code examples must be verified against the current codebase.
