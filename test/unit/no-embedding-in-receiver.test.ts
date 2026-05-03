/**
 * Lint-style guard test.
 *
 * Asserts that no source file under `src/collector/receiver/` invokes
 * `embedder.embed(...)` (or any `.embed(` method) and, as a
 * belt-and-suspenders check, that the receiver does not import from
 * `src/collector/embedding/`.
 *
 * The design document (Requirement 10.2; Design § Components and
 * Interfaces → `receiver`) states that embedding computation runs
 * exclusively on two code paths:
 *
 *   1. The async `ExtractionWorker` (after `putMemoryRecord`, in a
 *      background task on the buffer pipeline).
 *   2. The `QueryLayer` (embedding the query string for hybrid
 *      retrieval, strictly read-path).
 *
 * The HTTP receiver sits on the write hot path: every inbound event
 * must be acknowledged quickly, regardless of whether the embedder is
 * ready, degraded, or missing. Invoking `embedder.embed(...)` from the
 * receiver would block the ack behind ~20–50 ms of model work and
 * couple the shim's SLA to the embedder's degraded-mode state
 * machine — defeating the never-degrade-below-FTS5 guarantee.
 *
 * The check recursively reads every `.ts` file under
 * `src/collector/receiver/`, strips comments (so prose descriptions
 * of the boundary remain allowed), and searches for:
 *
 *   - `embedder.embed(` — the canonical direct call.
 *   - `.embed(` on any identifier — catches aliased holders such as
 *     `const e = deps.embedder; e.embed(...)`.
 *   - `collector/embedding` — the belt-and-suspenders import check.
 *
 * Validates: Requirement 10.2; Design § Components and Interfaces →
 * `receiver` write hot path.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Directory that must NOT invoke the embedder or import from the embedding module. */
const RECEIVER_DIR = fileURLToPath(
  new URL('../../src/collector/receiver', import.meta.url),
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
 * code. TSDoc and line comments that *describe* the boundary are
 * explicitly allowed; only executable call sites and imports are
 * violations.
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

describe('receiver module — no direct embedder invocation', () => {
  const files = collectTsFiles(RECEIVER_DIR);

  it('walked source files under src/collector/receiver/', () => {
    // Sanity: ensure we actually walked some files. A typo in the path
    // (or a move that relocates the receiver) would otherwise produce
    // silently-passing vacuous tests below.
    expect(files.length).toBeGreaterThan(0);
  });

  it('src/collector/receiver/ does not invoke `embedder.embed(...)`', () => {
    /**
     * **Validates: Requirement 10.2**
     *
     * The canonical direct-call pattern. The receiver must never invoke
     * `embedder.embed(...)` — embedding belongs to `ExtractionWorker`
     * (write path) and `QueryLayer` (read path) only.
     */
    const offenders = scanForPattern(files, /embedder\.embed\s*\(/);
    expect(
      offenders,
      offenders.length > 0
        ? `Receiver boundary violation: ${offenders.map((o) => `${o.file}:${o.line} calls embedder.embed — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('src/collector/receiver/ does not invoke any `.embed(` method', () => {
    /**
     * **Validates: Requirement 10.2**
     *
     * Broader than the canonical form above — catches aliased holders
     * such as `const e = deps.embedder; e.embed(...)` where the
     * identifier before `.embed(` is not literally `embedder`.
     */
    // `\.embed\s*\(` matches `foo.embed(`, `foo.embed (`, etc.
    // Rejects `.embedded`, `.embedAll`, `.embedder` (no `(` follows).
    const offenders = scanForPattern(files, /\.embed\s*\(/);
    expect(
      offenders,
      offenders.length > 0
        ? `Receiver boundary violation: ${offenders.map((o) => `${o.file}:${o.line} calls .embed(...) — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('src/collector/receiver/ does not import from src/collector/embedding/', () => {
    /**
     * **Validates: Requirement 10.2 (belt-and-suspenders)**
     *
     * Even if no `.embed(` call exists today, importing from the
     * embedding module signals that the receiver is pulling in the
     * embedder contract or BLOB codec — both out of scope for a
     * write-path HTTP handler. Catching this at the import level
     * prevents a future refactor from silently regressing the
     * never-degrade-below-FTS5 guarantee.
     */
    const offenders = scanForPattern(files, /collector\/embedding/);
    expect(
      offenders,
      offenders.length > 0
        ? `Receiver boundary violation: ${offenders.map((o) => `${o.file}:${o.line} imports from collector/embedding — "${o.text}"`).join('; ')}`
        : '',
    ).toEqual([]);
  });
});
