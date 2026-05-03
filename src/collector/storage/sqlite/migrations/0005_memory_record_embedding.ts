/**
 * Migration 0005 — memory record embedding column.
 *
 * Adds a single nullable BLOB column to `memory_records` to hold the
 * local dense-vector embedding of each record, computed from the
 * Titan-parity sentence-transformer model (384 dims, fp32 little-endian
 * IEEE-754 → 1 536 bytes per row). The embedding is stored inline on the
 * record so hybrid retrieval (FTS5 lexical ∪ local ANN) can join lexical
 * hits back to the vector representation without a second index probe.
 *
 * - `embedding` — BLOB, NULLABLE, DEFAULT NULL. Written by the
 *                 embedding worker after a record is materialised; absent
 *                 (SQL NULL) until the worker backfills it. Readers must
 *                 treat NULL as "not yet embedded" and fall through to the
 *                 lexical-only path.
 *
 * Design notes:
 *
 * - Additive-only. No existing rows are rewritten, no indexes are
 *   created, and the FTS5 virtual table is untouched. `ALTER TABLE …
 *   ADD COLUMN` on SQLite is an O(1) metadata operation.
 * - NULL is the truthful representation for legacy rows and for rows
 *   the embedding worker has not yet processed. A synthetic DEFAULT
 *   (e.g. a zero-vector blob) would be indistinguishable from a
 *   genuine all-zero embedding and would defeat the "needs backfill"
 *   query pattern. Requirement 4.5 calls this out explicitly.
 * - No ANN index is created here. `sqlite-vec`'s virtual table (or any
 *   future replacement) is managed separately; the canonical vector
 *   storage lives on the record itself so a rebuild of the ANN index
 *   is always a pure read of this column.
 *
 * Validates: Requirements 4.1, 4.5, 4.6, 8.3
 */

import type { Migration } from './types.js';

export const DDL = `
ALTER TABLE memory_records ADD COLUMN embedding BLOB DEFAULT NULL;
`;

export const migration0005: Migration = {
  version: 5,
  name: '0005_memory_record_embedding',
  up: (db) => db.exec(DDL),
};
