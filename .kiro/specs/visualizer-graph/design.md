# Design Document: Visualizer Graph

## Overview

This spec replaces the "coming soon" placeholder with a React Flow graph. The graph uses a flat node layout where project hub nodes and memory nodes are connected by animated bezier edges. d3-force positions nodes in organic radial clusters based on edge connectivity. A click on any memory node opens a detail panel showing full details including concepts as badges. All data comes from the existing `/v1/memories` and `/v1/stats` endpoints — no backend changes.

Concepts are NOT rendered as separate graph nodes — they are stored in memory node data and displayed in the detail panel sidebar.

The graph does NOT use React Flow's group-node/parentId mechanism, MiniMap, Controls, or attribution watermark. An earlier iteration used `parentId` and dagre, but this prevented edges from rendering and produced rigid layouts. The current approach uses a flat graph with d3-force for organic clustering.

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
├── TopNavigation (existing + collector status, dark mode toggle, version)
├── AppLayout
│   └── content
│       ├── MetricCards (existing — live data)
│       ├── MemoryGraph (NEW — replaces placeholder)
│       │   ├── ReactFlow canvas
│       │   │   ├── ProjectSupernode (custom hub node)
│       │   │   └── MemoryNode (custom node)
│       │   └── Background (dot grid)
│       ├── GraphLegend (Project, Memory)
│       ├── MemoryDetailPanel (NEW — slides in on click)
│       └── EventTail (existing)
```

## Components

### Component 1: Graph data transformation (`ui/src/graph/transform.ts`)

Pure function. No React, no side effects. Testable in isolation.

Produces a flat graph (no `parentId` or `extent`) with two node types:
- **Project hub nodes** — one per namespace, with `colorIndex` from the 6-hue palette
- **Memory nodes** — one per memory record, inheriting the project's `colorIndex`

Edges connect each project hub to its memory nodes. Concepts are stored in memory node data for the detail panel but are NOT rendered as graph nodes.

```typescript
export function transformToGraph(
  memories: MemoryRecord[],
  projects: ProjectInfo[],
  darkMode?: boolean,
): GraphData {
  // Group memories by namespace
  // For each namespace:
  //   1. Create a project hub node (id: 'project-{namespace}')
  //   2. Create memory nodes (id: 'mem-{record_id}') with colorIndex + darkMode in data
  //   3. Create edges: project → each memory
  // All nodes are flat. d3-force clusters them via edges.
}
```

Node IDs are derived from immutable values (namespace, record_id) for stability across refreshes.

### Component 2: Custom node types

**ProjectSupernode** (`ui/src/graph/ProjectSupernode.tsx`):
- Prominent hub node with saturated background from the project's palette color.
- White text, rounded corners (`borderRadius: 10`), subtle box shadow.
- `title` attribute for hover tooltip on ellipsized labels.
- Hidden `Handle` components on all four sides (top, bottom, left, right) for nearest-side edge routing.
- Reads `colorIndex` and `darkMode` from node data to select the correct palette.

**MemoryNode** (`ui/src/graph/MemoryNode.tsx`):
- Fixed-width rectangle (260px). Left-aligned text, truncated to ~40 chars + ellipsis.
- Tinted background with saturated border from the project's palette color.
- `title` attribute shows full memory title on hover.
- Hidden `Handle` components on all four sides for nearest-side edge routing.
- Reads `colorIndex` and `darkMode` from node data.

**ConceptNode** (`ui/src/graph/ConceptNode.tsx`):
- Kept as a valid component but NOT used in the graph. Concepts are shown as badges in the detail panel instead.

Only ProjectSupernode and MemoryNode are registered via React Flow's `nodeTypes` prop.

### Component 3: MemoryGraph (`ui/src/components/MemoryGraph.tsx`)

The main graph component. Replaces the placeholder.

Props: `memories`, `projects`, `loading`, `error`, `darkMode`, `onNodeClick`.

Key behaviors:
- Calls `transformToGraph(memories, projects, darkMode)` then `applyForceLayout(nodes, edges)`.
- Uses `useNodesState`/`useEdgesState` for interactive node dragging.
- Content-based memoization (`contentKey` from record_ids) prevents recomputing layout on identical 10s refreshes.
- Assigns `sourceHandle`/`targetHandle` per edge based on relative node positions for nearest-side routing.
- Animated bezier edges with mode-aware stroke color.
- Canvas background adapts to dark mode via `getGraphColors(darkMode)`.
- No MiniMap, Controls, or attribution. `minZoom={0.1}` for zooming far out. `fitView` on initial render.
- Read-only: `nodesConnectable={false}`, `nodesDraggable={true}`, `elementsSelectable={true}`, `deleteKeyCode={null}`, `proOptions={{ hideAttribution: true }}`.

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
- Single memory → 1 project node, 1 memory node, 1 edge (project→memory).
- Multiple memories in same project → correct node/edge counts.
- Memories across 2 namespaces → 2 project hub nodes.
- Memory with empty concepts array → still has project→memory edge.
- All nodes are flat — no `parentId` or `extent`.
- No concept nodes created (concepts in memory data only).
- Stable IDs derived from namespace and record_id.
- Title truncation to 40 chars + ellipsis.
- `colorIndex` and `darkMode` in node data.

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
| `ProjectSupernode` | `ui/src/graph/ProjectSupernode.tsx` |
| `ConceptNode` (unused in graph) | `ui/src/graph/ConceptNode.tsx` |
| `MemoryNode` | `ui/src/graph/MemoryNode.tsx` |
| `GraphLegend` | `ui/src/graph/GraphLegend.tsx` |
| `graphTheme`, `getPalette`, `getGraphColors`, `LIGHT_PALETTE`, `DARK_PALETTE`, `PROJECT_PALETTE` | `ui/src/graph/theme.ts` |
| `applyForceLayout`, `NODE_DIMENSIONS` | `ui/src/graph/layout.ts` |
| `MemoryGraph` | `ui/src/components/MemoryGraph.tsx` |
| `MemoryDetailPanel` | `ui/src/components/MemoryDetailPanel.tsx` |
| `MemoriesResponse`, `MemoryRecord`, `normalizeMemoriesResponse`, `normalizeMemoryRecord` | `ui/src/types/api.ts` |

### Modified

| Symbol | Change |
|---|---|
| `App` in `ui/src/App.tsx` | Adds memories fetch with `normalizeMemoriesResponse`, replaces placeholder with MemoryGraph, adds detail panel, dark mode toggle, collector status in TopNavigation |
| `package.json` devDeps | Adds `@xyflow/react`, `d3-force`, `@types/d3-force`, `dagre`, `@types/dagre` |
