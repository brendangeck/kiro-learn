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

    // Patterns that detect ui/ references in any import/export form:
    //
    // 1. Static import/export with `from`:
    //    import { foo } from 'ui/bar'
    //    export { foo } from '../ui/bar'
    //    import type { X } from '../../ui/bar'
    //    (handles multiline: import {\n  foo\n} from 'ui/bar')
    //
    // 2. Side-effect (bare) imports:
    //    import 'ui/styles.css'
    //    import '../ui/global.css'
    //
    // 3. Dynamic imports:
    //    import('ui/foo')
    //    import('../ui/foo')
    //    (handles whitespace: import  ( 'ui/foo' ))
    //
    // 4. require() calls:
    //    require('ui/foo')
    //    require('../ui/foo')
    const patterns: RegExp[] = [
      // Static import/export ... from '...ui/...'
      /(?:import|export)\s[\s\S]*?from\s+['"][^'"]*ui\/[^'"]*['"]/g,
      // Side-effect import: import '...ui/...' (no `from`, no braces/identifiers before the string)
      /import\s+['"][^'"]*ui\/[^'"]*['"]/g,
      // Dynamic import: import('...ui/...')
      /import\s*\(\s*['"][^'"]*ui\/[^'"]*['"]\s*\)/g,
      // require('...ui/...')
      /require\s*\(\s*['"][^'"]*ui\/[^'"]*['"]\s*\)/g,
    ];

    for (const file of files) {
      const raw = readFileSync(file, 'utf8');
      const stripped = stripComments(raw);

      const seen = new Set<string>(); // deduplicate overlapping matches

      for (const pattern of patterns) {
        // Reset lastIndex for each file since we reuse the regex objects
        pattern.lastIndex = 0;
        for (const match of stripped.matchAll(pattern)) {
          const matchStart = match.index ?? 0;
          const lineNum = stripped.slice(0, matchStart).split('\n').length;
          const key = `${file}:${lineNum}`;
          if (!seen.has(key)) {
            seen.add(key);
            offenders.push({
              file,
              line: lineNum,
              text: match[0].replace(/\s+/g, ' ').trim(),
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
