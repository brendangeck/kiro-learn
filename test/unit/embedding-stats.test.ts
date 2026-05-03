/**
 * Unit tests for the stats surface (task 11.5).
 *
 * Validates that `StorageBackend.getStats()` populates the
 * `embeddings_present` and `embeddings_missing` fields correctly at
 * both global and namespace scope on a seeded fixture.
 *
 * The visualizer UI and operator dashboards rely on these counts to
 * communicate embedding coverage to the user (design §
 * observability). A wrong count here silently misrepresents the
 * state of the system.
 *
 * Fixture shape:
 *
 *   - Namespace A (`/actor/alice/project/a/`): 3 records, 2 with
 *     embeddings, 1 without.
 *   - Namespace B (`/actor/alice/project/b/`): 2 records, 0 with
 *     embeddings.
 *   - Namespace C (`/actor/alice/project/c/`): 1 record with an
 *     embedding.
 *
 *   Global expected: present=3, missing=3.
 *
 * Validates: Requirement 14.4
 *
 * @see src/collector/storage/sqlite/index.ts
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md § Stats surface
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { MemoryRecord, StorageBackend } from '../../src/types/index.js';

// ── Test lifecycle ──────────────────────────────────────────────────────

let tmpRoot: string;
let dbPath: string;
let storage: StorageBackend;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-stats-'));
  dbPath = join(tmpRoot, 'kiro-learn.db');
  storage = openSqliteStorage({ dbPath });
});

afterEach(async () => {
  try {
    await storage.close();
  } catch {
    /* swallow */
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────

const NS_A = '/actor/alice/project/a/';
const NS_B = '/actor/alice/project/b/';
const NS_C = '/actor/alice/project/c/';

/**
 * Build a Float32Array(384) with a distinct per-record pattern so
 * round-trip checks (should anyone add them later) can distinguish
 * individual records. The stats test itself doesn't read the vector
 * back — it only counts non-NULL columns — but a non-zero pattern
 * keeps the fixture honest.
 */
function makeVec(seed: number): Float32Array {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i += 1) {
    v[i] = Math.sin(seed * 0.17 + i * 0.003);
  }
  return v;
}

function makeRecord(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    record_id: 'mr_01JF8ZS4Z00000000000000001',
    namespace: NS_A,
    strategy: 'llm-summary',
    title: 'Example record',
    summary: 'A one-line summary of what happened in this session.',
    facts: ['fact one'],
    source_event_ids: ['01JF8ZS4Y00000000000000000'],
    created_at: '2026-04-23T20:00:00.000Z',
    concepts: ['testing'],
    files_touched: ['src/types/schemas.ts'],
    observation_type: 'tool_use',
    ...overrides,
  };
}

/**
 * Seed the shared fixture:
 *
 *   NS A (3 records): A1 + embedding, A2 + embedding, A3 NULL
 *   NS B (2 records): B1 NULL, B2 NULL
 *   NS C (1 record): C1 + embedding
 *
 *   → global: present=3, missing=3
 *   → NS A:   present=2, missing=1
 *   → NS B:   present=0, missing=2
 *   → NS C:   present=1, missing=0
 */
async function seedFixture(): Promise<void> {
  // NS A
  const a1 = makeRecord({
    record_id: 'mr_01JF8ZS4Z0000000000000000A',
    namespace: NS_A,
    title: 'A1',
    created_at: '2026-04-23T20:00:00.000Z',
  });
  const a2 = makeRecord({
    record_id: 'mr_01JF8ZS4Z0000000000000000B',
    namespace: NS_A,
    title: 'A2',
    created_at: '2026-04-23T20:00:01.000Z',
  });
  const a3 = makeRecord({
    record_id: 'mr_01JF8ZS4Z0000000000000000C',
    namespace: NS_A,
    title: 'A3',
    created_at: '2026-04-23T20:00:02.000Z',
  });

  // NS B
  const b1 = makeRecord({
    record_id: 'mr_01JF8ZS4Z0000000000000000D',
    namespace: NS_B,
    title: 'B1',
    created_at: '2026-04-23T20:00:03.000Z',
  });
  const b2 = makeRecord({
    record_id: 'mr_01JF8ZS4Z0000000000000000E',
    namespace: NS_B,
    title: 'B2',
    created_at: '2026-04-23T20:00:04.000Z',
  });

  // NS C
  const c1 = makeRecord({
    record_id: 'mr_01JF8ZS4Z0000000000000000F',
    namespace: NS_C,
    title: 'C1',
    created_at: '2026-04-23T20:00:05.000Z',
  });

  for (const r of [a1, a2, a3, b1, b2, c1]) {
    await storage.putMemoryRecord(r);
  }

  // Embeddings on A1, A2, C1 only.
  await storage.putEmbedding(a1.record_id, makeVec(1));
  await storage.putEmbedding(a2.record_id, makeVec(2));
  await storage.putEmbedding(c1.record_id, makeVec(3));
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('getStats — embedding coverage', () => {
  it('returns global present/missing counts across all namespaces', async () => {
    /**
     * **Validates: Requirement 14.4**
     *
     * Global stats must count every row in `memory_records`,
     * regardless of namespace, and split by `embedding IS NULL`.
     */
    await seedFixture();

    const stats = await storage.getStats();

    expect(stats.embeddings_present).toBe(3);
    expect(stats.embeddings_missing).toBe(3);
    expect(stats.total_memories).toBe(6);
  });

  it('returns per-namespace present/missing counts scoped to the given namespace', async () => {
    /**
     * **Validates: Requirement 14.4**
     *
     * Namespace-scoped stats must restrict both counts to the
     * given namespace — NS A has 2 present / 1 missing, NS B has
     * 0/2, NS C has 1/0.
     */
    await seedFixture();

    const a = await storage.getStats(NS_A);
    expect(a.embeddings_present).toBe(2);
    expect(a.embeddings_missing).toBe(1);
    expect(a.total_memories).toBe(3);

    const b = await storage.getStats(NS_B);
    expect(b.embeddings_present).toBe(0);
    expect(b.embeddings_missing).toBe(2);
    expect(b.total_memories).toBe(2);

    const c = await storage.getStats(NS_C);
    expect(c.embeddings_present).toBe(1);
    expect(c.embeddings_missing).toBe(0);
    expect(c.total_memories).toBe(1);
  });

  it('reports zero counts on an empty database at both scopes', async () => {
    /**
     * **Validates: Requirement 14.4**
     *
     * With no records stored, both scopes must return 0/0 —
     * no NULL coercion artefacts, no undefined.
     */
    const global = await storage.getStats();
    expect(global.embeddings_present).toBe(0);
    expect(global.embeddings_missing).toBe(0);

    const scoped = await storage.getStats(NS_A);
    expect(scoped.embeddings_present).toBe(0);
    expect(scoped.embeddings_missing).toBe(0);
  });

  it('updates counts correctly after embeddings are added post-hoc', async () => {
    /**
     * **Validates: Requirement 14.4**
     *
     * After a record is stored without an embedding and then
     * receives one via `putEmbedding` (mirroring the
     * BackfillWorker's write pattern), the counts must flip:
     * missing decreases by one, present increases by one.
     */
    const r = makeRecord({
      record_id: 'mr_01JF8ZS4Z0000000000000000X',
      namespace: NS_A,
      title: 'late embed',
    });

    await storage.putMemoryRecord(r);

    const before = await storage.getStats(NS_A);
    expect(before.embeddings_present).toBe(0);
    expect(before.embeddings_missing).toBe(1);

    await storage.putEmbedding(r.record_id, makeVec(42));

    const after = await storage.getStats(NS_A);
    expect(after.embeddings_present).toBe(1);
    expect(after.embeddings_missing).toBe(0);
  });
});
