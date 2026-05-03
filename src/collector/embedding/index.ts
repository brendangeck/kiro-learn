/**
 * Barrel export for the embedding module.
 *
 * Public surface of `src/collector/embedding/`. Every other module
 * in the codebase imports from this barrel rather than reaching into
 * sibling files directly, which keeps the boundary thin and the
 * modularity-guard tests (tasks 13.1–13.5) cheap to enforce.
 *
 * The module is pure and storage-agnostic: it imports from
 * `src/types/` only (via the sibling modules) and never from
 * `src/collector/storage/sqlite/`, `src/shim/`, `src/installer/`,
 * or `src/mcp/`. See design § Components and Interfaces.
 *
 * Re-exports:
 *
 * - BLOB codec: `encodeEmbeddingBlob`, `decodeEmbeddingBlob`,
 *   `EMBEDDING_DIMS`, `EMBEDDING_BLOB_BYTES`.
 * - Cosine math: `cosine`, `normalize`, `topKByCosine`, plus the
 *   `VectorIndexEntry`, `VectorIndexLike`, and `CosineHit` shapes
 *   consumed by the hybrid-search query layer.
 * - Input composition: `composeEmbeddingInput`, `DEFAULT_MAX_INPUT_CHARS`.
 * - RRF fusion: `rrfFuse`, `Ranked`, `Fused`.
 *
 * The `Embedder` interface and the concrete `createOnnxEmbedder`
 * factory are added to this barrel in task 4.1 (when
 * `onnx-embedder.ts` is created). Consumers in tasks 7.x and 8.x
 * import from here once the embedder file exists.
 *
 * @see Requirements 13.1, 13.2, 13.3
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — `src/collector/embedding/`
 * @module
 */

export {
  EMBEDDING_BLOB_BYTES,
  EMBEDDING_DIMS,
  decodeEmbeddingBlob,
  encodeEmbeddingBlob,
} from './blob.js';

export {
  cosine,
  normalize,
  topKByCosine,
} from './cosine.js';
export type {
  CosineHit,
  VectorIndexEntry,
  VectorIndexLike,
} from './cosine.js';

export {
  DEFAULT_MAX_INPUT_CHARS,
  composeEmbeddingInput,
} from './input-composition.js';

export { rrfFuse } from './rrf.js';
export type { Fused, Ranked } from './rrf.js';

export { createOnnxEmbedder } from './onnx-embedder.js';
export type { Embedder, EmbedderConfig } from './onnx-embedder.js';
