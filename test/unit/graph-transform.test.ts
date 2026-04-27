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

  it('creates correct structure for a single memory with concepts', () => {
    const memories: MemoryRecord[] = [
      mem({
        record_id: 'mr_01',
        namespace: '/actor/alice/project/abc123def456/',
        title: 'Test memory',
        concepts: ['typescript', 'testing'],
      }),
    ];
    const projects: ProjectInfo[] = [
      { namespace: '/actor/alice/project/abc123def456/', display_name: 'My Project' },
    ];

    const { nodes, edges } = transformToGraph(memories, projects);

    // 1 project hub + 1 memory node = 2 nodes (no concept nodes)
    expect(nodes).toHaveLength(2);

    // Project hub node
    const projectNode = nodes.find((n) => n.id === 'project-0');
    expect(projectNode).toBeDefined();
    expect(projectNode!.type).toBe('projectSupernode');
    expect(projectNode!.data).toEqual({
      label: 'My Project',
      namespace: '/actor/alice/project/abc123def456/',
    });

    // Memory node — concepts stored in data.memory, not as separate nodes
    const memNode = nodes.find((n) => n.type === 'memoryNode');
    expect(memNode).toBeDefined();
    expect(memNode!.id).toBe('project-0-mem-0');
    expect(memNode!.data.label).toBe('Test memory');
    expect(memNode!.data.memory).toEqual(memories[0]);
    expect(memNode!.data.memory.concepts).toEqual(['typescript', 'testing']);

    // 1 edge: project → memory
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({
      id: 'project-0-to-project-0-mem-0',
      source: 'project-0',
      target: 'project-0-mem-0',
    });
  });

  it('creates edges from project to each memory', () => {
    const ns = '/actor/alice/project/abc/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'Memory A', concepts: ['shared-concept', 'unique-a'] }),
      mem({ record_id: 'mr_02', namespace: ns, title: 'Memory B', concepts: ['shared-concept'] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'Proj' }];

    const { nodes, edges } = transformToGraph(memories, projects);

    // 1 project + 2 memories = 3 nodes
    expect(nodes).toHaveLength(3);
    expect(nodes.filter((n) => n.type === 'memoryNode')).toHaveLength(2);

    // 2 edges: project → mem_01, project → mem_02
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.source === 'project-0')).toBe(true);
  });

  it('creates separate project hub nodes for different namespaces', () => {
    const ns1 = '/actor/alice/project/aaa/';
    const ns2 = '/actor/alice/project/bbb/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns1, title: 'Mem in A', concepts: ['c1'] }),
      mem({ record_id: 'mr_02', namespace: ns2, title: 'Mem in B', concepts: ['c1'] }),
    ];
    const projects: ProjectInfo[] = [
      { namespace: ns1, display_name: 'Project A' },
      { namespace: ns2, display_name: 'Project B' },
    ];

    const { nodes, edges } = transformToGraph(memories, projects);

    const projectNodes = nodes.filter((n) => n.type === 'projectSupernode');
    expect(projectNodes).toHaveLength(2);
    expect(projectNodes[0]!.data.label).toBe('Project A');
    expect(projectNodes[1]!.data.label).toBe('Project B');

    // 2 edges: each project → its memory
    expect(edges).toHaveLength(2);
  });

  it('handles memory with empty concepts array', () => {
    const ns = '/actor/alice/project/abc/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'No concepts', concepts: [] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'Proj' }];

    const { nodes, edges } = transformToGraph(memories, projects);

    // 1 project + 1 memory = 2 nodes
    expect(nodes).toHaveLength(2);
    // Still has project → memory edge
    expect(edges).toHaveLength(1);
  });

  it('uses fallback label when no project display_name matches', () => {
    const ns = '/actor/alice/project/abcdef123456789/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'Orphan', concepts: [] }),
    ];

    const { nodes } = transformToGraph(memories, []);

    const projectNode = nodes.find((n) => n.type === 'projectSupernode');
    expect(projectNode).toBeDefined();
    expect(projectNode!.data.label).toBe('abcdef123456');
  });

  it('truncates memory title to 40 characters', () => {
    const ns = '/actor/alice/project/abc/';
    const longTitle = 'A'.repeat(60);
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: longTitle, concepts: [] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'Proj' }];

    const { nodes } = transformToGraph(memories, projects);

    const memNode = nodes.find((n) => n.type === 'memoryNode');
    expect(memNode!.data.label).toBe('A'.repeat(40) + '…');
    expect(memNode!.data.memory.title).toBe(longTitle);
  });

  it('stores observation_type in memory node data', () => {
    const ns = '/actor/alice/project/abc/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'Error mem', concepts: [], observation_type: 'error' }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'Proj' }];

    const { nodes } = transformToGraph(memories, projects);

    const memNode = nodes.find((n) => n.type === 'memoryNode');
    expect(memNode!.data.memory.observation_type).toBe('error');
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

  it('does not create concept nodes', () => {
    const ns = '/actor/alice/project/abc/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'M1', concepts: ['c1', 'c2', 'c3'] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'A' }];

    const { nodes } = transformToGraph(memories, projects);

    const conceptNodes = nodes.filter((n) => n.type === 'conceptNode');
    expect(conceptNodes).toHaveLength(0);

    // Concepts are in the memory node data instead
    const memNode = nodes.find((n) => n.type === 'memoryNode');
    expect(memNode!.data.memory.concepts).toEqual(['c1', 'c2', 'c3']);
  });
});
