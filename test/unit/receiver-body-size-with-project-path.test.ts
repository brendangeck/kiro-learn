/**
 * Example test: the 1 MiB serialized-body cap enforced by `EventBodySchema`
 * is measured on `body` only, not on the whole event. Adding a maximally-
 * sized `source.project_path` (2048 chars, the field's upper bound) does
 * not push a near-limit body into rejection; conversely, an oversized body
 * is rejected whether or not `project_path` is present.
 *
 * This test pins the contract explicitly so a future regression that starts
 * counting `source` bytes against the body cap is caught immediately.
 *
 * @see .kiro/specs/project-path-capture/requirements.md § Requirement 12.5
 * @see .kiro/specs/project-path-capture/design.md § Pipeline — Pass-Through Verification
 * @see src/types/schemas.ts — `EventBodySchema.refine`
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { parseEvent, type KiroMemEvent } from '../../src/types/schemas.js';

/** 1 MiB, the documented body-size cap. */
const MAX_BODY_BYTES = 1_048_576;

/**
 * A near-1-MiB text body: 1 MiB minus a ~1000-byte margin to absorb the
 * JSON wrapper (`{"type":"text","content":"..."}` ≈ 22 bytes) plus a
 * comfortable safety buffer. The serialized body is well under 1 MiB.
 */
const NEAR_LIMIT_CONTENT = 'x'.repeat(MAX_BODY_BYTES - 1000);

/**
 * A just-over-1-MiB text body: 1 MiB + 1 byte of content alone, which
 * guarantees the JSON-serialized body exceeds the cap regardless of the
 * wrapper size.
 */
const OVER_LIMIT_CONTENT = 'x'.repeat(MAX_BODY_BYTES + 1);

/**
 * Maximally-sized `project_path`: 2048 chars, the upper bound enforced by
 * `EventSourceSchema`. Using the field's upper bound is the strongest form
 * of the "source doesn't count toward body cap" claim.
 */
const MAX_PROJECT_PATH = 'a'.repeat(2048);

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

/** Build an event variant with a given body and optional project_path. */
function eventWith(
  body: unknown,
  projectPath: string | undefined,
): unknown {
  const base = structuredClone(validEventBase);
  const source =
    projectPath === undefined
      ? base.source
      : { ...base.source, project_path: projectPath };
  return { ...base, body, source };
}

describe('parseEvent — body-size cap excludes `source` (Requirement 12.5)', () => {
  it('accepts a near-1-MiB body alongside a 2048-char `source.project_path`', () => {
    /**
     * If the cap counted `source` bytes, a 2 KiB `project_path` added to a
     * body already close to 1 MiB would push the total over and trigger
     * rejection. The cap is scoped to `body` only, so this event must parse.
     */
    const event = eventWith(
      { type: 'text', content: NEAR_LIMIT_CONTENT },
      MAX_PROJECT_PATH,
    );

    const parsed = parseEvent(event);

    expect(parsed.source.project_path).toBe(MAX_PROJECT_PATH);
    expect(parsed.body).toEqual({ type: 'text', content: NEAR_LIMIT_CONTENT });
  });

  it('rejects an over-1-MiB body when `source.project_path` is present', () => {
    const event = eventWith(
      { type: 'text', content: OVER_LIMIT_CONTENT },
      MAX_PROJECT_PATH,
    );

    expect(() => parseEvent(event)).toThrow(ZodError);
  });

  it('rejects an over-1-MiB body when `source.project_path` is absent', () => {
    /**
     * Rejection is a property of `body` alone — `project_path`'s presence
     * or absence does not affect the outcome.
     */
    const event = eventWith(
      { type: 'text', content: OVER_LIMIT_CONTENT },
      undefined,
    );

    expect(() => parseEvent(event)).toThrow(ZodError);
  });
});
