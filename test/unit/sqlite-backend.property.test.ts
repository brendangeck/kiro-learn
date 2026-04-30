/**
 * Property-based tests for the SQLite storage backend.
 *
 * Covers tasks 6.1–6.6 in the event-schema-and-storage spec, which in turn
 * anchor Correctness Properties P1–P4 and the FTS5 sanitisation safety
 * property:
 *
 * - 6.1 / P1 — round-trip integrity: putEvent → getEventById deep-equals.
 * - 6.2 / P2 — putEvent idempotency: second put is a no-op on row count
 *              AND transaction_time.
 * - 6.3 / P3 — namespace isolation on search: n1 query never returns n2
 *              records.
 * - 6.4       — searchMemoryRecords honours limit.
 * - 6.5 / P4 — stored-row schema invariants: row round-trips through
 *              parseEvent; schema_version/namespace/time columns are
 *              well-formed.
 * - 6.6       — sanitizeForFts5 output is well-formed AND searchMemoryRecords
 *              never throws for arbitrary input.
 *
 * Each property opens a fresh temp directory + SQLite database per
 * iteration. This is heavier than sharing a single DB across runs, but it
 * gives every property a clean slate — no cross-iteration state can mask
 * a real bug. To keep wall-clock reasonable, heavy tests (P3, P4, P6-B)
 * cap `numRuns` below fast-check's default of 100; P1/P2 and the
 * string-only portion of P6 stay at the default.
 *
 * Cleanup is in a `try/finally` block inside each property body: a failing
 * iteration must still close the DB handle and remove the temp dir, or a
 * regression here would leak SQLite files into `/tmp` on every failed run.
 *
 * @see .kiro/specs/event-schema-and-storage/design.md § Correctness Properties
 * @see .kiro/specs/event-schema-and-storage/requirements.md § Requirements 6–8, 11, 12
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import Database from 'better-sqlite3';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sanitizeForFts5, tokenizeForQuery } from '../../src/collector/storage/sqlite/fts5.js';
import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import { NAMESPACE_RE, parseEvent } from '../../src/types/schemas.js';
import type {
  KiroMemEvent,
  MemoryRecord,
  StorageBackend,
} from '../../src/types/index.js';

import { arbitraryEvent, namespaceArb } from '../helpers/arbitrary.js';

/**
 * Scratch state for a single property iteration: a unique temp directory,
 * the DB file path inside it, and the open backend.
 *
 * Factored out so every `fc.asyncProperty` body can call one helper, wrap
 * the assertions in a `try/finally`, and be guaranteed to clean up on
 * both success and failure.
 */
interface Scratch {
  tmpRoot: string;
  dbPath: string;
  storage: StorageBackend;
}

/**
 * Open a fresh SQLite backend in a unique temp directory. The returned
 * handle is the caller's to close; see {@link cleanupScratch}.
 */
function openScratch(): Scratch {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-pbt-'));
  const dbPath = join(tmpRoot, 'kiro-learn.db');
  const storage = openSqliteStorage({ dbPath });
  return { tmpRoot, dbPath, storage };
}

/**
 * Close the backend and remove the temp tree. Never throws — cleanup
 * failures must not mask the property's real failure mode.
 */
async function cleanupScratch(s: Scratch): Promise<void> {
  try {
    await s.storage.close();
  } catch {
    // ignore: double-close is already a no-op; if something worse
    // happened, the assertion above would have surfaced first.
  }
  rmSync(s.tmpRoot, { recursive: true, force: true });
}

/* ────────────────────────────────────────────────────────────────────
 * Task 6.1 — Property P1: round-trip integrity
 * ──────────────────────────────────────────────────────────────────── */

describe('SQLite backend — property: round-trip integrity (P1, task 6.1)', () => {
  it('putEvent → getEventById deep-equals the original event', async () => {
    /**
     * **Validates: Requirements 7.1, Correctness Property P1**
     *
     * For any arbitrary valid `KiroMemEvent`, writing it via `putEvent` and
     * reading it back via `getEventById` MUST yield an object structurally
     * equal to the original. The backend's internal `transaction_time` is
     * not part of the public `KiroMemEvent` type and is therefore exempt
     * from the comparison — `toEqual` passes by construction.
     */
    await fc.assert(
      fc.asyncProperty(arbitraryEvent(), async (event: KiroMemEvent) => {
        const s = openScratch();
        try {
          await s.storage.putEvent(event);
          const read = await s.storage.getEventById(event.event_id);
          expect(read).toEqual(event);
        } finally {
          await cleanupScratch(s);
        }
      }),
      { numRuns: 50 },
    );
  });
});

/* ────────────────────────────────────────────────────────────────────
 * Task 6.2 — Property P2: putEvent idempotency
 * ──────────────────────────────────────────────────────────────────── */

describe('SQLite backend — property: putEvent idempotency (P2, task 6.2)', () => {
  it('second putEvent is a no-op on row count AND transaction_time', async () => {
    /**
     * **Validates: Requirements 6.2, 6.3, 6.4, Correctness Property P2**
     *
     * For any valid event `e`:
     *   (a) after two successive `putEvent(e)` calls, the `events` table
     *       contains exactly one row with `event_id = e.event_id`;
     *   (b) that row's `transaction_time` is exactly the value written on
     *       the first call — the second call does not re-stamp it.
     *
     * We insert a ~2 ms sleep between the two puts: `transaction_time` is
     * stamped with `new Date().toISOString()`, which has millisecond
     * resolution. Without a gap the two timestamps could legitimately be
     * identical on a fast machine and (b) would trivially hold even under
     * a bug where the second put *did* overwrite. The sleep forces the
     * clock far enough that a regression (re-stamp) would produce a
     * different string and fail the assertion.
     *
     * `transaction_time` is not surfaced on the public `KiroMemEvent`
     * type, so we probe it via a read-only sibling `Database` handle —
     * the same pattern used by the 5.12 persistence test. The probe is
     * scoped with `try/finally` so it always closes before the scratch
     * cleanup deletes the file.
     */
    await fc.assert(
      fc.asyncProperty(arbitraryEvent(), async (event: KiroMemEvent) => {
        const s = openScratch();
        try {
          await s.storage.putEvent(event);

          // Capture the first-write transaction_time before the second put.
          const probe1 = new Database(s.dbPath, { readonly: true });
          let t1: string;
          try {
            const row = probe1
              .prepare<[string], { transaction_time: string }>(
                'SELECT transaction_time FROM events WHERE event_id = ?',
              )
              .get(event.event_id);
            expect(row).toBeDefined();
            t1 = row!.transaction_time;
          } finally {
            probe1.close();
          }

          // Force the wall clock past one ISO-millisecond tick so a
          // (hypothetical) re-stamp would be visible in the stored value.
          await sleep(2);

          await s.storage.putEvent(event);

          // Re-read both the row count and the transaction_time.
          const probe2 = new Database(s.dbPath, { readonly: true });
          try {
            const { count } = probe2
              .prepare<[string], { count: number }>(
                'SELECT COUNT(*) AS count FROM events WHERE event_id = ?',
              )
              .get(event.event_id)!;
            expect(count).toBe(1);

            const { transaction_time: t2 } = probe2
              .prepare<[string], { transaction_time: string }>(
                'SELECT transaction_time FROM events WHERE event_id = ?',
              )
              .get(event.event_id)!;
            expect(t2).toBe(t1);
          } finally {
            probe2.close();
          }
        } finally {
          await cleanupScratch(s);
        }
      }),
      { numRuns: 30 },
    );
  });
});

/* ────────────────────────────────────────────────────────────────────
 * Task 6.3 — Property P3: namespace isolation on search
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Crockford-base32 alphabet used to mint per-iteration ULIDs for records.
 * Mirrors `ULID_ALPHABET` in `test/arbitrary.ts`; duplicated here rather
 * than exported so the arbitraries module stays focused on fast-check
 * generators.
 */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Build a deterministic, valid `mr_`-prefixed record id from a numeric
 * suffix. Padding to 26 Crockford-base32 digits keeps the id valid under
 * `RECORD_ID_RE`; mapping the suffix through the alphabet keeps the
 * output in range. Used to mint unique record ids across a single
 * iteration without needing another arbitrary.
 */
function makeRecordId(suffix: number): string {
  // Encode the suffix in base32 using the ULID alphabet, pad on the left
  // with `0` (which is a valid Crockford digit) to 26 chars.
  let encoded = '';
  let n = suffix;
  if (n === 0) {
    encoded = '0';
  } else {
    while (n > 0) {
      const digit = n % ULID_ALPHABET.length;
      encoded = ULID_ALPHABET[digit]! + encoded;
      n = Math.floor(n / ULID_ALPHABET.length);
    }
  }
  return `mr_${encoded.padStart(26, '0')}`;
}

describe('SQLite backend — property: namespace isolation on search (P3, task 6.3)', () => {
  it('search under n1 never returns records stored under n2', async () => {
    /**
     * **Validates: Requirements 8.4, Correctness Property P3**
     *
     * Given two distinct, valid namespaces `n1` and `n2`, and records
     * populated under both, a search scoped to `n1` MUST:
     *   - return only records whose `namespace` begins with `n1`;
     *   - never surface any record stored under `n2`.
     *
     * Records share a common term (`"shared"`) inserted into both
     * `title` and `summary` so FTS5 has something to match under either
     * namespace. Each record gets a deterministic, unique `record_id` via
     * `makeRecordId`, so the n1/n2 populations are structurally
     * indistinguishable apart from their namespace.
     */
    await fc.assert(
      fc.asyncProperty(
        fc
          .tuple(namespaceArb(), namespaceArb())
          .filter(([a, b]) => a !== b),
        async ([n1, n2]) => {
          const s = openScratch();
          try {
            // Mint 3 records per namespace. 6 total is plenty for the
            // isolation check without inflating the per-iteration cost.
            const n1Ids = new Set<string>();
            const n2Ids = new Set<string>();

            for (let i = 0; i < 3; i++) {
              const r1: MemoryRecord = {
                record_id: makeRecordId(i * 2),
                namespace: n1,
                strategy: 'llm-summary',
                title: 'shared title n1',
                summary: 'shared summary under namespace n1',
                facts: ['shared fact'],
                source_event_ids: ['01JF8ZS4Y00000000000000000'],
                created_at: '2026-04-23T20:00:00Z',
                concepts: ['testing'],
                files_touched: ['src/index.ts'],
                observation_type: 'tool_use',
              };
              const r2: MemoryRecord = {
                record_id: makeRecordId(i * 2 + 1),
                namespace: n2,
                strategy: 'llm-summary',
                title: 'shared title n2',
                summary: 'shared summary under namespace n2',
                facts: ['shared fact'],
                source_event_ids: ['01JF8ZS4Y00000000000000000'],
                created_at: '2026-04-23T20:00:00Z',
                concepts: ['testing'],
                files_touched: ['src/index.ts'],
                observation_type: 'tool_use',
              };
              await s.storage.putMemoryRecord(r1);
              await s.storage.putMemoryRecord(r2);
              n1Ids.add(r1.record_id);
              n2Ids.add(r2.record_id);
            }

            const hits = await s.storage.searchMemoryRecords({
              namespace: n1,
              query: 'shared',
              limit: 100,
            });

            // Every returned record's namespace must start with n1 …
            for (const h of hits) {
              expect(h.namespace.startsWith(n1)).toBe(true);
              // … and must not be one of the n2-scoped record ids.
              expect(n2Ids.has(h.record_id)).toBe(false);
            }
          } finally {
            await cleanupScratch(s);
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});

/* ────────────────────────────────────────────────────────────────────
 * Task 6.4 — searchMemoryRecords honours limit
 * ──────────────────────────────────────────────────────────────────── */

describe('SQLite backend — property: searchMemoryRecords honours limit (task 6.4)', () => {
  it('returns at most `limit` records when more are available', async () => {
    /**
     * **Validates: Requirements 8.3**
     *
     * When more matching records exist than the caller's `limit`,
     * `searchMemoryRecords` MUST return no more than `limit` rows. The
     * assertion is an inequality — the backend is free to return fewer
     * if the FTS5 ranker drops ties or the LIKE fallback is less
     * generous, but never more.
     *
     * Each iteration populates `limit + 5` records, all sharing a query
     * term, under a single namespace, then searches with that `limit`.
     */
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 15 }), async (limit) => {
        const s = openScratch();
        try {
          const namespace = '/actor/alice/project/limit-test/';
          const total = limit + 5;

          for (let i = 0; i < total; i++) {
            await s.storage.putMemoryRecord({
              record_id: makeRecordId(i),
              namespace,
              strategy: 'llm-summary',
              title: 'widget alpha',
              summary: 'widget beta — appears in every record',
              facts: ['widget'],
              source_event_ids: ['01JF8ZS4Y00000000000000000'],
              created_at: '2026-04-23T20:00:00Z',
              concepts: ['testing'],
              files_touched: ['src/index.ts'],
              observation_type: 'tool_use',
            });
          }

          const hits = await s.storage.searchMemoryRecords({
            namespace,
            query: 'widget',
            limit,
          });

          expect(hits.length).toBeLessThanOrEqual(limit);
        } finally {
          await cleanupScratch(s);
        }
      }),
      { numRuns: 20 },
    );
  });
});

/* ────────────────────────────────────────────────────────────────────
 * Task 6.5 — Property P4: stored-event schema invariants
 * ──────────────────────────────────────────────────────────────────── */

/**
 * Raw row shape for the schema-invariants probe. Mirrors the columns
 * declared in migration 0001's `events` table. Defined inline here rather
 * than imported from `src/collector/storage/sqlite/statements.ts` because
 * `EventRow` is internal to the storage layer — the PBT reaches across
 * the seam deliberately, and a local copy keeps that intent explicit.
 */
interface EventsRow {
  event_id: string;
  parent_event_id: string | null;
  session_id: string;
  actor_id: string;
  namespace: string;
  schema_version: number;
  kind: string;
  body_json: string;
  valid_time: string;
  transaction_time: string;
  source_json: string;
  content_hash: string | null;
}

describe('SQLite backend — property: stored-row schema invariants (P4, task 6.5)', () => {
  it('every stored row reconstructs into a valid event', async () => {
    /**
     * **Validates: Requirements 11.1, 11.2, Correctness Property P4**
     *
     * For every event written via `putEvent`, the stored row MUST:
     *   - round-trip through `parseEvent` when reassembled into wire JSON;
     *   - carry `schema_version === 1`;
     *   - carry a `namespace` matching `NAMESPACE_RE`;
     *   - carry `valid_time` and `transaction_time` values that parse as
     *     finite dates.
     *
     * We bypass the public `getEventById` path and read the raw row via a
     * sibling read-only `Database` handle. This is what makes the property
     * a *storage-layer* invariant rather than a backend-internal one:
     * even if `getEventById` were buggy (or silently filtered), the row
     * in the `events` table itself must remain a well-formed event.
     */
    await fc.assert(
      fc.asyncProperty(arbitraryEvent(), async (event: KiroMemEvent) => {
        const s = openScratch();
        try {
          await s.storage.putEvent(event);

          const probe = new Database(s.dbPath, { readonly: true });
          let row: EventsRow;
          try {
            const got = probe
              .prepare<[string], EventsRow>(
                `SELECT event_id, parent_event_id, session_id, actor_id,
                        namespace, schema_version, kind, body_json,
                        valid_time, transaction_time, source_json, content_hash
                 FROM events WHERE event_id = ?`,
              )
              .get(event.event_id);
            expect(got).toBeDefined();
            row = got!;
          } finally {
            probe.close();
          }

          // Reconstruct the wire JSON from the raw row. Optional fields
          // are attached conditionally so the shape satisfies
          // `exactOptionalPropertyTypes` (absent key, not `undefined`).
          const wire: Record<string, unknown> = {
            event_id: row.event_id,
            session_id: row.session_id,
            actor_id: row.actor_id,
            namespace: row.namespace,
            schema_version: row.schema_version,
            kind: row.kind,
            body: JSON.parse(row.body_json) as unknown,
            valid_time: row.valid_time,
            source: JSON.parse(row.source_json) as unknown,
          };
          if (row.parent_event_id !== null) {
            wire.parent_event_id = row.parent_event_id;
          }
          if (row.content_hash !== null) {
            wire.content_hash = row.content_hash;
          }

          // Invariant 1: parseEvent accepts the reconstructed wire JSON.
          expect(() => parseEvent(wire)).not.toThrow();

          // Invariant 2: schema_version is exactly 1.
          expect(row.schema_version).toBe(1);

          // Invariant 3: namespace matches the canonical regex.
          expect(NAMESPACE_RE.test(row.namespace)).toBe(true);

          // Invariant 4: both time columns parse as finite dates.
          expect(Number.isFinite(new Date(row.valid_time).getTime())).toBe(true);
          expect(Number.isFinite(new Date(row.transaction_time).getTime())).toBe(true);
        } finally {
          await cleanupScratch(s);
        }
      }),
      { numRuns: 30 },
    );
  });
});

/* ────────────────────────────────────────────────────────────────────
 * XML extraction fields — round-trip preservation (finding 8)
 * ──────────────────────────────────────────────────────────────────── */

describe('SQLite backend — property: XML extraction fields round-trip (finding 8)', () => {
  it('concepts, files_touched, and observation_type survive a write/read cycle', async () => {
    /**
     * **Validates: Requirements 8.1, 8.2, 8.3**
     *
     * The new fields added by the XML extraction pipeline (`concepts`,
     * `files_touched`, `observation_type`) MUST round-trip through the
     * SQLite backend without being silently defaulted. A regression in
     * `rowToMemoryRecord` — e.g. reintroducing the old hardcoded
     * `concepts: []` / `files_touched: []` / `observation_type: 'tool_use'`
     * defaults — would be caught here, because the search fallback reads
     * rows back and we compare every non-trivial case against the
     * values we wrote.
     *
     * We generate each record's three new fields as arbitraries so a
     * single iteration can populate non-default values across the
     * spectrum (empty arrays, single entries, multi-entry lists,
     * unicode, and every enum value for `observation_type`).
     */
    const conceptArb = fc
      .string({ minLength: 1, maxLength: 100 })
      .filter((s) => s.length > 0);
    const fileArb = fc
      .string({ minLength: 1, maxLength: 500 })
      .filter((s) => s.length > 0);
    const observationTypeArb = fc.constantFrom(
      'tool_use' as const,
      'decision' as const,
      'error' as const,
      'discovery' as const,
      'pattern' as const,
    );

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          concepts: fc.array(conceptArb, { minLength: 0, maxLength: 5 }),
          files_touched: fc.array(fileArb, { minLength: 0, maxLength: 5 }),
          observation_type: observationTypeArb,
        }),
        async (fields) => {
          const s = openScratch();
          try {
            const namespace = '/actor/alice/project/roundtrip-new-fields/';
            const record: MemoryRecord = {
              record_id: makeRecordId(0),
              namespace,
              strategy: 'llm-summary',
              title: 'roundtrip title',
              summary: 'roundtrip summary shared across iterations',
              facts: ['anchor fact'],
              source_event_ids: ['01JF8ZS4Y00000000000000000'],
              created_at: '2026-04-23T20:00:00Z',
              concepts: fields.concepts,
              files_touched: fields.files_touched,
              observation_type: fields.observation_type,
            };
            await s.storage.putMemoryRecord(record);

            // Use a query term we know appears in every record so the
            // primary FTS path lights up and returns the row we just
            // wrote. The row comes back through `rowToMemoryRecord`, so
            // any regression there (e.g. hardcoded defaults) is caught
            // by the equality checks below.
            const hits = await s.storage.searchMemoryRecords({
              namespace,
              query: 'roundtrip',
              limit: 5,
            });

            expect(hits).toHaveLength(1);
            const got = hits[0]!;
            expect(got.concepts).toEqual(fields.concepts);
            expect(got.files_touched).toEqual(fields.files_touched);
            expect(got.observation_type).toBe(fields.observation_type);
          } finally {
            await cleanupScratch(s);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});

/* ────────────────────────────────────────────────────────────────────
 * Task 6.6 — FTS5 query sanitisation is safe
 * ──────────────────────────────────────────────────────────────────── */

describe('SQLite backend — property: sanitizeForFts5 output shape (task 6.6A)', () => {
  it('returns empty string for zero-token input, otherwise OR-of-quoted-phrases', () => {
    /**
     * **Validates: Requirements 1.4, 1.5, 3.2, 3.3, 3.4**
     *
     * For any input string `q`, `sanitizeForFts5(q)`:
     *   - returns `''` when the input tokenises to zero tokens (empty or
     *     whitespace-only input);
     *   - otherwise returns an OR-of-quoted-phrases expression where each
     *     ` OR `-separated segment is a balanced `"…"` phrase with no
     *     unescaped interior `"` (every interior `"` appears as `""`).
     *
     * Property 3 from the fts5-query-tokenization design supersedes the
     * old single-phrase shape assertion. The branching on empty input
     * reflects the new semantics where the sanitizer signals "skip query"
     * by returning an empty string.
     *
     * Input domain is `fc.string()`, which covers empty strings, pure
     * quote strings like `"""`, mixed content, and unicode.
     */
    fc.assert(
      fc.property(fc.string(), (q) => {
        const out = sanitizeForFts5(q);
        const tokens = tokenizeForQuery(q);

        if (tokens.length === 0) {
          // Empty tokenization → empty output (signal to skip MATCH query)
          expect(out).toBe('');
          return;
        }

        // Non-empty tokenization → OR-of-quoted-phrases shape.
        // Split on ` OR ` to get individual phrases.
        const phrases = out.split(' OR ');
        expect(phrases.length).toBeGreaterThanOrEqual(1);
        expect(phrases.length).toBeLessThanOrEqual(32); // default term cap

        for (const phrase of phrases) {
          // Each phrase must start and end with `"`
          expect(phrase.startsWith('"')).toBe(true);
          expect(phrase.endsWith('"')).toBe(true);
          expect(phrase.length).toBeGreaterThanOrEqual(2);

          // Interior: after removing every `""` pair, no `"` may remain
          const interior = phrase.slice(1, -1);
          expect(interior.replace(/""/g, '')).not.toContain('"');
        }
      }),
    );
  });
});

describe('SQLite backend — property: searchMemoryRecords never throws (task 6.6B)', () => {
  it('returns an array for any input string, via FTS5 or LIKE fallback', async () => {
    /**
     * **Validates: Requirements 12.2**
     *
     * The public contract for `searchMemoryRecords` is "availability over
     * rank quality": for any `query` string, the call MUST return an
     * array — never throw, never propagate a `SqliteError` from FTS5's
     * parser. This exercises the sanitise-then-MATCH path together with
     * the LIKE fallback: whichever runs, the call resolves.
     *
     * We populate a single record per iteration so both paths have
     * something to potentially match against; the result is not checked
     * for content — only for shape (array) and for namespace isolation
     * (a cheap safety re-check).
     */
    await fc.assert(
      fc.asyncProperty(fc.string(), async (q) => {
        const s = openScratch();
        try {
          const namespace = '/actor/alice/project/fts-safe/';
          await s.storage.putMemoryRecord({
            record_id: makeRecordId(0),
            namespace,
            strategy: 'llm-summary',
            title: 'corpus title',
            summary: 'corpus summary so both paths have a target to consider',
            facts: ['anchor'],
            source_event_ids: ['01JF8ZS4Y00000000000000000'],
            created_at: '2026-04-23T20:00:00Z',
            concepts: ['testing'],
            files_touched: ['src/index.ts'],
            observation_type: 'tool_use',
          });

          const hits = await s.storage.searchMemoryRecords({
            namespace,
            query: q,
            limit: 10,
          });

          expect(Array.isArray(hits)).toBe(true);
          for (const h of hits) {
            expect(h.namespace.startsWith(namespace)).toBe(true);
          }
        } finally {
          await cleanupScratch(s);
        }
      }),
      { numRuns: 25 },
    );
  });
});
