# Design Document: Visualizer Graph

## Overview

This spec replaces the "coming soon" placeholder with a React Flow graph. The graph uses a flat node layout where project hub nodes, concept nodes, and memory nodes are connected by edges. Dagre positions related nodes close together based on edge connectivity, producing natural clusters per project. A click on any memory or concept node opens a detail panel. All data comes from the existing `/v1/memories` and `/v1/stats` endpoints — no backend changes.

The graph does NOT use React Flow's group-node/parentId mechanism. An earlier iteration used `parentId` and `extent: 'parent'` to nest concept and memory nodes inside project supernodes, but this prevented edges from rendering (React Flow doesn't draw edges between nodes inside a group) and produced a rigid table-like layout. The current approach uses a flat graph where clustering emerges from edge connectivity through dagre.

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
├── TopNavigation (existing)
├── AppLayout
│   └── content
│       ├── StatusIndicator (health — existing)
│       ├── MetricCards (existing — live data)
│       ├── MemoryGraph (NEW — replaces placeholder)
│       │   ├── ReactFlow canvas
│       │   │   ├── ProjectSupernode (custom hub node)
│       │   │   ├── ConceptNode (custom node)
│       │   │   └── MemoryNode (custom node)
│       │   ├── MiniMap
│       │   ├── Controls
│       │   └── Background
│       ├── MemoryDetailPanel (NEW — slides in on click)
│       └── EventTail (existing)
```

## Components

### Component 1: Graph data transformation (`ui/src/graph/transform.ts`)

Pure function. No React, no side effects. Testable in isolation.

Produces a flat graph (no `parentId` or `extent`) with three node types connected by edges:
- **Project hub → Concept** edges create the cluster structure
- **Memory → Concept** edges connect memories to their topics

```typescript
import type { Node, Edge } from '@xyflow/react';

interface ProjectInfo {
  namespace: string;
  display_name: string;
}

interface GraphData {
  nodes: Node[];
  edges: Edge[];
}

export function transformToGraph(
  memories: MemoryRecord[],
  projects: ProjectInfo[],
): GraphData {
  // Group memories by namespace
  // For each namespace:
  //   1. Create a project hub node (type: 'projectSupernode')
  //   2. Collect unique concepts with degree counts → concept nodes
  //   3. Create edges: project → each concept
  //   4. Create memory nodes + edges: memory → each of its concepts
  // All nodes are flat — no parentId. Dagre clusters them via edges.
}
```

Positions are all `{ x: 0, y: 0 }` placeholders — dagre repositions them in a single pass over the flat graph.

### Component 2: Custom node types

**ProjectSupernode** (`ui/src/graph/ProjectSupernode.tsx`):
- Prominent hub node with the project's `display_name` as label.
- All project hub nodes use the same blue color — projects are distinguished by label text, not color.
- Includes a `title` attribute for hover tooltip on ellipsized labels.
- Hidden `Handle` components (source + target) so React Flow can anchor edges.

**ConceptNode** (`ui/src/graph/ConceptNode.tsx`):
- Rounded rectangle. Label is the concept string.
- Fixed dimensions matching the layout engine's `NODE_DIMENSIONS` to avoid rendering/layout mismatches.
- All concept nodes use the same green color (distinct from project and memory colors).
- Hidden `Handle` components (source + target) for edge anchoring.

**MemoryNode** (`ui/src/graph/MemoryNode.tsx`):
- Small rectangle. Label is truncated title.
- All memory nodes use the same amber color (distinct from project and concept colors).
- `observation_type` is stored in node data for the detail panel but does not affect node color.
- Hidden `Handle` components (source + target) for edge anchoring.

All three are registered via React Flow's `nodeTypes` prop. All include invisible `Handle` components — without handles, React Flow cannot draw edges between custom nodes.

### Component 3: MemoryGraph (`ui/src/components/MemoryGraph.tsx`)

The main graph component. Replaces the placeholder.

```tsx
import { ReactFlow, MiniMap, Controls, Background } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// ... imports for custom nodes, transform, types

interface Props {
  memories: MemoryRecord[];
  projects: ProjectInfo[];
  loading: boolean;
  error: string | null;
  onNodeClick: (memory: MemoryRecord | null, concept: string | null) => void;
}

export function MemoryGraph({ memories, projects, loading, error, onNodeClick }: Props) {
  if (loading) return <Spinner />;
  if (error) return <StatusIndicator type="error">{error}</StatusIndicator>;
  if (memories.length === 0) return <Box>No memories yet — run some sessions to see your graph</Box>;

  const { nodes, edges } = transformToGraph(memories, projects);

  return (
    <div style={{ height: 500 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => {
          if (node.type === 'memoryNode') onNodeClick(node.data.memory, null);
          if (node.type === 'conceptNode') onNodeClick(null, node.data.label);
        }}
        fitView
      >
        <MiniMap />
        <Controls />
        <Background />
      </ReactFlow>
    </div>
  );
}
```

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

- Add memories fetch: `GET /v1/memories?limit=500` alongside existing stats/events fetches.
- Add state: `memories`, `memoriesLoading`, `memoriesError`, `selectedMemory`, `selectedConcept`.
- Replace the graph placeholder `Container` content with `<MemoryGraph>`.
- Render `<MemoryDetailPanel>` conditionally when a node is selected.

### Component 6: Layout

`dagre` is installed as a devDependency. A single dagre pass over the flat graph positions all nodes. Edge connectivity (project → concepts → memories) naturally produces clustered groups where related nodes are positioned close together.

The layout function (`ui/src/graph/layout.ts`):
- Takes all nodes and edges from `transformToGraph`
- Runs a single `dagre.layout()` with `rankdir: 'TB'`, `ranksep: 60`, `nodesep: 30`
- Converts dagre's center-based positions to React Flow's top-left convention
- Exports `NODE_DIMENSIONS` so custom node components can use the same sizes dagre allocates, avoiding rendering/layout mismatches

This approach replaced an earlier per-project-group dagre strategy that used React Flow's `parentId` grouping. The flat graph approach was adopted because:
1. React Flow doesn't render edges between nodes inside a group node
2. Per-group dagre produced rigid table-like layouts instead of organic clusters

## Testing Strategy

### Unit test for transformation

`test/unit/graph-transform.test.ts`:
- Empty memories → empty nodes/edges.
- Single memory with 2 concepts → 1 project node, 2 concept nodes, 1 memory node, 4 edges (2 project→concept + 2 memory→concept).
- Two memories sharing a concept → concept node has degree 2, correct edge count.
- Memories across 2 namespaces → 2 project hub nodes, separate concept nodes per project.
- Memory with empty concepts array → memory node exists, no edges.
- All nodes are flat — no `parentId` or `extent`.
- Project→concept edges exist for cluster structure.

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
| `ConceptNode` | `ui/src/graph/ConceptNode.tsx` |
| `MemoryNode` | `ui/src/graph/MemoryNode.tsx` |
| `GraphLegend` | `ui/src/graph/GraphLegend.tsx` |
| `graphTheme` | `ui/src/graph/theme.ts` |
| `applyDagreLayout`, `NODE_DIMENSIONS` | `ui/src/graph/layout.ts` |
| `MemoryGraph` | `ui/src/components/MemoryGraph.tsx` |
| `MemoryDetailPanel` | `ui/src/components/MemoryDetailPanel.tsx` |
| `MemoriesResponse`, `MemoryRecord`, `normalizeMemoriesResponse`, `normalizeMemoryRecord` | `ui/src/types/api.ts` |

### Modified

| Symbol | Change |
|---|---|
| `App` in `ui/src/App.tsx` | Adds memories fetch with `normalizeMemoriesResponse`, replaces placeholder with MemoryGraph, adds detail panel |
| `package.json` devDeps | Adds `@xyflow/react`, `dagre`, `@types/dagre` |
