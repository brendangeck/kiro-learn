#!/usr/bin/env node
/**
 * CLI entry point for `kiro-learn`.
 *
 * Parses argv, dispatches to command handlers, sets exit code.
 * No third-party CLI framework — argv is simple enough for manual parsing.
 *
 * The dispatch logic is factored into the exported {@link dispatch} function
 * so in-process callers (tests, embedding hosts) can exercise the same
 * parsing and exit-code logic without spawning a subprocess. The top-level
 * IIFE below keeps `npx tsx src/installer/bin.ts` and the installed
 * `~/.kiro-learn/bin/kiro-learn` wrapper working the way they always have.
 *
 * @see Requirements 1.1–1.9
 */

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cmdInit,
  cmdStart,
  cmdStop,
  cmdStatus,
  cmdUninstall,
} from './index.js';

export const USAGE = `kiro-learn — continuous learning for Kiro agent sessions

Usage: kiro-learn <command> [options]

Commands:
  init        Install or upgrade kiro-learn
  start       Start the collector daemon
  stop        Stop the collector daemon
  status      Show install and daemon status
  uninstall   Remove kiro-learn

Options:
  --version   Show version
  --help      Show this help

Init options:
  --no-set-default  Don't set kiro-learn as default agent
  --yes, -y         Skip confirmation prompts
  --global-only     Force global-only scope

Uninstall options:
  --keep-data       Preserve database, settings, and logs
`;

/**
 * Captured result of a single {@link dispatch} invocation.
 *
 * Returned so test code can assert on stdout, stderr, and exit code without
 * wiring spies onto `process.stdout` / `process.stderr` or spawning a child
 * process. The string buffers accumulate everything the dispatcher would
 * have written when invoked as a real CLI.
 */
export interface DispatchResult {
  /** Exit code the CLI would set via `process.exitCode`. */
  exitCode: number;
  /** Everything that would have been written to `process.stdout`. */
  stdout: string;
  /** Everything that would have been written to `process.stderr`. */
  stderr: string;
}

/**
 * In-process equivalent of running the bin with the given argv.
 *
 * Mirrors the top-level IIFE exactly: same command switch, same flag
 * parsing, same error strings, same exit codes. The only difference is
 * that stdout/stderr are captured into the returned object rather than
 * written to the real streams, and `process.exitCode` is left untouched.
 *
 * The `--help`, `--version`, and unknown-command branches are pure and
 * require no I/O. Real commands (`init`, `start`, `stop`, `status`,
 * `uninstall`) still invoke their handlers in {@link ./index}, which in
 * turn write to the real `process.stdout` / `process.stderr` — only the
 * bin's own output is captured here. Tests that need to assert on handler
 * output should spy on those streams directly.
 *
 * @param argv Positional arguments and flags, e.g. `['init', '--yes']`.
 *             This is `process.argv.slice(2)`, not the full argv.
 * @returns Captured stdout, stderr, and exit code.
 */
export async function dispatch(argv: readonly string[]): Promise<DispatchResult> {
  const result: DispatchResult = { exitCode: 0, stdout: '', stderr: '' };
  const command = argv[0];

  if (command === '--version') {
    const thisFile = fileURLToPath(import.meta.url);
    const pkgPath = path.resolve(path.dirname(thisFile), '..', '..', 'package.json');
    const pkgRaw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgRaw) as { version: string };
    result.stdout = `kiro-learn ${pkg.version}\n`;
    result.exitCode = 0;
    return result;
  }

  if (command === '--help' || command === undefined) {
    result.stdout = USAGE;
    result.exitCode = 0;
    return result;
  }

  const flags = argv.slice(1);

  switch (command) {
    case 'init': {
      const setDefault = !flags.includes('--no-set-default');
      const yes = flags.includes('--yes') || flags.includes('-y');
      const globalOnly = flags.includes('--global-only');
      result.exitCode = await cmdInit({ setDefault, yes, globalOnly });
      break;
    }

    case 'start':
      result.exitCode = cmdStart();
      break;

    case 'stop':
      result.exitCode = cmdStop();
      break;

    case 'status':
      result.exitCode = cmdStatus();
      break;

    case 'uninstall': {
      const keepData = flags.includes('--keep-data');
      result.exitCode = cmdUninstall({ keepData });
      break;
    }

    default:
      result.stderr =
        `[kiro-learn] unknown command: ${command}\n` +
        'Valid commands: init, start, stop, status, uninstall\n';
      result.exitCode = 1;
      break;
  }

  return result;
}

/**
 * True when this file is the process entry point (not an imported module).
 *
 * Guards the IIFE below so tests that `import` this module don't kick off
 * a CLI dispatch as a side-effect of import resolution.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const thisFile = fileURLToPath(import.meta.url);
    // Resolve symlinks: npx creates a symlink in its temp cache
    // (e.g. ~/.npm/_npx/<hash>/node_modules/.bin/kiro-learn) that
    // points to the real file. path.resolve alone won't follow the
    // symlink, so the comparison fails. realpathSync resolves the
    // full chain so both sides agree on the canonical path.
    return realpathSync(path.resolve(entry)) === realpathSync(thisFile);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void (async (): Promise<void> => {
    try {
      const result = await dispatch(process.argv.slice(2));
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      process.stderr.write(`[kiro-learn] fatal: ${message}\n`);
      if (stack !== undefined) process.stderr.write(`${stack}\n`);
      process.exitCode = 1;
    }
  })();
}
