/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/collector/ingestion/` mentions
 * the token `<private>` anywhere — in code, comments, or string
 * literals.
 *
 * The privacy-scrub boundary contract states that scrubbing of
 * `<private>…</private>` spans is the collector-pipeline's responsibility,
 * not the ingestion module's. Ingestion receives already-scrubbed buffer
 * entries (scrubbing happened upstream in the pipeline before events were
 * written to the per-project buffer). A reference to `<private>` anywhere
 * under the ingestion tree would indicate drift — someone trying to push
 * scrubbing into the wrong layer, or leaking the scrub token into a
 * prompt / log / identifier.
 *
 * Unlike the sqlite-import guard, this check is *not* comment-stripped:
 * the scrub token must not appear in prose either, because describing
 * it in an ingestion-module comment suggests the module has business
 * with scrubbing at all. Prose belongs in `docs/concepts/privacy.mdx`
 * or in pipeline-layer comments where the scrub actually lives.
 *
 * Validates: Requirement 17.2 (privacy-scrub ownership)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Ingestion module root, resolved relative to this test file. */
const INGESTION_ROOT = fileURLToPath(
  new URL('../../src/collector/ingestion', import.meta.url),
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

describe('ingestion module — privacy-scrub boundary', () => {
  it('does not reference "<private>" anywhere under src/collector/ingestion/', () => {
    /**
     * **Validates: Requirement 17.2**
     *
     * The ingestion module receives already-scrubbed buffer entries.
     * Privacy-scrub logic for `<private>…</private>` spans lives in the
     * collector-pipeline, not in ingestion. Any reference to the
     * `<private>` token inside ingestion code — in string literals, regex
     * patterns, identifiers, or even comments — indicates drift. A
     * comment that mentions `<private>` is a signal that the module is
     * taking on scrubbing concerns it shouldn't have.
     */
    const files = collectTsFiles(INGESTION_ROOT);

    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the ingestion tree) would otherwise
    // produce a silently-passing vacuous test.
    expect(files.length).toBeGreaterThan(0);

    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
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
      `found <private> references under ingestion tree: ${JSON.stringify(offenders, null, 2)}`,
    ).toEqual([]);
  });
});
