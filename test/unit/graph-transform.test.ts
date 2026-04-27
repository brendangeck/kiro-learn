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

  it('creates correct structure for a single memory with 2 concepts', () => {
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

    // 1 project supernode + 2 concept nodes + 1 memory node = 4 nodes
    expect(nodes).toHaveLength(4);

    // Project supernode
    const projectNode = nodes.find((n) => n.id === 'project-0');
    expect(projectNode).toBeDefined();
    expect(projectNode!.type).toBe('projectSupernode');
    expect(projectNode!.data).toEqual({
      label: 'My Project',
      namespace: '/actor/alice/project/abc123def456/',
    });

    // Concept nodes
    const conceptNodes = nodes.filter((n) => n.type === 'conceptNode');
    expect(conceptNodes).toHaveLength(2);
    expect(conceptNodes[0]!.id).toBe('project-0-concept-0');
    expect(conceptNodes[0]!.data).toEqual({ label: 'typescript', count: 1 });
    expect(conceptNodes[0]!.parentId).toBe('project-0');
    expect(conceptNodes[1]!.id).toBe('project-0-concept-1');
    expect(conceptNodes[1]!.data).toEqual({ label: 'testing', count: 1 });
    expect(conceptNodes[1]!.parentId).toBe('project-0');

    // Memory node
    const memNode = nodes.find((n) => n.type === 'memoryNode');
    expect(memNode).toBeDefined();
    expect(memNode!.id).toBe('project-0-mem-0');
    expect(memNode!.data.label).toBe('Test memory');
    expect(memNode!.data.memory).toEqual(memories[0]);
    expect(memNode!.parentId).toBe('project-0');

    // 2 edges: memory → typescript, memory → testing
    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual({
      id: 'project-0-mem-0-project-0-concept-0',
      source: 'project-0-mem-0',
      target: 'project-0-concept-0',
    });
    expect(edges[1]).toEqual({
      id: 'project-0-mem-0-project-0-concept-1',
      source: 'project-0-mem-0',
      target: 'project-0-concept-1',
    });
  });

  it('counts shared concept degree correctly', () => {
    const ns = '/actor/alice/project/abc/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'Memory A', concepts: ['shared-concept', 'unique-a'] }),
      mem({ record_id: 'mr_02', namespace: ns, title: 'Memory B', concepts: ['shared-concept'] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'Proj' }];

    const { nodes, edges } = transformToGraph(memories, projects);

    // shared-concept should have count 2
    const sharedConcept = nodes.find((n) => n.data.label === 'shared-concept');
    expect(sharedConcept).toBeDefined();
    expect(sharedConcept!.data.count).toBe(2);

    // unique-a should have count 1
    const uniqueConcept = nodes.find((n) => n.data.label === 'unique-a');
    expect(uniqueConcept).toBeDefined();
    expect(uniqueConcept!.data.count).toBe(1);

    // 3 edges total: mem_01→shared, mem_01→unique-a, mem_02→shared
    expect(edges).toHaveLength(3);
  });

  it('creates separate project supernodes for different namespaces', () => {
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

    const { nodes } = transformToGraph(memories, projects);

    const projectNodes = nodes.filter((n) => n.type === 'projectSupernode');
    expect(projectNodes).toHaveLength(2);
    expect(projectNodes[0]!.data.label).toBe('Project A');
    expect(projectNodes[1]!.data.label).toBe('Project B');

    // Same concept string in different projects = separate concept nodes
    const conceptNodes = nodes.filter((n) => n.type === 'conceptNode');
    expect(conceptNodes).toHaveLength(2);
    expect(conceptNodes[0]!.parentId).toBe('project-0');
    expect(conceptNodes[1]!.parentId).toBe('project-1');
  });

  it('handles memory with empty concepts array — no edges', () => {
    const ns = '/actor/alice/project/abc/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'No concepts', concepts: [] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'Proj' }];

    const { nodes, edges } = transformToGraph(memories, projects);

    // 1 project + 0 concepts + 1 memory = 2 nodes
    expect(nodes).toHaveLength(2);
    expect(nodes.filter((n) => n.type === 'conceptNode')).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('uses fallback label when no project display_name matches', () => {
    const ns = '/actor/alice/project/abcdef123456789/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'Orphan', concepts: [] }),
    ];

    const { nodes } = transformToGraph(memories, []);

    const projectNode = nodes.find((n) => n.type === 'projectSupernode');
    expect(projectNode).toBeDefined();
    // First 12 hex chars of the project_id segment
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
    expect(memNode!.data.label).toBe('A'.repeat(40));
    // Full memory is still in data.memory
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

  it('uses extent "parent" for concept and memory nodes', () => {
    const ns = '/actor/alice/project/abc/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns, title: 'Test', concepts: ['c1'] }),
    ];
    const projects: ProjectInfo[] = [{ namespace: ns, display_name: 'Proj' }];

    const { nodes } = transformToGraph(memories, projects);

    const conceptNode = nodes.find((n) => n.type === 'conceptNode');
    const memNode = nodes.find((n) => n.type === 'memoryNode');
    expect(conceptNode!.extent).toBe('parent');
    expect(memNode!.extent).toBe('parent');
  });

  it('assigns placeholder positions for layout', () => {
    const ns1 = '/actor/alice/project/aaa/';
    const ns2 = '/actor/alice/project/bbb/';
    const memories: MemoryRecord[] = [
      mem({ record_id: 'mr_01', namespace: ns1, title: 'M1', concepts: ['c1', 'c2'] }),
      mem({ record_id: 'mr_02', namespace: ns2, title: 'M2', concepts: ['c3'] }),
    ];
    const projects: ProjectInfo[] = [
      { namespace: ns1, display_name: 'A' },
      { namespace: ns2, display_name: 'B' },
    ];

    const { nodes } = transformToGraph(memories, projects);

    // Project supernodes spaced at 600px intervals
    const p0 = nodes.find((n) => n.id === 'project-0');
    const p1 = nodes.find((n) => n.id === 'project-1');
    expect(p0!.position).toEqual({ x: 0, y: 0 });
    expect(p1!.position).toEqual({ x: 600, y: 0 });

    // Concept nodes at y=100, spaced at 150px
    const c0 = nodes.find((n) => n.id === 'project-0-concept-0');
    const c1 = nodes.find((n) => n.id === 'project-0-concept-1');
    expect(c0!.position).toEqual({ x: 0, y: 100 });
    expect(c1!.position).toEqual({ x: 150, y: 100 });

    // Memory nodes at y=300, spaced at 120px
    const m0 = nodes.find((n) => n.id === 'project-0-mem-0');
    expect(m0!.position).toEqual({ x: 0, y: 300 });
  });
});
