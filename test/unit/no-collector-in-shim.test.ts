/**
 * Lint-style guard test.
 *
 * Asserts that no source file under the shim module directories
 * (`src/shim/shared/`, `src/shim/cli-agent/`, `src/shim/ide-hook/`) imports from
 * `src/collector/` or `src/installer/`.
 *
 * Additionally asserts that `src/shim/shared/` does not import from
 * `src/shim/cli-agent/` — the dependency direction is
 * cli-agent → shared, never the reverse.
 *
 * The design document (§ Module Structure) states:
 *
 * | Module               | May import from                  | Must NOT import from                                    |
 * |----------------------|----------------------------------|---------------------------------------------------------|
 * | src/shim/cli-agent/  | src/shim/shared/, src/types/     | src/collector/, src/installer/                           |
 * | src/shim/shared/     | src/types/                       | src/collector/, src/installer/, src/shim/cli-agent/      |
 *
 * A direct import from `collector/` or `installer/` in any shim module,
 * or from `shim/cli-agent` inside the shared module, is a modularity
 * violation — coupling the shim to implementation details it must not
 * depend on.
 *
 * Validates: Requirements 11.3, 11.4, Design § Module Structure
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

describe('shim modules — no collector/installer imports', () => {
  /** Directories that must NOT import from collector/ or installer/. */
  const COLLECTOR_INSTALLER_GUARDED_DIRS = [
    fileURLToPath(new URL('../../src/shim/shared', import.meta.url)),
    fileURLToPath(new URL('../../src/shim/cli-agent', import.meta.url)),
    fileURLToPath(new URL('../../src/shim/ide-hook', import.meta.url)),
  ];

  it('does not import from collector/ or installer/ in any shim module', () => {
    /**
     * **Validates: Requirements 11.4, Design § Module Structure**
     *
     * The shim is a standalone HTTP client of the collector. It shares
     * types but has no code-level dependency on the collector or
     * installer. A direct import from `collector/` or `installer/` in
     * any shim module is a modularity violation.
     */
    const files: string[] = [];
    for (const dir of COLLECTOR_INSTALLER_GUARDED_DIRS) {
      files.push(...collectTsFiles(dir));
    }

    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the directories) would otherwise
    // produce a silently-passing vacuous test.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    // Match import statements that reference collector/ or installer/ in any form:
    //   - 'collector/'
    //   - '../collector/'
    //   - '../../collector/'
    //   - etc.
    const collectorPattern = /collector\//;
    const installerPattern = /installer\//;

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
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from collector/ or installer/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('does not import from shim/cli-agent/ in the shared module', () => {
    /**
     * **Validates: Requirements 11.3, Design § Module Structure**
     *
     * The dependency direction is cli-agent → shared, never the reverse.
     * `src/shim/shared/` must not import from `src/shim/cli-agent/`.
     */
    const sharedDir = fileURLToPath(
      new URL('../../src/shim/shared', import.meta.url),
    );
    const files = collectTsFiles(sharedDir);

    // Sanity: ensure we actually walked some files.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    // Match import statements that reference shim/cli-agent in any form:
    //   - 'shim/cli-agent'
    //   - '../cli-agent'
    //   - './cli-agent'
    //   - etc.
    const cliAgentPattern = /shim\/cli-agent|['"]\.\.\/cli-agent|['"]\.\/cli-agent/;

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (cliAgentPattern.test(line)) {
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
        ? `Dependency direction violation: ${offenders.map((o) => `${o.file}:${o.line} imports from shim/cli-agent/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});
