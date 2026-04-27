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
 * - Groups memories by namespace into project supernodes.
 * - Extracts unique concepts per project with degree counts.
 * - Creates memory nodes with observation_type in data.
 * - Creates edges from each memory to its concept nodes.
 * - Concepts are per-project: same string in different projects = separate nodes.
 *
 * Node IDs are deterministic (index-based) so React Flow preserves viewport
 * across re-renders when data refreshes.
 *
 * Positions are placeholders — layout is applied separately.
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

    // Project supernode (group)
    nodes.push({
      id: projectId,
      type: 'projectSupernode',
      data: { label: displayName, namespace },
      position: { x: projectIndex * 600, y: 0 },
    });

    // Collect concepts for this project and count degree
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
          label: mem.title.length > 40 ? mem.title.slice(0, 40) : mem.title,
          memory: mem,
        },
        position: { x: memIndex * 120, y: 300 },
        parentId: projectId,
        extent: 'parent' as const,
      });

      // Edges from memory to its concepts
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

/**
 * Extracts a fallback label from a namespace when no project display_name is
 * available. Uses the first 12 hex chars of the project_id segment.
 *
 * Namespace format: /actor/<username>/project/<project_id>/
 */
function extractFallbackLabel(namespace: string): string {
  const parts = namespace.split('/');
  // Namespace: /actor/<username>/project/<project_id>/
  // Split on '/': ['', 'actor', '<username>', 'project', '<project_id>', '']
  const projectIdIndex = parts.indexOf('project');
  if (projectIdIndex !== -1 && projectIdIndex + 1 < parts.length) {
    const projectId = parts[projectIdIndex + 1] ?? '';
    return projectId.slice(0, 12);
  }
  return namespace.slice(0, 12);
}
