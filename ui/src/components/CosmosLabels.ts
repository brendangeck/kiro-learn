import { LabelRenderer, type LabelOptions } from '@interacta/css-labels';
import type { Graph } from '@cosmos.gl/graph';

/**
 * DOM-overlay label renderer for cosmos.gl Graph instances.
 *
 * Cosmos.gl renders points and edges on WebGL; it does NOT render text.
 * This class lives as a sibling overlay above the canvas, subscribes to the
 * engine's tracked-points stream, and repositions label spans every frame
 * so they follow their points through the simulation and on zoom/pan.
 *
 * Ported from the `point-labels` cosmos.gl storybook demo:
 * https://github.com/cosmosgl/graph/blob/main/src/stories/beginners/point-labels/labels.ts
 */
export class CosmosLabels {
  private readonly labelRenderer: LabelRenderer;
  private readonly labels: LabelOptions[] = [];
  private pointIndexToLabel: Map<number, string>;

  /**
   * @param container  A `<div>` sized and positioned over the cosmos canvas
   *   (`position: absolute; inset: 0; pointer-events: none` is typical).
   *   The renderer writes absolutely-positioned child spans into this div.
   * @param pointIndexToLabel  Initial mapping from cosmos.gl point index to
   *   the string to display. Can be replaced via `setPointIndexToLabel`.
   */
  constructor(container: HTMLDivElement, pointIndexToLabel: Map<number, string>) {
    this.labelRenderer = new LabelRenderer(container, { pointerEvents: 'none' });
    this.pointIndexToLabel = pointIndexToLabel;
  }

  /**
   * Replace the index-to-label mapping. The next `update()` call will
   * reflect the new mapping (and prune any labels that are no longer
   * backed by a tracked point).
   */
  setPointIndexToLabel(pointIndexToLabel: Map<number, string>): void {
    this.pointIndexToLabel = pointIndexToLabel;
  }

  /**
   * Pull current tracked positions from the engine, convert each to screen
   * space, and redraw. Intended to be called from `onSimulationTick` and
   * `onZoom` callbacks on the Graph config.
   */
  update(graph: Graph): void {
    const trackedPositions = graph.getTrackedPointPositionsMap();
    let index = 0;
    trackedPositions.forEach((position, pointIndex) => {
      const [simX, simY] = position;
      const [screenX, screenY] = graph.spaceToScreenPosition([simX ?? 0, simY ?? 0]);

      // Place the label above the point by the point's on-screen radius
      // plus a small padding so it doesn't kiss the dot.
      const spaceRadius = graph.getPointRadiusByIndex(pointIndex);
      const screenRadius = spaceRadius !== undefined ? graph.spaceToScreenRadius(spaceRadius) : 0;

      this.labels[index] = {
        id: `${pointIndex}`,
        text: this.pointIndexToLabel.get(pointIndex) ?? '',
        x: screenX,
        y: screenY - (screenRadius + 2),
        opacity: 1,
        // White text on the renderer's default dark pill background
        // (#1e2428). Matches the point-labels demo, which achieves the
        // same via `.app { color: white }` inherited CSS.
        color: 'white',
      };
      index += 1;
    });

    // Trim any stale entries left over from a previous larger tracked set.
    this.labels.length = index;

    this.labelRenderer.setLabels(this.labels);
    this.labelRenderer.draw(true);
  }

  /** Release DOM nodes and listeners owned by the underlying renderer. */
  destroy(): void {
    this.labelRenderer.destroy();
  }
}
