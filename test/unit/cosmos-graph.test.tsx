// @vitest-environment jsdom
/**
 * Component test for `ui/src/components/CosmosGraph.tsx`.
 *
 * Mocks `@cosmos.gl/graph` and `@interacta/css-labels` so we can assert the
 * component's imperative contract with both without touching WebGL or real
 * DOM measurement.
 *
 * We use `vi.doMock` + dynamic `await import` because a statically-hoisted
 * `vi.mock` interacts poorly with `@vitejs/plugin-react`'s auto-injected
 * `react/jsx-runtime` import in a `.tsx` file.
 *
 * @see .kiro/specs/cosmos-gl-graph/design.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE any dynamic import of the component.
// ---------------------------------------------------------------------------

interface MockGraphInstance {
  container: HTMLDivElement;
  config: Record<string, unknown>;
  calls: Array<{ method: string; args: unknown[] }>;
  destroyed: boolean;
  triggerClick(pointIndex: number | undefined): void;
  triggerPointMouseOver(pointIndex: number): void;
  triggerPointMouseOut(): void;
}
interface MockGraphCtor {
  new (container: HTMLDivElement, config: Record<string, unknown>): MockGraphInstance;
  instances: MockGraphInstance[];
  last(): MockGraphInstance;
  reset(): void;
}

interface MockLabelRendererInstance {
  container: HTMLDivElement;
  setLabelsCalls: Array<unknown[]>;
  drawCalls: number;
  destroyed: boolean;
}
interface MockLabelRendererCtor {
  new (container: HTMLDivElement, options?: unknown): MockLabelRendererInstance;
  instances: MockLabelRendererInstance[];
  last(): MockLabelRendererInstance;
  reset(): void;
}

function installCosmosMock(): void {
  vi.doMock('@cosmos.gl/graph', () => {
    class MockGraph {
      static instances: MockGraph[] = [];
      static last(): MockGraph {
        const inst = MockGraph.instances[MockGraph.instances.length - 1];
        if (!inst) throw new Error('MockGraph: no instance has been constructed');
        return inst;
      }
      static reset(): void {
        MockGraph.instances = [];
      }

      container: HTMLDivElement;
      config: Record<string, unknown>;
      calls: Array<{ method: string; args: unknown[] }> = [];
      destroyed = false;

      constructor(container: HTMLDivElement, config: Record<string, unknown>) {
        this.container = container;
        this.config = config;
        MockGraph.instances.push(this);
      }

      setPointPositions = (...a: unknown[]): void => { this.calls.push({ method: 'setPointPositions', args: a }); };
      setPointColors    = (...a: unknown[]): void => { this.calls.push({ method: 'setPointColors',    args: a }); };
      setPointSizes     = (...a: unknown[]): void => { this.calls.push({ method: 'setPointSizes',     args: a }); };
      setLinks          = (...a: unknown[]): void => { this.calls.push({ method: 'setLinks',          args: a }); };
      setLinkColors     = (...a: unknown[]): void => { this.calls.push({ method: 'setLinkColors',     args: a }); };
      render            = (...a: unknown[]): void => { this.calls.push({ method: 'render',            args: a }); };
      setConfigPartial  = (...a: unknown[]): void => { this.calls.push({ method: 'setConfigPartial',  args: a }); };
      trackPointPositionsByIndices = (...a: unknown[]): void => {
        this.calls.push({ method: 'trackPointPositionsByIndices', args: a });
      };
      getPointPositions = (): number[] => [];
      getNeighboringPointIndices = (_i: number): number[] => [];
      getConnectedLinkIndices = (_indices: number[]): number[] => [];
      destroy = (): void => {
        this.destroyed = true;
        this.calls.push({ method: 'destroy', args: [] });
      };

      triggerClick(pointIndex: number | undefined): void {
        (this.config['onClick'] as (i: number | undefined) => void)(pointIndex);
      }
      triggerPointMouseOver(pointIndex: number): void {
        (this.config['onPointMouseOver'] as (i: number) => void)(pointIndex);
      }
      triggerPointMouseOut(): void {
        (this.config['onPointMouseOut'] as () => void)();
      }
    }

    (globalThis as unknown as { __MockGraph__: MockGraphCtor }).__MockGraph__ =
      MockGraph as unknown as MockGraphCtor;

    return { Graph: MockGraph };
  });

  vi.doMock('@interacta/css-labels', () => {
    class MockLabelRenderer {
      static instances: MockLabelRenderer[] = [];
      static last(): MockLabelRenderer {
        const inst = MockLabelRenderer.instances[MockLabelRenderer.instances.length - 1];
        if (!inst) throw new Error('MockLabelRenderer: no instance has been constructed');
        return inst;
      }
      static reset(): void {
        MockLabelRenderer.instances = [];
      }

      container: HTMLDivElement;
      setLabelsCalls: Array<unknown[]> = [];
      drawCalls = 0;
      destroyed = false;

      constructor(container: HTMLDivElement, _options?: unknown) {
        this.container = container;
        MockLabelRenderer.instances.push(this);
      }

      setLabels = (labels: unknown[]): void => {
        // Snapshot at push time — CosmosLabels.update reuses its internal
        // array in place between calls.
        this.setLabelsCalls.push(
          (labels as Array<Record<string, unknown>>).map((l) => ({ ...l })),
        );
      };
      draw = (_withIntersection?: boolean): void => { this.drawCalls += 1; };
      show = (): void => {};
      hide = (): void => {};
      destroy = (): void => { this.destroyed = true; };
    }

    (globalThis as unknown as { __MockLabelRenderer__: MockLabelRendererCtor }).__MockLabelRenderer__ =
      MockLabelRenderer as unknown as MockLabelRendererCtor;

    return { LabelRenderer: MockLabelRenderer };
  });
}

function getMockGraph(): MockGraphCtor {
  const g = (globalThis as unknown as { __MockGraph__?: MockGraphCtor }).__MockGraph__;
  if (!g) throw new Error('MockGraph not installed');
  return g;
}

function getMockLabelRenderer(): MockLabelRendererCtor {
  const r = (globalThis as unknown as { __MockLabelRenderer__?: MockLabelRendererCtor }).__MockLabelRenderer__;
  if (!r) throw new Error('MockLabelRenderer not installed');
  return r;
}

installCosmosMock();

// Static `import type` statements: these are stripped at compile time, so
// they don't conflict with `vi.doMock` hoisting. Runtime imports still go
// through the dynamic `await import` below.
import type { CosmosGraphData, PackedTheme, ProjectInfo } from '../../ui/src/graph/transform.js';
import type { MemoryRecord } from '../../ui/src/types/api.js';

const { render } = await import('@testing-library/react');
const { CosmosGraph } = await import('../../ui/src/components/CosmosGraph.js');
const { transform } = await import('../../ui/src/graph/transform.js');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const THEME: PackedTheme = {
  darkMode: false,
  projectFill: [1, 0, 0, 1],
  memoryFill:  [0, 1, 0, 1],
  conceptFill: [0, 0, 1, 1],
  edgeColor:   [0.5, 0.5, 0.5, 1],
  backgroundColor: '#ffffff',
};

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

function buildData(): CosmosGraphData {
  const projects: ProjectInfo[] = [{ namespace: NS, display_name: 'Project One' }];
  const memories: MemoryRecord[] = [mem()];
  return transform(memories, projects, THEME);
}

/** The exact ordered sequence of engine calls the data effect produces on a full-reset upload. */
const DATA_EFFECT_CALL_ORDER = [
  'setPointPositions',
  'setPointColors',
  'setPointSizes',
  'setLinks',
  'setLinkColors',
  'render',
  'trackPointPositionsByIndices',
] as const;

function installResizeObserverStub(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CosmosGraph — mount', () => {
  beforeEach(() => {
    getMockGraph().reset();
    getMockLabelRenderer().reset();
    installResizeObserverStub();
  });

  it('constructs the Graph engine exactly once', () => {
    const data = buildData();
    render(<CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={() => {}} />);
    expect(getMockGraph().instances.length).toBe(1);
  });

  it('constructs a LabelRenderer exactly once', () => {
    const data = buildData();
    render(<CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={() => {}} />);
    expect(getMockLabelRenderer().instances.length).toBe(1);
  });

  it('passes the container element and a config object to the Graph constructor', () => {
    const data = buildData();
    render(<CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={() => {}} />);

    const inst = getMockGraph().last();
    expect(inst.container).toBeInstanceOf(HTMLDivElement);
    expect(inst.config['backgroundColor']).toBe('#ffffff');
    expect(inst.config['linkDefaultWidth']).toBe(0.6);
    expect(inst.config['enableDrag']).toBe(true);
    expect(typeof inst.config['onClick']).toBe('function');
    expect(typeof inst.config['onPointMouseOver']).toBe('function');
    expect(typeof inst.config['onPointMouseOut']).toBe('function');
    expect(typeof inst.config['onSimulationTick']).toBe('function');
    expect(typeof inst.config['onZoom']).toBe('function');
  });

  it('invokes engine methods in the exact order the data effect specifies', () => {
    const data = buildData();
    render(<CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={() => {}} />);

    const methods = getMockGraph()
      .last()
      .calls.map((c) => c.method)
      .filter((m) => (DATA_EFFECT_CALL_ORDER as readonly string[]).includes(m));

    expect(methods).toEqual([...DATA_EFFECT_CALL_ORDER]);
  });

  it('tracks project indices (and only project indices) for label positioning', () => {
    const data = buildData();
    render(<CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={() => {}} />);

    const trackCall = getMockGraph()
      .last()
      .calls.find((c) => c.method === 'trackPointPositionsByIndices');
    expect(trackCall).toBeDefined();
    const tracked = trackCall?.args[0] as number[];
    // Every tracked index must be a project.
    for (const idx of tracked) {
      expect(data.indexToKind[idx]).toBe('project');
    }
    // Every project index must be tracked.
    for (let i = 0; i < data.indexToKind.length; i++) {
      if (data.indexToKind[i] === 'project') expect(tracked).toContain(i);
    }
  });
});

describe('CosmosGraph — visual-only prop change (backgroundColor)', () => {
  beforeEach(() => {
    getMockGraph().reset();
    getMockLabelRenderer().reset();
    installResizeObserverStub();
  });

  it('triggers setConfigPartial but does not re-invoke any data setter', () => {
    const data = buildData();
    const { rerender } = render(
      <CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={() => {}} />,
    );

    const inst = getMockGraph().last();
    inst.calls = [];

    rerender(
      <CosmosGraph data={data} backgroundColor="#000000" onPointClick={() => {}} />,
    );

    const setConfigPartialCalls = inst.calls.filter((c) => c.method === 'setConfigPartial');
    expect(setConfigPartialCalls.length).toBeGreaterThanOrEqual(1);
    expect(setConfigPartialCalls[0]?.args[0]).toEqual({ backgroundColor: '#000000' });

    const dataSetterCalls = inst.calls.filter((c) =>
      (DATA_EFFECT_CALL_ORDER as readonly string[]).includes(c.method),
    );
    expect(dataSetterCalls).toEqual([]);
    expect(getMockGraph().instances.length).toBe(1);
  });
});

describe('CosmosGraph — callback identity change only', () => {
  beforeEach(() => {
    getMockGraph().reset();
    getMockLabelRenderer().reset();
    installResizeObserverStub();
  });

  it('does not reconstruct the engine or re-invoke data setters', () => {
    const data = buildData();
    const { rerender } = render(
      <CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={() => {}} />,
    );

    const inst = getMockGraph().last();
    inst.calls = [];

    rerender(
      <CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={() => {}} />,
    );

    expect(getMockGraph().instances.length).toBe(1);
    const dataSetterCalls = inst.calls.filter((c) =>
      (DATA_EFFECT_CALL_ORDER as readonly string[]).includes(c.method),
    );
    expect(dataSetterCalls).toEqual([]);
  });
});

describe('CosmosGraph — click dispatch', () => {
  beforeEach(() => {
    getMockGraph().reset();
    getMockLabelRenderer().reset();
    installResizeObserverStub();
  });

  it('forwards a valid point index to onPointClick with (id, kind)', () => {
    const data = buildData();
    const onPointClick = vi.fn();
    render(
      <CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={onPointClick} />,
    );

    const memIdx = data.indexToKind.findIndex((k) => k === 'memory');
    expect(memIdx).toBeGreaterThanOrEqual(0);

    getMockGraph().last().triggerClick(memIdx);

    expect(onPointClick).toHaveBeenCalledTimes(1);
    expect(onPointClick).toHaveBeenCalledWith(data.indexToId[memIdx], 'memory');
  });

  it('forwards a background click (undefined) as (null, null)', () => {
    const data = buildData();
    const onPointClick = vi.fn();
    render(
      <CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={onPointClick} />,
    );

    getMockGraph().last().triggerClick(undefined);

    expect(onPointClick).toHaveBeenCalledTimes(1);
    expect(onPointClick).toHaveBeenCalledWith(null, null);
  });

  it('toggles off on a second click of the same point (clears selection)', () => {
    const data = buildData();
    const onPointClick = vi.fn();
    render(
      <CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={onPointClick} />,
    );

    const memIdx = data.indexToKind.findIndex((k) => k === 'memory');
    expect(memIdx).toBeGreaterThanOrEqual(0);

    const inst = getMockGraph().last();
    inst.triggerClick(memIdx);
    inst.triggerClick(memIdx);

    expect(onPointClick).toHaveBeenCalledTimes(2);
    expect(onPointClick).toHaveBeenNthCalledWith(1, data.indexToId[memIdx], 'memory');
    expect(onPointClick).toHaveBeenNthCalledWith(2, null, null);
  });
});

describe('CosmosGraph — unmount', () => {
  beforeEach(() => {
    getMockGraph().reset();
    getMockLabelRenderer().reset();
    installResizeObserverStub();
  });

  it('calls destroy() on both Graph and LabelRenderer exactly once', () => {
    const data = buildData();
    const { unmount } = render(
      <CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={() => {}} />,
    );

    const graph = getMockGraph().last();
    const labels = getMockLabelRenderer().last();
    expect(graph.destroyed).toBe(false);
    expect(labels.destroyed).toBe(false);

    unmount();

    expect(graph.destroyed).toBe(true);
    expect(labels.destroyed).toBe(true);
    const destroyCalls = graph.calls.filter((c) => c.method === 'destroy');
    expect(destroyCalls.length).toBe(1);
  });
});

describe('CosmosGraph — hover interaction (engine-internal, no React callback)', () => {
  beforeEach(() => {
    getMockGraph().reset();
    getMockLabelRenderer().reset();
    installResizeObserverStub();
  });

  it('on hover, pushes outlinedPointIndices + highlightedLinkIndices via setConfigPartial', () => {
    const data = buildData();
    render(
      <CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={() => {}} />,
    );

    const inst = getMockGraph().last();
    inst.calls = []; // Isolate the hover call from the mount-time uploads.

    const memIdx = data.indexToKind.findIndex((k) => k === 'memory');
    expect(memIdx).toBeGreaterThanOrEqual(0);
    inst.triggerPointMouseOver(memIdx);

    const setConfigCalls = inst.calls.filter((c) => c.method === 'setConfigPartial');
    expect(setConfigCalls.length).toBe(1);
    const payload = setConfigCalls[0]?.args[0] as Record<string, unknown>;
    expect(Array.isArray(payload['outlinedPointIndices'])).toBe(true);
    expect(Array.isArray(payload['highlightedLinkIndices'])).toBe(true);
    // The hovered index itself is always part of the outlined set.
    expect(payload['outlinedPointIndices']).toContain(memIdx);
  });

  it('on hover-out, clears outlinedPointIndices + highlightedLinkIndices', () => {
    const data = buildData();
    render(
      <CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={() => {}} />,
    );

    const inst = getMockGraph().last();
    inst.calls = [];
    inst.triggerPointMouseOut();

    const setConfigCalls = inst.calls.filter((c) => c.method === 'setConfigPartial');
    expect(setConfigCalls.length).toBe(1);
    expect(setConfigCalls[0]?.args[0]).toEqual({
      outlinedPointIndices: undefined,
      highlightedLinkIndices: undefined,
    });
  });

  it('ignores hover while a click selection is active', () => {
    const data = buildData();
    render(
      <CosmosGraph data={data} backgroundColor="#ffffff" onPointClick={() => {}} />,
    );

    const inst = getMockGraph().last();
    const memIdx = data.indexToKind.findIndex((k) => k === 'memory');
    expect(memIdx).toBeGreaterThanOrEqual(0);

    // Activate the click selection, then clear the call log so we only
    // observe hover-induced calls afterward.
    inst.triggerClick(memIdx);
    inst.calls = [];

    inst.triggerPointMouseOver(memIdx);
    inst.triggerPointMouseOut();

    // The hover handlers early-return when `clickedRef` is set, so they
    // should NOT invoke setConfigPartial.
    const setConfigCalls = inst.calls.filter((c) => c.method === 'setConfigPartial');
    expect(setConfigCalls).toEqual([]);
  });
});
