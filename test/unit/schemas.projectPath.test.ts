/**
 * Example-level unit tests for the `source.project_path` extension to
 * `EventSourceSchema`.
 *
 * Covers:
 * - `parseEvent` accepts `source.project_path` at the 1-char lower bound.
 * - `parseEvent` accepts `source.project_path` at the 2048-char upper bound.
 * - `parseEvent` accepts an event whose `source` omits `project_path`
 *   entirely (backward compatibility with pre-spec shims and pre-spec
 *   stored rows).
 * - `parseEvent` rejects `source.project_path = ''` (below the min bound)
 *   with a `ZodError` whose `issues[0].path` ends in `project_path`.
 * - `parseEvent` rejects `source.project_path` of length 2049 (above the
 *   max bound) with a `ZodError` whose `issues[0].path` ends in
 *   `project_path`.
 *
 * The `MemoryRecord` new-field tests in `schemas.newFields.test.ts` cover a
 * different spec; this file is dedicated to the `Event` wire-schema change
 * introduced by project-path-capture so the two concerns stay legible.
 *
 * @see .kiro/specs/project-path-capture/requirements.md
 *      § Requirement 5.1, 5.2, 5.4, 5.5
 * @see .kiro/specs/project-path-capture/tasks.md § Task 1.2
 */

import { describe, expect, it } from 'vitest';
import { ZodError, type ZodIssue } from 'zod';

import { parseEvent, type KiroMemEvent } from '../../src/types/schemas.js';

/** Baseline valid event. Tests override `source` via a helper. */
const validEventBase: KiroMemEvent = {
  event_id: '01JF8ZS4Y00000000000000000',
  session_id: 'sess-1',
  actor_id: 'alice',
  namespace: '/actor/alice/project/abc/',
  schema_version: 1,
  kind: 'prompt',
  body: { type: 'text', content: 'hi' },
  valid_time: '2026-04-23T20:00:00Z',
  source: { surface: 'kiro-cli', version: '0.1.0', client_id: 'client-1' },
};

/**
 * Build a valid event as an `unknown` value with a caller-supplied
 * `source` block. Deep-clones the baseline so mutations never leak
 * between tests.
 */
function eventWithSource(source: Record<string, unknown>): unknown {
  const clone = structuredClone(validEventBase) as Record<string, unknown>;
  clone['source'] = source;
  return clone;
}

/**
 * Runs `parseEvent` on input that is expected to fail and returns the
 * first `ZodIssue`. Mirrors the helper in `schemas.test.ts`.
 */
function firstIssueFor(input: unknown): ZodIssue {
  try {
    parseEvent(input);
  } catch (err) {
    expect(err).toBeInstanceOf(ZodError);
    const issues = (err as ZodError).issues;
    expect(issues.length).toBeGreaterThan(0);
    const first = issues[0];
    if (first === undefined) {
      throw new Error('ZodError has no issues');
    }
    return first;
  }
  throw new Error('parseEvent unexpectedly succeeded');
}

describe('parseEvent — source.project_path length bounds (Requirement 5.1, 5.2)', () => {
  it('accepts source.project_path of length 1 (lower bound)', () => {
    const input = eventWithSource({
      surface: 'kiro-cli',
      version: '0.1.0',
      client_id: 'client-1',
      project_path: '/',
    });
    const result = parseEvent(input);
    expect(result.source.project_path).toBe('/');
  });

  it('accepts source.project_path of length 2048 (upper bound)', () => {
    const longPath = 'a'.repeat(2048);
    const input = eventWithSource({
      surface: 'kiro-cli',
      version: '0.1.0',
      client_id: 'client-1',
      project_path: longPath,
    });
    const result = parseEvent(input);
    expect(result.source.project_path).toHaveLength(2048);
    expect(result.source.project_path).toBe(longPath);
  });
});

describe('parseEvent — source.project_path backward compatibility (Requirement 5.4)', () => {
  it('accepts an event whose source omits project_path entirely', () => {
    const input = eventWithSource({
      surface: 'kiro-cli',
      version: '0.1.0',
      client_id: 'client-1',
    });
    // Sanity: the key really is absent before parsing.
    expect(
      Object.prototype.hasOwnProperty.call(
        (input as { source: Record<string, unknown> }).source,
        'project_path',
      ),
    ).toBe(false);

    const result = parseEvent(input);
    // Under exactOptionalPropertyTypes the key must be absent on the
    // parsed object, not `project_path: undefined`. Use `in` so a
    // future regression that materialises the key as `undefined`
    // is caught here.
    expect('project_path' in result.source).toBe(false);
  });
});

describe('parseEvent — source.project_path bound violations (Requirement 5.5)', () => {
  it('rejects source.project_path = "" with an issue path ending in project_path', () => {
    const input = eventWithSource({
      surface: 'kiro-cli',
      version: '0.1.0',
      client_id: 'client-1',
      project_path: '',
    });

    expect(() => parseEvent(input)).toThrow(ZodError);

    const issue = firstIssueFor(input);
    expect(issue.path[issue.path.length - 1]).toBe('project_path');
  });

  it('rejects source.project_path of length 2049 with an issue path ending in project_path', () => {
    const tooLong = 'a'.repeat(2049);
    const input = eventWithSource({
      surface: 'kiro-cli',
      version: '0.1.0',
      client_id: 'client-1',
      project_path: tooLong,
    });

    expect(() => parseEvent(input)).toThrow(ZodError);

    const issue = firstIssueFor(input);
    expect(issue.path[issue.path.length - 1]).toBe('project_path');
  });
});
