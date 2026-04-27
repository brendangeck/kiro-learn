import type { Node, Edge } from '@xyflow/react';
import type { MemoryRecord } from '../types/api.js';

/**
 * Minimal project info needed for graph labeling.
 * Extracted from StatsResponse.projects entries.
 */
export interface ProjectInfo {
  namespace: string;
  display_name: string;
}

export interface GraphData {
  nodes: Node[];
  edges: Edge[];
}

/**
 * Pure transformation: memories + project metadata → React Flow graph data.
 *
 * Produces a flat graph with two node types:
 *   - Project hub nodes (one per namespace)
 *   - Memory nodes (one per memory record)
 *
 * Edges connect each memory to its project hub. Concepts are stored in
 * the memory node data for display in the detail panel sidebar but are
 * NOT rendered as separate graph nodes.
 *
 * Node IDs are deterministic (index-based) so React Flow preserves viewport
 * across re-renders when data refreshes.
 *
 * Positions are placeholders — layout is applied separately by dagre.
 */
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
    const displayName = displayNames.get(namespace) ?? extractFallbackLabel(namespace);

    // Project hub node
    nodes.push({
      id: projectId,
      type: 'projectSupernode',
      data: { label: displayName, namespace },
      position: { x: 0, y: 0 },
    });

    // Memory nodes + edges to project hub
    let memIndex = 0;
    for (const mem of mems) {
      const memNodeId = `${projectId}-mem-${memIndex}`;
      nodes.push({
        id: memNodeId,
        type: 'memoryNode',
        data: {
          label: mem.title.length > 40 ? mem.title.slice(0, 40) + '…' : mem.title,
          memory: mem,
        },
        position: { x: 0, y: 0 },
      });

      // Edge from project hub → memory
      edges.push({
        id: `${projectId}-to-${memNodeId}`,
        source: projectId,
        target: memNodeId,
      });

      memIndex++;
    }
    projectIndex++;
  }

  return { nodes, edges };
}

/**
 * Extracts a fallback label from a namespace when no project display_name is
 * available. Uses the first 12 hex chars of the project_id segment.
 *
 * Namespace format: /actor/<username>/project/<project_id>/
 */
function extractFallbackLabel(namespace: string): string {
  const parts = namespace.split('/');
  const projectIdIndex = parts.indexOf('project');
  if (projectIdIndex !== -1 && projectIdIndex + 1 < parts.length) {
    const projectId = parts[projectIdIndex + 1] ?? '';
    return projectId.slice(0, 12);
  }
  return namespace.slice(0, 12);
}
