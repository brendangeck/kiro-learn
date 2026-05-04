/**
 * Lint-style guard test.
 *
 * Asserts that the three XML pipeline modules respect their import
 * direction relative to the ingestion module:
 *
 * | Module                                      | May import from                                     | Must NOT import from              |
 * |---------------------------------------------|-----------------------------------------------------|-----------------------------------|
 * | `src/collector/pipeline/acp-client.ts`      | `node:child_process`, `node:stream`, ACP SDK        | `src/collector/ingestion/`        |
 * | `src/collector/pipeline/xml-framer.ts`      | `src/types/`                                        | `src/collector/ingestion/`        |
 * | `src/collector/pipeline/xml-parser.ts`      | `src/types/`                                        | `src/collector/ingestion/`        |
 *
 * Rationale (design § Modularity boundary): ingestion imports from the
 * pipeline barrel (for `frameBatchXml`, `invokeBatchCompressor`, XML
 * escape helpers). The XML pipeline modules must stay leaves — they
 * cannot import back from ingestion without creating a cycle and
 * destroying the one-way dependency graph. If an XML module needs
 * anything from ingestion, the shared piece belongs in `src/types/` or a
 * new leaf module, not in the ingestion tree.
 *
 * Validates: Design § Modularity boundary (ingestion → pipeline, not the
 * reverse)
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
  let withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  withoutBlocks = withoutBlocks.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return withoutBlocks;
}

/**
 * Regex that matches the start of any TypeScript module specifier line:
 *
 *   - `import ...`                   (named/default/namespace/side-effect/dynamic)
 *   - `export ...`                   (including `export ... from ...`)
 *
 * A positive match just means "this line begins an import/export
 * statement"; it does not assert the statement is complete. Multi-line
 * imports are handled by {@link findOffenders} which keeps accumulating
 * lines after a start-match until the statement terminates.
 */
const IMPORT_START_RE = /^\s*(?:import|export)\b/;

/**
 * Regex that matches a complete single-line module-specifier statement.
 * Used as a fast path — if a single physical line is already a complete
 * import/export-from or side-effect import, we don't need to accumulate
 * further lines.
 *
 * Covers:
 *   - `import ... from '<path>'`     (named/default/namespace/type-only)
 *   - `import '<path>'`              (side-effect)
 *   - `import('<path>')`             (dynamic)
 *   - `export ... from '<path>'`     (re-exports)
 */
const IMPORT_LIKE_RE =
  /^\s*(?:import\s+(?:[^;'"]*\bfrom\s+)?|import\s*\(\s*|export\b[^;]*\bfrom\s+)['"]/;

/**
 * A module-specifier statement terminates on the first line that
 * contains an opening quote for the path. Once we see the quote, we
 * know the `from '...'` (or side-effect / dynamic) specifier is on
 * this line and the statement ends here. Accumulating any further
 * lines would over-capture the next statement.
 *
 * This heuristic is intentionally loose: we do not try to handle a
 * path that spans multiple lines (illegal in TypeScript) or a
 * template-literal specifier (not valid for static imports anyway).
 */
const SPECIFIER_TERMINATOR_RE = /['"]/;

/**
 * Scan a single file for import/export statements matching a forbidden
 * import pattern. Returns an array of offending statements (empty if
 * clean).
 *
 * A statement is an offender only when BOTH conditions hold:
 *   1. It is an `import` or `export` statement (single- or multi-line).
 *   2. Its full text matches the forbidden `pattern` (e.g.
 *      /collector\/ingestion\//).
 *
 * Multi-line imports are handled by accumulating lines starting with
 * `import` / `export` until the module specifier's closing quote is
 * reached, then matching the combined string. This catches regressions
 * like:
 *
 *     import {
 *       reconcile,
 *     } from '../ingestion/reconciler.js';
 *
 * that a per-line check would let through because no single line
 * contains both `import` AND `ingestion/`.
 *
 * The dual check (start-of-statement + pattern) also avoids false
 * positives when the forbidden substring appears inside a comment, a
 * variable name, a diagnostic message, or an inline regex literal in
 * unrelated code.
 */
function findOffenders(
  filePath: string,
  pattern: RegExp,
): Array<{ file: string; line: number; text: string }> {
  const stripped = stripComments(readFileSync(filePath, 'utf8'));
  const lines = stripped.split('\n');
  const offenders: Array<{ file: string; line: number; text: string }> = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Fast path: a complete single-line import/export whose specifier
    // is on the same line. We can match directly without accumulating.
    if (IMPORT_LIKE_RE.test(line)) {
      if (pattern.test(line)) {
        offenders.push({ file: filePath, line: i + 1, text: line.trim() });
      }
      i += 1;
      continue;
    }

    // Slow path: the line *starts* an import/export statement but the
    // module specifier is on a later line. Accumulate lines until we
    // encounter the opening quote of the specifier (which, for a
    // well-formed statement, is the single-line form's terminator too).
    if (IMPORT_START_RE.test(line)) {
      const startLine = i + 1;
      const buf: string[] = [line];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j]!;
        buf.push(next);
        if (SPECIFIER_TERMINATOR_RE.test(next)) {
          break;
        }
        j += 1;
      }
      const combined = buf.join(' ');
      if (pattern.test(combined)) {
        offenders.push({
          file: filePath,
          line: startLine,
          text: combined.trim(),
        });
      }
      i = j + 1;
      continue;
    }

    i += 1;
  }

  return offenders;
}

/**
 * Pattern matching any import specifier under the ingestion tree. Catches
 * relative paths like `../ingestion/…` or `./ingestion/…`, absolute-ish
 * paths like `src/collector/ingestion/…`, and barrel imports like
 * `../ingestion/index.js`.
 */
const INGESTION_IMPORT_RE = /(?:^|[/'"])ingestion\//;

describe('XML pipeline modules — no imports from ingestion/', () => {
  const ACP_CLIENT = fileURLToPath(
    new URL('../../src/collector/pipeline/acp-client.ts', import.meta.url),
  );
  const XML_FRAMER = fileURLToPath(
    new URL('../../src/collector/pipeline/xml-framer.ts', import.meta.url),
  );
  const XML_PARSER = fileURLToPath(
    new URL('../../src/collector/pipeline/xml-parser.ts', import.meta.url),
  );

  it('acp-client.ts does not import from collector/ingestion/', () => {
    /**
     * **Validates: Design § Modularity boundary**
     *
     * The ACP client is a transport leaf. Ingestion imports the ACP
     * client (for `createAcpSession`), not the other way round. An import
     * from `collector/ingestion/` would create a cycle and invert the
     * dependency graph.
     */
    const offenders = findOffenders(ACP_CLIENT, INGESTION_IMPORT_RE);

    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from ingestion/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('xml-framer.ts does not import from collector/ingestion/', () => {
    /**
     * **Validates: Design § Modularity boundary**
     *
     * The XML framer is a pure leaf — `src/types/` only. Ingestion
     * imports framing helpers from the pipeline barrel, not the other
     * way round.
     */
    const offenders = findOffenders(XML_FRAMER, INGESTION_IMPORT_RE);

    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from ingestion/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('xml-parser.ts does not import from collector/ingestion/', () => {
    /**
     * **Validates: Design § Modularity boundary**
     *
     * The XML parser is a pure leaf — `src/types/` only. Ingestion
     * imports parsing helpers from the pipeline barrel, not the other
     * way round.
     */
    const offenders = findOffenders(XML_PARSER, INGESTION_IMPORT_RE);

    expect(
      offenders,
      offenders.length > 0
        ? `Modularity violation: ${offenders.map((o) => `${o.file}:${o.line} imports from ingestion/ — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});

/**
 * Self-test for the ingestion-import regex. Documents which forms the
 * regex is expected to catch and which it should let through. If the
 * regex is loosened (false positives on prose lines mentioning the word
 * "ingestion") or tightened (misses side-effect or dynamic imports), one
 * of these cases fails.
 */
describe('INGESTION_IMPORT_RE — recognised vs ignored lines', () => {
  const tmpRoot = fileURLToPath(new URL('./', import.meta.url));

  function matches(line: string): boolean {
    // Write the line to a scratch file, run the offenders scan against
    // the ingestion-import pattern, and see whether the line was
    // flagged. A line that is recognised as import-like AND imports
    // from ingestion/ produces exactly one offender; an ignored line
    // produces zero.
    const scratch = `${tmpRoot}__ingestion-regex-scratch.ts`;
    writeFileSync(scratch, line + '\n', 'utf8');
    try {
      const offenders = findOffenders(scratch, INGESTION_IMPORT_RE);
      return offenders.length > 0;
    } finally {
      unlinkSync(scratch);
    }
  }

  it.each([
    ["import '../../src/collector/ingestion/reconciler.js';", true],
    ["import foo from '../ingestion/reconciler.js';", true],
    ["import { reconcile } from '../ingestion/reconciler.js';", true],
    ["import * as I from '../ingestion/index.js';", true],
    ["import type { CandidateMemory } from '../ingestion/candidate.js';", true],
    ["export { reconcile } from '../ingestion/reconciler.js';", true],
    ["export * from '../ingestion/index.js';", true],
    ["  import('../ingestion/reconciler.js');", true],
    ["const msg = 'ingestion/ reference in a string';", false],
    ["const importIngestion = 1;", false],
    [
      "throw new Error('cannot import from ingestion/ here');",
      false,
    ],
  ])('classifies %j → flagged=%s', (line, expected) => {
    expect(matches(line)).toBe(expected);
  });
});

/**
 * Multi-line import coverage. A `import { ... } from '...'` block that
 * wraps across several lines must still be recognised as an import
 * statement so the guard's per-statement check sees the module
 * specifier.
 */
describe('findOffenders — multi-line ingestion import coverage', () => {
  const tmpRoot = fileURLToPath(new URL('./', import.meta.url));

  function scanContent(source: string): Array<{ line: number; text: string }> {
    const scratch = `${tmpRoot}__ingestion-multiline-scratch.ts`;
    writeFileSync(scratch, source, 'utf8');
    try {
      return findOffenders(scratch, INGESTION_IMPORT_RE).map((o) => ({
        line: o.line,
        text: o.text,
      }));
    } finally {
      unlinkSync(scratch);
    }
  }

  it('flags a multi-line named import from ingestion/', () => {
    const src = [
      'import {',
      '  reconcile,',
      "} from '../ingestion/reconciler.js';",
      '',
    ].join('\n');

    const offenders = scanContent(src);
    expect(offenders).toHaveLength(1);
    // The reported line number is the statement's FIRST line, which
    // is the one starting with `import {`.
    expect(offenders[0]!.line).toBe(1);
    expect(offenders[0]!.text).toContain('ingestion/');
  });

  it('flags a multi-line re-export from ingestion/', () => {
    const src = [
      'export {',
      '  reconcile,',
      '  type ReconciliationContext,',
      "} from '../ingestion/reconciler.js';",
    ].join('\n');

    const offenders = scanContent(src);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]!.line).toBe(1);
  });

  it('does not flag a multi-line import from an allowed path', () => {
    const src = [
      'import {',
      '  KiroMemEvent,',
      '  MemoryRecord,',
      "} from '../../types/index.js';",
    ].join('\n');

    expect(scanContent(src)).toEqual([]);
  });

  it('handles adjacent multi-line imports independently', () => {
    const src = [
      'import {',
      '  frameEvent,',
      "} from './xml-framer.js';",
      'import {',
      '  reconcile,',
      "} from '../ingestion/reconciler.js';",
    ].join('\n');

    const offenders = scanContent(src);
    expect(offenders).toHaveLength(1);
    // The offender must be the second block (starting at line 4),
    // not the first — the first imports from a clean sibling.
    expect(offenders[0]!.line).toBe(4);
  });

  it('still handles a single-line import after a multi-line one', () => {
    const src = [
      'import {',
      '  foo,',
      "} from './clean.js';",
      "import bar from '../ingestion/reconciler.js';",
    ].join('\n');

    const offenders = scanContent(src);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]!.line).toBe(4);
  });
});
