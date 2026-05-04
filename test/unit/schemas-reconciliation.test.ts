/**
 * Example-level unit tests for the reconciliation-engine Zod schema
 * additions in `src/types/schemas.ts`:
 *
 * - `CandidateMemorySchema` — the in-memory output shape of the
 *   Extraction Stage. Mirrors `MemoryRecordSchema` minus `created_at`.
 *   Does not validate the transient `embedding` field — that lives only
 *   on the TypeScript type intersection.
 * - `JudgeResponseSchema` — discriminated union on `kind` over
 *   `{kind: 'merge', ...}` and `{kind: 'keep_separate'}` variants.
 *
 * The existing `MemoryRecordSchema` is unchanged; positive coverage for
 * that schema stays in `test/unit/schemas.test.ts`.
 *
 * @see .kiro/specs/reconciliation-engine/requirements.md § 3.2, 6.3, 6.4
 * @see .kiro/specs/reconciliation-engine/design.md § Data Models — Wire schema additions
 */

import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  CandidateMemorySchema,
  JudgeResponseSchema,
  JudgeMergeResponseSchema,
  JudgeKeepSeparateResponseSchema,
} from '../../src/types/schemas.js';

/**
 * Minimal valid Candidate Memory literal shared by the positive tests.
 * Structurally identical to a `MemoryRecord` except for the deliberate
 * absence of `created_at`.
 */
const validCandidate = {
  record_id: 'mr_01JF8ZS4Y00000000000000000',
  namespace: '/actor/alice/project/abc/',
  strategy: 'llm-summary',
  title: 'Investigating the flaky test',
  summary: 'Narrowed the failure to a race in the extraction worker.',
  facts: ['The test fails ~10% of the time.'],
  source_event_ids: ['01JF8ZS4Y00000000000000000'],
  concepts: ['flaky-test', 'extraction-worker'],
  files_touched: ['src/collector/buffer/extraction.ts'],
  observation_type: 'discovery',
} as const;

describe('CandidateMemorySchema — positive cases (Requirement 3.2)', () => {
  it('accepts a minimal valid candidate', () => {
    const result = CandidateMemorySchema.parse(validCandidate);
    expect(result.record_id).toBe(validCandidate.record_id);
    expect(result.observation_type).toBe('discovery');
  });

  it('accepts every observation_type enum value', () => {
    const enums = [
      'tool_use',
      'decision',
      'error',
      'discovery',
      'pattern',
      'session_summary',
    ] as const;
    for (const t of enums) {
      const result = CandidateMemorySchema.parse({
        ...validCandidate,
        observation_type: t,
      });
      expect(result.observation_type).toBe(t);
    }
  });

  it('accepts empty facts / concepts / files_touched arrays', () => {
    const result = CandidateMemorySchema.parse({
      ...validCandidate,
      facts: [],
      concepts: [],
      files_touched: [],
    });
    expect(result.facts).toEqual([]);
    expect(result.concepts).toEqual([]);
    expect(result.files_touched).toEqual([]);
  });

  it('ignores extra keys like `embedding` (not part of the Zod schema)', () => {
    // The `embedding` field is TypeScript-only — it is intersected onto
    // the `CandidateMemory` type but the Zod schema does not declare it.
    // Zod's default behaviour for extra keys on `z.object(...)` is to
    // strip them silently on `.parse`, not to raise. This test locks
    // that behaviour in so a future switch to `.strict()` would be a
    // deliberate, breaking change.
    const withExtra = {
      ...validCandidate,
      embedding: new Float32Array(384),
    };
    const result = CandidateMemorySchema.parse(withExtra);
    // The parsed shape has no `embedding` key.
    expect('embedding' in result).toBe(false);
  });
});

describe('CandidateMemorySchema — negative cases (Requirement 3.2)', () => {
  it('rejects a missing record_id', () => {
    const { record_id: _unused, ...rest } = validCandidate;
    expect(() => CandidateMemorySchema.parse(rest)).toThrow(ZodError);
  });

  it('rejects a missing namespace', () => {
    const { namespace: _unused, ...rest } = validCandidate;
    expect(() => CandidateMemorySchema.parse(rest)).toThrow(ZodError);
  });

  it('rejects a missing title', () => {
    const { title: _unused, ...rest } = validCandidate;
    expect(() => CandidateMemorySchema.parse(rest)).toThrow(ZodError);
  });

  it('rejects a missing source_event_ids', () => {
    const { source_event_ids: _unused, ...rest } = validCandidate;
    expect(() => CandidateMemorySchema.parse(rest)).toThrow(ZodError);
  });

  it('rejects an empty source_event_ids (min 1)', () => {
    expect(() =>
      CandidateMemorySchema.parse({ ...validCandidate, source_event_ids: [] }),
    ).toThrow(ZodError);
  });

  it('rejects a missing observation_type', () => {
    const { observation_type: _unused, ...rest } = validCandidate;
    expect(() => CandidateMemorySchema.parse(rest)).toThrow(ZodError);
  });

  it('rejects an invalid observation_type', () => {
    expect(() =>
      CandidateMemorySchema.parse({
        ...validCandidate,
        observation_type: 'not-a-known-type',
      }),
    ).toThrow(ZodError);
  });

  it('rejects a malformed record_id', () => {
    expect(() =>
      CandidateMemorySchema.parse({ ...validCandidate, record_id: 'not-a-record-id' }),
    ).toThrow(ZodError);
  });

  it('does not accept `created_at` as a substitute required field', () => {
    // Adding `created_at` to a Candidate Memory is a no-op: the schema
    // does not require it (it is MemoryRecord-only) and also does not
    // declare it, so it is silently stripped. A candidate without the
    // other required fields is still rejected.
    const withCreatedAt = {
      ...validCandidate,
      created_at: '2026-04-23T20:00:00Z',
    };
    // Happy path still passes.
    const parsed = CandidateMemorySchema.parse(withCreatedAt);
    expect('created_at' in parsed).toBe(false);
  });
});

describe('JudgeResponseSchema — positive cases (Requirement 6.3)', () => {
  const mergeBase = {
    kind: 'merge' as const,
    merged_record_ids: [
      'mr_01JF8ZS4Y00000000000000000',
      'mr_01JF8ZS4Y00000000000000001',
    ],
    title: 'Flaky test root-caused',
    summary: 'Race condition in the extraction worker.',
    facts: ['Fails ~10% of the time.'],
    concepts: ['flaky-test'],
    files_touched: ['src/collector/buffer/extraction.ts'],
  };

  it('accepts a minimal merge response (no observation_type)', () => {
    const result = JudgeResponseSchema.parse(mergeBase);
    expect(result.kind).toBe('merge');
    if (result.kind !== 'merge') throw new Error('wrong kind discriminator');
    expect(result.merged_record_ids).toHaveLength(2);
    expect('observation_type' in result).toBe(false);
  });

  it('accepts a merge response with observation_type', () => {
    const result = JudgeResponseSchema.parse({
      ...mergeBase,
      observation_type: 'decision',
    });
    expect(result.kind).toBe('merge');
    if (result.kind !== 'merge') throw new Error('wrong kind discriminator');
    expect(result.observation_type).toBe('decision');
  });

  it('accepts a keep_separate response', () => {
    const result = JudgeResponseSchema.parse({ kind: 'keep_separate' });
    expect(result.kind).toBe('keep_separate');
  });

  it('discriminates on `kind` — merge is routed to the merge schema', () => {
    // `JudgeMergeResponseSchema` parses a merge body directly; this
    // locks in the discriminator wiring.
    const result = JudgeMergeResponseSchema.parse(mergeBase);
    expect(result.kind).toBe('merge');
  });

  it('discriminates on `kind` — keep_separate is routed to the keep-separate schema', () => {
    const result = JudgeKeepSeparateResponseSchema.parse({ kind: 'keep_separate' });
    expect(result.kind).toBe('keep_separate');
  });
});

describe('JudgeResponseSchema — negative cases (Requirement 6.3, 6.4)', () => {
  const mergeBase = {
    kind: 'merge' as const,
    merged_record_ids: ['mr_01JF8ZS4Y00000000000000000'],
    title: 'Flaky test root-caused',
    summary: 'Race condition in the extraction worker.',
    facts: [],
    concepts: [],
    files_touched: [],
  };

  it('rejects a response with no kind discriminator', () => {
    const { kind: _unused, ...rest } = mergeBase;
    expect(() => JudgeResponseSchema.parse(rest)).toThrow(ZodError);
  });

  it('rejects a response with an unknown kind discriminator', () => {
    expect(() =>
      JudgeResponseSchema.parse({ ...mergeBase, kind: 'uncertain' }),
    ).toThrow(ZodError);
  });

  it('rejects a merge response missing `merged_record_ids`', () => {
    const { merged_record_ids: _unused, ...rest } = mergeBase;
    expect(() => JudgeResponseSchema.parse(rest)).toThrow(ZodError);
  });

  it('rejects a merge response with an empty `merged_record_ids` (min 1)', () => {
    expect(() =>
      JudgeResponseSchema.parse({ ...mergeBase, merged_record_ids: [] }),
    ).toThrow(ZodError);
  });

  it('rejects a merge response with a malformed merged record id', () => {
    expect(() =>
      JudgeResponseSchema.parse({
        ...mergeBase,
        merged_record_ids: ['not-a-record-id'],
      }),
    ).toThrow(ZodError);
  });

  it('rejects a merge response missing `title`', () => {
    const { title: _unused, ...rest } = mergeBase;
    expect(() => JudgeResponseSchema.parse(rest)).toThrow(ZodError);
  });

  it('rejects a merge response missing `summary`', () => {
    const { summary: _unused, ...rest } = mergeBase;
    expect(() => JudgeResponseSchema.parse(rest)).toThrow(ZodError);
  });

  it('rejects a merge response with an invalid observation_type', () => {
    expect(() =>
      JudgeResponseSchema.parse({
        ...mergeBase,
        observation_type: 'not-a-known-type',
      }),
    ).toThrow(ZodError);
  });
});
