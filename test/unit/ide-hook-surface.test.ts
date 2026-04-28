/**
 * Unit tests for the `buildEvent` surface parameter.
 *
 * Validates that the optional `surface` field on `EventBuildParams`
 * defaults to `'kiro-cli'` when omitted and propagates `'kiro-ide'`
 * when explicitly provided. Also verifies backward compatibility —
 * existing CLI shim callers that omit the parameter continue to get
 * `'kiro-cli'` without any code change.
 *
 * Test file: test/unit/ide-hook-surface.test.ts
 * Requirements: 5.2, 5.3, 5.4, N12
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir: string;

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpDir,
  };
});

const { buildEvent } = await import('../../src/shim/shared/index.js');
const { parseEvent } = await import('../../src/types/index.js');

describe('buildEvent — surface parameter', () => {
  let cwdDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'kiro-learn-surface-test-home-'));
    cwdDir = mkdtempSync(join(tmpdir(), 'kiro-learn-surface-test-'));
  });

  afterEach(() => {
    rmSync(cwdDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to kiro-cli when surface is omitted', () => {
    /**
     * Validates: Requirements 5.2, N12
     *
     * When the `surface` field is not provided in `EventBuildParams`,
     * `buildEvent` must default `source.surface` to `'kiro-cli'`.
     * This ensures backward compatibility for existing CLI shim callers.
     */
    const event = buildEvent({
      kind: 'prompt',
      body: { type: 'text', content: 'hello' },
      sessionId: 'sess-surface-1',
      cwd: cwdDir,
    });

    expect(event.source.surface).toBe('kiro-cli');
  });

  it('propagates kiro-ide to event.source.surface', () => {
    /**
     * Validates: Requirements 5.2, 5.3
     *
     * When `surface: 'kiro-ide'` is explicitly provided, the resulting
     * event must have `source.surface === 'kiro-ide'`.
     */
    const event = buildEvent({
      kind: 'prompt',
      body: { type: 'text', content: 'hello from IDE' },
      sessionId: 'sess-surface-2',
      cwd: cwdDir,
      surface: 'kiro-ide',
    });

    expect(event.source.surface).toBe('kiro-ide');
  });

  it('kiro-ide event passes parseEvent validation', () => {
    /**
     * Validates: Requirements 5.4
     *
     * An event with `source.surface: 'kiro-ide'` must pass the Zod
     * EventSchema validation, confirming that `'kiro-ide'` is a valid
     * surface value in the schema.
     */
    const event = buildEvent({
      kind: 'tool_use',
      body: {
        type: 'json',
        data: { tool_name: 'readFile', tool_input: {}, tool_response: {} },
      },
      sessionId: 'sess-surface-3',
      cwd: cwdDir,
      surface: 'kiro-ide',
    });

    expect(() => parseEvent(event)).not.toThrow();
    expect(event.source.surface).toBe('kiro-ide');
  });

  it('explicit kiro-cli surface matches default behavior', () => {
    /**
     * Validates: Requirements 5.3, N12
     *
     * Passing `surface: 'kiro-cli'` explicitly must produce the same
     * surface value as omitting the parameter entirely.
     */
    const eventDefault = buildEvent({
      kind: 'note',
      body: { type: 'text', content: 'test' },
      sessionId: 'sess-surface-4',
      cwd: cwdDir,
    });

    const eventExplicit = buildEvent({
      kind: 'note',
      body: { type: 'text', content: 'test' },
      sessionId: 'sess-surface-4',
      cwd: cwdDir,
      surface: 'kiro-cli',
    });

    expect(eventDefault.source.surface).toBe('kiro-cli');
    expect(eventExplicit.source.surface).toBe('kiro-cli');
  });

  it('surface does not affect other event fields', () => {
    /**
     * Validates: Requirements N12
     *
     * Changing the surface parameter must not alter any other event
     * fields (namespace, kind, body, schema_version, etc.). Only
     * `source.surface` should differ.
     */
    const eventCli = buildEvent({
      kind: 'session_summary',
      body: { type: 'text', content: 'summary text' },
      sessionId: 'sess-surface-5',
      cwd: cwdDir,
    });

    const eventIde = buildEvent({
      kind: 'session_summary',
      body: { type: 'text', content: 'summary text' },
      sessionId: 'sess-surface-5',
      cwd: cwdDir,
      surface: 'kiro-ide',
    });

    // Core fields must be identical
    expect(eventIde.namespace).toBe(eventCli.namespace);
    expect(eventIde.session_id).toBe(eventCli.session_id);
    expect(eventIde.actor_id).toBe(eventCli.actor_id);
    expect(eventIde.schema_version).toBe(eventCli.schema_version);
    expect(eventIde.kind).toBe(eventCli.kind);
    expect(eventIde.body).toEqual(eventCli.body);

    // Source fields other than surface must be identical
    expect(eventIde.source.version).toBe(eventCli.source.version);
    expect(eventIde.source.client_id).toBe(eventCli.source.client_id);
    expect(eventIde.source.project_path).toBe(eventCli.source.project_path);

    // Only surface differs
    expect(eventCli.source.surface).toBe('kiro-cli');
    expect(eventIde.source.surface).toBe('kiro-ide');
  });
});
