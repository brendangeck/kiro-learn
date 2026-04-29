/**
 * XML Framer — converts a {@link KiroMemEvent} into the
 * `<tool_observation>` XML format the compressor agent expects as input.
 *
 * The framer handles three body types (`json`, `text`, `message`) and
 * XML-escapes all text content to prevent injection. No XML library is
 * needed — the output structure is fixed and simple enough for string
 * concatenation with escaping.
 *
 * @see .kiro/specs/xml-extraction-pipeline/design.md § Component 2
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 2, 3
 */

import type { BufferEntry } from '../buffer/types.js';
import type { KiroMemEvent } from '../../types/index.js';

/**
 * Replace the five XML special characters with their entity references.
 *
 * Order matters: `&` must be replaced first to avoid double-escaping the
 * ampersand in subsequently inserted entities.
 *
 * @see Requirements 3.1, 3.2
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Frame an event as a `<tool_observation>` XML string for the compressor.
 *
 * Extracts `tool_name`, `timestamp`, `input`, and optionally `output` from
 * the event body and wraps them in the XML schema the compressor prompt
 * expects.
 *
 * @see Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */
export function frameEvent(event: KiroMemEvent): string {
  const body = event.body;
  let toolName = 'unknown';
  let input = '';
  let output = '';

  if (body.type === 'json') {
    // body.data is `unknown` — it may be null, a primitive, or an object.
    // Only attempt structured field extraction when it is a non-null object.
    if (body.data !== null && typeof body.data === 'object' && !Array.isArray(body.data)) {
      const data = body.data as Record<string, unknown>;
      toolName =
        typeof data['tool_name'] === 'string' ? data['tool_name'] : 'unknown';

      const rawInput = data['tool_input'];
      input =
        rawInput !== null && typeof rawInput === 'object'
          ? JSON.stringify(rawInput)
          : String(rawInput ?? '');

      const rawOutput = data['tool_response'];
      if (rawOutput !== undefined && rawOutput !== null) {
        output =
          typeof rawOutput === 'object'
            ? JSON.stringify(rawOutput)
            : String(rawOutput);
      }
    } else {
      // Non-object data (null, primitive, array): stringify as input
      input = body.data === null || body.data === undefined
        ? ''
        : JSON.stringify(body.data);
    }
  } else if (body.type === 'text') {
    input = body.content;
  } else if (body.type === 'message') {
    input = body.turns.map((t) => `${t.role}: ${t.content}`).join('\n');
  }

  const lines = [
    '<tool_observation>',
    `  <tool_name>${escapeXml(toolName)}</tool_name>`,
    `  <timestamp>${escapeXml(event.valid_time)}</timestamp>`,
    `  <input>${escapeXml(input)}</input>`,
  ];

  if (output) {
    lines.push(`  <output>${escapeXml(output)}</output>`);
  }

  lines.push('</tool_observation>');
  return lines.join('\n');
}

/**
 * Frame a batch of {@link BufferEntry} objects as a concatenated XML string.
 *
 * Each entry is converted to a minimal {@link KiroMemEvent}-shaped object
 * (just enough fields for {@link frameEvent} to work) and framed
 * individually. The results are concatenated with newlines to form the
 * batch prompt sent to the compressor agent.
 *
 * @see Requirements 10.2
 */
export function frameBatch(entries: BufferEntry[]): string {
  return entries
    .map((entry) => {
      const syntheticEvent: KiroMemEvent = {
        event_id: entry.event_id,
        namespace: entry.namespace,
        schema_version: 1 as const,
        kind: entry.kind,
        body: entry.body,
        valid_time: entry.timestamp,
        session_id: '',
        actor_id: '',
        source: {
          surface: entry.surface as 'kiro-cli' | 'kiro-ide',
          version: '',
          client_id: '',
        },
      };
      return frameEvent(syntheticEvent);
    })
    .join('\n');
}
