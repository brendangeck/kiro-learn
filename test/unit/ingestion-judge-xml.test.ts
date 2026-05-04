/**
 * Unit tests for the judge XML framer and parser (Task 7.2).
 *
 * These tests pin down example-based behaviour of
 * {@link frameJudgePrompt} and {@link parseJudgeResponse} against the
 * `<reconciliation_request>` / `<merge>` / `<keep_separate/>` grammar
 * defined in the reconciliation-engine design doc.
 *
 * The framer is exercised with hostile string inputs (containing `<`,
 * `&`, `"`) to confirm every text child and attribute value is
 * XML-escaped. The parser is exercised with minimal-valid merge and
 * keep-separate blocks, with hostile text content to confirm
 * round-tripping through `unescapeXml`, and with a handful of malformed
 * inputs to confirm it returns `null` rather than throwing or
 * returning a partial response.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 7.2
 * @see .kiro/specs/reconciliation-engine/design.md § `judge-xml.ts`
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 6.2, 6.3,
 *   6.5, 6.7
 */

import { describe, expect, it } from 'vitest';

import {
  frameJudgePrompt,
  parseJudgeResponse,
  type JudgeRequest,
} from '../../src/collector/ingestion/judge-xml.js';

// ── Shared fixtures ─────────────────────────────────────────────────────

/**
 * Build a minimal {@link JudgeRequest} with one cluster member and one
 * neighbor. The caller can pass overrides for the member and neighbor
 * fields to exercise hostile content.
 */
function makeMinimalRequest(overrides?: {
  memberTitle?: string;
  memberSummary?: string;
  memberFacts?: readonly string[];
  memberConcepts?: readonly string[];
  memberFiles?: readonly string[];
  neighborTitle?: string;
  neighborSummary?: string;
  neighborFacts?: readonly string[];
  neighborSimilarity?: number;
}): JudgeRequest {
  return {
    cluster: {
      centroid: null,
      members: [
        {
          record_id: 'mr_01J000000000000000000000AA',
          title: overrides?.memberTitle ?? 'Cluster member title',
          summary: overrides?.memberSummary ?? 'Cluster member summary',
          facts: overrides?.memberFacts ?? ['fact a', 'fact b'],
          concepts: overrides?.memberConcepts ?? ['concept a'],
          files_touched: overrides?.memberFiles ?? ['src/foo.ts'],
          observation_type: 'decision',
        },
      ],
    },
    neighbors: [
      {
        record_id: 'mr_01J000000000000000000000BB',
        title: overrides?.neighborTitle ?? 'Neighbor title',
        summary: overrides?.neighborSummary ?? 'Neighbor summary',
        facts: overrides?.neighborFacts ?? ['neighbor fact'],
        similarity: overrides?.neighborSimilarity ?? 0.87,
      },
    ],
  };
}

// ── frameJudgePrompt ────────────────────────────────────────────────────

describe('frameJudgePrompt', () => {
  it('emits a <reconciliation_request> block with candidate_cluster and neighbor_pool', () => {
    const xml = frameJudgePrompt(makeMinimalRequest());

    expect(xml.startsWith('<reconciliation_request>')).toBe(true);
    expect(xml.endsWith('</reconciliation_request>')).toBe(true);
    expect(xml).toContain('<candidate_cluster>');
    expect(xml).toContain('</candidate_cluster>');
    expect(xml).toContain('<neighbor_pool>');
    expect(xml).toContain('</neighbor_pool>');
  });

  it('escapes < > & " in titles, summaries, facts, concepts', () => {
    const xml = frameJudgePrompt(
      makeMinimalRequest({
        memberTitle: 'Title <with> "quotes" & ampersand',
        memberSummary: 'Summary <tag> & more',
        memberFacts: ['fact <with> & bits', 'fact "quoted"'],
        memberConcepts: ['concept & thing'],
        memberFiles: ['path/with <special> chars.ts'],
        neighborTitle: 'Neighbor <with> & "stuff"',
        neighborSummary: 'Neighbor summary <foo>',
        neighborFacts: ['fact & more'],
      }),
    );

    // Originals must NOT appear unescaped in the serialised prompt.
    expect(xml).not.toContain('Title <with>');
    expect(xml).not.toContain('"quotes"');
    expect(xml).not.toContain('Summary <tag>');
    expect(xml).not.toContain('& ampersand');

    // Escaped forms must appear.
    expect(xml).toContain('Title &lt;with&gt; &quot;quotes&quot; &amp; ampersand');
    expect(xml).toContain('Summary &lt;tag&gt; &amp; more');
    expect(xml).toContain('fact &lt;with&gt; &amp; bits');
    expect(xml).toContain('fact &quot;quoted&quot;');
    expect(xml).toContain('concept &amp; thing');
    expect(xml).toContain('path/with &lt;special&gt; chars.ts');
    expect(xml).toContain('Neighbor &lt;with&gt; &amp; &quot;stuff&quot;');
  });

  it('emits similarity attribute with 4-decimal precision for reproducibility', () => {
    const xml = frameJudgePrompt(
      makeMinimalRequest({ neighborSimilarity: 0.8712345 }),
    );
    // 0.8712345 truncated to 4 decimals via toFixed → "0.8712"
    expect(xml).toContain('similarity="0.8712"');
  });

  it('renders empty facts/concepts/files lists with empty wrapper elements', () => {
    const xml = frameJudgePrompt(
      makeMinimalRequest({
        memberFacts: [],
        memberConcepts: [],
        memberFiles: [],
        neighborFacts: [],
      }),
    );
    // Wrappers stay — grammar is stable.
    expect(xml).toContain('<facts></facts>');
    expect(xml).toContain('<concepts></concepts>');
    expect(xml).toContain('<files></files>');
  });

  it('emits one <candidate> per cluster member', () => {
    const xml = frameJudgePrompt({
      cluster: {
        centroid: null,
        members: [
          {
            record_id: 'mr_01J000000000000000000000AA',
            title: 'A',
            summary: 'Aa',
            facts: [],
            concepts: [],
            files_touched: [],
            observation_type: 'decision',
          },
          {
            record_id: 'mr_01J000000000000000000000BB',
            title: 'B',
            summary: 'Bb',
            facts: [],
            concepts: [],
            files_touched: [],
            observation_type: 'discovery',
          },
        ],
      },
      neighbors: [],
    });

    // Two candidates, zero neighbors.
    const candidateCount = (xml.match(/<candidate\s/g) ?? []).length;
    expect(candidateCount).toBe(2);
    const neighborCount = (xml.match(/<neighbor\s/g) ?? []).length;
    expect(neighborCount).toBe(0);

    // record_id attributes are escaped and present.
    expect(xml).toContain('record_id="mr_01J000000000000000000000AA"');
    expect(xml).toContain('record_id="mr_01J000000000000000000000BB"');
  });

  it('handles a request with neighbors but no facts on them', () => {
    const xml = frameJudgePrompt(
      makeMinimalRequest({ neighborFacts: [] }),
    );
    // Neighbor wrapper still present with empty facts.
    expect(xml).toContain('<neighbor');
    expect(xml).toContain('<facts></facts>');
  });
});

// ── parseJudgeResponse — merge path ─────────────────────────────────────

describe('parseJudgeResponse — merge decisions', () => {
  it('parses a minimal <merge> block into a merge discriminated variant', () => {
    const xml = `
      <merge>
        <merged_record_id>mr_01J000000000000000000000AA</merged_record_id>
        <merged_record_id>mr_01J000000000000000000000BB</merged_record_id>
        <title>Merged title</title>
        <summary>Merged summary text</summary>
        <facts><fact>fact one</fact><fact>fact two</fact></facts>
        <concepts><concept>concept one</concept></concepts>
        <files><file>src/a.ts</file><file>src/b.ts</file></files>
      </merge>
    `;
    const result = parseJudgeResponse(xml);
    expect(result).not.toBeNull();
    if (result === null) return; // Narrow for TS.
    expect(result.kind).toBe('merge');
    if (result.kind !== 'merge') return; // Narrow for TS.

    expect(result.merged_record_ids).toEqual([
      'mr_01J000000000000000000000AA',
      'mr_01J000000000000000000000BB',
    ]);
    expect(result.title).toBe('Merged title');
    expect(result.summary).toBe('Merged summary text');
    expect(result.facts).toEqual(['fact one', 'fact two']);
    expect(result.concepts).toEqual(['concept one']);
    expect(result.files_touched).toEqual(['src/a.ts', 'src/b.ts']);
    // Optional field absent → key must not exist (exactOptionalPropertyTypes).
    expect('observation_type' in result).toBe(false);
  });

  it('includes observation_type when present and recognised', () => {
    const xml = `
      <merge>
        <merged_record_id>mr_01J000000000000000000000AA</merged_record_id>
        <title>T</title>
        <summary>S</summary>
        <facts></facts>
        <concepts></concepts>
        <files></files>
        <observation_type>discovery</observation_type>
      </merge>
    `;
    const result = parseJudgeResponse(xml);
    expect(result).not.toBeNull();
    if (result?.kind !== 'merge') return;
    expect(result.observation_type).toBe('discovery');
  });

  it('omits observation_type when absent from the <merge> body', () => {
    const xml = `
      <merge>
        <merged_record_id>mr_01J000000000000000000000AA</merged_record_id>
        <title>T</title>
        <summary>S</summary>
        <facts></facts>
        <concepts></concepts>
        <files></files>
      </merge>
    `;
    const result = parseJudgeResponse(xml);
    expect(result).not.toBeNull();
    if (result?.kind !== 'merge') return;
    // Per exactOptionalPropertyTypes: the key must not exist, not just be undefined.
    expect('observation_type' in result).toBe(false);
  });

  it('silently drops an unrecognised observation_type value', () => {
    const xml = `
      <merge>
        <merged_record_id>mr_01J000000000000000000000AA</merged_record_id>
        <title>T</title>
        <summary>S</summary>
        <facts></facts>
        <concepts></concepts>
        <files></files>
        <observation_type>not_a_real_type</observation_type>
      </merge>
    `;
    const result = parseJudgeResponse(xml);
    expect(result).not.toBeNull();
    if (result?.kind !== 'merge') return;
    expect('observation_type' in result).toBe(false);
  });

  it('unescapes XML entities in title, summary, facts, concepts, files', () => {
    const xml = `
      <merge>
        <merged_record_id>mr_01J000000000000000000000AA</merged_record_id>
        <title>Title &lt;with&gt; &quot;quotes&quot; &amp; ampersand</title>
        <summary>Summary &amp; more</summary>
        <facts><fact>fact &lt;escaped&gt;</fact></facts>
        <concepts><concept>concept &amp; thing</concept></concepts>
        <files><file>path/&lt;special&gt;.ts</file></files>
      </merge>
    `;
    const result = parseJudgeResponse(xml);
    expect(result).not.toBeNull();
    if (result?.kind !== 'merge') return;
    expect(result.title).toBe('Title <with> "quotes" & ampersand');
    expect(result.summary).toBe('Summary & more');
    expect(result.facts).toEqual(['fact <escaped>']);
    expect(result.concepts).toEqual(['concept & thing']);
    expect(result.files_touched).toEqual(['path/<special>.ts']);
  });
});

// ── parseJudgeResponse — keep-separate path ─────────────────────────────

describe('parseJudgeResponse — keep-separate decisions', () => {
  it('parses self-closing <keep_separate/>', () => {
    const result = parseJudgeResponse('<keep_separate/>');
    expect(result).toEqual({ kind: 'keep_separate' });
  });

  it('parses <keep_separate></keep_separate> explicit closing form', () => {
    const result = parseJudgeResponse('<keep_separate></keep_separate>');
    expect(result).toEqual({ kind: 'keep_separate' });
  });

  it('parses <keep_separate/> surrounded by whitespace', () => {
    const result = parseJudgeResponse('\n\n  <keep_separate/>\n\n');
    expect(result).toEqual({ kind: 'keep_separate' });
  });
});

// ── parseJudgeResponse — null returns ───────────────────────────────────

describe('parseJudgeResponse — invalid inputs return null', () => {
  it('returns null for empty string', () => {
    expect(parseJudgeResponse('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(parseJudgeResponse('   \n\t  ')).toBeNull();
  });

  it('returns null for garbage text with no XML tags', () => {
    expect(
      parseJudgeResponse('I think these are different memories, keep them separate.'),
    ).toBeNull();
  });

  it('returns null for well-formed XML with neither <merge> nor <keep_separate/>', () => {
    expect(
      parseJudgeResponse('<some_other_tag>content</some_other_tag>'),
    ).toBeNull();
  });

  it('returns null for <merge> with zero <merged_record_id> children', () => {
    const xml = `
      <merge>
        <title>T</title>
        <summary>S</summary>
        <facts></facts>
        <concepts></concepts>
        <files></files>
      </merge>
    `;
    expect(parseJudgeResponse(xml)).toBeNull();
  });

  it('returns null for <merge> missing <title>', () => {
    const xml = `
      <merge>
        <merged_record_id>mr_01J000000000000000000000AA</merged_record_id>
        <summary>S</summary>
        <facts></facts>
        <concepts></concepts>
        <files></files>
      </merge>
    `;
    expect(parseJudgeResponse(xml)).toBeNull();
  });

  it('returns null for <merge> missing <summary>', () => {
    const xml = `
      <merge>
        <merged_record_id>mr_01J000000000000000000000AA</merged_record_id>
        <title>T</title>
        <facts></facts>
        <concepts></concepts>
        <files></files>
      </merge>
    `;
    expect(parseJudgeResponse(xml)).toBeNull();
  });

  it('returns null for <merge> with empty-string <title>', () => {
    const xml = `
      <merge>
        <merged_record_id>mr_01J000000000000000000000AA</merged_record_id>
        <title>   </title>
        <summary>S</summary>
        <facts></facts>
        <concepts></concepts>
        <files></files>
      </merge>
    `;
    expect(parseJudgeResponse(xml)).toBeNull();
  });
});
