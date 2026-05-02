import { useEffect, useRef } from 'react';
import { Graph, type GraphConfig } from '@cosmos.gl/graph';

import type { CosmosGraphData, NodeId, NodeKind } from '../graph/transform.js';
import { CosmosLabels } from './CosmosLabels.js';

/**
 * Thin React wrapper around `@cosmos.gl/graph`.
 *
 * Visual model:
 * - Pure colored dots. No labels. Node kind is communicated by color only,
 *   surfaced in the dashboard via `GraphLegend`.
 * - Hover a point: outline it and its neighbors, soft-fade other links.
 * - Click a point: full highlight — ring around the clicked point, its
 *   neighborhood stays bright, everything else greys out. Click the same
 *   point or the background to clear.
 *
 * All dimming/highlighting uses cosmos.gl's native
 * `highlightedPointIndices` / `outlinedPointIndices` / `focusedPointIndex`
 * config — no custom DOM layer, no rAF loop, no per-frame React re-renders.
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
  // Latest-props ref so engine callbacks (registered once at mount) read the
  // current data and onPointClick without rebuilding the engine when those
  // prop identities change.
  const propsRef = useRef(props);
  propsRef.current = props;
  // Currently-clicked index; null when no point is in the "exploring" state.
  // Kept in a ref so hover callbacks can cheaply skip their soft-preview
  // updates while an explicit click selection is active.
  const clickedRef = useRef<number | null>(null);
  // Previous `data` prop, kept so we can diff on every data-effect run and
  // decide whether we can do an incremental (layout-preserving) upload or
  // we need a full reset. Incremental works when the new id set is a
  // superset of the previous (only additions, no removals or reorders).
  const prevDataRef = useRef<CosmosGraphData | null>(null);

  // --- Mount: construct engine exactly once. ---
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
      // Baseline: use cosmos.gl defaults for everything except the items
      // ported from the point-labels demo palette. Background is set via
      // propsRef.current.backgroundColor (which `getPackedTheme` now
      // returns the demo's #2d313a), and edge default width is matched to
      // the demo's 0.6 so the ratio of edge-to-point stays consistent.
      //
      // Settling is controlled primarily by `simulationDecay` (alpha
      // half-life), NOT `simulationFriction`. Friction damps stored
      // velocity between ticks, but repulsion + link springs write fresh
      // velocity every tick scaled by `alpha` — so the simulation keeps
      // producing motion until alpha decays past the engine's threshold.
      //
      // `simulationDecay: 1500` — tuned for ~3 seconds of active
      // simulation. Default is 5000 (~10 seconds); empirical testing
      // against our live data showed 500 settled in ~1 second, 1500
      // lands near the 3-second sweet spot where the initial unfurling
      // is satisfying to watch but ends before it feels stale.
      backgroundColor: propsRef.current.backgroundColor,
      linkDefaultWidth: 0.6,
      enableDrag: true,
      simulationDecay: 1500,

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

      // Hover: soft preview. Outline the hovered point and its neighborhood
      // and fade unrelated links. Skip if a click selection is active.
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

    const graph = new Graph(container, config);
    graphRef.current = graph;

    // Label overlay. Constructed after the engine so that the labels div
    // already exists in the DOM. Initial index→label map is empty; the
    // data-effect below populates it on every data upload.
    const labelsContainer = labelsContainerRef.current;
    if (labelsContainer) {
      labelsRef.current = new CosmosLabels(labelsContainer, new Map());
    }

    return () => {
      labelsRef.current?.destroy();
      labelsRef.current = null;
      graph.destroy();
      graphRef.current = null;
    };
  }, []);

  // --- Upload buffers when data changes.
  //
  // Two paths. The "incremental" path preserves layout positions, camera
  // zoom/pan, and click selection — so polling refreshes that only add new
  // memories feel seamless, like nodes popping in without the graph
  // resetting. It is taken when the new data is an id-superset of the old.
  //
  // The "full" path is a clean reset — positions from the seed, camera
  // fit to the data's actual extent (via `fitView()`, NOT a fixed zoom
  // level — the correct zoom depends on how wide the data spreads and the
  // canvas size), selection cleared. Taken on first mount and on any change
  // that isn't strictly additive (id removed, filter toggled, dark-mode
  // swap, etc.). Since `transform()` stable-sorts memories by record_id,
  // ordinary polling refreshes always land in the incremental path.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const { data } = props;
    const prev = prevDataRef.current;

    // Is the new id set a strict superset of the previous one (with every
    // previously-existing id still at its old index)? If so, we can
    // preserve layout.
    const canIncrementallyAdd = (() => {
      if (prev === null) return false;
      if (data.indexToId.length < prev.indexToId.length) return false;
      for (let i = 0; i < prev.indexToId.length; i++) {
        if (prev.indexToId[i] !== data.indexToId[i]) return false;
      }
      return true;
    })();

    let positionsToUpload: Float32Array;
    if (canIncrementallyAdd && prev !== null) {
      // Read back current simulation positions for existing points and
      // preserve them. New points get their hash-seeded positions from the
      // freshly-transformed data. Cosmos.gl's `getPointPositions()` returns
      // a flat number[] interleaved as [x0, y0, x1, y1, ...].
      const current = graph.getPointPositions();
      positionsToUpload = new Float32Array(data.positions);
      const keep = Math.min(current.length, positionsToUpload.length);
      for (let i = 0; i < keep; i++) positionsToUpload[i] = current[i] ?? 0;
    } else {
      positionsToUpload = data.positions;
    }

    graph.setPointPositions(positionsToUpload);
    graph.setPointColors(data.colors);
    graph.setPointSizes(data.sizes);
    graph.setLinks(data.links);
    graph.setLinkColors(data.linkColors);

    // Build the set of project indices to track for labels, and the
    // matching index→label map for the overlay renderer. Only project
    // points are labeled for now (memories/concepts carry `null` labels).
    const projectIndices: number[] = [];
    const labelMap = new Map<number, string>();
    for (let i = 0; i < data.indexToKind.length; i++) {
      if (data.indexToKind[i] !== 'project') continue;
      projectIndices.push(i);
      const text = data.indexToLabel[i];
      if (text !== null && text !== undefined) labelMap.set(i, text);
    }
    labelsRef.current?.setPointIndexToLabel(labelMap);

    if (!canIncrementallyAdd) {
      // Full reset: drop any selection because the old click-index may now
      // point at a different (or removed) node.
      clickedRef.current = null;
      graph.setConfigPartial({
        focusedPointIndex: undefined,
        highlightedPointIndices: undefined,
        outlinedPointIndices: undefined,
        highlightedLinkIndices: undefined,
      });
    }

    graph.render();
    // Track project positions for the label overlay AFTER render, matching
    // the demo's order. Calling this before render can leave the tracker
    // holding stale indices that get reset by the upload pipeline.
    graph.trackPointPositionsByIndices(projectIndices);
    // Baseline: rely on the engine's default simulation auto-start and
    // default `fitViewOnInit: true`. No explicit `start()` or `fitView()`
    // — we want to see what the engine produces with zero overrides.
    prevDataRef.current = data;
  }, [props.data]);

  // --- Visual-only delta (dark-mode toggle). ---
  useEffect(() => {
    graphRef.current?.setConfigPartial({ backgroundColor: props.backgroundColor });
  }, [props.backgroundColor]);

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
