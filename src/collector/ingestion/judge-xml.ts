/**
 * Ingestion / Judge XML — pure prompt framing and response parsing for
 * the `kiro-learn-reconciler` judge surface.
 *
 * The Reconciliation Stage invokes the judge over ACP with an XML
 * prompt describing a Candidate Cluster plus its Neighbor Pool, and
 * expects back either:
 *
 * - a `<merge>...</merge>` block listing the record ids to collapse
 *   together with the merged-record fields for the resulting Summary
 *   Record, OR
 * - a bare `<keep_separate/>` signal.
 *
 * This module owns both sides of that wire:
 *
 * - {@link frameJudgePrompt} serialises a {@link JudgeRequest} into a
 *   `<reconciliation_request>` XML block, reusing
 *   {@link escapeXml} from the existing XML pipeline framer so every
 *   text and attribute value is escaped identically to the compressor
 *   prompt.
 * - {@link parseJudgeResponse} extracts a {@link JudgeResponse} from
 *   the model's raw text. It returns `null` on any shape that is not
 *   a well-formed merge or keep-separate decision so the reconciler
 *   can funnel the failure into its retry + circuit-breaker logic
 *   (Requirements 6.7, 12.2).
 *
 * Both functions are pure — no I/O, no side effects. The module sits
 * at `src/collector/ingestion/` and MUST NOT import from
 * `src/collector/storage/`, `src/collector/ingestion/reconciler.ts`,
 * or `src/collector/ingestion/candidate.ts` (guard tests enforce the
 * leaf-module invariant).
 *
 * @see .kiro/specs/reconciliation-engine/design.md § `judge-xml.ts` —
 *   prompt framing and response parsing
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 6.2, 6.3,
 *   6.5, 6.7
 * @module
 */

import { escapeXml } from '../pipeline/xml-framer.js';
import { unescapeXml } from '../pipeline/xml-parser.js';
import type {
  JudgeResponse,
  JudgeMergeResponse,
  JudgeKeepSeparateResponse,
  ObservationType,
} from '../../types/index.js';
import { OBSERVATION_TYPES } from '../../types/index.js';

// ── Re-exports ──────────────────────────────────────────────────────────

export type {
  JudgeResponse,
  JudgeMergeResponse,
  JudgeKeepSeparateResponse,
} from '../../types/index.js';

// ── Public types ────────────────────────────────────────────────────────

/**
 * The inputs to {@link frameJudgePrompt}.
 *
 * `cluster.centroid` is carried here for parity with the design but is
 * intentionally *not* serialised into the prompt — the judge reasons
 * over titles/summaries/facts, not raw vectors. Keeping the centroid
 * on the request shape is useful for debug logging (Requirement 11.4).
 *
 * Strings are unescaped TypeScript values; the framer handles XML
 * escaping at serialisation time.
 */
export interface JudgeRequest {
  cluster: {
    /** Cluster centroid (for debug logging only; not sent to the model). */
    centroid: Float32Array | null;
    members: ReadonlyArray<{
      record_id: string;
      title: string;
      summary: string;
      facts: readonly string[];
      concepts: readonly string[];
      files_touched: readonly string[];
      observation_type: ObservationType;
    }>;
  };
  neighbors: ReadonlyArray<{
    record_id: string;
    title: string;
    summary: string;
    facts: readonly string[];
    similarity: number;
  }>;
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Render a list of string children as `<tag>...</tag>` entries wrapped
 * in a `<wrapper>...</wrapper>` parent. Empty lists still emit the
 * wrapper so the grammar is stable and parsers can rely on the outer
 * element being present.
 *
 * All child text is XML-escaped via {@link escapeXml}.
 */
function renderStringList(
  wrapper: string,
  childTag: string,
  items: readonly string[],
  indent: string,
): string {
  if (items.length === 0) {
    return `${indent}<${wrapper}></${wrapper}>`;
  }
  const inner = items
    .map((item) => `<${childTag}>${escapeXml(item)}</${childTag}>`)
    .join('');
  return `${indent}<${wrapper}>${inner}</${wrapper}>`;
}

/**
 * Format a cosine similarity for attribute output. Four decimal places
 * is plenty for operator-facing debugging and keeps the prompt byte
 * count predictable across runs.
 */
function formatSimilarity(sim: number): string {
  return sim.toFixed(4);
}

// ── Public API: framing ─────────────────────────────────────────────────

/**
 * Serialise a {@link JudgeRequest} as a `<reconciliation_request>` XML
 * block.
 *
 * Grammar (from design.md § Response shape):
 *
 * ```xml
 * <reconciliation_request>
 *   <candidate_cluster>
 *     <candidate record_id="mr_...">
 *       <title>...</title>
 *       <summary>...</summary>
 *       <facts><fact>...</fact>...</facts>
 *       <concepts><concept>...</concept>...</concepts>
 *       <files><file>...</file>...</files>
 *       <observation_type>decision</observation_type>
 *     </candidate>
 *     ...
 *   </candidate_cluster>
 *   <neighbor_pool>
 *     <neighbor record_id="mr_..." similarity="0.87">
 *       <title>...</title>
 *       <summary>...</summary>
 *       <facts><fact>...</fact>...</facts>
 *     </neighbor>
 *     ...
 *   </neighbor_pool>
 * </reconciliation_request>
 * ```
 *
 * - Every text child (`<title>`, `<summary>`, `<fact>`, `<concept>`,
 *   `<file>`, `<observation_type>`) is XML-escaped.
 * - Attribute values (`record_id`, `similarity`) are also escaped.
 * - `similarity` is formatted with four decimal places so the prompt
 *   is byte-reproducible for a given input.
 * - Empty facts/concepts/files lists still emit their wrapper element
 *   so the grammar stays stable.
 *
 * Pure — no I/O, no logs.
 *
 * @see Requirements 6.2
 */
export function frameJudgePrompt(req: JudgeRequest): string {
  const lines: string[] = [];
  lines.push('<reconciliation_request>');

  // ── Candidate cluster ─────────────────────────────────────────────
  lines.push('  <candidate_cluster>');
  for (const member of req.cluster.members) {
    lines.push(
      `    <candidate record_id="${escapeXml(member.record_id)}">`,
    );
    lines.push(`      <title>${escapeXml(member.title)}</title>`);
    lines.push(`      <summary>${escapeXml(member.summary)}</summary>`);
    lines.push(renderStringList('facts', 'fact', member.facts, '      '));
    lines.push(
      renderStringList('concepts', 'concept', member.concepts, '      '),
    );
    lines.push(
      renderStringList('files', 'file', member.files_touched, '      '),
    );
    lines.push(
      `      <observation_type>${escapeXml(member.observation_type)}</observation_type>`,
    );
    lines.push('    </candidate>');
  }
  lines.push('  </candidate_cluster>');

  // ── Neighbor pool ────────────────────────────────────────────────
  lines.push('  <neighbor_pool>');
  for (const neighbor of req.neighbors) {
    lines.push(
      `    <neighbor record_id="${escapeXml(neighbor.record_id)}" similarity="${escapeXml(formatSimilarity(neighbor.similarity))}">`,
    );
    lines.push(`      <title>${escapeXml(neighbor.title)}</title>`);
    lines.push(`      <summary>${escapeXml(neighbor.summary)}</summary>`);
    lines.push(renderStringList('facts', 'fact', neighbor.facts, '      '));
    lines.push('    </neighbor>');
  }
  lines.push('  </neighbor_pool>');

  lines.push('</reconciliation_request>');
  return lines.join('\n');
}

// ── Public API: parsing ─────────────────────────────────────────────────

/** Matches `<merge>...</merge>` — captures the inner body, non-greedy. */
const MERGE_RE = /<merge\b[^>]*>([\s\S]*?)<\/merge>/;

/** Matches `<keep_separate/>` or `<keep_separate></keep_separate>`. */
const KEEP_SEPARATE_RE = /<keep_separate\b[^>]*\/>|<keep_separate\b[^>]*><\/keep_separate>/;

/** Captures every `<merged_record_id>...</merged_record_id>` occurrence. */
const MERGED_RECORD_ID_RE = /<merged_record_id>([\s\S]*?)<\/merged_record_id>/g;

/** Factory: captures every `<tag>...</tag>` occurrence for a given tag. */
function allTagRe(tag: string): RegExp {
  return new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
}

/** Factory: captures the first `<tag>...</tag>` occurrence for a given tag. */
function singleTagRe(tag: string): RegExp {
  return new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
}

/**
 * Extract all `<tag>...</tag>` children from `text`, trimmed and
 * XML-unescaped. Skips empty inner content.
 */
function extractAll(text: string, tag: string): string[] {
  const out: string[] = [];
  const re = allTagRe(tag);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1]?.trim();
    if (raw !== undefined && raw.length > 0) {
      out.push(unescapeXml(raw));
    }
  }
  return out;
}

/**
 * Extract the first `<tag>...</tag>` occurrence, trimmed and
 * XML-unescaped. Returns `null` when absent or empty after trim.
 */
function extractOne(text: string, tag: string): string | null {
  const m = singleTagRe(tag).exec(text);
  const raw = m?.[1]?.trim();
  if (raw === undefined || raw.length === 0) return null;
  return unescapeXml(raw);
}

/**
 * Set of valid {@link ObservationType} values. Derived from the
 * single-source-of-truth constant exported from `src/types/schemas.ts`
 * so a schema change flows through to the parser without edits.
 */
const VALID_OBSERVATION_TYPES: ReadonlySet<string> = new Set(OBSERVATION_TYPES);

/**
 * Parse a judge response XML into a {@link JudgeResponse} discriminated
 * union.
 *
 * Returns `null` for:
 *
 * - empty string or whitespace-only input
 * - well-formed XML that contains neither `<merge>` nor
 *   `<keep_separate/>`
 * - non-XML conversational text
 * - `<merge>` blocks with zero `<merged_record_id>` children
 * - `<merge>` blocks missing `<title>` or `<summary>`
 *
 * On a `<keep_separate/>` (or `<keep_separate></keep_separate>`)
 * signal, returns `{ kind: 'keep_separate' }`.
 *
 * On a `<merge>` block, returns `{ kind: 'merge', merged_record_ids,
 * title, summary, facts, concepts, files_touched, observation_type? }`.
 * The `observation_type` field is attached only when the model emitted
 * a recognised enum value; unknown values are silently dropped per the
 * fallback rule in Requirement 7.6 (the reconciler then uses the
 * highest-similarity member's type).
 *
 * Pure — no I/O, no logs.
 *
 * @see Requirements 6.3, 6.5, 6.7
 */
export function parseJudgeResponse(xml: string): JudgeResponse | null {
  if (xml.trim().length === 0) return null;

  // `<keep_separate>` is a cheap check — handle it first so we don't
  // pay for the merge-regex scan on the common case.
  if (KEEP_SEPARATE_RE.test(xml)) {
    const response: JudgeKeepSeparateResponse = { kind: 'keep_separate' };
    return response;
  }

  const mergeMatch = MERGE_RE.exec(xml);
  if (mergeMatch === null) return null;

  const body = mergeMatch[1] ?? '';

  // Collect every `<merged_record_id>` child. A merge with zero ids is
  // invalid per the schema (`.min(1)`).
  const mergedIds: string[] = [];
  let idMatch: RegExpExecArray | null;
  MERGED_RECORD_ID_RE.lastIndex = 0;
  while ((idMatch = MERGED_RECORD_ID_RE.exec(body)) !== null) {
    const raw = idMatch[1]?.trim();
    if (raw !== undefined && raw.length > 0) {
      mergedIds.push(unescapeXml(raw));
    }
  }
  if (mergedIds.length === 0) return null;

  const title = extractOne(body, 'title');
  const summary = extractOne(body, 'summary');
  if (title === null || summary === null) return null;

  const facts = extractAll(body, 'fact');
  const concepts = extractAll(body, 'concept');
  const filesTouched = extractAll(body, 'file');

  // `observation_type` is optional. When present but unrecognised, we
  // silently drop it — the reconciler falls back to the highest-
  // similarity member's type (Requirement 7.6).
  const rawObservationType = extractOne(body, 'observation_type');
  const hasValidObservationType =
    rawObservationType !== null &&
    VALID_OBSERVATION_TYPES.has(rawObservationType);

  // Build the response with `exactOptionalPropertyTypes` in mind — do
  // not assign `undefined` to `observation_type`; omit the key when
  // the value is absent.
  const base = {
    kind: 'merge' as const,
    merged_record_ids: mergedIds,
    title,
    summary,
    facts,
    concepts,
    files_touched: filesTouched,
  };
  const response: JudgeMergeResponse = hasValidObservationType
    ? { ...base, observation_type: rawObservationType as ObservationType }
    : base;
  return response;
}
