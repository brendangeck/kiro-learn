/**
 * Per-project append-only NDJSON buffer store.
 *
 * Manages buffer files at `<bufferDir>/<projectId>/buffer.ndjson`. Each line
 * is a self-contained JSON object representing a {@link BufferEntry}. The
 * buffer is append-only — entries are only removed when {@link BufferStore.clear}
 * is called after a successful extraction.
 *
 * Internal to `src/collector/buffer/` — not exposed via HTTP.
 *
 * @see .kiro/specs/workspace-buffer-pipeline/design.md § Component 1: BufferStore
 * @see .kiro/specs/workspace-buffer-pipeline/requirements.md § Requirement 1, 3
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BufferEntry } from './types.js';

const BUFFER_FILENAME = 'buffer.ndjson';

/**
 * Per-project append-only NDJSON buffer store.
 *
 * @see Requirements 1.1–1.8, 3.1–3.3
 */
export interface BufferStore {
  /** Append a scrubbed event to the project buffer. Returns bytes written. */
  append(projectId: string, entry: BufferEntry): Promise<number>;

  /** Read all valid entries from the buffer as a snapshot. Skips corrupt lines. */
  snapshot(projectId: string): Promise<BufferEntry[]>;

  /** Current byte size of the buffer file. Returns 0 if file does not exist. */
  size(projectId: string): Promise<number>;

  /** Resolve the filesystem path for a project buffer. */
  bufferPath(projectId: string): string;

  /** List all project IDs that have buffer files. */
  listProjects(): Promise<string[]>;

  /** Remove the buffer file for a project. */
  clear(projectId: string): Promise<void>;
}

/**
 * Create a {@link BufferStore} backed by the local filesystem.
 *
 * @param bufferDir - Root directory for buffer files.
 *   Defaults to `~/.kiro-learn/buffers/`.
 *
 * @see Requirements 1.1, 1.2, 18.2
 */
export function createBufferStore(
  bufferDir: string = path.join(os.homedir(), '.kiro-learn', 'buffers'),
): BufferStore {
  return {
    /**
     * Append a {@link BufferEntry} as a single NDJSON line to the project
     * buffer file. Creates the buffer directory on first append.
     *
     * Each entry is serialized as `JSON.stringify(entry) + '\n'` and written
     * atomically via `appendFileSync`. Returns the number of bytes written.
     *
     * @see Requirements 1.1, 1.2, 1.3, 1.4, 3.1
     */
    async append(projectId: string, entry: BufferEntry): Promise<number> {
      const filePath = this.bufferPath(projectId);
      const dir = path.dirname(filePath);

      fs.mkdirSync(dir, { recursive: true });

      const line = JSON.stringify(entry) + '\n';
      const bytes = Buffer.byteLength(line, 'utf-8');

      fs.appendFileSync(filePath, line, 'utf-8');

      return bytes;
    },

    /**
     * Read all valid {@link BufferEntry} objects from the buffer file.
     *
     * Parses each line independently. Lines that fail `JSON.parse` are
     * skipped with a warning logged to stderr — this handles partial writes
     * from crashes.
     *
     * @see Requirements 1.5, 3.2, 3.3
     */
    async snapshot(projectId: string): Promise<BufferEntry[]> {
      const filePath = this.bufferPath(projectId);

      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return [];
        }
        throw err;
      }

      const lines = content.split('\n');
      const entries: BufferEntry[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        try {
          entries.push(JSON.parse(trimmed) as BufferEntry);
        } catch {
          process.stderr.write(
            `[kiro-learn] skipping corrupt buffer line in ${filePath}: ${trimmed.slice(0, 80)}\n`,
          );
        }
      }

      return entries;
    },

    /**
     * Return the byte size of the buffer file, or 0 if it does not exist.
     *
     * @see Requirement 1.7
     */
    async size(projectId: string): Promise<number> {
      const filePath = this.bufferPath(projectId);

      try {
        const stat = fs.statSync(filePath);
        return stat.size;
      } catch {
        return 0;
      }
    },

    /**
     * Resolve the filesystem path for a project buffer file.
     *
     * Path: `<bufferDir>/<projectId>/buffer.ndjson`
     *
     * Validates that `projectId` is a safe filesystem token (no path
     * separators, no traversal segments) to prevent directory traversal
     * when `extractProjectId` falls back to the raw namespace string.
     *
     * @see Requirement 1.1
     */
    bufferPath(projectId: string): string {
      const safe = path.basename(projectId);
      if (safe !== projectId || safe === '' || safe === '.' || safe === '..') {
        throw new Error(`unsafe projectId for buffer path: ${projectId}`);
      }
      return path.join(bufferDir, safe, BUFFER_FILENAME);
    },

    /**
     * List all project IDs that have buffer files on disk.
     *
     * Reads the buffer directory and returns the names of subdirectories
     * that contain a `buffer.ndjson` file.
     *
     * @see Requirement 1.8
     */
    async listProjects(): Promise<string[]> {
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = fs.readdirSync(bufferDir, { withFileTypes: true });
      } catch {
        return [];
      }

      const projectIds: string[] = [];

      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue;

        const bufferFile = path.join(bufferDir, entry.name, BUFFER_FILENAME);
        try {
          fs.statSync(bufferFile);
          projectIds.push(entry.name);
        } catch {
          // No buffer file in this directory — skip.
        }
      }

      return projectIds;
    },

    /**
     * Remove the buffer file for a project.
     *
     * @see Requirement 1.6
     */
    async clear(projectId: string): Promise<void> {
      const filePath = this.bufferPath(projectId);

      try {
        fs.unlinkSync(filePath);
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return; // File already gone — that's fine.
        }
        throw err;
      }
    },
  };
}
