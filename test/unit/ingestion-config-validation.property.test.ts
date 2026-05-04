/**
 * Property-based test for {@link validateCollectorConfig} — Property 21
 * from the reconciliation-engine design.
 *
 * **Property 21: Configuration validation.** For any
 * {@link CollectorConfig} object, `validateCollectorConfig` accepts
 * it if and only if every new reconciliation field lies within its
 * documented range:
 *
 *   - `bufferIdleMs` ∈ [5_000, 300_000]
 *   - `intraBatchSimilarityThreshold` ∈ [0, 1]
 *   - `neighborSimilarityThreshold` ∈ [0, 1]
 *   - `neighborPoolMaxSize` ∈ [1, 100]
 *   - `judgeModelTimeoutMs` ∈ [5_000, 300_000]
 *
 * Out-of-range values cause rejection with a message that names the
 * offending field AND the observed value.
 *
 * ## Strategy
 *
 * Two mixed-in-range / out-of-range generators:
 *
 * 1. A config where EVERY new field lies in its documented range.
 *    Validator must accept — no throw.
 * 2. A config where exactly ONE new field is forced out of range
 *    (everything else still in range). Validator must reject, and
 *    the error message must contain the offending field name and a
 *    substring representation of the observed value.
 *
 * The validator is boolean-returning in spirit: either the whole
 * config passes or a single offending field is flagged. We don't
 * test "multiple out-of-range fields at once" because the validator
 * short-circuits on the first violation — the useful guarantee for
 * operators is that _some_ diagnostic fires, which the single-field
 * case already proves.
 *
 * 200 runs per property.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 13.8
 * @see .kiro/specs/reconciliation-engine/design.md § Correctness
 *   Properties — Property 21
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 10.1–10.7
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COLLECTOR_CONFIG,
  validateCollectorConfig,
} from '../../src/collector/index.js';
import type { CollectorConfig } from '../../src/collector/index.js';

// ── Field-range specs ───────────────────────────────────────────────────

/**
 * Name + range tuple for each validated numeric field. Drives both
 * the "all in-range" generator and the "single out-of-range" generator
 * so the two stay in lockstep — adding a new validated field
 * automatically extends both properties.
 */
const FIELDS: ReadonlyArray<{
  name: keyof CollectorConfig;
  min: number;
  max: number;
}> = [
  { name: 'bufferIdleMs', min: 5_000, max: 300_000 },
  { name: 'intraBatchSimilarityThreshold', min: 0, max: 1 },
  { name: 'neighborSimilarityThreshold', min: 0, max: 1 },
  { name: 'neighborPoolMaxSize', min: 1, max: 100 },
  { name: 'judgeModelTimeoutMs', min: 5_000, max: 300_000 },
];

// ── Arbitraries ─────────────────────────────────────────────────────────

/**
 * Generate a float in the closed range `[min, max]`, inclusive at
 * both ends. `noNaN` because `Number.isFinite(NaN) === false` would
 * incorrectly trigger the validator's rejection path and confuse the
 * "all in-range" test.
 */
function inRangeFloat(min: number, max: number): fc.Arbitrary<number> {
  return fc.double({
    min,
    max,
    noNaN: true,
    noDefaultInfinity: true,
  });
}

/**
 * Generate an integer in the closed range `[min, max]`.
 */
function inRangeInt(min: number, max: number): fc.Arbitrary<number> {
  return fc.integer({ min, max });
}

/**
 * Generate a value for a given field within its documented range.
 * Integer-valued fields use integer generators; floats use bounded
 * doubles. The split is hard-coded per field because
 * `neighborPoolMaxSize` is an integer knob and the others are real-
 * valued.
 */
function valueInRange(field: { name: keyof CollectorConfig; min: number; max: number }): fc.Arbitrary<number> {
  if (field.name === 'neighborPoolMaxSize' || field.name === 'bufferIdleMs' || field.name === 'judgeModelTimeoutMs') {
    return inRangeInt(field.min, field.max);
  }
  return inRangeFloat(field.min, field.max);
}

/**
 * Generate an out-of-range value for a given field. Returns a mix of
 * "below min" and "above max" values — both branches of the
 * validator's rejection path get exercised. Uses `oneof` rather than
 * a single direction so a property iteration covers both in
 * expectation.
 *
 * Integer-valued fields use integer-step offsets; float-valued fields
 * use a `>= 0.5` margin so rounding to the representable double
 * nearest the field's max can't accidentally land back inside the
 * range (`300_000 + Number.EPSILON === 300_000` in IEEE 754, which
 * is exactly the bug fc found on the first counterexample).
 */
function valueOutOfRange(field: { name: keyof CollectorConfig; min: number; max: number }): fc.Arbitrary<number> {
  const isInteger =
    field.name === 'neighborPoolMaxSize' ||
    field.name === 'bufferIdleMs' ||
    field.name === 'judgeModelTimeoutMs';
  if (isInteger) {
    const below = fc.integer({ min: field.min - 1_000_000, max: field.min - 1 });
    const above = fc.integer({ min: field.max + 1, max: field.max + 1_000_000 });
    return fc.oneof(below, above);
  }
  // Float-valued ranges are [0, 1] — use a margin of `>= 0.5` so
  // the representable floats genuinely sit outside the range.
  const below = fc.double({
    min: field.min - 1_000_000,
    max: field.min - 0.5,
    noNaN: true,
    noDefaultInfinity: true,
  });
  const above = fc.double({
    min: field.max + 0.5,
    max: field.max + 1_000_000,
    noNaN: true,
    noDefaultInfinity: true,
  });
  return fc.oneof(below, above);
}

/**
 * Generate a config where every validated field lies within its
 * documented range. Non-validated fields are seeded from
 * `DEFAULT_COLLECTOR_CONFIG` so the returned config is otherwise
 * structurally valid.
 */
const allInRangeConfigArb: fc.Arbitrary<CollectorConfig> = fc
  .record({
    bufferIdleMs: valueInRange(FIELDS[0]!),
    intraBatchSimilarityThreshold: valueInRange(FIELDS[1]!),
    neighborSimilarityThreshold: valueInRange(FIELDS[2]!),
    neighborPoolMaxSize: valueInRange(FIELDS[3]!),
    judgeModelTimeoutMs: valueInRange(FIELDS[4]!),
  })
  .map((overrides) => ({ ...DEFAULT_COLLECTOR_CONFIG, ...overrides }));

/**
 * Generate a config where one randomly-chosen field is pushed out of
 * range and every other validated field sits in its documented range.
 * The output carries the forced field name and observed value so the
 * property can assert the error message references both.
 */
const singleOutOfRangeConfigArb: fc.Arbitrary<{
  config: CollectorConfig;
  badField: (typeof FIELDS)[number];
  badValue: number;
}> = fc
  .tuple(
    fc.nat({ max: FIELDS.length - 1 }),
    valueInRange(FIELDS[0]!),
    valueInRange(FIELDS[1]!),
    valueInRange(FIELDS[2]!),
    valueInRange(FIELDS[3]!),
    valueInRange(FIELDS[4]!),
  )
  .chain(([idx, v0, v1, v2, v3, v4]) => {
    const badField = FIELDS[idx]!;
    return valueOutOfRange(badField).map((badValue) => {
      const inRange: Record<string, number> = {
        bufferIdleMs: v0,
        intraBatchSimilarityThreshold: v1,
        neighborSimilarityThreshold: v2,
        neighborPoolMaxSize: v3,
        judgeModelTimeoutMs: v4,
      };
      inRange[badField.name as string] = badValue;
      const config: CollectorConfig = {
        ...DEFAULT_COLLECTOR_CONFIG,
        ...(inRange as Partial<CollectorConfig>),
      };
      return { config, badField, badValue };
    });
  });

// ── Tests ───────────────────────────────────────────────────────────────

describe('Property 21 — Configuration validation', () => {
  it('accepts any config whose validated fields all lie in range', () => {
    fc.assert(
      fc.property(allInRangeConfigArb, (config) => {
        validateCollectorConfig(config);
        // Reaching here means no throw.
      }),
      { numRuns: 200 },
    );
  });

  it('rejects a config whose single chosen field is out of range — error names field + observed value', () => {
    fc.assert(
      fc.property(singleOutOfRangeConfigArb, ({ config, badField, badValue }) => {
        let caught: unknown = undefined;
        try {
          validateCollectorConfig(config);
        } catch (err: unknown) {
          caught = err;
        }
        // Must have thrown.
        expect(caught).toBeInstanceOf(Error);
        const message = (caught as Error).message;

        // The message must reference the offending field.
        expect(message).toContain(String(badField.name));

        // The message must contain the observed value. We compare
        // as `String(value)` because the validator uses
        // `String(value)` to interpolate — this keeps the property
        // aligned with the implementation rather than with a
        // number-formatting quirk (e.g., `-0.5.toString()` vs
        // `'-0.5'`).
        expect(message).toContain(String(badValue));
      }),
      { numRuns: 200 },
    );
  });
});
