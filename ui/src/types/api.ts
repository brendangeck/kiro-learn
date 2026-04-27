/** Wire shapes for the read API. Duplicated from backend — no cross-import. */

export interface StatsResponse {
  total_events: number;
  total_memories: number;
  total_projects: number;
  total_concepts: number;
  observation_types: Record<string, number>;
  event_kinds: Record<string, number>;
  projects: Array<{
    namespace: string;
    project_id: string;
    display_name: string;
    event_count: number;
    memory_count: number;
  }>;
}

export interface EventsResponse {
  items: EventItem[];
  total: number;
}

export interface EventItem {
  event_id: string;
  session_id: string;
  kind: string;
  body: { type: string; content?: string; turns?: Array<{ role: string; content: string }>; data?: unknown };
  valid_time: string;
}

/** Observation type classification for a memory record. */
export type ObservationType = 'tool_use' | 'decision' | 'error' | 'discovery' | 'pattern';

/**
 * A single memory record as returned by the `/v1/memories` endpoint.
 * Fields mirror the backend `MemoryRecordSchema` — duplicated here to
 * avoid importing from `src/`.
 */
export interface MemoryRecord {
  record_id: string;
  namespace: string;
  strategy: string;
  title: string;
  summary: string;
  facts: string[];
  source_event_ids: string[];
  created_at: string;
  concepts: string[];
  files_touched: string[];
  observation_type: ObservationType;
}

/** Paginated response from `GET /v1/memories`. */
export interface MemoriesResponse {
  items: MemoryRecord[];
  total: number;
  limit: number;
  offset: number;
}

/** Valid observation types — used for runtime validation. */
const VALID_OBSERVATION_TYPES = new Set<ObservationType>([
  'tool_use', 'decision', 'error', 'discovery', 'pattern',
]);

/**
 * Runtime normalizer for a single MemoryRecord.
 * Coerces missing or incorrect fields to safe defaults so downstream
 * code can safely access properties like `title.length` without errors.
 */
export function normalizeMemoryRecord(raw: unknown): MemoryRecord {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    record_id: typeof r['record_id'] === 'string' ? r['record_id'] : '',
    namespace: typeof r['namespace'] === 'string' ? r['namespace'] : '',
    strategy: typeof r['strategy'] === 'string' ? r['strategy'] : '',
    title: typeof r['title'] === 'string' ? r['title'] : '',
    summary: typeof r['summary'] === 'string' ? r['summary'] : '',
    facts: Array.isArray(r['facts']) ? (r['facts'] as unknown[]).filter((f): f is string => typeof f === 'string') : [],
    source_event_ids: Array.isArray(r['source_event_ids']) ? (r['source_event_ids'] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
    created_at: typeof r['created_at'] === 'string' ? r['created_at'] : '',
    concepts: Array.isArray(r['concepts']) ? (r['concepts'] as unknown[]).filter((c): c is string => typeof c === 'string') : [],
    files_touched: Array.isArray(r['files_touched']) ? (r['files_touched'] as unknown[]).filter((f): f is string => typeof f === 'string') : [],
    observation_type: typeof r['observation_type'] === 'string' && VALID_OBSERVATION_TYPES.has(r['observation_type'] as ObservationType)
      ? r['observation_type'] as ObservationType
      : 'tool_use',
  };
}

/**
 * Runtime normalizer for the paginated memories response.
 * Ensures `items` is an array of valid MemoryRecord objects.
 */
export function normalizeMemoriesResponse(raw: unknown): MemoriesResponse {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(r['items']) ? (r['items'] as unknown[]).map(normalizeMemoryRecord) : [];
  return {
    items,
    total: typeof r['total'] === 'number' ? r['total'] : items.length,
    limit: typeof r['limit'] === 'number' ? r['limit'] : 500,
    offset: typeof r['offset'] === 'number' ? r['offset'] : 0,
  };
}
