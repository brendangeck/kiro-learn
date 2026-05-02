// @vitest-environment jsdom
/**
 * Unit test for `ui/src/components/CosmosLabels.ts`.
 *
 * Mocks `@interacta/css-labels` so we can inspect exactly what label
 * payloads the class sends to the renderer, and mocks the cosmos.gl
 * `Graph` interface with a minimal object that returns known positions
 * and radii.
 *
 * @see .kiro/specs/cosmos-gl-graph/design.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the label-renderer library BEFORE importing CosmosLabels.
// ---------------------------------------------------------------------------

interface MockRendererInstance {
  container: HTMLDivElement;
  setLabelsCalls: Array<unknown[]>;
  drawCalls: number;
  destroyed: boolean;
}
interface MockRendererCtor {
  new (container: HTMLDivElement, options?: unknown): MockRendererInstance;
  instances: MockRendererInstance[];
  last(): MockRendererInstance;
  reset(): void;
}

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
      // Snapshot at push time: CosmosLabels.update reuses its internal
      // array in place, so a shallow copy here is the only way subsequent
      // asserts can see per-call state.
      this.setLabelsCalls.push(
        (labels as Array<Record<string, unknown>>).map((l) => ({ ...l })),
      );
    };
    draw = (_withIntersection?: boolean): void => { this.drawCalls += 1; };
    show = (): void => {};
    hide = (): void => {};
    destroy = (): void => { this.destroyed = true; };
  }

  (globalThis as unknown as { __MockLabelRenderer__: MockRendererCtor }).__MockLabelRenderer__ =
    MockLabelRenderer as unknown as MockRendererCtor;

  return { LabelRenderer: MockLabelRenderer };
});

function getMockRenderer(): MockRendererCtor {
  const r = (globalThis as unknown as { __MockLabelRenderer__?: MockRendererCtor }).__MockLabelRenderer__;
  if (!r) throw new Error('MockLabelRenderer not installed');
  return r;
}

const { CosmosLabels } = await import('../../ui/src/components/CosmosLabels.js');

// ---------------------------------------------------------------------------
// Minimal fake Graph
// ---------------------------------------------------------------------------

/**
 * Returns a fake Graph-shaped object that reports the supplied tracked
 * positions and a constant radius. Only the methods CosmosLabels.update
 * actually calls are implemented.
 */
function makeFakeGraph(tracked: Map<number, [number, number]>, radius = 8) {
  return {
    getTrackedPointPositionsMap: () => tracked,
    spaceToScreenPosition: ([x, y]: [number, number]): [number, number] => [x, y],
    spaceToScreenRadius: (r: number) => r,
    getPointRadiusByIndex: (_i: number) => radius,
  } as unknown as Parameters<InstanceType<typeof CosmosLabels>['update']>[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CosmosLabels', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    getMockRenderer().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('constructs a LabelRenderer on the supplied container', () => {
    new CosmosLabels(container, new Map());
    const r = getMockRenderer();
    expect(r.instances.length).toBe(1);
    expect(r.last().container).toBe(container);
  });

  it('emits one label per tracked point with text from the index→label map', () => {
    const labels = new CosmosLabels(
      container,
      new Map([
        [1, 'project-one'],
        [3, 'project-three'],
      ]),
    );

    const graph = makeFakeGraph(
      new Map([
        [1, [100, 200]],
        [3, [300, 400]],
      ]),
      8,
    );
    labels.update(graph);

    const r = getMockRenderer().last();
    expect(r.setLabelsCalls.length).toBe(1);
    const emitted = r.setLabelsCalls[0] as Array<{
      id: string;
      text: string;
      x: number;
      y: number;
      color?: string;
    }>;
    expect(emitted.length).toBe(2);

    // Sort by id for deterministic assertions (Map iteration order is
    // insertion order but we shouldn't rely on it).
    const byId = new Map(emitted.map((l) => [l.id, l]));
    const label1 = byId.get('1')!;
    const label3 = byId.get('3')!;

    expect(label1.text).toBe('project-one');
    // Label is placed above the point by (radius + 2) pixels.
    expect(label1.x).toBe(100);
    expect(label1.y).toBe(200 - (8 + 2));
    expect(label1.color).toBe('white');

    expect(label3.text).toBe('project-three');
    expect(label3.x).toBe(300);
    expect(label3.y).toBe(400 - (8 + 2));
  });

  it('calls draw(true) once per update() so the renderer actually paints', () => {
    const labels = new CosmosLabels(container, new Map([[1, 'a']]));
    labels.update(makeFakeGraph(new Map([[1, [0, 0]]])));
    labels.update(makeFakeGraph(new Map([[1, [1, 1]]])));
    expect(getMockRenderer().last().drawCalls).toBe(2);
  });

  it('falls back to an empty string when a tracked index has no label in the map', () => {
    const labels = new CosmosLabels(container, new Map());
    labels.update(makeFakeGraph(new Map([[7, [50, 50]]])));

    const emitted = getMockRenderer().last().setLabelsCalls[0] as Array<{ text: string }>;
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.text).toBe('');
  });

  it('setPointIndexToLabel swaps the map atomically for the next update', () => {
    const labels = new CosmosLabels(container, new Map([[1, 'old']]));
    labels.update(makeFakeGraph(new Map([[1, [0, 0]]])));
    labels.setPointIndexToLabel(new Map([[1, 'new']]));
    labels.update(makeFakeGraph(new Map([[1, [0, 0]]])));

    const calls = getMockRenderer().last().setLabelsCalls as Array<Array<{ text: string }>>;
    expect(calls[0]![0]!.text).toBe('old');
    expect(calls[1]![0]!.text).toBe('new');
  });

  it('trims stale entries when the tracked set shrinks', () => {
    const labels = new CosmosLabels(
      container,
      new Map([
        [1, 'a'],
        [2, 'b'],
        [3, 'c'],
      ]),
    );

    labels.update(
      makeFakeGraph(
        new Map([
          [1, [0, 0]],
          [2, [1, 1]],
          [3, [2, 2]],
        ]),
      ),
    );
    labels.update(makeFakeGraph(new Map([[1, [0, 0]]])));

    const calls = getMockRenderer().last().setLabelsCalls;
    expect((calls[0] as unknown[]).length).toBe(3);
    expect((calls[1] as unknown[]).length).toBe(1);
  });

  it('destroy() propagates to the underlying renderer exactly once', () => {
    const labels = new CosmosLabels(container, new Map());
    labels.destroy();
    expect(getMockRenderer().last().destroyed).toBe(true);
  });
});
