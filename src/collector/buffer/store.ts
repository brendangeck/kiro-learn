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
 * Typed facade for `fs.flockSync` (Node ≥ 22).
 *
 * `@types/node` does not yet declare `flockSync`, so we cast through this
 * interface when calling it.  At runtime the function exists on Node 22+
 * builds that include POSIX advisory locking support.
 */
interface FlockFs {
  flockSync(fd: number, operation: 'ex' | 'sh' | 'un'): void;
}

/**
 * Result of an atomic buffer replace operation.
 *
 * @see Requirements 6.2, 6.4
 */
export interface ReplaceResult {
  /** Entries from the catch-up window that were replayed. */
  catchUpEntries: BufferEntry[];
  /** Total bytes of the new buffer file. */
  newSizeBytes: number;
}

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

  /**
   * Read all valid entries and the current byte size atomically.
   * Used by CompactionWorker to capture both snapshot and S0 in one call
   * so no appends can slip between the two reads.
   */
  snapshotWithSize(projectId: string): Promise<{ entries: BufferEntry[]; sizeBytes: number }>;

  /** Current byte size of the buffer file. Returns 0 if file does not exist. */
  size(projectId: string): Promise<number>;

  /** Resolve the filesystem path for a project buffer. */
  bufferPath(projectId: string): string;

  /** List all project IDs that have buffer files. */
  listProjects(): Promise<string[]>;

  /** Remove the buffer file for a project. */
  clear(projectId: string): Promise<void>;

  /** Current byte size of the buffer file (synchronous). Returns 0 if file does not exist. */
  sizeSync(projectId: string): number;

  /**
   * Atomically replace buffer contents with catch-up replay.
   *
   * 1. Acquire exclusive flock on the buffer file
   * 2. Read any bytes appended since `sinceOffset` (catch-up window)
   * 3. Parse catch-up bytes into BufferEntry objects
   * 4. Write `newEntries` + catch-up entries to a temp file
   * 5. Rename temp file to buffer file (atomic on POSIX)
   * 6. Release exclusive flock
   *
   * Returns the catch-up entries that were replayed and the new file size.
   *
   * @see Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
   */
  replace(
    projectId: string,
    newEntries: readonly BufferEntry[],
    sinceOffset: number,
  ): Promise<ReplaceResult>;
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
     * Read all valid entries and the current byte size atomically.
     *
     * Reads the file content once and derives both the parsed entries and
     * the byte size from the same read, so no appends can slip between
     * the two values.
     *
     * @see Requirements 1.5, 7.1
     */
    async snapshotWithSize(projectId: string): Promise<{ entries: BufferEntry[]; sizeBytes: number }> {
      const filePath = this.bufferPath(projectId);

      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { entries: [], sizeBytes: 0 };
        }
        throw err;
      }

      const sizeBytes = Buffer.byteLength(content, 'utf-8');
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

      return { entries, sizeBytes };
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
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return 0;
        }
        throw err;
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

    /**
     * Return the byte size of the buffer file synchronously, or 0 if it
     * does not exist.
     *
     * Used by CompactionWorker to record S0 at snapshot time so the byte
     * offset is captured atomically with the snapshot read.
     *
     * @see Requirements 7.1, 7.2
     */
    sizeSync(projectId: string): number {
      const filePath = this.bufferPath(projectId);

      try {
        const stat = fs.statSync(filePath);
        return stat.size;
      } catch (err: unknown) {
        if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return 0;
        }
        throw err;
      }
    },

    /**
     * Atomically replace buffer contents with catch-up replay.
     *
     * Opens the buffer file, acquires an exclusive POSIX flock, reads any
     * bytes appended since `sinceOffset`, writes `newEntries` + catch-up
     * entries to a temp file, and atomically renames it over the buffer.
     *
     * The exclusive lock is held only for the brief read + write + rename
     * window (sub-millisecond for typical catch-up sizes).
     *
     * @see Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
     */
    async replace(
      projectId: string,
      newEntries: readonly BufferEntry[],
      sinceOffset: number,
    ): Promise<ReplaceResult> {
      const filePath = this.bufferPath(projectId);
      const dir = path.dirname(filePath);
      const tempPath = path.join(dir, `buffer.ndjson.${Date.now()}.tmp`);

      // Open the buffer file for reading to acquire the exclusive lock.
      const fd = fs.openSync(filePath, 'r');

      try {
        // 1. Acquire exclusive POSIX file lock.
        //    fs.flockSync is a Node 22+ API — call via cast since @types/node
        //    may not yet include the declaration.
        (fs as unknown as FlockFs).flockSync(fd, 'ex');

        try {
          // 2. Read catch-up bytes [sinceOffset, current_size).
          const stat = fs.fstatSync(fd);
          const catchUpSize = stat.size - sinceOffset;
          const catchUpEntries: BufferEntry[] = [];

          if (catchUpSize > 0) {
            const catchUpBuffer = Buffer.alloc(catchUpSize);
            fs.readSync(fd, catchUpBuffer, 0, catchUpSize, sinceOffset);
            const catchUpText = catchUpBuffer.toString('utf-8');

            // 3. Parse catch-up lines into BufferEntry objects.
            for (const line of catchUpText.split('\n')) {
              const trimmed = line.trim();
              if (trimmed.length === 0) continue;

              try {
                catchUpEntries.push(JSON.parse(trimmed) as BufferEntry);
              } catch {
                process.stderr.write(
                  `[kiro-learn] skipping corrupt catch-up line in ${filePath}: ${trimmed.slice(0, 80)}\n`,
                );
              }
            }
          }

          // 4. Write newEntries + catch-up entries to temp file.
          let totalBytes = 0;
          const lines: string[] = [];

          for (const entry of newEntries) {
            const line = JSON.stringify(entry) + '\n';
            lines.push(line);
            totalBytes += Buffer.byteLength(line, 'utf-8');
          }

          for (const entry of catchUpEntries) {
            const line = JSON.stringify(entry) + '\n';
            lines.push(line);
            totalBytes += Buffer.byteLength(line, 'utf-8');
          }

          fs.writeFileSync(tempPath, lines.join(''), 'utf-8');

          // 5. Atomic rename — POSIX guarantees this is atomic on the same filesystem.
          fs.renameSync(tempPath, filePath);

          return { catchUpEntries, newSizeBytes: totalBytes };
        } finally {
          // 6. Release exclusive lock.
          (fs as unknown as FlockFs).flockSync(fd, 'un');
        }
      } finally {
        // 7. Close file descriptor.
        fs.closeSync(fd);

        // 8. Clean up temp file if it still exists (rename failed or was never reached).
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Already renamed or doesn't exist — that's fine.
        }
      }
    },
  };
}
