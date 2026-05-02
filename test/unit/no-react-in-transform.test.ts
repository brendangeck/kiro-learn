/**
 * Lint-style guard test.
 *
 * Asserts that `ui/src/graph/transform.ts` does not import from `react`,
 * `react-dom`, or `@cosmos.gl/graph`. The transform module is a pure,
 * environment-free function — its only job is to shape domain data into
 * Float32Array buffers and lookup maps. Importing React (DOM-targeted) or
 * `@cosmos.gl/graph` (WebGL engine) would couple the pure layer to the
 * rendering layer, making it un-testable in a node environment and
 * foreclosing a future renderer swap.
 *
 * Validates: Requirements 4.4, 17.4
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('ui/src/graph/transform.ts — no react or @cosmos.gl/graph imports', () => {
  const transformPath = fileURLToPath(
    new URL('../../ui/src/graph/transform.ts', import.meta.url),
  );

  it('ui/src/graph/transform.ts does not import react, react-dom, or @cosmos.gl/graph', () => {
    /**
     * **Validates: Requirements 4.4, 17.4**
     *
     * The Transform_Module must remain a pure function — no React, no
     * `react-dom`, and no `@cosmos.gl/graph`. This keeps the module
     * testable outside a browser and makes the rendering layer swappable.
     */
    const source = readFileSync(transformPath, 'utf8');

    // Match every import/export-from specifier:
    //   import ... from '...';
    //   import '...';
    //   import type ... from '...';
    //   export ... from '...';
    // Imports: the `from ... '...'` clause is optional so bare
    // `import '...';` still matches. Exports: we require the literal
    // `from` token so we don't false-positive on `export const x = '...'`
    // (which has a string literal but isn't a module specifier). The
    // actual specifier is captured in group 1.
    const specPattern =
      /(?:^|\n)\s*(?:import(?:\s[\s\S]*?)?\s*(?:from\s+)?|export\s[\s\S]*?\sfrom\s+)['"]([^'"]+)['"]/g;

    const forbidden = ['react', 'react-dom', '@cosmos.gl/graph'];

    const offenders: Array<{ line: number; specifier: string; text: string }> = [];

    for (const match of source.matchAll(specPattern)) {
      const specifier = match[1] ?? '';
      const hit = forbidden.find(
        (f) => specifier === f || specifier.startsWith(`${f}/`),
      );
      if (!hit) continue;

      const lineNum = source.slice(0, match.index ?? 0).split('\n').length;
      offenders.push({
        line: lineNum,
        specifier,
        text: match[0].replace(/\s+/g, ' ').trim(),
      });
    }

    expect(
      offenders,
      offenders.length > 0
        ? `Forbidden import in ui/src/graph/transform.ts: ${offenders
            .map((o) => `line ${o.line} imports "${o.specifier}" — ${o.text}`)
            .join('; ')}`
        : '',
    ).toEqual([]);
  });
});
