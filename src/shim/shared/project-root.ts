/**
 * Project-root detection for the shim's `buildEvent` path.
 *
 * Given a working directory, {@link detectProjectRoot} walks upward
 * looking for one of the markers in {@link PROJECT_MARKERS}, stopping
 * at the resolved `$HOME` as a ceiling. The result is the preimage for
 * the `project_id` namespace segment on every emitted event, and is
 * also surfaced verbatim on `source.project_path`.
 *
 * ## Deliberate duplication with the installer
 *
 * {@link PROJECT_MARKERS} is a byte-for-byte copy of the installer's
 * `PROJECT_MARKERS` in `src/installer/index.ts`. The two lists MUST stay
 * in lock-step.
 *
 * Requirement N9 forbids the shim from importing anything under
 * `src/installer/` (the existing `no-shim-in-installer` modularity guard
 * test enforces this, and the sibling `no-collector-in-shim` guard
 * enforces the inverse). The installer's `PROJECT_MARKERS` is on the
 * wrong side of that boundary, so reusing it by import is not an option.
 *
 * Alternatives were considered and rejected in the design doc:
 *
 * - Moving the constant to a shared utility module would pull in the
 *   installer's `detectScope` walk alongside it and prematurely shape a
 *   new public surface area while we're still learning whether the two
 *   walks need to stay identical long-term.
 * - Reading the list from a config file at runtime is over-engineered
 *   for v0.
 *
 * Duplicating the literal has a one-release review cost and zero runtime
 * cost. A future refactor spec can extract both the list and the walk
 * shape into a shared utility; Non-functional Requirement N9
 * acknowledges this explicitly. For now: any PR touching
 * `PROJECT_MARKERS` in one file MUST touch it in the other. Parity is
 * enforced at the test layer by
 * `test/unit/shim-project-markers-match-installer.test.ts`.
 *
 * ## `projectRoot` vs. `projectPath`
 *
 * {@link ProjectRootResult} exposes both `projectRoot` and `projectPath`
 * fields. **They are always equal by contract** — see Requirement 6.1.
 * The two names exist because downstream code refers to the same value
 * by different names: the hash input for `project_id` is conventionally
 * called the project root, while the wire field emitted on
 * `source.project_path` is conventionally called the project path. The
 * duplication is a naming convenience for readers, not a modelling
 * distinction.
 *
 * @see Requirements 1.4, N9
 * @see src/installer/index.ts — `PROJECT_MARKERS` (must stay in sync)
 */

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';

/**
 * Project markers used by `detectProjectRoot` to identify a project
 * root. Checked in order at each directory during the upward walk; the
 * first match at the nearest directory wins.
 *
 * Byte-for-byte identical to the installer's `PROJECT_MARKERS` in
 * `src/installer/index.ts`. See the module-level TSDoc above for the
 * rationale behind the duplication.
 *
 * @see Requirements 1.4, N9
 */
export const PROJECT_MARKERS: readonly string[] = [
  '.kiro',
  '.git',
  'package.json',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'deno.json',
  'deno.jsonc',
] as const;

/**
 * Result of a project-root detection pass.
 *
 * `projectRoot` and `projectPath` always hold the same string value; the
 * two fields exist for naming clarity at the call site (hash input vs.
 * emitted wire field). See the module-level TSDoc for details.
 *
 * @see Requirements 1.1, 1.2, 4.1, 6.1
 */
export interface ProjectRootResult {
  /** Resolved absolute path used as the hash input for `project_id`. */
  projectRoot: string;
  /** Value emitted on `source.project_path`. Always === `projectRoot`. */
  projectPath: string;
  /** True iff this is a global sentinel event (no marker found). */
  isGlobal: boolean;
}

/**
 * Detect the project root by walking upward from `cwd`.
 *
 * Resolves both `cwd` and `$HOME` via {@link realpathSync} to normalise
 * symlinks, then walks from the resolved cwd up toward the resolved
 * `$HOME` (the Walk_Ceiling, never inspected). At each directory, the
 * fifteen entries in {@link PROJECT_MARKERS} are checked in order; the
 * nearest directory containing any marker wins and is returned as the
 * project root.
 *
 * When no marker is found before the walk reaches the ceiling — or
 * when `cwd` is at or outside the ceiling to begin with — the result
 * is the global sentinel: both `projectRoot` and `projectPath` are the
 * ceiling itself, and `isGlobal` is `true`. This collapses every
 * non-project event from one user into one namespace per user.
 *
 * ### Failure handling
 *
 * The function never throws. Four failure modes are handled with
 * distinct fallbacks:
 *
 * 1. `realpathSync(cwd)` throws → log `[kiro-learn] cwd realpath failed`
 *    once to stderr and return `{ projectRoot: cwd, projectPath: cwd,
 *    isGlobal: false }` (the raw cwd becomes the hash input).
 * 2. `realpathSync(homedir())` throws → log
 *    `[kiro-learn] homedir/realpath failed` once to stderr and continue
 *    with the unresolved `homedir()` value as the ceiling.
 * 3. A per-marker `existsSync` throws mid-walk → treat the marker as
 *    absent, continue silently (no stderr output). Permission-denied on
 *    ancestor directories is an expected outcome, not an error.
 * 4. Anything else thrown by the walk body → log
 *    `[kiro-learn] walk error` once to stderr and fall back to hashing
 *    the resolved cwd (today's behaviour before this spec).
 *
 * Warning messages never include the path value itself (Requirement N6).
 *
 * @see Requirements 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1,
 *   3.2, 3.3, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, N6
 */
export function detectProjectRoot(cwd: string): ProjectRootResult {
  // ── Phase 1a: resolve Walk_Ceiling ($HOME) ────────────────────────
  // Requirement 7.2 — on throw, fall back to the unresolved homedir()
  // and log once.
  let ceiling: string;
  try {
    ceiling = realpathSync(homedir());
  } catch {
    process.stderr.write('[kiro-learn] homedir/realpath failed\n');
    ceiling = homedir();
  }

  // ── Phase 1b: resolve cwd ─────────────────────────────────────────
  // Requirement 7.1 — on throw, log once and return the raw cwd as
  // both hash input and emitted path, with isGlobal=false (we can't
  // tell whether the unresolved path is under $HOME).
  let resolvedCwd: string;
  try {
    resolvedCwd = realpathSync(cwd);
  } catch {
    process.stderr.write('[kiro-learn] cwd realpath failed\n');
    return { projectRoot: cwd, projectPath: cwd, isGlobal: false };
  }

  // ── Phase 2: ceiling cases → global sentinel ──────────────────────
  // Requirement 2.4 — cwd === ceiling skips the walk entirely.
  // Requirement 2.5 — cwd outside the ceiling also skips the walk.
  if (resolvedCwd === ceiling || !isUnder(resolvedCwd, ceiling)) {
    return { projectRoot: ceiling, projectPath: ceiling, isGlobal: true };
  }

  // ── Phase 3: upward walk ──────────────────────────────────────────
  // Wrap the entire walk body in a defensive try/catch per Requirement
  // 7.4: on unexpected throw, fall back to hashing the resolved cwd.
  try {
    let current = resolvedCwd;
    // Requirement 2.2/2.3 — never inspect the ceiling itself.
    // dirname(current) === current happens at filesystem roots ('/'
    // on POSIX, 'C:\\' on Windows) — bail before infinite-looping.
    while (current !== ceiling && current !== dirname(current)) {
      for (const marker of PROJECT_MARKERS) {
        // Requirement 7.3 — per-marker existsSync errors are silent;
        // treat as "marker absent" and continue.
        let found = false;
        try {
          found = existsSync(join(current, marker));
        } catch {
          found = false;
        }
        if (found) {
          // Requirement 1.3, 1.5 — nearest directory wins, regardless
          // of which marker matched.
          return { projectRoot: current, projectPath: current, isGlobal: false };
        }
      }
      current = dirname(current);
    }
  } catch {
    // Requirement 7.4 — unexpected walk-body error. Fall back to
    // today's behaviour (hash the resolved cwd) and log once.
    process.stderr.write('[kiro-learn] walk error\n');
    return { projectRoot: resolvedCwd, projectPath: resolvedCwd, isGlobal: false };
  }

  // ── Phase 4: walk completed, no marker found → global sentinel ────
  // Requirement 3.1, 3.2, 3.3.
  return { projectRoot: ceiling, projectPath: ceiling, isGlobal: true };
}

/**
 * Return `true` iff `path` is equal to `parent` or is a descendant of
 * `parent`. Uses the platform path separator to avoid false positives
 * on sibling directories that share a prefix (e.g. `/home/alice2`
 * should NOT be considered under `/home/alice`).
 *
 * Normalises trailing separators on `parent` before comparing, so
 * `isUnder('/foo/bar', '/foo/')` still works. The filesystem root
 * (`/` on POSIX, `C:\` on Windows) is special-cased: stripping its
 * trailing separator would leave an empty string, and appending the
 * separator back to the unstripped form would produce a doubled
 * separator (`'//'`) that no real path starts with. For the root we
 * therefore short-circuit on `path.startsWith(sep)` instead.
 */
function isUnder(path: string, parent: string): boolean {
  if (path === parent) return true;
  // Filesystem root: any absolute path is under it.
  if (parent === sep) return path.startsWith(sep);
  // Strip a single trailing separator from non-root parent so
  // `parent + sep` is a clean prefix probe (no double-separators).
  const normalisedParent = parent.endsWith(sep) ? parent.slice(0, -1) : parent;
  return path.startsWith(normalisedParent + sep);
}
