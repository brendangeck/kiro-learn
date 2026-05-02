/**
 * Example-based unit tests for the pure `transform()` function in
 * `ui/src/graph/transform.ts`.
 *
 * These tests pin down small, enumerable behaviors: node emission order,
 * id / kind / label construction, link construction, per-namespace concept
 * scoping, and buffer shape at a known size.
 *
 * Property-level invariants (shape, determinism, bi-map round-trip, bounds)
 * live in the `cosmos-transform-*.property.test.ts` suites.
 *
 * @see .kiro/specs/cosmos-gl-graph/design.md
 * @see .kiro/specs/cosmos-gl-graph/requirements.md
 */

import { describe, it, expect } from 'vitest';

import {
  transform,
  type CosmosGraphData,
  type PackedTheme,
  type ProjectInfo,
} from '../../ui/src/graph/transform.js';
import type { MemoryRecord } from '../../ui/src/types/api.js';

// ---------------------------------------------------------------------------
// Test fixtures / helpers
// ---------------------------------------------------------------------------

/**
 * Minimal, clearly-distinguishable theme built from constants rather than
 * the real demo palette. Keeps assertions about color values self-evident
 * and decouples the tests from color-token changes.
 */
const THEME: PackedTheme = {
  darkMode: false,
  projectFill: [1, 0, 0, 1],
  memoryFill:  [0, 1, 0, 1],
  conceptFill: [0, 0, 1, 1],
  edgeColor:   [0.5, 0.5, 0.5, 1],
  backgroundColor: '#ffffff',
};

const NS1 = '/actor/alice/project/ns1/';
const NS2 = '/actor/alice/project/ns2/';

function proj(namespace: string, display_name: string): ProjectInfo {
  return { namespace, display_name };
}

/** Build a valid UI-side `MemoryRecord` with overrides on safe defaults. */
function mem(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    record_id: 'mr_01TEST000000000000000000',
    namespace: NS1,
    strategy: 'llm-summary',
    title: 'Test memory',
    summary: 'summary',
    facts: [],
    source_event_ids: ['01TEST000000000000000000'],
    created_at: '2024-01-01T00:00:00Z',
    concepts: [],
    files_touched: [],
    observation_type: 'discovery',
    ...overrides,
  };
}

function indexOf(data: CosmosGraphData, id: string): number {
  const idx = data.idToIndex.get(id);
  if (idx === undefined) throw new Error(`id not present in bi-map: ${id}`);
  return idx;
}

function linkTuples(data: CosmosGraphData): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < data.links.length; i += 2) {
    out.push([data.links[i]!, data.links[i + 1]!]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('transform() — empty inputs', () => {
  it('produces zero points and zero links with empty Float32Arrays', () => {
    const data = transform([], [], THEME);

    expect(data.positions.length).toBe(0);
    expect(data.colors.length).toBe(0);
    expect(data.sizes.length).toBe(0);
    expect(data.links.length).toBe(0);
    expect(data.linkColors.length).toBe(0);

    expect(data.indexToId).toEqual([]);
    expect(data.indexToKind).toEqual([]);
    expect(data.indexToLabel).toEqual([]);
    expect(data.idToIndex.size).toBe(0);
    expect(data.memoryIndexByRecordId.size).toBe(0);
  });
});

describe('transform() — single project + single memory (no concepts)', () => {
  const projects = [proj(NS1, 'Project One')];
  const memories = [mem({ record_id: 'rec1', namespace: NS1, title: 'Memory One' })];

  it('produces 2 points and 1 memory→project link', () => {
    const data = transform(memories, projects, THEME);

    expect(data.positions.length).toBe(2 * 2); // 2 points
    expect(data.links.length).toBe(2 * 1);     // 1 link
  });

  it('orders points as [memory, project] so projects paint on top', () => {
    const data = transform(memories, projects, THEME);

    expect(data.indexToId[0]).toBe('memory:rec1');
    expect(data.indexToId[1]).toBe(`project:${NS1}`);
    expect(data.indexToKind[0]).toBe('memory');
    expect(data.indexToKind[1]).toBe('project');
  });

  it('populates indexToLabel with project display_name and null for memory', () => {
    const data = transform(memories, projects, THEME);

    expect(data.indexToLabel[0]).toBeNull();
    expect(data.indexToLabel[1]).toBe('Project One');
  });

  it('populates memoryIndexByRecordId with the memory point index', () => {
    const data = transform(memories, projects, THEME);

    expect(data.memoryIndexByRecordId.get('rec1')).toBe(0);
  });

  it('emits a single memory→project link', () => {
    const data = transform(memories, projects, THEME);

    expect(linkTuples(data)).toEqual([[0, 1]]);
  });
});

describe('transform() — two projects with overlapping concept strings', () => {
  const projects = [proj(NS1, 'NS1'), proj(NS2, 'NS2')];
  const memories = [
    mem({ record_id: 'r1', namespace: NS1, concepts: ['shared'] }),
    mem({ record_id: 'r2', namespace: NS2, concepts: ['shared'] }),
  ];

  it('scopes concepts per namespace: 2 projects + 2 memories + 2 concepts', () => {
    const data = transform(memories, projects, THEME);

    expect(data.indexToId.length).toBe(6);
    expect(data.idToIndex.has(`concept:${NS1}:shared`)).toBe(true);
    expect(data.idToIndex.has(`concept:${NS2}:shared`)).toBe(true);
  });

  it('emits memory→project and memory→concept links, no project→concept', () => {
    const data = transform(memories, projects, THEME);

    const r1Idx = indexOf(data, 'memory:r1');
    const r2Idx = indexOf(data, 'memory:r2');
    const c1Idx = indexOf(data, `concept:${NS1}:shared`);
    const c2Idx = indexOf(data, `concept:${NS2}:shared`);
    const p1Idx = indexOf(data, `project:${NS1}`);
    const p2Idx = indexOf(data, `project:${NS2}`);

    const tuples = new Set(linkTuples(data).map(([a, b]) => `${a}-${b}`));
    expect(tuples.has(`${r1Idx}-${p1Idx}`)).toBe(true);
    expect(tuples.has(`${r2Idx}-${p2Idx}`)).toBe(true);
    expect(tuples.has(`${r1Idx}-${c1Idx}`)).toBe(true);
    expect(tuples.has(`${r2Idx}-${c2Idx}`)).toBe(true);
    // No project→concept edges: neither (p1,c1) nor (c1,p1), etc.
    expect(tuples.has(`${p1Idx}-${c1Idx}`)).toBe(false);
    expect(tuples.has(`${c1Idx}-${p1Idx}`)).toBe(false);
    expect(tuples.has(`${p2Idx}-${c2Idx}`)).toBe(false);
    expect(tuples.has(`${c2Idx}-${p2Idx}`)).toBe(false);
  });
});

describe('transform() — node ordering (concepts → memories → projects)', () => {
  it('places concepts first, memories in the middle, projects last', () => {
    const projects = [proj(NS1, 'P1'), proj(NS2, 'P2')];
    const memories = [
      mem({ record_id: 'r1', namespace: NS1, concepts: ['c1'] }),
    ];

    const data = transform(memories, projects, THEME);

    // Expected: [concept(ns1,c1), memory(r1), project(ns1), project(ns2)]
    expect(data.indexToKind).toEqual(['concept', 'memory', 'project', 'project']);
    expect(data.indexToId).toEqual([
      `concept:${NS1}:c1`,
      'memory:r1',
      `project:${NS1}`,
      `project:${NS2}`,
    ]);
  });
});

describe('transform() — per-kind point sizes', () => {
  it('assigns size 12 to projects (3× default) and size 4 to memories and concepts', () => {
    const projects = [proj(NS1, 'P1')];
    const memories = [
      mem({ record_id: 'r1', namespace: NS1, concepts: ['c1'] }),
    ];

    const data = transform(memories, projects, THEME);

    const c1Idx = indexOf(data, `concept:${NS1}:c1`);
    const m1Idx = indexOf(data, 'memory:r1');
    const p1Idx = indexOf(data, `project:${NS1}`);

    expect(data.sizes[c1Idx]).toBe(4);
    expect(data.sizes[m1Idx]).toBe(4);
    expect(data.sizes[p1Idx]).toBe(12);
  });
});

describe('transform() — buffer shape at a known size', () => {
  it('produces the expected buffer lengths for 1 project + 2 memories + 3 concepts', () => {
    const projects = [proj(NS1, 'P1')];
    const memories = [
      mem({ record_id: 'r1', namespace: NS1, title: 'A', concepts: ['c1', 'c2'] }),
      mem({ record_id: 'r2', namespace: NS1, title: 'B', concepts: ['c3'] }),
    ];

    const data = transform(memories, projects, THEME);

    // 3 concepts + 2 memories + 1 project = 6 points.
    expect(data.indexToId.length).toBe(6);
    expect(data.positions.length).toBe(12); // 2 * 6
    expect(data.colors.length).toBe(24);    // 4 * 6
    expect(data.sizes.length).toBe(6);

    // Project is the last index (emission order = concepts, memories, projects).
    const projIdx = indexOf(data, `project:${NS1}`);
    expect(projIdx).toBe(5);
    expect(data.sizes[projIdx]).toBe(12);
  });
});

describe('transform() — stable sort across polling refreshes', () => {
  it('reorders shuffled memory input by record_id so indices stay deterministic', () => {
    const projects = [proj(NS1, 'P1')];
    const memoriesInOrderA: MemoryRecord[] = [
      mem({ record_id: 'a', namespace: NS1 }),
      mem({ record_id: 'b', namespace: NS1 }),
      mem({ record_id: 'c', namespace: NS1 }),
    ];
    const memoriesInOrderB: MemoryRecord[] = [
      mem({ record_id: 'c', namespace: NS1 }),
      mem({ record_id: 'a', namespace: NS1 }),
      mem({ record_id: 'b', namespace: NS1 }),
    ];

    const dataA = transform(memoriesInOrderA, projects, THEME);
    const dataB = transform(memoriesInOrderB, projects, THEME);

    expect(dataA.indexToId).toEqual(dataB.indexToId);
  });
});

describe('transform() — duplicate concepts on the same memory', () => {
  it('emits exactly one memory→concept link per unique (memory, concept) pair', () => {
    // MemoryRecord.concepts is typed `string[]` with no uniqueness
    // guarantee. A memory that lists the same concept twice should not
    // produce two edges to the same concept point.
    const projects = [proj(NS1, 'P1')];
    const memories = [
      mem({
        record_id: 'r1',
        namespace: NS1,
        concepts: ['dup', 'dup', 'other', 'dup'],
      }),
    ];

    const data = transform(memories, projects, THEME);

    // Exactly one concept node for `dup` and one for `other` — the node
    // emission loop already deduplicates, so this is a sanity check.
    expect(data.idToIndex.has(`concept:${NS1}:dup`)).toBe(true);
    expect(data.idToIndex.has(`concept:${NS1}:other`)).toBe(true);
    expect(data.indexToKind.filter((k) => k === 'concept').length).toBe(2);

    // Link count: 1 memory→project + 1 memory→concept(dup) + 1 memory→concept(other).
    // Without the dedup fix in the link loop, we would get 3 dup edges
    // for a total link count of 5.
    const linkCount = data.links.length / 2;
    expect(linkCount).toBe(3);
  });
});
