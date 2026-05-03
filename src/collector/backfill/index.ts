/**
 * Barrel export for the backfill module.
 *
 * Public surface of `src/collector/backfill/`. Every other module
 * in the codebase imports from this barrel rather than reaching
 * into `./worker.js` directly, which keeps the boundary thin and
 * the modularity-guard tests (tasks 13.1–13.2) cheap to enforce.
 *
 * The module is pure of storage-sqlite and shim knowledge: it
 * imports `StorageBackend` via the public `src/types/` interface
 * and never from `src/collector/storage/sqlite/`. See design
 * § Components and Interfaces.
 *
 * @see Requirements 13.1, 13.2, 13.3
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — `src/collector/backfill/`
 * @module
 */

export { createBackfillWorker } from './worker.js';
export type {
  BackfillWorker,
  BackfillWorkerConfig,
  BackfillWorkerDeps,
  BackfillWorkerStatus,
} from './worker.js';
