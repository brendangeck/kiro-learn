/**
 * Property-based test: numeric bounds of `transform()` output.
 *
 * @see .kiro/specs/cosmos-gl-graph/design.md — Property P4
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { transform } from '../../ui/src/graph/transform.js';
import { transformInputArb } from '../helpers/cosmos-arb.js';

describe('transform() — P4: color components are in [0, 1]', () => {
  it('every entry in colors and linkColors is in [0, 1]', () => {
    /**
     * Any out-of-range GL color is either clamped silently by the GPU or
     * produces garbage output — both are bugs upstream.
     */
    fc.assert(
      fc.property(transformInputArb, ({ memories, projects, theme }) => {
        const data = transform(memories, projects, theme);

        for (let i = 0; i < data.colors.length; i++) {
          const c = data.colors[i]!;
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
        for (let i = 0; i < data.linkColors.length; i++) {
          const c = data.linkColors[i]!;
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(1);
        }
      }),
      { numRuns: 50 },
    );
  });
});

describe('transform() — per-kind sizes: projects are strictly larger than leaves', () => {
  it('project size > memory/concept size for every generated input', () => {
    /**
     * The hub/leaf visual distinction depends on projects being physically
     * larger than memories and concepts. If this collapses, the user can't
     * tell projects apart at a glance.
     */
    fc.assert(
      fc.property(transformInputArb, ({ memories, projects, theme }) => {
        const data = transform(memories, projects, theme);
        for (let i = 0; i < data.indexToKind.length; i++) {
          const size = data.sizes[i]!;
          if (data.indexToKind[i] === 'project') {
            expect(size).toBeGreaterThan(4); // default leaf size
          } else {
            expect(size).toBe(4);
          }
        }
      }),
      { numRuns: 50 },
    );
  });
});
