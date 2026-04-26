// Feature: default-equivalent-agent, Property 4: mergeHooks is deterministic and pure
/**
 * Property-based test: `mergeHooks` is deterministic and pure.
 *
 * For every validated Seed_Payload and every `HookTriggerMap`, invoking
 * `mergeHooks(seed, triggers)` twice must produce deep-equal outputs and
 * must not mutate `seed`. Additionally, the canonical JSON serialisation
 * (`JSON.stringify(merged, null, 2)`) must be byte-identical across the two
 * calls — this is the property the installer relies on when it writes the
 * merged result to disk: re-running `kiro-learn init` against an unchanged
 * `kiro_default` yields byte-for-byte equivalent files.
 *
 * **Validates: Requirement 7.3**
 *
 * @see .kiro/specs/default-equivalent-agent/design.md § Key Functions — mergeHooks
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { mergeHooks } from '../../src/installer/index.js';
import type {
  HookEntry,
  HookTriggerMap,
} from '../../src/installer/index.js';

/**
 * Arbitrary for a single `HookEntry`. Same shape as P2/P3: `.map` to omit
 * the `matcher` key entirely when undefined so the generated object is
 * exactly-assignable to `HookEntry` under `exactOptionalPropertyTypes`.
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
 * array of `HookEntry` values. Same shape as P2/P3.
 */
const hookTriggerMapArb: fc.Arbitrary<HookTriggerMap> = fc.record({
  agentSpawn: fc.array(hookEntryArb),
  userPromptSubmit: fc.array(hookEntryArb),
  postToolUse: fc.array(hookEntryArb),
  stop: fc.array(hookEntryArb),
});

/**
 * Arbitrary for a Seed_Payload-like object. For determinism/purity the
 * seed shape can be simpler than P3's preservation generator: any
 * JSON-serialisable dictionary exercises the invariant. We use
 * `fc.dictionary(fc.string(), fc.jsonValue())` so every generated value
 * round-trips cleanly through `JSON.stringify` — which matters because the
 * purity check compares `JSON.stringify(seed)` snapshots before and after
 * the mergeHooks calls.
 */
const seedArb: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string(),
  fc.jsonValue(),
);

describe('Installer — property: mergeHooks is deterministic and pure (P4)', () => {
  it('two calls produce deep-equal outputs, leave the seed unmutated, and serialise byte-identically', () => {
    /**
     * **Validates: Requirement 7.3**
     *
     * Snapshot the seed's JSON shape before the first call, invoke
     * `mergeHooks` twice, and assert three things:
     *
     *   1. The two merged objects deep-equal each other (determinism).
     *   2. The seed's JSON-serialised form is unchanged from the snapshot
     *      (purity — no mutation).
     *   3. `JSON.stringify(merged, null, 2)` is byte-identical across the
     *      two calls (byte-determinism — what the installer's write to
     *      disk relies on).
     */
    fc.assert(
      fc.property(seedArb, hookTriggerMapArb, (seed, triggers) => {
        const snapshot = JSON.stringify(seed);

        const merged1 = mergeHooks(seed, triggers);
        const merged2 = mergeHooks(seed, triggers);

        expect(merged1).toEqual(merged2);
        expect(JSON.stringify(seed)).toBe(snapshot);
        expect(JSON.stringify(merged1, null, 2)).toBe(
          JSON.stringify(merged2, null, 2),
        );
      }),
    );
  });
});
