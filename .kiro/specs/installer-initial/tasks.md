# Implementation Plan: kiro-learn Installer (CLI)

## Overview

Implement the kiro-learn installer — the `kiro-learn` CLI that ships as the npm package's `bin` entry and bootstraps a local runtime install under `~/.kiro-learn/`. The installer provides five commands (`init`, `start`, `stop`, `status`, `uninstall`) that manage the directory layout, payload deployment, runtime dependencies, bin wrappers, agent configs, and daemon lifecycle. Implementation is in TypeScript, split across two files: `src/installer/bin.ts` (CLI entry point) and `src/installer/index.ts` (command implementations and shared utilities).

## Tasks

- [x] 1. Implement precondition checks and scope detection in `src/installer/index.ts`
  - [x] 1.1 Define constants, types, and `PROJECT_MARKERS` array
    - Export `INSTALL_DIR` as `path.join(homedir(), '.kiro-learn')`
    - Export `MIN_NODE_VERSION = 22`
    - Export `InstallScope`, `InitOptions`, `UninstallOptions` interfaces
    - Define `PROJECT_MARKERS` constant with all 15 markers: `.kiro`, `.git`, `package.json`, `Cargo.toml`, `pyproject.toml`, `setup.py`, `go.mod`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `Gemfile`, `composer.json`, `mix.exs`, `deno.json`, `deno.jsonc`
    - _Requirements: 15.2_

  - [x] 1.2 Implement `checkNodeVersion()`
    - Parse `process.versions.node` major version
    - If below 22, throw with message `[kiro-learn] Node.js 22 or later is required (found: <version>)`
    - _Requirements: N7_

  - [x] 1.3 Implement `checkKiroCli()`
    - Run `kiro-cli --version` via `execSync` in a try/catch
    - On failure, throw with descriptive message including install instructions and explanation that kiro-learn depends on kiro-cli for extraction
    - _Requirements: 16.1, 16.2, 16.3, 16.4_

  - [x] 1.4 Implement `detectScope(cwd)`
    - Resolve `cwd` via `fs.realpathSync`
    - Fail fast if `cwd` is above `$HOME` (throw error)
    - Return global-only if `cwd` is exactly `$HOME`
    - Walk upward from `cwd`, checking each directory for any `PROJECT_MARKERS` entry via `existsSync`
    - Stop before reaching `$HOME` (never examine `$HOME` itself)
    - Return nearest match as `projectRoot` with `detectedMarker`, or global-only if no marker found
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8_

  - [x] 1.5 Implement `promptYesNo(question)`
    - Use `node:readline` to create interface on stdin/stdout
    - Return `Promise<boolean>`: true for Y/y/empty, false for N/n
    - _Requirements: 18.1, 18.2, 18.3_

- [x] 2. Implement filesystem operations in `src/installer/index.ts`
  - [x] 2.1 Implement `createLayout(scope)`
    - Create `~/.kiro-learn/`, `~/.kiro-learn/bin/`, `~/.kiro-learn/lib/`, `~/.kiro-learn/logs/` via `mkdirSync` with `recursive: true`
    - Create `~/.kiro/agents/` for global agent configs
    - If `scope.projectRoot` is defined, create `<projectRoot>/.kiro/agents/`
    - Set directory permissions to `0o755`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 17.3_

  - [x] 2.2 Implement `deployPayload()`
    - Determine source `dist/` directory relative to the installer's own location (one level up from `import.meta.url`)
    - On upgrade, remove existing `~/.kiro-learn/lib/` via `rmSync`
    - Copy `shim/`, `collector/`, `installer/`, `types/` subdirectories via `cpSync` with `recursive: true`
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 2.3 Implement `writePackageJson()`
    - Write minimal `package.json` to `~/.kiro-learn/` with `name: "kiro-learn-runtime"`, `private: true`, `type: "module"`
    - List pinned production dependencies: `better-sqlite3`, `ulidx`, `zod` with exact versions from the npm package
    - Read version from the package's own `package.json`
    - _Requirements: 3.4_

  - [x] 2.4 Implement `installDeps()`
    - On upgrade, remove existing `~/.kiro-learn/node_modules/` via `rmSync`
    - Run `npm install --production` in `~/.kiro-learn/` via `execSync` from `node:child_process`
    - On failure, print npm stderr output and throw
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [x] 2.5 Implement `writeBinWrappers()`
    - Write `~/.kiro-learn/bin/shim`: shebang + ESM import of `main()` from `../lib/shim/cli-agent/index.js`
    - Write `~/.kiro-learn/bin/collector`: shebang + ESM import of `startCollector()` from `../lib/collector/index.js`, with SIGTERM/SIGINT handlers for graceful shutdown
    - Write `~/.kiro-learn/bin/kiro-learn`: shebang + ESM import of `../lib/installer/bin.js`
    - Set all wrappers to `0o755` via `chmodSync`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 17.1_

  - [x] 2.6 Implement `writeSettings()`
    - If `~/.kiro-learn/settings.json` does not exist, write default settings: `collector.host: "127.0.0.1"`, `collector.port: 21100`, `shim.timeoutMs: 2000`
    - If file already exists, do nothing (preserve user customizations)
    - _Requirements: 14.1, 14.2, 14.3_

  - [x] 2.7 Implement `writeAgentConfigs(scope)`
    - Generate `kiro-learn.json` with four hooks (`agentSpawn`, `userPromptSubmit`, `postToolUse` with `matcher: "*"`, `stop`), each command using absolute path to `~/.kiro-learn/bin/shim` with `|| true` suffix
    - Write `kiro-learn.json` to `~/.kiro/agents/` (always) and `<projectRoot>/.kiro/agents/` (when project detected)
    - Generate `kiro-learn-compressor.json` with extraction prompt, empty `tools` and `allowedTools` arrays
    - Write `kiro-learn-compressor.json` to `~/.kiro/agents/` only (global scope only)
    - On upgrade, overwrite all agent configs at all applicable scopes
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11_

  - [x] 2.8 Implement `setDefaultAgent()`
    - Run `kiro-cli agent set-default kiro-learn` via `execSync`
    - On failure, log warning to stderr but do not throw
    - _Requirements: 7.1, 7.2, 7.3_

- [x] 3. Checkpoint
  - Ensure all tests pass and the module compiles with `npm run typecheck`. Ask the user if questions arise.

- [x] 4. Implement daemon lifecycle in `src/installer/index.ts`
  - [x] 4.1 Implement `getDaemonPid()`
    - Read PID from `~/.kiro-learn/collector.pid`
    - Probe liveness via `process.kill(pid, 0)`
    - Return PID if alive, `null` if not running
    - Clean up stale PID files (process not alive)
    - _Requirements: 10.2, 9.5, 9.6, N5_

  - [x] 4.2 Implement `startDaemon()`
    - Check if already running via `getDaemonPid()`, return early if so
    - Spawn `process.execPath` with `~/.kiro-learn/bin/collector` as argument, `detached: true`
    - Redirect stdout/stderr to `~/.kiro-learn/logs/collector-YYYY-MM-DD.log` via file descriptor
    - Write PID to `~/.kiro-learn/collector.pid` with permissions `0o644`
    - Call `child.unref()` to let installer exit
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 17.2_

  - [x] 4.3 Implement `stopDaemon()`
    - Read PID file, handle missing/invalid PID file gracefully
    - Send `SIGTERM`, busy-wait up to 5 seconds checking liveness via `process.kill(pid, 0)` in 100ms increments
    - If still alive after 5s, send `SIGKILL`
    - Remove PID file after process exits
    - Handle stale PID files (process already dead)
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [x] 5. Implement command handlers in `src/installer/index.ts`
  - [x] 5.1 Implement `cmdInit(opts)`
    - Orchestrate full install/upgrade flow: `checkNodeVersion` → `checkKiroCli` → `detectScope` → apply `--global-only` override → project scope confirmation via `promptYesNo` (when TTY and not `--yes`) → detect upgrade → `stopDaemon` (if upgrade) → `createLayout` → `deployPayload` → `writePackageJson` → `installDeps` → `writeBinWrappers` → `writeSettings` → `writeAgentConfigs` → `setDefaultAgent` (unless `--no-set-default`) → `startDaemon` → print summary
    - Print progress messages to stdout at each step with `[kiro-learn]` prefix
    - On fresh install failure before payload deployment, clean up partial `~/.kiro-learn/`
    - Return 0 on success, 1 on failure
    - `cmdInit` is async (because of `promptYesNo`)
    - _Requirements: 1.2, 1.7, 1.8, 1.9, 2.1–2.7, 3.1–3.4, 4.1–4.4, 5.1–5.5, 6.1–6.11, 7.1–7.3, 8.1, 8.4, 8.5, 12.1–12.8, 13.1–13.5, 14.1–14.3, 15.1–15.10, 16.1–16.4, 17.1–17.5, 18.1–18.8, N4, N10_

  - [x] 5.2 Implement `cmdStart()`
    - Check if installed (`~/.kiro-learn/` exists), exit 1 if not
    - Call `startDaemon()`, which handles already-running case
    - Return 0 on success, 1 on failure
    - _Requirements: 8.2, 8.6, 8.7_

  - [x] 5.3 Implement `cmdStop()`
    - Check if installed, print message and exit 0 if not
    - Call `stopDaemon()`
    - Return 0 on success (including "not running"), 1 on failure
    - _Requirements: 9.1–9.6, N6_

  - [x] 5.4 Implement `cmdStatus()`
    - Check if installed, print `[kiro-learn] not installed` and exit 1 if not
    - Report daemon status (running/stopped with PID), install directory, database path and existence, version from deployed `package.json`
    - Output in key-value format (parseable by scripts)
    - Return 0 if installed, 1 if not
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, N11_

  - [x] 5.5 Implement `cmdUninstall(opts)`
    - Check if installed, print message and exit 0 if not
    - Stop daemon, detect scope for project-level cleanup
    - Remove global agent configs (`kiro-learn.json`, `kiro-learn-compressor.json`)
    - Remove project-scoped agent config if project detected
    - If `--keep-data`: remove `bin/`, `lib/`, `node_modules/`, `collector.pid`, `package.json` but preserve `kiro-learn.db`, `settings.json`, `logs/`
    - If not `--keep-data`: remove entire `~/.kiro-learn/`
    - Print confirmation message
    - Return 0 on success, 1 on failure
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

- [x] 6. Implement CLI entry point in `src/installer/bin.ts`
  - [x] 6.1 Implement argv parsing and command dispatch
    - Parse `process.argv.slice(2)` — no CLI framework, manual parsing
    - Handle `--version`: read version from `package.json` relative to `import.meta.url`, print and exit 0
    - Handle `--help` or no args: print usage summary listing all commands, exit 0
    - Dispatch `init`, `start`, `stop`, `status`, `uninstall` to corresponding handlers from `index.ts`
    - Parse flags: `--no-set-default`, `--yes`/`-y`, `--global-only` for init; `--keep-data` for uninstall
    - On unrecognized command: print error to stderr listing valid commands, exit 1
    - Set `process.exitCode` from handler return value (never call `process.exit()` directly)
    - `bin.ts` must `await cmdInit()` since it is async
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

- [x] 7. Checkpoint
  - Ensure `npm run typecheck` and `npm run test` pass. Ask the user if questions arise.

- [x] 8. Write unit tests for installer
  - [x] 8.1 Write unit tests for `checkNodeVersion` and `checkKiroCli`
    - Test: passes on Node 22+
    - Test: throws with `[kiro-learn]` prefix on Node < 22
    - Test: `checkKiroCli` throws with install instructions when kiro-cli not found
    - _Requirements: N7, 16.1, 16.2, 16.4_

  - [x] 8.2 Write unit tests for `detectScope`
    - Test: returns global-only when cwd is `$HOME`
    - Test: returns project scope when `.git/` found in cwd
    - Test: returns project scope when `package.json` found in ancestor
    - Test: returns global-only when no markers found before `$HOME`
    - Test: throws when cwd is above `$HOME`
    - Test: nearest-marker-wins when multiple markers in walk path
    - Test: all 15 project markers are recognized
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8_

  - [x] 8.3 Write unit tests for bin wrapper content and agent config generation
    - Test: shim wrapper has correct shebang and import path
    - Test: collector wrapper has SIGTERM/SIGINT handlers
    - Test: kiro-learn wrapper imports from `../lib/installer/bin.js`
    - Test: `kiro-learn.json` has all four hooks with absolute shim path and `|| true`
    - Test: `kiro-learn-compressor.json` has extraction prompt and empty tools
    - Test: `postToolUse` hook has `matcher: "*"`
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 6.3, 6.4, 6.5, 6.8, 6.9_

  - [x] 8.4 Write unit tests for settings file and status output
    - Test: default settings contain `collector.port: 21100`, `collector.host: "127.0.0.1"`, `shim.timeoutMs: 2000`
    - Test: existing settings file is not overwritten
    - Test: status output is in key-value format
    - _Requirements: 14.1, 14.2, 14.3, N11_

  - [x] 8.5 Write unit tests for argv parsing in `bin.ts`
    - Test: `--version` prints version and exits 0
    - Test: `--help` prints usage and exits 0
    - Test: no args prints usage and exits 0
    - Test: unrecognized command exits 1 with error listing valid commands
    - Test: flags are correctly parsed and passed to handlers
    - _Requirements: 1.3, 1.4, 1.5, 1.6_

- [x] 9. Write property-based tests for installer
  - [x] 9.1 Write property test: Unrecognized command rejection [PBT]
    - **Property 1: Unrecognized command rejection**
    - For any string not in `{init, start, stop, status, uninstall, --help, --version}`, the CLI produces exit code 1 and stderr lists valid commands
    - **Validates: Requirements 1.4**

  - [x] 9.2 Write property test: Upgrade data preservation [PBT]
    - **Property 2: Upgrade data preservation**
    - For any existing install with random file contents in `kiro-learn.db`, `settings.json`, and `logs/`, running init (upgrade) preserves byte-identical contents of those files while replacing `lib/`, `bin/`, `node_modules/`
    - **Validates: Requirements 2.7, 12.5**

  - [x] 9.3 Write property test: Hook command format [PBT]
    - **Property 3: Hook command format**
    - For any generated `kiro-learn.json` agent config, every `command` field contains the absolute path to `~/.kiro-learn/bin/shim` (with actual home directory, no tilde) and ends with `|| true`
    - **Validates: Requirements 6.4**

  - [x] 9.4 Write property test: Uninstall --keep-data selective preservation [PBT]
    - **Property 4: Uninstall --keep-data selective preservation**
    - For any existing install with random user data files, `uninstall --keep-data` removes `bin/`, `lib/`, `node_modules/` and preserves byte-identical `kiro-learn.db`, `settings.json`, and `logs/*`
    - **Validates: Requirements 11.5**

  - [x] 9.5 Write property test: Error message prefix [PBT]
    - **Property 5: Error message prefix**
    - For any error condition that causes stderr output, the output contains the `[kiro-learn]` prefix
    - **Validates: Requirements 13.5**

  - [x] 9.6 Write property test: Scope detection correctness [PBT]
    - **Property 6: Scope detection correctness**
    - For any directory hierarchy under a temp home with randomly placed project markers, `detectScope` returns the nearest ancestor containing a marker as `projectRoot`, or `undefined` if none found before `$HOME`. Walk never considers `$HOME` itself. Throws for cwd above `$HOME`.
    - **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8**

- [x] 10. Write integration tests and modularity guard
  - [x] 10.1 Write integration test: fresh init flow
    - Full init in a temp home with mocked `kiro-cli` and `npm`
    - Verify all directories created, payload deployed, bin wrappers written, agent configs written, settings created, PID file written
    - _Requirements: 2.1–2.6, 3.1–3.4, 5.1–5.5, 6.1–6.10, 14.1_

  - [x] 10.2 Write integration test: upgrade flow
    - Init twice in a temp home, verify `kiro-learn.db`, `settings.json`, and `logs/` preserved, `lib/` replaced, daemon restarted
    - _Requirements: 2.7, 12.1–12.8_

  - [x] 10.3 Write integration test: uninstall flows
    - Init then uninstall: verify all files removed
    - Init then uninstall --keep-data: verify selective removal
    - _Requirements: 11.1–11.7_

  - [x] 10.4 Write modularity guard test: no shim imports in installer
    - Create `test/no-shim-in-installer.test.ts` following the pattern in `test/no-collector-in-shim.test.ts`
    - Scan `src/installer/` for imports from `src/shim/`
    - Any match is a modularity violation
    - _Requirements: Design § Module Structure_

- [x] 11. Final checkpoint
  - Ensure `npm run typecheck && npm run lint && npm run test` all pass. Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (P1–P6)
- Unit tests and property tests are complementary — unit tests cover specific examples and edge cases, property tests verify universal invariants
- The implementation language is TypeScript, matching the existing codebase
- All filesystem operations use synchronous Node.js APIs (`mkdirSync`, `writeFileSync`, `cpSync`, `rmSync`) — the installer is a short-lived CLI process
- The only async operations are `promptYesNo` (readline) and the top-level `cmdInit` orchestration
- `startDaemon` spawns `process.execPath` with the collector bin wrapper, not `startCollector` directly
- `stopDaemon` uses a busy-wait loop with `process.kill(pid, 0)` for liveness checking
- The installer may import from `src/collector/index.ts` but must NOT import from `src/shim/`
- Existing `fast-check` and `vitest` dev dependencies are used for all testing
