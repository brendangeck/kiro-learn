/**
 * Ingestion / Candidate module — produces Candidate Memories from a buffer
 * snapshot.
 *
 * This is the Extraction Stage output of the Ingestion Pipeline. The
 * function {@link extractCandidates} frames a buffer batch as XML, invokes
 * the `kiro-learn-compressor` agent over ACP, parses the XML response, and
 * enriches every returned memory fragment with a fresh `record_id`,
 * namespace, `source_event_ids`, and — when the {@link Embedder} is ready —
 * a pre-computed 384-dimensional embedding vector.
 *
 * The crucial contract is **in-memory only**: this module NEVER calls
 * `storage.putMemoryRecord` or `storage.putEmbedding`. It produces an
 * in-memory array of {@link CandidateMemory} values that the Reconciliation
 * Stage then clusters, compares against existing graph neighbors, and
 * commits (either merged or as-is). The `storage` dependency is reserved on
 * the {@link ExtractCandidatesDeps} shape for future parity with today's
 * `ExtractionWorker` but is deliberately not used here.
 *
 * The XML framing and ACP session helpers (`frameBatch`,
 * `invokeBatchCompressor`) are reused / duplicated from the existing
 * `src/collector/buffer/extraction.ts`. Once the reconciliation engine
 * lands in full (Task 13), `buffer/extraction.ts` becomes a thin wrapper
 * over the Ingestion Pipeline and the duplication goes away.
 *
 * ## Modularity
 *
 * This module lives at `src/collector/ingestion/` and MUST NOT import from
 * `src/collector/storage/sqlite/` (guard test in Task 16). Allowed imports:
 *
 * - `src/types/` — for `CandidateMemory`, `MemoryRecord`, `StorageBackend`
 * - `src/collector/buffer/types.js` — for the `BufferEntry` type only
 * - `src/collector/embedding/` barrel — for `composeEmbeddingInput`,
 *   `Embedder`
 * - `src/collector/pipeline/` — for `createAcpSession`, `frameBatch`,
 *   `parseMemoryXml`, `isGarbageResponse`
 * - `ulidx` — for record id generation
 *
 * No privacy-scrub tokens in this file — scrubbing belongs to the
 * pipeline, not ingestion (AGENTS.md modularity rule).
 *
 * @see .kiro/specs/reconciliation-engine/design.md § `candidate.ts` — Candidate Memory
 * @see .kiro/specs/reconciliation-engine/requirements.md § Requirements 3.1–3.5
 * @module
 */

import { ulid } from 'ulidx';

import type { CandidateMemory, MemoryRecord, StorageBackend } from '../../types/index.js';
import type { BufferEntry } from '../buffer/types.js';
import { composeEmbeddingInput } from '../embedding/index.js';
import type { Embedder } from '../embedding/index.js';
import { createAcpSession } from '../pipeline/acp-client.js';
import type { AcpSession } from '../pipeline/acp-client.js';
import { frameBatch } from '../pipeline/xml-framer.js';
import { isGarbageResponse, parseMemoryXml } from '../pipeline/xml-parser.js';
import type { RawMemoryFields } from '../pipeline/xml-parser.js';

// ── Re-exports ──────────────────────────────────────────────────────────

export type { CandidateMemory } from '../../types/index.js';

// ── Public types ────────────────────────────────────────────────────────

/**
 * Configuration for {@link extractCandidates}.
 *
 * @see Requirements 11.1, 11.2, 11.3, 18.2 (workspace-buffer-pipeline —
 *   carried forward verbatim)
 */
export interface ExtractCandidatesConfig {
  /** Per-extraction timeout in milliseconds. Default 60_000. */
  timeoutMs: number;
  /** Maximum retry attempts for transient failures. Default 3. */
  maxRetries: number;
}

/**
 * Dependencies injected into {@link extractCandidates}.
 *
 * `storage` is present for future parity with today's `ExtractionWorker`
 * surface (which takes a full `StorageBackend`) but is NEVER called from
 * this module — the whole point of the Extraction Stage is that it writes
 * nothing. Callers MUST pass the backend as-is so any future reshuffle of
 * the pipeline's write seam stays source-compatible.
 *
 * `embedder` is nullable because the collector may be configured without
 * an embedder (Req 3.4 / 14.x). A null embedder yields Candidate Memories
 * with `embedding: null`.
 */
export interface ExtractCandidatesDeps {
  /**
   * Reserved for future parity with today's `ExtractionWorker`. Pass
   * `storage` but do not call it from this module — extraction never
   * writes (Req 3.1).
   */
  storage: StorageBackend;
  /**
   * The embedder used to produce a 384-dim vector for every candidate.
   * When `null` or not ready, candidates emit with `embedding: null`
   * (Req 3.4).
   */
  embedder: Embedder | null;
}

// ── Internal helpers (lifted verbatim from buffer/extraction.ts) ────────

/**
 * Invoke the compressor agent via ACP for a batch of buffer entries.
 *
 * Creates an ACP session, sends the batch XML prompt, parses the response,
 * and retries on garbage or transient errors up to `maxRetries` times.
 * Each attempt creates and destroys its own ACP session. On permanent
 * failure the function throws; on deliberate-skip responses (empty,
 * `<skip/>`) it returns `[]`.
 *
 * Duplicated from `src/collector/buffer/extraction.ts` so the Ingestion
 * Pipeline does not depend on the buffer module's private helpers. Task
 * 13 will refactor `buffer/extraction.ts` into a thin wrapper over the
 * pipeline, at which point this duplication folds into a single
 * implementation.
 *
 * @see Requirements 10.2, 10.3, 11.2, 11.3 (workspace-buffer-pipeline)
 */
async function invokeBatchCompressor(
  xmlPayload: string,
  timeoutMs: number,
  maxRetries: number,
): Promise<RawMemoryFields[]> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let session: AcpSession | null = null;
    try {
      session = await createAcpSession({
        agentName: 'kiro-learn-compressor',
        timeoutMs,
      });

      const responseText = await session.sendPrompt(xmlPayload);

      // Empty response = valid skip (compressor intentionally declined).
      if (!responseText.trim()) {
        return [];
      }

      // Explicit skip token.
      if (/<skip\b/.test(responseText)) {
        return [];
      }

      // Check for garbage (conversational response).
      if (isGarbageResponse(responseText)) {
        lastError = new Error(
          `compressor returned non-XML response (attempt ${String(attempt + 1)}/${String(maxRetries)})`,
        );
        process.stderr.write(
          `[kiro-learn] extraction garbage detected: ${lastError.message}\n`,
        );
        continue;
      }

      const records = parseMemoryXml(responseText);

      // Response contained <memory_record> markers but no parseable records.
      if (records.length === 0) {
        lastError = new Error(
          `compressor returned <memory_record> markers but no parseable records (attempt ${String(attempt + 1)}/${String(maxRetries)})`,
        );
        process.stderr.write(
          `[kiro-learn] extraction produced no valid records: ${lastError.message}\n`,
        );
        continue;
      }

      return records;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));
      process.stderr.write(
        `[kiro-learn] extraction attempt ${String(attempt + 1)}/${String(maxRetries)} failed: ${lastError.message}\n`,
      );
    } finally {
      session?.destroy();
    }
  }

  throw lastError ?? new Error('extraction failed after all retries');
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Produce {@link CandidateMemory} values from a buffer snapshot.
 *
 * The function:
 *
 * 1. Returns `[]` on an empty input (no ACP session created).
 * 2. Frames the batch as XML via {@link frameBatch}.
 * 3. Invokes the `kiro-learn-compressor` agent over ACP; retries on
 *    garbage / transient failures.
 * 4. For each returned `RawMemoryFields` block, allocates a fresh
 *    `record_id` and composes a {@link CandidateMemory}.
 * 5. When an {@link Embedder} is injected and ready, computes the 384-dim
 *    vector for each candidate and attaches it; on embedder failure or
 *    not-ready embedder, emits the candidate with `embedding: null` and
 *    writes a stderr warning (Req 3.4).
 *
 * The function NEVER writes to storage. On permanent compressor failure
 * the error propagates to the caller, which is responsible for leaving
 * the buffer intact (Req 1.3).
 *
 * @see Requirements 3.1, 3.2, 3.3, 3.4, 3.5
 */
export async function extractCandidates(
  entries: readonly BufferEntry[],
  config: ExtractCandidatesConfig,
  deps: ExtractCandidatesDeps,
): Promise<CandidateMemory[]> {
  if (entries.length === 0) return [];

  const firstEntry = entries[0];
  if (firstEntry === undefined) return [];

  // All entries in a snapshot share the same namespace (buffers are
  // per-project, and project id is derived from the namespace prefix).
  const namespace = firstEntry.namespace;
  const sourceEventIds = entries.map((e) => e.event_id);

  // `frameBatch` expects a mutable `BufferEntry[]` shape; the input here
  // is `readonly BufferEntry[]`. Spread into a fresh array so the type
  // line up and the caller's array is never mutated.
  const xmlPayload = frameBatch([...entries]);

  // Propagate compressor errors — the outer pipeline catches and leaves
  // the buffer intact.
  const rawRecords = await invokeBatchCompressor(
    xmlPayload,
    config.timeoutMs,
    config.maxRetries,
  );

  const candidates: CandidateMemory[] = [];
  for (const raw of rawRecords) {
    const recordId = `mr_${ulid()}`;

    // Compose a synthetic `MemoryRecord`-shaped value for the embedder's
    // input composer. `composeEmbeddingInput` reads `title`, `summary`,
    // `facts`, `concepts` only — the `created_at` here is a placeholder
    // that never leaves this function.
    //
    // We do not use `toMemoryRecord(candidate)` because the candidate
    // is not yet constructed (we need its embedding first), and
    // `toMemoryRecord` is documented to stamp `created_at` at commit
    // time — calling it here would conflate extraction-time with
    // commit-time.
    const tempRecordForInput: MemoryRecord = {
      record_id: recordId,
      namespace,
      strategy: 'llm-summary',
      source_event_ids: sourceEventIds,
      created_at: new Date().toISOString(),
      title: raw.title,
      summary: raw.summary,
      facts: raw.facts,
      concepts: raw.concepts,
      files_touched: raw.files,
      observation_type: raw.type,
    };

    // Compute embedding when possible. Three branches:
    //
    //  1. No embedder configured (`embedder === null`) → null embedding,
    //     no warning (operator chose this mode explicitly).
    //  2. Embedder configured but not ready (load failed) → null
    //     embedding with a degraded-mode warning per record.
    //  3. Embedder ready → try `embed(...)`; on failure, null embedding
    //     with a warning identifying the candidate's `record_id`.
    //
    // Never re-throw from this block — extraction continues and the
    // Reconciliation Stage treats null-embedding candidates as
    // singleton clusters (Req 4.4).
    let embedding: Float32Array | null = null;
    if (deps.embedder !== null) {
      if (deps.embedder.isReady()) {
        try {
          const input = composeEmbeddingInput(tempRecordForInput);
          embedding = await deps.embedder.embed(input);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[kiro-learn] embedding failed for candidate ${recordId}: ${message}\n`,
          );
          embedding = null;
        }
      } else {
        process.stderr.write(
          `[kiro-learn] degraded mode: skipping embed for candidate ${recordId} (embedder not ready)\n`,
        );
      }
    }

    // Build the `CandidateMemory`. Intentionally no `created_at` — that
    // is stamped by `toMemoryRecord(...)` at commit time (Req 7.7).
    const candidate: CandidateMemory = {
      record_id: recordId,
      namespace,
      strategy: 'llm-summary',
      source_event_ids: sourceEventIds,
      title: raw.title,
      summary: raw.summary,
      facts: raw.facts,
      concepts: raw.concepts,
      files_touched: raw.files,
      observation_type: raw.type,
      embedding,
    };

    candidates.push(candidate);
  }

  return candidates;
}

/**
 * Convert a {@link CandidateMemory} to a committable {@link MemoryRecord}.
 *
 * Stamps `created_at` with the current wall-clock time and strips the
 * transient `embedding` carrier — the embedding is written separately
 * via `storage.putEmbedding(record_id, vec)` at commit time, not carried
 * inside the record row.
 *
 * This helper is used by the Reconciliation Stage on the keep-separate
 * path and on the direct-commit fallback (Req 1.6). The merge path
 * builds a fresh Summary Record instead and does not call this.
 *
 * @see Requirements 7.7, 1.6
 */
export function toMemoryRecord(c: CandidateMemory): MemoryRecord {
  // Destructure so the transient `embedding` field never reaches the
  // committable record. The `_` prefix on the binding marks it as an
  // intentional discard (project lint config permits it).
  const { embedding: _embedding, ...fields } = c;
  return {
    ...fields,
    created_at: new Date().toISOString(),
  };
}
