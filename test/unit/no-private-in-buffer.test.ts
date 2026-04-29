/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/collector/buffer/` mentions the
 * token `<private>`. The privacy-scrub boundary contract states that
 * scrubbing of `<private>…</private>` spans is the collector-pipeline's
 * responsibility, not the buffer module's. Events reaching the buffer have
 * already been scrubbed by the pipeline. A reference to `<private>` inside
 * the buffer tree would indicate drift — someone trying to push scrubbing
 * into the wrong layer.
 *
 * The check recursively reads every `.ts` file under the buffer tree,
 * strips comments (so that prose describing the contract is allowed), and
 * searches for the `<private>` token in executable code.
 *
 * Validates: Requirement 17.2
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
 * code. The requirement (17.2) forbids scrubbing *logic* in the buffer
 * layer, not documentation that explains the contract. TSDoc and line
 * comments that describe the pipeline's scrub boundary are explicitly
 * allowed.
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

describe('buffer module — privacy-scrub boundary', () => {
  it('does not reference "<private>" in executable code under src/collector/buffer/', () => {
    /**
     * **Validates: Requirement 17.2**
     *
     * The buffer module receives already-scrubbed events from the
     * pipeline. Privacy-scrub logic for `<private>…</private>` spans
     * lives in the collector-pipeline, not in the buffer. Any reference
     * to the `<private>` token inside executable buffer code (string
     * literals, regex patterns, identifiers) indicates drift — someone
     * is pushing scrubbing into the wrong layer. TSDoc and line comments
     * that *describe* the contract are explicitly allowed; the stripper
     * removes them before the scan.
     */
    const files = collectTsFiles(BUFFER_ROOT);

    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the buffer tree) would otherwise
    // produce a silently-passing vacuous test.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const stripped = stripComments(readFileSync(file, 'utf8'));
      const lines = stripped.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]!.includes('<private>')) {
          offenders.push({
            file,
            line: i + 1,
            text: lines[i]!.trim(),
          });
        }
      }
    }

    expect(
      offenders,
      `found <private> references in executable buffer code: ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });
});
