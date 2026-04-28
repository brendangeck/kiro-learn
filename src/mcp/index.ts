/**
 * MCP server entry point — wires tool registration, dispatch, and stdio transport.
 *
 * Creates a `Server` instance with the three memory tools (search_memory,
 * save_observation, save_session_summary), derives the project namespace
 * from `process.cwd()`, loads collector config, and connects via
 * `StdioServerTransport`.
 *
 * Errors are logged to stderr only — stdout is reserved for JSON-RPC.
 *
 * @see Requirements 1.1–1.6, 2.1–2.4, N1, N6, N9
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadCollectorConfig } from './client.js';
import { deriveNamespace } from './namespace.js';
import {
  handleSaveObservation,
  handleSaveSessionSummary,
  handleSearchMemory,
} from './tools.js';
import type { ToolContext } from './tools.js';

// ── Version resolution ──────────────────────────────────────────────────

/**
 * Read the package version once at module load. The compiled entry point
 * lives at `dist/mcp/index.js`, so `../../package.json` resolves to the
 * root `package.json`.
 */
function loadVersion(): string {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    );
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Tool definitions ────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: 'search_memory',
    description:
      'Search kiro-learn memory records for the current project. Returns relevant prior observations, decisions, and patterns.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query',
        },
        limit: {
          type: 'number',
          description:
            'Maximum number of results to return (default: 10, max: 100)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'save_observation',
    description:
      'Store a structured observation as a memory record for future sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the observation (max 200 chars)',
        },
        summary: {
          type: 'string',
          description:
            'Detailed description of the observation (max 4000 chars)',
        },
        observation_type: {
          type: 'string',
          enum: ['tool_use', 'decision', 'error', 'discovery', 'pattern'],
          description: 'Classification of the observation',
        },
        concepts: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Key concepts or topics related to this observation',
        },
        files_touched: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths relevant to this observation',
        },
        facts: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Specific factual statements extracted from this observation',
        },
      },
      required: [
        'title',
        'summary',
        'observation_type',
        'concepts',
        'files_touched',
        'facts',
      ],
    },
  },
  {
    name: 'save_session_summary',
    description:
      'Store a structured session summary capturing what was accomplished in this session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        request: {
          type: 'string',
          description: 'What the user asked for',
        },
        investigated: {
          type: 'string',
          description: 'What was investigated or explored',
        },
        learned: {
          type: 'string',
          description: 'Key learnings or discoveries',
        },
        completed: {
          type: 'string',
          description: 'What was completed or delivered',
        },
        next_steps: {
          type: 'string',
          description: 'Suggested next steps or follow-ups',
        },
        files_read: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files that were read during the session',
        },
        files_modified: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files that were modified during the session',
        },
      },
      required: [
        'request',
        'investigated',
        'learned',
        'completed',
        'next_steps',
        'files_read',
        'files_modified',
      ],
    },
  },
];

// ── Server factory ──────────────────────────────────────────────────────

/**
 * Create and start the MCP memory server.
 *
 * 1. Derives namespace from `process.cwd()`
 * 2. Loads collector config from `~/.kiro-learn/settings.json`
 * 3. Creates `Server` with tool handlers
 * 4. Connects via `StdioServerTransport`
 */
export async function main(): Promise<void> {
  const version = loadVersion();
  const namespace = deriveNamespace(process.cwd());
  const config = loadCollectorConfig();

  const ctx: ToolContext = { namespace, config };

  const server = new Server(
    { name: 'kiro-learn-memory', version },
    { capabilities: { tools: {} } },
  );

  // ── List tools handler ──────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  // ── Call tool handler ───────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args ?? {}) as Record<string, unknown>;

    switch (name) {
      case 'search_memory':
        return { ...await handleSearchMemory(toolArgs, ctx) };
      case 'save_observation':
        return { ...await handleSaveObservation(toolArgs, ctx) };
      case 'save_session_summary':
        return { ...await handleSaveSessionSummary(toolArgs, ctx) };
      default:
        return {
          content: [{ type: 'text' as const, text: `Error: unknown tool "${name}"` }],
          isError: true,
        };
    }
  });

  // ── Connect transport ───────────────────────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
