/**
 * Internal buffer types for the workspace buffer pipeline.
 *
 * `BufferEntry` is a lightweight projection of a scrubbed `KiroMemEvent`,
 * containing only the fields needed for buffering and batch extraction.
 * This module is internal to `src/collector/buffer/` — nothing here is
 * exported to `src/types/` or the public API.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Model 1: BufferEntry
 */

import type { KiroMemEvent } from '../../types/index.js';

/**
 * Lightweight projection of a scrubbed {@link KiroMemEvent} for buffer storage.
 *
 * The buffer doesn't need `schema_version`, `content_hash`, `parent_event_id`,
 * `session_id`, or the full `source` block. Keeping the entry lean reduces
 * buffer file size. The `event_id` and `namespace` are preserved so the
 * ExtractionWorker can populate `source_event_ids` and `namespace` on the
 * resulting `MemoryRecord`.
 *
 * @see Requirements 2.1, 2.2, 2.3
 */
export interface BufferEntry {
  /** Original event_id from the KiroMemEvent (ULID). */
  event_id: string;
  /** Namespace from the event (carries actor + project identity). */
  namespace: string;
  /** Event kind: prompt, tool_use, session_summary, note. */
  kind: KiroMemEvent['kind'];
  /** The scrubbed event body (already privacy-scrubbed by the pipeline). */
  body: KiroMemEvent['body'];
  /** ISO 8601 timestamp (valid_time from the event). */
  timestamp: string;
  /** Source surface from the event. */
  surface: string;
}

/**
 * Project a scrubbed {@link KiroMemEvent} into a {@link BufferEntry}.
 *
 * Maps:
 * - `event.event_id` → `event_id`
 * - `event.namespace` → `namespace`
 * - `event.kind` → `kind`
 * - `event.body` → `body`
 * - `event.valid_time` → `timestamp`
 * - `event.source.surface` → `surface`
 *
 * Fields omitted: `schema_version`, `content_hash`, `parent_event_id`,
 * `session_id`, full `source` block.
 *
 * @see Requirements 2.1, 2.2
 */
export function toBufferEntry(event: KiroMemEvent): BufferEntry {
  return {
    event_id: event.event_id,
    namespace: event.namespace,
    kind: event.kind,
    body: event.body,
    timestamp: event.valid_time,
    surface: event.source.surface,
  };
}

/**
 * Regex for extracting the project segment from a namespace path.
 *
 * Matches: `/actor/<actor_id>/project/<project_id>/`
 * Captures: `<project_id>` in group 1.
 */
const PROJECT_ID_RE = /^\/actor\/[^/]+\/project\/([^/]+)\/$/;

/**
 * Extract the project ID from a namespace string.
 *
 * For namespaces matching `/actor/<actor_id>/project/<project_id>/`, returns
 * the `<project_id>` segment. For non-matching strings, returns the full
 * namespace as a fallback buffer key.
 *
 * @see Requirements 4.1, 4.2
 */
export function extractProjectId(namespace: string): string {
  const match = PROJECT_ID_RE.exec(namespace);
  return match?.[1] ?? namespace;
}
