// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../../ui/src/App.js';

/**
 * Smoke test for the dashboard page.
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4
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
  projects: [],
};

const MOCK_EVENTS = {
  items: [],
  total: 0,
};

const MOCK_HEALTHZ = { status: 'ok', version: '0.1.0' };

beforeEach(() => {
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
});
