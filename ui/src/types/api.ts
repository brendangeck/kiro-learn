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
