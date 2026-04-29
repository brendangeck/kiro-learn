/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/shim/` imports from
 * `src/collector/buffer/`.
 *
 * The shim is a standalone HTTP client of the collector. It shares types
 * via `src/types/` but has no code-level dependency on any collector
 * internals, including the buffer module. A direct import from
 * `collector/buffer` inside any shim module would indicate a modularity
 * violation — coupling the shim to the collector's internal buffering
 * implementation.
 *
 * The check recursively reads every `.ts` file under the shim directories,
 * strips comments (so that prose describing the boundary is allowed), and
 * searches for import statements referencing `collector/buffer`.
 *
 * Validates: Requirement 17.3
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Shim directories that must NOT import from collector/buffer/. */
const SHIM_DIRS = [
  fileURLToPath(new URL('../../src/shim/shared', import.meta.url)),
  fileURLToPath(new URL('../../src/shim/cli-agent', import.meta.url)),
  fileURLToPath(new URL('../../src/shim/ide-hook', import.meta.url)),
];

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

describe('shim modules — no buffer imports', () => {
  it('does not import from collector/buffer/ in any shim module', () => {
    /**
     * **Validates: Requirement 17.3**
     *
     * The shim is a standalone HTTP client of the collector. It shares
     * types but has no code-level dependency on the collector's internal
     * buffer module. A direct import from `collector/buffer` in any shim
     * module is a modularity violation.
     */
    const files: string[] = [];
    for (const dir of SHIM_DIRS) {
      files.push(...collectTsFiles(dir));
    }

    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the shim directories) would otherwise
    // produce a silently-passing vacuous test.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    // Match import statements that reference collector/buffer in any form:
    //   - 'collector/buffer'
    //   - '../collector/buffer'
    //   - '../../collector/buffer'
    //   - etc.
    const bufferImportPattern = /collector\/buffer/;

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (bufferImportPattern.test(line)) {
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
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from collector/buffer/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});
