/**
 * Property-based tests for the judge XML framer and parser — Property 13
 * from the reconciliation-engine design.
 *
 * **Property 13: Judge XML round-trip preserves content.**
 *
 * Two round-trip directions are validated:
 *
 * 1. `parseJudgeResponse(serializeJudgeResponse(resp))` returns a
 *    structurally-equal {@link JudgeResponse} for every generated
 *    response (both `merge` and `keep_separate` variants). The
 *    `serializeJudgeResponse` helper is defined locally in this file
 *    because production code never needs to serialise a response —
 *    only the judge model does, and we simulate that here to drive
 *    the round-trip.
 *
 * 2. `parseJudgePrompt(frameJudgePrompt(req))` recovers the cluster
 *    and neighbor record_ids plus every string field for every
 *    generated request. `parseJudgePrompt` is a local helper — it is
 *    not part of the production API because the reconciler only ever
 *    *sends* prompts, it never parses them back.
 *
 * Both directions stress the XML escape / unescape contract: generated
 * strings are allowed to contain `<`, `>`, `&`, `"`, `'` — any of
 * which get escaped by the framer and must round-trip through the
 * parser unchanged.
 *
 * The generators constrain string content to a non-whitespace trimmed
 * form so that the parser's `.trim()` of extracted content is a no-op,
 * keeping the round-trip identity exact.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 7.3
 * @see .kiro/specs/reconciliation-engine/design.md § Correctness
 *   Properties — Property 13
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 6.2, 6.3
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import {
  frameJudgePrompt,
  parseJudgeResponse,
  type JudgeRequest,
  type JudgeResponse,
  type JudgeMergeResponse,
} from '../../src/collector/ingestion/judge-xml.js';
import {
  OBSERVATION_TYPES,
  type ObservationType,
} from '../../src/types/index.js';
import { escapeXml } from '../../src/collector/pipeline/xml-framer.js';

// ── Local helpers — local because production code never needs them ──────

/**
 * Serialise a {@link JudgeResponse} back into the XML grammar the judge
 * model emits. Only used to drive the response round-trip property; the
 * reconciler never serialises responses, only parses them.
 *
 * For `merge`, emits:
 *
 * ```xml
 * <merge>
 *   <merged_record_id>...</merged_record_id>...
 *   <title>...</title>
 *   <summary>...</summary>
 *   <facts><fact>...</fact>...</facts>
 *   <concepts><concept>...</concept>...</concepts>
 *   <files><file>...</file>...</files>
 *   [<observation_type>...</observation_type>]
 * </merge>
 * ```
 *
 * For `keep_separate`, emits `<keep_separate/>`.
 *
 * All text is XML-escaped via the production {@link escapeXml}.
 */
function serializeJudgeResponse(resp: JudgeResponse): string {
  if (resp.kind === 'keep_separate') {
    return '<keep_separate/>';
  }
  const parts: string[] = [];
  parts.push('<merge>');
  for (const id of resp.merged_record_ids) {
    parts.push(`<merged_record_id>${escapeXml(id)}</merged_record_id>`);
  }
  parts.push(`<title>${escapeXml(resp.title)}</title>`);
  parts.push(`<summary>${escapeXml(resp.summary)}</summary>`);
  parts.push(
    `<facts>${resp.facts
      .map((f) => `<fact>${escapeXml(f)}</fact>`)
      .join('')}</facts>`,
  );
  parts.push(
    `<concepts>${resp.concepts
      .map((c) => `<concept>${escapeXml(c)}</concept>`)
      .join('')}</concepts>`,
  );
  parts.push(
    `<files>${resp.files_touched
      .map((f) => `<file>${escapeXml(f)}</file>`)
      .join('')}</files>`,
  );
  if (resp.observation_type !== undefined) {
    parts.push(
      `<observation_type>${escapeXml(resp.observation_type)}</observation_type>`,
    );
  }
  parts.push('</merge>');
  return parts.join('');
}

/**
 * Minimal extracted view of a {@link JudgeRequest} — just the record
 * ids and text fields the round-trip test asserts on.
 */
interface ExtractedPrompt {
  clusterRecordIds: string[];
  clusterTitles: string[];
  clusterSummaries: string[];
  clusterFacts: string[][]; // per-member
  clusterConcepts: string[][];
  clusterFiles: string[][];
  clusterObservationTypes: string[];
  neighborRecordIds: string[];
  neighborTitles: string[];
  neighborSummaries: string[];
  neighborFacts: string[][]; // per-neighbor
}

/** Unescape the four entities the framer emits. Mirrors `unescapeXml` in production. */
function unescape(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * Parse a `<reconciliation_request>` prompt emitted by
 * {@link frameJudgePrompt}. Test-only; production code never parses the
 * prompt back into a request. Tolerates the exact grammar the framer
 * emits and not much else.
 */
function parseJudgePrompt(xml: string): ExtractedPrompt {
  const extractCluster = /<candidate_cluster>([\s\S]*?)<\/candidate_cluster>/.exec(xml);
  const extractNeighbors = /<neighbor_pool>([\s\S]*?)<\/neighbor_pool>/.exec(xml);
  const clusterBody = extractCluster?.[1] ?? '';
  const neighborBody = extractNeighbors?.[1] ?? '';

  const out: ExtractedPrompt = {
    clusterRecordIds: [],
    clusterTitles: [],
    clusterSummaries: [],
    clusterFacts: [],
    clusterConcepts: [],
    clusterFiles: [],
    clusterObservationTypes: [],
    neighborRecordIds: [],
    neighborTitles: [],
    neighborSummaries: [],
    neighborFacts: [],
  };

  // Extract each <candidate> block and its fields.
  const candidateRe = /<candidate\s+record_id="([^"]*)">([\s\S]*?)<\/candidate>/g;
  let cm: RegExpExecArray | null;
  while ((cm = candidateRe.exec(clusterBody)) !== null) {
    out.clusterRecordIds.push(unescape(cm[1] ?? ''));
    const body = cm[2] ?? '';
    out.clusterTitles.push(extractOneTag(body, 'title'));
    out.clusterSummaries.push(extractOneTag(body, 'summary'));
    out.clusterFacts.push(extractChildList(body, 'facts', 'fact'));
    out.clusterConcepts.push(extractChildList(body, 'concepts', 'concept'));
    out.clusterFiles.push(extractChildList(body, 'files', 'file'));
    out.clusterObservationTypes.push(extractOneTag(body, 'observation_type'));
  }

  // Extract each <neighbor> block and its fields.
  const neighborRe = /<neighbor\s+record_id="([^"]*)"\s+similarity="[^"]*">([\s\S]*?)<\/neighbor>/g;
  let nm: RegExpExecArray | null;
  while ((nm = neighborRe.exec(neighborBody)) !== null) {
    out.neighborRecordIds.push(unescape(nm[1] ?? ''));
    const body = nm[2] ?? '';
    out.neighborTitles.push(extractOneTag(body, 'title'));
    out.neighborSummaries.push(extractOneTag(body, 'summary'));
    out.neighborFacts.push(extractChildList(body, 'facts', 'fact'));
  }

  return out;
}

function extractOneTag(text: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(text);
  return m === null ? '' : unescape(m[1]?.trim() ?? '');
}

function extractChildList(text: string, wrapper: string, child: string): string[] {
  const wrapperRe = new RegExp(`<${wrapper}>([\\s\\S]*?)<\\/${wrapper}>`);
  const wm = wrapperRe.exec(text);
  if (wm === null) return [];
  const body = wm[1] ?? '';
  const out: string[] = [];
  const childRe = new RegExp(`<${child}>([\\s\\S]*?)<\\/${child}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = childRe.exec(body)) !== null) {
    const raw = m[1]?.trim() ?? '';
    if (raw.length > 0) out.push(unescape(raw));
  }
  return out;
}

// ── Arbitraries — locally defined so we can tune bounds for this test ──

/** Crockford base32 alphabet used in ULIDs (no I, L, O, U). */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulidArb(): fc.Arbitrary<string> {
  return fc
    .array(
      fc.integer({ min: 0, max: ULID_ALPHABET.length - 1 }),
      { minLength: 26, maxLength: 26 },
    )
    .map((indices) => {
      let out = '';
      for (const i of indices) {
        const ch = ULID_ALPHABET[i];
        // Index bounded to alphabet range; `ch` is always defined.
        if (ch === undefined) throw new Error('ulidArb: out-of-range index');
        out += ch;
      }
      return out;
    });
}

function recordIdArb(): fc.Arbitrary<string> {
  return ulidArb().map((ulid) => `mr_${ulid}`);
}

/**
 * Generate a bounded non-empty string with no leading/trailing
 * whitespace and no internal tag-boundary whitespace. Allowed content
 * includes `<`, `>`, `&`, `"`, `'` so the escape/unescape contract is
 * stressed.
 *
 * Leading/trailing whitespace must be stripped because the parser
 * calls `.trim()` on every extracted field, so the round-trip cannot
 * preserve surrounding whitespace.
 */
function nonWhitespaceStringArb(maxLength: number): fc.Arbitrary<string> {
  return fc
    .string({ minLength: 1, maxLength })
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function observationTypeArb(): fc.Arbitrary<ObservationType> {
  return fc.constantFrom(...OBSERVATION_TYPES);
}

/**
 * Arbitrary {@link JudgeMergeResponse}. Bounds mirror the schema caps
 * (`title` ≤ 200, `summary` ≤ 4000, facts/concepts/files small lists)
 * but use a smaller test-side budget so 200 iterations stay fast.
 */
function judgeMergeResponseArb(): fc.Arbitrary<JudgeMergeResponse> {
  return fc
    .record({
      merged_record_ids: fc.array(recordIdArb(), { minLength: 1, maxLength: 5 }),
      title: nonWhitespaceStringArb(80),
      summary: nonWhitespaceStringArb(200),
      facts: fc.array(nonWhitespaceStringArb(60), { minLength: 0, maxLength: 5 }),
      concepts: fc.array(nonWhitespaceStringArb(40), { minLength: 0, maxLength: 5 }),
      files_touched: fc.array(nonWhitespaceStringArb(60), { minLength: 0, maxLength: 5 }),
    })
    .chain((base) =>
      fc
        .option(observationTypeArb(), { nil: undefined })
        .map((ot) =>
          ot === undefined
            ? { kind: 'merge' as const, ...base }
            : { kind: 'merge' as const, ...base, observation_type: ot },
        ),
    );
}

function judgeResponseArb(): fc.Arbitrary<JudgeResponse> {
  return fc.oneof(
    judgeMergeResponseArb(),
    fc.constant({ kind: 'keep_separate' as const }),
  );
}

/**
 * Arbitrary {@link JudgeRequest}. The centroid is always `null` since
 * {@link frameJudgePrompt} never serialises it.
 */
function judgeRequestArb(): fc.Arbitrary<JudgeRequest> {
  const memberArb = fc.record({
    record_id: recordIdArb(),
    title: nonWhitespaceStringArb(80),
    summary: nonWhitespaceStringArb(200),
    facts: fc.array(nonWhitespaceStringArb(60), { minLength: 0, maxLength: 5 }),
    concepts: fc.array(nonWhitespaceStringArb(40), { minLength: 0, maxLength: 5 }),
    files_touched: fc.array(nonWhitespaceStringArb(60), { minLength: 0, maxLength: 5 }),
    observation_type: observationTypeArb(),
  });
  const neighborArb = fc.record({
    record_id: recordIdArb(),
    title: nonWhitespaceStringArb(80),
    summary: nonWhitespaceStringArb(200),
    facts: fc.array(nonWhitespaceStringArb(60), { minLength: 0, maxLength: 5 }),
    similarity: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
  });
  return fc.record({
    cluster: fc.record({
      centroid: fc.constant(null),
      members: fc.array(memberArb, { minLength: 1, maxLength: 5 }),
    }),
    neighbors: fc.array(neighborArb, { minLength: 0, maxLength: 5 }),
  });
}

// ── Property 13 ─────────────────────────────────────────────────────────

describe('Property 13: judge XML round-trip preserves content', () => {
  it('parseJudgeResponse(serializeJudgeResponse(resp)) is structurally equal to resp', () => {
    /**
     * **Validates: Requirements 6.2, 6.3**
     *
     * For any generated {@link JudgeResponse} — both `merge` and
     * `keep_separate` variants — serialising and re-parsing recovers
     * the same discriminated union structurally: same `kind`, and in
     * the `merge` case the same `merged_record_ids` (in order), same
     * title / summary / facts / concepts / files_touched, and the
     * same `observation_type` (absent-vs-present) state.
     */
    fc.assert(
      fc.property(judgeResponseArb(), (resp) => {
        const xml = serializeJudgeResponse(resp);
        const parsed = parseJudgeResponse(xml);
        if (parsed === null) {
          throw new Error(
            `parseJudgeResponse returned null for xml=${xml}`,
          );
        }
        if (parsed.kind !== resp.kind) {
          throw new Error(
            `kind mismatch: got ${parsed.kind}, want ${resp.kind}`,
          );
        }
        if (resp.kind === 'merge' && parsed.kind === 'merge') {
          if (
            JSON.stringify(parsed.merged_record_ids) !==
            JSON.stringify(resp.merged_record_ids)
          ) {
            throw new Error(
              `merged_record_ids mismatch: got ${JSON.stringify(parsed.merged_record_ids)}, want ${JSON.stringify(resp.merged_record_ids)}`,
            );
          }
          if (parsed.title !== resp.title) {
            throw new Error(
              `title mismatch: got ${JSON.stringify(parsed.title)}, want ${JSON.stringify(resp.title)}`,
            );
          }
          if (parsed.summary !== resp.summary) {
            throw new Error(
              `summary mismatch: got ${JSON.stringify(parsed.summary)}, want ${JSON.stringify(resp.summary)}`,
            );
          }
          if (JSON.stringify(parsed.facts) !== JSON.stringify(resp.facts)) {
            throw new Error(
              `facts mismatch: got ${JSON.stringify(parsed.facts)}, want ${JSON.stringify(resp.facts)}`,
            );
          }
          if (JSON.stringify(parsed.concepts) !== JSON.stringify(resp.concepts)) {
            throw new Error(
              `concepts mismatch: got ${JSON.stringify(parsed.concepts)}, want ${JSON.stringify(resp.concepts)}`,
            );
          }
          if (
            JSON.stringify(parsed.files_touched) !==
            JSON.stringify(resp.files_touched)
          ) {
            throw new Error(
              `files_touched mismatch: got ${JSON.stringify(parsed.files_touched)}, want ${JSON.stringify(resp.files_touched)}`,
            );
          }
          const gotOt = 'observation_type' in parsed ? parsed.observation_type : null;
          const wantOt = 'observation_type' in resp ? resp.observation_type : null;
          if (gotOt !== wantOt) {
            throw new Error(
              `observation_type mismatch: got ${String(gotOt)}, want ${String(wantOt)}`,
            );
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('parseJudgePrompt(frameJudgePrompt(req)) recovers record_ids and all string fields', () => {
    /**
     * **Validates: Requirements 6.2**
     *
     * For any generated {@link JudgeRequest}, a round trip through
     * {@link frameJudgePrompt} + the local {@link parseJudgePrompt}
     * helper recovers: cluster member record_ids, titles, summaries,
     * facts, concepts, files_touched, observation_type; neighbor
     * record_ids, titles, summaries, facts. Similarity is asserted
     * only through successful neighbor extraction — its numeric value
     * is formatted with `toFixed(4)` and is not round-tripped back to
     * the exact input float.
     */
    fc.assert(
      fc.property(judgeRequestArb(), (req) => {
        const xml = frameJudgePrompt(req);
        const got = parseJudgePrompt(xml);

        // Cluster members
        const wantClusterIds = req.cluster.members.map((m) => m.record_id);
        const wantClusterTitles = req.cluster.members.map((m) => m.title);
        const wantClusterSummaries = req.cluster.members.map((m) => m.summary);
        const wantClusterFacts = req.cluster.members.map((m) => [...m.facts]);
        const wantClusterConcepts = req.cluster.members.map((m) => [...m.concepts]);
        const wantClusterFiles = req.cluster.members.map((m) => [...m.files_touched]);
        const wantClusterOt = req.cluster.members.map((m) => m.observation_type);

        if (JSON.stringify(got.clusterRecordIds) !== JSON.stringify(wantClusterIds)) {
          throw new Error(
            `cluster record_ids mismatch: got ${JSON.stringify(got.clusterRecordIds)}, want ${JSON.stringify(wantClusterIds)}`,
          );
        }
        if (JSON.stringify(got.clusterTitles) !== JSON.stringify(wantClusterTitles)) {
          throw new Error(
            `cluster titles mismatch: got ${JSON.stringify(got.clusterTitles)}, want ${JSON.stringify(wantClusterTitles)}`,
          );
        }
        if (JSON.stringify(got.clusterSummaries) !== JSON.stringify(wantClusterSummaries)) {
          throw new Error(
            `cluster summaries mismatch: got ${JSON.stringify(got.clusterSummaries)}, want ${JSON.stringify(wantClusterSummaries)}`,
          );
        }
        if (JSON.stringify(got.clusterFacts) !== JSON.stringify(wantClusterFacts)) {
          throw new Error(
            `cluster facts mismatch: got ${JSON.stringify(got.clusterFacts)}, want ${JSON.stringify(wantClusterFacts)}`,
          );
        }
        if (JSON.stringify(got.clusterConcepts) !== JSON.stringify(wantClusterConcepts)) {
          throw new Error(
            `cluster concepts mismatch: got ${JSON.stringify(got.clusterConcepts)}, want ${JSON.stringify(wantClusterConcepts)}`,
          );
        }
        if (JSON.stringify(got.clusterFiles) !== JSON.stringify(wantClusterFiles)) {
          throw new Error(
            `cluster files mismatch: got ${JSON.stringify(got.clusterFiles)}, want ${JSON.stringify(wantClusterFiles)}`,
          );
        }
        if (
          JSON.stringify(got.clusterObservationTypes) !==
          JSON.stringify(wantClusterOt)
        ) {
          throw new Error(
            `cluster observation_type mismatch: got ${JSON.stringify(got.clusterObservationTypes)}, want ${JSON.stringify(wantClusterOt)}`,
          );
        }

        // Neighbors
        const wantNeighborIds = req.neighbors.map((n) => n.record_id);
        const wantNeighborTitles = req.neighbors.map((n) => n.title);
        const wantNeighborSummaries = req.neighbors.map((n) => n.summary);
        const wantNeighborFacts = req.neighbors.map((n) => [...n.facts]);

        if (JSON.stringify(got.neighborRecordIds) !== JSON.stringify(wantNeighborIds)) {
          throw new Error(
            `neighbor record_ids mismatch: got ${JSON.stringify(got.neighborRecordIds)}, want ${JSON.stringify(wantNeighborIds)}`,
          );
        }
        if (JSON.stringify(got.neighborTitles) !== JSON.stringify(wantNeighborTitles)) {
          throw new Error(
            `neighbor titles mismatch: got ${JSON.stringify(got.neighborTitles)}, want ${JSON.stringify(wantNeighborTitles)}`,
          );
        }
        if (
          JSON.stringify(got.neighborSummaries) !== JSON.stringify(wantNeighborSummaries)
        ) {
          throw new Error(
            `neighbor summaries mismatch: got ${JSON.stringify(got.neighborSummaries)}, want ${JSON.stringify(wantNeighborSummaries)}`,
          );
        }
        if (JSON.stringify(got.neighborFacts) !== JSON.stringify(wantNeighborFacts)) {
          throw new Error(
            `neighbor facts mismatch: got ${JSON.stringify(got.neighborFacts)}, want ${JSON.stringify(wantNeighborFacts)}`,
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});
