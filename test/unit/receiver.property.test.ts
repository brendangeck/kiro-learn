/**
 * Property-based tests for the HTTP receiver's retrieval gating logic.
 *
 * Feature: collector-pipeline, Property 7: Retrieval gating
 *
 * @see .kiro/specs/collector-pipeline/design.md § Property 7
 * @see .kiro/specs/collector-pipeline/requirements.md § Requirements 3.2, 3.3, 3.4, 3.5
 */

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { KiroMemEvent, EventIngestResponse, StorageBackend } from '../../src/types/index.js';
import type { Pipeline } from '../../src/collector/pipeline/index.js';
import type { RetrievalAssembler } from '../../src/collector/retrieval/index.js';
import type { ReceiverHandle } from '../../src/collector/receiver/index.js';
import { startReceiver } from '../../src/collector/receiver/index.js';
import { arbitraryEvent } from '../helpers/arbitrary.js';

// ── Mocks ───────────────────────────────────────────────────────────────

/** Known retrieval result returned by the mock assembler. */
const MOCK_RETRIEVAL = {
  context: 'mock-context',
  records: ['mr_MOCK00000000000000000000000'],
  latency_ms: 1,
};

/** Mock pipeline that always stores successfully. */
const mockPipeline: Pipeline = {
  process(event: KiroMemEvent): Promise<EventIngestResponse> {
    return Promise.resolve({ event_id: event.event_id, stored: true });
  },
  extraction: {
    enqueue() {},
    drain() {
      return Promise.resolve();
    },
    get active() {
      return 0;
    },
  },
};

/** Mock retrieval assembler that always returns a known result. */
const mockRetrieval: RetrievalAssembler = {
  assemble(): Promise<typeof MOCK_RETRIEVAL> {
    return Promise.resolve(MOCK_RETRIEVAL);
  },
};

/** Mock storage backend — not exercised by retrieval gating tests. */
const mockStorage: StorageBackend = {
  putEvent() { return Promise.resolve(); },
  getEventById() { return Promise.resolve(null); },
  putMemoryRecord() { return Promise.resolve(); },
  searchMemoryRecords() { return Promise.resolve([]); },
  close() { return Promise.resolve(); },
  getStats() {
    return Promise.resolve({
      total_events: 0, total_memories: 0, total_projects: 0,
      total_concepts: 0, observation_types: {}, event_kinds: {},
    });
  },
  listProjects() { return Promise.resolve([]); },
  listMemoryRecords() { return Promise.resolve({ items: [], total: 0 }); },
  listEvents() { return Promise.resolve({ items: [], total: 0 }); },
};

// ── Server lifecycle ────────────────────────────────────────────────────

let handle: ReceiverHandle;
let baseUrl: string;

beforeAll(async () => {
  handle = await startReceiver(
    { pipeline: mockPipeline, retrieval: mockRetrieval, storage: mockStorage },
    { host: '127.0.0.1', port: 0, maxBodyBytes: 2 * 1024 * 1024, retrievalBudgetMs: 500 },
  );
  const addr = handle.server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('unexpected server address type');
  }
  baseUrl = `http://127.0.0.1:${String(addr.port)}`;
});

afterAll(async () => {
  await handle.close();
});

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * The set of `retrieve` parameter values to test. Includes the only
 * value that should trigger retrieval (`"true"`) and several that should
 * not, plus `undefined` for "no parameter at all".
 */
const RETRIEVE_VALUES: Array<string | undefined> = [
  'true',
  'false',
  '1',
  'yes',
  '',
  undefined,
];

/** Arbitrary retrieve parameter value drawn from the test set. */
function retrieveParamArb(): fc.Arbitrary<string | undefined> {
  return fc.constantFrom(...RETRIEVE_VALUES);
}

/**
 * POST an event to the receiver and return the parsed response.
 */
async function postEvent(
  event: KiroMemEvent,
  retrieve: string | undefined,
): Promise<EventIngestResponse> {
  const qs = retrieve !== undefined ? `?retrieve=${retrieve}` : '';
  const res = await fetch(`${baseUrl}/v1/events${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  return (await res.json()) as EventIngestResponse;
}

// ── Property test ───────────────────────────────────────────────────────

describe('Receiver — property: retrieval gating (P7)', () => {
  // Feature: collector-pipeline, Property 7: Retrieval gating

  it('response contains retrieval iff retrieve === "true" AND kind === "prompt"', async () => {
    /**
     * **Validates: Requirements 3.2, 3.3, 3.4, 3.5**
     *
     * For any event and any value of `retrieve`, the response contains a
     * `retrieval` field if and only if `retrieve === "true"` AND
     * `event.kind === "prompt"`.
     */
    await fc.assert(
      fc.asyncProperty(
        arbitraryEvent(),
        retrieveParamArb(),
        async (event, retrieve) => {
          const response = await postEvent(event, retrieve);

          const shouldHaveRetrieval =
            retrieve === 'true' && event.kind === 'prompt';

          if (shouldHaveRetrieval) {
            expect(response.retrieval).toBeDefined();
            expect(response.retrieval).toEqual(MOCK_RETRIEVAL);
          } else {
            expect(response.retrieval).toBeUndefined();
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
