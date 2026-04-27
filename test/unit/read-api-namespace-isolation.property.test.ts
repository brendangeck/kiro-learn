/**
 * Property-based tests for namespace isolation on the read API.
 *
 * Feature: visualizer-read-api, Properties 1 + 2: namespace isolation on
 * memories and events.
 *
 * Seeds a fresh SQLite database with events and memories across multiple
 * namespaces, then asserts that `listMemoryRecords` and `listEvents` never
 * leak data from one namespace into another.
 *
 * @see .kiro/specs/visualizer-read-api/design.md § Property 1, Property 2
 * @see .kiro/specs/visualizer-read-api/requirements.md § Requirement 7.1, N9
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { openSqliteStorage } from '../../src/collector/storage/sqlite/index.js';
import type { StorageBackend } from '../../src/types/index.js';
import { arbitraryEvent, arbitraryMemoryRecord, namespaceArb } from '../helpers/arbitrary.js';

/* ── Scratch helpers (same pattern as sqlite-backend.property.test.ts) ── */

interface Scratch {
  tmpRoot: string;
  dbPath: string;
  storage: StorageBackend;
}

function openScratch(): Scratch {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-pbt-ns-iso-'));
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

describe('Read API — property: namespace isolation on memories and events (P1 + P2)', () => {
  it('listMemoryRecords and listEvents return only items matching the requested namespace', async () => {
    /**
     * **Validates: Requirements 7.1, N9**
     *
     * For any set of 2–4 distinct namespaces, each populated with 1–3
     * events and 1–3 memory records, calling `listMemoryRecords(ns)` and
     * `listEvents({ namespace: ns, limit: 200 })` for each namespace
     * MUST return only items whose `namespace` field equals `ns`.
     */
    await fc.assert(
      fc.asyncProperty(
        // Generate 2–4 distinct namespaces.
        fc
          .uniqueArray(namespaceArb(), { minLength: 2, maxLength: 4, comparator: 'IsStrictlyEqual' }),
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
              // Ensure unique event_id by appending the index in base32.
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
              // Ensure unique record_id by encoding the index.
              const suffix = i.toString(32).toUpperCase().padStart(4, '0');
              record.record_id = record.record_id.slice(0, -4) + suffix;
              await s.storage.putMemoryRecord(record);
              memoriesByNs.set(ns, (memoriesByNs.get(ns) ?? 0) + 1);
            }

            // For each namespace, verify isolation.
            for (const ns of namespaces) {
              const memories = await s.storage.listMemoryRecords(ns);
              const expectedMemories = memoriesByNs.get(ns) ?? 0;
              expect(memories.length).toBe(expectedMemories);
              for (const mem of memories) {
                expect(mem.namespace).toBe(ns);
              }

              const { items: events } = await s.storage.listEvents({
                namespace: ns,
                limit: 200,
              });
              const expectedEvents = eventsByNs.get(ns) ?? 0;
              expect(events.length).toBe(expectedEvents);
              for (const evt of events) {
                expect(evt.namespace).toBe(ns);
              }
            }
          } finally {
            await cleanupScratch(s);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
