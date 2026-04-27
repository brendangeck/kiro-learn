# Design Document: Visualizer Graph

## Overview

This spec replaces the "coming soon" placeholder with a React Flow graph. The graph uses a flat node layout with three node types — project (blue), concept (mint/green), and memory (pink/salmon) — all using the same outline style but different colors. d3-force positions nodes in organic radial clusters based on edge connectivity. Memories act as the hub, connecting to both their project and their concepts.

Three checkboxes above the graph (Projects, Memories, Concepts) let users filter which node types are visible. Edge visibility follows specific rules based on which types are checked.

A click on any memory or concept node opens a detail panel. All data comes from the existing `/v1/memories` and `/v1/stats` endpoints — no backend changes.

## Architecture

### Data flow

```text
/v1/memories?limit=500 → MemoryRecord[]
/v1/stats              → StatsResponse (for project display_names)
                            ↓
              transformToGraph(memories, projects)
                            ↓
              { nodes: Node[], edges: Edge[] }
                            ↓
              <ReactFlow nodes={nodes} edges={edges} />
```

### Component tree

```text
App
├── TopNavigation (collector status, dark mode toggle, version)
├── AppLayout
│   └── content
│       ├── MetricCards (existing — live data)
│       ├── MemoryGraph (replaces placeholder)
│       │   ├── Filter checkboxes (Projects, Memories, Concepts)
│       │   ├── ReactFlow canvas
│       │   │   ├── ProjectNode (blue outline)
│       │   │   ├── ConceptNode (mint/green outline)
│       │   │   └── MemoryNode (pink/salmon outline)
│       │   └── Background (dot grid)
│       ├── MemoryDetailPanel (slides in on click)
│       └── EventTail (existing)
```

## Components

### Component 1: Graph data transformation (`ui/src/graph/transform.ts`)

Pure function. No React, no side effects. Testable in isolation.

Produces a flat graph with three node types and three edge types:
- **Project nodes** (blue) — one per namespace
- **Concept nodes** (mint/green) — one per unique concept string per project
- **Memory nodes** (pink/salmon) — one per memory record

All three edge types are generated (tagged with `linkType` in edge data):
- `memory-project`: memory → its project
- `memory-concept`: memory → each of its concepts
- `project-concept`: project → each of its concepts

The MemoryGraph component filters which edges to display based on the checkbox state.

Node IDs are derived from immutable values for stability across refreshes.

### Component 2: Custom node types

All three node types use the same outline style (tinted background + saturated border + `borderRadius: 8`) but different colors. Each has handles on all four sides (both source and target) for nearest-side edge routing.

**ProjectNode** (`ui/src/graph/ProjectNode.tsx`):
- Blue outline style. Labeled with project `display_name`.
- `title` attribute for hover tooltip.

**ConceptNode** (`ui/src/graph/ConceptNode.tsx`):
- Mint/green outline style. Labeled with concept string.
- `title` attribute for hover tooltip.

**MemoryNode** (`ui/src/graph/MemoryNode.tsx`):
- Pink/salmon outline style. Fixed width (260px), left-aligned text truncated to ~40 chars + ellipsis.
- `title` attribute shows full memory title on hover.

All three registered via React Flow's `nodeTypes` prop. All read `darkMode` from node data to select light/dark color variants.

### Component 3: MemoryGraph (`ui/src/components/MemoryGraph.tsx`)

The main graph component. Replaces the placeholder.

Props: `memories`, `projects`, `loading`, `error`, `darkMode`, `onNodeClick`.

Key behaviors:
- Three Cloudscape `Checkbox` components above the canvas: Projects, Memories, Concepts (all checked by default).
- Computes full graph via `transformToGraph` then `applyForceLayout` (memoized by content key).
- Filters nodes by checkbox state; filters edges by `linkType` using `getAllowedLinkTypes()` rules.
- Assigns `sourceHandle`/`targetHandle` per edge based on relative node positions for nearest-side routing.
- Animated bezier edges with mode-aware stroke color.
- Canvas background adapts to dark mode.
- No MiniMap, Controls, or attribution. `minZoom={0.1}`. `fitView` on initial render.
- Read-only: `nodesConnectable={false}`, `nodesDraggable={true}`, `elementsSelectable={true}`, `deleteKeyCode={null}`.
- Handles clicks on memory nodes (opens detail panel with full record) and concept nodes (opens detail panel with related memories).

### Component 4: MemoryDetailPanel (`ui/src/components/MemoryDetailPanel.tsx`)

Cloudscape side panel showing full memory details.

```tsx
interface Props {
  memory: MemoryRecord | null;
  concept: string | null;
  memories: MemoryRecord[];  // for concept click — filter to show related memories
  onClose: () => void;
}
```

When `memory` is set: shows title, summary, facts, concepts (as badges), files_touched, observation_type, created_at, source_event_ids.

When `concept` is set: shows concept name and a list of memory titles that reference it.

Uses Cloudscape `Container`, `Header`, `SpaceBetween`, `Badge`, `Box`, `Button` (close).

### Component 5: App.tsx changes

- Add memories fetch: `GET /v1/memories?limit=500` alongside existing stats/events fetches. Uses `normalizeMemoriesResponse` for runtime validation.
- Add state: `memories`, `memoriesLoading`, `memoriesError`, `selectedMemory`, `selectedConcept`, `darkMode`.
- Dark mode state initialized from `localStorage` (`kiro-learn-dark-mode` key) and applies `applyMode()` on load.
- Replace the graph placeholder `Container` content with `<MemoryGraph>` passing `darkMode`.
- Render `<MemoryDetailPanel>` conditionally when a node is selected.
- Move health status from content area to TopNavigation utilities (icon + text).
- TopNavigation utilities: collector status, dark mode toggle (`light-dark` icon), version.

### Component 6: Layout

`d3-force` is installed as a devDependency (replaced dagre). The layout function (`ui/src/graph/layout.ts`) runs a force simulation synchronously to compute positions.

Forces:
- **link**: edges act as springs (distance: 180, strength: 0.4)
- **charge**: many-body repulsion (strength: -600) for even spacing
- **center**: keeps the graph centered at origin
- **collide**: prevents node overlap (radius: 0.8× max dimension, strength: 0.8)

Initial positions are deterministic — each node's ID is hashed to an angle and radius on a circle, ensuring the simulation always converges to the same layout for the same data. This prevents nodes from jumping on each 10s refresh.

The layout exports `NODE_DIMENSIONS` so custom node components can match their rendered size to the collision radius.

This approach replaced dagre, which produced rigid hierarchical layouts. d3-force produces organic radial clusters that feel more natural and animated.

## Testing Strategy

### Unit test for transformation

`test/unit/graph-transform.test.ts`:
- Empty memories → empty nodes/edges.
- Single memory with concepts → project + concept + memory nodes, all three edge types.
- Shared concept → degree count correct.
- Memories across 2 namespaces → 2 project nodes, separate concept nodes per project.
- Memory with empty concepts → memory→project edge only.
- All nodes flat — no `parentId` or `extent`.
- Stable IDs derived from namespace, concept string, and record_id.
- Title truncation to 40 chars + ellipsis.
- `darkMode` in node data.

### Updated smoke test

- Mock `/v1/memories` with realistic data.
- Assert "coming soon" text is gone.
- Assert at least one memory title from mocked data appears.
- Assert "Memory Graph" header still present.

## Interfaces

### New

| Symbol | Module |
|---|---|
| `transformToGraph`, `ProjectInfo` | `ui/src/graph/transform.ts` |
| `ProjectNode` | `ui/src/graph/ProjectNode.tsx` |
| `ConceptNode` | `ui/src/graph/ConceptNode.tsx` |
| `MemoryNode` | `ui/src/graph/MemoryNode.tsx` |
| `GraphLegend` | `ui/src/graph/GraphLegend.tsx` |
| `graphTheme`, `getNodeColors`, `getGraphColors`, `LIGHT_COLORS`, `DARK_COLORS` | `ui/src/graph/theme.ts` |
| `applyForceLayout`, `NODE_DIMENSIONS` | `ui/src/graph/layout.ts` |
| `MemoryGraph` | `ui/src/components/MemoryGraph.tsx` |
| `MemoryDetailPanel` | `ui/src/components/MemoryDetailPanel.tsx` |
| `MemoriesResponse`, `MemoryRecord`, `normalizeMemoriesResponse`, `normalizeMemoryRecord` | `ui/src/types/api.ts` |

### Modified

| Symbol | Change |
|---|---|
| `App` in `ui/src/App.tsx` | Adds memories fetch with `normalizeMemoriesResponse`, replaces placeholder with MemoryGraph, adds detail panel, dark mode toggle, collector status in TopNavigation |
| `package.json` devDeps | Adds `@xyflow/react`, `d3-force`, `@types/d3-force`, `dagre`, `@types/dagre` |
