/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/collector/buffer/` imports from
 * `src/collector/storage/sqlite/`.
 *
 * The design document (§ Modularity boundary) states that the buffer module
 * receives `StorageBackend` via dependency injection. Only the top-level
 * daemon wiring (`src/collector/index.ts`) may import from the concrete
 * SQLite backend. A direct import from `storage/sqlite/` inside the buffer
 * tree would indicate a modularity violation — coupling the buffer to a
 * specific storage implementation.
 *
 * The check recursively reads every `.ts` file under the buffer directory,
 * strips comments (so that prose describing the boundary is allowed), and
 * searches for import statements referencing `storage/sqlite`.
 *
 * Validates: Requirement 17.1
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Buffer module root, resolved relative to this test file. */
const BUFFER_ROOT = fileURLToPath(
  new URL('../../src/collector/buffer', import.meta.url),
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

describe('buffer module — no direct SQLite imports', () => {
  it('does not import from storage/sqlite/ in src/collector/buffer/', () => {
    /**
     * **Validates: Requirement 17.1**
     *
     * The buffer module receives `StorageBackend` via dependency
     * injection. Only `src/collector/index.ts` (the daemon wiring) may
     * import from `src/collector/storage/sqlite/`. A direct import from
     * `storage/sqlite` in any buffer module file is a modularity
     * violation.
     */
    const files = collectTsFiles(BUFFER_ROOT);

    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the buffer tree) would otherwise
    // produce a silently-passing vacuous test.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    // Match import statements that reference storage/sqlite in any form:
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
