/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `ui/src/` imports from `src/` or
 * `../../src/`. The UI communicates with the backend exclusively via
 * HTTP (`fetch`). A direct import from `src/` in any UI module is a
 * modularity violation — coupling browser-targeted code to the
 * Node.js backend.
 *
 * Validates: Requirements 14.2, N11
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Recursively collect every `.ts` and `.tsx` file under `dir`. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (
      stat.isFile() &&
      (entry.endsWith('.ts') || entry.endsWith('.tsx'))
    ) {
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

describe('ui/src/ modules — no src/ imports', () => {
  const uiSrcDir = fileURLToPath(new URL('../../ui/src', import.meta.url));

  it('does not import from src/ in any ui/src/ module', () => {
    /**
     * **Validates: Requirements 14.2, N11**
     *
     * The UI (`ui/src/`) communicates with the backend exclusively
     * via HTTP. It must not import from the Node.js backend (`src/`).
     * A direct import from `src/` in any UI module is a modularity
     * violation — coupling browser-targeted code to Node.js modules.
     */
    const files = collectTsFiles(uiSrcDir);

    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the directory) would otherwise produce
    // a silently-passing vacuous test.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    // Match import specifiers that reference src/ in any form:
    //   - 'src/'
    //   - '../../src/'
    //   - '../../../src/'
    //   - etc.
    const srcPattern = /src\//;

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Only check lines that look like import/export statements
        // to avoid false positives from string literals or comments.
        if (
          (line.includes('import') || line.includes('export')) &&
          (line.includes("'") || line.includes('"')) &&
          srcPattern.test(line)
        ) {
          // Exclude imports that reference './src/' relative to ui/
          // (e.g. './types/health.js' which is inside ui/src/ itself).
          // We only flag imports that escape ui/src/ to reach the
          // backend's src/ directory. The pattern '../../src/' is the
          // canonical escape path from ui/src/ to the root src/.
          // Also flag bare 'src/' which would be an absolute-style
          // reference to the backend.
          //
          // However, we must NOT flag relative imports within ui/src/
          // like './types/health.js' — the 'src/' match there is a
          // false positive from the line containing 'import' and the
          // file path containing 'src/'. So we check the actual import
          // specifier between quotes.
          const specifierMatch = line.match(/['"]([^'"]+)['"]/);
          if (specifierMatch) {
            const specifier = specifierMatch[1]!;
            // Flag if the specifier itself references the backend src/
            if (
              specifier.includes('../../src/') ||
              specifier.startsWith('src/')
            ) {
              offenders.push({
                file,
                line: i + 1,
                text: line.trim(),
              });
            }
          }
        }
      }
    }

    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from src/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});
