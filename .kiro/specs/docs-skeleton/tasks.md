# Implementation Plan: docs-skeleton

## Overview

Build the Mintlify documentation skeleton for kiro-learn under `docs/`: a Mintlify configuration, a shared-glyph brand system (favicon + light/dark logos), placeholder MDX pages for every navigation entry, and a `.mintignore` for drafts. The deploy path is Mintlify's Git integration — no CI build step lives in this repo. Work is ordered so every navigation reference resolves before the site is previewed locally, and cross-file invariants (P1–P15) are validated at the end by reading files on disk.

## Tasks

- [x] 1. Scaffold Mintlify configuration at `docs/docs.json` — R1, R2, R3, R11
  - [x] 1.1 Declare `$schema: "https://mintlify.com/docs.json"`, `theme: "linden"`, `name: "kiro-learn"` — R2, R11
  - [x] 1.2 Declare `colors.primary: "#8D47FF"`, `colors.light: "#C7A0FF"`, `colors.dark: "#7D25E6"` — R2, R9
  - [x] 1.3 Declare the five navigation groups in reader-journey order: `Overview`, `Getting started`, `Concepts`, `Guides`, `Architecture` — R3
  - [x] 1.4 Populate each group with the exact page IDs in the exact order specified (9 pages under `Architecture` covering every layer and cross-cutting flow) — R3
  - [x] 1.5 Wire asset refs: `favicon: "/favicon.svg"`, `logo.light: "/logo/light.svg"`, `logo.dark: "/logo/dark.svg"` — R2
  - [x] 1.6 Wire navbar `GitHub` link and primary `Install` button with `href: "/getting-started/install"` — R2, R6
  - [x] 1.7 Set `contextual.options` to `["copy", "view", "chatgpt", "claude"]` — R2
  - [x] 1.8 Set `footer.socials.github` to the same GitHub URL used in the navbar link — R2

- [x] 2. Author brand assets using one shared glyph — R7, R8, R9, R13
  - [x] 2.1 Create `docs/logo/light.svg` with `viewBox="0 0 124 23"`, the three-stroke + three-circle glyph, and the `kiro-learn` wordmark filled `#09090B` — R7, R8
  - [x] 2.2 Create `docs/logo/dark.svg` as a byte-identical copy of `light.svg` with only the wordmark fill changed to `#FFFFFF` — R7, R8
  - [x] 2.3 Create `docs/favicon.svg` with `viewBox="0 0 512 512"`, the glyph scaled by `512/23` (stroke-width `44`, top dot radius `72`, bottom dot radii `60`), and no wordmark — R7, R8
  - [x] 2.4 Use the `Inter, ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif` font stack on both wordmark `<text>` elements — R8
  - [x] 2.5 Keep SVGs script-free and free of external `xlink:href` references — R13

- [x] 3. Scaffold the Overview and Concepts MDX pages — R4, R5
  - [x] 3.1 Create `docs/introduction.mdx` with non-empty `title` and `description` frontmatter and body `_Coming soon._` — R4, R5
  - [x] 3.2 Create `docs/how-it-works.mdx` with non-empty `title` and `description` frontmatter and body `_Coming soon._` — R4, R5

- [x] 4. Scaffold the Getting started MDX pages — R4, R5, R6
  - [x] 4.1 Create `docs/getting-started/install.mdx` (target of the primary `Install` CTA) — R4, R5, R6
  - [x] 4.2 Create `docs/getting-started/quickstart.mdx` — R4, R5
  - [x] 4.3 Create `docs/getting-started/verify.mdx` — R4, R5

- [x] 5. Scaffold the Guides MDX pages — R4, R5
  - [x] 5.1 Create `docs/guides/kiro-cli.mdx` — R4, R5
  - [x] 5.2 Create `docs/guides/kiro-ide.mdx` — R4, R5

- [x] 6. Scaffold the Architecture MDX pages (one per layer + cross-cutting flows) — R3, R4, R5
  - [x] 6.1 Create `docs/architecture/overview.mdx` — R3, R4, R5
  - [x] 6.2 Create `docs/architecture/cli-shim.mdx` — R3, R4, R5
  - [x] 6.3 Create `docs/architecture/ide-shim.mdx` — R3, R4, R5
  - [x] 6.4 Create `docs/architecture/buffer-pipeline.mdx` — R3, R4, R5
  - [x] 6.5 Create `docs/architecture/extraction.mdx` — R3, R4, R5
  - [x] 6.6 Create `docs/architecture/compaction.mdx` — R3, R4, R5
  - [x] 6.7 Create `docs/architecture/summarization.mdx` — R3, R4, R5
  - [x] 6.8 Create `docs/architecture/retrieval.mdx` — R3, R4, R5
  - [x] 6.9 Create `docs/architecture/storage.mdx` — R3, R4, R5

- [x] 7. Add the `.mintignore` exclusion list — R10
  - [x] 7.1 Create `docs/.mintignore` with gitignore syntax — R10
  - [x] 7.2 Exclude `drafts/` and `*.draft.mdx` from the published site — R10

- [x] 8. Verify local authoring and Mintlify-owned deploy flow — R12
  - [x] 8.1 Run `mint dev` from `docs/` and confirm the site renders on `localhost:3000` with live reload — R12
  - [x] 8.2 Click through every sidebar entry and confirm each page renders its `title`, `description`, and `_Coming soon._` body — R4, R5, R12
  - [x] 8.3 Confirm the repo introduces no CI build step for the Docs_Site and no runtime npm dependency (Mintlify is an external service) — R1, R12
  - [x] 8.4 Push to the Mintlify-tracked branch and confirm the hosted Mintlify project builds and deploys via its Git integration — R12

- [x] 9. Correctness Property Validation (file-system-local, review-based — no test surface in this repo) — R1–R13
  - [x] 9.1 **P1 (`nav-page-referential-integrity`)** — For every page ID in `docs.json` navigation, manually confirm `docs/${pageId}.mdx` exists as a regular file — R4, P1
  - [x] 9.2 **P2 (`no-orphan-mdx-pages`)** — Walk `docs/**/*.mdx` (excluding `.mintignore` matches) and confirm each file is referenced by exactly one Page_ID in `docs.json` — R4, P2
  - [x] 9.3 **P3 (`frontmatter-present`)** — Open each MDX file and confirm line 1 opens YAML frontmatter with non-empty `title` and `description` string fields — R5, P3
  - [x] 9.4 **P4 (`asset-refs-resolve`)** — Confirm `docs/favicon.svg`, `docs/logo/light.svg`, and `docs/logo/dark.svg` all exist on disk — R2, P4
  - [x] 9.5 **P5 (`cta-resolves-to-page`)** — Confirm `navbar.primary.href` starts with `/` and its suffix matches a declared Page_ID — R6, P5
  - [x] 9.6 **P6 (`palette-config-literal`)** — Confirm `colors` in `docs.json` equals `{ primary: "#8D47FF", light: "#C7A0FF", dark: "#7D25E6" }` exactly — R2, R9, P6
  - [x] 9.7 **P7 (`palette-svg-consistency`)** — Inspect each SVG and confirm the glyph stroke/fill colors are exactly `{ #8D47FF, #C7A0FF, #7D25E6 }`, with `#09090B` / `#FFFFFF` appearing only as wordmark fills in the two logo files — R9, P7
  - [x] 9.8 **P8 (`glyph-identity-logos`)** — Diff the glyph markup in `logo/light.svg` against `logo/dark.svg` and confirm they are identical up to whitespace, with only the wordmark fill differing — R7, R8, P8
  - [x] 9.9 **P9 (`glyph-identity-favicon`)** — Multiply every glyph coordinate and radius in `logo/dark.svg` by `512/23`, round to integer, and confirm the result equals the glyph geometry in `favicon.svg` — R7, P9
  - [x] 9.10 **P10 (`wordmark-font-stack`)** — Confirm both logo `<text>` elements declare the `Inter, ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif` font stack — R8, P10
  - [x] 9.11 **P11 (`mintlify-schema-valid`)** — Open `docs.json` in a JSON-Schema-aware editor and confirm no inline schema violations are reported against `https://mintlify.com/docs.json`; `mint dev` succeeding from task 8.1 is the runtime confirmation — R11, P11
  - [x] 9.12 **P12 (`nav-group-count-and-order`)** — Confirm `navigation.groups` has exactly five entries in the order `Overview`, `Getting started`, `Concepts`, `Guides`, `Architecture` — R3, P12
  - [x] 9.13 **P13 (`contextual-menu-options`)** — Confirm `contextual.options` equals `["copy", "view", "chatgpt", "claude"]` exactly — R2, P13
  - [x] 9.14 **P14 (`github-url-consistency`)** — Confirm the `GitHub` navbar link `href` equals `footer.socials.github` — R2, P14
  - [x] 9.15 **P15 (`nav-matches-architecture-layers`)** — Confirm the `Architecture` group pages are exactly `overview`, `cli-shim`, `ide-shim`, `buffer-pipeline`, `extraction`, `compaction`, `summarization`, `retrieval`, `storage`, in that order — R3, P15

## Completion Summary

This spec is closed out. The docs skeleton is live under `docs/` with a schema-valid `docs.json`, a shared-glyph brand system, placeholder MDX pages for every navigation entry in the Overview → Getting started → Concepts → Guides → Architecture reader journey, and a `.mintignore` that keeps drafts out of the published site. Local authoring works via `mint dev`, deploy is Git-triggered by the connected Mintlify project, and the fifteen correctness properties (P1–P15) have been verified by file-system-local review. Prose for individual pages will land in later specs that map 1:1 to the navigation groups.
