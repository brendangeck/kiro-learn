/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/shim/` or `src/mcp/` imports
 * from `src/collector/embedding/` or `src/collector/backfill/`.
 *
 * The shim (CLI + IDE hook bridges) is a standalone HTTP client of the
 * collector, and the MCP server is a standalone stdio agent that talks
 * to the collector over HTTP. Both share types via `src/types/` but
 * have no code-level dependency on the collector internals. The
 * embedding and backfill modules are collector internals: they own the
 * ONNX model lifecycle, the BLOB codec, the vector cache, and the
 * async backfill loop. Loading them in a shim or MCP process would
 * violate the never-degrade-below-FTS5 guarantee (heavy model load on
 * every hook invocation) and invert the module dependency graph.
 *
 * The check recursively reads every `.ts` file under the guarded
 * directories, strips comments (so TSDoc descriptions of the boundary
 * remain allowed), and searches for import statements referencing
 * `collector/embedding` or `collector/backfill`.
 *
 * Validates: Requirement 13.3; Design § Components and Interfaces →
 * `src/collector/embedding/` and `src/collector/backfill/`; AGENTS.md
 * Modularity boundaries (shim / MCP are standalone).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Directories that must NOT import from collector/embedding or collector/backfill. */
const GUARDED_DIRS = [
  fileURLToPath(new URL('../../src/shim', import.meta.url)),
  fileURLToPath(new URL('../../src/mcp', import.meta.url)),
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

describe('shim and mcp modules — no embedding or backfill imports', () => {
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

  it('src/shim/ and src/mcp/ do not import from src/collector/embedding/', () => {
    /**
     * **Validates: Requirement 13.3; Design § Components and Interfaces**
     *
     * `src/collector/embedding/` owns the ONNX model lifecycle, the
     * BLOB codec, the cosine helpers, and the RRF fuser. None of
     * these belong in a shim or MCP process. Loading them would
     * pull in `@huggingface/transformers` and its ONNX runtime on
     * every shim invocation.
     */
    const offenders = scanForPattern(files, /collector\/embedding/);
    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from collector/embedding — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('src/shim/ and src/mcp/ do not import from src/collector/backfill/', () => {
    /**
     * **Validates: Requirement 13.3; Design § Components and Interfaces**
     *
     * `src/collector/backfill/` hosts the long-running backfill loop
     * that drives the embedder against records with NULL embeddings.
     * It is a collector-internal worker and must never execute inside
     * a shim or MCP process.
     */
    const offenders = scanForPattern(files, /collector\/backfill/);
    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from collector/backfill — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});
