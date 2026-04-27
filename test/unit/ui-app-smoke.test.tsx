// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../../ui/src/App.js';

/**
 * Smoke test for the dashboard page.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4
 *
 * Cloudscape components render responsive layouts that may duplicate DOM nodes
 * (e.g. a "virtual" hidden copy for measurement). We use getAllByText where
 * multiple matches are expected and assert length >= 1.
 */

const MOCK_STATS = {
  total_events: 42,
  total_memories: 17,
  total_projects: 3,
  total_concepts: 99,
  observation_types: {},
  event_kinds: {},
  projects: [
    {
      namespace: '/actor/alice/project/abc123/',
      project_id: 'abc123',
      display_name: 'Test Project',
      event_count: 10,
      memory_count: 1,
    },
  ],
};

const MOCK_EVENTS = {
  items: [],
  total: 0,
};

const MOCK_HEALTHZ = { status: 'ok', version: '0.1.0' };

const MOCK_MEMORIES = {
  items: [
    {
      record_id: 'mr_01JF8ZS4Y00000000000000000',
      namespace: '/actor/alice/project/abc123/',
      strategy: 'llm-summary',
      title: 'Implemented user authentication flow',
      summary: 'Added JWT-based auth with refresh tokens',
      facts: ['Uses RS256 signing', 'Tokens expire in 1h'],
      source_event_ids: ['01JF8ZS4Y00000000000000000'],
      created_at: '2026-04-23T20:00:00Z',
      concepts: ['authentication', 'jwt'],
      files_touched: ['src/auth/index.ts'],
      observation_type: 'tool_use' as const,
    },
  ],
  total: 1,
  limit: 500,
  offset: 0,
};

beforeEach(() => {
  // React Flow requires ResizeObserver which jsdom doesn't provide
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => {
      if (url === '/healthz') {
        return { ok: true, json: async () => MOCK_HEALTHZ };
      }
      if (url === '/v1/stats') {
        return { ok: true, json: async () => MOCK_STATS };
      }
      if (url.startsWith('/v1/events')) {
        return { ok: true, json: async () => MOCK_EVENTS };
      }
      if (url.startsWith('/v1/memories')) {
        return { ok: true, json: async () => MOCK_MEMORIES };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App dashboard smoke test', () => {
  it('renders the top navigation with "kiro-learn"', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('kiro-learn').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders mocked metric values from /v1/stats', async () => {
    render(<App />);
    await waitFor(() => {
      // total_memories = 17
      expect(screen.getAllByText('17').length).toBeGreaterThanOrEqual(1);
      // total_events = 42
      expect(screen.getAllByText('42').length).toBeGreaterThanOrEqual(1);
      // total_projects = 3
      expect(screen.getAllByText('3').length).toBeGreaterThanOrEqual(1);
      // total_concepts = 99
      expect(screen.getAllByText('99').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders "Recent Events" text', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText(/Recent Events/).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the "Memory Graph" header', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('Memory Graph').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('does not render "coming soon" text (Req 9.3)', async () => {
    render(<App />);
    await waitFor(() => {
      // Memories have loaded — graph should be rendered, not the placeholder
      expect(screen.getAllByText('Memory Graph').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it('renders at least one mocked memory title (Req 9.4)', async () => {
    render(<App />);
    await waitFor(() => {
      // The memory title "Implemented user authentication flow" is exactly 40 chars,
      // so the transform keeps it as-is. The MemoryNode renders it as plain text
      // inside a <div>, which should be queryable via screen.getByText.
      // React Flow renders custom nodes as plain DOM in jsdom (with ResizeObserver
      // stubbed), so the text should be findable.
      expect(
        screen.getAllByText('Implemented user authentication flow').length,
      ).toBeGreaterThanOrEqual(1);
    });
  });
});
