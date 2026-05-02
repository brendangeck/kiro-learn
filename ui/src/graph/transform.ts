import type { MemoryRecord } from '../types/api.js';

/**
 * Pure transform: domain data → `CosmosGraphData` (typed buffers for
 * `@cosmos.gl/graph`). No React, no DOM, no cosmos.gl imports.
 *
 * Visual model is deliberately minimal: colored dots, no labels, no shape
 * variation, no per-point size, no cluster force. Node kind is
 * communicated by color only (see `GraphLegend.tsx`). Layout is handled
 * entirely by cosmos.gl's default simulation (repulsion + link springs +
 * gravity).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeKind = 'project' | 'memory' | 'concept';
export type NodeId = string;

/** Minimal project info. Re-exported for upstream callers. */
export interface ProjectInfo {
  namespace: string;
  display_name: string;
}

export interface PackedTheme {
  readonly darkMode: boolean;
  readonly projectFill: readonly [number, number, number, number];
  readonly memoryFill: readonly [number, number, number, number];
  readonly conceptFill: readonly [number, number, number, number];
  readonly edgeColor: readonly [number, number, number, number];
  readonly backgroundColor: string;
}

export interface CosmosGraphData {
  // Typed-array buffers to upload to the engine.
  readonly positions: Float32Array; // length = 2 * pointCount
  readonly colors: Float32Array; // length = 4 * pointCount (RGBA 0..1)
  readonly sizes: Float32Array; // length = pointCount (simulation-space units)
  readonly links: Float32Array; // length = 2 * linkCount
  readonly linkColors: Float32Array; // length = 4 * linkCount

  // Bi-map for interaction: translate between engine point indices and
  // domain-level ids + kinds. `memoryIndexByRecordId` lets click handlers
  // resolve a memory click back to its `MemoryRecord`. `indexToLabel`
  // carries the string to render above each point — null for points that
  // should not be labeled. Currently only project points carry labels
  // (their display_name); memory/concept entries are null.
  readonly indexToId: readonly NodeId[];
  readonly indexToKind: readonly NodeKind[];
  readonly idToIndex: ReadonlyMap<NodeId, number>;
  readonly indexToLabel: readonly (string | null)[];
  readonly memoryIndexByRecordId: ReadonlyMap<string, number>;
}

// ---------------------------------------------------------------------------
// Simulation-space constants
// ---------------------------------------------------------------------------

/**
 * Simulation space is `[0, SPACE_SIZE]` on both axes, matching cosmos.gl's
 * default `spaceSize`. Seeds are placed in a tight cluster at `SPACE_CENTER`
 * so the engine's force simulation spreads them from a controlled start.
 */
const SPACE_SIZE = 4096;
const SPACE_CENTER = SPACE_SIZE / 2; // 2048

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic FNV-1a style hash: maps (id, salt) to a float in [0, 1).
 * Same inputs always produce the same output, so initial positions stay
 * stable across polling refreshes.
 */
function hashToUnit(id: string, salt: string): number {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  const s = `${salt}:${id}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) / 0x1_0000_0000;
}

interface WorkingNode {
  id: NodeId;
  kind: NodeKind;
  namespace: string;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Build a `CosmosGraphData` from raw domain data.
 *
 * Node ordering is deterministic and emitted in render-back-to-front order:
 * first concepts (unique `(namespace, concept)` pairs in first-seen order),
 * then memories in input order, then projects in input order. This order is
 * load-bearing: cosmos.gl draws points in buffer-index order — later indices
 * paint over earlier ones — so emitting projects last keeps them visible on
 * top even when the force layout settles concepts and memories around them.
 */
export function transform(
  memories: readonly MemoryRecord[],
  projects: readonly ProjectInfo[],
  theme: PackedTheme,
): CosmosGraphData {
  // Sort inputs by primary key so the emitted node order is stable across
  // polling refreshes. Without this, the backend's newest-first ordering
  // would shuffle indices on every fetch and break the append-only
  // incremental-update path in CosmosGraph.
  const sortedProjects = [...projects].sort((a, b) => a.namespace.localeCompare(b.namespace));
  const sortedMemories = [...memories].sort((a, b) => a.record_id.localeCompare(b.record_id));

  // Lookup for project display names, keyed by namespace. Used to populate
  // `indexToLabel` for project points below.
  const projectDisplayName = new Map<string, string>();
  for (const p of sortedProjects) projectDisplayName.set(p.namespace, p.display_name);

  // 1. Collect nodes in render-back-to-front order: concepts, memories,
  //    projects.
  const nodes: WorkingNode[] = [];
  const memoryIndexByRecordId = new Map<string, number>();
  const seenConcept = new Set<string>();

  for (const m of sortedMemories) {
    for (const c of m.concepts) {
      const key = `${m.namespace}:${c}`;
      if (seenConcept.has(key)) continue;
      seenConcept.add(key);
      nodes.push({ id: `concept:${key}`, kind: 'concept', namespace: m.namespace });
    }
  }
  for (const m of sortedMemories) {
    memoryIndexByRecordId.set(m.record_id, nodes.length);
    nodes.push({ id: `memory:${m.record_id}`, kind: 'memory', namespace: m.namespace });
  }
  for (const p of sortedProjects) {
    nodes.push({ id: `project:${p.namespace}`, kind: 'project', namespace: p.namespace });
  }

  const pointCount = nodes.length;

  // 2. Bi-map.
  const indexToId: NodeId[] = new Array<NodeId>(pointCount);
  const indexToKind: NodeKind[] = new Array<NodeKind>(pointCount);
  const indexToLabel: (string | null)[] = new Array<string | null>(pointCount);
  const idToIndex = new Map<NodeId, number>();
  for (const [i, n] of nodes.entries()) {
    indexToId[i] = n.id;
    indexToKind[i] = n.kind;
    idToIndex.set(n.id, i);
    // Only project points carry visible labels for now. Memory and concept
    // labels can be introduced later without changing this contract.
    indexToLabel[i] = n.kind === 'project'
      ? projectDisplayName.get(n.namespace) ?? n.namespace
      : null;
  }

  // 3. Buffers. Seed position + packed RGBA color + per-kind size in one loop.
  const positions = new Float32Array(2 * pointCount);
  const colors = new Float32Array(4 * pointCount);
  const sizes = new Float32Array(pointCount);

  // Per-kind size. Projects are visibly larger than leaves so hubs
  // stand out as cluster anchors.
  const DEFAULT_SIZE = 6;
  const PROJECT_SIZE = 14;

  for (const [i, n] of nodes.entries()) {
    // Baseline seed: match the cosmos.gl demo's tight random cluster near
    // the center of the default `spaceSize` (4096). Every point starts
    // within a ~0.5%-wide box at the center and the simulation forces
    // spread them from there. Still deterministic per id for stable
    // positions across reloads.
    const angle = hashToUnit(n.id, 'a') * Math.PI * 2;
    const radius = hashToUnit(n.id, 'r') * (SPACE_SIZE * 0.005);
    positions[2 * i] = SPACE_CENTER + Math.cos(angle) * radius;
    positions[2 * i + 1] = SPACE_CENTER + Math.sin(angle) * radius;

    // Packed RGBA fill from theme. This is the only signal of node kind.
    const fill =
      n.kind === 'project' ? theme.projectFill :
      n.kind === 'memory' ? theme.memoryFill :
      theme.conceptFill;
    colors[4 * i] = fill[0];
    colors[4 * i + 1] = fill[1];
    colors[4 * i + 2] = fill[2];
    colors[4 * i + 3] = fill[3];

    sizes[i] = n.kind === 'project' ? PROJECT_SIZE : DEFAULT_SIZE;
  }

  // 4. Links: memory→project and memory→concept. No project→concept.
  //
  // `m.concepts` is not guaranteed unique by the API type, so we dedupe
  // per-memory before emitting links. Without this, a memory that repeats
  // a concept in its array would produce duplicate memory→concept edges
  // to the same concept point (the concept point itself is already deduped
  // during node emission via `seenConcept`).
  const linkPairs: number[] = [];
  for (const m of sortedMemories) {
    const memIdx = idToIndex.get(`memory:${m.record_id}`);
    if (memIdx === undefined) continue;
    const projIdx = idToIndex.get(`project:${m.namespace}`);
    if (projIdx !== undefined) linkPairs.push(memIdx, projIdx);
    const seenConcepts = new Set<string>();
    for (const c of m.concepts) {
      if (seenConcepts.has(c)) continue;
      seenConcepts.add(c);
      const cIdx = idToIndex.get(`concept:${m.namespace}:${c}`);
      if (cIdx !== undefined) linkPairs.push(memIdx, cIdx);
    }
  }

  const linkCount = linkPairs.length / 2;
  const links = new Float32Array(2 * linkCount);
  const linkColors = new Float32Array(4 * linkCount);
  for (let i = 0; i < linkCount; i++) {
    const src = linkPairs[2 * i];
    const dst = linkPairs[2 * i + 1];
    // `linkPairs` is populated in contiguous (src, dst) pairs above, so
    // both reads are always defined at this point. Guard defensively
    // anyway to satisfy noUncheckedIndexedAccess without non-null
    // assertions.
    if (src === undefined || dst === undefined) continue;
    links[2 * i] = src;
    links[2 * i + 1] = dst;
    linkColors[4 * i] = theme.edgeColor[0];
    linkColors[4 * i + 1] = theme.edgeColor[1];
    linkColors[4 * i + 2] = theme.edgeColor[2];
    linkColors[4 * i + 3] = theme.edgeColor[3];
  }

  return {
    positions,
    colors,
    sizes,
    links,
    linkColors,
    indexToId,
    indexToKind,
    idToIndex,
    indexToLabel,
    memoryIndexByRecordId,
  };
}
