# Implementation Log: cosmos-gl-graph

> **Reverse spec.** All tasks below are complete. This document records
> what was built, not what was planned. See `design.md` for
> architecture and `requirements.md` for per-requirement traceability.

## Summary

| Metric | Value |
|---|---|
| New/rewritten source files | 6 (`ui/src/*`) |
| Source lines added | ~783 |
| New test files | 10 (`test/unit/*`) |
| Tests passing | 57 cosmos-specific; 867 total project-wide |
| Typecheck | clean |
| Lint | clean |
| Build | clean |
| Backend changes | none |

## Phases

### Phase 1 — Dependency swap and scaffolding

- [x] 1.1 Added `@cosmos.gl/graph` as a dependency.
- [x] 1.2 Added `@interacta/css-labels` as a dependency (used by
  `CosmosLabels`).
- [x] 1.3 Added `@playwright/test` and `globals` as devDependencies
  (dev harness + lint config).
- [x] 1.4 Removed `sigma`, `@react-sigma/core`, `graphology`,
  `graphology-layout-forceatlas2`, `graphology-types` from
  `package.json`.
- [x] 1.5 Deleted obsolete files: `ui/src/graph/layout.ts`,
  `ConceptNode.tsx`, `MemoryNode.tsx`, `ProjectNode.tsx`.
- [x] 1.6 Added `.kiro-dev/` to `.gitignore`.

### Phase 2 — Pure transform

- [x] 2.1 Wrote `ui/src/graph/transform.ts` (240 LoC).
  - Types: `NodeKind`, `NodeId`, `ProjectInfo`, `PackedTheme`,
    `CosmosGraphData`.
  - Public API: `transform(memories, projects, theme)`.
  - Emission order: concepts → memories → projects (render-back-to-front
    so projects paint on top).
  - Stable-sort inputs by primary key for layout stability across polls.
  - FNV-1a hash for deterministic ring-seeded positions near
    `SPACE_CENTER = 2048` on `SPACE_SIZE = 4096` (matches demo seed).
  - Per-kind sizes: project = 12, memory/concept = 4.
  - `indexToLabel` populated with `display_name` for projects, `null`
    elsewhere.
  - No cluster data, no filter flags, no shape variation.

### Phase 3 — Theme and legend

- [x] 3.1 Wrote `ui/src/graph/theme.ts` (53 LoC).
  - `hexToRgba01(hex)` — parses `#RRGGBB` / `#RRGGBBAA`, throws on
    malformed input.
  - `getPackedTheme(darkMode)` — returns the demo's palette in dark mode
    and a light-surface variant in light mode. Colors: `#ED69B4`
    projects, `#4B5BBF` memory/concept (always the same), `#5F74C2`
    edges on dark / `#4B5BBF` on light, `#2d313a` / `#f2f3f3`
    backgrounds.
  - Pruned all pre-migration palette exports (`LIGHT_COLORS`,
    `DARK_COLORS`, `getNodeColors`, `getGraphColors`, `graphTheme`,
    `NodeColorScheme`).
- [x] 3.2 Wrote `ui/src/graph/GraphLegend.tsx` (38 LoC) with two
  swatches: "Project" (pink) and "Memory / Concept" (blue-purple).

### Phase 4 — Label overlay class

- [x] 4.1 Wrote `ui/src/components/CosmosLabels.ts` (83 LoC) — direct
  port of the cosmos.gl demo's `CosmosLabels`. Wraps
  `@interacta/css-labels` `LabelRenderer`. Three methods:
  `setPointIndexToLabel`, `update(graph)`, `destroy()`. Labels carry
  `color: 'white'` for readable text on the dark pill background.

### Phase 5 — React component

- [x] 5.1 Wrote `ui/src/components/CosmosGraph.tsx` (266 LoC).
  - Props: `{ data, backgroundColor, onPointClick }`.
  - Mount effect: construct `Graph` + `CosmosLabels`.
  - Data effect: upload buffers in fixed order, compute project
    indices, update the label map, call
    `trackPointPositionsByIndices` after `render()`.
  - Incremental-append optimization: when new data's `indexToId` is a
    superset of the previous, preserve existing simulation positions
    instead of resetting.
  - Visual effect: `setConfigPartial({ backgroundColor })` only.
  - Engine callbacks (hover, click, tick, zoom) use latest-props ref
    so callback identity changes don't rebuild the engine.
  - Hover + click exploration uses cosmos.gl native
    `focusedPointIndex` / `highlightedPointIndices` /
    `outlinedPointIndices` / `highlightedLinkIndices`.
  - JSX: container with `data-testid="cosmos-canvas"`, sibling
    labels div with `data-testid="cosmos-labels"` and
    `pointer-events: none`.
  - Cleanup: destroy labels, destroy engine.

### Phase 6 — Outer shell

- [x] 6.1 Wrote `ui/src/components/MemoryGraph.tsx` (103 LoC).
  - Preserved public prop shape `{ memories, projects, loading, error,
    darkMode, onNodeClick }`.
  - Memoized `theme` and `data`.
  - Loading / error / empty placeholders.
  - Click routing: memory → `(memory, null)`, concept → `(null, str)`,
    project → no-op on `onNodeClick`, background → `(null, null)`.
  - 500px-height canvas container.

### Phase 7 — Tests

- [x] 7.1 `test/unit/cosmos-transform.test.ts` — 8 example-based tests
  for emission order, bi-map population, link construction, per-kind
  sizes, cross-namespace scoping, buffer shape, sort stability.
- [x] 7.2 `test/unit/cosmos-transform-shapes.property.test.ts` — P1
  (buffer shape invariants).
- [x] 7.3 `test/unit/cosmos-transform-bimap.property.test.ts` — P2 (link
  validity), P3 (bi-map round-trip), P5 (label assignment).
- [x] 7.4 `test/unit/cosmos-transform-bounds.property.test.ts` — P4
  (color bounds + project > leaf size).
- [x] 7.5 `test/unit/cosmos-transform-determinism.property.test.ts` — P6
  (structurally-equal inputs → element-equal outputs).
- [x] 7.6 `test/unit/cosmos-graph.test.tsx` — 11 component tests
  covering single engine/labels ctor, config shape, data-setter order,
  project-only tracking, visual-delta no-op, callback identity
  stability, click dispatch variants, unmount cleanup. Uses
  `vi.doMock` + dynamic import for both `@cosmos.gl/graph` and
  `@interacta/css-labels`.
- [x] 7.7 `test/unit/cosmos-labels.test.ts` — 7 tests for
  construction, label emission shape, draw count, empty-label
  fallback, map swap, trim-on-shrink, destroy propagation.
- [x] 7.8 `test/unit/theme-packed.test.ts` — 5 tests for
  `hexToRgba01` correctness and both-mode palette values.
- [x] 7.9 `test/unit/memory-graph-shell.test.tsx` — 9 tests for
  canvas/legend render, loading/error/empty states, click routing.
- [x] 7.10 `test/unit/no-react-in-transform.test.ts` — guard test
  enforcing `transform.ts` has no React / cosmos.gl imports.
- [x] 7.11 `test/helpers/cosmos-arb.ts` — fast-check arbitraries
  (`memoryArrayArb`, `projectArrayArb`, `packedThemeArb`,
  `transformInputArb`).

### Phase 8 — Dev harness

- [x] 8.1 Wrote `scripts/dev-harness.mjs` (69 LoC) — Playwright script
  that screenshots the Vite dev server and prints a JSON report of
  canvas dimensions, label counts, and console errors.
- [x] 8.2 Added an ESLint override for `scripts/**/*.mjs` enabling Node
  + browser globals (the harness runs in both contexts via
  `page.evaluate`).

### Phase 9 — Visual verification (iterative)

The development loop used the dev harness against two real projects'
worth of live kiro-learn data:

- [x] 9.1 Established baseline by stripping all simulation parameters
  back to cosmos.gl defaults — observed organic spread driven by link
  topology alone.
- [x] 9.2 Ported the demo's two-color palette (pink hubs, blue-purple
  leaves, blue-purple edges, dark canvas) via
  `getPackedTheme(darkMode)`.
- [x] 9.3 Enabled labels for project hubs. Tracked positions after
  `render()` so the track call survives the engine's upload pipeline.
- [x] 9.4 Added `color: 'white'` to label emission so pill text reads
  against the renderer's dark default background.
- [x] 9.5 Bumped project point size to `12` (3× default) so hubs
  stand out at any zoom.
- [x] 9.6 Added light-mode palette as a surface swap — same accents,
  light canvas, slightly darker edge for contrast against near-white.

### Phase 10 — Cleanup

- [x] 10.1 Removed all `#region DEBUG` instrumentation from
  `CosmosGraph.tsx` (`window.__cosmos_debug` backdoor).
- [x] 10.2 Removed 12 one-shot debug probe scripts under `scripts/`,
  keeping only `dev-harness.mjs` as the permanent tool.
- [x] 10.3 Pruned dead theme exports.
- [x] 10.4 Removed the obsolete `test/unit/graph-transform.test.ts`
  and `test/unit/ui-app-smoke.test.tsx` (pre-migration React-Flow era).

### Phase 11 — Final validation

- [x] 11.1 `npm run typecheck` — clean.
- [x] 11.2 `npm run lint` — clean.
- [x] 11.3 `npm run test` — 867 tests across 184 files, all passing.
- [x] 11.4 `npm run build` — both backend (`tsc`) and UI (`vite build`)
  succeed.
- [x] 11.5 `git diff --stat src/` — empty, confirming no backend
  changes.

## Deferred / out of scope

Intentionally not implemented — see `requirements.md § Cut from
original scope` for the full list. Headliners:

- Filter checkboxes
- Cluster force
- Memory/concept labels
- Label sampling at zoom
- Point shape variation
- `window.__cosmos_debug` dev hook (removed in Phase 10)
