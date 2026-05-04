/**
 * Unit tests for `reconcile` — ACP session lifecycle
 * (reconciliation-engine Task 9.5).
 *
 * For every judge invocation the reconciler performs, exactly one
 * `createAcpSession` call happens with `agentName ===
 * 'kiro-learn-reconciler'`, and that session's `destroy()` is called
 * exactly once before control returns for the cluster. This is the
 * example-based counterpart of Property 19 ("Judge ACP session
 * lifecycle") and is the hardest invariant to debug when it drifts —
 * a missed `destroy()` leaks a `kiro-cli acp` child process.
 *
 * Covered scenarios:
 *
 * 1. Successful merge response → one session, one destroy.
 * 2. Successful keep-separate response → one session, one destroy.
 * 3. Non-XML response with successful retry → two sessions, two
 *    destroys (one per attempt).
 * 4. Non-XML response with failed retry → two sessions, two
 *    destroys (the reconciler still falls back to keep-separate).
 * 5. Judge timeout → one session, one destroy (timeout is terminal).
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 9.5
 * @see .kiro/specs/reconciliation-engine/requirements.md § 6.8
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CandidateMemory, StorageBackend } from '../../src/types/index.js';
import type { ReconciliationContext } from '../../src/collector/ingestion/reconciler.js';
import { makeValidRecord } from '../helpers/fixtures.js';

// ── Mock ACP client ─────────────────────────────────────────────────────

const responseQueue: Array<string | Error> = [];
const mockSessions: Array<{
  agentName: string;
  sendPrompt: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}> = [];

const createAcpSessionMock = vi.fn((opts: { agentName: string }) => {
  const response = responseQueue.shift();
  const session = {
    agentName: opts.agentName,
    sendPrompt: vi.fn(() => {
      if (response instanceof Error) return Promise.reject(response);
      return Promise.resolve(response ?? '');
    }),
    destroy: vi.fn(),
  };
  mockSessions.push(session);
  return Promise.resolve(session);
});

vi.mock('../../src/collector/pipeline/acp-client.js', () => ({
  createAcpSession: createAcpSessionMock,
}));

// ── Helpers ─────────────────────────────────────────────────────────────

function seededUnitVec(seed: number): Float32Array {
  const vec = new Float32Array(384);
  let norm = 0;
  for (let i = 0; i < 384; i += 1) {
    vec[i] = Math.sin((seed + 1) * (i + 1));
    norm += (vec[i] as number) * (vec[i] as number);
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < 384; i += 1) {
    vec[i] = (vec[i] as number) * inv;
  }
  return vec;
}

function makeCandidate(overrides: Partial<CandidateMemory> = {}): CandidateMemory {
  return {
    record_id: 'mr_01JF8ZS4Y00000000000000000',
    namespace: '/actor/alice/project/p1/',
    strategy: 'llm-summary',
    source_event_ids: ['01JF8ZS4Y00000000000000001'],
    title: 'Default',
    summary: 'Default summary',
    facts: [],
    concepts: [],
    files_touched: [],
    observation_type: 'tool_use',
    embedding: seededUnitVec(42),
    ...overrides,
  };
}

async function makeEnvWithNeighbor(): Promise<{
  ctx: ReconciliationContext;
  storage: StorageBackend;
  cleanup: () => Promise<void>;
}> {
  const { openSqliteStorage } = await import('../../src/collector/storage/sqlite/index.js');
  const { createQueryLayer } = await import('../../src/collector/query/index.js');
  const { createReconciliationCircuitBreaker } =
    await import('../../src/collector/ingestion/circuit-breaker.js');

  const tmpRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-reconciler-lc-'));
  const dbPath = join(tmpRoot, 'kiro-learn.db');
  const storage = openSqliteStorage({ dbPath });
  const query = createQueryLayer({ storage, embedder: null });

  // Seed one neighbor so the cluster's neighbor pool is non-empty
  // and the judge will be invoked.
  const namespace = '/actor/alice/project/p1/';
  const neighbor = makeValidRecord({
    record_id: 'mr_01JF8ZS4Y0000000000NEIGHLC1',
    namespace,
    title: 'Existing neighbor for lifecycle test',
  });
  await storage.putMemoryRecord(neighbor);
  await storage.putEmbedding(neighbor.record_id, seededUnitVec(42));

  const ctx = {
    storage,
    query,
    embedder: null,
    config: {
      intraBatchSimilarityThreshold: 0.85,
      neighborSimilarityThreshold: 0.8,
      neighborPoolMaxSize: 10,
      judgeModelTimeoutMs: 30_000,
      debug: false,
    },
    circuitBreaker: createReconciliationCircuitBreaker(),
    projectId: 'p1',
    namespace,
  };

  return {
    ctx,
    storage,
    cleanup: async () => {
      try {
        await storage.close();
      } catch {
        /* swallow cleanup errors */
      }
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

beforeEach(() => {
  responseQueue.length = 0;
  mockSessions.length = 0;
  createAcpSessionMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Assert that every session created so far was issued against the
 * reconciler agent, was prompted exactly once, and had `destroy()`
 * called exactly once.
 */
function assertStandardLifecycle(): void {
  for (const session of mockSessions) {
    expect(session.agentName).toBe('kiro-learn-reconciler');
    expect(session.sendPrompt).toHaveBeenCalledTimes(1);
    expect(session.destroy).toHaveBeenCalledTimes(1);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('reconcile — ACP session lifecycle', () => {
  it('opens exactly one session and destroys it on a successful <keep_separate/>', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, cleanup } = await makeEnvWithNeighbor();
    try {
      responseQueue.push('<keep_separate/>');

      const candidates = [
        makeCandidate({
          record_id: 'mr_01JF8ZS4Y0000000000LIFEC01',
          embedding: seededUnitVec(42),
        }),
      ];

      await reconcile(candidates, ctx);

      expect(createAcpSessionMock).toHaveBeenCalledTimes(1);
      expect(mockSessions).toHaveLength(1);
      assertStandardLifecycle();
    } finally {
      await cleanup();
    }
  });

  it('opens exactly one session and destroys it on a successful <merge>', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, cleanup } = await makeEnvWithNeighbor();
    try {
      const candidate = makeCandidate({
        record_id: 'mr_01JF8ZS4Y0000000000LIFEC02',
        embedding: seededUnitVec(42),
      });
      responseQueue.push(
        `
<merge>
  <merged_record_id>${candidate.record_id}</merged_record_id>
  <merged_record_id>mr_01JF8ZS4Y0000000000NEIGHLC1</merged_record_id>
  <title>Merged</title>
  <summary>Merged summary body</summary>
  <facts></facts>
  <concepts></concepts>
  <files></files>
</merge>
`.trim(),
      );

      await reconcile([candidate], ctx);

      expect(createAcpSessionMock).toHaveBeenCalledTimes(1);
      expect(mockSessions).toHaveLength(1);
      assertStandardLifecycle();
    } finally {
      await cleanup();
    }
  });

  it('opens two sessions and destroys both on non-XML + successful retry', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, cleanup } = await makeEnvWithNeighbor();
    try {
      // First attempt: conversational garbage → parse failure.
      responseQueue.push('I think these are separate memories.');
      // Second attempt: valid keep-separate.
      responseQueue.push('<keep_separate/>');

      await reconcile(
        [
          makeCandidate({
            record_id: 'mr_01JF8ZS4Y0000000000LIFEC03',
            embedding: seededUnitVec(42),
          }),
        ],
        ctx,
      );

      expect(createAcpSessionMock).toHaveBeenCalledTimes(2);
      expect(mockSessions).toHaveLength(2);
      assertStandardLifecycle();
    } finally {
      await cleanup();
    }
  });

  it('opens two sessions and destroys both on non-XML + non-XML (double failure)', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, cleanup } = await makeEnvWithNeighbor();
    try {
      responseQueue.push('first garbage response');
      responseQueue.push('second garbage response');

      await reconcile(
        [
          makeCandidate({
            record_id: 'mr_01JF8ZS4Y0000000000LIFEC04',
            embedding: seededUnitVec(42),
          }),
        ],
        ctx,
      );

      expect(createAcpSessionMock).toHaveBeenCalledTimes(2);
      expect(mockSessions).toHaveLength(2);
      assertStandardLifecycle();
    } finally {
      await cleanup();
    }
  });

  it('opens exactly one session and destroys it on a judge timeout', async () => {
    const { reconcile } = await import('../../src/collector/ingestion/reconciler.js');

    const { ctx, cleanup } = await makeEnvWithNeighbor();
    try {
      responseQueue.push(new Error('ACP session timed out after 30000ms'));

      await reconcile(
        [
          makeCandidate({
            record_id: 'mr_01JF8ZS4Y0000000000LIFEC05',
            embedding: seededUnitVec(42),
          }),
        ],
        ctx,
      );

      // Timeout is terminal — no retry, so only one session ever
      // opens.
      expect(createAcpSessionMock).toHaveBeenCalledTimes(1);
      expect(mockSessions).toHaveLength(1);
      assertStandardLifecycle();
    } finally {
      await cleanup();
    }
  });
});
