/**
 * Property-based tests for merge-commit semantics on the SQLite storage
 * backend (reconciliation-engine spec, Task 2.5).
 *
 * The reconciliation engine commits a `<merge>` decision inside
 * `withTransaction` as a single unit of work:
 *
 *   tx.putMemoryRecord(summary)
 *   tx.deleteMemoryRecord(mergedIds)
 *   tx.putEmbedding(summary.record_id, vec)
 *
 * Two invariants MUST hold across arbitrary record seed sets:
 *
 * - **Property 15 — Merge commit semantics.** After the commit, every id
 *   in `mergedIds` is absent from `listMemoryRecords`, each merged
 *   record's embedding is absent (nulled by the delete cascade, and the
 *   row itself is gone), the summary record is readable by its own id,
 *   and no row outside the merged set is mutated or deleted.
 *
 * - **Property 18 — Summary-commit atomicity.** If the transaction body
 *   throws, the entire `put + delete + put-embedding` batch is rolled
 *   back: the new summary is absent, the "would-be-deleted" records are
 *   still present, and their embeddings are still present (not nulled).
 *
 * Each iteration opens a fresh SQLite file in a unique temp directory so
 * state cannot leak across runs. The cleanup is wrapped in `try/finally`
 * inside each property body — a failing iteration must still close the
 * handle and remove the temp tree.
 *
 * The generators reuse `arbitraryMemoryRecord` from `test/helpers/arbitrary.ts`
 * and re-stamp `record_id` / `namespace` per iteration to guarantee
 * uniqueness across runs and a consistent namespace for the merge set.
 *
 * Validates: Requirements 6.4, 7.1, 7.4, 7.5, 8.1, 9.1, 9.2, 9.3, 9.4,
 *            9.5, 13.4.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { MemoryRecord, StorageBackend } from '../../src/types/index.js';

import { arbitraryMemoryRecord } from '../helpers/arbitrary.js';

/**
 * Scratch state for one property iteration: a unique temp directory, the
 * DB file path inside it, and the open backend. Each iteration runs in
 * its own scratch so any cross-iteration mutation is impossible.
 */
interface Scratch {
  tmpRoot: string;
  dbPath: string;
  storage: StorageBackend;
}

function openScratch(): Scratch {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-delete-pbt-'));
  const dbPath = join(tmpRoot, 'kiro-learn.db');
  const storage = openSqliteStorage({ dbPath });
  return { tmpRoot, dbPath, storage };
}

async function cleanupScratch(s: Scratch): Promise<void> {
  try {
    await s.storage.close();
  } catch {
    // swallow: cleanup failures must not mask the property's real failure
  }
  rmSync(s.tmpRoot, { recursive: true, force: true });
}

/**
 * Make a deterministic 384-dimensional `Float32Array` from a string seed.
 * The tests only care that the embedding is "present" or "absent"; they
 * do not inspect the values. Using a seed makes failing shrinks easier to
 * reason about.
 */
function seededEmbedding(seed: string): Float32Array {
  const vec = new Float32Array(384);
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  for (let i = 0; i < vec.length; i++) {
    h = (h * 1103515245 + 12345) | 0;
    vec[i] = ((h >>> 8) & 0xffff) / 0xffff;
  }
  return vec;
}

/**
 * Count the FTS5 companion rows for a given `record_id`. The public
 * `StorageBackend` surface does not expose FTS5-level reads, so the
 * probe opens a read-only sibling handle. Used by property assertions
 * that check "every trace of a deleted record is gone".
 */
function countFtsRows(dbPath: string, recordId: string): number {
  const probe = new Database(dbPath, { readonly: true });
  try {
    const row = probe
      .prepare<[string], { c: number }>(
        'SELECT COUNT(*) AS c FROM memory_records_fts WHERE record_id = ?',
      )
      .get(recordId);
    return row?.c ?? 0;
  } finally {
    probe.close();
  }
}

/**
 * Re-stamp a batch of arbitrary memory records so every `record_id` is
 * unique within the batch and every record shares the same namespace.
 *
 * `arbitraryMemoryRecord` generates independent records, so two outputs
 * in the same array can collide on `record_id` or land in different
 * namespaces. Both would break these properties' set-up (PK collision on
 * insert; namespace filter excluding a seeded row). This helper makes
 * the generator's output fit the property's precondition without
 * altering the records' other validated fields.
 *
 * `record_id` must match `/^mr_[0-9A-HJKMNP-TV-Z]{26}$/` (Crockford
 * base32: no I, L, O, U). `idPrefix` is 4 chars drawn from the same
 * alphabet; together with a 2-char tag and a zero-padded index they
 * fill the 26-char suffix.
 */
function stamp(
  records: readonly MemoryRecord[],
  namespace: string,
  idPrefix: string,
  tag: string,
): MemoryRecord[] {
  return records.map((r, i) => {
    // prefix (4) + tag (2) + digits (20) = 26 chars
    const suffix = `${idPrefix}${tag}${i.toString().padStart(20, '0')}`;
    return {
      ...r,
      record_id: `mr_${suffix}`,
      namespace,
    };
  });
}

/**
 * Build a Crockford-safe 26-char record_id suffix from a 4-char prefix
 * and a 22-char tag (e.g. `SUMMARY000000000000000`). The result is
 * suitable for `mr_${suffix}` and will satisfy `RECORD_ID_RE`.
 */
function makeRecordId(idPrefix: string, tag22: string): string {
  // `tag22` must already contain only Crockford alphabet characters.
  return `mr_${idPrefix}${tag22}`;
}

/** A short Crockford base32 tag used as part of a `record_id` prefix. */
const idPrefixArb = fc
  .stringMatching(/^[0-9A-HJKMNP-TV-Z]{4}$/)
  .filter((s) => s.length === 4);

/* ────────────────────────────────────────────────────────────────────
 * Property 15 — Merge commit semantics
 *
 * Seed 3..8 arbitrary memory records in one namespace. Pick a
 * non-empty subset to merge. Build a fresh summary record and commit
 * the merge inside `withTransaction`. After the commit:
 *
 * 1. Every merged id is absent from `listMemoryRecords({namespace})`.
 * 2. Every merged id has no FTS5 entry (probed directly).
 * 3. Every merged id's embedding is absent (row gone → getEmbedding null).
 * 4. The summary record is readable by its own `record_id`.
 * 5. No non-merged id is mutated or deleted — its stored record still
 *    deep-equals the seeded value.
 * ──────────────────────────────────────────────────────────────────── */

describe('SQLite backend — property: merge commit semantics (P15)', () => {
  it('summary written, merged rows + FTS5 + embeddings gone, other rows intact', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbitraryMemoryRecord(), { minLength: 3, maxLength: 8 }),
        arbitraryMemoryRecord(),
        idPrefixArb,
        // Chosen size of the merge subset. We cap at the seed length
        // minus one so at least one seeded record is NOT merged — the
        // "no row outside the merged set is mutated" assertion needs a
        // witness.
        fc.integer({ min: 1, max: 7 }),
        async (seedRecords, summaryTemplate, idPrefix, mergeCountRaw) => {
          const namespace = '/actor/pbt/project/merge/';
          const seeded = stamp(seedRecords, namespace, idPrefix, 'SD');
          const mergeCount = Math.min(mergeCountRaw, seeded.length - 1);
          if (mergeCount < 1) return; // skip degenerate shrinks

          const s = openScratch();
          try {
            // Seed: insert each record and attach an embedding. The
            // embedding is what Property 15's "embedding is absent after
            // merge" clause observes.
            for (const r of seeded) {
              await s.storage.putMemoryRecord(r);
              await s.storage.putEmbedding(r.record_id, seededEmbedding(r.record_id));
            }

            // Choose the merged subset as the first `mergeCount`
            // records. Deterministic on the input arrays so a failing
            // shrink is reproducible.
            const mergedIds = seeded.slice(0, mergeCount).map((r) => r.record_id);
            const untouched = seeded.slice(mergeCount);

            // Construct a fresh summary record that lands in the same
            // namespace. `record_id` is re-stamped so it never collides
            // with the seeded set. 22 Crockford-safe chars after the
            // 4-char prefix = the required 26-char suffix.
            const summary: MemoryRecord = {
              ...summaryTemplate,
              record_id: makeRecordId(idPrefix, 'SMRY00000000000000000000'.slice(0, 22)),
              namespace,
              strategy: 'llm-reconciled',
            };

            const summaryVec = seededEmbedding(summary.record_id);

            // Commit the merge via withTransaction. This is the exact
            // call pattern the reconciler uses.
            await s.storage.withTransaction((tx) => {
              tx.putMemoryRecord(summary);
              tx.deleteMemoryRecord(mergedIds);
              tx.putEmbedding(summary.record_id, summaryVec);
            });

            // 1. Every merged id is absent from the namespace listing.
            const listing = await s.storage.listMemoryRecords({
              namespace,
              limit: 100,
              offset: 0,
            });
            const listedIds = new Set(listing.items.map((r) => r.record_id));
            for (const id of mergedIds) {
              expect(listedIds.has(id)).toBe(false);
            }

            // 2. FTS5 companion rows for merged ids are gone.
            for (const id of mergedIds) {
              expect(countFtsRows(s.dbPath, id)).toBe(0);
            }

            // 3. Embeddings for merged ids are gone (row gone → null).
            for (const id of mergedIds) {
              expect(await s.storage.getEmbedding(id)).toBeNull();
            }

            // 4. Summary is readable by its id, and its embedding round-trips.
            expect(listedIds.has(summary.record_id)).toBe(true);
            const storedSummary = listing.items.find(
              (r) => r.record_id === summary.record_id,
            );
            expect(storedSummary).toBeDefined();
            const storedSummaryEmbedding = await s.storage.getEmbedding(summary.record_id);
            expect(storedSummaryEmbedding).not.toBeNull();
            expect(storedSummaryEmbedding!.length).toBe(summaryVec.length);

            // 5. No non-merged row is mutated. Every `untouched` record
            //    must still appear in the listing with unchanged fields.
            for (const r of untouched) {
              const stored = listing.items.find((x) => x.record_id === r.record_id);
              expect(stored).toBeDefined();
              // Deep-equal every stored field against the seeded record
              // (round-trip integrity of the untouched rows).
              expect(stored).toEqual(r);
              // Its embedding is still present, too.
              expect(await s.storage.getEmbedding(r.record_id)).not.toBeNull();
            }
          } finally {
            await cleanupScratch(s);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

/* ────────────────────────────────────────────────────────────────────
 * Property 18 — Summary-commit atomicity
 *
 * Seed 3..8 records. Inside a `withTransaction` body:
 *   - put a new summary
 *   - delete a non-empty subset of seeded records
 *   - put the summary's embedding
 *   - THROW
 *
 * After the throw, every one of those intended writes MUST be rolled
 * back: the summary is absent, every "would-be-deleted" record is still
 * present (primary row + FTS5 + embedding), and no other row is affected.
 * ──────────────────────────────────────────────────────────────────── */

describe('SQLite backend — property: summary-commit atomicity (P18)', () => {
  it('injected failure inside withTransaction rolls back put + delete + put-embedding atomically', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbitraryMemoryRecord(), { minLength: 3, maxLength: 8 }),
        arbitraryMemoryRecord(),
        idPrefixArb,
        fc.integer({ min: 2, max: 7 }),
        async (seedRecords, summaryTemplate, idPrefix, deleteCountRaw) => {
          const namespace = '/actor/pbt/project/rollback/';
          const seeded = stamp(seedRecords, namespace, idPrefix, 'AT');
          // Require at least 2 deletes so "multiple rows rolled back" is
          // exercised, and leave at least one record untouched for the
          // non-mutation witness.
          const deleteCount = Math.min(deleteCountRaw, seeded.length - 1);
          if (deleteCount < 2) return;

          const s = openScratch();
          try {
            // Seed: every record gets an embedding, so the rollback
            // must restore both the row and its embedding.
            for (const r of seeded) {
              await s.storage.putMemoryRecord(r);
              await s.storage.putEmbedding(r.record_id, seededEmbedding(r.record_id));
            }

            const toDelete = seeded.slice(0, deleteCount);
            const toDeleteIds = toDelete.map((r) => r.record_id);

            const summary: MemoryRecord = {
              ...summaryTemplate,
              record_id: makeRecordId(idPrefix, 'RBCK00000000000000000000'.slice(0, 22)),
              namespace,
              strategy: 'llm-reconciled',
            };

            // Sentinel the caller throws from inside the tx body. We
            // match on identity (`rejects.toBe`) so any other thrown
            // error would fail the property.
            const trigger = new Error('pbt-injected rollback');

            await expect(
              s.storage.withTransaction((tx) => {
                tx.putMemoryRecord(summary);
                tx.deleteMemoryRecord(toDeleteIds);
                tx.putEmbedding(
                  summary.record_id,
                  seededEmbedding(summary.record_id),
                );
                throw trigger;
              }),
            ).rejects.toBe(trigger);

            // The summary row is absent at every level.
            const listing = await s.storage.listMemoryRecords({
              namespace,
              limit: 100,
              offset: 0,
            });
            const listedIds = new Set(listing.items.map((r) => r.record_id));
            expect(listedIds.has(summary.record_id)).toBe(false);
            expect(countFtsRows(s.dbPath, summary.record_id)).toBe(0);
            expect(await s.storage.getEmbedding(summary.record_id)).toBeNull();

            // Every "would-be-deleted" record is still present, its
            // FTS5 row still there, its embedding still not nulled.
            for (const r of toDelete) {
              expect(listedIds.has(r.record_id)).toBe(true);
              const stored = listing.items.find(
                (x) => x.record_id === r.record_id,
              );
              expect(stored).toEqual(r);
              expect(countFtsRows(s.dbPath, r.record_id)).toBe(1);
              expect(await s.storage.getEmbedding(r.record_id)).not.toBeNull();
            }

            // The remaining seeded records are unaffected.
            for (const r of seeded.slice(deleteCount)) {
              const stored = listing.items.find(
                (x) => x.record_id === r.record_id,
              );
              expect(stored).toEqual(r);
              expect(await s.storage.getEmbedding(r.record_id)).not.toBeNull();
            }
          } finally {
            await cleanupScratch(s);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
