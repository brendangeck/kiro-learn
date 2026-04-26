/**
 * Zod-backed schemas and parsers for the kiro-learn wire contract.
 *
 * These schemas are the runtime source of truth for the `Event` and
 * `MemoryRecord` shapes. The corresponding TypeScript types are derived via
 * `z.infer` so the validator and the type always stay in lockstep.
 *
 * See `.kiro/specs/event-schema-and-storage/design.md` § Zod Schemas for the
 * contract. See AGENTS.md for the overall architecture.
 */

import { z } from 'zod';

/** ULID — Crockford base32, 26 chars. @see Requirements 2.2 */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Memory record id — `mr_` prefix followed by a ULID. @see Requirements 3.3 */
export const RECORD_ID_RE = /^mr_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Namespace path. Mirrors AgentCore Memory's namespace convention, including
 * the mandatory trailing slash for prefix-safe IAM scoping.
 * @see Requirements 2.3
 */
export const NAMESPACE_RE = /^\/actor\/[^/]+\/project\/[^/]+\/$/;

/** sha256 hex digest as produced by `sha256:<hex>`. @see Requirements 2.9 */
export const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;

/** Max serialized body size: 1 MiB. @see Requirements 2.7, 12.3 */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Event body — a discriminated union on `type`.
 * - `text`: plain UTF-8 content, capped at 1 MiB.
 * - `message`: ordered list of role/content turns (non-empty).
 * - `json`: arbitrary structured payload.
 *
 * The inner `content.max(MAX_BODY_BYTES)` on the `text` variant is a
 * fast-path check that avoids serializing obviously-too-large strings.
 * The outer `.refine` then enforces the serialized-size cap uniformly
 * across all three variants, so `message` (summed across `turns`) and
 * `json` (arbitrary nested data) are also rejected when their JSON
 * encoding exceeds 1 MiB.
 *
 * @see Requirements 1.3, 2.6, 2.7, 12.3
 */
export const EventBodySchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('text'),
      content: z.string().max(MAX_BODY_BYTES),
    }),
    z.object({
      type: z.literal('message'),
      turns: z
        .array(
          z.object({
            role: z.string().min(1),
            content: z.string(),
          }),
        )
        .min(1),
    }),
    z.object({
      type: z.literal('json'),
      data: z.unknown(),
    }),
  ])
  /**
   * Enforces the 1 MiB serialized-body cap across every body variant.
   * Counts the JSON encoding's length in UTF-16 code units, which is a
   * safe upper-bound proxy for byte size (equal for ASCII, larger than
   * UTF-8 byte length for non-ASCII). Rejecting at the validator boundary
   * keeps oversized payloads out of the pipeline and storage layers per
   * the design's "DoS via oversized body" control.
   *
   * @see Requirements 2.7, 12.3
   */
  .refine((body) => JSON.stringify(body).length <= MAX_BODY_BYTES, {
    message: 'body serialized size exceeds 1 MiB',
  });

/**
 * Provenance block — identifies which client surface emitted the event.
 *
 * `project_path` is the absolute, symlink-resolved filesystem path of the
 * project root the shim hashed to derive `project_id`. Optional for
 * backward compatibility with pre-project-path-capture shims and with
 * events already in storage; the updated shim always populates it.
 * Carrier-only — no structural constraint (no absolute-path regex, no
 * `$HOME` prefix check). The 1–2048 char bound is a DoS guard.
 *
 * @see Requirements 1.4, 2.10 (event-schema-and-storage)
 * @see Requirements 5.1, 5.2, 5.3, 5.6, 11.5 (project-path-capture)
 */
export const EventSourceSchema = z.object({
  surface: z.enum(['kiro-cli', 'kiro-ide']),
  version: z.string().min(1),
  client_id: z.string().min(1),
  project_path: z.string().min(1).max(2048).optional(),
});

/**
 * Canonical `Event` wire schema. v1 fields only; additions in future
 * schema versions MUST be additive.
 *
 * @see Requirements 1.1, 2.1–2.10
 */
export const EventSchema = z.object({
  event_id: z.string().regex(ULID_RE),
  parent_event_id: z.string().regex(ULID_RE).optional(),
  session_id: z.string().min(1).max(128),
  actor_id: z.string().min(1).max(128),
  namespace: z.string().regex(NAMESPACE_RE),
  schema_version: z.literal(1),
  kind: z.enum(['prompt', 'tool_use', 'session_summary', 'note']),
  body: EventBodySchema,
  valid_time: z.string().datetime({ offset: true }),
  source: EventSourceSchema,
  content_hash: z.string().regex(CONTENT_HASH_RE).optional(),
});

/**
 * The observation type values the compressor may return.
 * @see Requirements 8.3
 */
export const OBSERVATION_TYPES = [
  'tool_use',
  'decision',
  'error',
  'discovery',
  'pattern',
] as const;

/**
 * `MemoryRecord` schema — the long-term memory unit produced by a memory
 * strategy and stored under a namespace.
 *
 * @see Requirements 3.1, 3.3–3.5, 8.1, 8.2, 8.3
 */
export const MemoryRecordSchema = z.object({
  record_id: z.string().regex(RECORD_ID_RE),
  namespace: z.string().regex(NAMESPACE_RE),
  strategy: z.string().min(1),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(4000),
  facts: z.array(z.string().min(1).max(500)),
  source_event_ids: z.array(z.string().regex(ULID_RE)).min(1),
  created_at: z.string().datetime({ offset: true }),
  // New fields from XML extraction (Requirements 8.1, 8.2, 8.3)
  concepts: z.array(z.string().min(1).max(100)),
  files_touched: z.array(z.string().min(1).max(500)),
  observation_type: z.enum(OBSERVATION_TYPES),
});

/**
 * Compile-time type derived from {@link EventSchema}.
 *
 * @see Requirements 1.1
 */
export type KiroMemEvent = z.infer<typeof EventSchema>;

/**
 * Compile-time type derived from {@link MemoryRecordSchema}.
 *
 * @see Requirements 3.1
 */
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

/**
 * The observation type classification for a memory record.
 * Derived from {@link OBSERVATION_TYPES}.
 *
 * @see Requirements 8.3
 */
export type ObservationType = MemoryRecord['observation_type'];

/**
 * Validate arbitrary input against {@link EventSchema}.
 *
 * @throws ZodError when input fails any rule. The error path identifies the
 *         first failing field. @see Requirements 2.1, 2.11
 */
export function parseEvent(input: unknown): KiroMemEvent {
  return EventSchema.parse(input);
}

/**
 * Validate arbitrary input against {@link MemoryRecordSchema}.
 *
 * @throws ZodError when input fails any rule. @see Requirements 3.2
 */
export function parseMemoryRecord(input: unknown): MemoryRecord {
  return MemoryRecordSchema.parse(input);
}
