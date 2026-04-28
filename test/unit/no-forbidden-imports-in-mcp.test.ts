/**
 * Lint-style guard test.
 *
 * Asserts that no source file under the MCP module directory (`src/mcp/`)
 * imports from `src/collector/`, `src/shim/`, or `src/installer/`.
 *
 * The design document (§ Module Dependency Graph) states:
 *
 * | Module    | May import from                              | Must NOT import from                          |
 * |-----------|----------------------------------------------|-----------------------------------------------|
 * | src/mcp/  | src/types/ (import type), node:, SDK, ulidx  | src/collector/, src/shim/, src/installer/      |
 *
 * A direct import from `collector/`, `shim/`, or `installer/` in any MCP
 * module file is a modularity violation — coupling the MCP server to
 * implementation details it must not depend on.
 *
 * Validates: Requirements 10.1–10.5, N12
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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

describe('mcp module — no forbidden imports', () => {
  const MCP_DIR = fileURLToPath(
    new URL('../../src/mcp', import.meta.url),
  );

  it('src/mcp/ does not import from src/collector/', () => {
    /**
     * **Validates: Requirements 10.1, 10.5, Design § Module Dependency Graph**
     *
     * The MCP server is a standalone HTTP client of the collector. It shares
     * types but has no code-level dependency on the collector. A direct
     * import from `collector/` in any MCP module file is a modularity
     * violation.
     */
    const files = collectTsFiles(MCP_DIR);

    // Sanity: ensure we actually walked some files.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    const collectorPattern = /collector\//;

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (collectorPattern.test(line)) {
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
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from collector/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('src/mcp/ does not import from src/shim/', () => {
    /**
     * **Validates: Requirements 10.2, 10.5, Design § Module Dependency Graph**
     *
     * The MCP server deliberately duplicates small amounts of logic
     * (config loading, namespace derivation) rather than importing from
     * `src/shim/`. A direct import from `shim/` in any MCP module file
     * is a modularity violation.
     */
    const files = collectTsFiles(MCP_DIR);

    // Sanity: ensure we actually walked some files.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    const shimPattern = /shim\//;

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (shimPattern.test(line)) {
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
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from shim/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('src/mcp/ does not import from src/installer/', () => {
    /**
     * **Validates: Requirements 10.3, 10.5, Design § Module Dependency Graph**
     *
     * The MCP server has no dependency on the installer module. A direct
     * import from `installer/` in any MCP module file is a modularity
     * violation.
     */
    const files = collectTsFiles(MCP_DIR);

    // Sanity: ensure we actually walked some files.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    const installerPattern = /installer\//;

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (installerPattern.test(line)) {
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
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from installer/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});
