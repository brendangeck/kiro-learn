import { useState, useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Box from '@cloudscape-design/components/box';
import Checkbox from '@cloudscape-design/components/checkbox';
import SpaceBetween from '@cloudscape-design/components/space-between';

import { transformToGraph, type ProjectInfo } from '../graph/transform.js';
import { applyForceLayout } from '../graph/layout.js';
import { ProjectNode } from '../graph/ProjectNode.js';
import { ConceptNode } from '../graph/ConceptNode.js';
import { MemoryNode } from '../graph/MemoryNode.js';
import { getGraphColors } from '../graph/theme.js';
import type { MemoryRecord } from '../types/api.js';

const nodeTypes = {
  projectNode: ProjectNode,
  conceptNode: ConceptNode,
  memoryNode: MemoryNode,
};

/** Node type keys matching the checkbox filters. */
const TYPE_MAP = {
  projects: 'projectNode',
  memories: 'memoryNode',
  concepts: 'conceptNode',
} as const;

/**
 * Determines which edge linkTypes to include based on active filters.
 *
 * Rules:
 * - All 3 checked: memory→project + memory→concept (no project→concept)
 * - Projects + Memories: memory→project
 * - Projects + Concepts: project→concept
 * - Memories + Concepts: memory→concept
 * - Single type: no edges
 */
function getAllowedLinkTypes(p: boolean, m: boolean, c: boolean): Set<string> {
  const allowed = new Set<string>();
  if (p && m && c) {
    allowed.add('memory-project');
    allowed.add('memory-concept');
  } else if (p && m) {
    allowed.add('memory-project');
  } else if (p && c) {
    allowed.add('project-concept');
  } else if (m && c) {
    allowed.add('memory-concept');
  }
  return allowed;
}

interface MemoryGraphProps {
  memories: MemoryRecord[];
  projects: ProjectInfo[];
  loading: boolean;
  error: string | null;
  darkMode: boolean;
  onNodeClick: (memory: MemoryRecord | null, concept: string | null) => void;
}

export function MemoryGraph({
  memories,
  projects,
  loading,
  error,
  darkMode,
  onNodeClick,
}: MemoryGraphProps) {
  const colors = getGraphColors(darkMode);

  // Filter checkboxes — all on by default
  const [showProjects, setShowProjects] = useState(true);
  const [showMemories, setShowMemories] = useState(true);
  const [showConcepts, setShowConcepts] = useState(true);

  // Stable content key
  const contentKey = useMemo(
    () => memories.map((m) => m.record_id).join(','),
    [memories],
  );
  const projectKey = useMemo(
    () => projects.map((p) => p.namespace).join(','),
    [projects],
  );

  // Compute full graph (all nodes + all edges with linkType tags)
  const fullGraph = useMemo(() => {
    if (memories.length === 0) {
      return { allNodes: [] as Node[], allEdges: [] as Edge[] };
    }
    const graph = transformToGraph(memories, projects, darkMode);
    const positioned = applyForceLayout(graph.nodes, graph.edges);

    // Build position lookup for closest-handle selection
    const posMap = new Map<string, { x: number; y: number }>();
    for (const n of positioned) {
      posMap.set(n.id, n.position);
    }

    const styledEdges = graph.edges.map((e) => {
      const sp = posMap.get(e.source);
      const tp = posMap.get(e.target);
      let sourceHandle: string | undefined;
      let targetHandle: string | undefined;

      if (sp && tp) {
        const dx = tp.x - sp.x;
        const dy = tp.y - sp.y;
        if (Math.abs(dx) > Math.abs(dy)) {
          sourceHandle = dx > 0 ? 's-right' : 's-left';
          targetHandle = dx > 0 ? 't-left' : 't-right';
        } else {
          sourceHandle = dy > 0 ? 's-bottom' : 's-top';
          targetHandle = dy > 0 ? 't-top' : 't-bottom';
        }
      }

      return {
        ...e,
        sourceHandle,
        targetHandle,
        animated: true,
        style: { stroke: colors.edgeStroke, strokeWidth: 1.5 },
      };
    });

    return { allNodes: positioned, allEdges: styledEdges };
  }, [contentKey, projectKey, memories, projects, darkMode, colors.edgeStroke]);

  // Filter nodes and edges based on checkboxes
  const { filteredNodes, filteredEdges } = useMemo(() => {
    const visibleTypes = new Set<string>();
    if (showProjects) visibleTypes.add(TYPE_MAP.projects);
    if (showMemories) visibleTypes.add(TYPE_MAP.memories);
    if (showConcepts) visibleTypes.add(TYPE_MAP.concepts);

    const fNodes = fullGraph.allNodes.filter((n) => visibleTypes.has(n.type ?? ''));
    const visibleNodeIds = new Set(fNodes.map((n) => n.id));

    const allowedLinks = getAllowedLinkTypes(showProjects, showMemories, showConcepts);

    const fEdges = fullGraph.allEdges.filter((e) => {
      // Both endpoints must be visible
      if (!visibleNodeIds.has(e.source) || !visibleNodeIds.has(e.target)) return false;
      // Edge linkType must be allowed
      const linkType = typeof e.data === 'object' && e.data !== null && 'linkType' in e.data
        ? String(e.data.linkType)
        : '';
      return allowedLinks.has(linkType);
    });

    return { filteredNodes: fNodes, filteredEdges: fEdges };
  }, [fullGraph, showProjects, showMemories, showConcepts]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type === 'memoryNode') {
        onNodeClick(node.data.memory as MemoryRecord, null);
      } else if (node.type === 'conceptNode') {
        onNodeClick(null, node.data.label as string);
      }
    },
    [onNodeClick],
  );

  const defaultEdgeOptions = useMemo(() => ({
    style: { stroke: colors.edgeStroke, strokeWidth: 1.5 },
    animated: true,
  }), [colors.edgeStroke]);

  if (loading) {
    return (
      <Box textAlign="center" padding={{ vertical: 'xxl' }}>
        <Spinner size="large" />
        <Box variant="p" color="text-body-secondary" margin={{ top: 's' }}>
          Loading graph...
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box textAlign="center" padding={{ vertical: 'xxl' }}>
        <StatusIndicator type="error">Failed to load memories</StatusIndicator>
      </Box>
    );
  }

  if (memories.length === 0) {
    return (
      <Box textAlign="center" padding={{ vertical: 'xxl' }} color="text-body-secondary">
        No memories yet — run some sessions to see your graph
      </Box>
    );
  }

  return (
    <>
      <Box margin={{ bottom: 's' }}>
        <SpaceBetween direction="horizontal" size="l">
          <Checkbox checked={showProjects} onChange={({ detail }) => setShowProjects(detail.checked)}>
            Projects
          </Checkbox>
          <Checkbox checked={showMemories} onChange={({ detail }) => setShowMemories(detail.checked)}>
            Memories
          </Checkbox>
          <Checkbox checked={showConcepts} onChange={({ detail }) => setShowConcepts(detail.checked)}>
            Concepts
          </Checkbox>
        </SpaceBetween>
      </Box>
      <div style={{ height: 500, background: colors.canvasBackground }}>
        <ReactFlow
          nodes={filteredNodes}
          edges={filteredEdges}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          nodesConnectable={false}
          nodesDraggable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          deleteKeyCode={null}
          minZoom={0.1}
          fitView
          onNodeClick={handleNodeClick}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} color={colors.gridDot} />
        </ReactFlow>
      </div>
    </>
  );
}
