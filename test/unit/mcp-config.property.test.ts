// Feature: mcp-memory-server, Property 7: Config loading returns valid host/port or defaults

/**
 * Property-based test for collector config loading.
 *
 * @see .kiro/specs/mcp-memory-server/design.md § Property 7
 * @see .kiro/specs/mcp-memory-server/requirements.md § 6.2
 */

import type * as nodeFs from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeFs;
  return {
    ...original,
    readFileSync: vi.fn(),
  };
});

import { readFileSync } from 'node:fs';

import { loadCollectorConfig } from '../../src/mcp/client.js';

const mockedReadFileSync = vi.mocked(readFileSync);

describe('Config loading — property tests', () => {
  it('Property 7: returns non-empty host and positive port for any settings.json content', () => {
    /**
     * **Validates: Requirements 6.2**
     *
     * For any settings.json content (valid, invalid, missing),
     * `loadCollectorConfig` returns non-empty host and positive port.
     * When the file is missing or malformed, the returned values equal
     * the defaults ('127.0.0.1' and 21100).
     */
    const configScenario = fc.oneof(
      // Valid config with collector section
      fc
        .record({
          host: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.length > 0),
          port: fc.integer({ min: 1, max: 65535 }),
        })
        .map((c) => ({
          type: 'valid' as const,
          content: JSON.stringify({ collector: { host: c.host, port: c.port } }),
          expectedHost: c.host,
          expectedPort: c.port,
        })),
      // Valid JSON without collector section
      fc.jsonValue()
        .filter((v) => v === null || typeof v !== 'object' || Array.isArray(v) || !('collector' in (v as object)))
        .map((v) => ({
          type: 'no-collector' as const,
          content: JSON.stringify(v),
          expectedHost: '127.0.0.1',
          expectedPort: 21100,
        })),
      // Invalid JSON
      fc
        .string({ minLength: 1, maxLength: 500 })
        .filter((s) => {
          try {
            JSON.parse(s);
            return false;
          } catch {
            return true;
          }
        })
        .map((s) => ({
          type: 'invalid-json' as const,
          content: s,
          expectedHost: '127.0.0.1',
          expectedPort: 21100,
        })),
      // Missing file (throws ENOENT)
      fc.constant({
        type: 'missing' as const,
        content: null as string | null,
        expectedHost: '127.0.0.1',
        expectedPort: 21100,
      }),
    );

    fc.assert(
      fc.property(configScenario, (scenario) => {
        if (scenario.content === null) {
          mockedReadFileSync.mockImplementation(() => {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          });
        } else {
          mockedReadFileSync.mockReturnValue(scenario.content);
        }

        const config = loadCollectorConfig();

        // Host must be a non-empty string
        expect(typeof config.host).toBe('string');
        expect(config.host.length).toBeGreaterThan(0);

        // Port must be a positive integer
        expect(typeof config.port).toBe('number');
        expect(config.port).toBeGreaterThan(0);

        // Assert scenario-specific expectations
        expect(config.host).toBe(scenario.expectedHost);
        expect(config.port).toBe(scenario.expectedPort);
      }),
      { numRuns: 100 },
    );
  });
});
