/**
 * Kiro IDE hook shim (v1).
 *
 * Invoked by `.kiro/hooks/*.kiro.hook` entries in a Kiro IDE project.
 * Reads the hook event type from `process.argv[2]`, the payload from
 * the `USER_PROMPT` environment variable, and the working directory from
 * `process.cwd()`. Normalizes the input into a canonical Event, POSTs it
 * to the collector, and returns any retrieval context to the IDE runtime
 * via stdout for prompt injection.
 *
 * @see Requirements 3.1, 3.2, 3.5, 4.1, 4.2, 4.5, 11.1, 11.2
 */

import type { KiroMemEvent } from '../../types/index.js';
import {
  buildEvent,
  loadConfig,
  postEvent,
  readSession,
  truncateBody,
} from '../shared/index.js';

// ── Handler functions ───────────────────────────────────────────────────

/**
 * Handle the `promptSubmit` hook.
 *
 * Reads `USER_PROMPT` as plain text, builds a "prompt" event, POSTs with
 * `retrieve=true`, and writes retrieval context to stdout when available.
 *
 * @see Requirements 4.6, 5.1, 6.1, 6.2, 7.1, 7.4, 8.1, 8.2, 8.3
 */
async function handlePrompt(userPrompt: string, cwd: string): Promise<void> {
  const config = loadConfig();
  const sessionId = readSession(cwd);

  let body: KiroMemEvent['body'] = { type: 'text', content: userPrompt };
  body = truncateBody(body, config.maxBodyBytes);

  const event = buildEvent({
    kind: 'prompt',
    body,
    sessionId,
    cwd,
    surface: 'kiro-ide',
  });

  const response = await postEvent(event, { retrieve: true }, config);

  if (
    response !== null &&
    response.retrieval !== undefined &&
    response.retrieval.context !== ''
  ) {
    process.stdout.write(response.retrieval.context);
  }
}

/**
 * Handle the `postToolUse` hook.
 *
 * Parses `USER_PROMPT` as camelCase JSON, maps fields to the kiro-learn
 * snake_case convention, builds a "tool_use" event, and POSTs with
 * `retrieve=false`. No stdout output.
 *
 * @see Requirements 4.7, 4.9, 5.1, 7.2, 7.5, 8.4
 */
async function handleToolUse(userPrompt: string, cwd: string): Promise<void> {
  const config = loadConfig();
  const sessionId = readSession(cwd);

  let toolName = 'unknown';
  let toolInput: Record<string, unknown> = {};
  let toolResponse: Record<string, unknown> = {};

  try {
    const parsed = JSON.parse(userPrompt) as Record<string, unknown>;

    if (typeof parsed['toolName'] === 'string') {
      toolName = parsed['toolName'];
    }
    if (
      parsed['toolArgs'] !== null &&
      parsed['toolArgs'] !== undefined &&
      typeof parsed['toolArgs'] === 'object'
    ) {
      toolInput = parsed['toolArgs'] as Record<string, unknown>;
    }

    const resp: Record<string, unknown> = {};
    if (parsed['toolResult'] !== undefined) {
      resp['result'] = parsed['toolResult'];
    }
    if (parsed['toolSuccess'] !== undefined) {
      resp['success'] = parsed['toolSuccess'];
    }
    if (Object.keys(resp).length > 0) {
      toolResponse = resp;
    }
  } catch {
    process.stderr.write('[kiro-learn] failed to parse USER_PROMPT JSON\n');
  }

  const data = {
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
  };

  let body: KiroMemEvent['body'] = { type: 'json', data };
  body = truncateBody(body, config.maxBodyBytes);

  const event = buildEvent({
    kind: 'tool_use',
    body,
    sessionId,
    cwd,
    surface: 'kiro-ide',
  });

  await postEvent(event, { retrieve: false }, config);
}

/**
 * Handle the `agentStop` hook.
 *
 * Reads `USER_PROMPT` as plain text (summary), builds a "session_summary"
 * event, and POSTs with `retrieve=false`. No stdout output.
 *
 * @see Requirements 4.8, 5.1, 7.3, 8.4
 */
async function handleStop(userPrompt: string, cwd: string): Promise<void> {
  const config = loadConfig();
  const sessionId = readSession(cwd);

  let body: KiroMemEvent['body'] = { type: 'text', content: userPrompt };
  body = truncateBody(body, config.maxBodyBytes);

  const event = buildEvent({
    kind: 'session_summary',
    body,
    sessionId,
    cwd,
    surface: 'kiro-ide',
  });

  await postEvent(event, { retrieve: false }, config);
}

// ── Main entry point ────────────────────────────────────────────────────

/**
 * Main entry point for the IDE hook shim.
 *
 * Reads the hook event type from `process.argv[2]`, the payload from
 * `process.env.USER_PROMPT`, and the working directory from `process.cwd()`.
 * Dispatches to the appropriate handler. Always exits 0.
 *
 * @see Requirements 3.1, 3.2, 3.3, 3.5, 4.1, 4.2, 4.5, 11.1, 11.2, 11.4, 11.5
 */
export async function main(): Promise<void> {
  try {
    const eventType = process.argv[2];
    const userPrompt = process.env['USER_PROMPT'] ?? '';
    const cwd = process.cwd();

    switch (eventType) {
      case 'promptSubmit':
        await handlePrompt(userPrompt, cwd);
        break;
      case 'postToolUse':
        await handleToolUse(userPrompt, cwd);
        break;
      case 'agentStop':
        await handleStop(userPrompt, cwd);
        break;
      default:
        if (eventType !== undefined) {
          process.stderr.write(
            `[kiro-learn] unrecognized IDE hook event: ${eventType}\n`,
          );
        } else {
          process.stderr.write(
            '[kiro-learn] missing IDE hook event type argument\n',
          );
        }
        break;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[kiro-learn] unexpected error: ${message}\n`);
  }
}
