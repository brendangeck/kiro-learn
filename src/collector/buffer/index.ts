/**
 * Buffer module barrel export.
 *
 * Re-exports the public surface of the per-project append-only NDJSON
 * buffer system: store, watcher, extraction worker, and shared types.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirement 17.1
 *
 * @module
 */

// ── Types ───────────────────────────────────────────────────────────────

export type { BufferEntry } from './types.js';

export type { BufferStore } from './store.js';

export type { BufferWatcher, BufferWatcherConfig, ProjectBufferState } from './watcher.js';

export type {
  ExtractionWorker,
  ExtractionResult,
  ExtractionWorkerConfig,
  ExtractionWorkerDeps,
} from './extraction.js';

// ── Values (factory functions + utilities) ──────────────────────────────

export { toBufferEntry, extractProjectId } from './types.js';

export { createBufferStore } from './store.js';

export { createBufferWatcher } from './watcher.js';

export { createExtractionWorker } from './extraction.js';
