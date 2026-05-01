# Implementation Plan: v0 Documentation

## Overview

Write the actual content for the kiro-learn documentation site and update the project README. The site ships with three navigation groups — **Getting started**, **Concepts**, and **Architecture** — served from `docs/` via Mintlify. The scaffold (`docs.json`, logos, `.mintignore`) is complete.

This plan has been **reverse-spec'd** to match the current state of the repo. Tasks 1–8 document work that is already complete. Tasks 9–10 are the remaining forward work. The historical trail of abandoned pages (How It Works, Verify, CLI Guide, IDE Guide) is intentionally not preserved here — the spec reflects the site that exists, not the site that was once sketched.

## Style Guide

- **Mermaid over ASCII** for all diagrams.
- **Design-level language** — describe what components do, not implementation type names (no `KiroMemEvent`, no "Cloudscape React").
- **Consistent naming** — "Kiro CLI Shim", "Kiro IDE Shim", "Collector", "Workers", "Database" (not "Storage", not "Buffer Pipeline").
- **Dashed lines = async/non-blocking** in sequence diagrams.
- **No icons on individual pages** — icons belong on section headers in `docs.json` only.
- **v0 version dropdown** in `docs.json` navigation.
- **Page titles match sidebar and deep-dive cards.**
- **"Related pages" footer** on every non-trivial page linking to adjacent concepts/architecture.
- **Headings start at H2** on the page body; the page title from frontmatter is the H1.
- **Introduction and Install live together** in the Getting started group.
- **Cut pages stay cut.** Content that belonged to deleted pages (privacy model detail, CLI/IDE usage walkthroughs) now lives on the Concept or Architecture page whose scope naturally absorbs it.

## Navigation structure (ground truth)

```text
Getting started
├── introduction          docs/getting-started/introduction.mdx
└── install               docs/getting-started/install.mdx

Concepts
├── projects              docs/concepts/projects.mdx
├── event-types           docs/concepts/event-types.mdx
├── event-buffer          docs/concepts/event-buffer.mdx
└── privacy               docs/concepts/privacy.mdx

Architecture
├── overview              docs/architecture/overview.mdx
├── kiro-cli-shim         docs/architecture/kiro-cli-shim.mdx
├── kiro-ide-shim         docs/architecture/kiro-ide-shim.mdx
├── collector             docs/architecture/collector.mdx
├── extraction            docs/architecture/extraction.mdx
├── compaction            docs/architecture/compaction.mdx
├── summarization         docs/architecture/summarization.mdx
├── retrieval             docs/architecture/retrieval.mdx
├── database              docs/architecture/database.mdx
└── viewer                docs/architecture/viewer.mdx
```

## Tasks

- [x] 1. Scaffold
  - [x] 1.1 `docs/docs.json` configured with Mintlify schema, `v0` version dropdown, primary/light/dark colors, GitHub navbar link, Install CTA button
  - [x] 1.2 Logos and favicon in place (`docs/logo/{light,dark}.svg`, `docs/favicon.svg`)
  - [x] 1.3 `.mintignore` configured

- [x] 2. Architecture Overview (`docs/architecture/overview.mdx`)
  - [x] 2.1 Simplified system diagram (Developer → Kiro IDE/CLI → Daemon → Database) in Mermaid
  - [x] 2.2 Sequence diagram for a full agent turn (prompt submit, tool uses, agent stop, async extraction)
  - [x] 2.3 Component descriptions: Kiro IDE/CLI, Collector, Workers, Database
  - [x] 2.4 Deep-dive cards linking to all eight sub-pages

- [x] 3. Kiro CLI Shim (`docs/architecture/kiro-cli-shim.mdx`)
  - [x] 3.1 What it does: translates Kiro CLI hook events into structured events for the daemon
  - [x] 3.2 How hooks reach the shim: stdin JSON from the Kiro CLI runtime
  - [x] 3.3 The four hook events (agentSpawn, userPromptSubmit, postToolUse, stop) and what each captures
  - [x] 3.4 Session management and project detection
  - [x] 3.5 Retrieval: how context flows back to the agent via stdout
  - [x] 3.6 "Exit 0 always" contract — never blocks the agent

- [x] 4. Kiro IDE Shim (`docs/architecture/kiro-ide-shim.mdx`)
  - [x] 4.1 What it does: translates Kiro IDE hook events into structured events for the daemon
  - [x] 4.2 How hooks reach the shim: `argv[2]` for event type, `USER_PROMPT` env for payload
  - [x] 4.3 The three hook events (promptSubmit, postToolUse, agentStop) and what each captures
  - [x] 4.4 Why agentStop uses `askAgent` instead of `runCommand`
  - [x] 4.5 How it differs from the CLI shim (input format, event names, `source.surface` tag)

- [x] 5. Collector and workers (four pages)
  - [x] 5.1 Collector (`docs/architecture/collector.mdx`) — HTTP API, cleaning pipeline (dedup + privacy scrub), storage, buffer append, retrieval path, viewer UI
  - [x] 5.2 Extraction (`docs/architecture/extraction.mdx`) — ACP client, batch XML framing, circuit breaker, concurrency limits, timeouts, async design
  - [x] 5.3 Compaction (`docs/architecture/compaction.mdx`) — when it fires, LLM-driven summarization, deterministic eviction, buffer replace feedback loop
  - [x] 5.4 Summarization (`docs/architecture/summarization.mdx`) — hook path vs MCP path, what a session summary contains vs an observation

- [x] 6. Retrieval and database (two pages)
  - [x] 6.1 Retrieval (`docs/architecture/retrieval.mdx`) — FTS5 search, LIKE fallback, latency budget, context assembly
  - [x] 6.2 Database (`docs/architecture/database.mdx`) — schema (events, memory_records, events_fts), migrations 0001–0004, STRICT tables, FTS5 tokenizer

- [x] 7. Concepts (four pages)
  - [x] 7.1 Projects (`docs/concepts/projects.mdx`) — the unit of memory isolation, upward marker walk, the 15 project markers, global project fallback, `kiro-learn init` creating scope, multi-agent sharing, namespace format
  - [x] 7.2 Event types (`docs/concepts/event-types.mdx`) — the four kinds (prompt, tool_use, session_summary, note), the three body shapes (text, message, json), envelope fields, pipeline mapping, rationale for four-not-one
  - [x] 7.3 Event buffer (`docs/concepts/event-buffer.mdx`) — per-project NDJSON staging, why buffering exists, triggers for extraction and compaction, clear-on-success, resilience
  - [x] 7.4 Privacy (`docs/concepts/privacy.mdx`) — what lives on your machine, what leaves (extraction via your own Bedrock), the `<private>` tag mechanics, escape hatches (per-project delete, uninstall, skip extraction), per-event fields stored

- [x] 8. Introduction (`docs/getting-started/introduction.mdx`)
  - [x] 8.1 H1 "Continuous learning for Kiro agents" (no subtitle after)
  - [x] 8.2 "The problem" section — three paragraphs: session amnesia, why manual memory tools fail, how passive capture differs
  - [x] 8.3 "What you get" — six-card grid (memory across sessions, local and private, visual dashboard, MCP tools, CLI and IDE, per-project isolation)
  - [x] 8.4 "Get started" CTA card to Install
  - [x] 8.5 **DRAFT-REVIEW GATE**: tagline, problem framing, and scope reviewed with user
  - [x] 8.6 Structural refactor executed during review: moved intro into Getting started, removed the Overview group, deleted the How It Works stub, deleted the Guides group, deleted the Verify stub, merged Quickstart into Install, added the Privacy concept page
  - _Requirements: 1.1–1.6_

- [x] 9. Install and quickstart (`docs/getting-started/install.mdx`)
  - [x] 9.1 Read `src/installer/index.ts` and `src/installer/bin.ts` to confirm the install flow and CLI flags
  - [x] 9.2 Draft the page
    - Prerequisites: Node ≥ 22, Kiro CLI or Kiro IDE, AWS credentials for extraction
    - Install commands: `npm install -g kiro-learn`, `kiro-learn init`, `kiro-learn start`
    - What `kiro-learn init` does: scope detection, agent config seed-then-merge, hook file deployment, UI asset copy, compressor agent install
    - Project-scoped vs `--global-only` install
    - Quickstart walkthrough: start a session, do one task, watch the event tail, see extraction produce a memory record, start a new session and see context injected
    - Dashboard callout: `http://127.0.0.1:21100/ui/`
    - Short troubleshooting list: daemon won't start (port conflict), no events appearing (hooks not wired), extraction silently failing (missing `kiro-cli`)
  - [x] 9.3 **DRAFT-REVIEW GATE**: present draft and confirm commands, prerequisites, the "aha moment", CLI vs IDE emphasis
  - [x] 9.4 Revise based on feedback and finalize
  - _Requirements: 2.1–2.5, 3.1–3.4, 4.1–4.3 (merged)_

- [x] 10. Viewer (`docs/architecture/viewer.mdx`)
  - [x] 10.1 Read `ui/src/` to confirm component structure, polling behavior, and graph layout
  - [x] 10.2 Draft the page
    - What it does: visual interface for inspecting memory state, served by the collector at `/ui/*`
    - Components: health indicator, metric cards, memory graph (React Flow + dagre), Recent Events table, memory detail panel
    - Polling: fetches `/healthz`, `/v1/stats`, `/v1/events?limit=50`, `/v1/memories?limit=500` every 10 seconds
    - Graph: three node types (project hubs, concept nodes, memory nodes), edges showing relationships
    - Dark mode toggle persisted to localStorage
    - Static asset serving with path-traversal protection and SPA fallback
    - Dev mode: `npm run dev:ui` on `127.0.0.1:5173` with proxy to collector
  - [x] 10.3 Add "Related pages" card group linking to Collector, Database, Architecture overview
  - [x] 10.4 Add Viewer to the Architecture navigation group in `docs/docs.json`

- [x] 11. README update (`README.md`)
  - [x] 11.1 Draft the new README
    - Tagline matching the Introduction page ("Continuous learning for Kiro agents.")
    - 1–2 paragraph description
    - Quick-start snippet (install + init + start)
    - Link to the published docs site
    - Comparison section referencing mem0, Graphiti, Letta, claude-mem — named, characterized, with kiro-learn's differentiators (Kiro-native, local-by-default, passive, AWS/Bedrock-aware)
    - Inspiration credit to `claude-mem`
    - License
  - [x] 11.2 **DRAFT-REVIEW GATE**: present draft and confirm positioning, comparison framing, whether to add badges or screenshots
  - [x] 11.3 Revise based on feedback and finalize
  - _Requirements: 10.1–10.5_

- [x] 12. Reorder Architecture sidebar to match data flow
  - [x] 12.1 Update `docs/docs.json` — reorder the `Architecture` group's `pages` array to follow the actual runtime path a piece of data takes through the system, top-to-bottom:
    1. `architecture/overview`
    2. `architecture/kiro-cli-shim`
    3. `architecture/kiro-ide-shim`
    4. `architecture/collector`
    5. `architecture/extraction`
    6. `architecture/compaction`
    7. `architecture/summarization`
    8. `architecture/retrieval`
    9. `architecture/database`
    10. `architecture/viewer`
  - [x] 12.2 Confirm the order on the rendered site matches the sidebar JSON and that no page title or in-page "next/previous" auto-navigation conflicts with the new order
  - [x] 12.3 Audit each Architecture page's **Related pages** card group to make sure the highlighted neighbor(s) make sense given the new reading order (e.g., Collector's "next" neighbor is Extraction; Extraction's is Compaction; etc.) — reorder or reweight cards where the reading flow now makes a different neighbor the natural first click
  - [x] 12.4 Spot-check the two cross-group links that reference Architecture pages (`concepts/event-buffer` → Extraction/Compaction/Collector, `concepts/event-types` → Kiro CLI shim/Kiro IDE shim/Extraction/Summarization) — these are already flow-aligned, but confirm after the reorder
  - [x] 12.5 Confirm the reorder does not break any existing deep links (paths stay the same, only the sidebar order changes — no renames, no moves)
  - _Rationale: the current sidebar is roughly alphabetical (Compaction before Extraction before Retrieval), but the actual data flow is shim → collector → extraction → compaction → summarization → retrieval → database → viewer. A reader paging top-to-bottom should see the system assemble itself in the order data actually moves through it._

- [x] 13. Discoverability — GitHub, Google, and npm
  - [x] 13.1 **npm keywords and homepage** — update `package.json`:
    - Point `homepage` at the published docs site (`https://kiro-learn.mintlify.app`) so npm's sidebar links readers to docs instead of the GitHub README
    - Expand `keywords` with the terms developers actually search for: `mcp`, `mcp-server`, `sqlite`, `fts5`, `ide`, `cli`, `passive-memory`, `session-memory`, `context-injection`, `rag`, `knowledge-base`, `claude-mem-alternative` (keep existing keywords)
  - [x] 13.2 **README SEO passes** — edit `README.md`:
    - Add a one-line "What is kiro-learn?" H2 answer near the top with the high-intent keywords ("agent memory", "Kiro", "AWS Bedrock", "local-first", "MCP") written into prose rather than a bullet list — Google's snippet extractor prefers prose
    - Rename `## How it compares` to `## Alternatives` (both render the same way for humans; "alternatives to mem0" / "alternatives to claude-mem" is the query pattern people type)
    - Add a short `## FAQ` section at the bottom with 3–5 questions ("Does kiro-learn send my code to the cloud?", "Does it work with Claude or only Kiro?", "How is this different from CLAUDE.md or AGENTS.md?", "Is there a hosted version?") — FAQ markup is a well-known SERP booster and each answer seeds a long-tail search term
    - Add explicit link text (not bare URLs) for every outbound link so GitHub's summarizer and Google both see the anchor text
  - [x] 13.3 **Mintlify site metadata** — update `docs/docs.json`:
    - Add a top-level `metadata` block with `description` (one sentence matching the README tagline), `og:title`, `og:description`, and `og:image` pointing at `/assets/dashboard-preview.gif` (or a dedicated `og-image.png` if a static image is preferred)
    - Add `seo.indexing: "navigable"` so only pages in the sidebar are indexed (keeps stale drafts out of Google)
    - Add a `robots.txt` / sitemap reference if Mintlify's default is not sufficient for the custom domain
  - [x] 13.4 **GitHub repository surface** — these are set via the GitHub UI / repo files, not `package.json`:
    - Populate the GitHub repo **About** box: one-line description, link to the docs site, and repo **topics** (`kiro`, `agent-memory`, `mcp`, `aws-bedrock`, `sqlite`, `rag`, `claude-mem`, `continuous-learning`, `developer-tools`) — topics are one of GitHub's strongest internal search signals
    - Add a **social preview image** (repo Settings → Social preview) using the same OG image as Mintlify — this is what LinkedIn, Twitter, and Slack render when the repo URL is pasted
    - Add `CONTRIBUTING.md`, `SECURITY.md`, and a minimal `CODE_OF_CONDUCT.md` (or link to the Contributor Covenant) — GitHub's **Community Standards** checklist rewards completeness with a health badge and some SERP lift
    - Add `.github/ISSUE_TEMPLATE/bug_report.md` and `feature_request.md`, plus `.github/PULL_REQUEST_TEMPLATE.md` — these don't directly affect search but they improve the signal-to-noise of issues, which is what people land on from Google
  - [x] 13.5 **Cross-linking** — confirm every surface points at every other:
    - README links to the docs site (already present)
    - Docs site links to the GitHub repo (already present in navbar)
    - `package.json` `homepage` → docs site (new, from 13.1)
    - `package.json` `repository` → GitHub (already present)
    - `package.json` `bugs` → GitHub issues (already present)
    - Docs site footer has a link back to npm (add under `footer.socials` if Mintlify supports it, otherwise as a plain navbar link)
  - [x] 13.6 Ask user for sign-off on the discoverability changes before applying them — several of these (GitHub topics, repo Settings → Social preview, `homepage` change on a published package) have downstream effects worth confirming
  - _Rationale: the docs themselves are strong, but the package is hard to find. Google, GitHub, and npm each have their own ranking signals, and the current surface leaves most of them empty. These changes cost a few hours and compound over the life of the project._

- [x] 14. Final sweep
  - [x] 14.1 Every page renders in Mintlify preview without frontmatter or MDX errors
  - [x] 14.2 All internal links resolve — no references to deleted pages (`/how-it-works`, `/getting-started/quickstart`, `/getting-started/verify`, `/guides/*`)
  - [x] 14.3 No page contains "Coming soon." placeholder text
  - [x] 14.4 Architecture pages all end in a "Related pages" card group
  - [x] 14.5 Ask user for final sign-off
  - _Requirements: 11.1–11.5_

## Notes

- **Reverse-spec'd.** Tasks 1–8 were reconstructed from the actual files in `docs/` at the time of this rewrite. The original task list (with How It Works, Verify, separate Quickstart, and two Guides) was superseded by structural decisions made during Introduction review; it is not preserved here.
- **Each remaining task is one page or one artifact.** Keeps diffs reviewable and feedback focused.
- **Draft-review gates** remain on the two user-facing surfaces still to write: the merged Install page and the README. Architecture and Concept pages are source-derivable and were written without gates.
- **Terminology** uses the names from the Architecture Overview diagram (Kiro CLI Shim, Kiro IDE Shim, Collector, Workers, Database) — propagated across every page.
- **Out of scope** for this spec (intentionally): API reference, blog posts, "For AWS Teams" section, Mintlify scaffold changes beyond navigation, `AGENTS.md` updates.

## Downstream cleanup (not blocking)

`requirements.md` and `design.md` still reference the abandoned pages (How It Works as Requirement 5, Verify as Requirement 4, separate Quickstart as Requirement 3, CLI Guide as Requirement 6, IDE Guide as Requirement 7). They should be reconciled to match this task list, but the docs can ship without that reconciliation happening first. Suggested follow-up: a single pass that collapses Requirements 2+3+4 into a unified "Install and quickstart" requirement, deletes Requirements 5, 6, and 7, and updates the design document's page table and outlines to match.
