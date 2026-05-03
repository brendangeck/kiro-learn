/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/collector/embedding/` or
 * `src/collector/backfill/` imports from `src/shim/`, `src/installer/`,
 * or `src/mcp/`.
 *
 * The design document (§ Components and Interfaces → `src/collector/embedding/`
 * and `src/collector/backfill/`) states that the embedding and backfill
 * modules live inside the collector and know nothing about the shim
 * layer (CLI/IDE hook bridges), the installer (user-facing bootstrap
 * CLI), or the MCP server (standalone stdio agent). Allowed imports
 * are `src/types/` (via the `StorageBackend` interface), sibling files
 * inside the same module, and `node:*` / vetted third-party packages.
 *
 * A direct import from `src/shim/`, `src/installer/`, or `src/mcp/` in
 * any embedding or backfill file would invert the dependency graph
 * established in `AGENTS.md` (Modularity boundaries) and the design's
 * module dependency table.
 *
 * The check recursively reads every `.ts` file under the two guarded
 * directories, strips comments (so TSDoc descriptions of the boundary
 * remain allowed), and searches for import statements referencing
 * `shim/`, `installer/`, or `mcp/`.
 *
 * Validates: Requirement 13.3; Design § Components and Interfaces →
 * `src/collector/embedding/` and `src/collector/backfill/`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Directories that must NOT import from shim/, installer/, or mcp/. */
const GUARDED_DIRS = [
  fileURLToPath(new URL('../../src/collector/embedding', import.meta.url)),
  fileURLToPath(new URL('../../src/collector/backfill', import.meta.url)),
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

/** Scan the guarded files for any line matching `pattern`. */
function scanForPattern(
  files: readonly string[],
  pattern: RegExp,
): Array<{ file: string; line: number; text: string }> {
  const offenders: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    const stripped = stripComments(readFileSync(file, 'utf8'));
    const lines = stripped.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (pattern.test(line)) {
        offenders.push({
          file,
          line: i + 1,
          text: line.trim(),
        });
      }
    }
  }
  return offenders;
}

describe('embedding and backfill modules — no shim/installer/mcp imports', () => {
  const files: string[] = [];
  for (const dir of GUARDED_DIRS) {
    files.push(...collectTsFiles(dir));
  }

  it('walked source files under both guarded directories', () => {
    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the directories) would otherwise
    // produce silently-passing vacuous tests below.
    expect(files.length).toBeGreaterThan(0);
  });

  it('src/collector/embedding/ and src/collector/backfill/ do not import from src/shim/', () => {
    /**
     * **Validates: Requirement 13.3; Design § Components and Interfaces**
     *
     * The shim layer (CLI + IDE hook bridges) is a downstream HTTP
     * client of the collector. Importing from `shim/` inside the
     * embedding or backfill modules inverts the dependency graph.
     */
    const offenders = scanForPattern(files, /shim\//);
    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from shim/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('src/collector/embedding/ and src/collector/backfill/ do not import from src/installer/', () => {
    /**
     * **Validates: Requirement 13.3; Design § Components and Interfaces**
     *
     * The installer is a user-facing bootstrap CLI. The embedding and
     * backfill modules have no runtime dependency on installation
     * concerns; importing from `installer/` is a modularity violation.
     */
    const offenders = scanForPattern(files, /installer\//);
    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from installer/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('src/collector/embedding/ and src/collector/backfill/ do not import from src/mcp/', () => {
    /**
     * **Validates: Requirement 13.3; Design § Components and Interfaces**
     *
     * The MCP server is a standalone stdio agent that talks to the
     * collector over HTTP. Importing from `mcp/` inside the embedding
     * or backfill modules inverts the dependency graph.
     */
    const offenders = scanForPattern(files, /\bmcp\//);
    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from mcp/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});
