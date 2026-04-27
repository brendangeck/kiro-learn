import { useMemo, useCallback } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Box from '@cloudscape-design/components/box';

import { transformToGraph, type ProjectInfo } from '../graph/transform.js';
import { applyForceLayout } from '../graph/layout.js';
import { ProjectSupernode } from '../graph/ProjectSupernode.js';
import { MemoryNode } from '../graph/MemoryNode.js';
import { GraphLegend } from '../graph/GraphLegend.js';
import { getGraphColors } from '../graph/theme.js';
import type { MemoryRecord } from '../types/api.js';

/**
 * Stable node-type map — defined outside the component so React Flow
 * doesn't re-register types on every render.
 */
const nodeTypes = {
  projectSupernode: ProjectSupernode,
  memoryNode: MemoryNode,
};

interface MemoryGraphProps {
  memories: MemoryRecord[];
  projects: ProjectInfo[];
  loading: boolean;
  error: string | null;
  darkMode: boolean;
  onNodeClick: (memory: MemoryRecord | null, concept: string | null) => void;
}

/**
 * Interactive React Flow graph showing project hub nodes and memory nodes
 * with animated edges. Uses d3-force for organic, clustered positioning.
 *
 * Read-only: users can pan, zoom, and drag nodes to explore, but cannot
 * create, delete, or connect nodes.
 */
export function MemoryGraph({
  memories,
  projects,
  loading,
  error,
  darkMode,
  onNodeClick,
}: MemoryGraphProps) {
  const colors = getGraphColors(darkMode);

  // Stable content key — only recompute layout when actual data changes,
  // not on every 10s fetch that returns the same records.
  const contentKey = useMemo(
    () => memories.map((m) => m.record_id).join(','),
    [memories],
  );

  const projectKey = useMemo(
    () => projects.map((p) => p.namespace).join(','),
    [projects],
  );

  // Compute initial layout from data (layout doesn't depend on darkMode)
  const { initialNodes, initialEdges } = useMemo(() => {
    if (memories.length === 0) {
      return { initialNodes: [] as Node[], initialEdges: [] as typeof styledEdges };
    }
    const graph = transformToGraph(memories, projects, darkMode);
    const positioned = applyForceLayout(graph.nodes, graph.edges);

    // Build position lookup for closest-handle selection
    const posMap = new Map<string, { x: number; y: number }>();
    for (const n of positioned) {
      posMap.set(n.id, n.position);
    }

    // Assign sourceHandle/targetHandle based on relative node positions
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
    return { initialNodes: positioned, initialEdges: styledEdges };
  }, [contentKey, projectKey, memories, projects, darkMode, colors.edgeStroke]);

  // Use React Flow's state hooks for interactive node dragging
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sync when data or theme changes
  useMemo(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type === 'memoryNode') {
        onNodeClick(node.data.memory as MemoryRecord, null);
      }
    },
    [onNodeClick],
  );

  // Default edge options (updated per theme)
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
      <div style={{ height: 500, background: colors.canvasBackground }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          nodesConnectable={false}
          nodesDraggable={true}
          elementsSelectable={true}
          deleteKeyCode={null}
          minZoom={0.1}
          fitView
          onNodeClick={handleNodeClick}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} color={colors.canvasBackground} />
        </ReactFlow>
      </div>
      <GraphLegend darkMode={darkMode} />
    </>
  );
}
