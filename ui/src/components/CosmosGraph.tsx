import { useEffect, useRef } from 'react';
import { Graph, type GraphConfig } from '@cosmos.gl/graph';

import type { CosmosGraphData, NodeId, NodeKind } from '../graph/transform.js';
import { CosmosLabels } from './CosmosLabels.js';

/**
 * Thin React wrapper around `@cosmos.gl/graph`.
 *
 * Lifecycle model:
 * - Uploads data exactly once, at mount time. Subsequent prop changes to
 *   `data`, `backgroundColor`, or `onPointClick` do NOT reupload buffers
 *   or touch the engine's layout state.
 * - The parent triggers a fresh layout by changing the component's `key`
 *   prop, which remounts the whole subtree: the old engine/labels are
 *   destroyed and a new pair is built against the latest `data` + theme.
 * - This decouples UI polling (which refreshes `data` every 10s) from
 *   simulation (which would otherwise restart on every poll and never
 *   fully settle).
 *
 * Visual model:
 * - Pure colored dots. Project hubs render with floating text labels
 *   managed by `CosmosLabels`; memory/concept leaves are unlabeled.
 * - Hover a point: outline it and its neighbors, soft-fade other links.
 * - Click a point: full highlight — ring around the clicked point, its
 *   neighborhood stays bright, everything else greys out. Click the same
 *   point or the background to clear.
 * - All dimming/highlighting uses cosmos.gl's native
 *   `highlightedPointIndices` / `outlinedPointIndices` / `focusedPointIndex`
 *   config — no custom DOM layer, no rAF loop, no per-frame React renders.
 */
export interface CosmosGraphProps {
  readonly data: CosmosGraphData;
  readonly backgroundColor: string;
  readonly onPointClick: (id: NodeId | null, kind: NodeKind | null) => void;
}

export function CosmosGraph(props: CosmosGraphProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelsContainerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<Graph | null>(null);
  const labelsRef = useRef<CosmosLabels | null>(null);
  // Latest-props ref so engine callbacks (registered once at mount) read
  // the current `data` and `onPointClick` without rebuilding the engine
  // when their identities change between renders.
  const propsRef = useRef(props);
  propsRef.current = props;
  // Currently-clicked index; null when no point is in the "exploring"
  // state. Kept in a ref so hover callbacks can cheaply skip their
  // soft-preview updates while an explicit click selection is active.
  const clickedRef = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const clearExploration = (): void => {
      clickedRef.current = null;
      graphRef.current?.setConfigPartial({
        focusedPointIndex: undefined,
        highlightedPointIndices: undefined,
        outlinedPointIndices: undefined,
        highlightedLinkIndices: undefined,
        linkGreyoutOpacity: 0.05,
      });
    };

    const config: GraphConfig = {
      // Baseline: cosmos.gl defaults for everything except the items we
      // deliberately override from the point-labels demo.
      //
      // `simulationDecay: 300` — tuned for ~2 seconds of active
      // simulation. Default is 5000 (~10 seconds). Larger points make
      // sub-pixel late-frame motion more visible on screen, so we decay
      // harder than we would with smaller sprites to compensate.
      backgroundColor: propsRef.current.backgroundColor,
      linkDefaultWidth: 0.6,
      enableDrag: true,
      simulationDecay: 300,

      // Reposition label spans every time the engine advances — both
      // during the force simulation (points moving in simulation space)
      // and on zoom/pan (points unchanged but screen projection changes).
      onSimulationTick: (): void => {
        const g = graphRef.current;
        if (g) labelsRef.current?.update(g);
      },
      onZoom: (): void => {
        const g = graphRef.current;
        if (g) labelsRef.current?.update(g);
      },

      // Hover: soft preview. Outline the hovered point and its
      // neighborhood and fade unrelated links. Skip if a click selection
      // is active.
      onPointMouseOver: (pointIndex: number): void => {
        if (clickedRef.current !== null) return;
        const g = graphRef.current;
        if (!g) return;
        const neighborhood = [pointIndex, ...g.getNeighboringPointIndices(pointIndex)];
        g.setConfigPartial({
          outlinedPointIndices: neighborhood,
          highlightedLinkIndices: g.getConnectedLinkIndices(neighborhood),
        });
      },
      onPointMouseOut: (): void => {
        if (clickedRef.current !== null) return;
        graphRef.current?.setConfigPartial({
          outlinedPointIndices: undefined,
          highlightedLinkIndices: undefined,
        });
      },

      // Click: full highlight. Ring, neighborhood stays bright, everything
      // else greys out. A second click on the same point clears.
      onClick: (pointIndex: number | undefined): void => {
        const p = propsRef.current;
        const g = graphRef.current;
        if (!g) return;
        if (pointIndex === undefined) {
          clearExploration();
          p.onPointClick(null, null);
          return;
        }
        if (clickedRef.current === pointIndex) {
          clearExploration();
          p.onPointClick(null, null);
          return;
        }
        clickedRef.current = pointIndex;
        const neighborhood = [pointIndex, ...g.getNeighboringPointIndices(pointIndex)];
        g.setConfigPartial({
          focusedPointIndex: pointIndex,
          highlightedPointIndices: neighborhood,
          highlightedLinkIndices: g.getConnectedLinkIndices(neighborhood),
          outlinedPointIndices: undefined,
        });
        p.onPointClick(
          p.data.indexToId[pointIndex] ?? null,
          p.data.indexToKind[pointIndex] ?? null,
        );
      },
    };

    // Build the engine + label overlay.
    const graph = new Graph(container, config);
    graphRef.current = graph;

    const labelsContainer = labelsContainerRef.current;
    if (labelsContainer) {
      labelsRef.current = new CosmosLabels(labelsContainer, new Map());
    }

    // Upload the initial (and only) data snapshot.
    const { data } = propsRef.current;
    graph.setPointPositions(data.positions);
    graph.setPointColors(data.colors);
    graph.setPointSizes(data.sizes);
    graph.setLinks(data.links);
    graph.setLinkColors(data.linkColors);

    // Build the label map and the set of project indices to track, so
    // the overlay can follow project points through the simulation.
    const projectIndices: number[] = [];
    const labelMap = new Map<number, string>();
    for (let i = 0; i < data.indexToKind.length; i++) {
      if (data.indexToKind[i] !== 'project') continue;
      projectIndices.push(i);
      const text = data.indexToLabel[i];
      if (text !== null && text !== undefined) labelMap.set(i, text);
    }
    labelsRef.current?.setPointIndexToLabel(labelMap);

    graph.render();
    // Track project positions AFTER render, matching the demo's order.
    // Calling this before render leaves the tracker holding stale
    // indices that get wiped by the upload pipeline.
    graph.trackPointPositionsByIndices(projectIndices);

    return () => {
      labelsRef.current?.destroy();
      labelsRef.current = null;
      graph.destroy();
      graphRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid="cosmos-canvas"
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      {/* Label overlay: absolute-positioned sibling of the cosmos canvas.
          `CosmosLabels` writes absolutely-positioned child spans into this
          div and updates their transforms on every simulation tick / zoom
          event. Pointer events pass through so clicks still hit the canvas. */}
      <div
        ref={labelsContainerRef}
        data-testid="cosmos-labels"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      />
    </div>
  );
}
