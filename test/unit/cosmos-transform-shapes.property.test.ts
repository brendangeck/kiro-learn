/**
 * Property-based test: buffer shape invariants of `transform()`.
 *
 * For any valid input, let `pointCount = indexToId.length` and
 * `linkCount = links.length / 2`. Every buffer must align to these counts.
 *
 * @see .kiro/specs/cosmos-gl-graph/design.md — Property P1
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { transform } from '../../ui/src/graph/transform.js';
import { transformInputArb } from '../helpers/cosmos-arb.js';

describe('transform() — P1: buffer shapes are consistent with pointCount/linkCount', () => {
  it('every Float32Array has the length prescribed by pointCount or linkCount', () => {
    fc.assert(
      fc.property(transformInputArb, ({ memories, projects, theme }) => {
        const data = transform(memories, projects, theme);
        const pointCount = data.indexToId.length;
        const linkCount = data.links.length / 2;

        expect(Number.isInteger(linkCount)).toBe(true);
        expect(data.positions.length).toBe(2 * pointCount);
        expect(data.colors.length).toBe(4 * pointCount);
        expect(data.sizes.length).toBe(pointCount);
        expect(data.linkColors.length).toBe(4 * linkCount);

        // Parallel bi-map arrays share pointCount.
        expect(data.indexToKind.length).toBe(pointCount);
        expect(data.indexToLabel.length).toBe(pointCount);
      }),
      { numRuns: 50 },
    );
  });
});
