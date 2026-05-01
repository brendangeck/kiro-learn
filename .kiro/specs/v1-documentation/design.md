# Design: v1 Documentation

## Overview

This design covers writing the actual content for 16 MDX pages on the kiro-learn documentation site, plus updating the project README. The Mintlify scaffold is already deployed at `https://kiro-learn.mintlify.app/` — all pages exist but contain "Coming soon." placeholder text.

The documentation splits into two tiers:

1. **User-facing pages** (7 pages) — Introduction, Install, Quickstart, Verify, How It Works, CLI Guide, IDE Guide. These establish the project's voice and require user review before finalizing.
2. **Architecture pages** (9 pages) — Overview + 8 technical deep-dives. These are source-derivable from the codebase and AGENTS.md.

Plus the **README** update, which is the GitHub landing page.

### Key Design Decisions

1. **Draft-review gates for user-facing pages.** The Introduction, Getting Started pages, How It Works, both Guides, and the README all need the user's voice — how to pitch the project, what to emphasize, what tone to strike. These pages are drafted first, then presented to the user for feedback before finalizing. Architecture pages skip this gate.

2. **Architecture pages written from source.** The 9 architecture pages can be written accurately by reading the source code and AGENTS.md. They don't need user input on framing — just technical accuracy.

3. **One page at a time.** Each page is a separate task. This keeps diffs reviewable and lets the user give focused feedback on user-facing pages without being overwhelmed.

4. **Mintlify components used judiciously.** Callouts for warnings/tips, Steps for sequential procedures, CodeGroups for multi-command examples, Cards for navigation. Not every page needs every component.

5. **No scaffold changes.** The docs.json navigation, logos, favicon, and .mintignore are already correct. This spec only writes page content.

## Page Content Outlines

### Page 1: Introduction (`docs/introduction.mdx`)

**Tier:** User-facing (draft-review gate required)

**Needs user input on:**
- The tagline / one-liner pitch
- What to emphasize as the primary value prop (privacy? continuity? zero-config?)
- Whether to mention comparable tools (graphiti, claude-mem, mem0) here or only in README
- Any specific phrasing preferences

**Content outline:**
```
---
title: "Introduction"
description: "Memory for Kiro agent sessions. Local, private, and built for AWS developers."
---

# kiro-learn

[Tagline — needs user voice]

## The problem

[2-3 paragraphs: agent sessions are stateless, context is lost between sessions,
developers repeat themselves, agents re-discover the same things]

## What kiro-learn does

[2-3 paragraphs: passive capture of tool-use events, LLM-driven extraction into
structured memory records, automatic injection of relevant context into future sessions]

## What you get

<CardGroup cols={2}>
  <Card title="Memory across sessions" icon="brain">
    [Brief description]
  </Card>
  <Card title="Local and private" icon="lock">
    [Brief description]
  </Card>
  <Card title="Visual dashboard" icon="chart-network">
    [Brief description]
  </Card>
  <Card title="MCP tools" icon="plug">
    [Brief description]
  </Card>
  <Card title="Works with CLI and IDE" icon="terminal">
    [Brief description]
  </Card>
  <Card title="Built for AWS" icon="aws">
    [Brief description]
  </Card>
</CardGroup>

## Get started

<Card title="Install kiro-learn" icon="rocket" href="/getting-started/install">
  Get up and running in under 2 minutes.
</Card>
```

### Page 2: Install (`docs/getting-started/install.mdx`)

**Tier:** User-facing (draft-review gate required)

**Needs user input on:**
- Is the install flow `npm install -g kiro-learn` → `kiro-learn init` → `kiro-learn start`? Or something different?
- Any prerequisites beyond Node ≥ 22 and kiro-cli?
- Should we mention AWS credentials / Bedrock access as a prerequisite for extraction?

**Content outline:**
```
---
title: "Install"
description: "Install kiro-learn and run the collector daemon."
---

## Prerequisites

- Node.js 22 or later
- Kiro CLI or Kiro IDE
- [AWS credentials for extraction — confirm with user]

## Install the package

<Steps>
  <Step title="Install kiro-learn">
    ```bash
    npm install -g kiro-learn
    ```
  </Step>
  <Step title="Initialize in your project">
    ```bash
    cd your-project
    kiro-learn init
    ```
    [Explain what init does: creates agent configs, deploys payload, writes hooks]
  </Step>
  <Step title="Start the collector">
    ```bash
    kiro-learn start
    ```
    [Explain what start does: launches daemon on 127.0.0.1:21100]
  </Step>
</Steps>

## Project vs global install

[Explain --global-only flag, scope detection, when to use each]

## What init creates

[File tree showing what gets created: ~/.kiro-learn/, .kiro/hooks/, agent configs]
```

### Page 3: Quickstart (`docs/getting-started/quickstart.mdx`)

**Tier:** User-facing (draft-review gate required)

**Needs user input on:**
- What's the ideal "aha moment" — seeing the memory graph? Getting context injected?
- Should the quickstart use CLI or IDE (or show both)?

**Content outline:**
```
---
title: "Quickstart"
description: "Go from install to live memory graph in 90 seconds."
---

## 1. Start a Kiro session

[Start kiro-cli or open Kiro IDE in a project where kiro-learn is initialized]

## 2. Do some work

[Ask the agent to do something — e.g., "read the README and summarize the project"]

## 3. Check the dashboard

[Open http://localhost:21100/ui/ — show the event appearing in the event tail]

## 4. See memory extraction

[Wait a moment, refresh — show a memory record appearing in the graph]

## 5. Start a new session

[Start a fresh session, ask something related — show the retrieval context being injected]
```

### Page 4: Verify (`docs/getting-started/verify.mdx`)

**Tier:** User-facing (no draft-review gate — factual commands)

**Content outline:**
```
---
title: "Verify your install"
description: "Confirm the daemon is running and events are being captured."
---

## Check daemon status

```bash
kiro-learn status
```

## Check the health endpoint

```bash
curl http://localhost:21100/healthz
```

## Open the dashboard

[http://localhost:21100/ui/]

## Troubleshooting

### Daemon won't start
[Port conflict, missing Node, permission issues]

### No events appearing
[Hooks not installed, agent config not pointing to kiro-learn, shim errors]

### Extraction not working
[Missing kiro-cli, no Bedrock credentials, ACP errors]
```

### Page 5: How It Works (`docs/how-it-works.mdx`)

**Tier:** User-facing (draft-review gate required)

**Needs user input on:**
- How technical should this be? Conceptual overview or semi-technical?
- Should it include a diagram? (Mermaid or ASCII art?)
- How much to say about the privacy model here vs a dedicated page later?

**Content outline:**
```
---
title: "How it works"
description: "How kiro-learn captures events, builds memory records, and injects context."
---

## The three-phase cycle

### 1. Capture

[Shim intercepts hook events, builds structured events, POSTs to collector.
Events include: prompts, tool uses, session summaries.
Happens passively — no user action required.]

### 2. Extract

[Collector buffers events per-project, then sends batches to an LLM (via kiro-cli → Bedrock)
for extraction into structured memory records. Each record has a title, summary, concepts,
files touched, and observation type.]

### 3. Retrieve

[On the next session start, the shim queries the collector for relevant memories using FTS5
full-text search. Matching records are formatted as context and injected into the agent's
prompt via hook stdout.]

## Where your data lives

[Everything stored locally in ~/.kiro-learn/kiro-learn.db (SQLite).
Events and memory records never leave your machine except for extraction
(sent to Bedrock via kiro-cli for LLM processing).
<private> tags are stripped before storage.]

## The buffer pipeline

[Brief mention: events are buffered in per-project NDJSON files before extraction.
This decouples ingestion from extraction latency. When buffers grow too large,
compaction summarizes and evicts old records.]
```

### Page 6: CLI Guide (`docs/guides/kiro-cli.mdx`)

**Tier:** User-facing (draft-review gate required)

**Needs user input on:**
- How much detail on agent config structure?
- Should we show the actual hook JSON from the agent config?
- Any CLI-specific gotchas the user has encountered?

**Content outline:**
```
---
title: "Using kiro-learn with Kiro CLI"
description: "Full setup, hook lifecycle, agent config, and troubleshooting for kiro-cli."
---

## How it works with Kiro CLI

[The CLI shim reads stdin JSON from kiro-cli hook triggers and POSTs events to the collector.]

## Hook lifecycle

[agentSpawn → userPromptSubmit → postToolUse (repeated) → stop]
[Explain what each hook does and what data it captures]

## Agent configuration

[Show the relevant parts of the agent config JSON — the hooks section]
[Explain seed-then-merge: kiro-learn init creates an agent that inherits from kiro_default]

## Retrieval flow

[On userPromptSubmit: shim queries collector, writes context to stdout, agent reads it as hook output]

## Troubleshooting

[Common issues: agent not using kiro-learn hooks, shim not found, collector not running]
```

### Page 7: IDE Guide (`docs/guides/kiro-ide.mdx`)

**Tier:** User-facing (draft-review gate required)

**Needs user input on:**
- How much detail on the .kiro/hooks/ file format?
- Should we show the actual hook file content?
- MCP integration — how prominent should this be?

**Content outline:**
```
---
title: "Using kiro-learn with Kiro IDE"
description: "Hook files, MCP tools, and troubleshooting for the Kiro IDE."
---

## How it works with Kiro IDE

[The IDE shim reads event type from argv and payload from environment variables.]

## Hook files

[Show the .kiro/hooks/*.kiro.hook files that kiro-learn init creates]
[Three hooks: promptSubmit, postToolUse, agentStop]

## MCP integration

[The MCP server exposes three tools: search_memory, save_observation, save_session_summary]
[Explain when to use hooks vs MCP tools]

## Retrieval flow

[promptSubmit hook: shim queries collector, writes context to stdout]
[MCP: agent calls search_memory tool directly for pull-based retrieval]

## Troubleshooting

[Common issues: hooks not triggering, MCP server not registered, collector not running]
```

### Pages 8–16: Architecture Pages

**Tier:** Architecture (no draft-review gate — source-derivable)

All architecture pages follow a consistent structure:

```
---
title: "[Component name]"
description: "[One-line description]"
---

## What it does
[High-level responsibility]

## How it works
[Technical walkthrough with code pointers]

## Key design decisions
[Why it's built this way — trade-offs, alternatives considered]

## Code pointers
[File paths for the reader to explore]
```

**Page 8: Architecture Overview** — Five-layer diagram, dependency direction, modularity boundaries.

**Page 9: CLI Shim** — stdin parsing, hook dispatch table (agentSpawn/userPromptSubmit/postToolUse/stop), event building, session management, "exit 0 always" contract, body truncation.

**Page 10: IDE Shim** — argv[2] event type, USER_PROMPT env var, three event types (promptSubmit/postToolUse/agentStop), source.surface = 'kiro-ide', askAgent pattern for agentStop.

**Page 11: Buffer Pipeline** — NDJSON append-only files, flock-based locking, BufferEntry projection (what fields are dropped), BufferWatcher trigger thresholds, per-project isolation.

**Page 12: Extraction** — ACP client (kiro-cli acp --agent kiro-learn-compressor), XML framing (<tool_observation>), XML parsing (<memory_record>), circuit breaker (3 retries), concurrency limit (2 sessions), 30-second timeout, async after ingest response.

**Page 13: Compaction** — When it fires (buffer overflow), LLM-driven summarization of existing memory records, deterministic eviction of oldest records, atomic buffer replace, relationship to extraction.

**Page 14: Summarization** — Session summary flow (agentStop → session_summary event), pre-aggregated data approach, how summaries differ from observations, observation_type = 'session_summary'.

**Page 15: Retrieval** — FTS5 tokenization (porter unicode61), query construction (quoted phrase, " doubled), LIKE fallback when FTS5 rejects, latency budget on retrieval assembler, context string assembly.

**Page 16: Storage** — SQLite schema (events, memory_records, events_fts), STRICT tables, migrations 0001–0004, FTS5 configuration, StorageBackend interface (DI pattern), putEvent idempotency (INSERT OR IGNORE), putMemoryRecord PK collision rejection, transaction_time stamped on insert.

### README Update

**Tier:** User-facing (draft-review gate required)

**Needs user input on:**
- How to position kiro-learn relative to comparable tools (graphiti, claude-mem, mem0)
- Any badges to include (npm version, license, etc.)
- Whether to include a GIF/screenshot of the dashboard

**Content outline:**
```markdown
# kiro-learn

[Tagline — same as Introduction page]

[1-2 paragraph description]

## Quick start

```bash
npm install -g kiro-learn
cd your-project
kiro-learn init
kiro-learn start
```

## Documentation

Full docs at [kiro-learn.mintlify.app](https://kiro-learn.mintlify.app/)

## How it compares

| | kiro-learn | claude-mem | graphiti | mem0 |
|---|---|---|---|---|
| [comparison dimensions — needs user input] |

## Inspired by

[Credit claude-mem, note the rebuild for Kiro + AWS ecosystem]

## License

[MIT or whatever the current license is]
```

## Task Ordering Strategy

The pages are ordered to maximize efficiency:

1. **Scaffold verification** — confirm docs/ directory exists with all stubs, docs.json is correct.
2. **Architecture pages first** (8–16) — these are source-derivable and don't need user input. Writing them first builds momentum and lets the user see progress while we iterate on user-facing pages.
3. **User-facing pages** (1–7) — each one drafted, then paused for user review. Ordered by dependency: Introduction first (sets the voice), then Install → Quickstart → Verify (the onboarding funnel), then How It Works (conceptual bridge), then the two Guides.
4. **README last** — it borrows from the Introduction and Install pages, so writing it last avoids duplication of effort.

## Content Sources

| Page | Primary source | Needs user input? |
|---|---|---|
| Introduction | User voice + AGENTS.md overview | Yes — pitch, tagline, emphasis |
| Install | `src/installer/index.ts`, AGENTS.md installer section | Yes — confirm flow, prerequisites |
| Quickstart | End-to-end workflow knowledge | Yes — ideal "aha moment" |
| Verify | `src/installer/index.ts`, collector healthz | No — factual commands |
| How It Works | AGENTS.md architecture section | Yes — depth level, diagram style |
| CLI Guide | `src/shim/cli-agent/`, `src/shim/shared/`, AGENTS.md | Yes — framing, gotchas |
| IDE Guide | `src/shim/ide-hook/`, `src/mcp/`, AGENTS.md | Yes — framing, MCP prominence |
| Architecture Overview | AGENTS.md architecture section | No |
| CLI Shim | `src/shim/cli-agent/`, `src/shim/shared/` | No |
| IDE Shim | `src/shim/ide-hook/`, `src/shim/shared/` | No |
| Buffer Pipeline | `src/collector/buffer/` | No |
| Extraction | `src/collector/pipeline/acp-client.ts`, `xml-framer.ts`, `xml-parser.ts` | No |
| Compaction | `src/collector/buffer/compaction.ts` | No |
| Summarization | `src/shim/*/`, `src/collector/pipeline/` | No |
| Retrieval | `src/collector/retrieval/`, `src/collector/storage/sqlite/fts5.ts` | No |
| Storage | `src/collector/storage/sqlite/` | No |
| README | Introduction + Install pages, user voice | Yes — positioning, comparisons |

## Mintlify Components Reference

Components to use across pages:

- **`<Steps>`** — for sequential procedures (Install, Quickstart)
- **`<Callout>`** — for warnings (`type="warning"`), tips (`type="tip"`), and notes (`type="note"`)
- **`<CardGroup>` + `<Card>`** — for feature grids (Introduction) and navigation CTAs
- **`<CodeGroup>`** — for showing multiple command variants (e.g., npm vs yarn)
- **`<Tabs>`** — for CLI vs IDE alternatives on shared pages
- **`<Accordion>`** — for troubleshooting sections (collapsible Q&A)
- **Code blocks** — with language tags and optional titles (`title="~/.kiro-learn/settings.json"`)

## Error Handling

- If a source file referenced in the content outline doesn't exist or has changed significantly, note the discrepancy and ask the user before proceeding.
- If a Mintlify component doesn't render as expected, fall back to standard Markdown.
- If the user's feedback on a draft-review gate contradicts the requirements, update the requirements to match the user's intent.
