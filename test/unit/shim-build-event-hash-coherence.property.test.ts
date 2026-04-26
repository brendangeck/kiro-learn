/**
 * Property-based test for `buildEvent` hash-preimage coherence (Property 5).
 *
 * For any event produced by `buildEvent`, the `project_id` segment of
 * `event.namespace` equals the lowercase hex SHA-256 of
 * `event.source.project_path`, and `event.source.project_path` starts
 * with the platform path separator (i.e. is an absolute path).
 *
 * This property is the visible consequence of two internal invariants:
 * 1. `buildEvent` hashes the same string it emits on `source.project_path`
 *    (Requirement 6.1 — `projectRoot === projectPath` by `detectProjectRoot`
 *    contract).
 * 2. `detectProjectRoot` only returns absolute paths — either a resolved
 *    project-marker directory, the resolved `$HOME` ceiling, or (on raw
 *    cwd fallback) whatever the caller passed. The property exercises
 *    the happy path where every cwd is a real, absolute directory under
 *    a mocked `$HOME`, so every returned `projectPath` is absolute.
 *
 * **Feature: project-path-capture, Property 5: Hash-preimage coherence**
 *
 * **Validates: Requirements 6.1, 6.3, 6.4**
 *
 * @see .kiro/specs/project-path-capture/design.md § Property 5
 * @see .kiro/specs/project-path-capture/tasks.md § Task 4.4
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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

/** Regex to extract the `project_id` hex segment from a namespace. */
const NAMESPACE_RE = /^\/actor\/[^/]+\/project\/([^/]+)\/$/;

describe('Feature: project-path-capture, Property 5: Hash-preimage coherence', () => {
  /**
   * Pool of real project directories planted under a mocked `$HOME`.
   *
   * Each pool directory gets its own `.git` marker so `detectProjectRoot`
   * terminates there. A `src/` subdirectory is also created so the
   * property exercises cwds strictly below the project root as well.
   */
  const projectRoots: string[] = [];
  const subdirs: string[] = [];
  const POOL_SIZE = 10;

  beforeAll(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'kiro-learn-hash-coh-prop-'));
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
   * Generator for `EventBuildParams`-shaped values. Every field varies
   * independently; `cwd` is picked from the combined root-and-subdir pool.
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
      cwdIndex: fc.integer({ min: 0, max: POOL_SIZE * 2 - 1 }),
    });

  it('project_id segment equals lowercase hex SHA-256 of source.project_path and project_path is absolute', () => {
    /**
     * **Validates: Requirements 6.1, 6.3, 6.4**
     *
     * - 6.1: `source.project_path` is the same resolved path used as the
     *   hash input for `project_id` — verified by recomputing the hash
     *   from the emitted path and comparing against the namespace segment.
     * - 6.3: No transformation is applied to `project_path` beyond
     *   `realpathSync` — verified indirectly: any extra normalisation
     *   would break the hash equality since the recomputed hash uses the
     *   emitted path verbatim.
     * - 6.4: `project_path` is always an absolute path — verified by
     *   asserting it starts with the platform path separator.
     */
    fc.assert(
      fc.property(paramsArb(), (p) => {
        const pool = [...projectRoots, ...subdirs];
        const cwd = pool[p.cwdIndex]!;

        const params = {
          kind: p.kind,
          body: p.body,
          sessionId: p.sessionId,
          cwd,
          ...(p.parentEventId !== undefined
            ? { parentEventId: p.parentEventId }
            : {}),
        };

        const event = buildEvent(params);

        // Extract the project_id hex from the namespace.
        const match = NAMESPACE_RE.exec(event.namespace);
        expect(match).not.toBeNull();
        const projectIdFromNamespace = match![1]!;

        // Recompute the hash from the emitted preimage.
        const projectPath = event.source.project_path;
        expect(typeof projectPath).toBe('string');
        const recomputedProjectId = createHash('sha256')
          .update(projectPath as string)
          .digest('hex');

        // Requirement 6.1: hash equality.
        expect(projectIdFromNamespace).toBe(recomputedProjectId);

        // Lowercase hex sanity check (64 chars).
        expect(recomputedProjectId).toMatch(/^[0-9a-f]{64}$/);

        // Requirement 6.4: project_path is absolute. Use
        // `path.isAbsolute` so the assertion is correct on every
        // platform — on Windows a path like `C:\foo` is absolute but
        // does not start with `sep` (`\\`), and `startsWith(sep)`
        // would miss it.
        expect(isAbsolute(projectPath as string)).toBe(true);
      }),
      { numRuns: 25 },
    );
  });
});
