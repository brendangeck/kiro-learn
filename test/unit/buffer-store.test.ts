/**
 * Unit tests for BufferStore (NDJSON file management).
 *
 * Covers corrupt-line handling, size for non-existent files, clear,
 * listProjects, mkdir-on-first-append, and snapshot for non-existent projects.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Component 1: BufferStore
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirements 1.1, 1.2, 1.5, 1.6, 1.7, 1.8, 3.2, 14.3
 */

import * as fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBufferStore } from '../../src/collector/buffer/store.js';
import type { BufferEntry } from '../../src/collector/buffer/types.js';

let tmpDir: string;

/** Build a minimal valid BufferEntry for testing. */
function makeEntry(overrides: Partial<BufferEntry> = {}): BufferEntry {
  return {
    event_id: '01JF8ZS4Y00000000000000000',
    namespace: '/actor/alice/project/abc123/',
    kind: 'prompt',
    body: { type: 'text', content: 'hello' },
    timestamp: '2026-04-23T20:00:00Z',
    surface: 'kiro-cli',
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'buffer-store-test-'));
});

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('BufferStore', () => {
  describe('snapshot — corrupt-line handling', () => {
    it('skips corrupt lines and returns valid entries', async () => {
      const store = createBufferStore(tmpDir);
      const projectId = 'proj-corrupt';
      const filePath = store.bufferPath(projectId);

      // Create the directory structure manually
      fs.mkdirSync(join(tmpDir, projectId), { recursive: true });

      const validEntry = makeEntry({ event_id: '01JF8ZS4Y00000000000000001' });
      const validEntry2 = makeEntry({ event_id: '01JF8ZS4Y00000000000000002' });

      // Write a mix of valid JSON lines and corrupt lines
      const lines = [
        JSON.stringify(validEntry),
        '{"broken json line',
        JSON.stringify(validEntry2),
        'not json at all',
        '',
      ].join('\n');

      fs.writeFileSync(filePath, lines, 'utf-8');

      const snapshot = await store.snapshot(projectId);

      expect(snapshot).toHaveLength(2);
      expect(snapshot[0]).toEqual(validEntry);
      expect(snapshot[1]).toEqual(validEntry2);
    });
  });

  describe('snapshot — non-existent project', () => {
    it('returns empty array for non-existent project', async () => {
      const store = createBufferStore(tmpDir);
      const snapshot = await store.snapshot('does-not-exist');
      expect(snapshot).toEqual([]);
    });
  });

  describe('size', () => {
    it('returns 0 for non-existent project', async () => {
      const store = createBufferStore(tmpDir);
      const bytes = await store.size('no-such-project');
      expect(bytes).toBe(0);
    });

    it('returns correct byte count after appending', async () => {
      const store = createBufferStore(tmpDir);
      const projectId = 'proj-size';
      const entry = makeEntry();

      const bytesWritten = await store.append(projectId, entry);
      const size = await store.size(projectId);

      expect(size).toBe(bytesWritten);
      expect(size).toBeGreaterThan(0);
    });
  });

  describe('clear', () => {
    it('removes the buffer file', async () => {
      const store = createBufferStore(tmpDir);
      const projectId = 'proj-clear';

      await store.append(projectId, makeEntry());
      const sizeBefore = await store.size(projectId);
      expect(sizeBefore).toBeGreaterThan(0);

      await store.clear(projectId);

      const sizeAfter = await store.size(projectId);
      expect(sizeAfter).toBe(0);
    });
  });

  describe('listProjects', () => {
    it('returns empty array when no buffers exist', async () => {
      const store = createBufferStore(tmpDir);
      const projects = await store.listProjects();
      expect(projects).toEqual([]);
    });

    it('returns correct project IDs after appending to multiple projects', async () => {
      const store = createBufferStore(tmpDir);

      await store.append('proj-a', makeEntry());
      await store.append('proj-b', makeEntry());
      await store.append('proj-c', makeEntry());

      const projects = await store.listProjects();

      expect(projects.sort()).toEqual(['proj-a', 'proj-b', 'proj-c']);
    });
  });

  describe('mkdir-on-first-append', () => {
    it('creates the directory structure on first append', async () => {
      const store = createBufferStore(tmpDir);
      const projectId = 'proj-mkdir';
      const dirPath = join(tmpDir, projectId);

      // Directory should not exist yet
      expect(fs.existsSync(dirPath)).toBe(false);

      await store.append(projectId, makeEntry());

      // Directory and file should now exist
      expect(fs.existsSync(dirPath)).toBe(true);
      expect(fs.existsSync(store.bufferPath(projectId))).toBe(true);
    });
  });
});
