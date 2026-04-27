/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/` imports from `ui/` or
 * `../ui/`. The backend and frontend are independent compilation
 * units — `src/` targets Node.js, `ui/` targets the browser. A
 * direct import from `ui/` in any backend module is a modularity
 * violation.
 *
 * Validates: Requirements 14.1, N12
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
 */
function stripComments(source: string): string {
  let withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  withoutBlocks = withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return withoutBlocks;
}

describe('src/ modules — no ui/ imports', () => {
  const srcDir = fileURLToPath(new URL('../../src', import.meta.url));

  it('does not import from ui/ in any src/ module', () => {
    /**
     * **Validates: Requirements 14.1, N12**
     *
     * The backend (`src/`) has no compile-time dependency on the UI
     * (`ui/`). The daemon serves pre-built static files from disk at
     * runtime. A direct import from `ui/` in any backend module is a
     * modularity violation — coupling the Node.js backend to
     * browser-targeted code.
     */
    const files = collectTsFiles(srcDir);

    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the directory) would otherwise produce
    // a silently-passing vacuous test.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    // Match import specifiers that reference ui/ in any form:
    //   - 'ui/'
    //   - '../ui/'
    //   - '../../ui/'
    //   - etc.
    // Also handles multiline imports by joining the full file content
    // and scanning for import/export statements with ui/ specifiers.
    const uiPattern = /ui\//;
    const importExportPattern = /(?:import|export)\s[\s\S]*?from\s+['"][^'"]*ui\/[^'"]*['"]/g;

    for (const file of files) {
      const raw = readFileSync(file, 'utf8');
      const stripped = stripComments(raw);

      // Check for multiline import/export statements
      const multilineMatches = stripped.matchAll(importExportPattern);
      for (const match of multilineMatches) {
        const matchStart = match.index ?? 0;
        const lineNum = stripped.slice(0, matchStart).split('\n').length;
        offenders.push({
          file,
          line: lineNum,
          text: match[0].replace(/\s+/g, ' ').trim(),
        });
      }

      // Also check single-line patterns as a fallback
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (
          (line.includes('import') || line.includes('export')) &&
          (line.includes("'") || line.includes('"')) &&
          uiPattern.test(line)
        ) {
          // Avoid double-reporting if already caught by multiline scan
          const alreadyCaught = offenders.some((o) => o.file === file && o.line === i + 1);
          if (!alreadyCaught) {
            offenders.push({
              file,
              line: i + 1,
              text: line.trim(),
            });
          }
        }
      }
    }

    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from ui/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});
