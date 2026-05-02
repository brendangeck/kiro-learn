/**
 * Fast-check arbitraries for the pure `transform()` function in
 * `ui/src/graph/transform.ts`.
 *
 * These are **UI-local** generators: the `MemoryRecord` shape the UI consumes
 * (from `ui/src/types/api.ts`) differs from the backend `MemoryRecord` in
 * `src/types/schemas.ts`, so we deliberately do not reuse
 * `test/helpers/arbitrary.ts` here. We only generate the fields the transform
 * actually reads — `record_id`, `namespace`, `title`, `concepts` — and pin
 * the remaining required fields to safe defaults that mirror the `mem()`
 * helper in `test/unit/cosmos-transform.test.ts`.
 *
 * @see .kiro/specs/cosmos-gl-graph/design.md § Correctness Properties
 */

import fc from 'fast-check';

import type {
  PackedTheme,
  ProjectInfo,
} from '../../ui/src/graph/transform.js';
import type { MemoryRecord } from '../../ui/src/types/api.js';

/** A short identifier-like string suitable for `record_id` or concept names. */
const idLikeArb = fc
  .stringMatching(/^[a-zA-Z0-9_]{1,20}$/)
  .filter((s) => s.length > 0);

/**
 * Namespace in the shape the transform expects: `/actor/a/project/<tail>/`.
 * The tail is kept short and slash-free so we generate a small pool of
 * namespaces, which is important for making project↔memory↔concept
 * co-location scenarios hit during property runs.
 */
export const namespaceArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-zA-Z0-9_]{1,20}$/)
  .filter((s) => s.length > 0)
  .map((s) => `/actor/a/project/${s}/`);

/** A short, non-empty concept string. */
export const conceptArb: fc.Arbitrary<string> = idLikeArb;

/** Minimal project-info arbitrary. */
export const projectInfoArb: fc.Arbitrary<ProjectInfo> = fc.record({
  namespace: namespaceArb,
  display_name: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.length > 0),
});

/**
 * Arbitrary UI-side `MemoryRecord`. Only the fields the transform reads
 * (`record_id`, `namespace`, `title`, `concepts`) vary; the others are
 * pinned to safe defaults identical to the `mem()` helper in the
 * example-based tests.
 */
export const memoryRecordArb: fc.Arbitrary<MemoryRecord> = fc
  .record({
    record_id: idLikeArb,
    namespace: namespaceArb,
    title: fc.string({ minLength: 0, maxLength: 120 }),
    concepts: fc.array(conceptArb, { minLength: 0, maxLength: 5 }),
  })
  .map(({ record_id, namespace, title, concepts }) => ({
    record_id,
    namespace,
    strategy: 'llm-summary',
    title,
    summary: 'summary',
    facts: [],
    source_event_ids: ['01TEST000000000000000000'],
    created_at: '2024-01-01T00:00:00Z',
    concepts,
    files_touched: [],
    observation_type: 'discovery' as const,
  }));

/**
 * Arbitrary list of memories, deduplicated by `record_id` so the transform's
 * `memory:${record_id}` node ids remain unique (mirroring the real-world
 * invariant that `record_id` is a primary key).
 */
export const memoryArrayArb: fc.Arbitrary<MemoryRecord[]> = fc
  .array(memoryRecordArb, { minLength: 0, maxLength: 8 })
  .map((ms) => {
    const seen = new Set<string>();
    const out: MemoryRecord[] = [];
    for (const m of ms) {
      if (seen.has(m.record_id)) continue;
      seen.add(m.record_id);
      out.push(m);
    }
    return out;
  });

/**
 * Arbitrary list of projects, deduplicated by `namespace` so the transform's
 * `project:${namespace}` node ids remain unique.
 */
export const projectArrayArb: fc.Arbitrary<ProjectInfo[]> = fc
  .array(projectInfoArb, { minLength: 0, maxLength: 4 })
  .map((ps) => {
    const seen = new Set<string>();
    const out: ProjectInfo[] = [];
    for (const p of ps) {
      if (seen.has(p.namespace)) continue;
      seen.add(p.namespace);
      out.push(p);
    }
    return out;
  });

/** Packed-theme arbitrary: four RGBA tuples plus a fixed hex background. */
export const packedThemeArb: fc.Arbitrary<PackedTheme> = fc.record({
  darkMode: fc.boolean(),
  projectFill: fc.tuple(
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.float({ min: 0, max: 1, noNaN: true }),
  ),
  memoryFill: fc.tuple(
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.float({ min: 0, max: 1, noNaN: true }),
  ),
  conceptFill: fc.tuple(
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.float({ min: 0, max: 1, noNaN: true }),
  ),
  edgeColor: fc.tuple(
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.float({ min: 0, max: 1, noNaN: true }),
    fc.float({ min: 0, max: 1, noNaN: true }),
  ),
  backgroundColor: fc.constant('#000000'),
});

/** Convenience record: a full `transform()` input tuple. */
export interface TransformInput {
  memories: MemoryRecord[];
  projects: ProjectInfo[];
  theme: PackedTheme;
}

/** Arbitrary `transform()` input tuple. */
export const transformInputArb: fc.Arbitrary<TransformInput> = fc.record({
  memories: memoryArrayArb,
  projects: projectArrayArb,
  theme: packedThemeArb,
});
