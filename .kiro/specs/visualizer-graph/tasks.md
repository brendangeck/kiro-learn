# Implementation Plan: Visualizer Graph

Dependencies first, then graph logic, then UI components, then wiring, then tests.

- [x] 1. Install React Flow dependency

  - [x] 1.1 Add `@xyflow/react` to root `package.json` devDependencies
    - Latest stable version, caret range.
    - Run `npm install` and verify success.
    - _Requirements: 1.1, 1.3_

  - [x] 1.2 Optionally add `dagre` for layout
    - If using dagre for hierarchical layout, add `dagre` and `@types/dagre` as devDependencies.
    - _Requirements: 4.7_

- [x] 2. Define UI types for memories

  - [x] 2.1 Add `MemoriesResponse` and `MemoryRecord` to `ui/src/types/api.ts`
    - `MemoriesResponse`: `{ items: MemoryRecord[], total: number, limit: number, offset: number }`.
    - `MemoryRecord`: all fields from the backend schema (`record_id`, `namespace`, `strategy`, `title`, `summary`, `facts`, `source_event_ids`, `created_at`, `concepts`, `files_touched`, `observation_type`).
    - Do NOT import from `src/`.
    - _Requirements: 8.1, 8.2, 8.3_

- [x] 3. Implement graph data transformation

  - [x] 3.1 Create `ui/src/graph/transform.ts`
    - Pure function `transformToGraph(memories, projects) → { nodes, edges }`.
    - Group memories by namespace → flat project hub nodes (no parentId/grouping).
    - Create memory nodes with observation_type and concepts in data (concepts shown in detail panel, not as graph nodes).
    - Create edges from each project hub → its memory nodes.
    - Node IDs derived from immutable values: namespace for projects, record_id for memories.
    - Each project and its memories assigned a `colorIndex` from the 6-hue palette.
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6_

  - [x] 3.2 Implement layout positioning
    - d3-force simulation with deterministic initial positions (hashed from node IDs).
    - Edge connectivity clusters related nodes together organically.
    - _Requirements: 4.7_

- [x] 4. Build custom node components

  - [x] 4.1 Create `ui/src/graph/ProjectSupernode.tsx`
    - Flat hub node with saturated background from project palette color.
    - White text, rounded corners, box shadow.
    - Handles on all four sides for nearest-side edge routing.
    - `title` attribute for hover tooltip on ellipsized labels.
    - _Requirements: 5.2, 10.1_

  - [x] 4.2 Create `ui/src/graph/ConceptNode.tsx`
    - Kept as valid component but not used in graph (concepts shown as tags in detail panel).
    - Size scales with degree (data.count).
    - All concept nodes use the same color from the Cloudscape-derived theme.
    - _Requirements: 5.3, 10.1_

  - [x] 4.3 Create `ui/src/graph/MemoryNode.tsx`
    - Fixed-width rectangle (260px). Label is truncated title (~40 chars + ellipsis).
    - Tinted background with saturated border from project palette color.
    - Handles on all four sides for nearest-side edge routing.
    - `title` attribute shows full memory title on hover.
    - _Requirements: 5.4, 10.1_

  - [x] 4.4 Add node type color legend
    - Legend mapping two colors to: Project, Memory.
    - Use Cloudscape components (Box, SpaceBetween) for the legend display.
    - _Requirements: 5.5, 10.4_

- [x] 5. Build MemoryGraph component

  - [x] 5.0 Define color palette and graph styling constants
    - Create a `ui/src/graph/theme.ts` file exporting a 6-hue color palette (Blue, Violet, Rose, Amber, Emerald, Teal) for project-based coloring.
    - Each project gets a color; memory nodes inherit their project's color.
    - Export edge stroke color and canvas background.
    - Use the same font family Cloudscape applies (`'Amazon Ember'` or its fallback stack).
    - _Requirements: 10.1, 10.2, 10.3, 10.5_

  - [x] 5.1 Create `ui/src/components/MemoryGraph.tsx`
    - Import `@xyflow/react` and its CSS.
    - Accept props: memories, projects, loading, error, onNodeClick.
    - Render loading/error/empty states.
    - Call `transformToGraph` then `applyForceLayout` and render `<ReactFlow>` with positioned nodes and styled edges.
    - Use `useNodesState`/`useEdgesState` for interactive dragging.
    - Content-based memoization (contentKey from record_ids) to avoid recomputing layout on identical refreshes.
    - Assign `sourceHandle`/`targetHandle` per edge based on relative node positions for nearest-side routing.
    - Animated bezier edges with mode-aware stroke color.
    - Configure read-only: `nodesConnectable={false}`, `nodesDraggable={true}`, `elementsSelectable={true}`, `deleteKeyCode={null}`.
    - `<Background>` with dot grid. No MiniMap, Controls, or attribution (`proOptions={{ hideAttribution: true }}`).
    - Register custom node types via `nodeTypes` prop (ProjectSupernode, MemoryNode).
    - Handle `onNodeClick` for memory nodes.
    - Canvas height at least 500px with themed background. `minZoom={0.1}`.
    - `fitView` on initial render.
    - _Requirements: 2.3, 2.4, 2.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 7.1, 7.2, 7.3, 7.4, 11.1, 11.2, 11.3, 11.4, 11.5_

- [x] 6. Build MemoryDetailPanel component

  - [x] 6.1 Create `ui/src/components/MemoryDetailPanel.tsx`
    - Cloudscape side panel / overlay.
    - When memory selected: show title, summary, facts (bulleted), concepts (badges), files_touched, observation_type (colored badge), created_at, source_event_ids.
    - When concept selected: show concept name + list of memory titles referencing it.
    - Close button or background click to dismiss.
    - Uses Cloudscape Container, Header, SpaceBetween, Badge, Box, Button.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 7. Wire into App.tsx

  - [x] 7.1 Add memories fetch to App.tsx
    - Fetch `GET /v1/memories?limit=500` on mount and every 10s.
    - Add state: `memories`, `memoriesLoading`, `memoriesError`.
    - _Requirements: 2.1, 2.2, 10.1_

  - [x] 7.2 Replace graph placeholder with MemoryGraph
    - Remove the "coming soon" StatusIndicator.
    - Render `<MemoryGraph>` inside the existing Container.
    - Pass memories, projects (from stats), loading, error, onNodeClick.
    - _Requirements: 4.1_

  - [x] 7.3 Add MemoryDetailPanel
    - State: `selectedMemory`, `selectedConcept`.
    - Render conditionally when either is set.
    - _Requirements: 6.1, 6.5_

  - [x] 7.4 Ensure refresh preserves viewport
    - React Flow preserves pan/zoom when node IDs are stable across re-renders.
    - Verify node IDs are deterministic (derived from record_id and concept string).
    - _Requirements: 10.2, 10.3_

- [x] 8. Tests

  - [x] 8.1 Create `test/unit/graph-transform.test.ts`
    - Empty memories → empty graph.
    - Single memory with 2 concepts → correct node/edge counts.
    - Shared concept → degree 2, 2 edges.
    - Two namespaces → 2 project supernodes.
    - Empty concepts array → memory node, no edges.
    - _Requirements: 3.6_

  - [x] 8.2 Update `test/unit/ui-app-smoke.test.tsx`
    - Mock `/v1/memories` with realistic data.
    - Assert "coming soon" text is gone.
    - Assert at least one mocked memory title appears.
    - Assert "Memory Graph" header still present.
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [x] 9. Final verification

  - [x] 9.1 Run full local gate
    - `npm run build && npm run typecheck && npm run lint && npm run test`

  - [x] 9.2 Manual end-to-end smoke
    - Start daemon with seeded data, open UI, verify:
      - Graph renders with project hub nodes and memory nodes.
      - Animated bezier edges connect project hubs to memories.
      - Click a memory → detail panel shows full record with concepts as badges.
      - Pan/zoom works. No MiniMap/Controls/attribution overlay.
      - Refresh doesn't reset viewport (stable node IDs).
      - Dark mode toggle works — canvas, nodes, and edges adapt.
      - Collector status shows in TopNavigation.
      - Stats cards and event tail still work.

## Notes

- No backend changes. All data from existing `/v1/memories` and `/v1/stats`.
- Concepts are stored in memory node data for the detail panel but are NOT rendered as separate graph nodes.
- Node IDs are stable: `project-{namespace}` for projects, `mem-{record_id}` for memories. This ensures React Flow preserves viewport on refresh.
- The transformation function is pure and testable without React or React Flow.
- d3-force layout with deterministic initial positions (hashed from node IDs) produces organic clusters.
- 6-hue color palette (Blue, Violet, Rose, Amber, Emerald, Teal) cycles across projects; memories inherit their project's color.
- Dark mode toggle in TopNavigation uses Cloudscape's `applyMode(Mode.Dark)` / `applyMode(Mode.Light)`.
