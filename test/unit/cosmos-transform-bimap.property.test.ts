/**
 * Property-based test: link-endpoint validity and bi-map round-trip for
 * `transform()`.
 *
 * @see .kiro/specs/cosmos-gl-graph/design.md — Properties P2, P3
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { transform } from '../../ui/src/graph/transform.js';
import { transformInputArb } from '../helpers/cosmos-arb.js';

describe('transform() — P2: every link endpoint is a valid integer point index', () => {
  it('0 ≤ links[i] < pointCount and links[i] is an integer', () => {
    /**
     * Every GL index in `links` must address a real point. Non-integer
     * indices would be a silent GPU-side corruption.
     */
    fc.assert(
      fc.property(transformInputArb, ({ memories, projects, theme }) => {
        const data = transform(memories, projects, theme);
        const pointCount = data.indexToId.length;

        for (let i = 0; i < data.links.length; i++) {
          const v = data.links[i]!;
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(pointCount);
        }
      }),
      { numRuns: 50 },
    );
  });
});

describe('transform() — P3: bi-map round-trips and parallel arrays agree', () => {
  it('idToIndex.get(indexToId[i]) === i and indexToKind/indexToLabel share pointCount', () => {
    /**
     * The bi-map between Node_Id and Point_Index is the interaction
     * backbone; a single off-by-one corrupts every click.
     */
    fc.assert(
      fc.property(transformInputArb, ({ memories, projects, theme }) => {
        const data = transform(memories, projects, theme);
        const pointCount = data.indexToId.length;

        for (let i = 0; i < pointCount; i++) {
          expect(data.idToIndex.get(data.indexToId[i]!)).toBe(i);
        }
        expect(data.idToIndex.size).toBe(pointCount);
        expect(data.indexToKind.length).toBe(pointCount);
        expect(data.indexToLabel.length).toBe(pointCount);
      }),
      { numRuns: 50 },
    );
  });
});

describe('transform() — indexToLabel: projects carry display names, leaves carry null', () => {
  it('project indices hold a non-empty string, memory/concept indices hold null', () => {
    fc.assert(
      fc.property(transformInputArb, ({ memories, projects, theme }) => {
        const data = transform(memories, projects, theme);

        for (let i = 0; i < data.indexToKind.length; i++) {
          const label = data.indexToLabel[i];
          if (data.indexToKind[i] === 'project') {
            expect(typeof label).toBe('string');
            expect((label as string).length).toBeGreaterThan(0);
          } else {
            expect(label).toBeNull();
          }
        }
      }),
      { numRuns: 50 },
    );
  });
});
