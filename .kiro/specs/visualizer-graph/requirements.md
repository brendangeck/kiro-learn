# Requirements: Visualizer Graph

## Introduction

This document defines the requirements for the memory graph — the hero feature of the v1 visualizer. The graph replaces the "coming soon" placeholder with a React Flow canvas showing project hub nodes and memory nodes connected by animated bezier edges in a force-directed, clustered layout.

This is the fifth and final spec: `project-path-capture` (shipped) → `visualizer-scaffold` (shipped) → `visualizer-read-api` (shipped) → `visualizer-dashboard` (shipped) → **`visualizer-graph` (this spec)**.

The dashboard already fetches `/v1/stats` and `/v1/events`. This spec adds a fetch to `/v1/memories` (all memories, paginated) and transforms the response into a React Flow graph. All graph structure — project grouping, concept extraction, edge computation — is derived client-side from the memories data. No new backend endpoints.

**In scope:** Install React Flow (`@xyflow/react`); fetch memories from `/v1/memories`; transform memories into graph nodes and edges; render with React Flow; project hub nodes; memory nodes; edges from projects to memories; click-to-detail side panel for memory nodes; pan/zoom/minimap; loading/error/empty states; runtime response validation; dark mode toggle; updated smoke tests.

**Out of scope:** New backend endpoints; cross-project concept merging; time-based visualization; node search/filter; drag-to-rearrange; export/save graph; React Router.

## Glossary

- **Graph_Canvas**: The React Flow canvas that replaces the graph placeholder. Renders inside the existing Cloudscape `Container` with "Memory Graph" header. No MiniMap, Controls, or React Flow attribution overlay — clean canvas with dot grid background.
- **Project_Hub_Node**: A React Flow node representing a project. Acts as the central hub of a cluster — memory nodes connect to it via edges, and d3-force positions related nodes nearby. Each project gets a color from a 6-hue palette (Blue, Violet, Rose, Amber, Emerald, Teal); memory nodes inherit their project's color. Labeled with the project's `display_name` from the stats response.
- **Memory_Node**: A React Flow node representing a single memory record. Fixed width (260px), left-aligned text truncated to ~40 chars with ellipsis. Tinted background with saturated border from its project's palette color. Concepts are stored in the node data for the detail panel but are NOT rendered as separate graph nodes.
- **Memory_Edge**: A React Flow animated bezier edge connecting a Project_Hub_Node to a Memory_Node. Edges use nearest-side handle routing (handles on all four sides of each node, `sourceHandle`/`targetHandle` assigned based on relative positions).
- **Detail_Panel**: A Cloudscape side panel (or drawer) that slides in when a Memory_Node is clicked, showing the full memory record (title, summary, facts, concepts as badges, files_touched, observation_type, created_at, source_event_ids).
- **Graph_Data**: The transformed data structure consumed by React Flow: `{ nodes: Node[], edges: Edge[] }`. Derived client-side from the memories response and the stats response (for project display names). Node IDs are stable (derived from namespace and record_id, not indices).

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

1. THE transformation SHALL produce two types of nodes:
   - **Project_Hub_Nodes**: one per distinct `namespace` in the memories. Labeled with `display_name` from the stats response's `projects` array (matched by namespace). If no match, label with the first 12 hex chars of the project_id segment. Each assigned a `colorIndex` from the 6-hue palette.
   - **Memory_Nodes**: one per memory record. Concepts are stored in the node data for the detail panel but are NOT rendered as separate graph nodes.
2. THE transformation SHALL produce edges from each Project_Hub_Node to each of its Memory_Nodes.
3. ALL nodes SHALL be flat (no `parentId` or `extent`). Clustering is achieved through edge connectivity and the d3-force layout, not through React Flow's group-node mechanism.
4. Node IDs SHALL be derived from immutable values: `project-{namespace}` for projects, `mem-{record_id}` for memories. This ensures stable IDs across refreshes regardless of data ordering.
5. Memory_Nodes SHALL inherit their project's palette color. The `observation_type` is available in the data for the detail panel but does NOT affect node color.
6. THE transformation SHALL be a pure function: `(memories: MemoryRecord[], projects: ProjectInfo[], darkMode?: boolean) => { nodes: Node[], edges: Edge[] }`. Testable in isolation.

### Requirement 4: React Flow Canvas

**User Story:** As a kiro-learn user, I want to see my memories as an interactive graph I can pan, zoom, and explore.

#### Acceptance Criteria

1. THE Graph_Canvas SHALL render inside the existing Cloudscape `Container` with "Memory Graph" header, replacing the placeholder content.
2. THE canvas SHALL use React Flow's `<ReactFlow>` component with the computed nodes and edges.
3. THE canvas SHALL support pan (drag background) and zoom (scroll wheel) with `minZoom={0.1}` to allow zooming far out.
4. THE canvas SHALL render a `<Background>` with a dot grid pattern. No MiniMap or Controls overlays — the canvas is clean.
5. THE React Flow attribution watermark SHALL be hidden via `proOptions={{ hideAttribution: true }}`.
6. THE canvas SHALL use d3-force for layout positioning. The force simulation uses deterministic circular initial positions (hashed from node IDs), link forces, charge repulsion (`-600`), center force, and collision avoidance to produce organic radial clusters.
7. THE canvas height SHALL be at least 500px and SHALL expand to fill available space.
8. THE canvas background color SHALL adapt to dark mode.

### Requirement 5: Custom Node Components

**User Story:** As a user, I want to visually distinguish projects, concepts, and memories by node type at a glance.

#### Acceptance Criteria

1. THE graph SHALL use a 6-hue color palette (Blue, Violet, Rose, Amber, Emerald, Teal) that cycles across projects. Each project and its memory nodes share the same palette color. Light and dark mode each have their own palette variant.
2. THE graph SHALL render Project_Hub_Nodes with a saturated background from the palette, white text, rounded corners, and a subtle box shadow. A `title` attribute SHALL provide the full name on hover. Handles on all four sides for nearest-side edge routing.
3. THE graph SHALL render Memory_Nodes as fixed-width (260px) rectangles with the memory title (truncated to ~40 chars + ellipsis) left-aligned. Tinted background with saturated border from the project's palette color. `title` attribute shows full title on hover. Handles on all four sides.
4. THE graph SHALL include a legend mapping node type colors to their names (Project, Memory).

### Requirement 6: Click-to-Detail Side Panel

**User Story:** As a user, I want to click a memory node and see its full details without leaving the graph.

#### Acceptance Criteria

1. WHEN a Memory_Node is clicked, THE Detail_Panel SHALL slide in from the right showing the full memory record.
2. THE Detail_Panel SHALL display: title, summary, facts (as a bulleted list), concepts (as tags/badges), files_touched (as a list), observation_type (as a colored badge), created_at (formatted timestamp), source_event_ids (as a list of IDs).
3. THE Detail_Panel SHALL use Cloudscape components (`Container`, `Header`, `SpaceBetween`, `Badge`, `Box`).
4. WHEN the user clicks the background or a close button, THE Detail_Panel SHALL close.
5. THE Detail_Panel SHALL NOT navigate away from the graph. It overlays or sits beside the canvas.

### Requirement 7: Empty, Loading, and Error States

**User Story:** As a user, I want clear feedback about the graph's state.

#### Acceptance Criteria

1. WHILE memories are loading, THE graph container SHALL show a centered `Spinner` with "Loading graph...".
2. WHEN the memories fetch fails, THE graph container SHALL show a `StatusIndicator` type `error` with "Failed to load memories".
3. WHEN there are zero memories, THE graph container SHALL show "No memories yet — run some sessions to see your graph".
4. WHEN there are memories but a specific project has zero concepts (all memories have empty `concepts` arrays), THE project hub node SHALL still render with its memory nodes and edges.

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

1. THE graph's node colors SHALL use a curated 6-hue palette (Blue `#3B82F6`, Violet `#8B5CF6`, Rose `#F43F5E`, Amber `#F59E0B`, Emerald `#10B981`, Teal `#14B8A6`) with light and dark mode variants. Each project cycles through the palette; memory nodes inherit their project's color.
2. THE graph's text labels SHALL use the same font family as Cloudscape components (`'Amazon Ember'` or the fallback stack Cloudscape applies via `@cloudscape-design/global-styles`). No separate font import for the graph.
3. THE graph's edge colors SHALL use a mid-gray (`#7d8998` light, `#4B5563` dark) for visibility against the canvas background.
4. THE legend, detail panel, and any graph-adjacent UI SHALL use Cloudscape components (`Box`, `Badge`, `Header`, `Container`, etc.) — not custom-styled HTML.
5. THE React Flow canvas background SHALL adapt to dark mode (`#f2f3f3` light, `#0f1b2d` dark).
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

### Requirement 13: Dark Mode Toggle

**User Story:** As a user, I want to switch between light and dark mode so the UI is comfortable in any lighting.

#### Acceptance Criteria

1. THE TopNavigation SHALL include a `light-dark` icon button (no text) to toggle between light and dark mode.
2. CLICKING the toggle SHALL call Cloudscape's `applyMode(Mode.Dark)` or `applyMode(Mode.Light)` from `@cloudscape-design/global-styles`.
3. ALL Cloudscape components (containers, headers, badges, etc.) SHALL automatically adapt to the selected mode.
4. THE graph canvas background, edge colors, and node palette SHALL adapt to the selected mode using light/dark palette variants.
5. THE selected mode SHALL be persisted to `localStorage` (`kiro-learn-dark-mode` key) and restored on page load.
6. THE TopNavigation SHALL also show collector health status (`status-positive`/`status-negative`/`status-pending` icon with "Collector Online"/"Collector Offline"/"Connecting…" text) and the version number.

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
