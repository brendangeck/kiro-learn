# Requirements: v1 Documentation

## Introduction

This document defines the requirements for writing the content of the kiro-learn documentation site. The Mintlify scaffold (docs.json, MDX stubs, logos, .mintignore) already exists and is deployed at `https://kiro-learn.mintlify.app/`. All 16 pages are live but contain only "Coming soon." placeholder text. This spec covers writing the actual content for every page, plus updating the project README.

The documentation has two audiences: **users** (developers who want to install and use kiro-learn with Kiro CLI or Kiro IDE) and **contributors/curious developers** (people who want to understand the internals). The first group needs clear, fast onboarding. The second group needs accurate technical depth.

## Glossary

- **User-facing page**: A page primarily for users who want to install and use kiro-learn. Includes Introduction, Getting Started (Install, Quickstart, Verify), How It Works, and the two Guides (CLI, IDE).
- **Architecture page**: A page primarily for contributors or curious developers who want to understand internals. Includes the 9 pages under Architecture/.
- **User voice**: The tone, pitch, and framing decisions that only the project owner can make — how to describe the project to strangers, what to emphasize, what analogies to use.
- **Source-derivable content**: Technical content that can be accurately written by reading the source code and AGENTS.md without additional user input.
- **Draft-review gate**: A task checkpoint where a draft is written and presented to the user for feedback before finalizing.

## Requirements

### Requirement 1: Introduction Page

**User Story:** As a developer landing on the docs for the first time, I want to immediately understand what kiro-learn is, why it exists, and whether it's relevant to me, so that I can decide whether to keep reading.

#### Acceptance Criteria

1.1 The Introduction page SHALL contain a one-sentence tagline that communicates what kiro-learn does.

1.2 The Introduction page SHALL contain a 2–3 paragraph explanation of the problem kiro-learn solves (agent sessions lose context) and how it solves it (passive capture → extraction → retrieval).

1.3 The Introduction page SHALL contain a "What you get" section listing concrete capabilities (memory across sessions, local-only storage, MCP tools, visual dashboard, etc.).

1.4 The Introduction page SHALL contain a clear call-to-action pointing to the Getting Started guide.

1.5 The Introduction page SHALL NOT contain installation instructions (those belong in Getting Started).

1.6 BECAUSE the Introduction page establishes the project's voice and pitch, it SHALL go through a draft-review gate with the user before finalizing.

### Requirement 2: Getting Started — Install

**User Story:** As a developer who decided to try kiro-learn, I want step-by-step installation instructions, so that I can get it running without guessing.

#### Acceptance Criteria

2.1 The Install page SHALL list prerequisites (Node ≥ 22, Kiro CLI or Kiro IDE, AWS credentials for extraction).

2.2 The Install page SHALL provide the exact commands to install kiro-learn (npm install, kiro-learn init, kiro-learn start).

2.3 The Install page SHALL explain what `kiro-learn init` does (creates agent configs, deploys payload, writes hook files).

2.4 The Install page SHALL explain the difference between project-scoped and global installs.

2.5 BECAUSE the install flow is the first hands-on experience, it SHALL go through a draft-review gate with the user to confirm the commands and flow are accurate.

### Requirement 3: Getting Started — Quickstart

**User Story:** As a developer who just installed kiro-learn, I want a fast walkthrough that shows it working end-to-end, so that I can see value immediately.

#### Acceptance Criteria

3.1 The Quickstart page SHALL walk through a complete cycle: trigger an event → see it captured → see a memory record created → see it retrieved in a future session.

3.2 The Quickstart page SHALL include the viewer UI dashboard as a visual confirmation step.

3.3 The Quickstart page SHALL be completable in under 2 minutes by someone who has already installed.

3.4 BECAUSE the quickstart defines the "aha moment," it SHALL go through a draft-review gate with the user.

### Requirement 4: Getting Started — Verify

**User Story:** As a developer who just installed kiro-learn, I want to confirm everything is working correctly, so that I can trust the system before relying on it.

#### Acceptance Criteria

4.1 The Verify page SHALL provide commands to check daemon status (`kiro-learn status`), check the health endpoint (`curl localhost:21100/healthz`), and check the viewer UI.

4.2 The Verify page SHALL include a troubleshooting section for common issues (daemon not starting, port conflict, missing kiro-cli).

4.3 BECAUSE verification commands are factual, this page MAY be written without a draft-review gate, but the user SHALL be notified when it's done.

### Requirement 5: How It Works

**User Story:** As a developer evaluating kiro-learn, I want a conceptual overview of the capture → extract → retrieve cycle, so that I understand the system without reading source code.

#### Acceptance Criteria

5.1 The How It Works page SHALL explain the three-phase cycle: event capture (shim), memory extraction (ACP/LLM), and context retrieval (FTS5 search).

5.2 The How It Works page SHALL include a diagram or visual showing the data flow from hook trigger to context injection.

5.3 The How It Works page SHALL explain what happens to data (stored locally in SQLite, never sent to cloud except through kiro-cli → Bedrock for extraction).

5.4 The How It Works page SHALL explain the privacy model (<private> tags, local-only storage).

5.5 BECAUSE this page frames the mental model for everything else, it SHALL go through a draft-review gate with the user.

### Requirement 6: Guide — Kiro CLI

**User Story:** As a developer using Kiro CLI, I want a complete guide to setting up and using kiro-learn with the CLI agent, so that I can get memory working in my CLI workflow.

#### Acceptance Criteria

6.1 The CLI Guide SHALL explain the hook lifecycle (agentSpawn → userPromptSubmit → postToolUse → stop).

6.2 The CLI Guide SHALL explain the agent config structure and how kiro-learn's hooks are wired in.

6.3 The CLI Guide SHALL explain how retrieval context is injected (stdout from the shim, read by the agent as hook output).

6.4 The CLI Guide SHALL include a troubleshooting section for common CLI-specific issues.

6.5 BECAUSE the CLI guide involves workflow details the user may want to frame differently, it SHALL go through a draft-review gate.

### Requirement 7: Guide — Kiro IDE

**User Story:** As a developer using Kiro IDE, I want a complete guide to setting up and using kiro-learn with the IDE, so that I can get memory working in my IDE workflow.

#### Acceptance Criteria

7.1 The IDE Guide SHALL explain the hook file format (`.kiro/hooks/*.kiro.hook`) and the three hook events (promptSubmit, postToolUse, agentStop).

7.2 The IDE Guide SHALL explain the MCP server integration and the three MCP tools (search_memory, save_observation, save_session_summary).

7.3 The IDE Guide SHALL explain how retrieval context flows (hook stdout for promptSubmit, MCP tool calls for pull-based).

7.4 The IDE Guide SHALL include a troubleshooting section for common IDE-specific issues.

7.5 BECAUSE the IDE guide involves workflow details the user may want to frame differently, it SHALL go through a draft-review gate.

### Requirement 8: Architecture — Overview

**User Story:** As a contributor or curious developer, I want a high-level map of the system's layers and their responsibilities, so that I can orient myself before diving into specifics.

#### Acceptance Criteria

8.1 The Architecture Overview SHALL describe the five layers (Shim CLI, Shim IDE, Collector, MCP Server, Installer) and their responsibilities.

8.2 The Architecture Overview SHALL include the ASCII or Mermaid architecture diagram from AGENTS.md (or an improved version).

8.3 The Architecture Overview SHALL explain the strict dependency direction and modularity boundaries.

8.4 BECAUSE this page is source-derivable, it MAY be written without a draft-review gate.

### Requirement 9: Architecture — Technical Pages (8 pages)

**User Story:** As a contributor, I want detailed technical documentation for each subsystem, so that I can understand the design decisions and implementation details.

#### Acceptance Criteria

9.1 Each architecture page SHALL cover: what the component does, how it works internally, key design decisions, and relevant code pointers.

9.2 The CLI Shim page SHALL cover stdin parsing, hook dispatch, event building, session management, and the "exit 0 always" contract.

9.3 The IDE Shim page SHALL cover argv/env parsing, the three event types, source.surface distinction, and the askAgent pattern for agentStop.

9.4 The Buffer Pipeline page SHALL cover NDJSON append-only design, flock-based locking, BufferEntry projection, and the watcher trigger mechanism.

9.5 The Extraction page SHALL cover ACP client, XML framing, batch extraction, circuit breaker, concurrency limits, and timeout handling.

9.6 The Compaction page SHALL cover LLM-driven summarization, deterministic eviction, buffer replace, and when compaction fires.

9.7 The Summarization page SHALL cover session summary flow, the pre-aggregated data approach, and how summaries differ from observations.

9.8 The Retrieval page SHALL cover FTS5 tokenization, query construction, LIKE fallback, latency budget, and context assembly.

9.9 The Storage page SHALL cover SQLite schema, migrations (0001–0004), FTS5 configuration, STRICT tables, and the StorageBackend interface.

9.10 BECAUSE these pages are source-derivable, they MAY be written without draft-review gates, but the user SHALL be notified when each is done.

### Requirement 10: README Update

**User Story:** As a developer finding kiro-learn on GitHub, I want the README to give me a clear picture of what this is, how to get started, and how it compares to similar tools, so that I can evaluate it quickly.

#### Acceptance Criteria

10.1 The README SHALL contain a concise project description (1–2 paragraphs).

10.2 The README SHALL link to the Mintlify docs site for full documentation.

10.3 The README SHALL reference comparable projects (graphiti, claude-mem, mem0, etc.) with a brief note on how kiro-learn differs.

10.4 The README SHALL contain a quick-start snippet (install + init + start).

10.5 BECAUSE the README is the project's public face on GitHub, it SHALL go through a draft-review gate with the user.

### Requirement 11: Content Quality

**User Story:** As a reader of any page, I want the documentation to be clear, accurate, and consistent, so that I can trust it.

#### Acceptance Criteria

11.1 All pages SHALL use consistent terminology matching the glossary in AGENTS.md.

11.2 All code examples SHALL be tested or verified against the current codebase.

11.3 All pages SHALL use Mintlify components (callouts, steps, code groups, cards) where they improve readability.

11.4 No page SHALL exceed 1500 words unless the technical depth requires it (architecture pages may be longer).

11.5 All pages SHALL include appropriate frontmatter (title, description, icon where applicable).

## Non-functional Requirements

### Tone

- N1. User-facing pages SHALL use a developer-casual tone — direct, practical, no marketing fluff.
- N2. Architecture pages SHALL use a technical-but-readable tone — precise terminology, but not academic.
- N3. All pages SHALL prefer short sentences and active voice.

### Maintainability

- N4. Architecture pages SHALL reference source file paths so readers can find the code.
- N5. No page SHALL hardcode version numbers that will go stale. Use "current" or link to package.json.

### Privacy

- N6. No page SHALL include real usernames, file paths, or project names from actual user sessions. Use generic examples.

## Out of Scope

- **API Reference section** — deferred, not needed now.
- **Blog posts** — deferred, not needed now.
- **"For AWS Teams" section** — deferred, not needed now.
- **Mintlify scaffold changes** — the docs.json, logos, and .mintignore already exist and are deployed. This spec only covers writing page content.
- **AGENTS.md update** — tracked separately, not part of this spec.
