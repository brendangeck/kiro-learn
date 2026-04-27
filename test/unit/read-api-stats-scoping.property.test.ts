/**
 * Property-based tests for stats scoping on the read API.
 *
 * Feature: visualizer-read-api, Property 3: stats counts match
 * namespace-filtered data.
 *
 * Seeds a fresh SQLite database with events and memories across multiple
 * namespaces, then asserts that `getStats(ns)` returns counts that match
 * the actual number of events and memories seeded for that namespace, and
 * that global `getStats()` returns correct totals across all namespaces.
 *
 * @see .kiro/specs/visualizer-read-api/design.md § Property 3
 * @see .kiro/specs/visualizer-read-api/requirements.md § Requirement 7.2, N9
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { StorageBackend } from '../../src/types/index.js';
import { arbitraryEvent, arbitraryMemoryRecord, namespaceArb } from '../helpers/arbitrary.js';

/* ── Scratch helpers (same pattern as read-api-namespace-isolation) ──── */

interface Scratch {
  tmpRoot: string;
  dbPath: string;
  storage: StorageBackend;
}

function openScratch(): Scratch {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-pbt-stats-'));
  const dbPath = join(tmpRoot, 'kiro-learn.db');
  const storage = openSqliteStorage({ dbPath });
  return { tmpRoot, dbPath, storage };
}

async function cleanupScratch(s: Scratch): Promise<void> {
  try {
    await s.storage.close();
  } catch {
    // ignore
  }
  rmSync(s.tmpRoot, { recursive: true, force: true });
}

/* ── Property test ──────────────────────────────────────────────────── */

describe('Read API — property: stats scoping (P3)', () => {
  it('getStats(ns) counts match the number of events and memories seeded for that namespace', async () => {
    /**
     * **Validates: Requirements 7.2, N9**
     *
     * For any set of 2–4 distinct namespaces, each populated with 1–3
     * events and 1–3 memory records, calling `getStats(ns)` for each
     * namespace MUST return `total_events` and `total_memories` equal to
     * the count of items seeded with that namespace. Additionally, global
     * `getStats()` (no namespace) MUST return totals equal to the sum
     * across all namespaces.
     */
    await fc.assert(
      fc.asyncProperty(
        // Generate 2–4 distinct namespaces.
        fc.uniqueArray(namespaceArb(), { minLength: 2, maxLength: 4, comparator: 'IsStrictlyEqual' }),
        // Generate a pool of events and memories to distribute.
        fc.array(arbitraryEvent(), { minLength: 2, maxLength: 8 }),
        fc.array(arbitraryMemoryRecord(), { minLength: 2, maxLength: 8 }),
        async (namespaces, eventPool, memoryPool) => {
          const s = openScratch();
          try {
            // Track which namespace each event/memory was assigned to.
            const eventsByNs = new Map<string, number>();
            const memoriesByNs = new Map<string, number>();
            for (const ns of namespaces) {
              eventsByNs.set(ns, 0);
              memoriesByNs.set(ns, 0);
            }

            // Distribute events across namespaces round-robin, stamping
            // each with a unique event_id suffix to avoid PK collisions.
            for (let i = 0; i < eventPool.length; i++) {
              const ns = namespaces[i % namespaces.length]!;
              const event = { ...eventPool[i]!, namespace: ns };
              const suffix = i.toString(32).toUpperCase().padStart(4, '0');
              event.event_id = event.event_id.slice(0, 22) + suffix;
              await s.storage.putEvent(event);
              eventsByNs.set(ns, (eventsByNs.get(ns) ?? 0) + 1);
            }

            // Distribute memories across namespaces round-robin with
            // unique record_ids.
            for (let i = 0; i < memoryPool.length; i++) {
              const ns = namespaces[i % namespaces.length]!;
              const record = { ...memoryPool[i]!, namespace: ns };
              const suffix = i.toString(32).toUpperCase().padStart(4, '0');
              record.record_id = record.record_id.slice(0, -4) + suffix;
              await s.storage.putMemoryRecord(record);
              memoriesByNs.set(ns, (memoriesByNs.get(ns) ?? 0) + 1);
            }

            // For each namespace, verify scoped stats match seeded counts.
            for (const ns of namespaces) {
              const stats = await s.storage.getStats(ns);
              expect(stats.total_events).toBe(eventsByNs.get(ns));
              expect(stats.total_memories).toBe(memoriesByNs.get(ns));
            }

            // Verify global stats match the sum across all namespaces.
            const globalStats = await s.storage.getStats();
            const totalEvents = [...eventsByNs.values()].reduce((a, b) => a + b, 0);
            const totalMemories = [...memoriesByNs.values()].reduce((a, b) => a + b, 0);
            expect(globalStats.total_events).toBe(totalEvents);
            expect(globalStats.total_memories).toBe(totalMemories);
          } finally {
            await cleanupScratch(s);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
