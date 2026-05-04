/**
 * Ingestion / Reconciler — the Reconciliation Stage of the Ingestion
 * Pipeline.
 *
 * Given a batch of in-memory {@link CandidateMemory} values from the
 * Extraction Stage, this module:
 *
 *   1. Clusters intra-batch duplicates via
 *      {@link intraBatchCluster} (cosine ≥ `intraBatchSimilarityThreshold`).
 *   2. For every cluster with a non-null centroid, consults the
 *      per-namespace vector index for existing `memory_records` whose
 *      cosine similarity against the centroid meets
 *      `neighborSimilarityThreshold`, capped at `neighborPoolMaxSize`.
 *   3. For every cluster with ≥1 neighbor, invokes the
 *      `kiro-learn-reconciler` ACP agent with a
 *      `<reconciliation_request>` prompt and parses the response into
 *      either a merge decision or a keep-separate decision.
 *   4. Commits the decision inside a single `storage.withTransaction`
 *      call — merge paths write a fresh Summary Record and delete the
 *      merged originals atomically, keep-separate paths write each
 *      cluster member as a new memory record.
 *   5. Invalidates the per-namespace vector cache after every commit.
 *
 * ## Failure isolation
 *
 * Per-cluster errors (storage failure, embed failure, judge parse
 * failure that exhausts the retry budget) are caught and logged; the
 * outer loop continues with the next cluster. This matches
 * Requirement 8.2 ("abort only that cluster's writes and continue
 * processing remaining Candidate Clusters") and is the reason the
 * function's return shape carries `clustersFailed`.
 *
 * ## ACP session lifecycle
 *
 * Every judge invocation follows the single-use pattern used by the
 * compressor and compactor:
 *
 * ```ts
 * const session = await createAcpSession({ agentName: 'kiro-learn-reconciler', timeoutMs });
 * try {
 *   const text = await session.sendPrompt(framed);
 *   return parseJudgeResponse(text);
 * } finally {
 *   session.destroy();
 * }
 * ```
 *
 * `destroy()` is always called exactly once per session, in a
 * `finally` block (Requirement 6.8, Property 19).
 *
 * ## Circuit breaker feedback
 *
 * Each judge invocation records one outcome on the circuit breaker:
 * `'failure'` on timeout or final parse failure, `'success'` when the
 * response parses to a well-formed `JudgeResponse`. At end of run the
 * outer pipeline (`index.ts`, task 10) calls
 * `circuitBreaker.onRunComplete(projectId, anyJudgeFailure)` so a
 * tripped breaker can self-heal after the next clean run
 * (Requirement 12.3).
 *
 * ## Modularity
 *
 * This module lives at `src/collector/ingestion/` and MUST NOT import
 * from `src/collector/storage/sqlite/` — the modularity-guard test
 * under `test/unit/no-sqlite-in-ingestion.test.ts` (task 16.1) pins
 * the invariant. Allowed imports: `src/types/`,
 * `src/collector/embedding/` (barrel), `src/collector/pipeline/acp-client`,
 * `src/collector/query/` (for the `QueryLayer` type), `./candidate.js`,
 * `./circuit-breaker.js`, `./clustering.js`, `./judge-xml.js`, and
 * `ulidx` for the Summary Record id.
 *
 * @see .kiro/specs/reconciliation-engine/design.md § `reconciler.ts` —
 *   neighbor lookup, judge invocation, commit
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 5.1–5.5,
 *   6.1–6.8, 7.1–7.7, 8.1–8.3, 9.1–9.5, 11.2, 12.1–12.3
 * @module
 */

import { createHash } from 'node:crypto';

import { ulid } from 'ulidx';

import type {
  CandidateMemory,
  MemoryRecord,
  StorageBackend,
  StorageTransaction,
} from '../../types/index.js';
import { composeEmbeddingInput } from '../embedding/index.js';
import type { Embedder } from '../embedding/index.js';
import { createAcpSession } from '../pipeline/acp-client.js';
import type { AcpSession } from '../pipeline/acp-client.js';
import type { QueryLayer } from '../query/index.js';

import { toMemoryRecord } from './candidate.js';
import type { ReconciliationCircuitBreaker } from './circuit-breaker.js';
import { intraBatchCluster } from './clustering.js';
import type { Cluster } from './clustering.js';
import { frameJudgePrompt, parseJudgeResponse } from './judge-xml.js';
import type { JudgeMergeResponse, JudgeRequest, JudgeResponse } from './judge-xml.js';

// ── Public types ────────────────────────────────────────────────────────

/**
 * Configuration knobs the reconciler reads. Sourced from the collector
 * config (see `src/collector/index.ts` after task 13).
 *
 * @see Requirements 4.5, 5.3, 5.4, 6.6, 10.3, 10.4, 10.5, 10.6
 */
export interface ReconcilerConfig {
  /** Cosine-similarity floor for intra-batch clustering. Default 0.85. */
  intraBatchSimilarityThreshold: number;
  /** Cosine-similarity floor for neighbor lookup. Default 0.80. */
  neighborSimilarityThreshold: number;
  /** Max neighbor pool size per cluster. Default 10. */
  neighborPoolMaxSize: number;
  /** Per-judge-call timeout in milliseconds. Default 30_000. */
  judgeModelTimeoutMs: number;
  /** When true, emit per-cluster debug detail on stderr (Requirement 11.4). */
  debug: boolean;
}

/**
 * Dependencies + per-run identity injected into {@link reconcile}.
 *
 * `storage` and `query` are the two seams through which the reconciler
 * touches persistent state. `embedder` is required for the merge path
 * (Summary Records are embedded at commit time); the reconciler
 * gracefully no-embedding-commits a Summary Record when the embedder
 * is null or not ready, same as the direct-commit fallback does today.
 *
 * `namespace` is the shared namespace of every candidate in the batch —
 * buffer snapshots are per-project, so this invariant holds by
 * construction. The reconciler asserts it defensively but does not
 * enforce it schema-style.
 */
export interface ReconciliationContext {
  storage: StorageBackend;
  query: QueryLayer;
  embedder: Embedder | null;
  config: ReconcilerConfig;
  circuitBreaker: ReconciliationCircuitBreaker;
  projectId: string;
  namespace: string;
}

/**
 * Summary of what the reconciler did for a single run. Aggregated per
 * batch — the pipeline rolls these into the wider `IngestionResult`
 * (task 10) before emitting the structured log.
 */
export interface ReconciliationOutcome {
  /** Number of Summary Records written (one per merge decision). */
  summaryRecordsCommitted: number;
  /** Count of `memory_records` rows deleted across all merge commits. */
  recordsDeleted: number;
  /** Count of individual cluster members committed on keep-separate paths. */
  keepSeparateCommitted: number;
  /** Total ACP sessions opened against `kiro-learn-reconciler`. */
  judgeInvocations: number;
  /** Count of clusters whose final decision was `<merge>`. */
  mergeDecisions: number;
  /** Count of clusters whose final decision was `<keep_separate/>` (or fallback). */
  keepSeparateDecisions: number;
  /** Count of clusters that failed to commit due to an exception (Requirement 8.2). */
  clustersFailed: number;
  /** Phase-level latency breakdown in milliseconds. */
  phaseLatencyMs: {
    clustering: number;
    neighborLookup: number;
    judge: number;
    commit: number;
  };
  /** True when at least one judge invocation ended in failure this run. */
  anyJudgeFailure: boolean;
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Compose a Summary Record from a judge merge decision.
 *
 * Fields come from three sources:
 *
 * - Judge response: `title`, `summary`, `facts`, `concepts`,
 *   `files_touched`, optional `observation_type`.
 * - Cluster + merged neighbors: `source_event_ids` (deduped first-seen
 *   union) and the observation-type fallback (highest-similarity
 *   merged member) when the judge omits it.
 * - Freshly stamped: `record_id = 'mr_' + ulid()`, `strategy =
 *   'llm-reconciled'`, `namespace = ctx.namespace`, `created_at =
 *   new Date().toISOString()` (Requirements 7.2, 7.7).
 *
 * See {@link dedupedFirstSeenUnion} for the union semantics.
 */
function composeSummaryRecord(
  decision: JudgeMergeResponse,
  mergedMembers: readonly MergedMember[],
  namespace: string,
): MemoryRecord {
  // ── source_event_ids — deduped first-seen union across every
  //    merged entity (cluster member + neighbor).
  const sourceEventIds = dedupedFirstSeenUnion(...mergedMembers.map((m) => m.source_event_ids));

  // ── observation_type — judge value if present + recognised, else
  //    the highest-similarity member's type. `mergedMembers` is
  //    ordered by similarity descending already (cluster members
  //    first at similarity 1.0, then neighbors by descending
  //    similarity).
  const fallbackObservationType = mergedMembers[0]?.observation_type ?? 'tool_use';
  const observationType = decision.observation_type ?? fallbackObservationType;

  return {
    record_id: `mr_${ulid()}`,
    namespace,
    strategy: 'llm-reconciled',
    title: decision.title,
    summary: decision.summary,
    facts: [...decision.facts],
    concepts: [...decision.concepts],
    files_touched: [...decision.files_touched],
    observation_type: observationType,
    source_event_ids: sourceEventIds,
    created_at: new Date().toISOString(),
  };
}

/**
 * Return the first-seen-order deduplication of the concatenation of
 * every input array. Order within the first-seen group is preserved.
 *
 * Property 17 — for any merge, the Summary Record's `source_event_ids`
 * equals `dedupedFirstSeenUnion(...merged.source_event_ids)`.
 */
function dedupedFirstSeenUnion(...arrays: Array<readonly string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const arr of arrays) {
    for (const item of arr) {
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
  }
  return out;
}

/**
 * Normalised description of one merged entity for use by
 * {@link composeSummaryRecord}. Unifies the shape of a cluster member
 * (which has an implied similarity of 1.0) and a neighbor (which
 * carries its own similarity).
 *
 * The list ordering encodes "highest similarity first" — cluster
 * members always come first (similarity 1.0) followed by neighbors in
 * descending-similarity order, so `mergedMembers[0]` is the natural
 * fallback when the judge omits `observation_type`.
 */
interface MergedMember {
  record_id: string;
  source_event_ids: readonly string[];
  observation_type: MemoryRecord['observation_type'];
}

/**
 * Build the {@link JudgeRequest} handed to {@link frameJudgePrompt}
 * from the cluster's members + their neighbor pool.
 *
 * Cluster members use their full `facts` / `concepts` /
 * `files_touched` arrays, but as `readonly` snapshots — the framer
 * does not mutate.
 */
function buildJudgeRequest(
  cluster: Cluster,
  candidates: readonly CandidateMemory[],
  neighbors: ReadonlyArray<{ record: MemoryRecord; similarity: number }>,
): JudgeRequest {
  const members = cluster.members.map((idx) => {
    const c = candidates[idx];
    if (c === undefined) {
      // Unreachable: `cluster.members` are always indices into
      // `candidates` by construction (see `intraBatchCluster`).
      throw new Error(`reconciler: cluster member index ${String(idx)} out of range`);
    }
    return {
      record_id: c.record_id,
      title: c.title,
      summary: c.summary,
      facts: c.facts,
      concepts: c.concepts,
      files_touched: c.files_touched,
      observation_type: c.observation_type,
    };
  });
  return {
    cluster: {
      centroid: cluster.centroid,
      members,
    },
    neighbors: neighbors.map((n) => ({
      record_id: n.record.record_id,
      title: n.record.title,
      summary: n.record.summary,
      facts: n.record.facts,
      similarity: n.similarity,
    })),
  };
}

/**
 * Invoke the judge once. Returns `{ kind: 'ok', response }` on a
 * successful parse, `{ kind: 'timeout' }` when the session times out,
 * or `{ kind: 'parse-failure' }` when the session returned non-XML /
 * malformed output that `parseJudgeResponse` rejected.
 *
 * Every session is created with `{ agentName: 'kiro-learn-reconciler',
 * timeoutMs }` and is `destroy()`-ed exactly once before this helper
 * returns (Requirement 6.8).
 *
 * Errors other than timeout (spawn failure, unexpected ACP-level
 * errors) propagate to the caller as `{ kind: 'parse-failure' }` so
 * they feed the retry budget — exception propagation would short-
 * circuit the per-cluster error isolation in `reconcile`.
 */
async function invokeJudgeOnce(
  framed: string,
  timeoutMs: number,
  captureRaw: boolean,
): Promise<
  | { kind: 'ok'; response: JudgeResponse; raw: string | null }
  | { kind: 'timeout'; raw: string | null }
  | { kind: 'parse-failure'; raw: string | null }
> {
  let session: AcpSession | null = null;
  let raw: string | null = null;
  try {
    session = await createAcpSession({
      agentName: 'kiro-learn-reconciler',
      timeoutMs,
    });
    const rawResponse = await session.sendPrompt(framed);
    if (captureRaw) {
      raw = rawResponse;
    }
    const parsed = parseJudgeResponse(rawResponse);
    if (parsed === null) {
      return { kind: 'parse-failure', raw };
    }
    return { kind: 'ok', response: parsed, raw };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // The ACP client signals timeout via an Error whose message
    // includes the substring "timed out". Any other thrown error
    // from spawn / I/O / sendPrompt falls through as a parse
    // failure so the retry budget handles it uniformly with other
    // garbage-response cases.
    if (/timed out/i.test(message)) {
      return { kind: 'timeout', raw };
    }
    return { kind: 'parse-failure', raw };
  } finally {
    // Exactly one destroy per session, in a finally block —
    // Property 19.
    session?.destroy();
  }
}

/**
 * Run the retry loop over `invokeJudgeOnce`. Timeout is terminal (no
 * retry — the budget has already been burned). Parse failures retry
 * once with a fresh session for a total of at most 2 attempts per
 * cluster (Requirement 12.2).
 *
 * The returned `judgeInvocations` counts every attempt (each one
 * opens a session), and `outcomesRecorded` lists the outcome each
 * attempt contributes to the circuit breaker.
 */
async function invokeJudgeWithRetry(
  framed: string,
  timeoutMs: number,
  captureRaw: boolean,
): Promise<{
  response: JudgeResponse | null;
  judgeInvocations: number;
  outcomesRecorded: Array<'success' | 'failure'>;
  /**
   * Raw XML text of the most recent judge response — used only when
   * `captureRaw === true` (debug logging gate). `null` when debug is
   * off or when every attempt threw before receiving a response
   * (e.g. session spawn failure, timeout before any bytes arrived).
   */
  lastRawResponse: string | null;
}> {
  const outcomesRecorded: Array<'success' | 'failure'> = [];
  let invocations = 0;
  let lastRawResponse: string | null = null;
  const maxAttempts = 2;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    invocations += 1;
    const result = await invokeJudgeOnce(framed, timeoutMs, captureRaw);
    // Track the most recent raw response across all attempts so the
    // debug log can show what the LAST attempt actually returned —
    // whether successful, timed-out, or garbage.
    if (captureRaw && result.raw !== null) {
      lastRawResponse = result.raw;
    }
    if (result.kind === 'ok') {
      outcomesRecorded.push('success');
      return {
        response: result.response,
        judgeInvocations: invocations,
        outcomesRecorded,
        lastRawResponse,
      };
    }
    // Every non-OK attempt records a failure on the circuit
    // breaker — both timeout and parse-failure count.
    outcomesRecorded.push('failure');
    if (result.kind === 'timeout') {
      // Timeout is terminal per Requirement 6.6 — the full
      // judgeModelTimeoutMs was already burned, so retrying would
      // double the budget without actionable signal.
      return {
        response: null,
        judgeInvocations: invocations,
        outcomesRecorded,
        lastRawResponse,
      };
    }
    // parse-failure → retry on next loop iteration with a fresh
    // session. The `for` loop handles the retry limit via its
    // `attempt < maxAttempts` guard.
  }
  return {
    response: null,
    judgeInvocations: invocations,
    outcomesRecorded,
    lastRawResponse,
  };
}

/**
 * Resolve a judge merge decision's `merged_record_ids` into the
 * corresponding {@link MergedMember} objects.
 *
 * Unknown ids (ones that match neither a cluster member nor a
 * neighbor) are ignored with a stderr warning — the judge sometimes
 * hallucinates ids. When the known intersection is empty the
 * reconciler falls back to keep-separate (checked by the caller).
 */
function resolveMergedMembers(
  decision: JudgeMergeResponse,
  cluster: Cluster,
  candidates: readonly CandidateMemory[],
  neighbors: ReadonlyArray<{ record: MemoryRecord; similarity: number }>,
): { members: MergedMember[]; neighborIdsToDelete: string[] } {
  // Cluster members are implicitly at similarity 1.0 — they defined
  // the centroid. They come first in the merged-list ordering so
  // the observation-type fallback picks them over neighbors.
  const memberById = new Map<string, CandidateMemory>();
  for (const idx of cluster.members) {
    const c = candidates[idx];
    if (c === undefined) continue;
    memberById.set(c.record_id, c);
  }
  const neighborById = new Map<string, { record: MemoryRecord; similarity: number }>();
  for (const n of neighbors) {
    neighborById.set(n.record.record_id, n);
  }

  const members: MergedMember[] = [];
  const neighborIdsToDelete: string[] = [];
  const seenIds = new Set<string>();

  // Collect members with their role + similarity so we can sort for
  // `composeSummaryRecord`'s observation-type fallback, which reads
  // `mergedMembers[0].observation_type`. The sort precedence is:
  //   1. Cluster members beat neighbors. Cluster members defined
  //      the centroid, so they are the natural "most representative"
  //      source — and using a hard precedence avoids FP wobble
  //      around cosine-of-self-against-centroid ≈ 1.0.
  //   2. Within each bucket, similarity descending. A judge that
  //      rolls multiple neighbors into a merge gets the highest-
  //      similarity one's observation_type as the fallback.
  //   3. Citation order as a stable tie-breaker so byte-identical
  //      similarities don't shuffle between runs.
  interface IndexedMember {
    member: MergedMember;
    isClusterMember: boolean;
    similarity: number;
    seenOrder: number;
    neighborRecordId: string | null;
  }
  const indexed: IndexedMember[] = [];

  for (const id of decision.merged_record_ids) {
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const candidate = memberById.get(id);
    if (candidate !== undefined) {
      indexed.push({
        member: {
          record_id: candidate.record_id,
          source_event_ids: candidate.source_event_ids,
          observation_type: candidate.observation_type,
        },
        isClusterMember: true,
        // Cluster members are equivalent for ordering purposes;
        // the bucket flag above separates them from neighbors.
        similarity: 1.0,
        seenOrder: indexed.length,
        neighborRecordId: null,
      });
      continue;
    }
    const neighbor = neighborById.get(id);
    if (neighbor !== undefined) {
      indexed.push({
        member: {
          record_id: neighbor.record.record_id,
          source_event_ids: neighbor.record.source_event_ids,
          observation_type: neighbor.record.observation_type,
        },
        isClusterMember: false,
        similarity: neighbor.similarity,
        seenOrder: indexed.length,
        neighborRecordId: neighbor.record.record_id,
      });
      continue;
    }
    // Unknown id — log and continue. The caller decides whether
    // the resulting subset is usable.
    process.stderr.write(
      `[kiro-learn] reconciler: judge cited unknown record_id ${id}, ignoring\n`,
    );
  }

  indexed.sort((a, b) => {
    if (a.isClusterMember !== b.isClusterMember) {
      return a.isClusterMember ? -1 : 1;
    }
    if (a.similarity !== b.similarity) return b.similarity - a.similarity;
    return a.seenOrder - b.seenOrder;
  });

  for (const entry of indexed) {
    members.push(entry.member);
    if (entry.neighborRecordId !== null) {
      neighborIdsToDelete.push(entry.neighborRecordId);
    }
  }

  return { members, neighborIdsToDelete };
}

/**
 * Compute an embedding for a Summary Record using `ctx.embedder`.
 * Returns `null` when the embedder is absent, not ready, or fails
 * per-call — the Summary Record still commits in all three cases
 * (matching the extraction path's embed-on-write guards). Backfill
 * will fill the embedding later on daemon restart.
 */
async function embedSummary(
  record: MemoryRecord,
  embedder: Embedder | null,
): Promise<Float32Array | null> {
  if (embedder === null) return null;
  if (!embedder.isReady()) {
    process.stderr.write(
      `[kiro-learn] reconciler: degraded mode: skipping embed for summary ${record.record_id} (embedder not ready)\n`,
    );
    return null;
  }
  try {
    const input = composeEmbeddingInput(record);
    return await embedder.embed(input);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[kiro-learn] reconciler: embedding failed for summary ${record.record_id}: ${message}\n`,
    );
    return null;
  }
}

/**
 * Commit a cluster's keep-separate decision. Writes each member as a
 * new `memory_record` + optional embedding inside a single
 * `storage.withTransaction` block (Requirement 8.1).
 */
async function commitKeepSeparate(
  cluster: Cluster,
  candidates: readonly CandidateMemory[],
  ctx: ReconciliationContext,
): Promise<{ committed: number }> {
  const members: CandidateMemory[] = [];
  for (const idx of cluster.members) {
    const c = candidates[idx];
    if (c === undefined) continue;
    members.push(c);
  }
  if (members.length === 0) return { committed: 0 };

  await ctx.storage.withTransaction((tx: StorageTransaction) => {
    for (const member of members) {
      const record = toMemoryRecord(member);
      tx.putMemoryRecord(record);
      if (member.embedding !== null) {
        tx.putEmbedding(record.record_id, member.embedding);
      }
    }
  });

  ctx.query.invalidateNamespace(ctx.namespace);
  return { committed: members.length };
}

/**
 * Commit a cluster's merge decision. Writes the Summary Record and
 * deletes the merged originals inside one transaction, then embeds
 * the Summary and writes the embedding in a follow-up call (not
 * inside the same transaction — embed is async and the transaction
 * body is synchronous by contract).
 *
 * Actually — we embed the Summary Record *before* opening the
 * transaction so the embedding can land inside the same synchronous
 * `withTransaction` body as the delete + insert. The design spec
 * calls for this to be atomic: "one `putMemoryRecord(summary)` +
 * `deleteMemoryRecord(mergedIds)` + `putEmbedding(summary.record_id,
 * summaryEmbedding)` inside a single `StorageBackend` transaction".
 */
async function commitMerge(
  decision: JudgeMergeResponse,
  cluster: Cluster,
  candidates: readonly CandidateMemory[],
  neighbors: ReadonlyArray<{ record: MemoryRecord; similarity: number }>,
  ctx: ReconciliationContext,
): Promise<{ merged: true; recordsDeleted: number } | { merged: false }> {
  const { members, neighborIdsToDelete } = resolveMergedMembers(
    decision,
    cluster,
    candidates,
    neighbors,
  );
  if (members.length === 0) {
    // Judge cited only unknown ids — fall back to keep-separate so
    // we don't commit a summary referencing nothing.
    process.stderr.write(
      `[kiro-learn] reconciler: judge merge cited no known record_ids, falling back to keep-separate\n`,
    );
    return { merged: false };
  }

  const summary = composeSummaryRecord(decision, members, ctx.namespace);
  // Embed BEFORE entering the transaction — the transaction body is
  // synchronous and cannot await. This keeps the commit atomic
  // across insert + delete + putEmbedding per Requirement 8.1.
  const embedding = await embedSummary(summary, ctx.embedder);

  await ctx.storage.withTransaction((tx: StorageTransaction) => {
    tx.putMemoryRecord(summary);
    if (neighborIdsToDelete.length > 0) {
      tx.deleteMemoryRecord(neighborIdsToDelete);
    }
    if (embedding !== null) {
      tx.putEmbedding(summary.record_id, embedding);
    }
  });

  ctx.query.invalidateNamespace(ctx.namespace);
  return { merged: true, recordsDeleted: neighborIdsToDelete.length };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Reconcile a batch of candidates against the existing graph.
 *
 * See the module-level doc comment for the full per-cluster flow.
 * Returns an aggregate {@link ReconciliationOutcome} counting every
 * commit, judge invocation, and cluster-level failure the batch
 * produced. The caller (`IngestionPipeline.run`) uses this to build
 * the structured log line and to decide whether to clear the buffer.
 *
 * Per-cluster failures are isolated (Requirement 8.2): a storage
 * error on cluster N does not prevent clusters N+1..K from
 * committing.
 *
 * @param candidates - Output of the Extraction Stage. May be empty.
 * @param ctx - Dependencies + per-run identity. `namespace` is the
 *   shared namespace of every candidate in the batch.
 */
export async function reconcile(
  candidates: readonly CandidateMemory[],
  ctx: ReconciliationContext,
): Promise<ReconciliationOutcome> {
  const outcome: ReconciliationOutcome = {
    summaryRecordsCommitted: 0,
    recordsDeleted: 0,
    keepSeparateCommitted: 0,
    judgeInvocations: 0,
    mergeDecisions: 0,
    keepSeparateDecisions: 0,
    clustersFailed: 0,
    phaseLatencyMs: {
      clustering: 0,
      neighborLookup: 0,
      judge: 0,
      commit: 0,
    },
    anyJudgeFailure: false,
  };

  if (candidates.length === 0) return outcome;

  // ── Phase 1: clustering ────────────────────────────────────────────
  const tClusteringStart = performance.now();
  const clusters = intraBatchCluster(candidates, ctx.config.intraBatchSimilarityThreshold);
  outcome.phaseLatencyMs.clustering = performance.now() - tClusteringStart;

  // ── Phases 2–4: per-cluster (neighbor lookup + judge + commit) ────
  for (const cluster of clusters) {
    try {
      await processCluster(cluster, candidates, ctx, outcome);
    } catch (err: unknown) {
      // Per-cluster failure isolation (Requirement 8.2).
      // Log with the cluster's member record_ids so an operator
      // can correlate the failure to the original candidates.
      outcome.clustersFailed += 1;
      const memberIds = cluster.members
        .map((idx) => candidates[idx]?.record_id ?? '<unknown>')
        .join(',');
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[kiro-learn] reconciler: cluster commit failed [members=${memberIds}]: ${message}\n`,
      );
      // Continue with the next cluster — do not rethrow.
    }
  }

  return outcome;
}

/**
 * Determine whether per-cluster debug logging is active for this run.
 *
 * Gated by either the `config.debug` flag (from `CollectorConfig.reconciliationDebug`,
 * wired through `ReconcilerConfig.debug`) OR the `RECONCILER_DEBUG=true`
 * environment variable. The env-var fallback is documented in
 * Requirement 11.4 so an operator can flip on per-cluster debug output
 * without restarting the daemon through a full config rewrite.
 */
function isDebugEnabled(ctx: ReconciliationContext): boolean {
  return ctx.config.debug === true || process.env['RECONCILER_DEBUG'] === 'true';
}

/**
 * Emit one `ingestion-cluster-debug` JSON-Lines record to stderr.
 *
 * Payload shape (Requirement 11.4):
 *
 * ```json
 * {
 *   "event": "ingestion-cluster-debug",
 *   "project_id": "...",
 *   "cluster_members": ["mr_...", ...],
 *   "neighbor_pool": [{ "record_id": "mr_...", "similarity": 0.87 }, ...],
 *   "judge_request_xml_sha256": "<sha256 hex>" | null,
 *   "judge_response_xml": "<raw XML text>" | null
 * }
 * ```
 *
 * The request XML is hashed (never logged in full) to avoid leaking PII
 * from candidate summaries / facts. The response XML is logged verbatim
 * because diagnosing judge-model regressions requires seeing the exact
 * tokens the model emitted.
 *
 * When no judge was invoked for the cluster (null centroid, empty
 * neighbor pool, or a retry-exhausted fallback), `judge_request_xml_sha256`
 * and `judge_response_xml` are `null`. The cluster debug line still
 * emits so an operator can correlate "this cluster existed, these were
 * its neighbors, no judge ran".
 */
function emitClusterDebugLog(args: {
  projectId: string;
  clusterMembers: readonly string[];
  neighborPool: ReadonlyArray<{ record_id: string; similarity: number }>;
  judgeRequestXmlSha256: string | null;
  judgeResponseXml: string | null;
}): void {
  const payload = {
    event: 'ingestion-cluster-debug',
    project_id: args.projectId,
    cluster_members: [...args.clusterMembers],
    neighbor_pool: args.neighborPool.map((n) => ({
      record_id: n.record_id,
      similarity: n.similarity,
    })),
    judge_request_xml_sha256: args.judgeRequestXmlSha256,
    judge_response_xml: args.judgeResponseXml,
  };
  try {
    process.stderr.write(JSON.stringify(payload) + '\n');
  } catch {
    // Never let a logging failure abort reconciliation. Defensive —
    // `process.stderr.write` can fail in pathological environments
    // (EPIPE during teardown).
  }
}

/**
 * Process a single cluster. Broken out of the outer loop so the
 * try/catch in `reconcile` can isolate failures at cluster
 * granularity (Requirement 8.2).
 *
 * Mutates `outcome` in place — this matches the rest of the batch-
 * aggregation pattern used elsewhere in the pipeline (e.g.
 * `ExtractionResult` built up across retry attempts).
 */
async function processCluster(
  cluster: Cluster,
  candidates: readonly CandidateMemory[],
  ctx: ReconciliationContext,
  outcome: ReconciliationOutcome,
): Promise<void> {
  const debugEnabled = isDebugEnabled(ctx);
  const clusterMemberIds = cluster.members
    .map((idx) => candidates[idx]?.record_id)
    .filter((id): id is string => id !== undefined);

  // ── 2a: null-centroid or single-null-embedding cluster → commit
  //       members directly, no neighbor lookup, no judge.
  if (cluster.centroid === null) {
    const tCommit = performance.now();
    const { committed } = await commitKeepSeparate(cluster, candidates, ctx);
    outcome.phaseLatencyMs.commit += performance.now() - tCommit;
    outcome.keepSeparateCommitted += committed;
    // This path is not a judge decision — neither mergeDecisions nor
    // keepSeparateDecisions is incremented. Only clusters that
    // reached a (potentially implicit) decision count there.
    if (debugEnabled) {
      emitClusterDebugLog({
        projectId: ctx.projectId,
        clusterMembers: clusterMemberIds,
        neighborPool: [],
        judgeRequestXmlSha256: null,
        judgeResponseXml: null,
      });
    }
    return;
  }

  // ── 2b: neighbor lookup.
  const tNeighbor = performance.now();
  const neighbors = await ctx.query.lookupNeighbors(
    ctx.namespace,
    cluster.centroid,
    ctx.config.neighborSimilarityThreshold,
    ctx.config.neighborPoolMaxSize,
  );
  outcome.phaseLatencyMs.neighborLookup += performance.now() - tNeighbor;

  const neighborPool = neighbors.map((n) => ({
    record_id: n.record.record_id,
    similarity: n.similarity,
  }));

  // ── 2c: empty neighbor pool → commit members as new records. No
  //       judge invocation (Property 14).
  if (neighbors.length === 0) {
    const tCommit = performance.now();
    const { committed } = await commitKeepSeparate(cluster, candidates, ctx);
    outcome.phaseLatencyMs.commit += performance.now() - tCommit;
    outcome.keepSeparateCommitted += committed;
    if (debugEnabled) {
      emitClusterDebugLog({
        projectId: ctx.projectId,
        clusterMembers: clusterMemberIds,
        neighborPool,
        judgeRequestXmlSha256: null,
        judgeResponseXml: null,
      });
    }
    return;
  }

  // ── 2d: judge invocation with retry.
  const tJudge = performance.now();
  const request = buildJudgeRequest(cluster, candidates, neighbors);
  const framed = frameJudgePrompt(request);
  const judgeOutcome = await invokeJudgeWithRetry(
    framed,
    ctx.config.judgeModelTimeoutMs,
    debugEnabled,
  );
  outcome.phaseLatencyMs.judge += performance.now() - tJudge;
  outcome.judgeInvocations += judgeOutcome.judgeInvocations;
  for (const recorded of judgeOutcome.outcomesRecorded) {
    ctx.circuitBreaker.record(ctx.projectId, recorded);
    if (recorded === 'failure') {
      outcome.anyJudgeFailure = true;
    }
  }

  // Emit the per-cluster debug line AFTER the judge response is
  // received, with the hashed request prompt and the raw response
  // XML (Requirement 11.4). When the retry budget was exhausted
  // (no response parsed), we still have the last raw payload from
  // `judgeOutcome.lastRawResponse` — useful for diagnosing the
  // parser-failure case.
  if (debugEnabled) {
    const requestHash = createHash('sha256').update(framed).digest('hex');
    emitClusterDebugLog({
      projectId: ctx.projectId,
      clusterMembers: clusterMemberIds,
      neighborPool,
      judgeRequestXmlSha256: requestHash,
      judgeResponseXml: judgeOutcome.lastRawResponse,
    });
  }

  // ── 2e: commit the decision. A null response means the retry
  //       budget was exhausted → keep-separate fallback.
  const tCommit = performance.now();
  if (judgeOutcome.response === null) {
    const { committed } = await commitKeepSeparate(cluster, candidates, ctx);
    outcome.keepSeparateDecisions += 1;
    outcome.keepSeparateCommitted += committed;
  } else if (judgeOutcome.response.kind === 'keep_separate') {
    const { committed } = await commitKeepSeparate(cluster, candidates, ctx);
    outcome.keepSeparateDecisions += 1;
    outcome.keepSeparateCommitted += committed;
  } else {
    const mergeResult = await commitMerge(
      judgeOutcome.response,
      cluster,
      candidates,
      neighbors,
      ctx,
    );
    if (mergeResult.merged) {
      outcome.mergeDecisions += 1;
      outcome.summaryRecordsCommitted += 1;
      outcome.recordsDeleted += mergeResult.recordsDeleted;
    } else {
      // Fallback because the judge cited no known ids.
      const { committed } = await commitKeepSeparate(cluster, candidates, ctx);
      outcome.keepSeparateDecisions += 1;
      outcome.keepSeparateCommitted += committed;
    }
  }
  outcome.phaseLatencyMs.commit += performance.now() - tCommit;
}
