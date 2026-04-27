import { describe, it, expect } from 'vitest';
import { transformToGraph } from '../../ui/src/graph/transform.js';
import type { ProjectInfo } from '../../ui/src/graph/transform.js';
import type { MemoryRecord } from '../../ui/src/types/api.js';

/** Helper to build a minimal valid MemoryRecord for testing. */
function mem(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, 'record_id' | 'namespace' | 'title' | 'concepts'>): MemoryRecord {
  return {
    strategy: 'llm-summary',
    summary: 'test summary',
    facts: [],
    source_event_ids: ['01JF8ZS4Y00000000000000000'],
    created_at: '2026-04-23T20:00:00Z',
    files_touched: [],
    observation_type: 'tool_use',
    ...overrides,
  };
}

describe('transformToGraph', () => {
  it('returns empty nodes and edges for empty memories', () => {
    const result = transformToGraph([], []);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('creates project, concept, and memory nodes with correct edges', () => {
    const ns = '/actor/alice/project/abc/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'Test memory', concepts: ['typescript', 'testing'] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'My Project' }];

    const { nodes, edges } = transformToGraph(memories, projects);

    // 1 project + 2 concepts + 1 memory = 4 nodes
    expect(nodes).toHaveLength(4);
    expect(nodes.filter((n) => n.type === 'projectNode')).toHaveLength(1);
    expect(nodes.filter((n) => n.type === 'conceptNode')).toHaveLength(2);
    expect(nodes.filter((n) => n.type === 'memoryNode')).toHaveLength(1);

    // 1 memory→project + 2 memory→concept + 2 project→concept = 5 edges
    expect(edges).toHaveLength(5);
  });

  it('counts shared concept degree correctly', () => {
    const ns = '/actor/alice/project/abc/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'A', concepts: ['shared', 'unique-a'] }),
      mem({ record_id: 'mr_02', namespace: ns, title: 'B', concepts: ['shared'] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'Proj' }];

    const { nodes } = transformToGraph(memories, projects);

    const sharedConcept = nodes.find((n) => n.data.label === 'shared');
    expect(sharedConcept).toBeDefined();
    expect(sharedConcept!.data.count).toBe(2);
  });

  it('creates separate project hub nodes for different namespaces', () => {
    const ns1 = '/actor/alice/project/aaa/';
    const ns2 = '/actor/alice/project/bbb/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns1, title: 'A', concepts: ['c1'] }),
      mem({ record_id: 'mr_02', namespace: ns2, title: 'B', concepts: ['c1'] }),
    ];
    const projects: ProjectInfo[] = [
      { namespace: ns1, display_name: 'Project A' },
      { namespace: ns2, display_name: 'Project B' },
    ];

    const { nodes } = transformToGraph(memories, projects);

    const projectNodes = nodes.filter((n) => n.type === 'projectNode');
    expect(projectNodes).toHaveLength(2);

    // Same concept string in different projects = separate concept nodes
    const conceptNodes = nodes.filter((n) => n.type === 'conceptNode');
    expect(conceptNodes).toHaveLength(2);
  });

  it('connects memory directly to project when concepts array is empty', () => {
    const ns = '/actor/alice/project/abc/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'No concepts', concepts: [] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'Proj' }];

    const { nodes, edges } = transformToGraph(memories, projects);

    // 1 project + 0 concepts + 1 memory = 2 nodes
    expect(nodes).toHaveLength(2);
    expect(nodes.filter((n) => n.type === 'conceptNode')).toHaveLength(0);
    // 1 edge: memory → project
    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe('mem-mr_01');
    expect(edges[0]!.target).toBe(`project-${ns}`);
  });

  it('uses fallback label when no project display_name matches', () => {
    const ns = '/actor/alice/project/abcdef123456789/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'Orphan', concepts: [] }),
    ];

    const { nodes } = transformToGraph(memories, []);

    const projectNode = nodes.find((n) => n.type === 'projectNode');
    expect(projectNode!.data.label).toBe('abcdef123456');
  });

  it('truncates memory title to 40 characters with ellipsis', () => {
    const ns = '/actor/alice/project/abc/';
    const longTitle = 'A'.repeat(60);
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: longTitle, concepts: [] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'Proj' }];

    const { nodes } = transformToGraph(memories, projects);

    const memNode = nodes.find((n) => n.type === 'memoryNode');
    expect(memNode!.data.label).toBe('A'.repeat(40) + '…');
  });

  it('produces flat nodes without parentId or extent', () => {
    const ns = '/actor/alice/project/abc/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'Test', concepts: ['c1'] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'Proj' }];

    const { nodes } = transformToGraph(memories, projects);

    for (const node of nodes) {
      expect(node.parentId).toBeUndefined();
      expect(node.extent).toBeUndefined();
    }
  });

  it('uses stable IDs derived from namespace and record_id', () => {
    const ns = '/actor/alice/project/abc/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_STABLE_01', namespace: ns, title: 'M1', concepts: ['c1'] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'A' }];

    const { nodes } = transformToGraph(memories, projects);

    expect(nodes.find((n) => n.type === 'projectNode')!.id).toBe(`project-${ns}`);
    expect(nodes.find((n) => n.type === 'conceptNode')!.id).toBe(`concept-${ns}-c1`);
    expect(nodes.find((n) => n.type === 'memoryNode')!.id).toBe('mem-mr_STABLE_01');
  });
});
