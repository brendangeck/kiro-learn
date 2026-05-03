/**
 * Embedding BLOB codec.
 *
 * Canonical, pure, storage-agnostic encoder/decoder for the 384-dim
 * `Float32Array` vectors produced by the on-device embedder (Xenova
 * `all-MiniLM-L6-v2`). The wire representation is a fixed 1536-byte
 * little-endian IEEE-754 single-precision buffer — exactly
 * `{@link EMBEDDING_DIMS} * 4` bytes, with no framing, version byte,
 * length prefix, or checksum. Dimension is implicit in the column
 * contract and validated on decode.
 *
 * Endianness is handled explicitly via `DataView.setFloat32(offset,
 * value, /* littleEndian * / true)` / `DataView.getFloat32(offset,
 * true)`. Node is little-endian on every platform kiro-learn supports
 * today (x86_64 and arm64 macOS/Linux), but the explicit flag means
 * the same database file round-trips correctly across any host we
 * might one day add without relying on `Buffer.from(vec.buffer)`
 * inheriting the host byte order.
 *
 * This module is pure: no imports from `src/collector/storage/`,
 * `src/shim/`, `src/installer/`, or `src/mcp/`. The SQLite backend
 * imports from here, never the other way around (design § Components
 * and Interfaces → `src/collector/embedding/`).
 *
 * @see Requirements 4.2, 4.4, 11.1, 15.2, 15.3
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Data Models — BLOB encoding format
 * @see .kiro/specs/local-embeddings-and-hybrid-search/design.md
 *      § Components and Interfaces — `encodeEmbeddingBlob / decodeEmbeddingBlob`
 * @module
 */

/**
 * Fixed embedding dimensionality for the on-device model.
 *
 * `all-MiniLM-L6-v2` emits 384-dim vectors. Any deviation is a caller
 * bug (wrong model, corrupt row) and is surfaced as a thrown error
 * at the codec boundary.
 *
 * @see Requirements 4.2, 11.1
 */
export const EMBEDDING_DIMS = 384;

/**
 * Fixed on-disk BLOB size for one embedding: 384 float32 values × 4
 * bytes = 1536 bytes. Exposed as a named constant so callers and
 * tests do not sprinkle magic numbers.
 *
 * @see Requirements 4.2, 11.1, 15.2
 */
export const EMBEDDING_BLOB_BYTES = EMBEDDING_DIMS * 4;

/**
 * Encode a 384-dim `Float32Array` into a 1536-byte little-endian
 * `Buffer`.
 *
 * Every element is written via `DataView.setFloat32(offset, value,
 * /* littleEndian * / true)` so the byte order is independent of the
 * host. IEEE-754 bit patterns (NaN, ±Infinity, ±0, subnormals) are
 * preserved exactly — the round-trip property (design § Property 1)
 * verifies this end-to-end.
 *
 * The returned buffer is a freshly allocated heap region owned by the
 * caller; the input `vec` is never retained or mutated.
 *
 * @param vec - Dense vector produced by the embedder. Must have
 *   length exactly {@link EMBEDDING_DIMS} (384).
 * @returns A 1536-byte `Buffer` suitable for storage as a SQLite BLOB.
 * @throws If `vec.length !== {@link EMBEDDING_DIMS}`. The error message
 *   includes the offending length. The storage layer annotates the
 *   thrown error with the `record_id` for operator triage.
 *
 * @see Requirements 4.2, 11.1, 15.2
 */
export function encodeEmbeddingBlob(vec: Float32Array): Buffer {
  if (vec.length !== EMBEDDING_DIMS) {
    throw new Error(
      `encodeEmbeddingBlob: expected Float32Array of length ${String(EMBEDDING_DIMS)}, got ${String(vec.length)}`,
    );
  }
  const buf = Buffer.allocUnsafe(EMBEDDING_BLOB_BYTES);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < EMBEDDING_DIMS; i += 1) {
    // `noUncheckedIndexedAccess` widens `vec[i]` to `number | undefined`
    // even though the explicit `vec.length` guard above proves the
    // index is in bounds. The narrow cast is safe and local.
    view.setFloat32(i * 4, vec[i] as number, /* littleEndian */ true);
  }
  return buf;
}

/**
 * Decode a 1536-byte little-endian `Buffer` into a fresh 384-dim
 * `Float32Array`.
 *
 * The returned `Float32Array` is a new heap allocation — it never
 * aliases the input `blob`. This matters because SQLite row buffers
 * are often freed as soon as the statement iterator advances, and
 * we want the decoded vector to outlive the row.
 *
 * @param blob - Raw BLOB as read from SQLite. Must have length exactly
 *   {@link EMBEDDING_BLOB_BYTES} (1536).
 * @returns A fresh `Float32Array` of length {@link EMBEDDING_DIMS} (384).
 * @throws If `blob.length !== {@link EMBEDDING_BLOB_BYTES}`. The error
 *   message includes the offending byte length. The storage layer
 *   annotates the thrown error with the `record_id` for operator
 *   triage (Req 15.3).
 *
 * @see Requirements 4.2, 4.4, 11.1, 15.2, 15.3
 */
export function decodeEmbeddingBlob(blob: Buffer): Float32Array {
  if (blob.length !== EMBEDDING_BLOB_BYTES) {
    throw new Error(
      `decodeEmbeddingBlob: expected ${String(EMBEDDING_BLOB_BYTES)} bytes, got ${String(blob.length)}`,
    );
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i += 1) {
    out[i] = view.getFloat32(i * 4, /* littleEndian */ true);
  }
  return out;
}
