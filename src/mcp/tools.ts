/**
 * Tool handler implementations for the MCP memory server.
 *
 * Contains validation functions, tool handlers, and formatting logic for
 * the three MCP tools: search_memory, save_observation, save_session_summary.
 *
 * Each handler validates input, calls the collector client, and returns a
 * formatted ToolResult. All handlers wrap logic in try/catch and return
 * error ToolResults on any exception — never crash.
 *
 * Private tags pass through unchanged — no scrubbing. Privacy scrubbing
 * is the collector pipeline's responsibility.
 *
 * @see Requirements 2.1–2.4, 3.1–3.6, 4.1–4.5, 5.1–5.4, 7.1–7.5,
 *      11.1–11.5, 12.3, 12.4, 13.1–13.3
 */

import { ulid } from 'ulidx';

import { OBSERVATION_TYPES } from '../types/schemas.js';
import { postMemory, searchMemories } from './client.js';
import type { CollectorClientConfig, MemoryRecordPayload } from './client.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface ToolContext {
  namespace: string;
  config: CollectorClientConfig;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface SearchArgs {
  query: string;
  limit: number;
}

export interface ObservationArgs {
  title: string;
  summary: string;
  observation_type: string;
  concepts: string[];
  files_touched: string[];
  facts: string[];
}

export interface SessionSummaryArgs {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  files_read: string[];
  files_modified: string[];
}

export interface ValidationError {
  error: string;
}

// ── Validation ──────────────────────────────────────────────────────────

/**
 * Validate and extract search_memory arguments.
 *
 * - `query`: string, required, non-empty, ≤1000 chars
 * - `limit`: number, optional, default 10, clamped to [1, 100]
 */
export function validateSearchArgs(
  args: Record<string, unknown>,
): SearchArgs | ValidationError {
  const query = args['query'];
  if (typeof query !== 'string') {
    return { error: 'query must be a string' };
  }
  if (query.length === 0) {
    return { error: 'query must be non-empty' };
  }
  if (query.length > 1000) {
    return { error: 'query must be at most 1000 characters' };
  }

  let limit = 10;
  const rawLimit = args['limit'];
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== 'number') {
      return { error: 'limit must be a number' };
    }
    limit = Math.max(1, Math.min(100, Math.round(rawLimit)));
  }

  return { query, limit };
}

/**
 * Validate and extract save_observation arguments.
 *
 * - `title`: string, required, ≤200 chars
 * - `summary`: string, required, ≤4000 chars
 * - `observation_type`: must be one of OBSERVATION_TYPES
 * - `concepts`: array of strings, ≤50 entries
 * - `files_touched`: array of strings, ≤100 entries
 * - `facts`: array of strings, ≤50 entries
 */
export function validateObservationArgs(
  args: Record<string, unknown>,
): ObservationArgs | ValidationError {
  const title = args['title'];
  if (typeof title !== 'string') {
    return { error: 'title must be a string' };
  }
  if (title.length === 0) {
    return { error: 'title must be non-empty' };
  }
  if (title.length > 200) {
    return { error: 'title must be at most 200 characters' };
  }

  const summary = args['summary'];
  if (typeof summary !== 'string') {
    return { error: 'summary must be a string' };
  }
  if (summary.length === 0) {
    return { error: 'summary must be non-empty' };
  }
  if (summary.length > 4000) {
    return { error: 'summary must be at most 4000 characters' };
  }

  const observationType = args['observation_type'];
  if (typeof observationType !== 'string') {
    return { error: 'observation_type must be a string' };
  }
  const ALLOWED_OBSERVATION_TYPES = OBSERVATION_TYPES.filter(
    (t) => t !== 'session_summary',
  );
  if (
    !(ALLOWED_OBSERVATION_TYPES as readonly string[]).includes(observationType)
  ) {
    return {
      error: `observation_type must be one of: ${ALLOWED_OBSERVATION_TYPES.join(', ')}`,
    };
  }

  const concepts = args['concepts'];
  if (!Array.isArray(concepts)) {
    return { error: 'concepts must be an array' };
  }
  if (concepts.length > 50) {
    return { error: 'concepts must have at most 50 entries' };
  }
  for (const c of concepts) {
    if (typeof c !== 'string') {
      return { error: 'each concept must be a string' };
    }
  }

  const filesTouched = args['files_touched'];
  if (!Array.isArray(filesTouched)) {
    return { error: 'files_touched must be an array' };
  }
  if (filesTouched.length > 100) {
    return { error: 'files_touched must have at most 100 entries' };
  }
  for (const f of filesTouched) {
    if (typeof f !== 'string') {
      return { error: 'each files_touched entry must be a string' };
    }
  }

  const facts = args['facts'];
  if (!Array.isArray(facts)) {
    return { error: 'facts must be an array' };
  }
  if (facts.length > 50) {
    return { error: 'facts must have at most 50 entries' };
  }
  for (const f of facts) {
    if (typeof f !== 'string') {
      return { error: 'each fact must be a string' };
    }
  }

  return {
    title,
    summary,
    observation_type: observationType,
    concepts: concepts as string[],
    files_touched: filesTouched as string[],
    facts: facts as string[],
  };
}

/**
 * Validate and extract save_session_summary arguments.
 *
 * All 7 fields are required:
 * - `request`, `investigated`, `learned`, `completed`, `next_steps`: strings
 * - `files_read`, `files_modified`: arrays of strings
 */
export function validateSessionSummaryArgs(
  args: Record<string, unknown>,
): SessionSummaryArgs | ValidationError {
  const stringFields = [
    'request',
    'investigated',
    'learned',
    'completed',
    'next_steps',
  ] as const;

  const result: Record<string, unknown> = {};

  for (const field of stringFields) {
    const value = args[field];
    if (typeof value !== 'string') {
      return { error: `${field} must be a string` };
    }
    if (value.trim().length === 0) {
      return { error: `${field} must be a non-empty string` };
    }
    result[field] = value;
  }

  const arrayFields = ['files_read', 'files_modified'] as const;

  for (const field of arrayFields) {
    const value = args[field];
    if (!Array.isArray(value)) {
      return { error: `${field} must be an array` };
    }
    for (const item of value) {
      if (typeof item !== 'string') {
        return { error: `each ${field} entry must be a string` };
      }
    }
    result[field] = value;
  }

  return result as unknown as SessionSummaryArgs;
}

// ── Formatting ──────────────────────────────────────────────────────────

/**
 * Format memory records as human-readable text.
 *
 * Each record is formatted as a text block with title on header line,
 * summary as paragraph, concepts comma-separated, files_touched
 * newline-separated. Records are separated with blank lines.
 *
 * Returns "No matching memories found for the current project." for
 * empty results.
 */
export function formatSearchResults(records: MemoryRecordPayload[]): string {
  if (records.length === 0) {
    return 'No matching memories found for the current project.';
  }

  const blocks: string[] = [];

  for (const record of records) {
    const lines: string[] = [];
    lines.push(`### ${record.title}`);
    lines.push('');
    lines.push(record.summary);

    if (record.concepts.length > 0) {
      lines.push('');
      lines.push(`Concepts: ${record.concepts.join(', ')}`);
    }

    if (record.files_touched.length > 0) {
      lines.push('');
      lines.push('Files:');
      for (const file of record.files_touched) {
        lines.push(`  ${file}`);
      }
    }

    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

/**
 * Build the formatted summary for a session summary record.
 *
 * Format:
 * ```
 * ## What was investigated
 * {investigated}
 *
 * ## What was learned
 * {learned}
 *
 * ## What was completed
 * {completed}
 *
 * ## Next steps
 * {next_steps}
 * ```
 *
 * If exceeds 4000 chars, truncate to 4000.
 */
function buildSessionSummaryText(args: SessionSummaryArgs): string {
  const sections = [
    `## What was investigated\n${args.investigated}`,
    `## What was learned\n${args.learned}`,
    `## What was completed\n${args.completed}`,
    `## Next steps\n${args.next_steps}`,
  ];

  const full = sections.join('\n\n');

  if (full.length <= 4000) {
    return full;
  }

  // Remove sections from the bottom until under limit
  const included = [...sections];
  while (included.length > 0) {
    const candidate = included.join('\n\n');
    if (candidate.length + '\n\n[truncated]'.length <= 4000) {
      return candidate + '\n\n[truncated]';
    }
    included.pop();
  }

  // All sections too long individually — truncate the first section
  return sections[0]!.slice(0, 4000 - '\n\n[truncated]'.length) + '\n\n[truncated]';
}

// ── Tool Handlers ───────────────────────────────────────────────────────

/**
 * Create an error ToolResult.
 */
function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * Create a success ToolResult.
 */
function successResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Handle search_memory tool call.
 *
 * Validates input → calls searchMemories → formats results → returns ToolResult.
 */
export async function handleSearchMemory(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const validated = validateSearchArgs(args);
    if ('error' in validated) {
      return errorResult(validated.error);
    }

    const result = await searchMemories(
      {
        namespace: ctx.namespace,
        query: validated.query,
        limit: validated.limit,
      },
      ctx.config,
    );

    if (!result.ok) {
      return errorResult(result.error.message);
    }

    const formatted = formatSearchResults(result.records);
    return successResult(formatted);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'An unexpected error occurred';
    return errorResult(message);
  }
}

/**
 * Handle save_observation tool call.
 *
 * Validates input → constructs MemoryRecordPayload → calls postMemory → returns confirmation.
 */
export async function handleSaveObservation(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const validated = validateObservationArgs(args);
    if ('error' in validated) {
      return errorResult(validated.error);
    }

    const recordId = `mr_${ulid()}`;

    const record: MemoryRecordPayload = {
      record_id: recordId,
      namespace: ctx.namespace,
      strategy: 'mcp_observation',
      title: validated.title,
      summary: validated.summary,
      facts: validated.facts,
      source_event_ids: [ulid()],
      created_at: new Date().toISOString(),
      concepts: validated.concepts,
      files_touched: validated.files_touched,
      observation_type: validated.observation_type,
    };

    const result = await postMemory(record, ctx.config);

    if (!result.ok) {
      return errorResult(result.error.message);
    }

    return successResult(`Saved observation ${result.record_id}`);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'An unexpected error occurred';
    return errorResult(message);
  }
}

/**
 * Handle save_session_summary tool call.
 *
 * Validates input → constructs MemoryRecordPayload → calls postMemory → returns confirmation.
 *
 * - title: from `request`, truncated to 200 chars
 * - summary: formatted concatenation of investigated/learned/completed/next_steps, truncated to 4000
 * - observation_type: 'session_summary'
 * - strategy: 'mcp_session_summary'
 * - files_touched: deduplicated union of files_read + files_modified
 * - concepts: [], facts: []
 */
export async function handleSaveSessionSummary(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const validated = validateSessionSummaryArgs(args);
    if ('error' in validated) {
      return errorResult(validated.error);
    }

    const recordId = `mr_${ulid()}`;
    const title = validated.request.slice(0, 200);
    const summary = buildSessionSummaryText(validated);

    // Deduplicated union of files_read + files_modified
    const filesTouched = [
      ...new Set([...validated.files_read, ...validated.files_modified]),
    ];

    const record: MemoryRecordPayload = {
      record_id: recordId,
      namespace: ctx.namespace,
      strategy: 'mcp_session_summary',
      title,
      summary,
      facts: [],
      source_event_ids: [ulid()],
      created_at: new Date().toISOString(),
      concepts: [],
      files_touched: filesTouched,
      observation_type: 'session_summary',
    };

    const result = await postMemory(record, ctx.config);

    if (!result.ok) {
      return errorResult(result.error.message);
    }

    return successResult(`Saved session summary ${result.record_id}`);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'An unexpected error occurred';
    return errorResult(message);
  }
}
