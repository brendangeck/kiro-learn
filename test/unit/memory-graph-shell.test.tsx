// @vitest-environment jsdom
/**
 * Component test for `ui/src/components/MemoryGraph.tsx`.
 *
 * This is a boundary test between `MemoryGraph` (the orchestration shell)
 * and `CosmosGraph` (the engine wrapper). We mock `./CosmosGraph.js`
 * directly with a recorder component so we can inspect exactly what props
 * the shell passes down.
 *
 * We use `vi.doMock` + dynamic `await import` (same pattern as
 * `cosmos-graph.test.tsx`) because `vi.mock` hoists above
 * `@vitejs/plugin-react`'s auto-injected `react/jsx-runtime` import in
 * `.tsx` files and the factory ends up referencing that binding before
 * it is initialised.
 *
 * Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.7, 2.8, 2.9, 8.4, 17.3
 * @see .kiro/specs/cosmos-gl-graph/design.md § Interaction Model
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

// ---------------------------------------------------------------------------
// Mock: replace the real CosmosGraph with a recorder so we can observe the
// exact props MemoryGraph hands it across renders.
// ---------------------------------------------------------------------------

/** Shape of a recorded CosmosGraph render. Matches the simplified props. */
interface RecordedCall {
  data: unknown;
  backgroundColor: string;
  onPointClick: (id: string | null, kind: string | null) => void;
}

const cosmosGraphCalls: RecordedCall[] = [];

function installCosmosGraphMock(): void {
  vi.doMock('../../ui/src/components/CosmosGraph.js', () => ({
    CosmosGraph: (props: RecordedCall) => {
      cosmosGraphCalls.push(props);
      return React.createElement('div', { 'data-testid': 'mock-cosmos-graph' });
    },
  }));
}

installCosmosGraphMock();

// Static `import type` statements: stripped at compile time, so they don't
// conflict with `vi.doMock` hoisting. Runtime imports stay dynamic below.
import type { MemoryRecord } from '../../ui/src/types/api.js';
import type { ProjectInfo } from '../../ui/src/graph/transform.js';

const { render, screen, act, cleanup } = await import('@testing-library/react');
const { MemoryGraph } = await import('../../ui/src/components/MemoryGraph.js');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const NS = '/actor/alice/project/ns1/';

function mem(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    record_id: 'rec1',
    namespace: NS,
    strategy: 'llm-summary',
    title: 'Hello memory',
    summary: 'summary',
    facts: [],
    source_event_ids: ['01TEST000000000000000000'],
    created_at: '2024-01-01T00:00:00Z',
    concepts: ['typescript'],
    files_touched: [],
    observation_type: 'discovery',
    ...overrides,
  };
}

const DEFAULT_PROJECTS: ProjectInfo[] = [
  { namespace: NS, display_name: 'Project One' },
];

/** Resets between tests so each describe/it starts with a clean recorder. */
function resetRecorder(): void {
  cosmosGraphCalls.length = 0;
}

// Vitest is not configured with `globals: true`, so `@testing-library/react`'s
// auto-cleanup-on-afterEach hook does not fire. Without explicit cleanup the
// previous test's DOM leaks into `screen.queryByTestId` in the next test.
afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryGraph — default render', () => {
  beforeEach(() => {
    resetRecorder();
  });

  it('renders the canvas and a legend above it, with no filter checkboxes', () => {
    render(
      <MemoryGraph
        memories={[mem()]}
        projects={DEFAULT_PROJECTS}
        loading={false}
        error={null}
        darkMode={false}
        onNodeClick={() => {}}
      />,
    );

    // Canvas (mocked) renders.
    expect(screen.getByTestId('mock-cosmos-graph')).toBeTruthy();
    expect(cosmosGraphCalls.length).toBeGreaterThanOrEqual(1);

    // No filter checkboxes — the simplified shell doesn't render them.
    expect(screen.queryByRole('checkbox', { name: 'Projects' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Memories' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Concepts' })).toBeNull();

    // Legend is present — look for its kind labels as a tolerable proxy.
    // After the palette port, memory and concept share a color and the
    // legend collapses to two items: "Project" and "Memory / Concept".
    expect(screen.getByText('Project')).toBeTruthy();
    expect(screen.getByText('Memory / Concept')).toBeTruthy();
  });

  it('forwards the recorded props shape: data, backgroundColor, onPointClick only', () => {
    render(
      <MemoryGraph
        memories={[mem()]}
        projects={DEFAULT_PROJECTS}
        loading={false}
        error={null}
        darkMode={false}
        onNodeClick={() => {}}
      />,
    );

    const call = cosmosGraphCalls[0]!;
    expect(call.data).toBeDefined();
    expect(typeof call.backgroundColor).toBe('string');
    expect(typeof call.onPointClick).toBe('function');
  });
});

describe('MemoryGraph — state replacements for the canvas', () => {
  beforeEach(() => {
    resetRecorder();
  });

  it('renders a loading indicator (no canvas) when loading=true', () => {
    render(
      <MemoryGraph
        memories={[]}
        projects={[]}
        loading={true}
        error={null}
        darkMode={false}
        onNodeClick={() => {}}
      />,
    );

    expect(screen.queryByTestId('mock-cosmos-graph')).toBeNull();
    expect(screen.getByText(/Loading graph/i)).toBeTruthy();
    expect(cosmosGraphCalls.length).toBe(0);
  });

  it('renders an error indicator (no canvas) when error is set', () => {
    render(
      <MemoryGraph
        memories={[]}
        projects={[]}
        loading={false}
        error="boom"
        darkMode={false}
        onNodeClick={() => {}}
      />,
    );

    expect(screen.queryByTestId('mock-cosmos-graph')).toBeNull();
    expect(screen.getByText(/Failed to load memories/i)).toBeTruthy();
    expect(cosmosGraphCalls.length).toBe(0);
  });

  it('renders an empty-state message (no canvas) when memories is empty', () => {
    render(
      <MemoryGraph
        memories={[]}
        projects={DEFAULT_PROJECTS}
        loading={false}
        error={null}
        darkMode={false}
        onNodeClick={() => {}}
      />,
    );

    expect(screen.queryByTestId('mock-cosmos-graph')).toBeNull();
    expect(screen.getByText(/No memories yet/i)).toBeTruthy();
    expect(cosmosGraphCalls.length).toBe(0);
  });
});

describe('MemoryGraph — refresh button', () => {
  beforeEach(() => {
    resetRecorder();
  });

  it('renders a refresh button next to the canvas', () => {
    render(
      <MemoryGraph
        memories={[mem()]}
        projects={DEFAULT_PROJECTS}
        loading={false}
        error={null}
        darkMode={false}
        onNodeClick={() => {}}
      />,
    );

    expect(screen.getByTestId('cosmos-refresh')).toBeTruthy();
    // Cloudscape renders the icon button with its ariaLabel as the
    // accessible name.
    expect(screen.getByRole('button', { name: 'Refresh graph' })).toBeTruthy();
  });

  it('remounts CosmosGraph when the refresh button is clicked', () => {
    render(
      <MemoryGraph
        memories={[mem()]}
        projects={DEFAULT_PROJECTS}
        loading={false}
        error={null}
        darkMode={false}
        onNodeClick={() => {}}
      />,
    );

    // Initial mount produces exactly one recorded render.
    const mountCallCount = cosmosGraphCalls.length;
    expect(mountCallCount).toBeGreaterThanOrEqual(1);

    // Click the refresh button. The shell bumps its `refreshKey` state,
    // which is passed to `<CosmosGraph key={refreshKey} />`, forcing
    // React to unmount the old tree and mount a fresh one.
    const button = screen.getByRole('button', { name: 'Refresh graph' });
    act(() => {
      button.click();
    });

    // A new render pass produces at least one additional recorded call
    // (the old instance is unmounted and a new one is mounted).
    expect(cosmosGraphCalls.length).toBeGreaterThan(mountCallCount);
  });
});

describe('MemoryGraph — click routing to onNodeClick', () => {
  beforeEach(() => {
    resetRecorder();
  });

  it('invokes onNodeClick(memory, null) when a memory point is clicked', () => {
    const memory = mem({ record_id: 'recA', title: 'A-title', concepts: ['typescript'] });
    const onNodeClick = vi.fn();

    render(
      <MemoryGraph
        memories={[memory]}
        projects={DEFAULT_PROJECTS}
        loading={false}
        error={null}
        darkMode={false}
        onNodeClick={onNodeClick}
      />,
    );

    const call = cosmosGraphCalls[0]!;
    const data = call.data as {
      indexToKind: readonly string[];
      indexToId: readonly string[];
    };
    const memIdx = data.indexToKind.findIndex((k) => k === 'memory');
    expect(memIdx).toBeGreaterThanOrEqual(0);

    act(() => {
      call.onPointClick(data.indexToId[memIdx]!, 'memory');
    });

    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onNodeClick).toHaveBeenCalledWith(memory, null);
  });

  it('invokes onNodeClick(null, conceptString) when a concept point is clicked', () => {
    const memory = mem({ record_id: 'recA', concepts: ['typescript'] });
    const onNodeClick = vi.fn();

    render(
      <MemoryGraph
        memories={[memory]}
        projects={DEFAULT_PROJECTS}
        loading={false}
        error={null}
        darkMode={false}
        onNodeClick={onNodeClick}
      />,
    );

    const call = cosmosGraphCalls[0]!;
    const data = call.data as {
      indexToKind: readonly string[];
      indexToId: readonly string[];
    };
    const conceptIdx = data.indexToKind.findIndex((k) => k === 'concept');
    expect(conceptIdx).toBeGreaterThanOrEqual(0);

    act(() => {
      call.onPointClick(data.indexToId[conceptIdx]!, 'concept');
    });

    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onNodeClick).toHaveBeenCalledWith(null, 'typescript');
  });

  it('does not invoke onNodeClick (with any payload) when a project point is clicked', () => {
    const memory = mem();
    const onNodeClick = vi.fn();

    render(
      <MemoryGraph
        memories={[memory]}
        projects={DEFAULT_PROJECTS}
        loading={false}
        error={null}
        darkMode={false}
        onNodeClick={onNodeClick}
      />,
    );

    const call = cosmosGraphCalls[0]!;
    const data = call.data as {
      indexToKind: readonly string[];
      indexToId: readonly string[];
    };
    const projIdx = data.indexToKind.findIndex((k) => k === 'project');
    expect(projIdx).toBeGreaterThanOrEqual(0);

    act(() => {
      call.onPointClick(data.indexToId[projIdx]!, 'project');
    });

    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it('invokes onNodeClick(null, null) when the background is clicked', () => {
    const onNodeClick = vi.fn();
    render(
      <MemoryGraph
        memories={[mem()]}
        projects={DEFAULT_PROJECTS}
        loading={false}
        error={null}
        darkMode={false}
        onNodeClick={onNodeClick}
      />,
    );

    const call = cosmosGraphCalls[0]!;
    act(() => {
      call.onPointClick(null, null);
    });

    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onNodeClick).toHaveBeenCalledWith(null, null);
  });
});
