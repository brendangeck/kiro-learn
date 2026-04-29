/**
 * Property-based test for pipeline store-before-buffer ordering.
 *
 * Feature: workspace-buffer-pipeline, Property 9: Pipeline stores before buffering
 *
 * For any event processed by the pipeline with buffer mode enabled,
 * `putEvent()` is called before the buffer append, ensuring durable
 * storage in SQLite regardless of buffer append outcome.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Property 9
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 12.1, 14.2
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import type { StorageBackend } from '../../src/types/index.js';
import type { BufferStore } from '../../src/collector/buffer/store.js';
import type { BufferWatcher } from '../../src/collector/buffer/watcher.js';
import { arbitraryCleanEvent } from '../helpers/arbitrary.js';

// ── Mock ACP client ─────────────────────────────────────────────────────
// The extraction stage is created even in buffer mode, so we must mock
// the ACP client to prevent real kiro-cli spawning.

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: vi.fn(() =>
    Promise.resolve({
      sendPrompt: vi.fn(() => Promise.resolve('')),
      destroy: vi.fn(),
    }),
  ),
}));

describe('Pipeline stores before buffering (Property 9)', () => {
  it('putEvent is called before buffer append for any valid event', async () => {
    /**
     * **Validates: Requirements 12.1, 14.2**
     *
     * For any valid event processed with buffer mode enabled,
     * `putEvent()` is called before buffer append, ensuring durable
     * storage regardless of buffer outcome.
     */
    await fc.assert(
      fc.asyncProperty(arbitraryCleanEvent(), async (event) => {
        // Shared call-order tracker
        const callOrder: string[] = [];

        // Mock StorageBackend that records when putEvent is called
        const mockStorage: StorageBackend = {
          putEvent: vi.fn(async () => {
            callOrder.push('putEvent');
          }),
          getEventById: vi.fn(async () => null),
          putMemoryRecord: vi.fn(async () => undefined),
          searchMemoryRecords: vi.fn(async () => []),
          close: vi.fn(async () => undefined),
          getStats: vi.fn(async () => ({
            total_events: 0,
            total_memories: 0,
            total_projects: 0,
            total_concepts: 0,
            observation_types: {},
            event_kinds: {},
          })),
          listProjects: vi.fn(async () => []),
          listMemoryRecords: vi.fn(async () => ({ items: [], total: 0 })),
          listEvents: vi.fn(async () => ({ items: [], total: 0 })),
        };

        // Mock BufferStore that records when append is called
        const mockBufferStore: BufferStore = {
          append: vi.fn(async () => {
            callOrder.push('bufferAppend');
            return 100;
          }),
          snapshot: vi.fn(async () => []),
          size: vi.fn(async () => 0),
          bufferPath: vi.fn(() => '/tmp/test/buffer.ndjson'),
          listProjects: vi.fn(async () => []),
          clear: vi.fn(async () => undefined),
        };

        // Mock BufferWatcher that allows appends
        const mockBufferWatcher: BufferWatcher = {
          notifyAppend: vi.fn(() => true),
          notifyExtractionResult: vi.fn(),
          onExtraction: vi.fn(),
          close: vi.fn(),
          _getState: vi.fn(() => undefined),
        };

        // Import createPipeline (uses the mocked ACP client)
        const { createPipeline } = await import(
          '../../src/collector/pipeline/index.js'
        );

        const pipeline = createPipeline({
          storage: mockStorage,
          extractionConcurrency: 1,
          extractionQueueDepth: 10,
          extractionTimeout: 30_000,
          dedupMaxSize: 10_000,
          bufferStore: mockBufferStore,
          bufferWatcher: mockBufferWatcher,
          bufferEnabled: true,
        });

        await pipeline.process(event);

        // Verify both were called
        expect(callOrder).toContain('putEvent');
        expect(callOrder).toContain('bufferAppend');

        // Verify putEvent was called before bufferAppend
        const putEventIndex = callOrder.indexOf('putEvent');
        const bufferAppendIndex = callOrder.indexOf('bufferAppend');
        expect(putEventIndex).toBeLessThan(bufferAppendIndex);
      }),
      { numRuns: 50 },
    );
  });
});
