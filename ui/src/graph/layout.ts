import dagre from 'dagre';
import type { Node, Edge } from '@xyflow/react';

/**
 * Node dimension constants used by dagre for space allocation.
 * These don't control rendering size — they tell dagre how much
 * space each node occupies so it can avoid overlaps.
 */
const NODE_DIMENSIONS = {
  projectSupernode: { width: 600, height: 400 },
  conceptNode: { width: 160, height: 50 },
  memoryNode: { width: 140, height: 40 },
} as const;

/** Horizontal gap between project supernodes. */
const PROJECT_GAP_X = 80;

/** Padding inside a project supernode around its children. */
const PROJECT_PADDING = { top: 60, left: 40, bottom: 40, right: 40 };

/**
 * Applies dagre-based hierarchical layout to graph nodes.
 *
 * Strategy: run dagre independently per project group (concepts + memories),
 * then space project supernodes horizontally. Child node positions are
 * relative to their parent supernode (React Flow convention when parentId
 * is set).
 *
 * Pure function — no React dependency.
 */
export function applyDagreLayout(nodes: Node[], edges: Edge[]): Node[] {
  // Separate project supernodes from child nodes
  const projectNodes = nodes.filter((n) => n.type === 'projectSupernode');
  const childNodes = nodes.filter((n) => n.type !== 'projectSupernode');

  // Group children by parentId
  const childrenByProject = new Map<string, Node[]>();
  for (const child of childNodes) {
    const parentId = child.parentId ?? '';
    const list = childrenByProject.get(parentId) ?? [];
    list.push(child);
    childrenByProject.set(parentId, list);
  }

  // Collect edges per project (both source and target must share the same parent)
  const childParentLookup = new Map<string, string>();
  for (const child of childNodes) {
    if (child.parentId) {
      childParentLookup.set(child.id, child.parentId);
    }
  }

  const edgesByProject = new Map<string, Edge[]>();
  for (const edge of edges) {
    const parentId = childParentLookup.get(edge.source) ?? childParentLookup.get(edge.target);
    if (parentId) {
      const list = edgesByProject.get(parentId) ?? [];
      list.push(edge);
      edgesByProject.set(parentId, list);
    }
  }

  // Layout each project group independently, track bounding boxes
  const layoutResults = new Map<string, { nodes: Map<string, { x: number; y: number }>; width: number; height: number }>();

  for (const project of projectNodes) {
    const children = childrenByProject.get(project.id) ?? [];
    const projectEdges = edgesByProject.get(project.id) ?? [];

    if (children.length === 0) {
      layoutResults.set(project.id, { nodes: new Map(), width: 200, height: 100 });
      continue;
    }

    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', ranksep: 80, nodesep: 40, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    // Add child nodes with dimensions and rank hints
    for (const child of children) {
      const dims = child.type === 'conceptNode'
        ? NODE_DIMENSIONS.conceptNode
        : NODE_DIMENSIONS.memoryNode;

      g.setNode(child.id, { width: dims.width, height: dims.height });
    }

    // Add edges
    for (const edge of projectEdges) {
      // Edges go memory → concept; dagre will rank sources above targets
      // by default in TB mode. We want concepts above memories, so
      // reverse the edge direction for dagre (concept is target in our
      // data model, but should be ranked higher).
      g.setEdge(edge.target, edge.source);
    }

    dagre.layout(g);

    // Extract positions and compute bounding box
    const positions = new Map<string, { x: number; y: number }>();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const child of children) {
      const dagreNode = g.node(child.id);
      if (dagreNode) {
        // dagre positions are center-based; convert to top-left for React Flow
        const x = dagreNode.x - (dagreNode.width / 2);
        const y = dagreNode.y - (dagreNode.height / 2);
        positions.set(child.id, { x, y });

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + dagreNode.width);
        maxY = Math.max(maxY, y + dagreNode.height);
      }
    }

    // Normalize positions so the top-left child starts at (padding, padding)
    for (const pos of positions.values()) {
      pos.x = pos.x - minX + PROJECT_PADDING.left;
      pos.y = pos.y - minY + PROJECT_PADDING.top;
    }

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const totalWidth = contentWidth + PROJECT_PADDING.left + PROJECT_PADDING.right;
    const totalHeight = contentHeight + PROJECT_PADDING.top + PROJECT_PADDING.bottom;

    layoutResults.set(project.id, {
      nodes: positions,
      width: Math.max(totalWidth, NODE_DIMENSIONS.projectSupernode.width),
      height: Math.max(totalHeight, NODE_DIMENSIONS.projectSupernode.height),
    });
  }

  // Position project supernodes horizontally
  const updatedNodes: Node[] = [];
  let currentX = 0;

  for (const project of projectNodes) {
    const result = layoutResults.get(project.id);
    const width = result?.width ?? NODE_DIMENSIONS.projectSupernode.width;
    const height = result?.height ?? NODE_DIMENSIONS.projectSupernode.height;

    updatedNodes.push({
      ...project,
      position: { x: currentX, y: 0 },
      style: {
        ...project.style,
        width,
        height,
      },
    });

    currentX += width + PROJECT_GAP_X;
  }

  // Position child nodes relative to their parent supernode
  for (const child of childNodes) {
    const parentId = child.parentId ?? '';
    const result = layoutResults.get(parentId);
    const pos = result?.nodes.get(child.id);

    updatedNodes.push({
      ...child,
      position: pos ?? child.position,
    });
  }

  return updatedNodes;
}
