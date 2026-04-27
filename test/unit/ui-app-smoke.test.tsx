// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../../ui/src/App.js';

/**
 * Smoke test for the scaffold page.
 *
 * Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.8
 *
 * Cloudscape components render responsive layouts that may duplicate DOM nodes
 * (e.g. a "virtual" hidden copy for measurement). We use getAllByText where
 * multiple matches are expected and assert length >= 1.
 */

beforeEach(() => {
  // Mock fetch to return a successful healthz response
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', version: '0.8.0' }),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App scaffold smoke test', () => {
  it('renders the top navigation with "kiro-learn"', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('kiro-learn').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the "Total Memories" metric card', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('Total Memories').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the "Total Events" metric card', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('Total Events').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the "Projects" metric card', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('Projects').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the "Concepts" metric card', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('Concepts').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the "Memory Graph" header', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getAllByText('Memory Graph').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the graph placeholder body text', async () => {
    render(<App />);
    await waitFor(() => {
      expect(
        screen.getAllByText('Graph visualization coming soon').length,
      ).toBeGreaterThanOrEqual(1);
    });
  });
});
