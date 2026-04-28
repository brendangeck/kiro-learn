// Feature: mcp-memory-server, Property 6: Session summary construction respects size limits and includes all fields

/**
 * Property-based test for session summary construction.
 *
 * @see .kiro/specs/mcp-memory-server/design.md § Property 6
 * @see .kiro/specs/mcp-memory-server/requirements.md § 5.3, 5.4
 */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import type { MemoryRecordPayload } from '../../src/mcp/client.js';
import type { ToolContext } from '../../src/mcp/tools.js';
import { arbitrarySessionSummaryArgs } from '../helpers/arbitrary.js';

// Mock the client module before importing tools (which depends on it)
vi.mock('../../src/mcp/client.js', () => ({
  postMemory: vi.fn(),
  searchMemories: vi.fn(),
  loadCollectorConfig: vi.fn().mockReturnValue({
    host: '127.0.0.1',
    port: 21100,
    timeoutMs: 5000,
  }),
}));

// Import after mock so vitest intercepts the module
const { postMemory } = await import('../../src/mcp/client.js');
const { handleSaveSessionSummary } = await import('../../src/mcp/tools.js');

describe('Session summary construction — property tests', () => {
  it('Property 6: constructed record has title ≤200, summary ≤4000, and includes body fields', async () => {
    /**
     * **Validates: Requirements 5.3, 5.4**
     *
     * For any valid session summary input, the constructed record has
     * title ≤200, summary ≤4000. When total length permits, summary
     * contains substrings from each body field.
     */
    await fc.assert(
      fc.asyncProperty(arbitrarySessionSummaryArgs(), async (args) => {
        let capturedRecord: MemoryRecordPayload | undefined;

        vi.mocked(postMemory).mockImplementation(
          async (record: MemoryRecordPayload) => {
            capturedRecord = record;
            return {
              ok: true as const,
              record_id: record.record_id,
              stored: true,
            };
          },
        );

        const ctx: ToolContext = {
          namespace: '/actor/test/project/abc123/',
          config: { host: '127.0.0.1', port: 21100, timeoutMs: 5000 },
        };

        await handleSaveSessionSummary(
          args as unknown as Record<string, unknown>,
          ctx,
        );

        expect(capturedRecord).toBeDefined();
        const record = capturedRecord!;

        // Title must be ≤200 characters
        expect(record.title.length).toBeLessThanOrEqual(200);

        // Summary must be ≤4000 characters
        expect(record.summary.length).toBeLessThanOrEqual(4000);

        // When total length permits, summary should contain each body field
        const bodyFields = [
          args.investigated,
          args.learned,
          args.completed,
          args.next_steps,
        ];

        // Calculate the full formatted summary length
        const fullLength =
          '## What was investigated\n'.length +
          args.investigated.length +
          '\n\n## What was learned\n'.length +
          args.learned.length +
          '\n\n## What was completed\n'.length +
          args.completed.length +
          '\n\n## Next steps\n'.length +
          args.next_steps.length;

        if (fullLength <= 4000) {
          for (const field of bodyFields) {
            expect(record.summary).toContain(field);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
