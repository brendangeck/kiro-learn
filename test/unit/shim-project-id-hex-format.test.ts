/**
 * Example test for `project_id` hex format.
 *
 * Validates that `buildEvent` derives `project_id` as the lowercase hex
 * SHA-256 of `realpathSync(projectRoot)` — the resolved path of the
 * nearest ancestor directory containing a project marker.
 *
 * **Validates: Requirement 4.1**
 *
 * @see .kiro/specs/project-path-capture/tasks.md § Task 4.2
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpBase,
  };
});

const { buildEvent } = await import('../../src/shim/shared/index.js');

/**
 * Parse the `project_id` segment out of a namespace of shape
 * `/actor/<actor_id>/project/<project_id>/`.
 */
function extractProjectId(namespace: string): string {
  const match = /^\/actor\/[^/]+\/project\/([^/]+)\/$/.exec(namespace);
  if (match === null) {
    throw new Error(`namespace did not match expected shape: ${namespace}`);
  }
  return match[1]!;
}

describe('buildEvent — project_id hex format', () => {
  let projectRoot: string;
  let resolvedProjectRoot: string;

  beforeAll(() => {
    // Mocked $HOME is a tmp dir so the walk ceiling sits at a known path.
    tmpBase = mkdtempSync(join(tmpdir(), 'kiro-learn-pid-hex-'));

    // Create a project directory under the mocked $HOME with a `.git`
    // marker so `detectProjectRoot` resolves here rather than continuing
    // up to the ceiling.
    projectRoot = mkdtempSync(join(tmpBase, 'proj-'));
    mkdirSync(join(projectRoot, '.git'));

    // `detectProjectRoot` resolves symlinks via `realpathSync`, so the
    // hash preimage is the resolved path — which on macOS differs from
    // the raw tmp path (e.g. `/var/folders/...` vs `/private/var/...`).
    resolvedProjectRoot = realpathSync(projectRoot);
  });

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('project_id equals lowercase hex SHA-256 of realpath(projectRoot)', () => {
    /**
     * **Validates: Requirement 4.1**
     *
     * When `cwd` resolves to a directory containing a project marker,
     * `project_id` MUST be the lowercase hex SHA-256 digest of the
     * resolved project root path, and MUST be exactly 64 hex chars.
     */
    const event = buildEvent({
      kind: 'note',
      body: { type: 'text', content: 'hello' },
      sessionId: 'test-session',
      cwd: projectRoot,
    });

    const projectId = extractProjectId(event.namespace);

    const expected = createHash('sha256')
      .update(resolvedProjectRoot)
      .digest('hex');

    expect(projectId).toBe(expected);
    expect(projectId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('project_id is identical when cwd is a subdirectory of the project root', () => {
    /**
     * **Validates: Requirement 4.1**
     *
     * Derived-consequence check: the walk resolves any subdirectory of
     * the marked project to the same project root, so the hex digest
     * MUST match whether `cwd` is the root or a child.
     */
    const subdir = join(projectRoot, 'src');
    mkdirSync(subdir, { recursive: true });

    const event = buildEvent({
      kind: 'note',
      body: { type: 'text', content: 'hello' },
      sessionId: 'test-session',
      cwd: subdir,
    });

    const projectId = extractProjectId(event.namespace);

    const expected = createHash('sha256')
      .update(resolvedProjectRoot)
      .digest('hex');

    expect(projectId).toBe(expected);
  });
});
