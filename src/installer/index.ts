/**
 * Installer — the `kiro-learn` CLI (init, start, stop, status, uninstall).
 *
 * v1: single-machine, global install. Writes the CLI agent at
 * `~/.kiro/agents/kiro-learn.json`, deploys scripts, starts the daemon.
 *
 * @see Requirements 1–18, Non-functional N1–N12
 */

import { execFileSync, execSync, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

// ── Constants ───────────────────────────────────────────────────────────

/** The install directory. Always under the user's home. */
export const INSTALL_DIR: string = path.join(homedir(), '.kiro-learn');

/** Minimum required Node.js major version. */
export const MIN_NODE_VERSION = 22;

/**
 * The kiro-learn agent's description string. Extracted to module scope so
 * both the seed-then-merge flow and the fallback writer can reference the
 * same literal — see Requirements 4.2 and 6.2.
 */
export const KIRO_LEARN_DESCRIPTION =
  'Continuous learning for Kiro sessions. Captures tool-use events and injects prior context.';

/**
 * The exact set of hook triggers kiro-learn owns. Hook_Merge overwrites
 * each of these on the Seed_Payload; any hook trigger outside this tuple
 * is preserved unchanged.
 *
 * @see Requirements 4.3, 4.6 — Installer_Hook_Triggers glossary entry
 */
export const OWNED_TRIGGERS = [
  'agentSpawn',
  'userPromptSubmit',
  'postToolUse',
  'stop',
] as const;

/**
 * Absolute path to the shim executable that all four kiro-learn hook
 * triggers invoke. Built once at module load from {@link INSTALL_DIR}.
 *
 * Identical to the path the existing inline `kiroLearnConfig` construction
 * in {@link writeAgentConfigs} uses, by design — the Fallback_Config and
 * the merged hook entries must be byte-for-byte compatible with today's
 * hand-authored output (Requirement 6.2).
 */
const SHIM_PATH: string = path.join(INSTALL_DIR, 'bin', 'shim');

/**
 * `SHIM_PATH` wrapped in double quotes for safe inclusion in a shell
 * command — handles home directories with spaces or special characters.
 * The `|| true` suffix is appended at the call site (see
 * {@link KIRO_LEARN_TRIGGERS}).
 */
const QUOTED_SHIM: string = `"${SHIM_PATH}"`;

/**
 * The four hook-trigger entries kiro-learn owns on every installed agent
 * config. Used by both {@link mergeHooks} (to overwrite any seed payload's
 * entries at those triggers) and the Fallback_Config path (to populate
 * `hooks` when seeding fails).
 *
 * The quoted shim path and `|| true` suffix match the existing inline
 * `kiroLearnConfig` construction in {@link writeAgentConfigs} exactly —
 * this is load-bearing for Requirement 6.2 (Fallback_Config is byte-for-
 * byte compatible with today's hand-authored output) and for Requirement
 * 4.3 (merged output carries kiro-learn's owned entries).
 *
 * `postToolUse` is the only trigger that carries `matcher: '*'`; the
 * other three omit `matcher`, matching what kiro-cli expects.
 *
 * @see Requirements 4.3, 4.6, 6.2 — Installer_Hook_Triggers glossary entry
 */
export const KIRO_LEARN_TRIGGERS: HookTriggerMap = {
  agentSpawn: [{ command: QUOTED_SHIM + ' || true' }],
  userPromptSubmit: [{ command: QUOTED_SHIM + ' || true' }],
  postToolUse: [{ matcher: '*', command: QUOTED_SHIM + ' || true' }],
  stop: [{ command: QUOTED_SHIM + ' || true' }],
} as const;

/**
 * Project markers used by {@link detectScope} to identify a project root.
 * Checked in order at each directory during the upward walk; the first
 * match at the nearest directory wins.
 *
 * @see Requirements 15.2
 */
const PROJECT_MARKERS: readonly string[] = [
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

// ── Types ───────────────────────────────────────────────────────────────

/** Detected install scope. */
export interface InstallScope {
  /** Always true — global agent configs are always written. */
  global: true;
  /** When a project is detected, the absolute path to the project root. */
  projectRoot: string | undefined;
  /** The project marker that triggered detection, or undefined if no project detected. */
  detectedMarker: string | undefined;
}

/** Options for the init command. */
export interface InitOptions {
  /** Whether to run `kiro-cli agent set-default kiro-learn`. Default true. */
  setDefault: boolean;
  /** Skip project scope confirmation prompt (auto-accept). Default false. */
  yes: boolean;
  /** Force global-only scope even if a project is detected. Default false. */
  globalOnly: boolean;
}

/** Options for the uninstall command. */
export interface UninstallOptions {
  /** When true, preserve database, settings, and logs. */
  keepData: boolean;
}

// ── Precondition checks ────────────────────────────────────────────────

/**
 * Verify Node.js version >= 22. Throws with a descriptive message if not.
 *
 * @see Non-functional N7
 */
export function checkNodeVersion(): void {
  const major = parseInt(process.versions.node.split('.')[0]!, 10);
  if (major < MIN_NODE_VERSION) {
    throw new Error(
      `[kiro-learn] Node.js ${MIN_NODE_VERSION} or later is required (found: ${process.versions.node})`,
    );
  }
}

/**
 * Verify kiro-cli is installed by running `kiro-cli --version`.
 * Throws with install instructions if not found or non-zero exit.
 *
 * @see Requirements 16.1–16.4
 */
export function checkKiroCli(): void {
  try {
    execSync('kiro-cli --version', { stdio: 'ignore' });
  } catch {
    throw new Error(
      "[kiro-learn] kiro-cli is not installed. kiro-learn depends on kiro-cli for memory extraction " +
        "(the collector spawns 'kiro-cli chat --no-interactive --agent kiro-learn-compressor' to " +
        "transform events into memory records). Install kiro-cli first, then re-run 'npx kiro-learn init'.",
    );
  }
}

// ── Scope detection ─────────────────────────────────────────────────────

/**
 * Walk from `cwd` upward looking for any project marker.
 *
 * - If cwd is above $HOME → throw (fail fast).
 * - If cwd is $HOME or no marker found before $HOME → global-only.
 * - If any marker found below $HOME → global + project scope, with the
 *   NEAREST marker (first match during upward walk) winning.
 * - Walk ceiling is $HOME (never traverses at or above it).
 *
 * @see Requirements 15.1–15.8
 */
export function detectScope(cwd: string): InstallScope {
  const home = homedir();
  const resolved = realpathSync(cwd);

  // Fail fast if cwd is above $HOME
  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    throw new Error(
      `[kiro-learn] cannot install from outside the home directory tree (cwd: ${resolved})`,
    );
  }

  // If cwd is exactly $HOME, global-only
  if (resolved === home) {
    return { global: true, projectRoot: undefined, detectedMarker: undefined };
  }

  // Walk upward from cwd looking for any project marker
  let current = resolved;
  while (current !== home && current !== path.dirname(current)) {
    for (const marker of PROJECT_MARKERS) {
      const markerPath = path.join(current, marker);
      if (existsSync(markerPath)) {
        return {
          global: true,
          projectRoot: current,
          detectedMarker: marker,
        };
      }
    }
    current = path.dirname(current);
  }

  // No marker found before $HOME — global-only
  return { global: true, projectRoot: undefined, detectedMarker: undefined };
}

// ── Interactive prompts ──────────────────────────────────────────────────

/**
 * Prompt the user with a yes/no question on an interactive TTY.
 * Returns true for Y/y/empty (Enter), false for N/n.
 *
 * @see Requirements 18.1–18.3
 */
export function promptYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}

// ── Directory and file operations ───────────────────────────────────────

/**
 * Create the ~/.kiro-learn/ directory structure.
 * Creates bin/, lib/, logs/ subdirectories.
 * Creates ~/.kiro/agents/ for global agent configs.
 * Optionally creates <projectRoot>/.kiro/agents/ for project scope.
 *
 * @see Requirements 2.1–2.6, 17.3
 */
export function createLayout(scope: InstallScope): void {
  const dirs = [
    INSTALL_DIR,
    path.join(INSTALL_DIR, 'bin'),
    path.join(INSTALL_DIR, 'lib'),
    path.join(INSTALL_DIR, 'logs'),
    path.join(homedir(), '.kiro', 'agents'),
  ];

  if (scope.projectRoot !== undefined) {
    dirs.push(path.join(scope.projectRoot, '.kiro', 'agents'));
  }

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
}

/**
 * Copy the compiled dist/ payload into ~/.kiro-learn/lib/.
 * On upgrade, removes the existing lib/ first.
 * Source path is resolved relative to the installer's own location.
 *
 * @see Requirements 3.1–3.3
 */
export function deployPayload(): void {
  const libDir = path.join(INSTALL_DIR, 'lib');

  // Determine source: the dist/ directory of the npm package.
  // This file is at dist/installer/index.js, so dist/ is one level up.
  const thisFile = fileURLToPath(import.meta.url);
  const distDir = path.resolve(path.dirname(thisFile), '..');

  // On upgrade, remove existing lib/
  if (existsSync(libDir)) {
    rmSync(libDir, { recursive: true, force: true });
  }

  mkdirSync(libDir, { recursive: true });

  // Copy each subdirectory: shim/, collector/, installer/, types/
  for (const subdir of ['shim', 'collector', 'installer', 'types']) {
    const src = path.join(distDir, subdir);
    const dst = path.join(libDir, subdir);
    cpSync(src, dst, { recursive: true });
  }
}

/**
 * Write a minimal package.json to ~/.kiro-learn/ listing only
 * production runtime dependencies with pinned versions.
 *
 * @see Requirements 3.4
 */
export function writePackageJson(): void {
  // Read version from the package's own package.json
  const thisFile = fileURLToPath(import.meta.url);
  const pkgPath = path.resolve(path.dirname(thisFile), '..', '..', 'package.json');
  const pkgRaw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw) as { version: string };

  const runtimePkg = {
    name: 'kiro-learn-runtime',
    version: pkg.version,
    private: true,
    type: 'module',
    dependencies: {
      '@agentclientprotocol/sdk': '0.20.0',
      'better-sqlite3': '12.0.0',
      ulidx: '2.4.1',
      zod: '3.23.0',
    },
  };

  writeFileSync(
    path.join(INSTALL_DIR, 'package.json'),
    JSON.stringify(runtimePkg, null, 2) + '\n',
  );
}

/**
 * Run `npm install --production` in ~/.kiro-learn/.
 * On upgrade, removes existing node_modules/ first.
 * Spawns npm synchronously via child_process.execSync.
 *
 * @see Requirements 4.1–4.4
 */
export function installDeps(): void {
  const nodeModulesDir = path.join(INSTALL_DIR, 'node_modules');

  // On upgrade, remove existing node_modules/
  if (existsSync(nodeModulesDir)) {
    rmSync(nodeModulesDir, { recursive: true, force: true });
  }

  try {
    execSync('npm install --production', {
      cwd: INSTALL_DIR,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err: unknown) {
    const stderr =
      err !== null && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr)
        : '';
    throw new Error(
      `[kiro-learn] dependency installation failed${stderr ? `\n${stderr}` : ''}`,
    );
  }
}

/**
 * Write the three bin wrapper scripts (shim, collector, kiro-learn)
 * to ~/.kiro-learn/bin/ and chmod 0o755.
 *
 * @see Requirements 5.1–5.5, 17.1
 */
export function writeBinWrappers(): void {
  const binDir = path.join(INSTALL_DIR, 'bin');

  // Shim wrapper
  const shimContent = [
    '#!/usr/bin/env node',
    'import { main } from "../lib/shim/cli-agent/index.js";',
    'main().catch(() => {});',
  ].join('\n') + '\n';

  const shimPath = path.join(binDir, 'shim');
  writeFileSync(shimPath, shimContent);
  chmodSync(shimPath, 0o755);

  // Collector wrapper
  const collectorContent = [
    '#!/usr/bin/env node',
    'import { startCollector } from "../lib/collector/index.js";',
    'const handle = await startCollector();',
    'process.on("SIGTERM", async () => { await handle.close(); process.exit(0); });',
    'process.on("SIGINT", async () => { await handle.close(); process.exit(0); });',
  ].join('\n') + '\n';

  const collectorPath = path.join(binDir, 'collector');
  writeFileSync(collectorPath, collectorContent);
  chmodSync(collectorPath, 0o755);

  // CLI wrapper
  const cliContent = [
    '#!/usr/bin/env node',
    'import "../lib/installer/bin.js";',
  ].join('\n') + '\n';

  const cliPath = path.join(binDir, 'kiro-learn');
  writeFileSync(cliPath, cliContent);
  chmodSync(cliPath, 0o755);
}

/**
 * Write the default settings.json if it does not already exist.
 *
 * @see Requirements 14.1–14.3
 */
export function writeSettings(): void {
  const settingsPath = path.join(INSTALL_DIR, 'settings.json');

  if (existsSync(settingsPath)) {
    return;
  }

  const defaults = {
    collector: {
      host: '127.0.0.1',
      port: 21100,
    },
    shim: {
      timeoutMs: 2000,
    },
  };

  writeFileSync(settingsPath, JSON.stringify(defaults, null, 2) + '\n');
}

// ── Agent seed-then-merge helpers ───────────────────────────────────────

/**
 * The result of invoking the Seed_Command for one Agent_Scope.
 *
 * `ok: true` means `kiro-cli` exited zero AND the expected
 * `<targetDir>/kiro-learn.json` file exists on disk. The contents have not
 * been read or validated at this point — that is
 * {@link validateSeedPayload}'s job.
 *
 * `ok: false` carries a `reason` distinguishing the three failure modes:
 *
 *  - `spawn-failed`: `kiro-cli` could not be spawned (e.g. not on PATH, OS
 *    ENOENT). The thrown error had no numeric `status` property.
 *  - `non-zero-exit`: `kiro-cli` ran but exited non-zero (unknown flag,
 *    `kiro_default` not resolvable, permission denied, etc.). The thrown
 *    error had a numeric `status` property.
 *  - `missing-file`: `kiro-cli` exited zero but did not write the file —
 *    a defensive guard that should never fire in practice.
 *
 * `stderr` is captured verbatim from the thrown error (or `''` for
 * `missing-file`) so the caller can surface it in a warning if desired.
 *
 * @see Requirements 1.6, 1.7, 6.1
 */
export type SeedResult =
  | { ok: true; targetFile: string }
  | {
      ok: false;
      reason: 'spawn-failed' | 'non-zero-exit' | 'missing-file';
      stderr: string;
    };

/**
 * Invoke the Seed_Command for the given Agent_Scope's agents directory.
 *
 * Runs `kiro-cli agent create --from kiro_default --directory <targetDir>
 * kiro-learn` synchronously with `EDITOR=true` (so `kiro-cli` does not open
 * an interactive editor — Requirement 1.2) and captures stderr.
 *
 * On success, returns `{ ok: true, targetFile }` where `targetFile` is
 * `<targetDir>/kiro-learn.json`. The file exists on disk but its contents
 * have not been read — the caller is responsible for parsing and
 * validating via {@link validateSeedPayload}.
 *
 * On failure, returns `{ ok: false, reason, stderr }` with `reason` one of
 * `spawn-failed`, `non-zero-exit`, or `missing-file`. The caller is
 * responsible for writing the Fallback_Config; this helper does not touch
 * the filesystem on failure.
 *
 * Precondition: any pre-existing `<targetDir>/kiro-learn.json` has already
 * been unlinked by the caller (see Requirement 2.1) — this helper does not
 * perform the pre-seed delete.
 *
 * @param targetDir Absolute path to the Seed_Target_Directory (the scope's
 *                  `.kiro/agents/` directory). Must exist and be writable.
 * @returns A {@link SeedResult} describing whether the seed file was
 *          written.
 *
 * @see Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 12.3
 */
export function runSeedCommand(targetDir: string): SeedResult {
  const targetFile = path.join(targetDir, 'kiro-learn.json');

  // execFileSync: argv array avoids shell interpolation of targetDir (design § Security).
  try {
    execFileSync(
      'kiro-cli',
      [
        'agent',
        'create',
        '--from',
        'kiro_default',
        '--directory',
        targetDir,
        'kiro-learn',
      ],
      {
        env: { ...process.env, EDITOR: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: Buffer | string };
    const stderr =
      typeof e.stderr === 'string'
        ? e.stderr
        : Buffer.isBuffer(e.stderr)
          ? e.stderr.toString('utf8')
          : '';

    // Differentiate spawn-failed (no numeric status, e.g. ENOENT) from
    // non-zero-exit (kiro-cli ran but rejected the command).
    return typeof e.status === 'number'
      ? { ok: false, reason: 'non-zero-exit', stderr }
      : { ok: false, reason: 'spawn-failed', stderr };
  }

  // Defensive: even on exit 0, confirm kiro-cli actually produced the file.
  if (!existsSync(targetFile)) {
    return { ok: false, reason: 'missing-file', stderr: '' };
  }
  return { ok: true, targetFile };
}

/**
 * Validate the raw seed payload string produced by `kiro-cli agent create
 * --from kiro_default`.
 *
 * Attempts to parse `raw` as JSON. Returns the parsed value typed as
 * `Record<string, unknown>` when it is a non-null, non-array object with at
 * least one own key. Returns `null` on any failure: invalid JSON, `null`,
 * `undefined`, primitives, arrays, or empty objects.
 *
 * Pure and total — never throws, regardless of input.
 *
 * The function deliberately does not assert the presence of any named field
 * (`tools`, `prompt`, `description`, `mcpServers`, `allowedTools`, etc.) so
 * the installer inherits whatever shape `kiro-cli` ships now and in the
 * future without demanding specific keys.
 *
 * @param raw The raw string contents of `<target-dir>/kiro-learn.json`.
 * @returns The parsed Seed_Payload on success, or `null` if the payload is
 *          unusable and the caller should fall back to the minimal config.
 *
 * @see Requirements 3.1, 3.2, 3.3, 3.4, 3.5
 */
export function validateSeedPayload(
  raw: string,
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed !== 'object') return null;
  if (Array.isArray(parsed)) return null;
  if (Object.keys(parsed as object).length === 0) return null;

  return parsed as Record<string, unknown>;
}

/**
 * A single hook entry as it appears inside a Kiro agent JSON under
 * `hooks.<trigger>[]`.
 *
 * `command` is the shell command string kiro-cli executes when the trigger
 * fires. `matcher` is optional and is only populated for triggers that
 * accept a matcher (today, `postToolUse`); the other three owned triggers
 * omit it.
 *
 * @see Requirements 4.3, 4.6
 */
export interface HookEntry {
  /** Shell command string, e.g. `"<shim>" || true`. */
  command: string;
  /** Optional matcher for triggers like `postToolUse`. */
  matcher?: string;
}

/**
 * The four hook triggers kiro-learn owns. Exactly these keys, no others —
 * `mergeHooks` overwrites each of them on the Seed_Payload and leaves every
 * other trigger (and every other top-level field) untouched.
 *
 * Each value is the hook entry array that will replace whatever the
 * Seed_Payload had at that trigger.
 *
 * @see Requirements 4.3, 4.6 — Installer_Hook_Triggers glossary entry
 */
export interface HookTriggerMap {
  agentSpawn: readonly HookEntry[];
  userPromptSubmit: readonly HookEntry[];
  postToolUse: readonly HookEntry[];
  stop: readonly HookEntry[];
}

/**
 * Merge kiro-learn's four hook triggers onto a validated Seed_Payload.
 *
 * Rules (Requirement 4):
 *  - `name`          → `'kiro-learn'` (overwritten).
 *  - `description`   → {@link KIRO_LEARN_DESCRIPTION} (overwritten).
 *  - `hooks.<t>`     → `triggers[t]` for every `t` in {@link OWNED_TRIGGERS}
 *                      (overwritten; fresh array, no aliasing).
 *  - `hooks.<other>` → preserved unchanged for every hook trigger not in
 *                      {@link OWNED_TRIGGERS}.
 *  - all other top-level keys → copied through unchanged (tools, prompt,
 *                      mcpServers, allowedTools, and any future fields
 *                      `kiro_default` ships — Requirement 4.7).
 *
 * Pure: returns a fresh object, never mutates `seed`. If `seed.hooks` is
 * absent or not a plain object (e.g. a string, number, or array), it is
 * coerced to `{}` before the owned triggers are written — the result still
 * contains exactly the four owned triggers under `hooks`, and nothing else
 * from the malformed input.
 *
 * @param seed     A validated Seed_Payload (output of
 *                 {@link validateSeedPayload}). Must be a non-empty plain
 *                 object; this precondition is the caller's responsibility.
 * @param triggers The kiro-learn hook triggers to overwrite onto `seed`.
 *                 Must have exactly the four keys `agentSpawn`,
 *                 `userPromptSubmit`, `postToolUse`, `stop`.
 * @returns A fresh `Record<string, unknown>` representing the merged agent
 *          config, ready to be serialised with
 *          `JSON.stringify(merged, null, 2) + '\n'`.
 *
 * @see Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */
export function mergeHooks(
  seed: Record<string, unknown>,
  triggers: HookTriggerMap,
): Record<string, unknown> {
  // Start from a shallow copy of all top-level keys — preserves tools,
  // prompt, mcpServers, allowedTools, and any other fields kiro_default
  // ships now or in the future (Requirement 4.7).
  const merged: Record<string, unknown> = { ...seed };

  // Overwrite the two top-level fields kiro-learn owns.
  merged['name'] = 'kiro-learn';
  merged['description'] = KIRO_LEARN_DESCRIPTION;

  // Start hooks from whatever the seed had. Coerce to {} if absent or
  // malformed (non-object, array, null). validateSeedPayload guarantees
  // `seed` itself is a plain object, but it makes no promise about
  // `seed.hooks` specifically.
  const seedHooks = seed['hooks'];
  const baseHooks: Record<string, unknown> =
    seedHooks !== null &&
    typeof seedHooks === 'object' &&
    !Array.isArray(seedHooks)
      ? { ...(seedHooks as Record<string, unknown>) }
      : {};

  // Overwrite the four owned triggers — produces fresh arrays so the
  // caller cannot accidentally alias into `triggers`.
  for (const t of OWNED_TRIGGERS) {
    baseHooks[t] = [...triggers[t]];
  }
  merged['hooks'] = baseHooks;

  return merged;
}

/**
 * Derive the scope label for a Fallback_Warning from a Seed_Target_Directory.
 *
 * Returns `'global'` when `targetDir` is exactly the global agents directory
 * (`~/.kiro/agents`); returns `'project'` for any other directory
 * (project-scoped `<projectRoot>/.kiro/agents`).
 *
 * Module-private — only used to compose the Fallback_Warning in
 * {@link writeKiroLearnAgent}.
 *
 * @see Requirement 11.5
 */
function scopeLabel(targetDir: string): 'global' | 'project' {
  return targetDir === path.join(homedir(), '.kiro', 'agents')
    ? 'global'
    : 'project';
}

/**
 * Map a {@link SeedResult} failure reason to the `<cause>` substring used
 * inside the Fallback_Warning.
 *
 * - `spawn-failed`  → `'kiro-cli unavailable'`
 * - `non-zero-exit` → `'seed command failed'`
 * - `missing-file`  → `'seed command failed'`
 *
 * The invalid-payload case (validateSeedPayload returning `null`) passes
 * `'seed command failed'` directly at the call site and does not flow
 * through this helper.
 *
 * Module-private — only used by {@link writeKiroLearnAgent}.
 *
 * @see Requirements 11.2, 11.5
 */
function reasonToCause(
  reason: 'spawn-failed' | 'non-zero-exit' | 'missing-file',
): string {
  return reason === 'spawn-failed' ? 'kiro-cli unavailable' : 'seed command failed';
}

/**
 * Write the kiro-learn.json agent config at the given Agent_Scope's
 * `.kiro/agents/` directory, using the seed-then-merge flow from
 * Requirements 2, 3, 4, 5, 6, and 12.
 *
 * Executes the five-step per-scope sequence:
 *
 *   (a) Delete any existing `<targetDir>/kiro-learn.json` (ENOENT tolerated).
 *   (b) Invoke {@link runSeedCommand} to spawn `kiro-cli agent create --from
 *       kiro_default --directory <targetDir> kiro-learn`.
 *   (c) On seed success, read the written file and pass it to
 *       {@link validateSeedPayload}.
 *   (d) On valid payload, call {@link mergeHooks} with
 *       {@link KIRO_LEARN_TRIGGERS} and write the serialised result back
 *       to `<targetDir>/kiro-learn.json`.
 *   (e) On any failure (seed failed or payload invalid), write the
 *       Fallback_Config to the same path and emit a single
 *       Fallback_Warning to stderr.
 *
 * A seed failure is NOT an install failure (Requirement 6.5) — this
 * function returns normally in the fallback branch. It throws only on
 * unexpected errors: non-ENOENT unlink failures, readFileSync failures on
 * a file `runSeedCommand` reported as present, or writeFileSync failures
 * (e.g. permission denied on the agents dir, disk full).
 *
 * Caller (`createLayout`) is responsible for ensuring `targetDir` exists
 * and is writable before this is called.
 *
 * @param targetDir Absolute path to the Seed_Target_Directory — the
 *                  scope's `.kiro/agents/` directory (global or project).
 *
 * @see Requirements 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1,
 *      4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4,
 *      6.5, 11.1, 11.2, 11.3, 11.4, 11.5, 12.1
 */
export function writeKiroLearnAgent(targetDir: string): void {
  const targetFile = path.join(targetDir, 'kiro-learn.json');

  /**
   * Write the Fallback_Config to `targetFile` and emit a single
   * Fallback_Warning to stderr. Shared between every failure branch of
   * `writeKiroLearnAgent`.
   *
   * The Fallback_Config's key order — `name`, `description`, `hooks` at
   * top level; `agentSpawn`, `userPromptSubmit`, `postToolUse`, `stop`
   * inside `hooks` — is load-bearing: `JSON.stringify` serialises object
   * literals in insertion order, and Requirement 6.2 requires byte-for-
   * byte compatibility with the pre-spec hand-authored output.
   *
   * @see Requirements 6.1, 6.2, 6.3, 11.1, 11.2, 11.3, 11.4, 11.5
   */
  function writeFallback(cause: string, scope: 'global' | 'project'): void {
    const fallback = {
      name: 'kiro-learn',
      description: KIRO_LEARN_DESCRIPTION,
      hooks: {
        agentSpawn: KIRO_LEARN_TRIGGERS.agentSpawn,
        userPromptSubmit: KIRO_LEARN_TRIGGERS.userPromptSubmit,
        postToolUse: KIRO_LEARN_TRIGGERS.postToolUse,
        stop: KIRO_LEARN_TRIGGERS.stop,
      },
    };
    writeFileSync(targetFile, JSON.stringify(fallback, null, 2) + '\n');
    process.stderr.write(
      `[kiro-learn] warning: could not seed kiro-learn agent from kiro_default (${cause}) for ${scope} scope. ` +
        `Writing minimal hooks-only config — the agent will not have the default tools, prompt, or MCP servers until ` +
        `you install/upgrade kiro-cli and rerun 'kiro-learn init'.\n`,
    );
  }

  // (a) Pre-seed delete: remove any existing file so kiro-cli can write a
  // fresh seed in place. ENOENT is expected (no prior install); any other
  // error indicates a real fs problem and must propagate.
  try {
    unlinkSync(targetFile);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
  }

  const scope = scopeLabel(targetDir);

  // (b) Invoke the Seed_Command.
  const seed = runSeedCommand(targetDir);

  if (!seed.ok) {
    // (e.i) Seed failed — write fallback with a cause derived from the
    // SeedResult.reason and emit the warning.
    writeFallback(reasonToCause(seed.reason), scope);
    return;
  }

  // (c) Seed succeeded — read and validate the payload.
  const raw = readFileSync(seed.targetFile, 'utf8');
  const payload = validateSeedPayload(raw);

  if (payload === null) {
    // (e.ii) Payload unusable (invalid JSON, primitive, array, empty
    // object). Per Requirement 11.2, report `seed command failed`.
    writeFallback('seed command failed', scope);
    return;
  }

  // (d) Merge kiro-learn's four owned triggers onto the seed and write
  // the merged result back to the same path.
  const merged = mergeHooks(payload, KIRO_LEARN_TRIGGERS);
  writeFileSync(targetFile, JSON.stringify(merged, null, 2) + '\n');
}

/**
 * Generate and write both agent config files at all applicable scopes.
 *
 * `kiro-learn.json` is written via {@link writeKiroLearnAgent} per scope:
 *   - Global scope (`~/.kiro/agents/`) is always written.
 *   - Project scope (`<projectRoot>/.kiro/agents/`) is written when
 *     {@link InstallScope.projectRoot} is defined.
 *
 * Each scope runs the same seed-then-merge flow: delete any existing
 * `kiro-learn.json`, invoke `kiro-cli agent create --from kiro_default
 * --directory <targetDir> kiro-learn`, validate the seed payload, merge
 * kiro-learn's four owned hook triggers onto it, and write the result.
 * On any failure the scope falls back to a minimal hooks-only config and
 * emits a single `[kiro-learn] warning:` line to stderr.
 *
 * Scopes run sequentially — global completes every step before project
 * begins its own (Requirement 12.2). A fallback in one scope does not
 * short-circuit the other (Requirement 6.4).
 *
 * `kiro-learn-compressor.json` is written at global scope only with
 * hand-authored contents — this path is deliberately untouched by the
 * seed-then-merge flow (Requirement 8). Its bytes remain byte-for-byte
 * identical to the pre-spec installer's output (Requirement 8.2).
 *
 * @see Requirements 1–12 — default-equivalent-agent spec
 * @see Requirements 6.1–6.11 — original agent-config requirements
 *      (preserved for the compressor)
 */
export function writeAgentConfigs(scope: InstallScope): void {
  const globalAgentsDir = path.join(homedir(), '.kiro', 'agents');

  // ── Agent 1: kiro-learn.json (hook-registering agent) ──
  // Delegate to writeKiroLearnAgent per scope — it handles the pre-seed
  // delete, spawns kiro-cli, validates the payload, merges kiro-learn's
  // four owned triggers, and falls back to the bare hooks-only config if
  // any step fails (Requirements 1–6, 11, 12).
  writeKiroLearnAgent(globalAgentsDir);

  if (scope.projectRoot !== undefined) {
    writeKiroLearnAgent(path.join(scope.projectRoot, '.kiro', 'agents'));
  }

  // ── Agent 2: kiro-learn-compressor.json (extraction agent) ──
  writeCompressorAgent(globalAgentsDir);
}

/**
 * Write the kiro-learn-compressor agent config (the XML extraction
 * agent) into the given agents directory.
 *
 * The compressor is hand-authored — it is deliberately out of scope for
 * the seed-then-merge flow (Requirement 8) because it ships with zero
 * tools and a fixed XML-extraction prompt. Writing it through a
 * dedicated helper (instead of inlining in {@link writeAgentConfigs})
 * lets the extraction-pipeline integration test refresh the on-disk
 * prompt to the current source before running, which keeps that test
 * hermetic regardless of what the developer has previously installed.
 *
 * Global scope only — no project-scoped compressor is ever written
 * (Requirement 8.3).
 *
 * @param agentsDir The absolute path of the `.kiro/agents/` directory
 *                  to write into. The directory must already exist.
 *
 * @see Requirements 6.8, 6.9, 8.1, 8.2, 8.3
 */
export function writeCompressorAgent(agentsDir: string): void {
  const compressorPrompt =
    'You are a memory extraction agent for kiro-learn. Your ONLY job is to analyze tool-use observations and produce structured memory records.\n' +
    '\n' +
    'You will receive tool observations wrapped in <tool_observation> XML. Respond with ONLY XML — no prose, no markdown, no explanation.\n' +
    '\n' +
    'Return one or more <memory_record> blocks, or signal skip by returning either:\n' +
    '  - an empty response, or\n' +
    '  - a single `<skip/>` tag (optionally with a `reason` attribute, e.g. `<skip reason="trivial observation"/>`).\n' +
    '\n' +
    'The `type` attribute MUST be exactly one of: tool_use, decision, error, discovery, pattern.\n' +
    'Pick a single value — never emit the literal pipe-delimited list below.\n' +
    '\n' +
    '<memory_record type="TYPE">\n' +
    '  <title>Concise title (max 200 chars)</title>\n' +
    '  <summary>What happened and why it matters</summary>\n' +
    '  <facts>\n' +
    '    <fact>Discrete factual statement</fact>\n' +
    '  </facts>\n' +
    '  <concepts>\n' +
    '    <concept>technology-or-pattern</concept>\n' +
    '  </concepts>\n' +
    '  <files>\n' +
    '    <file>path/to/file</file>\n' +
    '  </files>\n' +
    '</memory_record>\n' +
    '\n' +
    'Concrete examples:\n' +
    '- type="tool_use" — a file read, write, or command invocation happened.\n' +
    '- type="decision" — a design or architectural choice was made.\n' +
    '- type="error" — a failure or bug was encountered.\n' +
    '- type="discovery" — a concrete debugging finding or learned fact.\n' +
    '- type="pattern" — a recurring approach or convention.\n' +
    '\n' +
    'Rules:\n' +
    '- Never reply with prose. Non-XML text is discarded.\n' +
    '- Valid skip signals: an empty response OR a single `<skip/>` tag.\n' +
    '- Concrete debugging findings count as discoveries.\n' +
    '- Focus on durable knowledge, not transient state.';

  const compressorConfig = {
    name: 'kiro-learn-compressor',
    description:
      'Memory record extraction agent for kiro-learn. Distills events into structured memory records.',
    prompt: compressorPrompt,
    tools: [] as string[],
    allowedTools: [] as string[],
  };

  writeFileSync(
    path.join(agentsDir, 'kiro-learn-compressor.json'),
    JSON.stringify(compressorConfig, null, 2) + '\n',
  );
}

/**
 * Run `kiro-cli agent set-default kiro-learn`.
 * Logs a warning on failure but does not throw.
 *
 * @see Requirements 7.1–7.3
 */
export function setDefaultAgent(): void {
  try {
    execSync('kiro-cli agent set-default kiro-learn', { stdio: 'ignore' });
  } catch {
    process.stderr.write(
      '[kiro-learn] warning: failed to set kiro-learn as default agent\n',
    );
  }
}

// ── Installation check ───────────────────────────────────────────────────

/**
 * Check whether kiro-learn is properly installed (not just a leftover
 * directory from `uninstall --keep-data`). Verifies INSTALL_DIR exists
 * and contains the runtime package.json.
 */
function isInstalled(): boolean {
  return (
    existsSync(INSTALL_DIR) &&
    existsSync(path.join(INSTALL_DIR, 'package.json'))
  );
}

// ── Daemon lifecycle ────────────────────────────────────────────────────

/**
 * Check if the collector daemon is running.
 * Reads the PID file and probes with process.kill(pid, 0).
 * Returns the PID if alive, null if not running or stale.
 * Cleans up stale PID files.
 *
 * @see Requirements 10.2, 9.5, 9.6, N5
 */
export function getDaemonPid(): number | null {
  const pidFile = path.join(INSTALL_DIR, 'collector.pid');

  if (!existsSync(pidFile)) {
    return null;
  }

  const pidStr = readFileSync(pidFile, 'utf8').trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    process.stderr.write('[kiro-learn] invalid PID file, removing\n');
    unlinkSync(pidFile);
    return null;
  }

  try {
    process.kill(pid, 0); // signal 0 = liveness check
  } catch {
    process.stderr.write(
      `[kiro-learn] removed stale PID file (process ${pid} not running)\n`,
    );
    unlinkSync(pidFile);
    return null;
  }

  // Verify the process is actually our collector (PID may have been reused)
  try {
    const psOutput = execSync(`ps -p ${pid} -o command=`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!psOutput.includes('collector')) {
      process.stderr.write(
        `[kiro-learn] PID ${pid} is not a kiro-learn collector (reused PID), removing stale PID file\n`,
      );
      unlinkSync(pidFile);
      return null;
    }
  } catch {
    // ps failed — process may have exited between kill(0) and ps; treat as stale
    try { unlinkSync(pidFile); } catch { /* ignore */ }
    return null;
  }

  return pid;
}

/**
 * Start the collector daemon as a detached background process.
 * Spawns ~/.kiro-learn/bin/collector with detached: true.
 * Writes PID to ~/.kiro-learn/collector.pid.
 * Redirects stdout/stderr to ~/.kiro-learn/logs/collector-YYYY-MM-DD.log.
 *
 * @see Requirements 8.1–8.7
 */
export function startDaemon(): void {
  // Check if already running
  const existingPid = getDaemonPid();
  if (existingPid !== null) {
    process.stdout.write(
      `[kiro-learn] daemon already running (PID ${existingPid})\n`,
    );
    return;
  }

  const collectorBin = path.join(INSTALL_DIR, 'bin', 'collector');
  const logsDir = path.join(INSTALL_DIR, 'logs');
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logFile = path.join(logsDir, `collector-${dateStr}.log`);

  // Open log file for append
  const logFd = openSync(logFile, 'a');

  const child = spawn(process.execPath, [collectorBin], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });

  // Write PID file
  const pidFile = path.join(INSTALL_DIR, 'collector.pid');
  writeFileSync(pidFile, String(child.pid) + '\n');
  chmodSync(pidFile, 0o644);

  // Detach — let the daemon outlive the installer
  child.unref();
  closeSync(logFd);

  process.stdout.write(`[kiro-learn] daemon started (PID ${child.pid})\n`);
}

/**
 * Synchronous sleep using Atomics.wait on a SharedArrayBuffer.
 * Blocks the current thread for the specified number of milliseconds.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stop the collector daemon.
 * SIGTERM → wait up to 5s → SIGKILL.
 * Removes the PID file after the process exits.
 *
 * @see Requirements 9.1–9.6
 */
export function stopDaemon(): void {
  const pidFile = path.join(INSTALL_DIR, 'collector.pid');

  if (!existsSync(pidFile)) {
    process.stdout.write('[kiro-learn] no PID file found, daemon is not running\n');
    return;
  }

  const pidStr = readFileSync(pidFile, 'utf8').trim();
  const pid = parseInt(pidStr, 10);

  if (isNaN(pid)) {
    process.stdout.write('[kiro-learn] invalid PID file, removing\n');
    unlinkSync(pidFile);
    return;
  }

  // Check if process is alive
  try {
    process.kill(pid, 0); // signal 0 = liveness check
  } catch {
    process.stdout.write(
      `[kiro-learn] stale PID file (process ${pid} not running), removing\n`,
    );
    unlinkSync(pidFile);
    return;
  }

  // Send SIGTERM
  process.stdout.write(`[kiro-learn] stopping daemon (PID ${pid})...\n`);
  process.kill(pid, 'SIGTERM');

  // Wait up to 5 seconds for exit
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // still alive?
      sleepSync(100); // busy-wait in 100ms increments
    } catch {
      // Process exited
      break;
    }
  }

  // If still alive after 5s, SIGKILL
  try {
    process.kill(pid, 0);
    process.stderr.write('[kiro-learn] daemon did not respond to SIGTERM, sent SIGKILL\n');
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already exited
  }

  // Remove PID file
  try {
    unlinkSync(pidFile);
  } catch {
    // Ignore — file may already be gone
  }

  process.stdout.write('[kiro-learn] daemon stopped\n');
}

// ── Command handlers ────────────────────────────────────────────────────

/**
 * The `init` command. Orchestrates the full install/upgrade flow.
 * Returns 0 on success, 1 on failure.
 *
 * @see Requirements 1.2, 2–8, 12, 13, 14, 15, 16, 17, 18
 */
export async function cmdInit(opts: InitOptions): Promise<number> {
  let isUpgrade = false;
  let layoutCreated = false;

  try {
    // ── Precondition checks (before any filesystem modifications) ──
    process.stdout.write('[kiro-learn] checking Node.js version...\n');
    checkNodeVersion();

    process.stdout.write('[kiro-learn] checking kiro-cli...\n');
    checkKiroCli();

    // ── Scope detection ──
    let scope = detectScope(process.cwd());

    // Apply --global-only override
    if (opts.globalOnly) {
      scope = { global: true, projectRoot: undefined, detectedMarker: undefined };
      process.stdout.write('[kiro-learn] forced global-only scope (--global-only)\n');
    } else if (scope.projectRoot !== undefined) {
      // Confirm project scope with user
      if (!opts.yes && process.stdout.isTTY) {
        const accepted = await promptYesNo(
          `Detected project at ${scope.projectRoot} (via ${scope.detectedMarker}). Install project-scoped agent config here? [Y/n] `,
        );
        if (!accepted) {
          scope = { global: true, projectRoot: undefined, detectedMarker: undefined };
          process.stdout.write('[kiro-learn] user declined project scope, using global-only\n');
        }
      } else {
        process.stdout.write(
          `[kiro-learn] project detected at ${scope.projectRoot} (via ${scope.detectedMarker})\n`,
        );
      }
    }

    process.stdout.write(
      `[kiro-learn] scope: ${scope.projectRoot ? `global + project (${scope.projectRoot})` : 'global-only'}\n`,
    );

    // ── Detect upgrade ──
    isUpgrade = existsSync(INSTALL_DIR);

    if (isUpgrade) {
      process.stdout.write('[kiro-learn] existing install detected, upgrading...\n');
      stopDaemon();
    }

    // ── Create directory structure ──
    process.stdout.write('[kiro-learn] creating ~/.kiro-learn/...\n');
    createLayout(scope);
    layoutCreated = true;

    // ── Deploy payload ──
    process.stdout.write('[kiro-learn] deploying payload...\n');
    deployPayload();

    // ── Write package.json for runtime deps ──
    writePackageJson();

    // ── Install runtime dependencies ──
    process.stdout.write('[kiro-learn] installing dependencies...\n');
    installDeps();

    // ── Write bin wrappers ──
    process.stdout.write('[kiro-learn] writing bin wrappers...\n');
    writeBinWrappers();

    // ── Write default settings (only if new install) ──
    writeSettings();

    // ── Write agent configs at all applicable scopes ──
    process.stdout.write('[kiro-learn] writing agent configs...\n');
    writeAgentConfigs(scope);

    // ── Optionally set default agent ──
    if (opts.setDefault) {
      setDefaultAgent();
    }

    // ── Start daemon ──
    process.stdout.write('[kiro-learn] starting collector daemon...\n');
    startDaemon();

    // ── Print summary ──
    const pid = getDaemonPid();
    const pkgPath = path.join(INSTALL_DIR, 'package.json');
    let version = 'unknown';
    try {
      const pkgRaw = readFileSync(pkgPath, 'utf8');
      version = (JSON.parse(pkgRaw) as { version: string }).version;
    } catch {
      // version stays 'unknown'
    }

    process.stdout.write('\n');
    process.stdout.write('[kiro-learn] install complete!\n');
    process.stdout.write(`[kiro-learn]   version:     ${version}\n`);
    process.stdout.write(`[kiro-learn]   install_dir: ${INSTALL_DIR}\n`);
    process.stdout.write(`[kiro-learn]   daemon PID:  ${pid ?? 'not running'}\n`);
    process.stdout.write(
      `[kiro-learn]   scope:       ${scope.projectRoot ? `global + project (${scope.projectRoot})` : 'global-only'}\n`,
    );
    process.stdout.write(
      `[kiro-learn]   agents:      ${path.join(homedir(), '.kiro', 'agents', 'kiro-learn.json')}`,
    );
    if (scope.projectRoot !== undefined) {
      process.stdout.write(
        `\n[kiro-learn]                ${path.join(scope.projectRoot, '.kiro', 'agents', 'kiro-learn.json')}`,
      );
    }
    process.stdout.write('\n');

    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[kiro-learn] init failed: ${message}\n`);

    // Cleanup on fresh install failure (before payload deployment)
    if (!isUpgrade && layoutCreated) {
      try {
        rmSync(INSTALL_DIR, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    return 1;
  }
}

/**
 * The `start` command. Starts the daemon if not already running.
 * Returns 0 on success, 1 on failure.
 *
 * @see Requirements 8.2, 8.6, 8.7
 */
export function cmdStart(): number {
  if (!isInstalled()) {
    process.stderr.write(
      "[kiro-learn] not installed. Run 'npx kiro-learn init' first.\n",
    );
    return 1;
  }

  try {
    startDaemon();
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[kiro-learn] failed to start daemon: ${message}\n`);
    return 1;
  }
}

/**
 * The `stop` command. Stops the daemon if running.
 * Returns 0 on success (including "not running"), 1 on failure.
 *
 * @see Requirements 9.1–9.6
 */
export function cmdStop(): number {
  if (!existsSync(INSTALL_DIR)) {
    process.stdout.write('[kiro-learn] not installed, nothing to stop\n');
    return 0;
  }

  try {
    stopDaemon();
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[kiro-learn] failed to stop daemon: ${message}\n`);
    return 1;
  }
}

/**
 * The `status` command. Prints install and daemon status.
 * Returns 0 if installed, 1 if not installed.
 *
 * @see Requirements 10.1–10.7
 */
export function cmdStatus(): number {
  if (!isInstalled()) {
    process.stderr.write('[kiro-learn] not installed\n');
    return 1;
  }

  // Daemon status
  const pid = getDaemonPid();
  if (pid !== null) {
    process.stdout.write('status: running\n');
    process.stdout.write(`pid: ${pid}\n`);
  } else {
    process.stdout.write('status: stopped\n');
  }

  // Install info
  process.stdout.write(`install_dir: ${INSTALL_DIR}\n`);

  // Database
  const dbPath = path.join(INSTALL_DIR, 'kiro-learn.db');
  process.stdout.write(`database: ${dbPath}\n`);
  process.stdout.write(`database_exists: ${existsSync(dbPath)}\n`);

  // Version
  try {
    const pkgRaw = readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8');
    const version = (JSON.parse(pkgRaw) as { version: string }).version;
    process.stdout.write(`version: ${version}\n`);
  } catch {
    process.stdout.write('version: unknown\n');
  }

  return 0;
}

/**
 * The `uninstall` command. Removes kiro-learn from the system.
 * Returns 0 on success (including "not installed"), 1 on failure.
 *
 * @see Requirements 11.1–11.7
 */
export function cmdUninstall(opts: UninstallOptions): number {
  if (!existsSync(INSTALL_DIR)) {
    process.stdout.write('[kiro-learn] not installed, nothing to uninstall\n');
    return 0;
  }

  try {
    // Stop daemon
    stopDaemon();

    // Detect scope for project-level cleanup
    let scope: InstallScope;
    try {
      scope = detectScope(process.cwd());
    } catch {
      scope = { global: true, projectRoot: undefined, detectedMarker: undefined };
    }

    // Remove global agent configs
    const globalAgentsDir = path.join(homedir(), '.kiro', 'agents');
    for (const name of ['kiro-learn.json', 'kiro-learn-compressor.json']) {
      const agentPath = path.join(globalAgentsDir, name);
      if (existsSync(agentPath)) {
        unlinkSync(agentPath);
      }
    }

    // Remove project-scoped agent config if applicable
    if (scope.projectRoot !== undefined) {
      const projectAgent = path.join(
        scope.projectRoot,
        '.kiro',
        'agents',
        'kiro-learn.json',
      );
      if (existsSync(projectAgent)) {
        unlinkSync(projectAgent);
      }
    }

    // Remove install directory
    if (opts.keepData) {
      // Remove bin/, lib/, node_modules/ but keep db, settings, logs
      for (const subdir of ['bin', 'lib', 'node_modules']) {
        const dirPath = path.join(INSTALL_DIR, subdir);
        if (existsSync(dirPath)) {
          rmSync(dirPath, { recursive: true, force: true });
        }
      }
      // Remove PID file and package.json
      for (const file of ['collector.pid', 'package.json']) {
        const filePath = path.join(INSTALL_DIR, file);
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
      }
    } else {
      rmSync(INSTALL_DIR, { recursive: true, force: true });
    }

    process.stdout.write('[kiro-learn] uninstalled successfully\n');
    return 0;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[kiro-learn] uninstall failed: ${message}\n`);
    return 1;
  }
}
