/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/collector/embedding/` imports
 * from `src/collector/storage/sqlite/`.
 *
 * The design document (§ Components and Interfaces → `src/collector/embedding/`)
 * states that the embedding module is storage-agnostic: it exposes pure
 * helpers (BLOB codec, cosine, RRF fusion, input composition) and the
 * concrete `OnnxEmbedder`, all of which are consumed by higher layers
 * (`ExtractionWorker`, `QueryLayer`, `BackfillWorker`). Storage access
 * is routed exclusively through the `StorageBackend` interface owned by
 * `src/types/`; only the top-level daemon wiring
 * (`src/collector/index.ts`) may depend on the concrete SQLite backend.
 *
 * A direct import from `storage/sqlite/` inside any embedding module
 * file would couple the embedding layer to a specific storage
 * implementation and defeat the never-degrade-below-FTS5 modularity
 * guarantee documented in the spec.
 *
 * The check recursively reads every `.ts` file under
 * `src/collector/embedding/`, strips comments (so the many TSDoc
 * descriptions of the boundary remain allowed), and searches for
 * import statements referencing `storage/sqlite`.
 *
 * Validates: Requirements 13.1, 13.2; Design § Components and
 * Interfaces → `src/collector/embedding/`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Directory that must NOT import from storage/sqlite/. */
const EMBEDDING_DIR = fileURLToPath(
  new URL('../../src/collector/embedding', import.meta.url),
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

describe('embedding module — no direct SQLite imports', () => {
  it('does not import from storage/sqlite/ in src/collector/embedding/', () => {
    /**
     * **Validates: Requirements 13.1, 13.2; Design § Components and
     * Interfaces → `src/collector/embedding/`**
     *
     * Only `src/collector/index.ts` (the daemon wiring) may import from
     * `src/collector/storage/sqlite/`. The embedding module receives a
     * `StorageBackend` via dependency injection at the layers that
     * consume it (`ExtractionWorker`, `QueryLayer`, `BackfillWorker`).
     * A direct import from `storage/sqlite` in any embedding file is a
     * modularity violation.
     */
    const files = collectTsFiles(EMBEDDING_DIR);

    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the directory) would otherwise produce
    // a silently-passing vacuous test.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    // Match any reference to storage/sqlite in executable code:
    //   - 'storage/sqlite'
    //   - './storage/sqlite'
    //   - '../storage/sqlite'
    //   - '../../storage/sqlite'
    //   - etc.
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
