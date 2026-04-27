# Requirements: Visualizer Graph

## Introduction

This document defines the requirements for the memory graph — the hero feature of the v1 visualizer. The graph replaces the "coming soon" placeholder with a React Flow canvas showing project hub nodes, concept nodes, and memory nodes connected by edges in a flat, clustered layout.

This is the fifth and final spec: `project-path-capture` (shipped) → `visualizer-scaffold` (shipped) → `visualizer-read-api` (shipped) → `visualizer-dashboard` (shipped) → **`visualizer-graph` (this spec)**.

The dashboard already fetches `/v1/stats` and `/v1/events`. This spec adds a fetch to `/v1/memories` (all memories, paginated) and transforms the response into a React Flow graph. All graph structure — project grouping, concept extraction, edge computation — is derived client-side from the memories data. No new backend endpoints.

**In scope:** Install React Flow (`@xyflow/react`); fetch memories from `/v1/memories`; transform memories into graph nodes and edges; render with React Flow; project hub nodes; concept nodes; memory nodes; edges from projects to concepts and from memories to concepts; click-to-detail side panel for memory and concept nodes; pan/zoom/minimap; loading/error/empty states; runtime response validation; updated smoke tests.

**Out of scope:** New backend endpoints; cross-project concept merging; time-based visualization; node search/filter; drag-to-rearrange; export/save graph; React Router.

## Glossary

- **Graph_Canvas**: The React Flow canvas that replaces the graph placeholder. Renders inside the existing Cloudscape `Container` with "Memory Graph" header.
- **Project_Hub_Node**: A React Flow node representing a project. Acts as the central hub of a cluster — concept and memory nodes connect to it via edges, and dagre positions related nodes nearby. All project hub nodes share the same color — projects are distinguished by their text label (`display_name`), not by color. Labeled with the project's `display_name` from the stats response.
- **Concept_Node**: A React Flow node representing a unique concept string within a project. Connected to its project hub node and to the memory nodes that reference it. All concept nodes share the same color (distinct from project and memory node colors).
- **Memory_Node**: A React Flow node representing a single memory record. All memory nodes share the same color (distinct from project and concept node colors). Connected to its concept nodes via edges.
- **Project_Edge**: A React Flow edge connecting a Project_Hub_Node to a Concept_Node. Creates the cluster structure so dagre groups related nodes together.
- **Memory_Edge**: A React Flow edge connecting a Memory_Node to a Concept_Node. Drawn when the memory's `concepts` array contains the concept string.
- **Detail_Panel**: A Cloudscape side panel (or drawer) that slides in when a Memory_Node is clicked, showing the full memory record (title, summary, facts, concepts, files_touched, observation_type, created_at, source_event_ids).
- **Graph_Data**: The transformed data structure consumed by React Flow: `{ nodes: Node[], edges: Edge[] }`. Derived client-side from the memories response and the stats response (for project display names).

## Requirements

### Requirement 1: Install React Flow

**User Story:** As a developer, I want React Flow available in the project so I can render the graph.

#### Acceptance Criteria

1. THE root `package.json` SHALL add `@xyflow/react` as a devDependency (latest stable version, caret range).
2. THE `@xyflow/react` CSS SHALL be imported in the graph component (React Flow requires its base styles).
3. `npm install` at the root SHALL succeed with the new dependency.

### Requirement 2: Fetch Memories for the Graph

**User Story:** As the graph component, I want all memories loaded so I can derive the graph structure.

#### Acceptance Criteria

1. THE graph component SHALL fetch `GET /v1/memories?limit=500` on mount and on each 10-second refresh cycle.
2. THE response SHALL be typed as `MemoriesResponse` (new UI type matching the `/v1/memories` response shape: `{ items: MemoryRecord[], total, limit, offset }`).
3. WHEN the fetch is in flight, THE graph SHALL show a loading state inside the container.
4. WHEN the fetch fails, THE graph SHALL show an error state.
5. WHEN the response contains zero memories, THE graph SHALL show an empty state ("No memories yet — run some sessions to see your graph").

### Requirement 3: Graph Data Transformation

**User Story:** As the graph component, I want memories transformed into React Flow nodes and edges so the graph renders the correct structure.

#### Acceptance Criteria

1. THE transformation SHALL produce three types of nodes:
   - **Project_Hub_Nodes**: one per distinct `namespace` in the memories. Labeled with `display_name` from the stats response's `projects` array (matched by namespace). If no match, label with the first 12 hex chars of the project_id segment.
   - **Concept_Nodes**: one per unique concept string within each project. A concept appearing in project A and project B produces two separate nodes (concepts are per-project).
   - **Memory_Nodes**: one per memory record.
2. THE transformation SHALL produce two kinds of edges:
   - **Project_Edges**: from each Project_Hub_Node to each of its Concept_Nodes (creates the cluster structure for layout).
   - **Memory_Edges**: from each Memory_Node to each of its Concept_Nodes (derived from the memory's `concepts` array).
3. ALL nodes SHALL be flat (no `parentId` or `extent`). Clustering is achieved through edge connectivity and the dagre layout algorithm, not through React Flow's group-node mechanism. This ensures edges render correctly and dagre can produce organic, clustered layouts.
4. Concept_Nodes SHALL use fixed dimensions matching the layout engine's allocation to avoid rendering/layout mismatches.
5. Memory_Nodes SHALL all use the same color. The `observation_type` is available in the data for the detail panel but does NOT affect node color.
6. THE transformation SHALL be a pure function: `(memories: MemoryRecord[], projects: ProjectInfo[]) => { nodes: Node[], edges: Edge[] }`. Testable in isolation.

### Requirement 4: React Flow Canvas

**User Story:** As a kiro-learn user, I want to see my memories as an interactive graph I can pan, zoom, and explore.

#### Acceptance Criteria

1. THE Graph_Canvas SHALL render inside the existing Cloudscape `Container` with "Memory Graph" header, replacing the placeholder content.
2. THE canvas SHALL use React Flow's `<ReactFlow>` component with the computed nodes and edges.
3. THE canvas SHALL support pan (drag background) and zoom (scroll wheel).
4. THE canvas SHALL render a `<MiniMap>` component showing a bird's-eye overview.
5. THE canvas SHALL render `<Controls>` (zoom in/out/fit buttons).
6. THE canvas SHALL render a `<Background>` with a dot grid pattern.
7. THE canvas SHALL use a layout algorithm to position nodes automatically. Options: React Flow's built-in layout, or a force-directed layout via `dagre` or `elkjs`. The spec does not prescribe which — use whichever produces readable results for the tripartite (project → concept → memory) structure.
8. THE canvas height SHALL be at least 500px and SHALL expand to fill available space.

### Requirement 5: Custom Node Components

**User Story:** As a user, I want to visually distinguish projects, concepts, and memories by node type at a glance.

#### Acceptance Criteria

1. THE graph SHALL use a consistent color scheme where each node TYPE has its own color: one color for all Project_Hub_Nodes, a different color for all Concept_Nodes, and a third color for all Memory_Nodes. Projects, concepts, and memories are distinguished by color; individual items within a type are distinguished by their text labels.
2. THE graph SHALL render Project_Hub_Nodes as prominent labeled nodes showing the project's `display_name`. All project hub nodes use the same color. A `title` attribute SHALL provide the full name on hover for long labels that are ellipsized.
3. THE graph SHALL render Concept_Nodes as rounded rectangles with the concept text as label. All concept nodes use the same fixed dimensions matching the layout engine. All concept nodes use the same color.
4. THE graph SHALL render Memory_Nodes as smaller rectangles with the memory title (truncated to ~40 chars) as label. All memory nodes use the same color.
5. THE graph SHALL include a legend mapping node type colors to their names (Project, Concept, Memory).

### Requirement 6: Click-to-Detail Side Panel

**User Story:** As a user, I want to click a memory node and see its full details without leaving the graph.

#### Acceptance Criteria

1. WHEN a Memory_Node is clicked, THE Detail_Panel SHALL slide in from the right showing the full memory record.
2. THE Detail_Panel SHALL display: title, summary, facts (as a bulleted list), concepts (as tags/badges), files_touched (as a list), observation_type (as a colored badge), created_at (formatted timestamp), source_event_ids (as a list of IDs).
3. THE Detail_Panel SHALL use Cloudscape components (`Container`, `Header`, `SpaceBetween`, `Badge`, `Box`).
4. WHEN a Concept_Node is clicked, THE Detail_Panel SHALL show the concept name and a list of memory titles that reference it.
5. WHEN the user clicks the background or a close button, THE Detail_Panel SHALL close.
6. THE Detail_Panel SHALL NOT navigate away from the graph. It overlays or sits beside the canvas.

### Requirement 7: Empty, Loading, and Error States

**User Story:** As a user, I want clear feedback about the graph's state.

#### Acceptance Criteria

1. WHILE memories are loading, THE graph container SHALL show a centered `Spinner` with "Loading graph...".
2. WHEN the memories fetch fails, THE graph container SHALL show a `StatusIndicator` type `error` with "Failed to load memories".
3. WHEN there are zero memories, THE graph container SHALL show "No memories yet — run some sessions to see your graph".
4. WHEN there are memories but a specific project has zero concepts (all memories have empty `concepts` arrays), THE project hub node SHALL still render with its memory nodes but no concept nodes or edges.

### Requirement 8: UI Types for Memories

**User Story:** As a UI developer, I want TypeScript interfaces for the memories response.

#### Acceptance Criteria

1. THE UI SHALL define a `MemoriesResponse` interface in `ui/src/types/api.ts` matching `{ items: MemoryRecord[], total: number, limit: number, offset: number }`.
2. THE UI SHALL define a `MemoryRecord` interface matching the backend's `MemoryRecord` schema fields.
3. These types SHALL NOT be imported from `src/`.
4. THE UI SHALL provide runtime normalizers (`normalizeMemoryRecord`, `normalizeMemoriesResponse`) that validate required fields and coerce missing or incorrect values to safe defaults (empty strings, empty arrays, fallback `ObservationType`). The fetch handler SHALL call `normalizeMemoriesResponse` before storing data into UI state.

### Requirement 9: Updated Smoke Tests

#### Acceptance Criteria

1. THE smoke test SHALL mock `fetch` for `/v1/memories` in addition to existing mocks.
2. THE smoke test SHALL assert that "Memory Graph" header is present (existing).
3. THE smoke test SHALL assert that the "coming soon" placeholder text is NO LONGER present (replaced by the graph or empty state).
4. THE smoke test SHALL assert that when mocked memories are provided, at least one memory title appears in the rendered output.

### Requirement 10: Branding Consistency with Cloudscape

**User Story:** As a user, I want the graph to look like it belongs on the same page as the Cloudscape dashboard components, not like a foreign widget pasted in.

#### Acceptance Criteria

1. THE graph's node colors SHALL be derived from Cloudscape design tokens (e.g. `colorBackgroundContainerContent`, `colorTextBodyDefault`, `colorBorderDividerDefault`, `colorBackgroundStatusInfo`, `colorBackgroundStatusSuccess`, `colorBackgroundStatusWarning`). Node colors SHALL NOT be arbitrary hex values unrelated to the Cloudscape palette.
2. THE graph's text labels SHALL use the same font family as Cloudscape components (`'Amazon Ember'` or the fallback stack Cloudscape applies via `@cloudscape-design/global-styles`). No separate font import for the graph.
3. THE graph's edge colors SHALL use a Cloudscape border or divider token (e.g. `colorBorderDividerDefault`) so edges blend with the page's visual language.
4. THE legend, detail panel, and any graph-adjacent UI SHALL use Cloudscape components (`Box`, `Badge`, `Header`, `Container`, etc.) — not custom-styled HTML.
5. THE React Flow canvas background (dot grid) SHALL use a color consistent with Cloudscape's background tokens so the graph area doesn't clash with the surrounding layout.
6. THE overall visual impression SHALL be that the graph is a native part of the Cloudscape page, not an embedded third-party widget.

### Requirement 11: Graph is Read-Only

**User Story:** As a user, I want the graph to be a visualization tool only — I can pan, zoom, and move nodes around to explore, but I cannot create, delete, or connect nodes.

#### Acceptance Criteria

1. THE graph SHALL NOT allow users to create new nodes via any interaction (drag from empty space, double-click, context menu, etc.).
2. THE graph SHALL NOT allow users to create new edges by dragging between nodes. React Flow's connection handles SHALL be disabled.
3. THE graph SHALL NOT allow users to delete nodes or edges via keyboard (Backspace/Delete) or any other interaction.
4. THE graph SHALL allow users to drag individual nodes to reposition them for exploration. Repositioned nodes are not persisted — a refresh resets positions.
5. THE React Flow component SHALL be configured with `nodesConnectable={false}`, `nodesDraggable={true}`, `elementsSelectable={true}`, and `deleteKeyCode={null}` (or equivalent) to enforce read-only behavior while preserving exploration.

### Requirement 12: Graph Refreshes with Data

**User Story:** As a user, I want the graph to update when new memories are captured.

#### Acceptance Criteria

1. THE graph SHALL re-fetch `/v1/memories` on the same 10-second refresh cycle as stats and events.
2. WHEN new memories appear in the response, THE graph SHALL re-compute nodes and edges and update the canvas.
3. THE refresh SHALL NOT reset the user's pan/zoom position. React Flow preserves viewport state across re-renders by default when node IDs are stable.

## Non-functional Requirements

- **N1.** THE graph SHALL render smoothly (no visible jank) with up to 500 memory nodes and 200 concept nodes. React Flow handles this scale in SVG mode.
- **N2.** THE graph data transformation SHALL complete in under 50 ms for 500 memories.
- **N3.** THE `@xyflow/react` bundle addition SHALL keep the total `dist/ui/` size under 4 MiB uncompressed.
- **N4.** THE UI code SHALL NOT import from `src/`. Guard tests enforce.
- **N5.** THE graph component SHALL be keyboard-accessible: Tab to focus nodes, Enter to open detail panel.

## Out of Scope

- New backend endpoints — the graph derives everything from `/v1/memories` and `/v1/stats`.
- Cross-project concept merging — same concept string in different projects stays separate.
- Time-based visualization / decay / recency — all nodes rendered equally.
- Node search or filter — show everything.
- Drag-to-rearrange nodes (React Flow supports this but we don't need custom persistence).
- Export/save graph as image.
- React Router.
- Dark mode toggle.
