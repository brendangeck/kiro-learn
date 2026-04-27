# Design Document: Visualizer Graph

## Overview

This spec replaces the "coming soon" placeholder with a React Flow graph. The graph shows all memories across all projects, grouped into project supernodes, with concept nodes as intermediaries and edges connecting memories to their concepts. A click on any memory node opens a detail panel. All data comes from the existing `/v1/memories` and `/v1/stats` endpoints — no backend changes.

## Architecture

### Data flow

```
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

```
App
├── TopNavigation (existing)
├── AppLayout
│   └── content
│       ├── StatusIndicator (health — existing)
│       ├── MetricCards (existing — live data)
│       ├── MemoryGraph (NEW — replaces placeholder)
│       │   ├── ReactFlow canvas
│       │   │   ├── ProjectSupernode (custom group node)
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

```typescript
import type { Node, Edge } from '@xyflow/react';

interface ProjectInfo {
  namespace: string;
  display_name: string;
}

interface MemoryRecord {
  record_id: string;
  namespace: string;
  title: string;
  concepts: string[];
  observation_type: string;
  // ... other fields
}

interface GraphData {
  nodes: Node[];
  edges: Edge[];
}

export function transformToGraph(
  memories: MemoryRecord[],
  projects: ProjectInfo[],
): GraphData {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Group memories by namespace
  const byNamespace = new Map<string, MemoryRecord[]>();
  for (const mem of memories) {
    const list = byNamespace.get(mem.namespace) ?? [];
    list.push(mem);
    byNamespace.set(mem.namespace, list);
  }

  // Build project display name lookup
  const displayNames = new Map(projects.map((p) => [p.namespace, p.display_name]));

  let projectIndex = 0;
  for (const [namespace, mems] of byNamespace) {
    const projectId = `project-${projectIndex}`;
    const displayName = displayNames.get(namespace) ?? namespace.slice(0, 12);

    // Project supernode (group)
    nodes.push({
      id: projectId,
      type: 'projectSupernode',
      data: { label: displayName, namespace },
      position: { x: projectIndex * 600, y: 0 },
    });

    // Collect concepts for this project
    const conceptCounts = new Map<string, number>();
    for (const mem of mems) {
      for (const concept of mem.concepts) {
        conceptCounts.set(concept, (conceptCounts.get(concept) ?? 0) + 1);
      }
    }

    // Concept nodes
    let conceptIndex = 0;
    const conceptNodeIds = new Map<string, string>();
    for (const [concept, count] of conceptCounts) {
      const conceptNodeId = `${projectId}-concept-${conceptIndex}`;
      conceptNodeIds.set(concept, conceptNodeId);
      nodes.push({
        id: conceptNodeId,
        type: 'conceptNode',
        data: { label: concept, count },
        position: { x: conceptIndex * 150, y: 100 },
        parentId: projectId,
        extent: 'parent' as const,
      });
      conceptIndex++;
    }

    // Memory nodes + edges
    let memIndex = 0;
    for (const mem of mems) {
      const memNodeId = `${projectId}-mem-${memIndex}`;
      nodes.push({
        id: memNodeId,
        type: 'memoryNode',
        data: {
          label: mem.title.slice(0, 40),
          memory: mem,
        },
        position: { x: memIndex * 120, y: 300 },
        parentId: projectId,
        extent: 'parent' as const,
      });

      // Edges to concepts
      for (const concept of mem.concepts) {
        const conceptNodeId = conceptNodeIds.get(concept);
        if (conceptNodeId) {
          edges.push({
            id: `${memNodeId}-${conceptNodeId}`,
            source: memNodeId,
            target: conceptNodeId,
          });
        }
      }
      memIndex++;
    }
    projectIndex++;
  }

  return { nodes, edges };
}
```

The positions above are initial placeholders. A layout algorithm (dagre or elkjs) repositions them after the initial render.

### Component 2: Custom node types

**ProjectSupernode** (`ui/src/graph/ProjectSupernode.tsx`):
- Group node with a colored header bar and semi-transparent background.
- Label shows project display_name.
- All project supernodes use the same color — projects are distinguished by label text, not color.

**ConceptNode** (`ui/src/graph/ConceptNode.tsx`):
- Rounded rectangle. Label is the concept string.
- Width/height scales with `data.count` (degree).
- All concept nodes use the same color (distinct from project and memory colors).

**MemoryNode** (`ui/src/graph/MemoryNode.tsx`):
- Small rectangle. Label is truncated title.
- All memory nodes use the same color (distinct from project and concept colors).
- `observation_type` is stored in node data for the detail panel but does not affect node color.

All three are registered via React Flow's `nodeTypes` prop.

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

React Flow needs initial positions for nodes. Two approaches:

**Option A: dagre layout.** Install `dagre` as a devDependency. Compute a hierarchical layout: project at top, concepts in middle, memories at bottom. Run once after `transformToGraph`, update node positions.

**Option B: Manual grid layout.** Position project supernodes in a row. Within each, concepts in a row above memories in a row. Simple, deterministic, no extra dependency.

Recommend **Option A** for better visual results with varying data shapes. dagre is small (~30KB) and well-suited for hierarchical graphs.

## Testing Strategy

### Unit test for transformation

`test/unit/graph-transform.test.ts`:
- Empty memories → empty nodes/edges.
- Single memory with 2 concepts → 1 project node, 2 concept nodes, 1 memory node, 2 edges.
- Two memories sharing a concept → concept node has degree 2, 2 edges to it.
- Memories across 2 namespaces → 2 project supernodes, nodes correctly parented.
- Memory with empty concepts array → memory node exists, no edges.

### Updated smoke test

- Mock `/v1/memories` with realistic data.
- Assert "coming soon" text is gone.
- Assert at least one memory title from mocked data appears.
- Assert "Memory Graph" header still present.

## Interfaces

### New

| Symbol | Module |
|---|---|
| `transformToGraph` | `ui/src/graph/transform.ts` |
| `ProjectSupernode` | `ui/src/graph/ProjectSupernode.tsx` |
| `ConceptNode` | `ui/src/graph/ConceptNode.tsx` |
| `MemoryNode` | `ui/src/graph/MemoryNode.tsx` |
| `MemoryGraph` | `ui/src/components/MemoryGraph.tsx` |
| `MemoryDetailPanel` | `ui/src/components/MemoryDetailPanel.tsx` |
| `MemoriesResponse`, `MemoryRecord` | `ui/src/types/api.ts` |

### Modified

| Symbol | Change |
|---|---|
| `App` in `ui/src/App.tsx` | Adds memories fetch, replaces placeholder with MemoryGraph, adds detail panel |
| `package.json` devDeps | Adds `@xyflow/react`, optionally `dagre` |
