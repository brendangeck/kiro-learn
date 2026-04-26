/**
 * Integration test: extraction pipeline with real kiro-cli ACP.
 *
 * Requires:
 * - kiro-cli installed and on PATH with ACP support
 * - Network access to Amazon Bedrock (via kiro-cli)
 *
 * The compressor agent config at `~/.kiro/agents/kiro-learn-compressor.json`
 * is rewritten from the current source in a `beforeAll` hook — the test
 * cannot rely on whatever stale version the developer happens to have
 * installed locally. An older kiro-learn install shipped a JSON-output
 * prompt; without this refresh the model returns JSON and every XML
 * assertion fails. The refresh makes the test hermetic at the cost of
 * overwriting the on-disk compressor for the duration of the test run.
 *
 * Run with: npm run test:integ
 *
 * These tests are excluded from CI — they require a real kiro-cli installation
 * and Bedrock credentials. They verify the end-to-end extraction flow:
 * ACP session → XML framing → compressor agent → XML parsing → MemoryRecord validation.
 *
 * @see .kiro/specs/xml-extraction-pipeline/requirements.md § Requirements 1, 2, 4, 6
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAcpSession } from '../../src/collector/pipeline/acp-client.js';
import { frameEvent } from '../../src/collector/pipeline/xml-framer.js';
import {
  parseMemoryXml,
  isGarbageResponse,
} from '../../src/collector/pipeline/xml-parser.js';
import { writeCompressorAgent } from '../../src/installer/index.js';
import { parseMemoryRecord } from '../../src/types/schemas.js';
import type { KiroMemEvent } from '../../src/types/schemas.js';

// ── Precondition checks ─────────────────────────────────────────────────

/** Check if kiro-cli is available and supports the `acp` subcommand. */
function acpAvailable(): boolean {
  try {
    execSync('kiro-cli acp --help', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

const canRun = acpAvailable();

describe.skipIf(!canRun)(
  'Extraction pipeline — ACP + XML integration',
  () => {
    // Backup/restore the global compressor config so the test doesn't
  // permanently mutate the developer's installed agent.
  const compressorPath = join(homedir(), '.kiro', 'agents', 'kiro-learn-compressor.json');
  let originalCompressor: string | null = null;

  beforeAll(() => {
    // Save whatever is on disk (or note its absence).
    if (existsSync(compressorPath)) {
      originalCompressor = readFileSync(compressorPath, 'utf8');
    }

    // Refresh from the current source so the XML prompt is up to date.
    const globalAgentsDir = join(homedir(), '.kiro', 'agents');
    mkdirSync(globalAgentsDir, { recursive: true });
    writeCompressorAgent(globalAgentsDir);
  });

  afterAll(() => {
    // Restore the original compressor config, or remove the file if it
    // didn't exist before the test wrote it.
    if (originalCompressor !== null) {
      writeFileSync(compressorPath, originalCompressor);
    } else if (existsSync(compressorPath)) {
      unlinkSync(compressorPath);
    }
  });

    // Sample event that simulates a real tool_use event
    const sampleEvent: KiroMemEvent = {
      event_id: '01JF8ZS4Y00000000000000000',
      session_id: 'sess-integ-1',
      actor_id: 'integ-test',
      namespace: '/actor/integ-test/project/test/',
      schema_version: 1,
      kind: 'tool_use',
      body: {
        type: 'json',
        data: {
          tool_name: 'fs_read',
          tool_input: { path: 'src/installer/index.ts' },
          tool_response: {
            success: true,
            result:
              'The file contains the installer module with functions for init, start, stop, status, and uninstall commands.',
          },
        },
      },
      valid_time: '2026-04-23T20:00:00Z',
      source: {
        surface: 'kiro-cli',
        version: '0.1.0',
        client_id: 'integ-test-client',
      },
    };

    // Sample event with text body (prompt kind)
    const textEvent: KiroMemEvent = {
      event_id: '01JF8ZS4Y00000000000000001',
      session_id: 'sess-integ-1',
      actor_id: 'integ-test',
      namespace: '/actor/integ-test/project/test/',
      schema_version: 1,
      kind: 'prompt',
      body: {
        type: 'text',
        content:
          'The user asked how to configure the collector port.',
      },
      valid_time: '2026-04-23T20:01:00Z',
      source: {
        surface: 'kiro-cli',
        version: '0.1.0',
        client_id: 'integ-test-client',
      },
    };

    // Sample session_summary event with message body
    const sessionSummaryEvent: KiroMemEvent = {
      event_id: '01JF8ZS4Y00000000000000002',
      session_id: 'sess-integ-1',
      actor_id: 'integ-test',
      namespace: '/actor/integ-test/project/test/',
      schema_version: 1,
      kind: 'session_summary',
      body: {
        type: 'message',
        turns: [
          { role: 'user', content: 'Set up the SQLite storage backend with FTS5 indexing.' },
          { role: 'assistant', content: 'I created the SQLite storage module with FTS5 full-text search. The schema includes events and memory_records tables with an FTS5 virtual table for search.' },
          { role: 'user', content: 'Add migration support so we can evolve the schema.' },
          { role: 'assistant', content: 'Done. Added a migrations runner with version tracking in a _migrations table. The first migration creates the initial schema.' },
        ],
      },
      valid_time: '2026-04-23T20:30:00Z',
      source: {
        surface: 'kiro-cli',
        version: '0.1.0',
        client_id: 'integ-test-client',
      },
    };

    // Sample note event with text body
    const noteEvent: KiroMemEvent = {
      event_id: '01JF8ZS4Y00000000000000003',
      session_id: 'sess-integ-1',
      actor_id: 'integ-test',
      namespace: '/actor/integ-test/project/test/',
      schema_version: 1,
      kind: 'note',
      body: {
        type: 'text',
        content:
          'The team decided to use ULID for all identifiers instead of UUIDv4. ULIDs are lexicographically sortable by timestamp, which gives us natural ordering in SQLite without an extra index on created_at.',
      },
      valid_time: '2026-04-23T21:00:00Z',
      source: {
        surface: 'kiro-cli',
        version: '0.1.0',
        client_id: 'integ-test-client',
      },
    };

    // Sample prompt event with message body (multi-turn conversation)
    const messagePromptEvent: KiroMemEvent = {
      event_id: '01JF8ZS4Y00000000000000004',
      session_id: 'sess-integ-1',
      actor_id: 'integ-test',
      namespace: '/actor/integ-test/project/test/',
      schema_version: 1,
      kind: 'prompt',
      body: {
        type: 'message',
        turns: [
          { role: 'user', content: 'Why is the dedup stage using a Map instead of a Set?' },
          { role: 'assistant', content: 'Map preserves insertion order, so eviction of the oldest entry is O(1) via map.keys().next(). A Set would also work but Map gives us the LRU eviction pattern for free.' },
        ],
      },
      valid_time: '2026-04-23T20:15:00Z',
      source: {
        surface: 'kiro-cli',
        version: '0.1.0',
        client_id: 'integ-test-client',
      },
    };

    it('frameEvent produces well-formed XML from a tool_use event', () => {
      const xml = frameEvent(sampleEvent);
      expect(xml).toMatch(/^<tool_observation>/);
      expect(xml).toMatch(/<\/tool_observation>$/);
      expect(xml).toContain('<tool_name>fs_read</tool_name>');
      expect(xml).toContain('<timestamp>');
      expect(xml).toContain('<input>');
      expect(xml).toContain('<output>');
    });

    it('ACP session completes handshake and returns a response', async () => {
      const xml = frameEvent(sampleEvent);
      const session = await createAcpSession({
        agentName: 'kiro-learn-compressor',
        timeoutMs: 60_000,
      });

      try {
        const response = await session.sendPrompt(xml);
        expect(typeof response).toBe('string');
        // Response should be non-empty (either XML records or empty skip)
        // We just verify we got a string back without timeout
      } finally {
        session.destroy();
      }
    }, 90_000);

    it('compressor response parses as XML memory records', async () => {
      const xml = frameEvent(sampleEvent);
      const session = await createAcpSession({
        agentName: 'kiro-learn-compressor',
        timeoutMs: 60_000,
      });

      let response: string;
      try {
        response = await session.sendPrompt(xml);
      } finally {
        session.destroy();
      }

      // Empty response is a valid skip — not an error
      if (!response.trim()) {
        return;
      }

      // If non-empty, it should not be garbage
      expect(isGarbageResponse(response)).toBe(false);

      const records = parseMemoryXml(response);
      expect(records.length).toBeGreaterThan(0);

      for (const record of records) {
        expect(record.title.length).toBeGreaterThan(0);
        expect(record.title.length).toBeLessThanOrEqual(200);
        expect(record.summary.length).toBeGreaterThan(0);
        expect(record.summary.length).toBeLessThanOrEqual(4000);
        expect([
          'tool_use',
          'decision',
          'error',
          'discovery',
          'pattern',
        ]).toContain(record.type);
        expect(Array.isArray(record.facts)).toBe(true);
        expect(Array.isArray(record.concepts)).toBe(true);
        expect(Array.isArray(record.files)).toBe(true);
      }
    }, 90_000);

    it('enriched records pass parseMemoryRecord validation', async () => {
      const xml = frameEvent(sampleEvent);
      const session = await createAcpSession({
        agentName: 'kiro-learn-compressor',
        timeoutMs: 60_000,
      });

      let response: string;
      try {
        response = await session.sendPrompt(xml);
      } finally {
        session.destroy();
      }

      // Empty response is a valid skip
      if (!response.trim()) {
        return;
      }

      const records = parseMemoryXml(response);
      expect(records.length).toBeGreaterThan(0);

      // Enrich each record with pipeline-managed fields and validate
      for (let i = 0; i < records.length; i++) {
        const raw = records[i]!;
        const enriched = {
          record_id: 'mr_00000000000000000000000000',
          namespace: '/actor/integ-test/project/test/',
          strategy: 'llm-summary',
          source_event_ids: ['01JF8ZS4Y00000000000000000'],
          created_at: new Date().toISOString(),
          title: raw.title,
          summary: raw.summary,
          facts: raw.facts,
          concepts: raw.concepts,
          files_touched: raw.files,
          observation_type: raw.type,
        };

        // This should not throw — the enriched record must be schema-valid
        const record = parseMemoryRecord(enriched);

        expect(record.title.length).toBeGreaterThan(0);
        expect(record.title.length).toBeLessThanOrEqual(200);
        expect(record.summary.length).toBeGreaterThan(0);
        expect(record.summary.length).toBeLessThanOrEqual(4000);
        expect(record.strategy).toBe('llm-summary');
        expect(record.concepts).toBeDefined();
        expect(record.files_touched).toBeDefined();
        expect(record.observation_type).toBeDefined();
      }
    }, 90_000);

    /**
     * Helper: send an event through ACP and validate the response.
     * Accepts either an empty skip or well-formed XML memory records.
     */
    async function sendAndValidate(event: KiroMemEvent): Promise<void> {
      const xml = frameEvent(event);
      const session = await createAcpSession({
        agentName: 'kiro-learn-compressor',
        timeoutMs: 60_000,
      });

      let response: string;
      try {
        response = await session.sendPrompt(xml);
      } finally {
        session.destroy();
      }

      // Empty response is a valid skip
      if (!response.trim()) {
        return;
      }

      // Non-empty response should not be garbage
      expect(isGarbageResponse(response)).toBe(false);

      const records = parseMemoryXml(response);
      for (const record of records) {
        expect(record.title.length).toBeGreaterThan(0);
        expect(record.title.length).toBeLessThanOrEqual(200);
        expect(record.summary.length).toBeGreaterThan(0);
        expect(record.summary.length).toBeLessThanOrEqual(4000);
        expect([
          'tool_use',
          'decision',
          'error',
          'discovery',
          'pattern',
        ]).toContain(record.type);
      }
    }

    it('handles text body content via ACP (prompt kind)', async () => {
      await sendAndValidate(textEvent);
    }, 90_000);

    it('handles session_summary event with message body via ACP', async () => {
      const xml = frameEvent(sessionSummaryEvent);
      // Message body concatenates turns as input
      expect(xml).toContain('<tool_name>unknown</tool_name>');
      expect(xml).toContain('user:');
      expect(xml).toContain('assistant:');

      await sendAndValidate(sessionSummaryEvent);
    }, 90_000);

    it('handles note event with text body via ACP', async () => {
      const xml = frameEvent(noteEvent);
      expect(xml).toContain('<tool_name>unknown</tool_name>');
      expect(xml).toContain('ULID');

      await sendAndValidate(noteEvent);
    }, 90_000);

    it('handles prompt event with message body via ACP', async () => {
      const xml = frameEvent(messagePromptEvent);
      expect(xml).toContain('<tool_name>unknown</tool_name>');
      expect(xml).toContain('user:');
      expect(xml).toContain('assistant:');

      await sendAndValidate(messagePromptEvent);
    }, 90_000);
  },
);
