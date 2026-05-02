/**
 * Property-based test: determinism of `transform()`.
 *
 * Two calls on structurally-equal inputs produce element-equal outputs.
 * Layout stability across polling refreshes depends on this — same inputs
 * must produce same buffers.
 *
 * @see .kiro/specs/cosmos-gl-graph/design.md — Property P6
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { transform } from '../../ui/src/graph/transform.js';
import { transformInputArb } from '../helpers/cosmos-arb.js';

describe('transform() — P6: structurally-equal inputs produce element-equal outputs', () => {
  it('Float32Arrays and parallel arrays match across calls', () => {
    fc.assert(
      fc.property(transformInputArb, (input) => {
        // Deep-clone the generated input for each call so a theoretical
        // mutation inside `transform` would produce observable drift
        // between the two runs. `transform` is contractually pure, but
        // deep-clones are the property-test analogue of "prove it."
        const a = transform(
          structuredClone(input.memories),
          structuredClone(input.projects),
          structuredClone(input.theme),
        );
        const b = transform(
          structuredClone(input.memories),
          structuredClone(input.projects),
          structuredClone(input.theme),
        );

        expect(b.positions).toEqual(a.positions);
        expect(b.colors).toEqual(a.colors);
        expect(b.sizes).toEqual(a.sizes);
        expect(b.links).toEqual(a.links);
        expect(b.linkColors).toEqual(a.linkColors);

        // indexToId / indexToKind / indexToLabel are the ordering backbone;
        // if they drift, every GL index shifts with them.
        expect(b.indexToId).toEqual(a.indexToId);
        expect(b.indexToKind).toEqual(a.indexToKind);
        expect(b.indexToLabel).toEqual(a.indexToLabel);
      }),
      { numRuns: 50 },
    );
  });
});
