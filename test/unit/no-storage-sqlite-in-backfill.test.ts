/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/collector/backfill/` imports
 * from `src/collector/storage/sqlite/`.
 *
 * The design document (§ Components and Interfaces → `src/collector/backfill/`)
 * states that the backfill worker is storage-agnostic: it iterates
 * records with NULL embeddings through the `StorageBackend` interface
 * (`listRecordsWithoutEmbedding`, `putEmbedding`) and delegates vector
 * computation to an injected `Embedder`. Only the top-level daemon
 * wiring (`src/collector/index.ts`) may import from the concrete SQLite
 * backend.
 *
 * A direct import from `storage/sqlite/` inside any backfill module
 * file would couple the backfill loop to a specific storage
 * implementation — breaking the contract that a future `StorageBackend`
 * (e.g. Aurora + pgvector, Bedrock AgentCore Memory) can be dropped in
 * without touching backfill code.
 *
 * The check recursively reads every `.ts` file under
 * `src/collector/backfill/`, strips comments (so TSDoc descriptions of
 * the boundary remain allowed), and searches for import statements
 * referencing `storage/sqlite`.
 *
 * Validates: Requirements 13.1, 13.2; Design § Components and
 * Interfaces → `src/collector/backfill/`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Directory that must NOT import from storage/sqlite/. */
const BACKFILL_DIR = fileURLToPath(
  new URL('../../src/collector/backfill', import.meta.url),
);

/** Recursively collect every `.ts` file under `dir`. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (stat.isFile() && entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip TypeScript comments from `source` so the scan only sees executable
 * code. TSDoc and line comments that *describe* the modularity boundary
 * are explicitly allowed; only executable import statements are violations.
 *
 * The stripper handles the two comment forms TypeScript uses:
 *   - block comments `/* … *\/` (any length, including TSDoc `/** … *\/`);
 *   - line comments `// …` to end of line.
 */
function stripComments(source: string): string {
  // Block comments first, to avoid `//` inside `/* ... // ... */` being
  // treated as the start of a line comment.
  let withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  withoutBlocks = withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return withoutBlocks;
}

describe('backfill module — no direct SQLite imports', () => {
  it('does not import from storage/sqlite/ in src/collector/backfill/', () => {
    /**
     * **Validates: Requirements 13.1, 13.2; Design § Components and
     * Interfaces → `src/collector/backfill/`**
     *
     * Only `src/collector/index.ts` (the daemon wiring) may import from
     * `src/collector/storage/sqlite/`. The backfill worker receives a
     * `StorageBackend` and an `Embedder` via dependency injection. A
     * direct import from `storage/sqlite` in any backfill file is a
     * modularity violation.
     */
    const files = collectTsFiles(BACKFILL_DIR);

    // Sanity: ensure we actually walked some files.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    const sqliteImportPattern = /storage\/sqlite/;

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (sqliteImportPattern.test(line)) {
          offenders.push({
            file,
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from storage/sqlite/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});
