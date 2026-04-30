/**
 * Example tests for `createFts5Sanitizer` factory (task 7.2).
 *
 * Covers:
 * - Empty corpus: input with > K tokens falls back to first-K.
 * - Populated corpus: IDF ranking retains rare tokens over common ones.
 * - Casing: ranker lowercases for vocab lookup but preserves original casing.
 * - Vocab table detach: falls back to first-K without throwing.
 *
 * Validates: Requirements 4.1, 4.2, 4.4, 4.5, 5.1, 5.3, 6.1
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFts5Sanitizer } from '../../src/collector/storage/sqlite/fts5.js';
import { MIGRATIONS, runMigrations } from '../../src/collector/storage/sqlite/migrations/index.js';
import { prepareStatements } from '../../src/collector/storage/sqlite/statements.js';
import type { Statements } from '../../src/collector/storage/sqlite/statements.js';

import { makeValidRecord } from '../helpers/fixtures.js';

let db: InstanceType<typeof Database>;
let stmts: Statements;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, MIGRATIONS);
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS memory_records_fts_vocab
     USING fts5vocab(memory_records_fts, 'row')`,
  );
  stmts = prepareStatements(db);
});

afterEach(() => {
  db.close();
});

/**
 * Helper: insert a memory record into both the primary table and FTS index.
 */
function seedRecord(record: ReturnType<typeof makeValidRecord>): void {
  stmts.insertMemoryRecord.run(
    record.record_id,
    record.namespace,
    record.strategy,
    record.title,
    record.summary,
    JSON.stringify(record.facts),
    JSON.stringify(record.source_event_ids),
    record.created_at,
    JSON.stringify(record.concepts),
    JSON.stringify(record.files_touched),
    record.observation_type,
  );
  stmts.insertMemoryRecordFts.run(
    record.record_id,
    record.namespace,
    record.title,
    record.summary,
    record.facts.join(' '),
  );
}

describe('createFts5Sanitizer — empty corpus (task 7.2)', () => {
  it('input with > K tokens falls back to first-K and returns a valid OR expression', () => {
    const sanitize = createFts5Sanitizer(stmts, { termCap: 3 });

    // 5 unique tokens, cap at 3 → first 3 retained
    const result = sanitize('alpha beta gamma delta epsilon');

    expect(result).toBe('"alpha" OR "beta" OR "gamma"');
  });

  it('input with <= K tokens retains all tokens', () => {
    const sanitize = createFts5Sanitizer(stmts, { termCap: 10 });

    const result = sanitize('one two three');

    expect(result).toBe('"one" OR "two" OR "three"');
  });

  it('empty input returns empty string', () => {
    const sanitize = createFts5Sanitizer(stmts);

    expect(sanitize('')).toBe('');
    expect(sanitize('   ')).toBe('');
  });
});

describe('createFts5Sanitizer — populated corpus (task 7.2)', () => {
  it('IDF ranking retains rare tokens over common ones', () => {
    // Seed multiple records where "the" appears in many and "syzygy" in one.
    // This gives "the" a high df (low IDF) and "syzygy" a low df (high IDF).
    for (let i = 0; i < 5; i++) {
      seedRecord(
        makeValidRecord({
          record_id: `mr_01JF8ZS4Z0000000000000010${String(i)}`,
          title: `The common record ${String(i)}`,
          summary: `the quick brown fox jumped over the lazy dog ${String(i)}`,
          facts: [`the fact ${String(i)}`],
        }),
      );
    }
    // One record with "syzygy"
    seedRecord(
      makeValidRecord({
        record_id: 'mr_01JF8ZS4Z00000000000000200',
        title: 'Syzygy alignment',
        summary: 'A rare syzygy event was observed',
        facts: ['syzygy observed'],
      }),
    );

    // Input: "the syzygy the the" → dedup → ["the", "syzygy"] (2 unique tokens)
    // With cap = 1, tokens.length > K triggers the ranker:
    const sanitize1 = createFts5Sanitizer(stmts, { termCap: 1 });
    const result = sanitize1('the syzygy the the');

    // "syzygy" has lower df (higher IDF) → retained over "the"
    expect(result).toBe('"syzygy"');

    // With cap = 2, tokens.length <= K so all tokens retained in original order
    // (no ranking needed when everything fits within the cap).
    const sanitize2 = createFts5Sanitizer(stmts, { termCap: 2 });
    const result2 = sanitize2('the syzygy the the');
    expect(result2).toBe('"the" OR "syzygy"');
  });
});

describe('createFts5Sanitizer — casing preservation (task 7.2)', () => {
  it('lowercases for vocab lookup but preserves original casing in output', () => {
    // Seed a record with "json" (lowercased by FTS5 tokenizer)
    seedRecord(
      makeValidRecord({
        record_id: 'mr_01JF8ZS4Z00000000000000300',
        title: 'JSON parsing guide',
        summary: 'How to parse JSON in TypeScript',
        facts: ['json is a data format'],
      }),
    );
    // Seed several records without "json" to make it relatively rare
    for (let i = 0; i < 5; i++) {
      seedRecord(
        makeValidRecord({
          record_id: `mr_01JF8ZS4Z0000000000000031${String(i)}`,
          title: `Common record ${String(i)}`,
          summary: `the quick brown fox ${String(i)}`,
          facts: [`common fact ${String(i)}`],
        }),
      );
    }

    const sanitize = createFts5Sanitizer(stmts, { termCap: 1 });

    // "JSON" (uppercase) should be looked up as "json" in vocab,
    // but the output preserves the original "JSON" casing.
    const result = sanitize('the JSON');

    // "json" has df=1 (high IDF), "the" has df=5 (low IDF) → "JSON" wins
    expect(result).toBe('"JSON"');
  });
});

describe('createFts5Sanitizer — vocab table detach fallback (task 7.2)', () => {
  it('falls back to first-K without throwing after vocab table is dropped', () => {
    // Seed some data so the corpus is non-empty
    seedRecord(
      makeValidRecord({
        record_id: 'mr_01JF8ZS4Z00000000000000400',
        title: 'Some record',
        summary: 'content for the corpus',
        facts: ['a fact'],
      }),
    );

    // Construct the sanitizer while vocab table exists
    const sanitize = createFts5Sanitizer(stmts, { termCap: 2 });

    // Drop the vocab table to simulate detachment
    db.exec('DROP TABLE memory_records_fts_vocab');

    // Should not throw — falls back to first-K
    const result = sanitize('alpha beta gamma delta');

    // First 2 tokens retained (first-K fallback)
    expect(result).toBe('"alpha" OR "beta"');
  });
});
