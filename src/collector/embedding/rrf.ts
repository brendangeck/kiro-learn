/**
 * Reciprocal Rank Fusion (RRF).
 *
 * Pure fusion layer for the hybrid search read path. Given two
 * ranked candidate lists — one from FTS5 (`lexical`) and one from
 * cosine similarity against the per-namespace vector index
 * (`vector`) — produces a single ranked list whose score for each
 * document is the classic RRF sum
 *
 *     score(d) = Σ_i 1 / (k + rank_i(d))
 *
 * where `rank_i(d)` is the 1-based position of `d` in ranking `i`.
 * Absence from a ranking is treated as `rank_i(d) = +∞`, which
 * contributes `0` to the sum (design § `rrfFuse` pseudocode). The
 * function therefore naturally handles the degraded-write case
 * where only one of the two retrievers has populated results.
 *
 * Tie-break here is deterministic-but-narrow: `fused_score DESC`
 * then `record_id ASC`. The richer caller-level tie-break —
 * `fused_score DESC, created_at DESC, record_id ASC` required by
 * Req 5.8 — is applied by `QueryLayer.search` after joining the
 * fused ids back to full `MemoryRecord`s, because the fusion layer
 * does not carry metadata beyond ranks.
 *
 * This module is pure and storage-agnostic. It imports nothing
 * from `src/collector/storage/sqlite/`, `src/shim/`,
 * `src/installer/`, or `src/mcp/` — matching the modularity rules
 * declared in design § Components and Interfaces and the barrel
 * constraints in task 3.10.
 *
 * @see Requirements 5.2, 5.3, 5.4, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — `rrfFuse(lexical, vector, k, limit)`
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Property 6 (RRF fusion algebraic contract)
 * @module
 */

/**
 * One entry in a ranked candidate list supplied to {@link rrfFuse}.
 *
 * `rank` is 1-based: the top-ranked document in the list has
 * `rank === 1`. Absence from a ranking is represented by omitting
 * the document from the list entirely — {@link rrfFuse} treats that
 * as a `+∞` rank contributing `0` to the fused score. A given
 * `record_id` should appear at most once per list; duplicates are
 * not meaningful in an RRF context and the caller is responsible
 * for de-duplication upstream (FTS5 and the cosine top-`k` each
 * produce one row per `record_id` by construction, so this is not
 * something the fusion layer has to defend against at runtime).
 *
 * @see Requirements 5.2, 18.2
 */
export interface Ranked {
  readonly record_id: string;
  /** 1-based position in the source ranking. */
  readonly rank: number;
}

/**
 * One fused hit returned by {@link rrfFuse}.
 *
 * `fused_score` is the sum of the per-list RRF contributions; see
 * {@link rrfFuse} for the formula. `lex_rank` / `vec_rank` are the
 * 1-based ranks from the lexical / vector input lists, or `null`
 * when the id was absent from that list (a `null` rank means that
 * side contributed `0` to `fused_score`). These fields are carried
 * through so the caller can apply richer tie-break logic and so
 * that downstream diagnostics can attribute a fused score to its
 * components without having to re-scan the inputs.
 *
 * @see Requirements 5.3, 5.4, 18.2
 */
export interface Fused {
  readonly record_id: string;
  readonly fused_score: number;
  readonly lex_rank: number | null;
  readonly vec_rank: number | null;
}

/**
 * Fuse two ranked lists via Reciprocal Rank Fusion.
 *
 * Contract (design § `rrfFuse`, Req 18.1–18.6):
 *
 * - **Score formula.** For every `d` in `L ∪ V`, `fused_score` is
 *   `1 / (k + rank_L(d)) + 1 / (k + rank_V(d))`, where a missing
 *   rank contributes `0`. Ids present in both lists receive the
 *   full two-term sum (Req 18.2).
 * - **Coverage.** The output contains exactly the distinct ids from
 *   `L ∪ V`, truncated to `limit`. Size is therefore
 *   `≤ min(limit, |L ∪ V|)` (Req 18.1).
 * - **Ordering.** Results are sorted by `(fused_score DESC,
 *   record_id ASC)`. This is deterministic given any stable sort
 *   in the JavaScript engine (all modern V8/Node sorts are
 *   stable), which is what Property 6 and Property 10 rely on
 *   (Req 18.6).
 * - **Rank monotonicity.** If two ids share the same `rank_L` but
 *   one has a strictly worse `rank_V`, its fused score is strictly
 *   smaller because `1 / (k + rank_V)` is a strictly decreasing
 *   function of `rank_V` for `k + rank_V > 0` (Property 6, rank
 *   monotonicity clause).
 * - **Agreement preservation.** When `L` and `V` are identical
 *   permutations, every id has `rank_L === rank_V` and the fused
 *   scores are therefore monotonically decreasing in that shared
 *   rank, so the output is that same permutation truncated to
 *   `limit` (Req 18.3).
 * - **Lexical-only fallback.** When `V === []`, each id has only
 *   its lexical contribution `1 / (k + rank_L)`, which is strictly
 *   decreasing in `rank_L`. The output is `L` in its original
 *   order, truncated to `limit` (Req 18.4).
 * - **Vector-only fallback.** Symmetric to the lexical case: when
 *   `L === []`, the output is `V` in its original order, truncated
 *   to `limit` (Req 18.5).
 *
 * Edge-case behaviour:
 *
 * - `limit <= 0` returns the empty array. A non-positive limit has
 *   no sensible meaning for a top-k fusion and the callers in this
 *   codebase never pass one, but guarding here keeps the function
 *   total.
 * - Both `L` and `V` empty returns the empty array.
 * - `k` is validated at the top of the function: non-finite or
 *   non-positive values throw with a descriptive error. The design
 *   assumes `k > 0` so that `k + rank` is strictly positive for every
 *   1-based `rank`; a bad `k` would silently corrupt `fused_score` by
 *   producing a zero or negative denominator, so we fail fast instead.
 *   Callers pass the configured RRF constant (`CollectorConfig.rrfK`,
 *   default `60`); an invalid value here indicates a configuration
 *   bug, not a runtime condition to tolerate.
 *
 * Complexity is `O(|L| + |V| + n log n)` where `n = |L ∪ V|`,
 * dominated by the final sort. For the scale target (`limit ≤ 10`,
 * `fetchDepth ≤ 40` per side, so `n ≤ 80`) this is negligible.
 *
 * @param lexical - 1-based ranked list from the FTS5 retriever.
 * @param vector - 1-based ranked list from the cosine retriever.
 * @param k - RRF constant (design default `60`). Must be a
 *   positive finite number so that `k + rank > 0` for every 1-based
 *   input `rank`. Invalid values throw.
 * @param limit - Maximum number of fused hits to return.
 * @returns Fused ranking, sorted and truncated to `limit`.
 *
 * @see Requirements 5.2, 5.3, 5.4, 18.1, 18.2, 18.3, 18.4, 18.5, 18.6
 */
export function rrfFuse(
  lexical: readonly Ranked[],
  vector: readonly Ranked[],
  k: number,
  limit: number,
): readonly Fused[] {
  if (limit <= 0) return [];

  // Guard against non-finite or non-positive `k`. The design
  // assumes `k > 0` so that `k + rank` is strictly positive for
  // every 1-based `rank`; a `k` of `NaN`, `-Infinity`, or a value
  // ≤ -1 would produce `NaN` / negative / zero denominators and
  // silently corrupt `fused_score`, breaking the ordering
  // invariant (Req 18.6) without surfacing an error. Callers pass
  // the configured RRF constant (default 60); a bad value here
  // indicates a configuration bug, not a runtime condition to
  // tolerate.
  if (!Number.isFinite(k) || k <= 0) {
    throw new Error(`rrfFuse: k must be a positive finite number, got ${String(k)}`);
  }

  // Mutable accumulator shape. The fields are kept mutable here so
  // the two accumulation passes can update them in-place; the
  // values are frozen into immutable `Fused` records only when the
  // final sorted slice is produced below.
  type Accumulator = {
    fused_score: number;
    lex_rank: number | null;
    vec_rank: number | null;
  };

  const scores = new Map<string, Accumulator>();

  for (const r of lexical) {
    let entry = scores.get(r.record_id);
    if (entry === undefined) {
      entry = { fused_score: 0, lex_rank: null, vec_rank: null };
      scores.set(r.record_id, entry);
    }
    entry.lex_rank = r.rank;
    entry.fused_score += 1 / (k + r.rank);
  }

  for (const r of vector) {
    let entry = scores.get(r.record_id);
    if (entry === undefined) {
      entry = { fused_score: 0, lex_rank: null, vec_rank: null };
      scores.set(r.record_id, entry);
    }
    entry.vec_rank = r.rank;
    entry.fused_score += 1 / (k + r.rank);
  }

  // Materialise to an array for sorting. The `Fused` shape is
  // readonly so we build fresh objects rather than leaking the
  // mutable accumulator to the caller.
  const all: Fused[] = [];
  for (const [record_id, entry] of scores) {
    all.push({
      record_id,
      fused_score: entry.fused_score,
      lex_rank: entry.lex_rank,
      vec_rank: entry.vec_rank,
    });
  }

  // `fused_score DESC, then record_id ASC`. Node's Array.prototype
  // .sort is stable since V8 7.0 / Node 11, which keeps equal-score
  // ties deterministic even across identical inputs (Property 10).
  all.sort((a, b) => {
    if (a.fused_score !== b.fused_score) return b.fused_score - a.fused_score;
    if (a.record_id < b.record_id) return -1;
    if (a.record_id > b.record_id) return 1;
    return 0;
  });

  if (all.length <= limit) return all;
  return all.slice(0, limit);
}
