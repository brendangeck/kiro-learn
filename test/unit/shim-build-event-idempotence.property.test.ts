/**
 * Property-based test for `buildEvent` idempotence (Property 4).
 *
 * For any `EventBuildParams` against a fixed filesystem state, two
 * invocations of `buildEvent` produce events with equal `namespace`
 * fields. Consequently the `project_id` segment is also equal.
 *
 * This is a stronger restatement of the same-cwd determinism property
 * covered by `shim-namespace.property.test.ts`: here the two invocations
 * may vary every field of `EventBuildParams` (kind, body, sessionId,
 * parentEventId) — the only thing held constant is `cwd` and the
 * filesystem state under it. `namespace` depends only on the resolved
 * project root and the OS username, neither of which varies with the
 * other params, so the two events must share a namespace.
 *
 * **Feature: project-path-capture, Property 4: Idempotence**
 *
 * **Validates: Requirement 4.4**
 *
 * @see .kiro/specs/project-path-capture/design.md § Property 4
 * @see .kiro/specs/project-path-capture/tasks.md § Task 4.3
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpBase,
  };
});

const { buildEvent } = await import('../../src/shim/shared/index.js');

describe('Feature: project-path-capture, Property 4: Idempotence', () => {
  /**
   * Pool of real project directories planted under a mocked `$HOME`.
   *
   * `detectProjectRoot` walks upward from `cwd` bounded above by the
   * resolved `$HOME`, so the pool must live under the mocked ceiling
   * (otherwise every cwd collapses to the global sentinel). Each pool
   * directory gets its own `.git` marker so the walk terminates there
   * and a `src/` subdirectory so the property can also exercise cwds
   * strictly below the project root.
   */
  const projectRoots: string[] = [];
  const subdirs: string[] = [];
  const POOL_SIZE = 10;

  beforeAll(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'kiro-learn-idem-prop-'));
    for (let i = 0; i < POOL_SIZE; i++) {
      const root = mkdtempSync(join(tmpBase, `proj-${String(i)}-`));
      mkdirSync(join(root, '.git'));
      const sub = join(root, 'src');
      mkdirSync(sub);
      projectRoots.push(root);
      subdirs.push(sub);
    }
  });

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  /**
   * Generator for an `EventBuildParams`-shaped value.
   *
   * `cwd` is picked from the full pool (roots + subdirs) so the walk
   * sometimes starts at the project root and sometimes one level below.
   * Every other field varies independently — none of them should
   * influence the resulting `namespace`.
   */
  const paramsArb = (): fc.Arbitrary<{
    kind: 'prompt' | 'tool_use' | 'session_summary' | 'note';
    body:
      | { type: 'text'; content: string }
      | { type: 'json'; data: unknown };
    sessionId: string;
    parentEventId: string | undefined;
    cwdIndex: number;
  }> =>
    fc.record({
      kind: fc.constantFrom(
        'prompt' as const,
        'tool_use' as const,
        'session_summary' as const,
        'note' as const,
      ),
      body: fc.oneof(
        fc.record({
          type: fc.constant('text' as const),
          content: fc.string({ maxLength: 200 }),
        }),
        fc.record({
          type: fc.constant('json' as const),
          data: fc.jsonValue(),
        }),
      ),
      sessionId: fc
        .string({ minLength: 1, maxLength: 40 })
        .filter((s) => s.length > 0),
      parentEventId: fc.option(
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.length > 0),
        { nil: undefined },
      ),
      // Index into the combined [projectRoots, subdirs] list; the
      // property body resolves it to an actual path.
      cwdIndex: fc.integer({ min: 0, max: POOL_SIZE * 2 - 1 }),
    });

  it('two invocations with differing params but shared cwd yield equal namespaces', () => {
    /**
     * **Validates: Requirement 4.4**
     *
     * For any fixed `cwd` under a fixed filesystem state, `namespace`
     * depends only on the resolved project root and the OS username —
     * both invariants across `buildEvent` calls. The property draws two
     * independent `EventBuildParams` values that share a `cwd` (via the
     * same `cwdIndex`) but may differ in every other field, and asserts
     * `namespace` equality.
     */
    fc.assert(
      fc.property(paramsArb(), paramsArb(), (a, b) => {
        // Hold cwd constant between the two invocations. Everything
        // else is free to vary.
        const pool = [...projectRoots, ...subdirs];
        const cwd = pool[a.cwdIndex]!;

        const paramsA = {
          kind: a.kind,
          body: a.body,
          sessionId: a.sessionId,
          cwd,
          ...(a.parentEventId !== undefined
            ? { parentEventId: a.parentEventId }
            : {}),
        };
        const paramsB = {
          kind: b.kind,
          body: b.body,
          sessionId: b.sessionId,
          cwd,
          ...(b.parentEventId !== undefined
            ? { parentEventId: b.parentEventId }
            : {}),
        };

        const e1 = buildEvent(paramsA);
        const e2 = buildEvent(paramsB);

        expect(e1.namespace).toBe(e2.namespace);
      }),
      { numRuns: 25 },
    );
  });
});
