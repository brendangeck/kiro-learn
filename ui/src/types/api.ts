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
