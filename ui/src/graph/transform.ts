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
 * Produces a flat graph with three node types:
 *   - Project hub nodes (blue) — one per namespace
 *   - Concept nodes (mint/green) — one per unique concept string per project
 *   - Memory nodes (pink/salmon) — one per memory record
 *
 * Edges:
 *   - Project hub → each concept (cluster structure)
 *   - Memory → each of its concepts
 *
 * Node IDs are derived from immutable values for stability across refreshes.
 */
export function transformToGraph(
  memories: MemoryRecord[],
  projects: ProjectInfo[],
  darkMode = false,
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

  for (const [namespace, mems] of byNamespace) {
    const projectId = `project-${namespace}`;
    const displayName = displayNames.get(namespace) ?? extractFallbackLabel(namespace);

    // Project hub node
    nodes.push({
      id: projectId,
      type: 'projectNode',
      data: { label: displayName, namespace, darkMode },
      position: { x: 0, y: 0 },
    });

    // Collect unique concepts for this project with degree counts
    const conceptCounts = new Map<string, number>();
    for (const mem of mems) {
      for (const concept of mem.concepts) {
        conceptCounts.set(concept, (conceptCounts.get(concept) ?? 0) + 1);
      }
    }

    // Concept nodes
    const conceptNodeIds = new Map<string, string>();
    for (const [concept, count] of conceptCounts) {
      const conceptNodeId = `concept-${namespace}-${concept}`;
      conceptNodeIds.set(concept, conceptNodeId);
      nodes.push({
        id: conceptNodeId,
        type: 'conceptNode',
        data: { label: concept, count, darkMode, namespace },
        position: { x: 0, y: 0 },
      });

      // Edge: project → concept (used when memories are hidden)
      edges.push({
        id: `${projectId}-to-${conceptNodeId}`,
        source: projectId,
        target: conceptNodeId,
        data: { linkType: 'project-concept' },
      });
    }

    // Memory nodes — edges to project and to each concept
    for (const mem of mems) {
      const memNodeId = `mem-${mem.record_id}`;
      nodes.push({
        id: memNodeId,
        type: 'memoryNode',
        data: {
          label: mem.title.length > 40 ? mem.title.slice(0, 40) + '…' : mem.title,
          memory: mem,
          darkMode,
        },
        position: { x: 0, y: 0 },
      });

      // Edge: memory → project
      edges.push({
        id: `${memNodeId}-to-${projectId}`,
        source: memNodeId,
        target: projectId,
        data: { linkType: 'memory-project' },
      });

      // Edges: memory → its concepts
      for (const concept of mem.concepts) {
        const conceptNodeId = conceptNodeIds.get(concept);
        if (conceptNodeId) {
          edges.push({
            id: `${memNodeId}-to-${conceptNodeId}`,
            source: memNodeId,
            target: conceptNodeId,
            data: { linkType: 'memory-concept' },
          });
        }
      }
    }
  }

  return { nodes, edges };
}

/**
 * Extracts a fallback label from a namespace when no project display_name is
 * available. Uses the first 12 hex chars of the project_id segment.
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
