// Feature: default-equivalent-agent, Property 3: mergeHooks preserves non-owned fields
/**
 * Property-based test: `mergeHooks` preserves non-owned fields.
 *
 * For every validated Seed_Payload and every `HookTriggerMap`, the merged
 * output must carry every top-level key outside `{name, description, hooks}`
 * verbatim from the seed, and every hook trigger inside `seed.hooks` that is
 * not an owned trigger must also survive verbatim. This is the mirror image
 * of Property 2 (which covers what gets overwritten): P3 pins down what must
 * not change.
 *
 * **Validates: Requirements 4.4, 4.7, 3.5**
 *
 * @see .kiro/specs/default-equivalent-agent/design.md § Key Functions — mergeHooks
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { mergeHooks, OWNED_TRIGGERS } from '../../src/installer/index.js';
import type {
  HookEntry,
  HookTriggerMap,
} from '../../src/installer/index.js';

/**
 * Set of owned top-level keys mergeHooks overwrites. Anything else the seed
 * carries must be preserved.
 */
const OWNED_TOP_LEVEL = new Set(['name', 'description', 'hooks']);

/**
 * Arbitrary for a single `HookEntry`. Same pattern as the P2 test: `.map`
 * to omit the `matcher` key entirely when undefined so the generated object
 * is exactly-assignable to `HookEntry` under `exactOptionalPropertyTypes`.
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
 * Arbitrary for a `HookTriggerMap` — the four owned keys each bound to an
 * array of `HookEntry` values. Same shape as P2.
 */
const hookTriggerMapArb: fc.Arbitrary<HookTriggerMap> = fc.record({
  agentSpawn: fc.array(hookEntryArb),
  userPromptSubmit: fc.array(hookEntryArb),
  postToolUse: fc.array(hookEntryArb),
  stop: fc.array(hookEntryArb),
});

/**
 * Arbitrary for a non-owned hook trigger name — any non-empty string that
 * is not one of the four owned triggers. Includes realistic wrong-triggers
 * like `preToolUse` / `preAgentSpawn` via ordinary string generation plus
 * an explicit oneof to make sure those hit the property regularly.
 */
const nonOwnedTriggerNameArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('preToolUse', 'preAgentSpawn', 'sessionStart', 'custom'),
  fc
    .string({ minLength: 1 })
    .filter(
      (k): k is string =>
        !(OWNED_TRIGGERS as readonly string[]).includes(k),
    ),
);

/**
 * Arbitrary for `seed.hooks` — a dictionary keyed by non-owned trigger
 * names, each bound to an array of HookEntry-shaped values. Using
 * `fc.jsonValue()` for the entry values would drift from HookEntry's
 * shape; reusing `hookEntryArb` keeps each preserved entry trivially
 * JSON-serialisable and deep-equal-comparable via `toEqual`.
 */
const seedHooksArb: fc.Arbitrary<Record<string, HookEntry[]>> = fc.dictionary(
  nonOwnedTriggerNameArb,
  fc.array(hookEntryArb),
);

/**
 * Arbitrary for a non-owned top-level key — any non-empty string that is
 * not `name`, `description`, or `hooks`.
 */
const nonOwnedTopLevelKeyArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1 })
  .filter((k): k is string => !OWNED_TOP_LEVEL.has(k));

/**
 * Arbitrary for a Seed_Payload-like object that definitely sprinkles
 * non-owned top-level keys and non-owned hook triggers, so the preservation
 * invariant is actually exercised every iteration. `fc.jsonValue()` (rather
 * than `fc.anything()`) keeps values JSON-serialisable so the deep-equality
 * checks via `toEqual` are well-defined.
 *
 * Composition:
 *   - `base`: dictionary of non-owned top-level keys → jsonValue. This is
 *     the payload that must survive verbatim.
 *   - `owned`: optional `name`, `description`, and `hooks` (with arbitrary
 *     values) layered on top. Mirrors the "present with arbitrary junk"
 *     cases exercised in P2 so the overwrite branch still fires. `hooks` is
 *     drawn from `seedHooksArb` so — when present — it carries non-owned
 *     triggers whose preservation is the second half of the property.
 */
const seedArb: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    fc.dictionary(nonOwnedTopLevelKeyArb, fc.jsonValue()),
    fc.record(
      {
        name: fc.jsonValue(),
        description: fc.jsonValue(),
        hooks: seedHooksArb,
      },
      { requiredKeys: [] },
    ),
  )
  .map(([base, owned]) => ({ ...base, ...owned }));

describe('Installer — property: mergeHooks preserves non-owned fields (P3)', () => {
  it('every non-owned top-level key and every non-owned hook trigger survives verbatim', () => {
    /**
     * **Validates: Requirements 4.4, 4.7, 3.5**
     *
     * For any seed and any `HookTriggerMap`, the merged output's top-level
     * keys outside `{name, description, hooks}` must deep-equal the seed's
     * values at those keys, and — when `seed.hooks` is a plain object — its
     * non-owned trigger entries must deep-equal the seed's entries at those
     * keys. The seed-hooks-is-not-a-plain-object branch is covered by P2
     * and the unit tests; P3 intentionally only speaks to the plain-object
     * case so the invariant it asserts is never vacuous in a misleading way.
     */
    fc.assert(
      fc.property(seedArb, hookTriggerMapArb, (seed, triggers) => {
        const merged = mergeHooks(seed, triggers);

        // Every non-owned top-level key must round-trip deep-equal.
        for (const k of Object.keys(seed)) {
          if (OWNED_TOP_LEVEL.has(k)) continue;
          expect(merged[k]).toEqual(seed[k]);
        }

        // Non-owned hook triggers must also round-trip deep-equal, but only
        // when the seed's `hooks` is a plain object. If it isn't,
        // mergeHooks coerces to `{}` (covered by P2); this clause is then
        // vacuous and we skip it.
        const seedHooks = seed['hooks'];
        const seedHooksIsPlainObject =
          seedHooks !== null &&
          typeof seedHooks === 'object' &&
          !Array.isArray(seedHooks);
        if (!seedHooksIsPlainObject) return;

        const mergedHooks = merged['hooks'] as Record<string, unknown>;
        const seedHooksObj = seedHooks as Record<string, unknown>;
        for (const u of Object.keys(seedHooksObj)) {
          if ((OWNED_TRIGGERS as readonly string[]).includes(u)) continue;
          expect(mergedHooks[u]).toEqual(seedHooksObj[u]);
        }
      }),
    );
  });
});
