import { useMemo } from 'react';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Box from '@cloudscape-design/components/box';

import { transformToGraph, type ProjectInfo } from '../graph/transform.js';
import { applyDagreLayout } from '../graph/layout.js';
import { ProjectSupernode } from '../graph/ProjectSupernode.js';
import { ConceptNode } from '../graph/ConceptNode.js';
import { MemoryNode } from '../graph/MemoryNode.js';
import { GraphLegend } from '../graph/GraphLegend.js';
import { graphTheme } from '../graph/theme.js';
import type { MemoryRecord } from '../types/api.js';

/**
 * Stable node-type map — defined outside the component so React Flow
 * doesn't re-register types on every render.
 */
const nodeTypes = {
  projectSupernode: ProjectSupernode,
  conceptNode: ConceptNode,
  memoryNode: MemoryNode,
};

interface MemoryGraphProps {
  memories: MemoryRecord[];
  projects: ProjectInfo[];
  loading: boolean;
  error: string | null;
  onNodeClick: (memory: MemoryRecord | null, concept: string | null) => void;
}

/**
 * Interactive React Flow graph showing project supernodes, concept nodes,
 * and memory nodes with edges connecting memories to their concepts.
 *
 * Read-only: users can pan, zoom, and drag nodes to explore, but cannot
 * create, delete, or connect nodes.
 *
 * Validates: Requirements 2.3, 2.4, 2.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6,
 * 4.8, 7.1, 7.2, 7.3, 7.4, 11.1, 11.2, 11.3, 11.4, 11.5
 */
export function MemoryGraph({
  memories,
  projects,
  loading,
  error,
  onNodeClick,
}: MemoryGraphProps) {
  // Memoize the transformation + layout so it only recomputes when data changes
  const { layoutNodes, edges } = useMemo(() => {
    if (memories.length === 0) {
      return { layoutNodes: [], edges: [] };
    }
    const graph = transformToGraph(memories, projects);
    const positioned = applyDagreLayout(graph.nodes, graph.edges);
    return { layoutNodes: positioned, edges: graph.edges };
  }, [memories, projects]);

  // --- Loading state (Req 7.1) ---
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

  // --- Error state (Req 7.2) ---
  if (error) {
    return (
      <Box textAlign="center" padding={{ vertical: 'xxl' }}>
        <StatusIndicator type="error">Failed to load memories</StatusIndicator>
      </Box>
    );
  }

  // --- Empty state (Req 7.3) ---
  if (memories.length === 0) {
    return (
      <Box textAlign="center" padding={{ vertical: 'xxl' }} color="text-body-secondary">
        No memories yet — run some sessions to see your graph
      </Box>
    );
  }

  // --- Graph canvas (Req 4.2–4.8, 11.1–11.5) ---
  return (
    <>
      <div style={{ height: 500 }}>
        <ReactFlow
          nodes={layoutNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          nodesConnectable={false}
          nodesDraggable={true}
          elementsSelectable={true}
          deleteKeyCode={null}
          fitView
          onNodeClick={(_event: React.MouseEvent, node: Node) => {
            if (node.type === 'memoryNode') {
              onNodeClick(node.data.memory as MemoryRecord, null);
            } else if (node.type === 'conceptNode') {
              onNodeClick(null, node.data.label as string);
            }
          }}
        >
          <MiniMap />
          <Controls />
          <Background variant={BackgroundVariant.Dots} color={graphTheme.canvas.background} />
        </ReactFlow>
      </div>
      <GraphLegend />
    </>
  );
}
