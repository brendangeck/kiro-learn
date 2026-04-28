/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/shim/shared/` imports from
 * `src/shim/ide-hook/`. The dependency direction is ide-hook → shared,
 * never the reverse.
 *
 * Validates: Requirements 12.3
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

/** Strip comments so the scan only sees executable code. */
function stripComments(source: string): string {
  let withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  withoutBlocks = withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return withoutBlocks;
}

describe('src/shim/shared/ — no ide-hook imports', () => {
  it('does not import from src/shim/ide-hook/', () => {
    const sharedDir = fileURLToPath(
      new URL('../../src/shim/shared', import.meta.url),
    );
    const files = collectTsFiles(sharedDir);

    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];

    const ideHookPattern = /ide-hook/;

    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (ideHookPattern.test(line)) {
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
        ? `Dependency direction violation: ${offenders.map((o) => `${o.file}:${o.line} imports from ide-hook/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});
