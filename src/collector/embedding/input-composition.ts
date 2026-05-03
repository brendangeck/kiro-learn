/**
 * Embedder input composition.
 *
 * Pure, deterministic function that flattens a {@link MemoryRecord}
 * into the single string passed to the on-device embedder. The
 * on-device model (`all-MiniLM-L6-v2`) accepts free-form text; the
 * specific assembly here — `title`, `summary`, `facts`, `concepts`
 * separated by blank lines with facts joined by newlines and
 * concepts joined by a comma-space — is the spec-frozen input shape
 * and is what Property 2 tests pin down.
 *
 * Determinism matters for two reasons:
 *
 * 1. Backfill (task 8) re-embeds records that existed before the
 *    model landed. For the re-embed to produce the same vector as
 *    the live extraction path (task 7), both must compose the input
 *    identically.
 * 2. The integration tests assert that a record embedded twice
 *    yields bit-identical vectors; a non-deterministic composer
 *    would mask real regressions in the embedder itself.
 *
 * The result is truncated to at most {@link DEFAULT_MAX_INPUT_CHARS}
 * code units (or the caller-supplied cap) using a plain
 * `.slice(0, cap)`. No codepoint-aware trimming — matching the
 * model's own tokenizer behaviour on the trailing bytes is the
 * embedder's problem, not this function's. See Req 1.1.
 *
 * This module is pure: no imports from `src/collector/storage/sqlite/`,
 * `src/shim/`, `src/installer/`, or `src/mcp/`. It imports from
 * `src/types/` only (for {@link MemoryRecord}), matching the
 * modularity rules declared in design § Components and Interfaces.
 *
 * @see Requirements 1.1, 3.2
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — `composeEmbeddingInput`
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Property 2 (deterministic and content-preserving)
 * @module
 */

import type { MemoryRecord } from '../../types/index.js';

/**
 * Default upper bound on the number of code units returned by
 * {@link composeEmbeddingInput}.
 *
 * Ten thousand characters is comfortably above the effective context
 * window of `all-MiniLM-L6-v2` (which the tokenizer will itself
 * truncate to 256 WordPiece tokens) but small enough that a
 * pathological record with thousands of long facts cannot drag a
 * single embed call into multi-second territory. See Req 1.1.
 */
export const DEFAULT_MAX_INPUT_CHARS = 10_000;

/**
 * Flatten a memory record into the single string handed to the
 * embedder.
 *
 * The composition is:
 *
 * ```
 * title + "\n\n" + summary + "\n\n" + facts.join("\n") + "\n\n" + concepts.join(", ")
 * ```
 *
 * followed by a truncation to `maxInputChars` code units. The
 * function is a pure value-level projection of `record`: given the
 * same input fields it always returns the same string, independent
 * of the process, the clock, or any ambient state.
 *
 * Fields that are empty arrays contribute the empty string in their
 * slot — the separators are unconditional, mirroring the
 * specification verbatim so the shape is stable across records.
 *
 * @param record - The memory record whose text fields should be
 *   projected into embedder input.
 * @param maxInputChars - Optional upper bound on the returned
 *   string's `.length`. Defaults to {@link DEFAULT_MAX_INPUT_CHARS}.
 *   Must be a non-negative integer; callers that pass `0` get the
 *   empty string.
 * @returns A string of length at most `maxInputChars`.
 *
 * @see Requirements 1.1, 3.2
 */
export function composeEmbeddingInput(
  record: MemoryRecord,
  maxInputChars: number = DEFAULT_MAX_INPUT_CHARS,
): string {
  const composed =
    record.title +
    '\n\n' +
    record.summary +
    '\n\n' +
    record.facts.join('\n') +
    '\n\n' +
    record.concepts.join(', ');
  return composed.slice(0, maxInputChars);
}
