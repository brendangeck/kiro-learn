# Requirements Document

## Introduction

The `docs-skeleton` feature establishes the Mintlify-based documentation site for kiro-learn. It defines a single source of truth for navigation (`docs/docs.json`), a self-contained brand system (favicon plus light and dark logos derived from one shared glyph), and a placeholder MDX page for every route declared in the navigation. The site follows the reader journey Overview → Getting started → Concepts → Guides → Architecture and is deployed by a Mintlify project connected to this repository — no build step for the docs lives in this repo's CI. The scope is the *shape* of the site: its taxonomy, its brand, and the referential integrity between configuration, assets, and content. Prose for individual pages lands in later specs that map 1:1 to the navigation groups.

## Glossary

- **Docs_Site**: The Mintlify-rendered documentation site whose source lives under `docs/` at the root of the kiro-learn repository.
- **Mintlify_Config**: The JSON document at `docs/docs.json` that configures site identity, theme, brand colors, navigation, assets, and chrome. Validated against `https://mintlify.com/docs.json`.
- **Navigation**: The `navigation.groups` array inside `Mintlify_Config` that lists, in display order, every group and every page ID exposed by the Docs_Site.
- **Page_ID**: A string in `navigation.groups[*].pages` that maps to an MDX file on disk via the rule `docs/${page_id}.mdx`.
- **MDX_Page**: A file under `docs/` with extension `.mdx`, consisting of YAML frontmatter (`title`, `description`) followed by body content.
- **Brand_Assets**: The three SVG files `docs/favicon.svg`, `docs/logo/light.svg`, and `docs/logo/dark.svg`.
- **Glyph**: The shared visual mark used by all Brand_Assets — three dots arranged as a triangle (top, bottom-left, bottom-right) connected by three thick strokes.
- **Wordmark**: The `kiro-learn` text rendered to the right of the Glyph in the two logo SVGs. Absent from the favicon.
- **Brand_Palette**: The three purple values `#8D47FF` (primary), `#C7A0FF` (light), `#7D25E6` (dark) shared between `Mintlify_Config.colors` and the Glyph fills.
- **Mintignore_File**: The `docs/.mintignore` file that excludes draft content from the published site using gitignore syntax.
- **CTA_Link**: The `navbar.primary` button in `Mintlify_Config`, which points at the Getting started install page.

## Requirements

### Requirement 1: Site scaffolding lives under `docs/`

**User Story:** As a maintainer, I want all documentation source files to live under a single top-level `docs/` directory, so that the docs site is cleanly separable from application code and the Mintlify project only needs one path to track.

#### Acceptance Criteria

1. THE Docs_Site SHALL be sourced entirely from files under the `docs/` directory at the repository root.
2. THE `docs/` directory SHALL contain `docs.json`, `favicon.svg`, a `logo/` subdirectory, a `getting-started/` subdirectory, a `guides/` subdirectory, an `architecture/` subdirectory, and one or more top-level MDX files.
3. THE repository SHALL NOT introduce a runtime npm dependency to ship the Docs_Site.

### Requirement 2: Mintlify configuration declares site identity and chrome

**User Story:** As a new kiro-learn user opening the Docs_Site, I want consistent branding and navigation to be present on every page, so that I can orient myself and trust I am on the right site.

#### Acceptance Criteria

1. THE Mintlify_Config SHALL declare `$schema` equal to `https://mintlify.com/docs.json`.
2. THE Mintlify_Config SHALL declare `theme` equal to `linden`.
3. THE Mintlify_Config SHALL declare `name` equal to `kiro-learn`.
4. THE Mintlify_Config SHALL declare `colors.primary` equal to `#8D47FF`, `colors.light` equal to `#C7A0FF`, and `colors.dark` equal to `#7D25E6`.
5. THE Mintlify_Config SHALL declare `favicon` equal to `/favicon.svg`, `logo.light` equal to `/logo/light.svg`, and `logo.dark` equal to `/logo/dark.svg`.
6. THE Mintlify_Config SHALL declare a navbar link with `label` equal to `GitHub` and `href` equal to `https://github.com/brendangeck/kiro-learn`.
7. THE Mintlify_Config SHALL declare a primary navbar button with `type` equal to `button`, `label` equal to `Install`, and `href` equal to `/getting-started/install`.
8. THE Mintlify_Config SHALL declare `contextual.options` equal to the array `["copy", "view", "chatgpt", "claude"]`.
9. THE Mintlify_Config SHALL declare `footer.socials.github` equal to `https://github.com/brendangeck/kiro-learn`.
10. WHEN the navbar `GitHub` link href and the footer `github` social URL are compared, THE Mintlify_Config SHALL hold them equal.

### Requirement 3: Navigation taxonomy follows the five-group reader journey

**User Story:** As a new kiro-learn user landing on the docs site, I want a predictable reader journey that starts with an introduction and ends with architecture deep-dives, so that I can progress from "what is this" through "how do I use it" to "how does it work inside".

#### Acceptance Criteria

1. THE Mintlify_Config SHALL declare exactly five navigation groups.
2. THE Mintlify_Config SHALL order the navigation groups as `Overview`, `Getting started`, `Concepts`, `Guides`, `Architecture`.
3. THE `Overview` group SHALL contain exactly the page ID `introduction`.
4. THE `Getting started` group SHALL contain exactly the page IDs `getting-started/install`, `getting-started/quickstart`, `getting-started/verify`, in that order.
5. THE `Concepts` group SHALL contain exactly the page ID `how-it-works`.
6. THE `Guides` group SHALL contain exactly the page IDs `guides/kiro-cli`, `guides/kiro-ide`, in that order.
7. THE `Architecture` group SHALL contain exactly the page IDs `architecture/overview`, `architecture/cli-shim`, `architecture/ide-shim`, `architecture/buffer-pipeline`, `architecture/extraction`, `architecture/compaction`, `architecture/summarization`, `architecture/retrieval`, `architecture/storage`, in that order.
8. THE `Architecture` group SHALL include one page per layer of the kiro-learn architecture (shim, collector, buffer, extraction, storage) plus the cross-cutting flows (compaction, summarization, retrieval) and an `overview` entry.

### Requirement 4: Every navigation entry resolves to an MDX file

**User Story:** As an existing user looking up an architecture deep-dive, I want every sidebar link to lead to a real page, so that I never hit a broken navigation entry while reading.

#### Acceptance Criteria

1. FOR every page ID listed in any `navigation.groups[*].pages` array, THE Docs_Site SHALL provide the corresponding file at `docs/${page_id}.mdx` as a regular file.
2. IF a `navigation.groups[*].pages` entry does not resolve to an existing MDX file, THEN THE Docs_Site build SHALL fail with an error naming the missing file.
3. THE Docs_Site SHALL NOT ship any MDX file under `docs/` that is excluded by `.mintignore` yet still referenced from `Navigation`.
4. THE Docs_Site SHALL NOT contain any MDX file under `docs/` (outside of `.mintignore`-excluded paths) that is not referenced by exactly one Page_ID in `Navigation`.

### Requirement 5: Every MDX page has non-empty frontmatter and skeleton body

**User Story:** As a contributor authoring new MDX content, I want every page to start from a consistent placeholder with valid frontmatter, so that the sidebar label, page header, and search index are populated from day one.

#### Acceptance Criteria

1. THE Docs_Site SHALL ensure every MDX_Page opens with YAML frontmatter on line 1.
2. THE Docs_Site SHALL ensure every MDX_Page frontmatter contains a non-empty `title` string field.
3. THE Docs_Site SHALL ensure every MDX_Page frontmatter contains a non-empty `description` string field.
4. WHILE a page body is still in skeleton state, THE MDX_Page body SHALL contain exactly `_Coming soon._`.
5. WHEN a page is filled in during a later spec, THE MDX_Page SHALL retain its `title` and `description` frontmatter fields as non-empty strings.

### Requirement 6: Primary install CTA resolves to a real page

**User Story:** As a new kiro-learn user clicking the "Install" button in the top navbar, I want to be taken to the installation instructions, so that the most important call to action on the site always works.

#### Acceptance Criteria

1. THE Mintlify_Config SHALL set `navbar.primary.href` to a string beginning with `/`.
2. WHEN the leading `/` is stripped from `navbar.primary.href`, THE resulting suffix SHALL equal a page ID declared in `Navigation`.
3. IF `navbar.primary.href` does not resolve to a declared page ID, THEN THE Docs_Site build SHALL fail referential-integrity validation.

### Requirement 7: Brand assets share one canonical Glyph

**User Story:** As a maintainer reviewing brand presentation in light and dark mode, I want the favicon and both logos to render the same underlying mark, so that kiro-learn reads as one brand across the tab icon, the light sidebar, and the dark sidebar.

#### Acceptance Criteria

1. THE Brand_Assets SHALL consist of exactly three SVG files: `docs/favicon.svg`, `docs/logo/light.svg`, `docs/logo/dark.svg`.
2. THE Glyph SHALL contain exactly three `<line>` elements with stroke color `#8D47FF`, `stroke-linecap` equal to `round`, and identical `stroke-width` per SVG, whose endpoints form a triangle with one top vertex above two bottom vertices that share a y-coordinate.
3. THE Glyph SHALL contain exactly three `<circle>` elements, one centered on each triangle vertex, with fills `#8D47FF` at the top vertex, `#7D25E6` at the bottom-left vertex, and `#C7A0FF` at the bottom-right vertex.
4. THE Glyph SHALL set the top-vertex circle radius strictly greater than the two bottom-vertex circle radii, and the two bottom-vertex circle radii equal to each other.
5. WHEN the Glyph geometry in `logo/light.svg` is compared to the Glyph geometry in `logo/dark.svg`, THE two SHALL be identical up to whitespace.
6. WHEN the Glyph geometry in `logo/dark.svg` is scaled by the uniform factor `512/23` and rounded to integer coordinates, THE result SHALL equal the Glyph geometry in `favicon.svg`.
7. THE `logo/light.svg` and `logo/dark.svg` SHALL declare `viewBox` equal to `0 0 124 23`, stroke-width `2.4`, top-vertex center `(11.5, 5)`, bottom-left vertex center `(5, 18)`, bottom-right vertex center `(18, 18)`, top dot radius `3.6`, and bottom dot radii `3`.
8. THE `favicon.svg` SHALL declare `viewBox` equal to `0 0 512 512`, stroke-width `44`, top-vertex center `(256, 128)`, bottom-left vertex center `(128, 384)`, bottom-right vertex center `(384, 384)`, top dot radius `72`, and bottom dot radii `60`.

### Requirement 8: Logo files render the `kiro-learn` wordmark in theme-appropriate color

**User Story:** As a reader switching between light and dark themes, I want the `kiro-learn` wordmark to stay readable against the surrounding chrome, so that the brand stays legible regardless of theme.

#### Acceptance Criteria

1. THE `logo/light.svg` SHALL contain a `<text>` element with textual content `kiro-learn`, position `(28, 17)`, font size `17`, font weight `700`, letter-spacing `-0.02em`, and fill `#09090B`.
2. THE `logo/dark.svg` SHALL contain a `<text>` element with textual content `kiro-learn`, position `(28, 17)`, font size `17`, font weight `700`, letter-spacing `-0.02em`, and fill `#FFFFFF`.
3. THE Wordmark SHALL declare `font-family` equal to `Inter, ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif` in both logo files.
4. THE `favicon.svg` SHALL NOT contain a Wordmark.
5. WHEN the Glyph portions are held constant, THE only visual difference between `logo/light.svg` and `logo/dark.svg` SHALL be the Wordmark fill color.

### Requirement 9: Brand palette is consistent across config and assets

**User Story:** As a reviewer validating that docs.json and MDX files stay consistent, I want the brand colors declared in `docs.json` to match the colors used in the SVG Brand_Assets, so that one palette change updates both the theme and the mark.

#### Acceptance Criteria

1. THE Mintlify_Config SHALL declare `colors.primary`, `colors.light`, and `colors.dark` equal to the Brand_Palette values `#8D47FF`, `#C7A0FF`, `#7D25E6` respectively.
2. THE set of stroke and fill colors used by the Glyph within each Brand_Asset SHALL equal exactly `{#8D47FF, #C7A0FF, #7D25E6}`.
3. THE `logo/light.svg` SHALL additionally use `#09090B` only as the Wordmark fill.
4. THE `logo/dark.svg` SHALL additionally use `#FFFFFF` only as the Wordmark fill.
5. THE Brand_Assets SHALL NOT reference any color outside of the set `{#8D47FF, #C7A0FF, #7D25E6, #09090B, #FFFFFF}`.

### Requirement 10: Mintignore keeps drafts out of the published site

**User Story:** As a contributor drafting a new page in-tree, I want draft files to stay out of the published Docs_Site, so that I can iterate in the repo without leaking work-in-progress to readers.

#### Acceptance Criteria

1. THE Docs_Site SHALL provide a file at `docs/.mintignore` using gitignore syntax.
2. THE Mintignore_File SHALL exclude the path `drafts/` from the published site.
3. THE Mintignore_File SHALL exclude the glob `*.draft.mdx` from the published site.
4. WHERE a file or directory is matched by the Mintignore_File, THE Docs_Site build SHALL omit that file or directory from the deployed output.

### Requirement 11: Mintlify configuration validates against the published schema

**User Story:** As a contributor editing `docs.json`, I want editor tooling to flag schema violations inline, so that I catch mistakes before I push.

#### Acceptance Criteria

1. THE Mintlify_Config SHALL validate successfully against the JSON Schema located at `https://mintlify.com/docs.json`.
2. IF the Mintlify_Config is not valid JSON, THEN THE Docs_Site build SHALL fail with a JSON parse error.
3. IF the Mintlify_Config violates the Mintlify schema, THEN THE Docs_Site build SHALL fail with a schema-validation error.
4. THE Mintlify_Config SHALL declare the `$schema` field so that editors with JSON Schema support surface violations inline.

### Requirement 12: Authoring and deploy flow is Mintlify-owned

**User Story:** As a contributor authoring new MDX content, I want a one-command local preview and a Git-push-driven deploy, so that my write-edit-publish loop does not require CI changes in this repo.

#### Acceptance Criteria

1. WHEN an author runs the Mintlify CLI in dev mode against the `docs/` directory, THE Docs_Site SHALL render on `localhost:3000` with live reload.
2. THE repository SHALL NOT own a CI build step for the Docs_Site.
3. WHEN a commit is pushed to the Mintlify-tracked branch, THE Mintlify project SHALL build and deploy the Docs_Site via its Git integration.
4. THE Docs_Site deploy pipeline SHALL NOT require any kiro-learn npm scripts to run.

### Requirement 13: The skeleton surfaces no secrets and no external script dependencies

**User Story:** As a reviewer looking at what the docs skeleton pulls in, I want it to be free of secrets and free of unreviewed outbound script sources, so that the docs site can be shipped without additional security review.

#### Acceptance Criteria

1. THE Docs_Site SHALL NOT contain any secret, token, or credential anywhere under `docs/`.
2. THE only outbound URLs hardcoded under `docs/` SHALL be the GitHub repository URL `https://github.com/brendangeck/kiro-learn` and the Mintlify schema URL `https://mintlify.com/docs.json`.
3. THE Brand_Assets SHALL NOT contain `<script>` elements or external `xlink:href` references.
4. WHERE the `contextual.options` array exposes third-party "send page to" targets such as `chatgpt` or `claude`, THE Docs_Site SHALL only transmit page content when a reader explicitly invokes one of those options.

## Correctness Properties

The following properties are static, file-system-local invariants. Each can be checked by reading the files under `docs/` and comparing them against the Mintlify_Config; none requires a running server. IDs and names are stable and are reused verbatim from the design document so that tasks can reference them.

| # | Name | Statement |
|---|---|---|
| P1 | `nav-page-referential-integrity` | For every page ID `p` listed in any `navigation.groups[*].pages`, the file `docs/${p}.mdx` exists and is a regular file. |
| P2 | `no-orphan-mdx-pages` | Every `.mdx` file under `docs/` (excluding anything matched by `.mintignore`) is referenced by exactly one page ID in `docs.json`. |
| P3 | `frontmatter-present` | Every `.mdx` file under `docs/` opens with YAML frontmatter containing non-empty `title` and `description` string fields. |
| P4 | `asset-refs-resolve` | `config.favicon`, `config.logo.light`, and `config.logo.dark` each resolve, after stripping the leading `/`, to an existing file under `docs/`. |
| P5 | `cta-resolves-to-page` | `config.navbar.primary.href` starts with `/`, and its suffix equals one of the declared page IDs in `config.navigation`. |
| P6 | `palette-config-literal` | `config.colors` equals `{ primary: "#8D47FF", light: "#C7A0FF", dark: "#7D25E6" }` exactly. |
| P7 | `palette-svg-consistency` | The set of brand colors appearing as stroke or fill in each of `logo/light.svg`, `logo/dark.svg`, and `favicon.svg` is exactly `{ #8D47FF, #C7A0FF, #7D25E6 }` (plus the wordmark fill in the two logo files). No other colors appear. |
| P8 | `glyph-identity-logos` | The glyph (three strokes + three circles) in `logo/light.svg` is byte-for-byte identical to the glyph in `logo/dark.svg` up to whitespace. Only the wordmark fill differs between the two files. |
| P9 | `glyph-identity-favicon` | The glyph in `favicon.svg` is `logo/dark.svg`'s glyph scaled by a single uniform factor (`512/23`), rounded to integer coordinates for every vertex and radius. |
| P10 | `wordmark-font-stack` | The wordmark `<text>` element in both logo files uses the font-family `Inter, ui-sans-serif, system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif`. |
| P11 | `mintlify-schema-valid` | `docs.json` validates against `https://mintlify.com/docs.json`. |
| P12 | `nav-group-count-and-order` | `config.navigation.groups` has exactly five entries, with `group` names (in order): `Overview`, `Getting started`, `Concepts`, `Guides`, `Architecture`. |
| P13 | `contextual-menu-options` | `config.contextual.options` equals `["copy", "view", "chatgpt", "claude"]` exactly. |
| P14 | `github-url-consistency` | The `href` in `config.navbar.links[*]` whose `label === "GitHub"` equals `config.footer.socials.github`. |
| P15 | `nav-matches-architecture-layers` | The `Architecture` group contains exactly one page per 5-layer architecture concern plus the cross-cutting flows, in the fixed order: `overview`, `cli-shim`, `ide-shim`, `buffer-pipeline`, `extraction`, `compaction`, `summarization`, `retrieval`, `storage`. |

### Property-to-requirement coverage

- P1 validates Requirement 4 (acceptance criteria 4.1, 4.2).
- P2 validates Requirement 4 (acceptance criterion 4.4).
- P3 validates Requirement 5 (acceptance criteria 5.1, 5.2, 5.3).
- P4 validates Requirement 2 (acceptance criterion 2.5).
- P5 validates Requirement 6 (all acceptance criteria).
- P6 validates Requirement 2 (acceptance criterion 2.4) and Requirement 9 (acceptance criterion 9.1).
- P7 validates Requirement 9 (acceptance criteria 9.2, 9.5).
- P8 validates Requirement 7 (acceptance criterion 7.5) and Requirement 8 (acceptance criterion 8.5).
- P9 validates Requirement 7 (acceptance criteria 7.6, 7.7, 7.8).
- P10 validates Requirement 8 (acceptance criterion 8.3).
- P11 validates Requirement 11 (all acceptance criteria).
- P12 validates Requirement 3 (acceptance criteria 3.1, 3.2).
- P13 validates Requirement 2 (acceptance criterion 2.8).
- P14 validates Requirement 2 (acceptance criterion 2.10).
- P15 validates Requirement 3 (acceptance criteria 3.7, 3.8).
