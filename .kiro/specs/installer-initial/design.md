# Design Document: kiro-learn Installer (CLI)

## Overview

This spec defines the kiro-learn installer — the `kiro-learn` CLI that ships as the npm package's `bin` entry (`src/installer/bin.ts`) and bootstraps a local runtime install under `~/.kiro-learn/`. The installer is the final v1 milestone piece that turns the existing library (types, collector, pipeline, storage, shim — all implemented and tested) into something a user can actually run.

The installer builds on the contracts established in [event-schema-and-storage](../event-schema-and-storage/design.md) (the canonical types), [collector-pipeline](../collector-pipeline/design.md) (the collector daemon started by `init`), and [shim](../shim/design.md) (the hook entry point wired into the agent config). Those are consumed here, not redefined.

**Design principle: short-lived, synchronous, idempotent.** The installer is a CLI tool, not a daemon. It runs, does its work using synchronous filesystem APIs where possible, and exits. Every command is safe to re-run. `init` on an existing install is an upgrade. `stop` on a stopped daemon is a no-op. `uninstall` on a missing install is a no-op.

**In scope:** The five CLI commands (`init`, `start`, `stop`, `status`, `uninstall`), directory layout creation, payload deployment, runtime dependency installation, bin wrapper generation, Kiro CLI agent config writing (both `kiro-learn.json` and `kiro-learn-compressor.json`), install scope detection (global vs project-level), kiro-cli dependency verification, daemon lifecycle management via PID file, upgrade flow, uninstall flow.

**Out of scope:** Collector implementation, shim implementation, storage internals, extraction pipeline, IDE hook support (v3), Homebrew/winget/standalone binary distribution (v3+), remote daemon support, graceful online upgrades.

**Known issue:** The current extraction code in `src/collector/pipeline/index.ts` spawns `kiro-cli extract`, which does not exist. The correct invocation is `kiro-cli chat --no-interactive --agent kiro-learn-compressor`. The compressor agent config written by this installer enables that invocation. The pipeline's `spawnKiroCli` function will need to be updated separately to use the correct command.

## Architecture

### Component context

```
npx kiro-learn <command>
         |
         v
┌─────────────────────────────────┐
│  CLI Entry Point                │  src/installer/bin.ts
│  parse argv → dispatch          │
└──────────────┬──────────────────┘
               |
               v
┌─────────────────────────────────┐
│  Installer Module               │  src/installer/index.ts
│                                 │
│  ┌───────────┐ ┌──────────┐    │
│  │ init      │ │ start    │    │
│  │ ─ scope   │ │ ─ spawn  │    │
│  │ ─ layout  │ │ ─ pid    │    │
│  │ ─ payload │ └──────────┘    │
│  │ ─ deps    │ ┌──────────┐    │
│  │ ─ bins    │ │ stop     │    │
│  │ ─ agents  │ │ ─ signal │    │
│  │ ─ daemon  │ │ ─ pid    │    │
│  └───────────┘ └──────────┘    │
│  ┌───────────┐ ┌──────────┐    │
│  │ status    │ │ uninstall│    │
│  │ ─ pid     │ │ ─ stop   │    │
│  │ ─ info    │ │ ─ agents │    │
│  └───────────┘ │ ─ dirs   │    │
│                └──────────┘    │
└────────────────────────────────┘
         |                    |
         v                    v
┌──────────────┐    ┌──────────────────┐
│ Collector    │    │ Filesystem       │
│ startCollector() │ │ ~/.kiro-learn/   │
│ (imported)   │    │ ~/.kiro/agents/  │
└──────────────┘    │ <Project>/.kiro/ │
                    └──────────────────┘
```

### Init sequence (fresh install)

```
User                    bin.ts              installer/index.ts         Filesystem            npm           Collector
 |                        |                        |                       |                   |               |
 |─npx kiro-learn init──>|                        |                       |                   |               |
 |                        |─dispatch('init')──────>|                       |                   |               |
 |                        |                        |─checkNodeVersion()    |                   |               |
 |                        |                        |─checkKiroCli()────────|───kiro-cli --version              |
 |                        |                        |─detectScope(cwd)──────|───walk upward     |               |
 |                        |                        |                       |   for markers     |               |
 |                        |                        |─createLayout()────────|───mkdir -p        |               |
 |                        |                        |─deployPayload()───────|───cp dist/ → lib/ |               |
 |                        |                        |─writePackageJson()────|───write pkg.json  |               |
 |                        |                        |─installDeps()─────────|───────────────────|─npm install   |
 |                        |                        |─writeBinWrappers()────|───write + chmod   |               |
 |                        |                        |─writeSettings()───────|───write if new    |               |
 |                        |                        |─writeAgentConfigs()───|───write agents    |               |
 |                        |                        |─setDefaultAgent()─────|───kiro-cli agent set-default     |
 |                        |                        |─startDaemon()─────────|───────────────────|───────────────|─spawn
 |                        |                        |                       |───write PID       |               |
 |                        |                        |─printSummary()        |                   |               |
 |<─exit 0────────────────|                        |                       |                   |               |
```

### Init sequence (upgrade)

```
User                    bin.ts              installer/index.ts         Filesystem            Collector
 |                        |                        |                       |                    |
 |─npx kiro-learn init──>|                        |                       |                    |
 |                        |─dispatch('init')──────>|                       |                    |
 |                        |                        |─checkNodeVersion()    |                    |
 |                        |                        |─checkKiroCli()        |                    |
 |                        |                        |─detectScope(cwd)      |                    |
 |                        |                        |─stopDaemon()──────────|───read PID         |
 |                        |                        |                       |                    |─SIGTERM
 |                        |                        |                       |───rm PID           |
 |                        |                        |─deployPayload()───────|───rm lib/ + cp     |
 |                        |                        |─installDeps()─────────|───rm node_modules/ |
 |                        |                        |                       |   + npm install    |
 |                        |                        |─writeBinWrappers()────|───write + chmod    |
 |                        |                        |─writeAgentConfigs()───|───overwrite agents |
 |                        |                        |─startDaemon()─────────|───spawn + PID      |
 |                        |                        |─printSummary()        |                    |
 |<─exit 0────────────────|                        |                       |                    |
```

## Module Structure

### Dependency direction

```
src/installer/bin.ts
    └── imports from → src/installer/index.ts
                            └── imports from → src/collector/index.ts  (startCollector only)
                            └── imports from → src/types/index.ts      (type imports only)
```

| Module | May import from | Must NOT import from |
|--------|----------------|---------------------|
| `src/installer/bin.ts` | `src/installer/index.ts` | `src/collector/`, `src/shim/`, `src/types/` |
| `src/installer/index.ts` | `src/collector/index.ts` (for `startCollector`), `src/types/` | `src/shim/` |

The installer imports `startCollector` from the collector to start the daemon in-process during `init`. It does NOT import from the shim — the shim is invoked via the bin wrapper scripts, not as a library call.

### File layout

```
src/installer/
├── bin.ts          # CLI entry point: argv parsing, dispatch, exit codes
└── index.ts        # Command implementations: init, start, stop, status, uninstall
```

All installer logic lives in two files. `bin.ts` is the thin entry point wired to `package.json#bin`. `index.ts` exports the command handlers and shared utilities (scope detection, daemon management, agent config generation).


## Components and Interfaces

### Component 1: CLI Entry Point (`src/installer/bin.ts`)

**Purpose.** Parse `process.argv`, dispatch to the correct command handler, and set the exit code. This is the `#!/usr/bin/env node` script wired to `package.json#bin`.

**Interface.**

```typescript
#!/usr/bin/env node

/**
 * CLI entry point for `kiro-learn`.
 *
 * Parses argv, dispatches to command handlers, sets exit code.
 * No third-party CLI framework — argv is simple enough for manual parsing.
 *
 * @see Requirements 1.1–1.7
 */

// No exported interface — this is a script, not a library.
// Internally calls functions from src/installer/index.ts.
```

**Argv parsing rules:**

| Input | Behavior |
|-------|----------|
| `kiro-learn init` | Call `cmdInit({ setDefault: true, yes: false, globalOnly: false })` |
| `kiro-learn init --no-set-default` | Call `cmdInit({ setDefault: false, yes: false, globalOnly: false })` |
| `kiro-learn init --yes` or `kiro-learn init -y` | Call `cmdInit({ setDefault: true, yes: true, globalOnly: false })` |
| `kiro-learn init --global-only` | Call `cmdInit({ setDefault: true, yes: false, globalOnly: true })` |
| `kiro-learn init --no-set-default --yes` | Call `cmdInit({ setDefault: false, yes: true, globalOnly: false })` |
| `kiro-learn start` | Call `cmdStart()` |
| `kiro-learn stop` | Call `cmdStop()` |
| `kiro-learn status` | Call `cmdStatus()` |
| `kiro-learn uninstall` | Call `cmdUninstall({ keepData: false })` |
| `kiro-learn uninstall --keep-data` | Call `cmdUninstall({ keepData: true })` |
| `kiro-learn --version` | Print version, exit 0 |
| `kiro-learn --help` or no args | Print usage, exit 0 |
| `kiro-learn <unknown>` | Print error + valid commands to stderr, exit 1 |

**Key design decisions:**

1. **No CLI framework.** `process.argv` has at most 4 elements (`node`, `bin.ts`, `command`, `--flag`). A library like `commander` or `yargs` would be overkill and violate the "no additional runtime dependencies" constraint.

2. **Version from package.json.** Read via `fs.readFileSync` relative to `import.meta.url`, same pattern as the shim.

3. **Exit codes.** The entry point sets `process.exitCode` based on the command handler's return. Handlers return `0` for success, `1` for failure. The entry point never calls `process.exit()` directly — it lets the event loop drain.

### Component 2: Installer Module (`src/installer/index.ts`)

**Purpose.** All command implementations and shared utilities. Exports one function per command plus internal helpers.

**Interface.**

```typescript
import type { CollectorHandle } from '../collector/index.js';

// ── Constants ───────────────────────────────────────────────────────────

/** The install directory. Always under the user's home. */
export const INSTALL_DIR: string;  // path.join(homedir(), '.kiro-learn')

/** Minimum required Node.js major version. */
export const MIN_NODE_VERSION = 22;

// ── Types ───────────────────────────────────────────────────────────────

/** Detected install scope. */
export interface InstallScope {
  /** Always true — global agent configs are always written. */
  global: true;
  /** When a project is detected, the absolute path to the project root. */
  projectRoot: string | undefined;
  /** The project marker that triggered detection (e.g., '.git', 'package.json'), or undefined if no project detected. */
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

// ── Scope detection ─────────────────────────────────────────────────────

/**
 * Walk from `cwd` upward looking for any project marker (e.g. `.kiro/`,
 * `.git/`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, etc.).
 *
 * Multi-signal detection: `.kiro/` is not assumed to exist on fresh machines
 * or in repos that have never used Kiro. Any conventional project marker
 * from a supported ecosystem qualifies the ancestor as the Project_Root.
 *
 * - If cwd is above $HOME → throw (fail fast).
 * - If cwd is $HOME or no marker found before $HOME → global-only.
 * - If any marker found below $HOME → global + project scope, with the
 *   NEAREST marker (first match during upward walk) winning.
 * - Walk ceiling is $HOME (never traverses at or above it).
 *
 * @see Requirements 15.1–15.9
 */
export function detectScope(cwd: string): InstallScope;

// ── Precondition checks ────────────────────────────────────────────────

/**
 * Verify Node.js version >= 22. Throws with a descriptive message if not.
 *
 * @see Non-functional N7
 */
export function checkNodeVersion(): void;

/**
 * Verify kiro-cli is installed by running `kiro-cli --version`.
 * Throws with install instructions if not found or non-zero exit.
 *
 * @see Requirements 16.1–16.4
 */
export function checkKiroCli(): void;

// ── Directory and file operations ───────────────────────────────────────

/**
 * Create the ~/.kiro-learn/ directory structure.
 * Creates bin/, lib/, logs/ subdirectories.
 * Creates ~/.kiro/agents/ for global agent configs.
 * Optionally creates <projectRoot>/.kiro/agents/ for project scope.
 *
 * @see Requirements 2.1–2.6
 */
export function createLayout(scope: InstallScope): void;

/**
 * Copy the compiled dist/ payload into ~/.kiro-learn/lib/.
 * On upgrade, removes the existing lib/ first.
 * Source path is resolved relative to the installer's own location.
 *
 * @see Requirements 3.1–3.3
 */
export function deployPayload(): void;

/**
 * Write a minimal package.json to ~/.kiro-learn/ listing only
 * production runtime dependencies with pinned versions.
 *
 * @see Requirements 3.4
 */
export function writePackageJson(): void;

/**
 * Run `npm install --production` in ~/.kiro-learn/.
 * On upgrade, removes existing node_modules/ first.
 * Spawns npm synchronously via child_process.execSync.
 *
 * @see Requirements 4.1–4.4
 */
export function installDeps(): void;

/**
 * Write the three bin wrapper scripts (shim, collector, kiro-learn)
 * to ~/.kiro-learn/bin/ and chmod 0o755.
 *
 * @see Requirements 5.1–5.5
 */
export function writeBinWrappers(): void;

/**
 * Write the default settings.json if it does not already exist.
 *
 * @see Requirements 14.1–14.3
 */
export function writeSettings(): void;

/**
 * Generate and write both agent config files at all applicable scopes.
 *
 * - kiro-learn.json: global always, project-scoped when detected.
 * - kiro-learn-compressor.json: global only.
 *
 * @see Requirements 6.1–6.11
 */
export function writeAgentConfigs(scope: InstallScope): void;

/**
 * Run `kiro-cli agent set-default kiro-learn`.
 * Logs a warning on failure but does not throw.
 *
 * @see Requirements 7.1–7.3
 */
export function setDefaultAgent(): void;

// ── Interactive prompts ──────────────────────────────────────────────────

/**
 * Prompt the user with a yes/no question on an interactive TTY.
 * Returns true for Y/y/empty (Enter), false for N/n.
 * Uses node:readline for synchronous-style TTY input.
 *
 * @see Requirements 18.1–18.3
 */
export function promptYesNo(question: string): Promise<boolean>;

// ── Daemon lifecycle ────────────────────────────────────────────────────

/**
 * Check if the collector daemon is running.
 * Reads the PID file and probes with process.kill(pid, 0).
 * Returns the PID if alive, null if not running or stale.
 * Cleans up stale PID files.
 *
 * @see Requirements 10.2, 9.5, 9.6
 */
export function getDaemonPid(): number | null;

/**
 * Start the collector daemon as a detached background process.
 * Spawns ~/.kiro-learn/bin/collector with detached: true.
 * Writes PID to ~/.kiro-learn/collector.pid.
 * Redirects stdout/stderr to ~/.kiro-learn/logs/collector-YYYY-MM-DD.log.
 *
 * @see Requirements 8.1–8.7
 */
export function startDaemon(): void;

/**
 * Stop the collector daemon.
 * SIGTERM → wait up to 5s → SIGKILL.
 * Removes the PID file after the process exits.
 *
 * @see Requirements 9.1–9.6
 */
export function stopDaemon(): void;

// ── Command handlers ────────────────────────────────────────────────────

/**
 * The `init` command. Orchestrates the full install/upgrade flow.
 * Returns 0 on success, 1 on failure.
 *
 * @see Requirements 1.2, 2–8, 12, 13, 14, 15, 16, 17, 18
 */
export async function cmdInit(opts: InitOptions): Promise<number>;

/**
 * The `start` command. Starts the daemon if not already running.
 * Returns 0 on success, 1 on failure.
 *
 * @see Requirements 8.2, 8.6, 8.7
 */
export function cmdStart(): number;

/**
 * The `stop` command. Stops the daemon if running.
 * Returns 0 on success (including "not running"), 1 on failure.
 *
 * @see Requirements 9.1–9.6
 */
export function cmdStop(): number;

/**
 * The `status` command. Prints install and daemon status.
 * Returns 0 if installed, 1 if not installed.
 *
 * @see Requirements 10.1–10.7
 */
export function cmdStatus(): number;

/**
 * The `uninstall` command. Removes kiro-learn from the system.
 * Returns 0 on success (including "not installed"), 1 on failure.
 *
 * @see Requirements 11.1–11.7
 */
export function cmdUninstall(opts: UninstallOptions): number;
```

**Key design decisions:**

1. **Synchronous filesystem APIs.** The installer is a short-lived CLI process. `mkdirSync`, `writeFileSync`, `cpSync`, `rmSync` are simpler and avoid callback/promise complexity. The only async operations are `npm install` (spawned as a child process) and daemon spawn.

2. **Command handlers return exit codes.** The entry point (`bin.ts`) sets `process.exitCode` from the return value. This keeps the handlers testable without mocking `process.exit`.

3. **`detectScope` is a pure function of `cwd`.** It reads the filesystem but has no side effects. This makes it independently testable.

4. **`startDaemon` spawns the bin wrapper, not `startCollector` directly.** The daemon must outlive the installer process. Spawning `~/.kiro-learn/bin/collector` as a detached child process with `unref()` ensures the daemon runs independently. The installer process exits immediately after spawn.


## Algorithms

### Algorithm: bin.ts main

```pascal
ALGORITHM main()

BEGIN
  args ← process.argv.slice(2)
  command ← args[0]

  IF command = '--version' THEN
    version ← readPackageVersion()
    stdout.write('kiro-learn ' + version + '\n')
    process.exitCode ← 0
    RETURN
  END IF

  IF command = '--help' OR command is undefined THEN
    printUsage()
    process.exitCode ← 0
    RETURN
  END IF

  flags ← args.slice(1)

  SWITCH command
    CASE 'init':
      setDefault ← NOT flags.includes('--no-set-default')
      yes ← flags.includes('--yes') OR flags.includes('-y')
      globalOnly ← flags.includes('--global-only')
      process.exitCode ← AWAIT cmdInit({ setDefault, yes, globalOnly })

    CASE 'start':
      process.exitCode ← cmdStart()

    CASE 'stop':
      process.exitCode ← cmdStop()

    CASE 'status':
      process.exitCode ← cmdStatus()

    CASE 'uninstall':
      keepData ← flags.includes('--keep-data')
      process.exitCode ← cmdUninstall({ keepData })

    DEFAULT:
      stderr.write('[kiro-learn] unknown command: ' + command + '\n')
      stderr.write('Valid commands: init, start, stop, status, uninstall\n')
      process.exitCode ← 1
  END SWITCH
END
```

### Algorithm: cmdInit()

```pascal
ALGORITHM cmdInit(opts)
INPUT: opts ∈ InitOptions
OUTPUT: Promise<number> (exit code 0 or 1)

BEGIN
  TRY
    // Precondition checks (before any filesystem modifications)
    checkNodeVersion()
    checkKiroCli()

    scope ← detectScope(process.cwd())

    // Apply --global-only override
    IF opts.globalOnly THEN
      scope ← { global: true, projectRoot: undefined, detectedMarker: undefined }
      log('Forced global-only scope (--global-only)')
    ELSE IF scope.projectRoot ≠ undefined THEN
      // Confirm project scope with user
      IF NOT opts.yes AND process.stdout.isTTY THEN
        accepted ← AWAIT promptYesNo('Detected project at ' + scope.projectRoot + ' (via ' + scope.detectedMarker + '). Install project-scoped agent config here? [Y/n] ')
        IF NOT accepted THEN
          scope ← { global: true, projectRoot: undefined, detectedMarker: undefined }
          log('User declined project scope, using global-only')
        END IF
      ELSE
        log('Project detected at ' + scope.projectRoot + ' (via ' + scope.detectedMarker + ')')
      END IF
    END IF

    log('Detected scope: ' + formatScope(scope))

    isUpgrade ← existsSync(INSTALL_DIR)

    IF isUpgrade THEN
      log('Existing install detected, upgrading...')
      stopDaemon()  // stop running daemon before replacing files
    END IF

    // Create directory structure
    log('Creating ~/.kiro-learn/...')
    createLayout(scope)

    // Deploy payload
    log('Deploying payload...')
    deployPayload()

    // Write package.json for runtime deps
    writePackageJson()

    // Install runtime dependencies
    log('Installing dependencies...')
    installDeps()

    // Write bin wrappers
    log('Writing bin wrappers...')
    writeBinWrappers()

    // Write default settings (only if new install)
    writeSettings()

    // Write agent configs at all applicable scopes
    log('Writing agent configs...')
    writeAgentConfigs(scope)

    // Optionally set default agent
    IF opts.setDefault THEN
      setDefaultAgent()
    END IF

    // Start daemon
    log('Starting collector daemon...')
    startDaemon()

    // Print summary
    printSummary(scope)

    RETURN 0

  CATCH error
    stderr.write('[kiro-learn] init failed: ' + error.message + '\n')

    // Cleanup on fresh install failure (before payload deployment)
    IF NOT isUpgrade AND partialLayoutCreated THEN
      TRY rmSync(INSTALL_DIR, { recursive: true }) CATCH ignore END TRY
    END IF

    RETURN 1
  END TRY
END
```

### Algorithm: detectScope()

```pascal
ALGORITHM detectScope(cwd)
INPUT: cwd ∈ string (absolute path)
OUTPUT: InstallScope

CONST PROJECT_MARKERS = [
  '.kiro',          // existing Kiro project (directory)
  '.git',           // git repo (directory)
  'package.json',   // Node.js (file)
  'Cargo.toml',     // Rust (file)
  'pyproject.toml', // Python (file)
  'setup.py',       // Python (file)
  'go.mod',         // Go (file)
  'pom.xml',        // Java/Maven (file)
  'build.gradle',   // Java/Gradle (file)
  'build.gradle.kts', // Kotlin/Gradle (file)
  'Gemfile',        // Ruby (file)
  'composer.json',  // PHP (file)
  'mix.exs',        // Elixir (file)
  'deno.json',      // Deno (file)
  'deno.jsonc',     // Deno (file)
]

BEGIN
  home ← os.homedir()
  resolved ← fs.realpathSync(cwd)

  // Fail fast if cwd is above $HOME
  IF NOT resolved.startsWith(home + path.sep) AND resolved ≠ home THEN
    THROW Error('Cannot install from outside home directory tree')
  END IF

  // If cwd is exactly $HOME, global-only
  IF resolved = home THEN
    RETURN { global: true, projectRoot: undefined, detectedMarker: undefined }
  END IF

  // Walk upward from cwd looking for any project marker
  current ← resolved
  WHILE current ≠ home AND current ≠ path.dirname(current) DO
    FOR EACH marker IN PROJECT_MARKERS DO
      markerPath ← path.join(current, marker)
      IF existsSync(markerPath) THEN
        RETURN {
          global: true,
          projectRoot: current,
          detectedMarker: marker,
        }
      END IF
    END FOR
    current ← path.dirname(current)
  END WHILE

  // No marker found before $HOME — global-only
  RETURN { global: true, projectRoot: undefined, detectedMarker: undefined }
END
```

**Notes:**
- The walk starts at `cwd` (inclusive) and moves upward. If `cwd` itself contains a project marker, that's the project root.
- The walk stops before `$HOME` (exclusive). We never examine `$HOME` itself or anything above it. In particular, `$HOME/.kiro/` is never treated as a project indicator — it is the global Kiro config directory, not a project.
- `PROJECT_MARKERS` is iterated in order at each directory; the first matching marker wins. Markers are not ranked across ecosystems — nearest-directory-wins is the only precedence rule. Within a single directory, iteration order determines which marker is reported in `detectedMarker`, but any match at that level produces the same `projectRoot`.
- `path.dirname(current) === current` is the filesystem root guard (prevents infinite loop on `/`). In practice the `current ≠ home` guard trips first for any `cwd` below `$HOME`.
- **Why being inside `~/.kiro/` falls through to global-only:** If `cwd` is `~/.kiro/` (or `~/.kiro/agents/`, etc.), the walk examines that directory first. Typically no markers exist inside `~/.kiro/` itself, so the walk moves up. The next step would be `$HOME`, but the `current ≠ home` guard halts the walk before examining it. Result: no `projectRoot`, global-only scope — which is the correct outcome, because `~/.kiro/` is user-global configuration, not a project.

### Algorithm: deployPayload()

```pascal
ALGORITHM deployPayload()

BEGIN
  libDir ← path.join(INSTALL_DIR, 'lib')

  // Determine source: the dist/ directory of the npm package.
  // bin.ts is at dist/installer/bin.js, so dist/ is two levels up.
  thisFile ← fileURLToPath(import.meta.url)
  distDir ← path.resolve(path.dirname(thisFile), '..')

  // On upgrade, remove existing lib/
  IF existsSync(libDir) THEN
    rmSync(libDir, { recursive: true, force: true })
  END IF

  mkdirSync(libDir, { recursive: true })

  // Copy each subdirectory: shim/, collector/, installer/, types/
  FOR EACH subdir IN ['shim', 'collector', 'installer', 'types'] DO
    src ← path.join(distDir, subdir)
    dst ← path.join(libDir, subdir)
    cpSync(src, dst, { recursive: true })
  END FOR
END
```

### Algorithm: writeBinWrappers()

```pascal
ALGORITHM writeBinWrappers()

BEGIN
  binDir ← path.join(INSTALL_DIR, 'bin')

  // Shim wrapper
  shimContent ← [
    '#!/usr/bin/env node',
    'import { main } from "../lib/shim/cli-agent/index.js";',
    'main().catch(() => {});',
  ].join('\n') + '\n'

  writeFileSync(path.join(binDir, 'shim'), shimContent)
  chmodSync(path.join(binDir, 'shim'), 0o755)

  // Collector wrapper
  collectorContent ← [
    '#!/usr/bin/env node',
    'import { startCollector } from "../lib/collector/index.js";',
    'const handle = await startCollector();',
    'process.on("SIGTERM", async () => { await handle.close(); process.exit(0); });',
    'process.on("SIGINT", async () => { await handle.close(); process.exit(0); });',
  ].join('\n') + '\n'

  writeFileSync(path.join(binDir, 'collector'), collectorContent)
  chmodSync(path.join(binDir, 'collector'), 0o755)

  // CLI wrapper
  cliContent ← [
    '#!/usr/bin/env node',
    'import "../lib/installer/bin.js";',
  ].join('\n') + '\n'

  writeFileSync(path.join(binDir, 'kiro-learn'), cliContent)
  chmodSync(path.join(binDir, 'kiro-learn'), 0o755)
END
```

**Notes:**
- All wrappers use ESM `import` syntax. The installed `package.json` sets `"type": "module"`.
- The collector wrapper registers `SIGTERM` and `SIGINT` handlers to call `handle.close()` for graceful shutdown. This ensures the SQLite database is closed properly when `stop` sends `SIGTERM`.
- The shim wrapper swallows rejections with `.catch(() => {})` — the shim's own `main()` already has a top-level try/catch, but this is a safety net.

### Algorithm: writeAgentConfigs()

```pascal
ALGORITHM writeAgentConfigs(scope)
INPUT: scope ∈ InstallScope

BEGIN
  shimPath ← path.join(INSTALL_DIR, 'bin', 'shim')

  // ── Agent 1: kiro-learn.json (hook-registering agent) ──

  kiroLearnConfig ← {
    name: 'kiro-learn',
    description: 'Continuous learning for Kiro sessions. Captures tool-use events and injects prior context.',
    hooks: {
      agentSpawn: [
        { command: shimPath + ' || true' }
      ],
      userPromptSubmit: [
        { command: shimPath + ' || true' }
      ],
      postToolUse: [
        { matcher: '*', command: shimPath + ' || true' }
      ],
      stop: [
        { command: shimPath + ' || true' }
      ]
    }
  }

  // Write global
  globalAgentsDir ← path.join(homedir(), '.kiro', 'agents')
  writeFileSync(
    path.join(globalAgentsDir, 'kiro-learn.json'),
    JSON.stringify(kiroLearnConfig, null, 2) + '\n'
  )

  // Write project-scoped if detected
  IF scope.projectRoot ≠ undefined THEN
    projectAgentsDir ← path.join(scope.projectRoot, '.kiro', 'agents')
    writeFileSync(
      path.join(projectAgentsDir, 'kiro-learn.json'),
      JSON.stringify(kiroLearnConfig, null, 2) + '\n'
    )
  END IF

  // ── Agent 2: kiro-learn-compressor.json (extraction agent) ──

  compressorConfig ← {
    name: 'kiro-learn-compressor',
    description: 'Memory record extraction agent for kiro-learn. Distills events into structured memory records.',
    prompt: COMPRESSOR_PROMPT,
    tools: [],
    allowedTools: []
  }

  writeFileSync(
    path.join(globalAgentsDir, 'kiro-learn-compressor.json'),
    JSON.stringify(compressorConfig, null, 2) + '\n'
  )
END
```

**Compressor prompt content:**

```
You are a memory extraction agent for kiro-learn. Your job is to distill the
provided event content into a structured memory record.

Analyze the content and produce a JSON object with these fields:
- title: A concise title (max 200 chars) summarizing the key observation
- summary: A detailed summary (max 4000 chars) of what happened
- facts: An array of discrete factual statements extracted from the content
- concepts: An array of key concepts, technologies, or patterns mentioned
- observation_type: One of "tool_use", "decision", "error", "discovery", "pattern"
- files_touched: An array of file paths mentioned or modified

Respond with ONLY the JSON object, no markdown fencing, no explanation.
```

### Algorithm: startDaemon()

```pascal
ALGORITHM startDaemon()

BEGIN
  // Check if already running
  existingPid ← getDaemonPid()
  IF existingPid ≠ null THEN
    log('Daemon already running (PID ' + existingPid + ')')
    RETURN
  END IF

  collectorBin ← path.join(INSTALL_DIR, 'bin', 'collector')
  logsDir ← path.join(INSTALL_DIR, 'logs')
  dateStr ← new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
  logFile ← path.join(logsDir, 'collector-' + dateStr + '.log')

  // Open log file for append
  logFd ← openSync(logFile, 'a')

  child ← spawn(process.execPath, [collectorBin], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  })

  // Write PID file
  pidFile ← path.join(INSTALL_DIR, 'collector.pid')
  writeFileSync(pidFile, String(child.pid) + '\n')
  chmodSync(pidFile, 0o644)

  // Detach — let the daemon outlive the installer
  child.unref()
  closeSync(logFd)

  log('Daemon started (PID ' + child.pid + ')')
END
```

**Notes:**
- `process.execPath` is used instead of `'node'` to ensure the same Node.js binary that runs the installer also runs the daemon.
- `detached: true` + `child.unref()` ensures the installer process can exit while the daemon continues.
- `stdio: ['ignore', logFd, logFd]` redirects both stdout and stderr to the date-stamped log file.

### Algorithm: stopDaemon()

```pascal
ALGORITHM stopDaemon()

BEGIN
  pidFile ← path.join(INSTALL_DIR, 'collector.pid')

  IF NOT existsSync(pidFile) THEN
    log('No PID file found, daemon is not running')
    RETURN
  END IF

  pidStr ← readFileSync(pidFile, 'utf8').trim()
  pid ← parseInt(pidStr, 10)

  IF isNaN(pid) THEN
    log('Invalid PID file, removing')
    unlinkSync(pidFile)
    RETURN
  END IF

  // Check if process is alive
  TRY
    process.kill(pid, 0)  // signal 0 = liveness check
  CATCH
    log('Stale PID file (process ' + pid + ' not running), removing')
    unlinkSync(pidFile)
    RETURN
  END TRY

  // Send SIGTERM
  log('Stopping daemon (PID ' + pid + ')...')
  process.kill(pid, 'SIGTERM')

  // Wait up to 5 seconds for exit
  deadline ← Date.now() + 5000
  WHILE Date.now() < deadline DO
    TRY
      process.kill(pid, 0)  // still alive?
      sleepSync(100)        // busy-wait in 100ms increments
    CATCH
      // Process exited
      BREAK
    END TRY
  END WHILE

  // If still alive after 5s, SIGKILL
  TRY
    process.kill(pid, 0)
    log('Daemon did not exit, sending SIGKILL')
    process.kill(pid, 'SIGKILL')
  CATCH
    // Already exited
  END TRY

  // Remove PID file
  TRY unlinkSync(pidFile) CATCH ignore END TRY

  log('Daemon stopped')
END
```

**Notes:**
- `sleepSync(100)` is implemented as a busy-wait using `Atomics.wait` on a `SharedArrayBuffer` or a tight loop with `Date.now()`. Since the installer is a short-lived CLI, blocking the event loop for up to 5 seconds is acceptable.
- The SIGTERM → wait → SIGKILL pattern gives the collector time to close the SQLite database cleanly.

### Algorithm: promptYesNo()

```pascal
ALGORITHM promptYesNo(question)
INPUT: question ∈ string
OUTPUT: Promise<boolean>

BEGIN
  rl ← readline.createInterface({ input: process.stdin, output: process.stdout })

  answer ← AWAIT new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close()
      resolve(ans.trim().toLowerCase())
    })
  })

  RETURN answer = '' OR answer = 'y' OR answer = 'yes'
END
```

**Notes:**
- Uses `node:readline` for TTY input. Since `promptYesNo` is async, `cmdInit` must also be async and `bin.ts` must await it.
- Invalid input (anything other than Y/y/N/n/empty) is treated as "Y" (default accept) to avoid blocking the user.

### Algorithm: cmdStatus()

```pascal
ALGORITHM cmdStatus()
OUTPUT: exit code (0 or 1)

BEGIN
  IF NOT existsSync(INSTALL_DIR) THEN
    stderr.write('[kiro-learn] not installed\n')
    RETURN 1
  END IF

  // Daemon status
  pid ← getDaemonPid()
  IF pid ≠ null THEN
    stdout.write('status: running\n')
    stdout.write('pid: ' + pid + '\n')
  ELSE
    stdout.write('status: stopped\n')
  END IF

  // Install info
  stdout.write('install_dir: ' + INSTALL_DIR + '\n')

  // Database
  dbPath ← path.join(INSTALL_DIR, 'kiro-learn.db')
  stdout.write('database: ' + dbPath + '\n')
  stdout.write('database_exists: ' + existsSync(dbPath) + '\n')

  // Version
  TRY
    pkgPath ← path.join(INSTALL_DIR, 'lib', 'installer', '..', '..', 'package.json')
    // Actually read from the deployed package.json at ~/.kiro-learn/package.json
    pkgRaw ← readFileSync(path.join(INSTALL_DIR, 'package.json'), 'utf8')
    version ← JSON.parse(pkgRaw).version
    stdout.write('version: ' + version + '\n')
  CATCH
    stdout.write('version: unknown\n')
  END TRY

  RETURN 0
END
```

### Algorithm: cmdUninstall()

```pascal
ALGORITHM cmdUninstall(opts)
INPUT: opts ∈ UninstallOptions
OUTPUT: exit code (0 or 1)

BEGIN
  IF NOT existsSync(INSTALL_DIR) THEN
    stdout.write('[kiro-learn] not installed, nothing to uninstall\n')
    RETURN 0
  END IF

  TRY
    // Stop daemon
    stopDaemon()

    // Detect scope for project-level cleanup
    TRY
      scope ← detectScope(process.cwd())
    CATCH
      scope ← { global: true, projectRoot: undefined, detectedMarker: undefined }
    END TRY

    // Remove global agent configs
    globalAgentsDir ← path.join(homedir(), '.kiro', 'agents')
    FOR EACH name IN ['kiro-learn.json', 'kiro-learn-compressor.json'] DO
      agentPath ← path.join(globalAgentsDir, name)
      IF existsSync(agentPath) THEN
        unlinkSync(agentPath)
      END IF
    END FOR

    // Remove project-scoped agent config if applicable
    IF scope.projectRoot ≠ undefined THEN
      projectAgent ← path.join(scope.projectRoot, '.kiro', 'agents', 'kiro-learn.json')
      IF existsSync(projectAgent) THEN
        unlinkSync(projectAgent)
      END IF
    END IF

    // Remove install directory
    IF opts.keepData THEN
      // Remove bin/, lib/, node_modules/ but keep db, settings, logs
      FOR EACH subdir IN ['bin', 'lib', 'node_modules'] DO
        dirPath ← path.join(INSTALL_DIR, subdir)
        IF existsSync(dirPath) THEN
          rmSync(dirPath, { recursive: true, force: true })
        END IF
      END FOR
      // Remove PID file and package.json
      FOR EACH file IN ['collector.pid', 'package.json'] DO
        filePath ← path.join(INSTALL_DIR, file)
        IF existsSync(filePath) THEN unlinkSync(filePath) END IF
      END FOR
    ELSE
      rmSync(INSTALL_DIR, { recursive: true, force: true })
    END IF

    stdout.write('[kiro-learn] uninstalled successfully\n')
    RETURN 0

  CATCH error
    stderr.write('[kiro-learn] uninstall failed: ' + error.message + '\n')
    RETURN 1
  END TRY
END
```


## Data Models

### Installed directory layout

```
~/.kiro-learn/
├── bin/
│   ├── kiro-learn            # CLI entry: dispatches to lib/installer/bin.js
│   ├── shim                  # Hook entry: calls lib/shim/cli-agent/index.js main()
│   └── collector             # Daemon entry: calls lib/collector/index.js startCollector()
├── lib/                      # Compiled payload (dist/ copied here)
│   ├── shim/
│   │   ├── cli-agent/
│   │   │   └── index.js
│   │   └── shared/
│   │       └── index.js
│   ├── collector/
│   │   ├── index.js
│   │   ├── pipeline/
│   │   ├── receiver/
│   │   ├── retrieval/
│   │   ├── query/
│   │   └── storage/
│   ├── installer/
│   │   ├── bin.js
│   │   └── index.js
│   └── types/
│       ├── index.js
│       └── schemas.js
├── node_modules/             # Runtime deps (better-sqlite3, ulidx, zod)
├── package.json              # Minimal: { dependencies, type: "module" }
├── kiro-learn.db             # SQLite store (created by collector on first run)
├── settings.json             # User-editable config (created by init if missing)
├── collector.pid             # PID of running daemon (created by start)
└── logs/
    └── collector-YYYY-MM-DD.log
```

### Agent config: `kiro-learn.json`

Written to `~/.kiro/agents/kiro-learn.json` (always) and `<Project_Root>/.kiro/agents/kiro-learn.json` (when project detected).

```json
{
  "name": "kiro-learn",
  "description": "Continuous learning for Kiro sessions. Captures tool-use events and injects prior context.",
  "hooks": {
    "agentSpawn": [
      { "command": "/Users/alice/.kiro-learn/bin/shim || true" }
    ],
    "userPromptSubmit": [
      { "command": "/Users/alice/.kiro-learn/bin/shim || true" }
    ],
    "postToolUse": [
      { "matcher": "*", "command": "/Users/alice/.kiro-learn/bin/shim || true" }
    ],
    "stop": [
      { "command": "/Users/alice/.kiro-learn/bin/shim || true" }
    ]
  }
}
```

**Notes:**
- The `command` field uses the absolute path to the shim wrapper, resolved from `os.homedir()` at install time. No tilde — Kiro's hook runner may not expand it.
- `|| true` ensures hook failures never block the agent lifecycle. The shim already exits 0 on all inputs, but this is a defense-in-depth measure.
- `"matcher": "*"` on `postToolUse` captures all tool invocations.

### Agent config: `kiro-learn-compressor.json`

Written to `~/.kiro/agents/kiro-learn-compressor.json` (global only).

```json
{
  "name": "kiro-learn-compressor",
  "description": "Memory record extraction agent for kiro-learn. Distills events into structured memory records.",
  "prompt": "You are a memory extraction agent for kiro-learn. Your job is to distill the provided event content into a structured memory record.\n\nAnalyze the content and produce a JSON object with these fields:\n- title: A concise title (max 200 chars) summarizing the key observation\n- summary: A detailed summary (max 4000 chars) of what happened\n- facts: An array of discrete factual statements extracted from the content\n- concepts: An array of key concepts, technologies, or patterns mentioned\n- observation_type: One of \"tool_use\", \"decision\", \"error\", \"discovery\", \"pattern\"\n- files_touched: An array of file paths mentioned or modified\n\nRespond with ONLY the JSON object, no markdown fencing, no explanation.",
  "tools": [],
  "allowedTools": []
}
```

**Notes:**
- This agent is invoked by the collector's extraction pipeline via `kiro-cli chat --no-interactive --agent kiro-learn-compressor "<event content>"`.
- `tools: []` and `allowedTools: []` ensure the compressor agent has no tool access — it is a pure text-in, JSON-out agent.
- The prompt instructs the model to output raw JSON. The extraction stage in the pipeline parses this JSON into a `MemoryRecord`.

### Settings file: `settings.json`

Written on first install only. Preserved across upgrades.

```json
{
  "collector": {
    "host": "127.0.0.1",
    "port": 21100
  },
  "shim": {
    "timeoutMs": 2000
  }
}
```

### Minimal `package.json` (written to `~/.kiro-learn/`)

```json
{
  "name": "kiro-learn-runtime",
  "version": "0.3.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "better-sqlite3": "12.0.0",
    "ulidx": "2.4.1",
    "zod": "3.23.0"
  }
}
```

**Notes:**
- `"type": "module"` is required because the bin wrappers and lib/ use ESM `import` syntax.
- Dependency versions are pinned (no `^` or `~`) to ensure reproducible installs.
- The version field matches the npm package version at install time.

### PID file: `collector.pid`

```
12345
```

A single line containing the decimal PID of the collector daemon process. Permissions `0o644`.

### Status output format

```
status: running
pid: 12345
install_dir: /Users/alice/.kiro-learn
database: /Users/alice/.kiro-learn/kiro-learn.db
database_exists: true
version: 0.3.0
```

Key-value pairs, one per line, parseable by scripts (Requirement N11).


## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Unrecognized command rejection

*For any* string that is not one of the five valid commands (`init`, `start`, `stop`, `status`, `uninstall`) and not a recognized flag (`--help`, `--version`), invoking the CLI with that string as the first argument SHALL produce exit code 1 and write an error message to stderr that lists the valid commands.

**Validates: Requirements 1.4**

### Property 2: Upgrade data preservation

*For any* existing install containing a `kiro-learn.db` file, a `settings.json` file, and files under `logs/`, running `init` (upgrade) SHALL preserve the byte-identical contents of `kiro-learn.db`, `settings.json`, and all files under `logs/`. The `lib/`, `bin/`, and `node_modules/` directories may be replaced, but user data files SHALL be untouched.

**Validates: Requirements 2.7, 12.5**

### Property 3: Hook command format

*For any* generated `kiro-learn.json` agent config (at any scope), every `command` field in every hook entry SHALL contain the absolute path to `~/.kiro-learn/bin/shim` (with the actual home directory, no tilde) and SHALL end with ` || true`.

**Validates: Requirements 6.4**

### Property 4: Uninstall --keep-data selective preservation

*For any* existing install containing user data files (`kiro-learn.db`, `settings.json`, `logs/*`), running `uninstall --keep-data` SHALL remove `bin/`, `lib/`, and `node_modules/` directories, and SHALL preserve the byte-identical contents of `kiro-learn.db`, `settings.json`, and all files under `logs/`.

**Validates: Requirements 11.5**

### Property 5: Error message prefix

*For any* error condition that causes the installer to write to stderr, the output SHALL contain the prefix `[kiro-learn]`.

**Validates: Requirements 13.5**

### Property 6: Scope detection correctness

*For any* directory path `cwd` that is at or below `$HOME`, `detectScope(cwd)` SHALL return `projectRoot` equal to the nearest ancestor directory (inclusive of `cwd`) that contains any project marker from the configured list, or `undefined` if no marker exists in any ancestor before reaching `$HOME`. When `projectRoot` is defined, `detectedMarker` SHALL equal the name of the first marker found at `projectRoot`. The walk SHALL stop before reaching `$HOME` (never considers `$HOME` itself or `$HOME/.kiro/` as a project root). For any `cwd` that is above `$HOME`, `detectScope` SHALL throw an error.

**Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8**


## Error Handling

### Error: Node.js version too old

**Condition.** `process.versions.node` major version is below 22.
**Behavior.** Print `[kiro-learn] Node.js 22 or later is required (found: <version>)` to stderr, exit 1.
**Recovery.** User upgrades Node.js.
**When checked.** First thing in `cmdInit`, before any filesystem operations.

### Error: kiro-cli not installed

**Condition.** `kiro-cli --version` fails (command not found or non-zero exit).
**Behavior.** Print `[kiro-learn] kiro-cli is not installed. kiro-learn depends on kiro-cli for memory extraction (the collector spawns 'kiro-cli chat --no-interactive --agent kiro-learn-compressor' to transform events into memory records). Install kiro-cli first, then re-run 'npx kiro-learn init'.` to stderr, exit 1.
**Recovery.** User installs kiro-cli.
**When checked.** After Node.js version check, before any filesystem operations.

### Error: cwd above $HOME

**Condition.** `detectScope` determines that `process.cwd()` is not at or below `$HOME`.
**Behavior.** Print `[kiro-learn] cannot install from outside the home directory tree (cwd: <path>)` to stderr, exit 1.
**Recovery.** User `cd`s into a directory under `$HOME`.
**When checked.** During scope detection, before directory creation.

### Error: Filesystem permission denied

**Condition.** Any `mkdirSync`, `writeFileSync`, `cpSync`, or `rmSync` call throws with `code: 'EACCES'` or `code: 'EPERM'`.
**Behavior.** Print `[kiro-learn] permission denied: <path> (<os error message>)` to stderr, exit 1.
**Recovery.** User fixes directory permissions or runs from a different location.

### Error: npm install failure

**Condition.** `execSync('npm install --production')` throws (non-zero exit code).
**Behavior.** Print `[kiro-learn] dependency installation failed` to stderr, followed by npm's stderr output, exit 1.
**Recovery.** User checks npm configuration, network connectivity, or Node.js native module build tools (for `better-sqlite3`).

### Error: Daemon spawn failure

**Condition.** `child_process.spawn` throws or the child process exits immediately.
**Behavior.** Print `[kiro-learn] failed to start collector daemon: <error>` to stderr, exit 1.
**Recovery.** User checks logs at `~/.kiro-learn/logs/collector-YYYY-MM-DD.log`.

### Error: Stale PID file

**Condition.** PID file exists but `process.kill(pid, 0)` throws `ESRCH` (no such process).
**Behavior.** Remove the stale PID file, log `[kiro-learn] removed stale PID file (process <pid> not running)` to stderr. Continue with the requested operation (start, stop, or init).
**Recovery.** Automatic — the stale file is cleaned up.

### Error: Daemon won't stop (SIGTERM ignored)

**Condition.** After sending SIGTERM, the process is still alive after 5 seconds.
**Behavior.** Send SIGKILL, remove PID file, log `[kiro-learn] daemon did not respond to SIGTERM, sent SIGKILL` to stderr.
**Recovery.** Automatic — SIGKILL is not ignorable.

### Error: Partial install cleanup

**Condition.** `cmdInit` fails after creating `~/.kiro-learn/` but before payload deployment completes (fresh install only).
**Behavior.** Remove the partially-created `~/.kiro-learn/` directory. Log the original error.
**Recovery.** User re-runs `init` after fixing the underlying issue.
**Note.** On upgrade, partial cleanup is NOT performed — the existing install (db, settings, logs) must be preserved even if the upgrade fails partway through.

### Error: Not installed

**Condition.** `stop`, `status`, or `uninstall` invoked when `~/.kiro-learn/` does not exist.
**Behavior.**
- `stop`: Print `[kiro-learn] not installed, nothing to stop`, exit 0.
- `status`: Print `[kiro-learn] not installed`, exit 1.
- `uninstall`: Print `[kiro-learn] not installed, nothing to uninstall`, exit 0.
**Recovery.** User runs `init` first (if they want to use kiro-learn).

## Testing Strategy

### Unit tests

Unit tests cover the installer's pure logic and filesystem operations using a temporary directory as a mock home. The installer functions accept paths derived from `INSTALL_DIR` (which is `path.join(homedir(), '.kiro-learn')`), so tests can override `homedir()` or use dependency injection to redirect all operations to a temp directory.

**Key unit test areas:**
- **Scope detection** (`detectScope`): Create temp directory trees with various project markers (`.kiro/`, `.git/`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, etc.) at various levels, verify correct scope detection and that `detectedMarker` matches the marker that triggered detection. Cover: `.kiro/`-only project, git-only repo, Node.js project without git, Rust project, Python project, nested projects (nearest-marker-wins), no project, cwd at home, cwd above home, cwd inside `~/.kiro/` (should fall through to global-only).
- **Bin wrapper content**: Verify generated wrapper scripts have correct shebang, import paths, and content.
- **Agent config generation**: Verify generated JSON is valid, contains all required hooks, uses absolute paths with `|| true`, compressor has correct prompt and empty tools.
- **Settings file**: Verify default content, verify preservation on re-init.
- **Status output format**: Verify key-value format is parseable.
- **Command routing**: Verify argv parsing dispatches to correct handlers.
- **Error messages**: Verify `[kiro-learn]` prefix on all error paths.
- **Project scope confirmation**: Mock TTY detection (`process.stdout.isTTY`), verify prompt is shown when TTY and project detected, verify prompt is skipped with `--yes`, verify `--global-only` forces global scope, verify non-TTY auto-accepts.

### Property-based tests

Property-based tests use `fast-check` (already a dev dependency) to verify universal properties across generated inputs. Each property test runs a minimum of 100 iterations.

**Property test configuration:**
- Library: `fast-check` (v4.7.0, already in devDependencies)
- Runner: `vitest` (already configured)
- Minimum iterations: 100 per property
- Tag format: `Feature: installer, Property N: <title>`

**Property tests to implement:**

1. **Feature: installer, Property 1: Unrecognized command rejection** — Generate random strings excluding valid commands, verify exit code 1 and stderr contains valid command list.

2. **Feature: installer, Property 2: Upgrade data preservation** — Generate random file contents for db/settings/logs, simulate upgrade, verify byte-identical preservation.

3. **Feature: installer, Property 3: Hook command format** — Generate agent configs with different home directory paths, verify all hook commands contain absolute shim path and `|| true` suffix.

4. **Feature: installer, Property 4: Uninstall --keep-data selective preservation** — Generate random file contents, simulate uninstall with --keep-data, verify selective preservation.

5. **Feature: installer, Property 5: Error message prefix** — Generate various error conditions, verify all stderr output contains `[kiro-learn]` prefix.

6. **Feature: installer, Property 6: Scope detection correctness** — Generate random directory hierarchies under a temp home, place various project markers (`.kiro/`, `.git/`, `package.json`, `Cargo.toml`, etc.) at different levels (including multiple markers in the same walk path), verify `detectScope` returns the correct `projectRoot` (nearest-marker-wins) and `detectedMarker` (the name of the marker that triggered detection). Additionally, when `--global-only` is set, the effective scope SHALL always be global-only regardless of what markers exist.

### Integration tests

Integration tests verify the end-to-end flows using a real (but isolated) filesystem under a temp directory. These mock external commands (`kiro-cli`, `npm`) but use real filesystem operations.

**Key integration test areas:**
- **Fresh init flow**: Full init in a temp home, verify all files created, daemon PID file written.
- **Upgrade flow**: Init twice, verify data preserved, payload replaced, daemon restarted.
- **Uninstall flow**: Init then uninstall, verify all files removed. Init then uninstall --keep-data, verify selective removal.
- **Start/stop/status**: Verify daemon lifecycle commands work correctly with PID file management.
- **kiro-cli dependency check**: Mock missing kiro-cli, verify init fails before any filesystem changes.

