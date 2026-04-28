/**
 * Fast-check arbitraries for the kiro-learn wire contract.
 *
 * These generators produce values that satisfy the Zod schemas in
 * `src/types/schemas.ts`. They are used by property-based tests to exercise
 * `parseEvent` / `parseMemoryRecord` and (in later tasks) the SQLite backend.
 *
 * Every generator here is the **positive** side of the schema: the output is
 * always valid. Tests that need invalid inputs mutate the output afterwards.
 *
 * @see .kiro/specs/event-schema-and-storage/design.md § Zod Schemas
 * @see .kiro/specs/event-schema-and-storage/requirements.md § Requirement 2
 */

import fc from 'fast-check';

import { OBSERVATION_TYPES } from '../../src/types/schemas.js';
import type { KiroMemEvent, MemoryRecord } from '../../src/types/schemas.js';
import type { StatsResult, ProjectInfo } from '../../src/types/index.js';

/** Crockford base32 alphabet used in ULIDs (no I, L, O, U). */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_ALPHABET_LEN = ULID_ALPHABET.length;

/** Lowercase hex digits for sha256 content hashes. */
const HEX_ALPHABET = '0123456789abcdef';
const HEX_ALPHABET_LEN = HEX_ALPHABET.length;

/**
 * Arbitrary 26-character Crockford base32 ULID matching `ULID_RE`.
 *
 * Implemented by picking 26 indices into the explicit alphabet rather than
 * relying on `fc.stringMatching`, to keep the generator deterministic and
 * dependency-free.
 */
export function ulidArb(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0, max: ULID_ALPHABET_LEN - 1 }), {
      minLength: 26,
      maxLength: 26,
    })
    .map((indices) => {
      let out = '';
      for (const i of indices) {
        // `noUncheckedIndexedAccess` makes this `string | undefined`; the
        // generator bounds guarantee it is defined, but we guard to keep
        // the type-checker honest.
        const ch = ULID_ALPHABET[i];
        if (ch === undefined) {
          throw new Error(`ulidArb: alphabet index out of range: ${String(i)}`);
        }
        out += ch;
      }
      return out;
    });
}

/** Arbitrary `mr_<ULID>` record id matching `RECORD_ID_RE`. */
export function recordIdArb(): fc.Arbitrary<string> {
  return ulidArb().map((ulid) => `mr_${ulid}`);
}

/**
 * Arbitrary non-empty segment for `namespace`. No `/`, printable ASCII, and
 * small so the full namespace stays readable in test output.
 */
function namespaceSegmentArb(): fc.Arbitrary<string> {
  return fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((s) => s.length > 0 && !s.includes('/'));
}

/**
 * Arbitrary namespace of the form `/actor/{actor}/project/{project}/`
 * matching `NAMESPACE_RE`.
 */
export function namespaceArb(): fc.Arbitrary<string> {
  return fc
    .tuple(namespaceSegmentArb(), namespaceSegmentArb())
    .map(([actor, project]) => `/actor/${actor}/project/${project}/`);
}

/**
 * Arbitrary ISO-8601 timestamp with offset (`Z`) accepted by
 * `z.string().datetime({ offset: true })`. Bounded to a plausible decade so
 * shrinking stays useful.
 */
export function isoDateArb(): fc.Arbitrary<string> {
  return fc
    .date({
      min: new Date('2020-01-01T00:00:00Z'),
      max: new Date('2030-01-01T00:00:00Z'),
      noInvalidDate: true,
    })
    .map((d) => d.toISOString());
}

/** Arbitrary `EventSource` value. */
export function eventSourceArb(): fc.Arbitrary<{
  surface: 'kiro-cli' | 'kiro-ide';
  version: string;
  client_id: string;
}> {
  return fc.record({
    surface: fc.constantFrom('kiro-cli' as const, 'kiro-ide' as const),
    version: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.length > 0),
    client_id: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.length > 0),
  });
}

/** Arbitrary text body. Content is capped well below the 1 MiB schema limit. */
function textBodyArb(): fc.Arbitrary<{ type: 'text'; content: string }> {
  return fc.record({
    type: fc.constant('text' as const),
    content: fc.string({ maxLength: 1000 }),
  });
}

/** Arbitrary message body: 1–5 role/content turns. */
function messageBodyArb(): fc.Arbitrary<{
  type: 'message';
  turns: Array<{ role: string; content: string }>;
}> {
  return fc.record({
    type: fc.constant('message' as const),
    turns: fc.array(
      fc.record({
        role: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.length > 0),
        content: fc.string({ maxLength: 500 }),
      }),
      { minLength: 1, maxLength: 5 },
    ),
  });
}

/**
 * Arbitrary json body. `data` is any JSON-representable value.
 *
 * `fc.jsonValue()` may yield `-0`, which the wire contract cannot
 * preserve: `JSON.stringify(-0)` is `'0'`, so a round-trip through the
 * SQLite backend (which serialises `body` via `JSON.stringify` and
 * deserialises via `JSON.parse`) returns `0`, not `-0`. That breaks the
 * P1 round-trip property (`test/sqlite-backend.property.test.ts`) on the
 * occasional iteration where fast-check shrinks into a `-0` leaf.
 *
 * We normalise `-0` → `0` post-generation to sidestep the issue. This
 * matches the actual on-wire behaviour: every other caller on the write
 * path (collector pipeline, storage backend, enrichment) observes the
 * `JSON.stringify` normalisation too, so fixing the generator — rather
 * than relaxing the property — keeps both ends of the contract honest.
 */
function jsonBodyArb(): fc.Arbitrary<{ type: 'json'; data: unknown }> {
  return fc.record({
    type: fc.constant('json' as const),
    data: fc.jsonValue().map(normaliseJsonValue),
  });
}

/**
 * Recursively replace `-0` with `0` inside a JSON-representable value so
 * the output matches what `JSON.parse(JSON.stringify(value))` would
 * produce. No other transformations — every other value JSON can encode
 * round-trips unchanged.
 */
function normaliseJsonValue(value: unknown): unknown {
  if (typeof value === 'number' && Object.is(value, -0)) {
    return 0;
  }
  if (Array.isArray(value)) {
    return value.map(normaliseJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => [k, normaliseJsonValue(v)] as const,
    );
    return Object.fromEntries(entries);
  }
  return value;
}

/** Arbitrary `EventBody` across all three variants. */
export function eventBodyArb(): fc.Arbitrary<
  | { type: 'text'; content: string }
  | { type: 'message'; turns: Array<{ role: string; content: string }> }
  | { type: 'json'; data: unknown }
> {
  return fc.oneof(textBodyArb(), messageBodyArb(), jsonBodyArb());
}

/** Arbitrary `sha256:<64-hex>` content hash matching `CONTENT_HASH_RE`. */
export function contentHashArb(): fc.Arbitrary<string> {
  return fc
    .array(fc.integer({ min: 0, max: HEX_ALPHABET_LEN - 1 }), {
      minLength: 64,
      maxLength: 64,
    })
    .map((indices) => {
      let hex = '';
      for (const i of indices) {
        const ch = HEX_ALPHABET[i];
        if (ch === undefined) {
          throw new Error(`contentHashArb: hex index out of range: ${String(i)}`);
        }
        hex += ch;
      }
      return `sha256:${hex}`;
    });
}

/** Arbitrary non-empty id string (≤ 128 chars) for `session_id` / `actor_id`. */
function boundedIdArb(): fc.Arbitrary<string> {
  return fc.string({ minLength: 1, maxLength: 128 }).filter((s) => s.length > 0);
}

/**
 * Arbitrary `project_path` value matching the `EventSource.project_path`
 * schema bounds: any string of length 1–2048. No structural constraint —
 * the field is a carrier, not a pattern (per Requirement 5.6).
 *
 * @see .kiro/specs/project-path-capture/requirements.md § Requirement 5.2
 * @see .kiro/specs/project-path-capture/design.md § Test helper extensions
 */
export function projectPathArb(): fc.Arbitrary<string> {
  return fc.string({ minLength: 1, maxLength: 2048 }).filter((s) => s.length > 0);
}

/** Arbitrary `EventKind`. */
function kindArb(): fc.Arbitrary<KiroMemEvent['kind']> {
  return fc.constantFrom(
    'prompt' as const,
    'tool_use' as const,
    'session_summary' as const,
    'note' as const,
  );
}

/**
 * Arbitrary valid `KiroMemEvent`.
 *
 * Produces events both with and without `parent_event_id` and `content_hash`
 * so `fc.option` handles the optionality. Optional fields are added to the
 * output only when they are defined, so the shape satisfies the
 * `exactOptionalPropertyTypes` rule in tsconfig.
 */
export function arbitraryEvent(): fc.Arbitrary<KiroMemEvent> {
  return fc
    .record({
      event_id: ulidArb(),
      parent_event_id: fc.option(ulidArb(), { nil: undefined }),
      session_id: boundedIdArb(),
      actor_id: boundedIdArb(),
      namespace: namespaceArb(),
      kind: kindArb(),
      body: eventBodyArb(),
      valid_time: isoDateArb(),
      source: eventSourceArb(),
      content_hash: fc.option(contentHashArb(), { nil: undefined }),
    })
    .map((r) => {
      const e: KiroMemEvent = {
        event_id: r.event_id,
        session_id: r.session_id,
        actor_id: r.actor_id,
        namespace: r.namespace,
        schema_version: 1,
        kind: r.kind,
        body: r.body,
        valid_time: r.valid_time,
        source: r.source,
      };
      if (r.parent_event_id !== undefined) {
        return { ...e, parent_event_id: r.parent_event_id };
      }
      return e;
    })
    .chain((e) =>
      // Second `chain` step attaches `content_hash` conditionally so the
      // final object only carries the key when a value was generated. This
      // preserves `exactOptionalPropertyTypes` compliance.
      fc.option(contentHashArb(), { nil: undefined }).map((hash) =>
        hash === undefined ? e : { ...e, content_hash: hash },
      ),
    )
    .chain((e) =>
      // Third `chain` step attaches `source.project_path` conditionally.
      // When the option resolves to a string, it is spread into a new
      // `source` object; when it resolves to `undefined`, the event is
      // returned unchanged so the key stays absent (not
      // `project_path: undefined`) under `exactOptionalPropertyTypes`.
      fc.option(projectPathArb(), { nil: undefined }).map((pp) =>
        pp === undefined ? e : { ...e, source: { ...e.source, project_path: pp } },
      ),
    );
}

/** Arbitrary non-empty bounded strategy name. */
function strategyArb(): fc.Arbitrary<string> {
  return fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.length > 0);
}

/**
 * Arbitrary valid `MemoryRecord`. Exported so the PBT in task 2.6 can reuse
 * it. Not required for task 2.3 but lives here to keep all arbitraries in one
 * module.
 */
export function arbitraryMemoryRecord(): fc.Arbitrary<MemoryRecord> {
  return fc.record({
    record_id: recordIdArb(),
    namespace: namespaceArb(),
    strategy: strategyArb(),
    title: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.length > 0),
    summary: fc.string({ minLength: 1, maxLength: 4000 }).filter((s) => s.length > 0),
    facts: fc.array(
      fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.length > 0),
      { minLength: 0, maxLength: 10 },
    ),
    source_event_ids: fc.array(ulidArb(), { minLength: 1, maxLength: 5 }),
    created_at: isoDateArb(),
    concepts: fc.array(
      fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.length > 0),
      { minLength: 0, maxLength: 10 },
    ),
    files_touched: fc.array(
      fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.length > 0),
      { minLength: 0, maxLength: 10 },
    ),
    observation_type: fc.constantFrom(...OBSERVATION_TYPES),
  });
}

// ── Read-API type generators (visualizer-read-api Task 9.1) ────────────

/** Known observation types used in `StatsResult.observation_types`. */
const STATS_OBSERVATION_TYPES = [
  'tool_use',
  'decision',
  'error',
  'discovery',
  'pattern',
] as const;

/** Known event kinds used in `StatsResult.event_kinds`. */
const STATS_EVENT_KINDS = [
  'prompt',
  'tool_use',
  'session_summary',
  'note',
] as const;

/**
 * Arbitrary valid `StatsResult` with reasonable random values.
 *
 * Generates non-negative integer counts and breakdowns by observation type
 * and event kind. Each breakdown key maps to a non-negative count.
 *
 * @see .kiro/specs/visualizer-read-api/requirements.md § N11
 */
export function arbitraryStatsResult(): fc.Arbitrary<StatsResult> {
  const countArb = fc.nat({ max: 10000 });

  const observationTypesArb = fc
    .tuple(...STATS_OBSERVATION_TYPES.map(() => countArb))
    .map((counts) => {
      const record: Record<string, number> = {};
      for (let i = 0; i < STATS_OBSERVATION_TYPES.length; i++) {
        const key = STATS_OBSERVATION_TYPES[i];
        const val = counts[i];
        if (key !== undefined && val !== undefined) {
          record[key] = val;
        }
      }
      return record;
    });

  const eventKindsArb = fc
    .tuple(...STATS_EVENT_KINDS.map(() => countArb))
    .map((counts) => {
      const record: Record<string, number> = {};
      for (let i = 0; i < STATS_EVENT_KINDS.length; i++) {
        const key = STATS_EVENT_KINDS[i];
        const val = counts[i];
        if (key !== undefined && val !== undefined) {
          record[key] = val;
        }
      }
      return record;
    });

  return fc.record({
    total_events: countArb,
    total_memories: countArb,
    total_projects: countArb,
    total_concepts: countArb,
    observation_types: observationTypesArb,
    event_kinds: eventKindsArb,
  });
}

/**
 * Arbitrary valid `ProjectInfo` with reasonable random values.
 *
 * Uses {@link namespaceArb} for the namespace and {@link projectPathArb}
 * for the optional project path. Counts are non-negative integers.
 *
 * @see .kiro/specs/visualizer-read-api/requirements.md § N11
 */
export function arbitraryProjectInfo(): fc.Arbitrary<ProjectInfo> {
  return fc.record({
    namespace: namespaceArb(),
    project_path: fc.option(projectPathArb(), { nil: null }),
    event_count: fc.nat({ max: 10000 }),
    memory_count: fc.nat({ max: 10000 }),
  });
}

// ── Private-span generators (Task 2.6) ─────────────────────────────────

/**
 * Arbitrary string containing `<private>...</private>` spans.
 *
 * Generates three variants:
 * - **simple**: `<private>secret</private>`
 * - **nested**: `<private>outer <private>inner</private> more</private>`
 * - **unclosed**: `<private>secret with no close tag`
 *
 * The inner content and surrounding text are arbitrary strings that never
 * contain the literal `<private>` or `</private>` substrings themselves,
 * so the injected tags are the only ones present.
 */
function privateSpanArb(): fc.Arbitrary<string> {
  /** Safe content that does not contain private tags. */
  const safeStr = fc
    .string({ maxLength: 50 })
    .map((s) => s.replace(/<\/?private>/g, ''));

  const simple = fc
    .tuple(safeStr, safeStr, safeStr)
    .map(([before, secret, after]) => `${before}<private>${secret}</private>${after}`);

  const nested = fc
    .tuple(safeStr, safeStr, safeStr, safeStr)
    .map(
      ([before, outer, inner, after]) =>
        `${before}<private>${outer}<private>${inner}</private>${outer}</private>${after}`,
    );

  const unclosed = fc
    .tuple(safeStr, safeStr)
    .map(([before, secret]) => `${before}<private>${secret}`);

  return fc.oneof(simple, nested, unclosed);
}

/**
 * Arbitrary text body with `<private>` spans injected into `content`.
 */
function textBodyWithPrivateArb(): fc.Arbitrary<{ type: 'text'; content: string }> {
  return fc.record({
    type: fc.constant('text' as const),
    content: privateSpanArb(),
  });
}

/**
 * Arbitrary message body with `<private>` spans injected into at least one
 * turn's `content`.
 */
function messageBodyWithPrivateArb(): fc.Arbitrary<{
  type: 'message';
  turns: Array<{ role: string; content: string }>;
}> {
  return fc.record({
    type: fc.constant('message' as const),
    turns: fc.array(
      fc.record({
        role: fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.length > 0),
        content: privateSpanArb(),
      }),
      { minLength: 1, maxLength: 5 },
    ),
  });
}

/**
 * Arbitrary json body with `<private>` spans injected into string values.
 *
 * Generates a small object/array tree where every string leaf contains a
 * private span, ensuring the recursive walk is exercised.
 */
function jsonBodyWithPrivateArb(): fc.Arbitrary<{ type: 'json'; data: unknown }> {
  // Build a small JSON-like tree where string leaves contain private spans.
  const leaf = privateSpanArb();
  const jsonData: fc.Arbitrary<unknown> = fc.oneof(
    leaf,
    fc.array(leaf, { minLength: 1, maxLength: 3 }),
    fc.dictionary(
      fc.string({ minLength: 1, maxLength: 10 }).filter((s) => s.length > 0),
      leaf,
      { minKeys: 1, maxKeys: 3 },
    ),
  );

  return fc.record({
    type: fc.constant('json' as const),
    data: jsonData,
  });
}

/** Arbitrary `EventBody` with `<private>` spans across all three variants. */
function eventBodyWithPrivateArb(): fc.Arbitrary<
  | { type: 'text'; content: string }
  | { type: 'message'; turns: Array<{ role: string; content: string }> }
  | { type: 'json'; data: unknown }
> {
  return fc.oneof(
    textBodyWithPrivateArb(),
    messageBodyWithPrivateArb(),
    jsonBodyWithPrivateArb(),
  );
}

/**
 * Arbitrary valid `KiroMemEvent` with `<private>...</private>` spans
 * injected into the body content.
 *
 * Uses {@link arbitraryEvent} as a structural base and replaces the body
 * with one that contains private spans (simple, nested, or unclosed) for
 * all three body types (`text`, `message`, `json`).
 *
 * @see .kiro/specs/collector-pipeline/design.md § Property 1
 * @see .kiro/specs/collector-pipeline/tasks.md § Task 2.6
 */
export function arbitraryEventWithPrivateSpans(): fc.Arbitrary<KiroMemEvent> {
  return arbitraryEvent().chain((event) =>
    eventBodyWithPrivateArb().map((body) => ({ ...event, body })),
  );
}

// ── Clean-event generator (Task 2.9) ───────────────────────────────────

/**
 * Strip all occurrences of `<private>` from a string so it is guaranteed
 * clean. Also strips `</private>` for completeness.
 */
function stripPrivateTags(s: string): string {
  return s.replace(/<\/?private>/g, '');
}

/**
 * Recursively strip `<private>` / `</private>` substrings from every
 * string leaf inside a JSON-representable value.
 */
function stripPrivateFromJson(value: unknown): unknown {
  if (typeof value === 'string') {
    return stripPrivateTags(value);
  }
  if (Array.isArray(value)) {
    return value.map(stripPrivateFromJson);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => [stripPrivateTags(k), stripPrivateFromJson(v)] as const,
    );
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Arbitrary valid `KiroMemEvent` whose body contains **no** occurrence of
 * the substring `<private>`. Built from {@link arbitraryEvent} with a
 * `.map()` pass that strips any accidental `<private>` / `</private>`
 * substrings from generated string fields.
 *
 * @see .kiro/specs/collector-pipeline/design.md § Property 4
 * @see .kiro/specs/collector-pipeline/tasks.md § Task 2.9
 */
export function arbitraryCleanEvent(): fc.Arbitrary<KiroMemEvent> {
  return arbitraryEvent().map((event) => {
    const body = event.body;
    let cleanBody: KiroMemEvent['body'];

    switch (body.type) {
      case 'text': {
        cleanBody = { ...body, content: stripPrivateTags(body.content) };
        break;
      }
      case 'message': {
        cleanBody = {
          ...body,
          turns: body.turns.map((turn) => ({
            ...turn,
            content: stripPrivateTags(turn.content),
          })),
        };
        break;
      }
      case 'json': {
        cleanBody = { ...body, data: stripPrivateFromJson(body.data) };
        break;
      }
    }

    return { ...event, body: cleanBody };
  });
}

// ── fs-tree generators for shim walk properties (Task 2.3) ─────────────

/**
 * The 15 project markers the shim walk checks at every directory, in the
 * exact order used by `src/installer/index.ts`. Duplicated here (at the
 * test layer) so the generators don't need to import production code —
 * the shim's own module will be checked for marker-list parity by the
 * example test `shim-project-markers-match-installer.test.ts` (Task 3.6).
 *
 * @see .kiro/specs/project-path-capture/design.md § Shim — Marker Walk
 */
const FS_TREE_PROJECT_MARKERS = [
  '.kiro',
  '.git',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'deno.json',
  'deno.jsonc',
] as const;

/**
 * Descriptor tuple emitted by {@link arbitraryFsTreeWithMarker} and
 * {@link arbitraryFsTreeNoMarker}. Callers map the descriptor onto either
 * a real temp directory (via `mkdtempSync`) or a stubbed
 * `existsSync`/`realpathSync`; the generator itself is data-only.
 *
 * All paths are POSIX-style (`/` separator) and absolute. `home` is a
 * mocked `$HOME` — an absolute path under a neutral root like `/mock-home`.
 * `projectRoot` is the directory where a marker is planted (or equal to
 * `home` when `marker === null`). `cwd` is at or below `projectRoot`.
 */
export interface FsTreeDescriptor {
  /** Absolute POSIX path acting as the mocked `$HOME` walk ceiling. */
  home: string;
  /**
   * Expected `projectRoot` result for this tree.
   *
   * - When `marker` is non-null, this is the directory containing the
   *   marker — always a strict descendant of `home`.
   * - When `marker` is `null`, this equals `home` (global-sentinel case).
   */
  projectRoot: string;
  /** Absolute POSIX path of the walk start. Always at or below `projectRoot`. */
  cwd: string;
  /**
   * The marker filename planted at `projectRoot`, or `null` for the
   * no-marker case. Drawn from the same 15-element list the shim uses.
   */
  marker: string | null;
}

/**
 * Arbitrary short, filesystem-safe directory segment. No `/`, no dots,
 * only lowercase letters and digits, 1–8 characters. Avoids collisions
 * with the marker filenames (which all contain a `.` or an uppercase
 * letter) so a generated walk segment cannot accidentally look like a
 * marker to downstream test code.
 */
function fsSegmentArb(): fc.Arbitrary<string> {
  return fc
    .stringMatching(/^[a-z0-9]{1,8}$/)
    .filter((s) => s.length >= 1 && s.length <= 8);
}

/** Join absolute POSIX path segments with `/`. */
function joinPosix(base: string, segments: readonly string[]): string {
  if (segments.length === 0) return base;
  const suffix = segments.join('/');
  return base.endsWith('/') ? `${base}${suffix}` : `${base}/${suffix}`;
}

/**
 * Arbitrary fs-tree descriptor with exactly one marker planted at a
 * random depth under the mocked `$HOME`.
 *
 * The tuple guarantees:
 *
 * - `home` is an absolute POSIX path acting as the walk ceiling.
 * - `projectRoot` is a strict descendant of `home` (depth 1..4 below).
 * - `cwd` is at or below `projectRoot` (0..4 extra levels deep).
 * - `marker` is one of the 15 shim project markers.
 * - No marker sits strictly between `cwd` and `projectRoot`: the
 *   generator places exactly one marker at `projectRoot`. Test code
 *   that realises the tree onto a filesystem (or a stubbed
 *   `existsSync`) is responsible for leaving every other directory
 *   marker-free.
 *
 * Drives Property 1 (walk finds the nearest marker-bearing ancestor).
 *
 * @see .kiro/specs/project-path-capture/design.md § Property 1
 * @see .kiro/specs/project-path-capture/requirements.md § N13
 */
export function arbitraryFsTreeWithMarker(): fc.Arbitrary<FsTreeDescriptor> {
  return fc
    .record({
      homeSegment: fsSegmentArb(),
      // Between `home` and `projectRoot`: 0..3 intermediate segments,
      // plus the `projectRoot` segment itself (enforced via minLength=1).
      // This makes `projectRoot` strictly deeper than `home`.
      rootPath: fc.array(fsSegmentArb(), { minLength: 1, maxLength: 4 }),
      // Between `projectRoot` and `cwd`: 0..4 extra segments (cwd may
      // equal projectRoot when this array is empty).
      cwdTail: fc.array(fsSegmentArb(), { minLength: 0, maxLength: 4 }),
      marker: fc.constantFrom(...FS_TREE_PROJECT_MARKERS),
    })
    .map(({ homeSegment, rootPath, cwdTail, marker }) => {
      const home = `/mock-home/${homeSegment}`;
      const projectRoot = joinPosix(home, rootPath);
      const cwd = joinPosix(projectRoot, cwdTail);
      return { home, projectRoot, cwd, marker };
    });
}

/**
 * Arbitrary fs-tree descriptor with no markers anywhere between `cwd` and
 * the mocked `$HOME` ceiling.
 *
 * The tuple guarantees:
 *
 * - `home` is an absolute POSIX path acting as the walk ceiling.
 * - `cwd` is a strict descendant of `home` (depth 1..6 below).
 * - `projectRoot === home` — the expected result of `detectProjectRoot`
 *   for a marker-free tree is the global sentinel.
 * - `marker === null` — no marker is planted. Test code that realises
 *   the tree onto a filesystem (or a stubbed `existsSync`) must leave
 *   every directory on the cwd→home chain marker-free.
 *
 * Drives Property 2 (global sentinel fallback).
 *
 * @see .kiro/specs/project-path-capture/design.md § Property 2
 * @see .kiro/specs/project-path-capture/requirements.md § N13
 */
export function arbitraryFsTreeNoMarker(): fc.Arbitrary<FsTreeDescriptor> {
  return fc
    .record({
      homeSegment: fsSegmentArb(),
      // `cwd` must be a strict descendant of `home`; require at least
      // one segment so `cwd !== home`.
      cwdPath: fc.array(fsSegmentArb(), { minLength: 1, maxLength: 6 }),
    })
    .map(({ homeSegment, cwdPath }) => {
      const home = `/mock-home/${homeSegment}`;
      const cwd = joinPosix(home, cwdPath);
      return { home, projectRoot: home, cwd, marker: null };
    });
}

// ── URL path generators for static-handler property tests (Task 7.1) ───

/**
 * Common file extensions produced by Vite builds and referenced in
 * `MIME_TABLE`. Used by sub-generators that need paths with extensions.
 */
const ASSET_EXTENSIONS = [
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.svg',
  '.png',
  '.ico',
  '.woff',
  '.woff2',
  '.map',
] as const;

/**
 * Arbitrary safe path segment: 1–12 lowercase alphanumeric characters.
 * No `/`, no `.`, no special characters — just a clean directory or
 * filename component.
 */
function urlSegmentArb(): fc.Arbitrary<string> {
  return fc
    .stringMatching(/^[a-z0-9]{1,12}$/)
    .filter((s) => s.length >= 1 && s.length <= 12);
}

/**
 * Arbitrary URL path containing `..` traversal segments.
 *
 * Generates paths like `/../../../etc/passwd`, `/assets/../../secret`,
 * and `/..` to exercise the path-traversal containment logic.
 */
function traversalPathArb(): fc.Arbitrary<string> {
  return fc
    .tuple(
      // Generate 0–5 segments that may or may not be '..'
      fc.array(urlSegmentArb(), { minLength: 0, maxLength: 5 }),
      // Pick a random index to force a '..' into
      fc.nat(),
      fc.option(urlSegmentArb(), { nil: undefined }),
    )
    .chain(([otherSegments, insertIdx, tail]) => {
      // Insert a guaranteed '..' at a random position
      const idx = otherSegments.length === 0 ? 0 : insertIdx % (otherSegments.length + 1);
      const segments = [...otherSegments];
      segments.splice(idx, 0, '..');

      return fc.tuple(...segments.map((s) => fc.constant(s))).map((segs) => {
        const path = '/' + segs.join('/');
        return tail !== undefined ? `${path}/${tail}` : path;
      });
    });
}

/**
 * Arbitrary URL path with percent-encoded attack characters.
 *
 * Generates paths containing:
 * - `%2e%2e` (encoded `..`)
 * - `%2f` (encoded `/`)
 * - `%00` (null byte)
 * - `%2e` (encoded `.`)
 * - Mixed case encodings (`%2E%2E`, `%2F`)
 */
function encodedPathArb(): fc.Arbitrary<string> {
  const encodedSegments = fc.constantFrom(
    '%2e%2e',       // ..
    '%2E%2E',       // .. (uppercase)
    '%2e%2E',       // .. (mixed case)
    '%2f',          // /
    '%2F',          // / (uppercase)
    '%00',          // null byte
    '%2e',          // .
    '%2E',          // . (uppercase)
    '..%2f',        // ../ (mixed literal + encoded)
    '%2e%2e%2f',    // ../ (fully encoded)
    '%2e%2e/',      // ../ (encoded dots, literal slash)
    '..%2F',        // ../ (uppercase encoded slash)
    '%2e%2e%2F',    // ../ (encoded dots, uppercase slash)
    '%zz',          // malformed percent-encoding
    '%',            // incomplete percent-encoding
    '%0',           // incomplete percent-encoding
  );

  return fc
    .array(fc.oneof(encodedSegments, urlSegmentArb()), {
      minLength: 1,
      maxLength: 5,
    })
    .map((parts) => '/' + parts.join('/'));
}

/**
 * Arbitrary extensionless URL path (no `.` in the final segment).
 *
 * These paths exercise the SPA fallback logic: when no file matches and
 * the path has no extension, `resolveAsset` should return `spa-fallback`
 * rather than 404.
 */
function extensionlessPathArb(): fc.Arbitrary<string> {
  return fc
    .array(urlSegmentArb(), { minLength: 1, maxLength: 4 })
    .map((segments) => '/' + segments.join('/'));
}

/**
 * Arbitrary URL path with a file extension from the MIME table.
 *
 * Exercises the MIME-type resolution and the "missing asset with
 * extension → 404" branch.
 */
function pathWithExtensionArb(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.array(urlSegmentArb(), { minLength: 0, maxLength: 3 }),
      urlSegmentArb(),
      fc.constantFrom(...ASSET_EXTENSIONS),
    )
    .map(([dirs, name, ext]) => {
      const prefix = dirs.length > 0 ? '/' + dirs.join('/') : '';
      return `${prefix}/${name}${ext}`;
    });
}

/**
 * Arbitrary URL path with mixed separator styles.
 *
 * Generates paths using backslashes (`\`), double slashes (`//`), and
 * mixed forward/back slashes to test normalisation.
 */
function mixedSeparatorPathArb(): fc.Arbitrary<string> {
  const separators = fc.constantFrom('/', '\\', '//', '\\\\', '/\\', '\\/');
  return fc
    .tuple(
      fc.array(
        fc.tuple(separators, urlSegmentArb()),
        { minLength: 1, maxLength: 4 },
      ),
      fc.option(fc.constantFrom('..', '.'), { nil: undefined }),
    )
    .map(([pairs, dotSegment]) => {
      let path = '';
      for (const [sep, seg] of pairs) {
        path += sep + seg;
      }
      if (dotSegment !== undefined) {
        path += '/' + dotSegment;
      }
      return path;
    });
}

/**
 * Arbitrary very long URL path string (500–2000 characters).
 *
 * Exercises buffer and length-related edge cases in the resolver.
 */
function longPathArb(): fc.Arbitrary<string> {
  return fc
    .array(urlSegmentArb(), { minLength: 40, maxLength: 160 })
    .map((segments) => '/' + segments.join('/'));
}

/**
 * Arbitrary URL path string for exercising the static-handler's
 * `resolveAsset` function across its full input space.
 *
 * Produces a weighted mix of:
 * - Path-traversal attempts (`..` segments)
 * - Percent-encoded attack strings (`%2e%2e`, `%00`, `%2f`)
 * - Mixed separator styles (`\`, `//`)
 * - Extensionless paths (SPA fallback candidates)
 * - Paths with file extensions (MIME resolution)
 * - Empty strings
 * - Very long strings
 * - Fully arbitrary strings (catch-all for unexpected inputs)
 *
 * Used by the three property tests in Tasks 7.3, 7.4, and 7.5.
 *
 * @see .kiro/specs/visualizer-scaffold/design.md § Property 1, 2, 3
 * @see .kiro/specs/visualizer-scaffold/requirements.md § N17
 */
export function arbitraryUrlPath(): fc.Arbitrary<string> {
  return fc.oneof(
    // Weight traversal and encoded paths higher — they are the
    // security-critical inputs for the static handler.
    { weight: 3, arbitrary: traversalPathArb() },
    { weight: 3, arbitrary: encodedPathArb() },
    { weight: 2, arbitrary: mixedSeparatorPathArb() },
    { weight: 2, arbitrary: extensionlessPathArb() },
    { weight: 2, arbitrary: pathWithExtensionArb() },
    { weight: 1, arbitrary: longPathArb() },
    { weight: 1, arbitrary: fc.constant('') },
    { weight: 1, arbitrary: fc.constant('/') },
    { weight: 1, arbitrary: fc.constant('/index.html') },
    // Fully arbitrary string — catches inputs none of the above produce.
    { weight: 2, arbitrary: fc.string({ minLength: 0, maxLength: 200 }) },
  );
}

// ── IDE hook shim generators (kiro-ide-hook-shim spec) ─────────────────

/**
 * Shape of the IDE's `postToolUse` payload in `USER_PROMPT`.
 * All fields are optional — the shim applies defaults for missing fields.
 */
export interface IdeToolUsePayload {
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolSuccess?: boolean;
}

/**
 * Arbitrary camelCase IDE `postToolUse` payload.
 *
 * Generates payloads with all four fields present. Tests that need partial
 * payloads can `.map()` to delete fields.
 *
 * @see .kiro/specs/kiro-ide-hook-shim/design.md § postToolUse Field Mapping
 */
export function ideToolUsePayloadArb(): fc.Arbitrary<IdeToolUsePayload> {
  return fc.record({
    toolName: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.length > 0),
    toolArgs: fc.dictionary(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.length > 0),
      fc.oneof(fc.string({ maxLength: 50 }), fc.integer(), fc.boolean()),
      { minKeys: 0, maxKeys: 5 },
    ),
    toolResult: fc.string({ maxLength: 200 }),
    toolSuccess: fc.boolean(),
  });
}

/**
 * Shape of a Kiro IDE `.kiro.hook` file.
 */
export interface KiroHookFile {
  enabled: boolean;
  name: string;
  description: string;
  version: string;
  when: {
    type: string;
    toolTypes?: string[];
  };
  then: {
    type: string;
    command: string;
  };
}

/**
 * Arbitrary IDE hook file object.
 *
 * @see .kiro/specs/kiro-ide-hook-shim/design.md § IDE Hook File Format
 */
export function ideHookFileArb(): fc.Arbitrary<KiroHookFile> {
  return fc
    .record({
      name: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.length > 0),
      description: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.length > 0),
      eventType: fc.constantFrom('promptSubmit', 'agentStop', 'postToolUse'),
      shimPath: shimPathArb(),
    })
    .map(({ name, description, eventType, shimPath }) => {
      const when: KiroHookFile['when'] = { type: eventType };
      if (eventType === 'postToolUse') {
        when.toolTypes = ['*'];
      }
      return {
        enabled: true,
        name,
        description,
        version: '1',
        when,
        then: {
          type: 'runCommand',
          command: `"${shimPath}" ${eventType} || true`,
        },
      };
    });
}

/**
 * Arbitrary shim executable path (including paths with spaces).
 *
 * @see .kiro/specs/kiro-ide-hook-shim/design.md § Hook Command Format
 */
export function shimPathArb(): fc.Arbitrary<string> {
  // Segments use a safe alphabet: alphanumerics, dash, underscore, dot, space.
  // This avoids generating paths with shell-unsafe characters (backticks, $, \, newlines)
  // that would produce misleading test data.
  const safeSegment = fc
    .stringMatching(/^[a-zA-Z0-9 _.-]{1,15}$/)
    .filter((s) => s.length >= 1 && s.length <= 15);

  return fc.oneof(
    // Simple path
    fc.constant('/home/user/.kiro-learn/bin/ide-shim'),
    // Path with tilde
    fc.constant('~/.kiro-learn/bin/ide-shim'),
    // Path with spaces
    fc.constant('/home/my user/.kiro-learn/bin/ide-shim'),
    // Random path segments with safe characters
    fc
      .array(safeSegment, { minLength: 1, maxLength: 5 })
      .map((segments) => '/' + segments.join('/') + '/ide-shim'),
  );
}

// ── MCP tool argument generators (mcp-memory-server Task 14) ───────────

/**
 * Arbitrary valid `search_memory` tool arguments.
 *
 * - `query`: non-empty string ≤1000 chars
 * - `limit`: optional number 1–100
 *
 * @see .kiro/specs/mcp-memory-server/design.md § Testing Strategy
 * @see .kiro/specs/mcp-memory-server/requirements.md § 3.1, 11.1
 */
export function arbitrarySearchMemoryArgs(): fc.Arbitrary<{
  query: string;
  limit?: number;
}> {
  return fc
    .record({
      query: fc.string({ minLength: 1, maxLength: 1000 }).filter((s) => s.length > 0),
      limit: fc.option(fc.integer({ min: 1, max: 100 }), { nil: undefined }),
    })
    .map((r) => {
      if (r.limit === undefined) {
        return { query: r.query };
      }
      return { query: r.query, limit: r.limit };
    });
}

/**
 * Arbitrary valid `save_observation` tool arguments.
 *
 * Respects all size constraints from the design:
 * - `title`: non-empty string ≤200 chars
 * - `summary`: non-empty string ≤4000 chars
 * - `observation_type`: one of OBSERVATION_TYPES
 * - `concepts`: array of strings, 0–50 entries, each 1–100 chars
 * - `files_touched`: array of strings, 0–100 entries, each 1–500 chars
 * - `facts`: array of strings, 0–50 entries, each 1–200 chars
 *
 * @see .kiro/specs/mcp-memory-server/design.md § Testing Strategy
 * @see .kiro/specs/mcp-memory-server/requirements.md § 4.1, 11.2–11.4
 */
export function arbitraryObservationArgs(): fc.Arbitrary<{
  title: string;
  summary: string;
  observation_type: string;
  concepts: string[];
  files_touched: string[];
  facts: string[];
}> {
  return fc.record({
    title: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.length > 0),
    summary: fc.string({ minLength: 1, maxLength: 4000 }).filter((s) => s.length > 0),
    observation_type: fc.constantFrom(...OBSERVATION_TYPES),
    concepts: fc.array(
      fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.length > 0),
      { minLength: 0, maxLength: 50 },
    ),
    files_touched: fc.array(
      fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.length > 0),
      { minLength: 0, maxLength: 100 },
    ),
    facts: fc.array(
      fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.length > 0),
      { minLength: 0, maxLength: 50 },
    ),
  });
}

/**
 * Arbitrary valid `save_session_summary` tool arguments.
 *
 * All string fields: non-empty strings ≤2000 chars.
 * Array fields: arrays of strings, 0–50 entries, each 1–500 chars.
 *
 * @see .kiro/specs/mcp-memory-server/design.md § Testing Strategy
 * @see .kiro/specs/mcp-memory-server/requirements.md § 5.1
 */
export function arbitrarySessionSummaryArgs(): fc.Arbitrary<{
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  files_read: string[];
  files_modified: string[];
}> {
  return fc.record({
    request: fc.string({ minLength: 1, maxLength: 2000 }).filter((s) => s.length > 0),
    investigated: fc.string({ minLength: 1, maxLength: 2000 }).filter((s) => s.length > 0),
    learned: fc.string({ minLength: 1, maxLength: 2000 }).filter((s) => s.length > 0),
    completed: fc.string({ minLength: 1, maxLength: 2000 }).filter((s) => s.length > 0),
    next_steps: fc.string({ minLength: 1, maxLength: 2000 }).filter((s) => s.length > 0),
    files_read: fc.array(
      fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.length > 0),
      { minLength: 0, maxLength: 50 },
    ),
    files_modified: fc.array(
      fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.length > 0),
      { minLength: 0, maxLength: 50 },
    ),
  });
}

/**
 * Arbitrary structurally invalid tool arguments.
 *
 * Generates different kinds of malformed args:
 * - Missing required fields (empty object)
 * - Wrong types: `query` as number, `concepts` as string, `title` as number
 * - Extra fields with wrong types
 *
 * @see .kiro/specs/mcp-memory-server/design.md § Testing Strategy
 * @see .kiro/specs/mcp-memory-server/requirements.md § 7.3
 */
export function arbitraryMalformedToolArgs(): fc.Arbitrary<Record<string, unknown>> {
  return fc.oneof(
    // Missing required fields — empty object
    fc.constant({} as Record<string, unknown>),
    // query as number instead of string
    fc.integer().map((n) => ({ query: n }) as Record<string, unknown>),
    // concepts as string instead of array
    fc.string({ maxLength: 100 }).map(
      (s) =>
        ({
          title: 'valid title',
          summary: 'valid summary',
          observation_type: 'discovery',
          concepts: s,
          files_touched: [],
          facts: [],
        }) as Record<string, unknown>,
    ),
    // title as number instead of string
    fc.integer().map(
      (n) =>
        ({
          title: n,
          summary: 'valid summary',
          observation_type: 'discovery',
          concepts: [],
          files_touched: [],
          facts: [],
        }) as Record<string, unknown>,
    ),
    // Extra fields with wrong types
    fc.record({
      query: fc.constant(true),
      limit: fc.constant('not a number'),
      extra_field: fc.constant(42),
    }) as fc.Arbitrary<Record<string, unknown>>,
  );
}

/**
 * Arbitrary observation args where at least one field exceeds its limit.
 *
 * Uses `fc.oneof()` to pick which field to exceed:
 * - `title` > 200 chars (201–500 char string)
 * - `summary` > 4000 chars (4001–5000 char string)
 * - `concepts` > 50 entries
 * - `files_touched` > 100 entries
 * - `facts` > 50 entries
 *
 * All other fields are valid.
 *
 * @see .kiro/specs/mcp-memory-server/design.md § Testing Strategy
 * @see .kiro/specs/mcp-memory-server/requirements.md § 4.4, 4.5, 11.1–11.4
 */
export function arbitraryOverLimitObservationArgs(): fc.Arbitrary<{
  title: string;
  summary: string;
  observation_type: string;
  concepts: string[];
  files_touched: string[];
  facts: string[];
}> {
  // Valid base values for fields not being exceeded
  const validTitle = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.length > 0);
  const validSummary = fc.string({ minLength: 1, maxLength: 4000 }).filter((s) => s.length > 0);
  const validObsType = fc.constantFrom(...OBSERVATION_TYPES);
  const validConcepts = fc.array(
    fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.length > 0),
    { minLength: 0, maxLength: 50 },
  );
  const validFilesTouched = fc.array(
    fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.length > 0),
    { minLength: 0, maxLength: 100 },
  );
  const validFacts = fc.array(
    fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.length > 0),
    { minLength: 0, maxLength: 50 },
  );

  // title > 200 chars
  const overTitle = fc
    .tuple(
      fc.string({ minLength: 201, maxLength: 500 }).filter((s) => s.length >= 201),
      validSummary,
      validObsType,
      validConcepts,
      validFilesTouched,
      validFacts,
    )
    .map(([title, summary, observation_type, concepts, files_touched, facts]) => ({
      title,
      summary,
      observation_type,
      concepts,
      files_touched,
      facts,
    }));

  // summary > 4000 chars
  const overSummary = fc
    .tuple(
      validTitle,
      fc.string({ minLength: 4001, maxLength: 5000 }).filter((s) => s.length >= 4001),
      validObsType,
      validConcepts,
      validFilesTouched,
      validFacts,
    )
    .map(([title, summary, observation_type, concepts, files_touched, facts]) => ({
      title,
      summary,
      observation_type,
      concepts,
      files_touched,
      facts,
    }));

  // concepts > 50 entries
  const overConcepts = fc
    .tuple(
      validTitle,
      validSummary,
      validObsType,
      fc.array(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.length > 0),
        { minLength: 51, maxLength: 60 },
      ),
      validFilesTouched,
      validFacts,
    )
    .map(([title, summary, observation_type, concepts, files_touched, facts]) => ({
      title,
      summary,
      observation_type,
      concepts,
      files_touched,
      facts,
    }));

  // files_touched > 100 entries
  const overFiles = fc
    .tuple(
      validTitle,
      validSummary,
      validObsType,
      validConcepts,
      fc.array(
        fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.length > 0),
        { minLength: 101, maxLength: 110 },
      ),
      validFacts,
    )
    .map(([title, summary, observation_type, concepts, files_touched, facts]) => ({
      title,
      summary,
      observation_type,
      concepts,
      files_touched,
      facts,
    }));

  // facts > 50 entries
  const overFacts = fc
    .tuple(
      validTitle,
      validSummary,
      validObsType,
      validConcepts,
      validFilesTouched,
      fc.array(
        fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.length > 0),
        { minLength: 51, maxLength: 60 },
      ),
    )
    .map(([title, summary, observation_type, concepts, files_touched, facts]) => ({
      title,
      summary,
      observation_type,
      concepts,
      files_touched,
      facts,
    }));

  return fc.oneof(overTitle, overSummary, overConcepts, overFiles, overFacts);
}
