/**
 * Unit tests for MCP tool handlers and formatting from `src/mcp/tools.ts`.
 *
 * Mocks the HTTP client (`src/mcp/client.ts`) so tests exercise validation,
 * formatting, and error-handling logic without a real collector.
 *
 * @see Requirements 2.1–2.4, 3.1–3.6, 4.1–4.5, 5.1–5.4, 7.1–7.5, 13.1–13.3
 */

import { describe, expect, it, vi } from 'vitest';

import type { CollectorClientConfig, MemoryRecordPayload } from '../../src/mcp/client.js';
import type { ToolContext } from '../../src/mcp/tools.js';

// ── Mock the HTTP client ────────────────────────────────────────────────

vi.mock('../../src/mcp/client.js', () => ({
  postMemory: vi.fn(),
  searchMemories: vi.fn(),
}));

// Import after mock so vitest intercepts the module
const { postMemory, searchMemories } = await import('../../src/mcp/client.js');
const {
  handleSearchMemory,
  handleSaveObservation,
  handleSaveSessionSummary,
  formatSearchResults,
} = await import('../../src/mcp/tools.js');

// ── Shared fixtures ─────────────────────────────────────────────────────

const ctx: ToolContext = {
  namespace: '/actor/testuser/project/abc123def456abc123def456abc123def456abc123def456abc123def456abcd1234/',
  config: { host: '127.0.0.1', port: 21100, timeoutMs: 5000 } satisfies CollectorClientConfig,
};

function makeRecord(overrides: Partial<MemoryRecordPayload> = {}): MemoryRecordPayload {
  return {
    record_id: 'mr_01JXYZ01JXYZ01JXYZ01JXYZ01',
    namespace: ctx.namespace,
    strategy: 'mcp_observation',
    title: 'Auth flow uses JWT tokens',
    summary: 'The authentication flow relies on short-lived JWT tokens.',
    facts: ['JWT tokens expire after 1 hour'],
    source_event_ids: ['01JXYZ01JXYZ01JXYZ01JXYZ01'],
    created_at: '2025-01-15T10:30:00.000Z',
    concepts: ['authentication', 'JWT'],
    files_touched: ['src/auth/index.ts'],
    observation_type: 'discovery',
    ...overrides,
  };
}

// ── handleSearchMemory ──────────────────────────────────────────────────

describe('handleSearchMemory', () => {
  it('happy path — returns formatted text from mocked client records', async () => {
    const records = [makeRecord()];
    vi.mocked(searchMemories).mockResolvedValueOnce({ ok: true, records });

    const result = await handleSearchMemory({ query: 'auth flow' }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).toContain('Auth flow uses JWT tokens');
    expect(result.content[0]!.text).toContain('authentication');
  });

  it('empty query → error result with "query must be non-empty"', async () => {
    const result = await handleSearchMemory({ query: '' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('query must be non-empty');
  });
});

// ── handleSaveObservation ───────────────────────────────────────────────

describe('handleSaveObservation', () => {
  it('happy path → confirmation with record_id starting with "mr_"', async () => {
    vi.mocked(postMemory).mockResolvedValueOnce({
      ok: true,
      record_id: 'mr_01JXYZ01JXYZ01JXYZ01JXYZ01',
      stored: true,
    });

    const result = await handleSaveObservation(
      {
        title: 'Test observation',
        summary: 'A test summary',
        observation_type: 'discovery',
        concepts: ['testing'],
        files_touched: ['src/test.ts'],
        facts: ['fact one'],
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/^Saved observation mr_/);
  });

  it('invalid observation_type → error result', async () => {
    const result = await handleSaveObservation(
      {
        title: 'Test',
        summary: 'A summary',
        observation_type: 'invalid_type',
        concepts: [],
        files_touched: [],
        facts: [],
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('observation_type must be one of');
  });
});

// ── handleSaveSessionSummary ────────────────────────────────────────────

describe('handleSaveSessionSummary', () => {
  it('happy path → confirmation with record_id', async () => {
    vi.mocked(postMemory).mockResolvedValueOnce({
      ok: true,
      record_id: 'mr_01JXYZ01JXYZ01JXYZ01JXYZ01',
      stored: true,
    });

    const result = await handleSaveSessionSummary(
      {
        request: 'Fix the login bug',
        investigated: 'Looked at auth module',
        learned: 'Token expiry was wrong',
        completed: 'Fixed token refresh',
        next_steps: 'Add tests',
        files_read: ['src/auth.ts'],
        files_modified: ['src/auth.ts'],
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/^Saved session summary mr_/);
  });

  it('title truncation to 200 chars — request > 200 chars', async () => {
    vi.mocked(postMemory).mockImplementationOnce(async (record) => {
      // Verify the title was truncated
      expect(record.title.length).toBeLessThanOrEqual(200);
      return { ok: true, record_id: record.record_id, stored: true };
    });

    const longRequest = 'A'.repeat(300);
    const result = await handleSaveSessionSummary(
      {
        request: longRequest,
        investigated: 'investigated',
        learned: 'learned',
        completed: 'completed',
        next_steps: 'next',
        files_read: [],
        files_modified: [],
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(postMemory).toHaveBeenCalled();
  });

  it('summary truncation to 4000 chars — very long fields', async () => {
    vi.mocked(postMemory).mockImplementationOnce(async (record) => {
      // Verify the summary was truncated to at most 4000 chars
      expect(record.summary.length).toBeLessThanOrEqual(4000);
      return { ok: true, record_id: record.record_id, stored: true };
    });

    const longField = 'X'.repeat(2000);
    const result = await handleSaveSessionSummary(
      {
        request: 'short request',
        investigated: longField,
        learned: longField,
        completed: longField,
        next_steps: longField,
        files_read: [],
        files_modified: [],
      },
      ctx,
    );

    expect(result.isError).toBeUndefined();
    expect(postMemory).toHaveBeenCalled();
  });
});

// ── Error handling — collector errors ───────────────────────────────────

describe('error handling', () => {
  it('connection_refused → error result (server continues)', async () => {
    vi.mocked(searchMemories).mockResolvedValueOnce({
      ok: false,
      error: {
        type: 'connection_refused',
        message: 'The kiro-learn collector is not running. Start it with `kiro-learn start`.',
      },
    });

    const result = await handleSearchMemory({ query: 'test' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('collector is not running');
  });

  it('timeout → error result (server continues)', async () => {
    vi.mocked(searchMemories).mockResolvedValueOnce({
      ok: false,
      error: {
        type: 'timeout',
        message: 'Request to collector timed out after 5 seconds.',
      },
    });

    const result = await handleSearchMemory({ query: 'test' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('timed out');
  });
});

// ── formatSearchResults ─────────────────────────────────────────────────

describe('formatSearchResults', () => {
  it('zero results → "No matching memories found for the current project."', () => {
    const text = formatSearchResults([]);
    expect(text).toBe('No matching memories found for the current project.');
  });

  it('multiple results → correct text format with titles, summaries, concepts, files', () => {
    const records = [
      makeRecord({
        title: 'First record',
        summary: 'Summary one',
        concepts: ['concept-a', 'concept-b'],
        files_touched: ['file1.ts', 'file2.ts'],
      }),
      makeRecord({
        title: 'Second record',
        summary: 'Summary two',
        concepts: ['concept-c'],
        files_touched: ['file3.ts'],
      }),
    ];

    const text = formatSearchResults(records);

    // Titles present
    expect(text).toContain('### First record');
    expect(text).toContain('### Second record');

    // Summaries present
    expect(text).toContain('Summary one');
    expect(text).toContain('Summary two');

    // Concepts present (comma-separated)
    expect(text).toContain('concept-a, concept-b');
    expect(text).toContain('concept-c');

    // Files present
    expect(text).toContain('file1.ts');
    expect(text).toContain('file2.ts');
    expect(text).toContain('file3.ts');

    // Records separated by blank line
    const blocks = text.split('\n\n');
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });
});
