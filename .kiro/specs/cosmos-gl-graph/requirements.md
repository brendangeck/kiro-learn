# Requirements Document: cosmos-gl-graph

> **Reverse spec.** Every requirement here is implemented and backed by
> tests in `test/unit/`. Requirements that were proposed but cut during
> implementation are listed in the "Cut from original scope" section at
> the end.

## Introduction

The kiro-learn viewer UI renders a GPU-accelerated force graph of
projects, memories, and concepts using
[`@cosmos.gl/graph`](https://github.com/cosmosgl/graph) (MIT, WebGL2).
Visual palette and label overlay are ported from the cosmos.gl
storybook's [`point-labels` demo](https://github.com/cosmosgl/graph/tree/main/src/stories/beginners/point-labels).

## Glossary

- **Cosmos_Engine** — the `@cosmos.gl/graph` `Graph` instance.
- **Transform_Module** — `ui/src/graph/transform.ts`. Pure function
  producing Float32Array buffers and bi-map lookups. No React, no DOM,
  no cosmos.gl imports.
- **Theme_Module** — `ui/src/graph/theme.ts`. Exports `getPackedTheme`
  and `hexToRgba01`.
- **CosmosGraph_Component** — `ui/src/components/CosmosGraph.tsx`. Owns
  the Cosmos_Engine and a CosmosLabels_Overlay.
- **CosmosLabels_Overlay** — `ui/src/components/CosmosLabels.ts`. Wraps
  `@interacta/css-labels` for DOM-overlay label rendering.
- **Memory_Graph** — `ui/src/components/MemoryGraph.tsx`. Outer shell
  with loading/error/empty states, legend, click routing.
- **Node_Kind** — `'project' | 'memory' | 'concept'`.
- **Point_Index** — integer in `[0, pointCount)`.
- **Node_Id** — `project:<namespace>` | `memory:<record_id>` |
  `concept:<namespace>:<concept>`.
- **Cosmos_Data** — the return type of `transform()`. Typed buffers plus
  bi-map structures.
- **Dev_Harness** — `scripts/dev-harness.mjs`, a Playwright script for
  visual iteration.

---

## Requirements

### Requirement 1: License-Compatible Engine

1. THE Memory_Graph SHALL render using `@cosmos.gl/graph` as the sole
   force-graph engine.
2. THE `package.json` SHALL declare `@cosmos.gl/graph` and
   `@interacta/css-labels` as dependencies.
3. THE `package.json` SHALL NOT list `sigma`, `@react-sigma/core`,
   `graphology`, `graphology-layout-forceatlas2`, or `graphology-types`.

### Requirement 2: Public Prop Shape Unchanged

1. THE Memory_Graph's public prop shape SHALL remain
   `{ memories, projects, loading, error, darkMode, onNodeClick }` so
   `App.tsx` imports are unchanged.
2. WHILE `loading` is true, THE Memory_Graph SHALL render a loading
   indicator in place of the canvas.
3. WHILE `error` is a non-null string, THE Memory_Graph SHALL render an
   error indicator in place of the canvas.
4. WHILE `memories` is an empty array, THE Memory_Graph SHALL render an
   empty-state message in place of the canvas.

### Requirement 3: Click Routing

1. WHEN a user clicks a memory point, THE Memory_Graph SHALL invoke
   `onNodeClick(memory, null)` with the domain `MemoryRecord`.
2. WHEN a user clicks a concept point, THE Memory_Graph SHALL invoke
   `onNodeClick(null, conceptString)`.
3. WHEN a user clicks a project point, THE Memory_Graph SHALL NOT invoke
   `onNodeClick` with a memory or concept payload.
4. WHEN a user clicks the canvas background or clicks the same point
   twice, THE Memory_Graph SHALL invoke `onNodeClick(null, null)`.
5. WHEN a user clicks any point, THE CosmosGraph_Component SHALL apply
   a full visual highlight (ring on the clicked point, neighborhood
   highlighted, everything else greyed out) via cosmos.gl's native
   `focusedPointIndex` / `highlightedPointIndices` /
   `highlightedLinkIndices` config.

### Requirement 4: Dark Mode

1. WHEN `darkMode` changes value, THE CosmosGraph_Component SHALL update
   the engine's `backgroundColor` via `setConfigPartial` WITHOUT resetting
   the running simulation's layout positions.
2. THE Theme_Module SHALL export `getPackedTheme(darkMode: boolean)`
   returning `projectFill`, `memoryFill`, `conceptFill`, `edgeColor`
   (four-float tuples in `[0, 1]`), `backgroundColor` (CSS string), and
   `darkMode` (boolean).
3. IN dark mode, `backgroundColor` SHALL be `#2d313a`; IN light mode it
   SHALL be `#f2f3f3`.
4. IN both modes, `projectFill` SHALL equal `hexToRgba01('#ED69B4')`
   (the demo's hot-pink hub color).
5. IN both modes, `memoryFill` SHALL equal `conceptFill` SHALL equal
   `hexToRgba01('#4B5BBF')` (the demo's blue-purple leaf color).
6. THE Theme_Module SHALL export `hexToRgba01(hex)` converting `#RRGGBB`
   or `#RRGGBBAA` to a four-float tuple in `[0, 1]` and throwing on
   malformed input.

### Requirement 5: Pure Transform Module

1. THE Transform_Module SHALL export `transform(memories, projects, theme)`
   returning a Cosmos_Data value.
2. THE Transform_Module SHALL NOT import from `react`, `react-dom`, or
   `@cosmos.gl/graph`.
3. THE repository SHALL contain a guard test
   (`test/unit/no-react-in-transform.test.ts`) enforcing criterion 2.
4. WHEN `transform()` is invoked twice with structurally-equal arguments,
   it SHALL return Cosmos_Data values whose Float32Arrays are
   element-for-element equal and whose bi-map arrays are deep-equal.

### Requirement 6: Cosmos_Data Buffer Shape

For every Cosmos_Data, with `pointCount = indexToId.length` and
`linkCount = links.length / 2`:

1. `positions.length` SHALL equal `2 * pointCount`.
2. `colors.length` SHALL equal `4 * pointCount`.
3. `sizes.length` SHALL equal `pointCount`.
4. `links.length` SHALL equal `2 * linkCount` and `linkCount` SHALL be an
   integer.
5. `linkColors.length` SHALL equal `4 * linkCount`.
6. `indexToKind.length` and `indexToLabel.length` SHALL each equal
   `pointCount`.
7. EVERY entry in `colors` and `linkColors` SHALL be in the closed
   interval `[0, 1]`.
8. EVERY link endpoint index in `links` SHALL be a non-negative integer
   less than `pointCount`.

### Requirement 7: Bi-Directional Lookup

1. THE Cosmos_Data SHALL expose `idToIndex: ReadonlyMap<NodeId, number>`
   and `indexToId: readonly NodeId[]`.
2. FOR every integer `i` in `[0, pointCount)`,
   `idToIndex.get(indexToId[i]) === i`.
3. `idToIndex.size` SHALL equal `pointCount`.
4. THE Cosmos_Data SHALL expose `indexToKind: readonly NodeKind[]`
   parallel to `indexToId`.
5. THE Cosmos_Data SHALL expose
   `memoryIndexByRecordId: ReadonlyMap<string, number>` for resolving a
   memory click back to its `MemoryRecord`.
6. Node ids SHALL follow the convention:
   - Project: `project:<namespace>`
   - Memory: `memory:<record_id>`
   - Concept: `concept:<namespace>:<concept>`

### Requirement 8: Label Assignment

1. THE Cosmos_Data SHALL expose
   `indexToLabel: readonly (string | null)[]` of length `pointCount`.
2. FOR every Point_Index `i` of kind `project`, `indexToLabel[i]` SHALL
   be a non-empty string (the project's `display_name`).
3. FOR every Point_Index `i` of kind `memory` or `concept`,
   `indexToLabel[i]` SHALL be `null`.

### Requirement 9: Node Emission Order

1. THE Transform_Module SHALL emit nodes in render-back-to-front order:
   unique `(namespace, concept)` pairs first (in first-seen order over
   the stable-sorted memory list), then memories (in `record_id` sort
   order), then projects (in `namespace` sort order).
2. WHEN two concept strings differ only by namespace (same concept text,
   different namespaces), THE Transform_Module SHALL emit two distinct
   concept points.
3. THE Transform_Module SHALL stable-sort `memories` by `record_id` and
   `projects` by `namespace` before emission, so structurally-equal
   inputs in any order produce identical output.

### Requirement 10: Edge Construction

1. FOR every `MemoryRecord m` whose namespace matches a rendered project,
   THE Transform_Module SHALL emit exactly one link between `m`'s memory
   point and that project's point.
2. FOR every `MemoryRecord m` and every concept `c` in `m.concepts`, THE
   Transform_Module SHALL emit exactly one link between `m`'s memory
   point and the `(m.namespace, c)` concept point.
3. THE Transform_Module SHALL NOT emit direct `project → concept` links.

### Requirement 11: Per-Kind Point Sizes

1. Project points SHALL have a `sizes` value of `12` (3× engine default).
2. Memory and concept points SHALL have a `sizes` value of `4` (engine
   default).

### Requirement 12: Deterministic Seed Positions

1. THE Transform_Module SHALL seed initial `positions` deterministically
   via FNV-1a hash of the Node_Id such that identical ids receive
   identical initial `(x, y)` values across invocations.
2. THE initial position of every point SHALL lie within a box of half-
   width `SPACE_SIZE * 0.005` centered on `(SPACE_CENTER, SPACE_CENTER)`
   where `SPACE_SIZE = 4096` and `SPACE_CENTER = 2048` (matching the
   cosmos.gl demo's `4096 * [0.495, 0.505]` seed).

### Requirement 13: CosmosGraph_Component Lifecycle

1. WHEN the CosmosGraph_Component mounts, it SHALL construct exactly one
   Cosmos_Engine instance attached to its container.
2. WHEN the CosmosGraph_Component mounts, it SHALL construct exactly one
   CosmosLabels_Overlay instance attached to its label-overlay container.
3. WHEN the CosmosGraph_Component unmounts, it SHALL call
   `CosmosLabels_Overlay.destroy()` and then `Cosmos_Engine.destroy()`,
   each exactly once.
4. WHEN the `data` prop changes to a new reference, THE
   CosmosGraph_Component SHALL re-upload buffers via the following calls
   in exactly this order: `setPointPositions`, `setPointColors`,
   `setPointSizes`, `setLinks`, `setLinkColors`, `render`,
   `trackPointPositionsByIndices`.
5. WHEN only `backgroundColor` changes, THE CosmosGraph_Component SHALL
   call `setConfigPartial({ backgroundColor })` and SHALL NOT re-invoke
   any buffer setter.
6. WHEN prop callbacks (`onPointClick`) change identity without any
   other prop changing, THE CosmosGraph_Component SHALL NOT reconstruct
   the Cosmos_Engine or re-upload buffers.

### Requirement 14: Label Tracking

1. THE CosmosGraph_Component SHALL compute project indices from
   `data.indexToKind` and pass them to
   `Cosmos_Engine.trackPointPositionsByIndices(...)` after calling
   `Cosmos_Engine.render()`.
2. THE CosmosGraph_Component SHALL derive
   `Map<pointIndex, display_name>` from `data.indexToLabel` and pass it
   to `CosmosLabels_Overlay.setPointIndexToLabel(...)`.
3. FOR every project Point_Index, the tracked set SHALL contain that
   index; FOR every non-project Point_Index, the tracked set SHALL NOT
   contain that index.

### Requirement 15: Label Rendering

1. THE CosmosGraph_Component SHALL render a label overlay as an
   absolutely-positioned sibling `<div>` inside its container, carrying
   `data-testid="cosmos-labels"` and `pointer-events: none`.
2. THE CosmosGraph_Component's container SHALL carry
   `data-testid="cosmos-canvas"`.
3. THE CosmosGraph_Component SHALL wire its engine's `onSimulationTick`
   and `onZoom` config callbacks to call
   `CosmosLabels_Overlay.update(graph)`.
4. THE CosmosLabels_Overlay SHALL place each label's top-left at
   `(screenX, screenY - (screenRadius + 2))` where `screenX`, `screenY`
   come from `spaceToScreenPosition` of the tracked point's simulation
   position and `screenRadius` comes from
   `spaceToScreenRadius(getPointRadiusByIndex(i))`.
5. THE CosmosLabels_Overlay SHALL emit each label with `color: 'white'`
   so text renders readably against the renderer's default
   `#1e2428` dark pill background.
6. THE CosmosLabels_Overlay SHALL call the underlying renderer's
   `draw(true)` on every `update()` invocation.
7. WHEN a label's point is no longer in the tracked set, THE
   CosmosLabels_Overlay SHALL drop it from the emitted labels array on
   the next `update()`.
8. THE CosmosGraph_Component SHALL NOT cause a React reconciliation on
   every simulation tick. Per-tick updates happen via direct DOM writes
   in the underlying `LabelRenderer`.

### Requirement 16: Engine Configuration

1. THE CosmosGraph_Component SHALL pass `linkDefaultWidth: 0.6` in its
   `GraphConfig` (matching the cosmos.gl demo).
2. THE CosmosGraph_Component SHALL pass `enableDrag: true` in its
   `GraphConfig`.
3. THE CosmosGraph_Component SHALL NOT override `spaceSize`,
   `simulationGravity`, `simulationRepulsion`, `simulationLinkSpring`,
   `simulationLinkDistance`, `simulationCluster`, `scalePointsOnZoom`,
   `scaleLinksOnZoom`, or `fitViewOnInit` — each uses the engine default.
4. THE CosmosGraph_Component SHALL NOT call `setPointClusters`,
   `setClusterPositions`, or `setPointClusterStrength`. No cluster force.

### Requirement 17: Hover Interaction

1. WHEN a user hovers a point and no click selection is active, THE
   CosmosGraph_Component SHALL call
   `setConfigPartial({ outlinedPointIndices, highlightedLinkIndices })`
   with the hovered point's neighborhood.
2. WHEN the cursor leaves a point and no click selection is active, THE
   CosmosGraph_Component SHALL clear `outlinedPointIndices` and
   `highlightedLinkIndices` via `setConfigPartial`.
3. WHILE a click selection is active, hover callbacks SHALL be no-ops.

### Requirement 18: Legend

1. THE GraphLegend SHALL render exactly two swatch entries: "Project"
   (`#ED69B4`) and "Memory / Concept" (`#4B5BBF`).
2. THE GraphLegend SHALL use rounded swatches (`borderRadius: 6`) to
   reflect that points are circles.

### Requirement 19: No Backend Change

1. Files under `src/` SHALL NOT be modified by this feature.
2. THE read API endpoints `/v1/stats`, `/v1/events`, `/v1/memories` SHALL
   NOT change their request or response shapes.
3. THE event schema and memory record schema SHALL NOT change.

### Requirement 20: Test Coverage

1. THE repository SHALL contain example-based unit tests for
   `transform()` covering empty input, single memory, cross-namespace
   concept scoping, emission order, per-kind sizes, buffer shape, and
   sort stability.
2. THE repository SHALL contain property-based tests using `fast-check`
   for properties P1–P6 as defined in `design.md`.
3. THE repository SHALL contain a component test for CosmosGraph.tsx
   mocking both `@cosmos.gl/graph` and `@interacta/css-labels` and
   asserting mount/data/visual/callback/click/unmount contracts.
4. THE repository SHALL contain a unit test for `CosmosLabels`
   (mocking `@interacta/css-labels`) asserting emission shape, draw
   behavior, map swap, trim-on-shrink, and destroy propagation.
5. THE repository SHALL contain a unit test for `theme.ts` asserting
   both dark and light palette values against their hex sources.
6. THE repository SHALL contain a component test for MemoryGraph.tsx
   (mocking CosmosGraph) asserting loading/error/empty states and
   memory/concept/project/background click routing.

### Requirement 21: Dev Harness

1. THE repository SHALL contain `scripts/dev-harness.mjs`, a Node ESM
   script invocable via `node scripts/dev-harness.mjs`.
2. THE `package.json` SHALL declare `@playwright/test` as a devDependency.
3. THE Dev_Harness SHALL default to `http://127.0.0.1:5173`, overridable
   via the `KIRO_DEV_URL` environment variable.
4. WHEN invoked, THE Dev_Harness SHALL navigate, wait for
   `[data-testid="cosmos-canvas"]`, wait 16 seconds for the simulation
   to settle, capture `.kiro-dev/screenshot.png`, and print a JSON
   report of canvas dimensions, visible/total label counts, and any
   captured console errors.
5. THE `.kiro-dev/` directory SHALL be listed in `.gitignore`.
6. THE Dev_Harness SHALL NOT be imported from any file under `src/` or
   `ui/src/` and SHALL NOT run as part of `npm run test`.

---

## Cut from original scope

The following were proposed in early drafts but cut during implementation
once evidence showed they added complexity without user value at current
data scale. They are NOT implemented and NOT covered by tests.

- **Filter checkboxes for Project / Memory / Concept.** Removed from the
  shell. The legend is informational-only.
- **Cluster force** (`pointClusters`, `clusterPositions`,
  `pointClusterStrength`). Not uploaded to the engine. Layout is driven
  entirely by default link-spring + repulsion + gravity.
- **Label-propagation / community detection** for concepts. Never
  implemented.
- **Point shapes other than circle.** All points are circles.
  `pointDefaultShape` uses engine default.
- **`fitView()` / fixed-zoom override on full reset.** Engine's
  `fitViewOnInit: true` default handles initial framing.
- **Memory labels on hover/select.** Labels render for projects only.
  Memory titles live in the `MemoryDetailPanel`.
- **Zoom-threshold label hiding.** Not implemented. With only project
  labels at project count = 1–2, not needed.
- **Explicit `graph.start()` calls.** Engine auto-starts on data upload.
- **`window.__cosmos_debug` dev backdoor.** Removed after the simulation
  investigation concluded.
- **`linkDefaultColor` override.** Uses the engine default `#666666`;
  per-link colors come from `data.linkColors`.
