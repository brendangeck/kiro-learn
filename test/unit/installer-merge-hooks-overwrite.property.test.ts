/**
 * Property-based test: `mergeHooks` overwrites owned fields with constants.
 *
 * Feature: default-equivalent-agent, Property 2: mergeHooks overwrites owned fields with constants
 *
 * For every validated Seed_Payload and every `HookTriggerMap`, the merged
 * output's `name` is the string literal `'kiro-learn'`, its `description` is
 * {@link KIRO_LEARN_DESCRIPTION}, and for every `t` in {@link OWNED_TRIGGERS}
 * its `hooks[t]` deep-equals `triggers[t]` — regardless of what the seed had
 * at those keys (including absent, wrong type, or an arbitrary payload).
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.5, 4.6**
 *
 * @see .kiro/specs/default-equivalent-agent/design.md § Key Functions — mergeHooks
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  KIRO_LEARN_DESCRIPTION,
  mergeHooks,
  OWNED_TRIGGERS,
} from '../../src/installer/index.js';
import type {
  HookEntry,
  HookTriggerMap,
} from '../../src/installer/index.js';

/**
 * Arbitrary for a single `HookEntry`. `matcher` is optional — `fc.option`
 * with `{ nil: undefined }` is the idiomatic way to model a sometimes-absent
 * optional string. We `.map` to either include the `matcher` key or omit it
 * entirely so the generated object is exactly-assignable to `HookEntry`
 * under `exactOptionalPropertyTypes` (which treats `matcher: undefined` and
 * no `matcher` key as distinct types).
 */
const hookEntryArb: fc.Arbitrary<HookEntry> = fc
  .record({
    command: fc.string(),
    matcher: fc.option(fc.string(), { nil: undefined }),
  })
  .map(({ command, matcher }): HookEntry =>
    matcher === undefined ? { command } : { command, matcher },
  );

/**
 * Arbitrary for a `HookTriggerMap` — exactly the four owned keys, each bound
 * to an array of `HookEntry` values.
 */
const hookTriggerMapArb: fc.Arbitrary<HookTriggerMap> = fc.record({
  agentSpawn: fc.array(hookEntryArb),
  userPromptSubmit: fc.array(hookEntryArb),
  postToolUse: fc.array(hookEntryArb),
  stop: fc.array(hookEntryArb),
});

/**
 * Arbitrary for a Seed_Payload-like object. Uses `fc.dictionary` so the
 * generated value is directly a `Record<string, unknown>` — no cast needed to
 * satisfy `mergeHooks`'s signature. We mix in random top-level keys via the
 * dictionary, then compose with a record that occasionally supplies `name`,
 * `description`, and `hooks` at arbitrary values so the owned-field overwrite
 * invariant is exercised across both "absent" and "present with arbitrary
 * junk" shapes.
 */
const seedArb: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    fc.dictionary(fc.string(), fc.anything()),
    fc.record(
      {
        name: fc.anything(),
        description: fc.anything(),
        hooks: fc.anything(),
      },
      { requiredKeys: [] },
    ),
  )
  .map(([base, owned]) => ({ ...base, ...owned }));

describe('Installer — property: mergeHooks overwrites owned fields (P2)', () => {
  it('name, description, and every owned hook trigger are always the constants', () => {
    /**
     * **Validates: Requirements 4.1, 4.2, 4.3, 4.5, 4.6**
     *
     * For any seed (regardless of what it carries at `name`, `description`,
     * or `hooks`) and any `HookTriggerMap`, `mergeHooks` must return an object
     * whose owned fields equal the constants — kiro-learn's name, the module
     * description constant, and the supplied triggers deep-copied into
     * `merged.hooks`. fast-check's shrinking produces fresh arbitraries each
     * iteration, so the seed cannot alias across runs.
     */
    fc.assert(
      fc.property(seedArb, hookTriggerMapArb, (seed, triggers) => {
        const merged = mergeHooks(seed, triggers);

        expect(merged['name']).toBe('kiro-learn');
        expect(merged['description']).toBe(KIRO_LEARN_DESCRIPTION);

        const mergedHooks = merged['hooks'] as Record<string, unknown>;
        for (const t of OWNED_TRIGGERS) {
          expect(mergedHooks[t]).toEqual(triggers[t]);
        }
      }),
    );
  });
});
