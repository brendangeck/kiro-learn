import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { Node, Edge } from '@xyflow/react';

/**
 * Node dimension constants used for collision radius.
 * Also used by custom node components to match rendering to layout.
 */
export const NODE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  projectSupernode: { width: 180, height: 50 },
  memoryNode: { width: 260, height: 40 },
};

const DEFAULT_DIMS = { width: 140, height: 40 };

/** Internal type for d3-force simulation nodes. */
interface SimNode extends SimulationNodeDatum {
  id: string;
  type: string;
  width: number;
  height: number;
}

/**
 * Simple deterministic hash of a string → number in [0, 1).
 * Same input always produces the same output, replacing Math.random().
 */
function hashToUnit(str: string, seed: number): number {
  let h = seed;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i);
    h = h | 0; // Convert to 32-bit int
  }
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Runs a d3-force simulation to compute positions for a flat graph.
 *
 * Forces:
 * - **link**: edges act as springs pulling connected nodes together
 * - **charge**: nodes repel each other (many-body force)
 * - **center**: keeps the graph centered at origin
 * - **collide**: prevents node overlap based on dimensions
 *
 * Initial positions are derived deterministically from node IDs so the
 * simulation always converges to the same layout for the same data.
 * This prevents nodes from jumping around on each 10s refresh cycle.
 */
export function applyForceLayout(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return [];

  // Build simulation nodes with deterministic circular initial positions.
  // Spreading nodes evenly around a circle prevents lopsided clustering.
  const radius = Math.max(150, nodes.length * 15);
  const simNodes: SimNode[] = nodes.map((node, i) => {
    const dims = NODE_DIMENSIONS[node.type ?? ''] ?? DEFAULT_DIMS;
    // Deterministic angle from hash, spread around full circle
    const angle = hashToUnit(node.id, 1) * 2 * Math.PI;
    // Vary the radius slightly per node so they don't all start on the same ring
    const r = radius * (0.3 + hashToUnit(node.id, 2) * 0.7);
    return {
      id: node.id,
      type: node.type ?? '',
      width: dims.width,
      height: dims.height,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
    };
  });

  // Build simulation links (d3-force uses source/target indices or id strings)
  const simLinks: SimulationLinkDatum<SimNode>[] = edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
  }));

  // Create and run simulation
  const simulation = forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
        .id((d) => d.id)
        .distance(180)
        .strength(0.4),
    )
    .force('charge', forceManyBody<SimNode>().strength(-600))
    .force('center', forceCenter(0, 0))
    .force(
      'collide',
      forceCollide<SimNode>().radius((d) => Math.max(d.width, d.height) * 0.8).strength(0.8),
    )
    .stop();

  // Tick to completion synchronously
  const iterations = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()));
  for (let i = 0; i < iterations; i++) {
    simulation.tick();
  }

  // Build lookup from simulation results
  const positionMap = new Map<string, { x: number; y: number }>();
  for (const simNode of simNodes) {
    positionMap.set(simNode.id, { x: simNode.x ?? 0, y: simNode.y ?? 0 });
  }

  // Map positions back to React Flow nodes
  return nodes.map((node) => {
    const pos = positionMap.get(node.id);
    return pos ? { ...node, position: { x: pos.x, y: pos.y } } : node;
  });
}
