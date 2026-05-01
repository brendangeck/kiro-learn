# Design: v0 Documentation

## Overview

This design describes the kiro-learn documentation site as it exists today — the navigation structure, page tiering, voice rules, component choices — plus outlines for the two pages that still need to be written (Install and the README update).

This document has been **reverse-spec'd** to match the realized structure. The original design sketched 16 pages organized as Introduction, 3 Getting-started pages, How It Works, 2 Guides, Architecture overview, and 8 Architecture deep-dives. During Introduction review the user cut How It Works, Verify, and the two Guides; folded Quickstart into Install; added a Privacy concept page; and moved the Introduction into the Getting started group. This document reflects that final structure.

## Realized structure

The site has **three navigation groups**. All sixteen non-scaffold files exist in `docs/`.

```text
Getting started
├── introduction            docs/getting-started/introduction.mdx     [written]
└── install                 docs/getting-started/install.mdx          [stub — Task 9]

Concepts
├── projects                docs/concepts/projects.mdx                [written]
├── event-types             docs/concepts/event-types.mdx             [written]
├── event-buffer            docs/concepts/event-buffer.mdx            [written]
└── privacy                 docs/concepts/privacy.mdx                 [written]

Architecture
├── overview                docs/architecture/overview.mdx            [written]
├── kiro-cli-shim           docs/architecture/kiro-cli-shim.mdx       [written]
├── kiro-ide-shim           docs/architecture/kiro-ide-shim.mdx       [written]
├── collector               docs/architecture/collector.mdx           [written]
├── extraction              docs/architecture/extraction.mdx          [written]
├── compaction              docs/architecture/compaction.mdx          [written]
├── summarization           docs/architecture/summarization.mdx       [written]
├── retrieval               docs/architecture/retrieval.mdx           [written]
└── database                docs/architecture/database.mdx            [written]
```

Plus `README.md` at the repo root, still to be updated (Task 10).

## Page tiers

Pages fall into three tiers, each with different voice rules and review requirements:

| Tier | Pages | Voice | Draft-review gate |
|------|-------|-------|-------------------|
| **User-facing** | Introduction, Install, README | Developer-casual. Direct, practical, no marketing fluff. Establishes the project's voice. | **Required** — the user's pitch decisions cannot be derived from source. |
| **Concept** | Projects, Event types, Event buffer, Privacy | Technical-but-readable. Design-level terminology, accessible to a reader who hasn't read source. | Not required — derivable from AGENTS.md plus a read of the relevant source module. |
| **Architecture** | Overview + 8 deep-dives | Technical-but-readable with implementation detail. Named components, source pointers, precise terminology. | Not required — source-derivable by design. |

The Introduction went through its draft-review gate during Task 8. Install and README draft-review gates remain.

## Key design decisions

### 1. Three groups, not five

The original sketch had five groups (Overview, Getting started, Concepts, Guides, Architecture). The site ships with three because:

- **Overview collapsed into Getting started.** A single-page Overview group added a navigation click for no content gain. The Introduction now lives inside Getting started.
- **Guides were cut.** The CLI and IDE guides would have duplicated the Architecture shim pages at a shallower depth. The audience that wants "how do I use the IDE integration" is the same audience that's willing to read the `kiro-ide-shim` architecture page, so one page per shim is enough.

### 2. Install absorbs Quickstart and Verify

A developer evaluating kiro-learn wants to go from `npm install -g` to "I see a memory record in the dashboard" on one page. Splitting that into Install → Quickstart → Verify adds friction. The merged page handles commands, walkthrough, and troubleshooting in one linear flow.

### 3. Privacy promoted to a Concept page

The Introduction originally carried a short "Privacy, briefly" section. Once the user asked for all privacy content to be consolidated, a dedicated Concept page became the right place — it's a topic that rewards depth (what leaves the machine, escape hatches, per-event field audit) and gets linked from every user-facing surface.

### 4. How It Works cut entirely

The original sketch had a How It Works page as the "conceptual bridge between Getting Started and Architecture." In practice, the Architecture overview's system and sequence diagrams serve that role, and the Privacy concept page picks up the data-lives-locally story that was the How-It-Works page's other hook. The standalone page wasn't earning its slot.

### 5. Mermaid everywhere

All diagrams use Mermaid. No ASCII art. This keeps diagrams source-controlled, editable, and consistent with the Architecture overview.

### 6. Design-level language on Concept and Architecture pages

Pages avoid internal type names (`KiroMemEvent`), framework names (`Cloudscape React`), and package-manager specifics where they don't serve comprehension. Code pointers (file paths, function names) appear on Architecture pages when readers might want to find the source, but they don't dominate prose.

### 7. Consistent component naming

The Architecture overview establishes the canonical names — **Kiro CLI Shim**, **Kiro IDE Shim**, **Collector**, **Workers**, **Database** — and every other page uses those exact names. No drift to "Storage" or "Buffer Pipeline" or "Daemon."

## Mintlify components used

Components that appear across the site, chosen for how they improve the specific page:

- **`<CardGroup>` + `<Card>`** — feature grids on the Introduction and "Related pages" footers on every non-trivial page.
- **`<Steps>`** — sequential procedures (Install commands, algorithms).
- **`<Callout>`** — warnings (`type="warning"`), tips (`type="tip"`), notes (`type="note"`). Used sparingly so they stay noticed.
- **`<CodeGroup>`** — reserved for multi-variant commands if needed (e.g., npm vs yarn). Not in use yet.
- **`<Tabs>`** — reserved for CLI-vs-IDE alternatives on shared pages. Not in use yet.
- **`<Accordion>`** — reserved for troubleshooting sections (collapsible Q&A). Candidate for the Install page.

Tables, fenced code blocks (with language tags), and Mermaid code blocks appear throughout.

## Outlines for remaining pages

### Install and quickstart (Task 9, `docs/getting-started/install.mdx`)

Tier: **User-facing** (draft-review gate required).

Needs user input on: confirmation of the exact install flow, whether quickstart shows CLI or IDE (or both via tabs), the specific example task to use in the walkthrough, whether to include dashboard screenshots.

```
---
title: "Install and quickstart"
description: "Install kiro-learn, initialize your project, and see your first memory."
---

## Prerequisites

- Node.js 22 or later
- Kiro CLI or Kiro IDE
- AWS credentials for extraction (kiro-learn uses your Bedrock access via kiro-cli)

## Install

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
    What init does: [scope detection, agent config seed-then-merge, hook files, compressor agent, UI asset copy]
  </Step>
  <Step title="Start the collector">
    ```bash
    kiro-learn start
    ```
    What start does: [launches daemon on 127.0.0.1:21100, deploys UI, starts watchers]
  </Step>
</Steps>

## Project vs global install

[--global-only flag, when to use each, how scope detection decides]

## Your first session

<Steps>
  <Step title="Open a Kiro session">
    [CLI: run kiro-cli; IDE: open your project in Kiro IDE]
  </Step>
  <Step title="Do one simple task">
    [Example prompt — needs user input on the right example]
  </Step>
  <Step title="Watch the event tail">
    [Open http://127.0.0.1:21100/ui/, point out events arriving in the tail]
  </Step>
  <Step title="Wait for extraction">
    [After the idle timer or size threshold fires, point out the memory record appearing in the graph]
  </Step>
  <Step title="Start a new session">
    [Open a new session, ask something related, show retrieved context in the agent's response]
  </Step>
</Steps>

## The dashboard

[Screenshot or description. Health indicator, metric cards, memory graph, event tail, memory detail panel.]

## Troubleshooting

<AccordionGroup>
  <Accordion title="Daemon won't start">
    [Port conflict on 21100, Node version too old, permission issues]
  </Accordion>
  <Accordion title="No events appearing">
    [Hooks not installed (re-run kiro-learn init), agent not using kiro-learn config, shim errors (check stderr)]
  </Accordion>
  <Accordion title="Events appear but no memory records">
    [kiro-cli not installed, Bedrock credentials missing, ACP errors in daemon log]
  </Accordion>
</AccordionGroup>

## Related pages

<CardGroup cols={2}>
  <Card title="Projects" href="/concepts/projects">
    How kiro-learn scopes memory per repository
  </Card>
  <Card title="Privacy" href="/concepts/privacy">
    What lives on your machine and what leaves
  </Card>
  <Card title="Architecture overview" href="/architecture/overview">
    How the pieces fit together
  </Card>
  <Card title="Event buffer" href="/concepts/event-buffer">
    What happens between capture and extraction
  </Card>
</CardGroup>
```

### README update (Task 10, `README.md`)

Tier: **User-facing** (draft-review gate required).

Needs user input on: positioning against mem0/Graphiti/Letta/claude-mem, whether to include badges (npm version, license, CI status), whether to include a screenshot or animated GIF of the dashboard.

```markdown
# kiro-learn

**Continuous learning for Kiro agents.**

[1–2 paragraph description matching the Introduction page's problem/solution framing, lightly compressed for GitHub readers scanning quickly.]

## Quick start

```bash
npm install -g kiro-learn
cd your-project
kiro-learn init
kiro-learn start
```

Full setup and walkthrough: [kiro-learn.mintlify.app/getting-started/install](https://kiro-learn.mintlify.app/getting-started/install)

## Documentation

[Published docs at kiro-learn.mintlify.app — link with a brief description of what's there: Getting started, Concepts, Architecture]

## How it compares

[Brief positioning section]

- **mem0** — hosted memory layer for generic agents
- **Graphiti** — temporal knowledge graphs, requires Neo4j
- **Letta** — full stateful-agent runtime (replaces your framework)
- **claude-mem** — same shape as kiro-learn but Claude-specific

kiro-learn is Kiro-native, local-by-default, passive (no CLAUDE.md to maintain), project-scoped, and AWS/Bedrock-aware.

## Inspired by

[Credit claude-mem by Alex Newman. Link to the original repo.]

## License

[MIT or whatever the current license is]
```

## Content sources for remaining pages

| Page | Primary sources |
|------|-----------------|
| Install and quickstart | `src/installer/index.ts`, `src/installer/bin.ts`, AGENTS.md installer section, collector healthz, viewer UI dashboard |
| README | Introduction page (for tone), Install page (for commands), user voice (for positioning) |

## Link integrity

Every internal link on every page points to a page that exists in the realized structure. When the Introduction review cut How It Works, Verify, Quickstart, and the Guides, the following link surgery was performed:

- `docs/getting-started/introduction.mdx` — removed a link to `/how-it-works`, replaced the "Privacy, briefly" section with a link out to `/concepts/privacy`.
- `docs/concepts/privacy.mdx` — links forward to `/architecture/collector`, `/architecture/extraction`, `/architecture/database`, `/concepts/projects`. No dead links.
- All Architecture pages — their existing "Related pages" card groups only reference other Architecture and Concept pages, none of which were cut.

Task 11 (Final sweep) will grep the site for any residual references to `/how-it-works`, `/getting-started/quickstart`, `/getting-started/verify`, or `/guides/` and remove them if any survived.

## Error handling

- **If a source file referenced in an outline has changed significantly** when the author starts writing, the author should note the discrepancy and pause to confirm with the user before proceeding.
- **If a Mintlify component doesn't render as expected**, fall back to standard Markdown.
- **If user feedback during a draft-review gate contradicts this design**, update the design to match the user's intent, then revise the page. The design document is not a contract — it's a reverse-spec that should stay honest about what the site actually is.
