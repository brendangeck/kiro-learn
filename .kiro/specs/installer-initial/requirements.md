# Requirements: kiro-learn Installer (CLI)

## Introduction

This document defines the requirements for the kiro-learn installer — the `kiro-learn` CLI that ships as the npm package's `bin` entry and bootstraps a local runtime install under `~/.kiro-learn/`. The installer is the last v1 milestone piece that turns the existing library (types, collector, pipeline, storage, shim — all implemented and tested) into something a user can actually run.

The installer builds on the contracts established in [event-schema-and-storage](../event-schema-and-storage/requirements.md) (the canonical types), [collector-pipeline](../collector-pipeline/requirements.md) (the collector daemon started by `init`), and [shim](../shim/requirements.md) (the hook entry point wired into the agent config). Those are consumed here, not redefined.

**In scope:** The five CLI commands (`init`, `start`, `stop`, `status`, `uninstall`), directory layout creation, payload deployment, runtime dependency installation, bin wrapper generation, Kiro CLI agent config writing (both `kiro-learn.json` and `kiro-learn-compressor.json`), install scope detection (global vs project-level), kiro-cli dependency verification, daemon lifecycle management via PID file, upgrade flow, and uninstall flow.

**Out of scope:** Collector implementation, shim implementation, storage internals, extraction pipeline, IDE hook support (v3), Homebrew/winget/standalone binary distribution (v3+), remote daemon support, graceful online upgrades.

## Glossary

- **Installer**: The `kiro-learn` CLI module (`src/installer/`) that implements the `init`, `start`, `stop`, `status`, and `uninstall` commands. Invoked via `npx kiro-learn <command>` or directly from the installed `~/.kiro-learn/bin/kiro-learn` wrapper.
- **Install_Directory**: The runtime directory at `~/.kiro-learn/` where the installer deploys the compiled payload, runtime dependencies, bin wrappers, and user data (database, settings, logs).
- **Payload**: The compiled `dist/` output from the npm package, copied into `~/.kiro-learn/lib/` during `init`. Contains the shim, collector, installer, and types modules.
- **Bin_Wrapper**: A shebang-executable Node.js script placed in `~/.kiro-learn/bin/` that imports from `../lib/` and serves as the runtime entry point for the shim, collector, or CLI.
- **Agent_Config**: A Kiro CLI agent configuration file placed in `~/.kiro/agents/` (global scope) or `<Project_Root>/.kiro/agents/` (project scope). The installer writes two agent configs: `kiro-learn.json` (the hook-registering agent) and `kiro-learn-compressor.json` (the extraction/compression agent).
- **PID_File**: The file at `~/.kiro-learn/collector.pid` that stores the process ID of the running collector daemon. Used by `start`, `stop`, and `status` commands.
- **Collector_Daemon**: The long-running background Node.js process that receives events, runs the pipeline, and serves retrieval queries. Managed by the installer via PID file.
- **Settings_File**: The user-editable configuration file at `~/.kiro-learn/settings.json`. Preserved across upgrades and optionally preserved on uninstall.
- **Project_Root**: The nearest ancestor directory (including cwd) that contains a project marker (one of `.kiro/`, `.git/`, `package.json`, `Cargo.toml`, `pyproject.toml`, `setup.py`, `go.mod`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `Gemfile`, `composer.json`, `mix.exs`, `deno.json`, `deno.jsonc`). Determined by the install scope detection walk (Requirement 15). When no marker is found before reaching `$HOME`, this is undefined and only global scope applies.
- **Compressor_Agent**: The specialized Kiro CLI agent config at `~/.kiro/agents/kiro-learn-compressor.json` used by the collector's extraction pipeline to distill events into structured memory records via `kiro-cli chat --no-interactive --agent kiro-learn-compressor`.

## Requirements

### Requirement 1: CLI Entry Point and Command Routing

**User Story:** As a developer, I want a single CLI entry point that dispatches to the correct command handler, so that I can manage kiro-learn with simple subcommands.

#### Acceptance Criteria

1. THE Installer SHALL expose a CLI entry point at `src/installer/bin.ts` wired to `package.json#bin` as `kiro-learn`.
2. WHEN invoked with a subcommand (`init`, `start`, `stop`, `status`, `uninstall`), THE Installer SHALL dispatch to the corresponding command handler.
3. WHEN invoked without a subcommand or with `--help`, THE Installer SHALL print a usage summary to stdout listing all available commands and exit with code 0.
4. WHEN invoked with an unrecognized subcommand, THE Installer SHALL print an error message to stderr listing valid commands and exit with code 1.
5. WHEN the `uninstall` command is invoked with the `--keep-data` flag, THE Installer SHALL pass that option to the uninstall handler.
6. THE Installer SHALL read the package version from `package.json` and display it when invoked with `--version`.
7. WHEN the `init` command is invoked with the `--no-set-default` flag, THE Installer SHALL skip the default agent setup step (Requirement 8).
8. WHEN the `init` command is invoked with the `--yes` or `-y` flag, THE Installer SHALL pass that option to the init handler to skip project scope confirmation.
9. WHEN the `init` command is invoked with the `--global-only` flag, THE Installer SHALL pass that option to the init handler to force global-only scope.

### Requirement 2: Directory Layout Creation (`init`)

**User Story:** As a developer, I want `kiro-learn init` to create the complete runtime directory structure, so that all components have a well-defined location on disk.

#### Acceptance Criteria

1. WHEN `init` is invoked, THE Installer SHALL create the `~/.kiro-learn/` directory if it does not exist.
2. WHEN `init` is invoked, THE Installer SHALL create the `~/.kiro-learn/bin/` directory if it does not exist.
3. WHEN `init` is invoked, THE Installer SHALL create the `~/.kiro-learn/lib/` directory if it does not exist.
4. WHEN `init` is invoked, THE Installer SHALL create the `~/.kiro-learn/logs/` directory if it does not exist.
5. WHEN `init` is invoked, THE Installer SHALL create the `~/.kiro/agents/` directory if it does not exist (for the global agent configs).
6. WHEN `init` is invoked and a Project_Root is detected (Requirement 15), THE Installer SHALL create the `<Project_Root>/.kiro/agents/` directory if it does not exist (for the project-scoped agent config).
7. IF `~/.kiro-learn/` already exists (upgrade scenario), THE Installer SHALL preserve existing `kiro-learn.db`, `settings.json`, and `logs/` contents.

### Requirement 3: Payload Deployment (`init`)

**User Story:** As a developer, I want `init` to copy the compiled library into the install directory, so that the installed copy is runtime-independent of the npm package or npx cache.

#### Acceptance Criteria

1. WHEN `init` is invoked, THE Installer SHALL copy the package's compiled output into `~/.kiro-learn/lib/`, including the `shim/`, `collector/`, `installer/`, and `types/` subdirectories.
2. WHEN `init` is invoked on an existing install (upgrade), THE Installer SHALL replace the entire `~/.kiro-learn/lib/` directory with the new payload.
3. THE Installer SHALL determine the source payload path relative to its own location in the package (the `dist/` directory of the npm package).
4. THE Installer SHALL copy a minimal `package.json` into `~/.kiro-learn/` that lists only the production runtime dependencies (`better-sqlite3`, `ulidx`, `zod`) with pinned versions matching the npm package.

### Requirement 4: Runtime Dependency Installation (`init`)

**User Story:** As a developer, I want `init` to install native runtime dependencies in the install directory, so that the collector and shim can load `better-sqlite3` and other deps without relying on the npm cache.

#### Acceptance Criteria

1. WHEN `init` is invoked, THE Installer SHALL run `npm install --production` in the `~/.kiro-learn/` directory to install runtime dependencies from the generated `package.json`.
2. WHEN `init` is invoked on an existing install (upgrade), THE Installer SHALL remove the existing `~/.kiro-learn/node_modules/` before running the install to ensure a clean dependency tree.
3. IF the `npm install` command fails, THE Installer SHALL print the error output to stderr and exit with code 1.
4. THE Installer SHALL use the `node:child_process` module to spawn the `npm` process. No third-party process management libraries.

### Requirement 5: Bin Wrapper Generation (`init`)

**User Story:** As a developer, I want `init` to write executable wrapper scripts, so that hooks and the CLI can invoke kiro-learn components via fast, fixed absolute paths.

#### Acceptance Criteria

1. WHEN `init` is invoked, THE Installer SHALL write a `~/.kiro-learn/bin/shim` wrapper script that is a `#!/usr/bin/env node` shebang script importing and calling the shim's `main()` from `../lib/shim/cli-agent/index.js`.
2. WHEN `init` is invoked, THE Installer SHALL write a `~/.kiro-learn/bin/collector` wrapper script that is a `#!/usr/bin/env node` shebang script importing and calling `startCollector()` from `../lib/collector/index.js`.
3. WHEN `init` is invoked, THE Installer SHALL write a `~/.kiro-learn/bin/kiro-learn` wrapper script that is a `#!/usr/bin/env node` shebang script importing and calling the CLI dispatcher from `../lib/installer/bin.js`.
4. THE Installer SHALL set file permissions on all bin wrapper scripts to `0o755` (owner read/write/execute, group and others read/execute).
5. EACH bin wrapper SHALL use ESM `import()` syntax to load from the `../lib/` directory relative to the wrapper's own location.

### Requirement 6: Kiro CLI Agent Configs (`init`)

**User Story:** As a developer, I want `init` to write the Kiro CLI agent configs for both the hook-registering agent and the extraction/compression agent, so that kiro-learn hooks fire automatically and the extraction pipeline can invoke the compressor agent via kiro-cli.

#### Acceptance Criteria

**Agent 1: `kiro-learn.json` (hook-registering agent)**

1. WHEN `init` is invoked, THE Installer SHALL write `~/.kiro/agents/kiro-learn.json` containing a valid Kiro CLI agent configuration (global scope, always written).
2. WHEN `init` is invoked and a Project_Root is detected (Requirement 15), THE Installer SHALL also write `<Project_Root>/.kiro/agents/kiro-learn.json` containing the same agent configuration (project scope).
3. THE `kiro-learn.json` Agent_Config SHALL register four hooks: `agentSpawn`, `userPromptSubmit`, `postToolUse`, and `stop`.
4. EACH hook's `command` field SHALL be the absolute path to `~/.kiro-learn/bin/shim` (resolved using the actual home directory, not a tilde) with ` || true` appended so that hook failures do not block the agent lifecycle.
5. THE `postToolUse` hook SHALL use `"matcher": "*"` to capture all tool uses.
6. THE `kiro-learn.json` Agent_Config SHALL be valid JSON conforming to Kiro's agent config schema.

**Agent 2: `kiro-learn-compressor.json` (extraction/compression agent)**

7. WHEN `init` is invoked, THE Installer SHALL write `~/.kiro/agents/kiro-learn-compressor.json` containing a valid Kiro CLI agent configuration (global scope only, never project-scoped).
8. THE `kiro-learn-compressor.json` Agent_Config SHALL include a `prompt` field with instructions for extracting structured memory records from event content, including fields: title, summary, facts, concepts, observation_type, and files_touched.
9. THE `kiro-learn-compressor.json` Agent_Config SHALL configure minimal tools with read-only access (no write or shell access).
10. THE Compressor_Agent SHALL be invocable via `kiro-cli chat --no-interactive --agent kiro-learn-compressor "<event content>"`.

**Shared**

11. WHEN `init` is invoked on an existing install (upgrade), THE Installer SHALL overwrite all agent configs at all applicable scopes to ensure hook paths and prompts are current.

**Known issue:** The current extraction code in `src/collector/pipeline/index.ts` spawns `kiro-cli extract`, which does not exist. The correct invocation is `kiro-cli chat --no-interactive --agent kiro-learn-compressor`. This will be addressed when the extraction stage is updated to use the correct command.

### Requirement 7: Default Agent Setup (`init`)

**User Story:** As a developer, I want `init` to optionally set kiro-learn as the default kiro-cli agent, so that I do not need to pass `--agent kiro-learn` every time I use kiro-cli.

#### Acceptance Criteria

1. WHEN `init` completes agent config writing and the `--no-set-default` flag is not present, THE Installer SHALL run `kiro-cli agent set-default kiro-learn`.
2. WHEN `init` is invoked with the `--no-set-default` flag, THE Installer SHALL skip the default agent setup step.
3. IF the `kiro-cli agent set-default kiro-learn` command fails (non-zero exit code), THE Installer SHALL log a warning to stderr but SHALL NOT fail the install (exit code remains 0 for this step).

### Requirement 8: Daemon Start (`init`, `start`)

**User Story:** As a developer, I want the collector daemon to be started automatically after `init` and on-demand via `start`, so that memory capture works immediately.

#### Acceptance Criteria

1. WHEN `init` completes payload deployment, THE Installer SHALL start the collector daemon as a detached background process.
2. WHEN `start` is invoked, THE Installer SHALL start the collector daemon if it is not already running.
3. THE Installer SHALL spawn the daemon using `child_process.spawn` with `detached: true` and `stdio` redirected to log files under `~/.kiro-learn/logs/`.
4. THE Installer SHALL write the daemon's process ID to `~/.kiro-learn/collector.pid` after successful spawn.
5. THE Installer SHALL redirect the daemon's stdout and stderr to `~/.kiro-learn/logs/collector-YYYY-MM-DD.log` where `YYYY-MM-DD` is the current date.
6. WHEN `start` is invoked and the daemon is already running (PID file exists and process is alive), THE Installer SHALL print a message indicating the daemon is already running and exit with code 0.
7. IF the daemon fails to start (spawn error), THE Installer SHALL print the error to stderr and exit with code 1.

### Requirement 9: Daemon Stop (`stop`, `init` upgrade)

**User Story:** As a developer, I want to stop the collector daemon cleanly, so that the database is closed properly and the PID file is cleaned up.

#### Acceptance Criteria

1. WHEN `stop` is invoked, THE Installer SHALL read the PID from `~/.kiro-learn/collector.pid`.
2. THE Installer SHALL send `SIGTERM` to the process identified by the PID.
3. THE Installer SHALL wait for the process to exit (up to 5 seconds). IF the process does not exit within 5 seconds, THE Installer SHALL send `SIGKILL`.
4. AFTER the process exits, THE Installer SHALL remove the `~/.kiro-learn/collector.pid` file.
5. IF the PID file does not exist when `stop` is invoked, THE Installer SHALL print a message indicating no daemon is running and exit with code 0.
6. IF the PID file exists but the process is not alive (stale PID), THE Installer SHALL remove the stale PID file and print a message indicating the daemon was not running.
7. WHEN `init` detects an existing install, THE Installer SHALL stop the running daemon (using the same logic as `stop`) before replacing the payload.

### Requirement 10: Daemon Status (`status`)

**User Story:** As a developer, I want to check whether the collector daemon is running and see basic install info, so that I can diagnose issues without reading PID files manually.

#### Acceptance Criteria

1. WHEN `status` is invoked, THE Installer SHALL report whether the collector daemon is running or stopped.
2. THE Installer SHALL determine daemon liveness by reading the PID file and checking if the process is alive via `process.kill(pid, 0)`.
3. WHEN the daemon is running, THE Installer SHALL display the PID.
4. THE Installer SHALL display the install directory path (`~/.kiro-learn/`).
5. THE Installer SHALL display the database file path (`~/.kiro-learn/kiro-learn.db`) and whether it exists.
6. THE Installer SHALL display the installed kiro-learn version (read from the deployed `package.json` in `~/.kiro-learn/`).
7. IF kiro-learn is not installed (`~/.kiro-learn/` does not exist), THE Installer SHALL print a message indicating kiro-learn is not installed and exit with code 1.

### Requirement 11: Uninstall (Scope-Aware)

**User Story:** As a developer, I want to cleanly remove kiro-learn from my system, so that no orphaned files, processes, or agent configs remain.

#### Acceptance Criteria

1. WHEN `uninstall` is invoked, THE Installer SHALL stop the collector daemon if it is running (using the same logic as `stop`).
2. WHEN `uninstall` is invoked, THE Installer SHALL remove the global agent config files: `~/.kiro/agents/kiro-learn.json` and `~/.kiro/agents/kiro-learn-compressor.json`.
3. WHEN `uninstall` is invoked inside a project (Project_Root detected via the scope detection tree walk from Requirement 15), THE Installer SHALL also remove `<Project_Root>/.kiro/agents/kiro-learn.json`.
4. WHEN `uninstall` is invoked without `--keep-data`, THE Installer SHALL remove the entire `~/.kiro-learn/` directory.
5. WHEN `uninstall` is invoked with `--keep-data`, THE Installer SHALL remove `~/.kiro-learn/bin/`, `~/.kiro-learn/lib/`, and `~/.kiro-learn/node_modules/` but preserve `~/.kiro-learn/kiro-learn.db`, `~/.kiro-learn/settings.json`, and `~/.kiro-learn/logs/`.
6. AFTER successful uninstall, THE Installer SHALL print a confirmation message to stdout.
7. IF kiro-learn is not installed when `uninstall` is invoked, THE Installer SHALL print a message indicating nothing to uninstall and exit with code 0.

### Requirement 12: Upgrade Flow (`init` on existing install)

**User Story:** As a developer, I want to upgrade kiro-learn by re-running `init`, so that I get the latest code without losing my data or having to manually manage the daemon.

#### Acceptance Criteria

1. WHEN `init` detects an existing install at `~/.kiro-learn/`, THE Installer SHALL treat the invocation as an upgrade.
2. THE Installer SHALL stop the running daemon before replacing any files (Requirement 9.7).
3. THE Installer SHALL replace `~/.kiro-learn/lib/` with the new payload (Requirement 3.2).
4. THE Installer SHALL replace `~/.kiro-learn/node_modules/` with a fresh dependency install (Requirement 4.2).
5. THE Installer SHALL preserve `~/.kiro-learn/kiro-learn.db`, `~/.kiro-learn/settings.json`, and `~/.kiro-learn/logs/` contents.
6. THE Installer SHALL rewrite `~/.kiro-learn/bin/` wrappers (Requirement 5).
7. THE Installer SHALL rewrite all agent configs (`kiro-learn.json` and `kiro-learn-compressor.json`) at all applicable scopes (Requirement 6.11).
8. THE Installer SHALL restart the daemon after the upgrade completes (Requirement 8).

### Requirement 13: Error Handling and User Feedback

**User Story:** As a developer, I want clear error messages and progress feedback from the CLI, so that I can understand what happened when something goes wrong.

#### Acceptance Criteria

1. THE Installer SHALL print progress messages to stdout during `init` (e.g., "Creating ~/.kiro-learn/...", "Deploying payload...", "Installing dependencies...", "Starting daemon...").
2. IF any step of `init` fails, THE Installer SHALL print a descriptive error message to stderr and exit with code 1.
3. THE Installer SHALL NOT leave a partially-created install directory if `init` fails before payload deployment completes. IF directory creation succeeds but payload deployment fails, THE Installer SHALL remove the partially-created directories.
4. IF a filesystem operation fails due to permissions, THE Installer SHALL include the path and the OS error message in the error output.
5. ALL error messages SHALL include a `[kiro-learn]` prefix for consistency with the shim's logging convention.

### Requirement 14: Settings File

**User Story:** As a developer, I want a default settings file created on first install, so that I have a starting point for configuration without reading documentation.

#### Acceptance Criteria

1. WHEN `init` is invoked and `~/.kiro-learn/settings.json` does not exist, THE Installer SHALL write a default settings file with documented fields.
2. THE default settings file SHALL include `collector.port` (default `21100`), `collector.host` (default `"127.0.0.1"`), and `shim.timeoutMs` (default `2000`).
3. WHEN `init` is invoked and `~/.kiro-learn/settings.json` already exists, THE Installer SHALL NOT overwrite it (user customizations are preserved).

### Requirement 15: Install Scope Detection

**User Story:** As a developer, I want the installer to detect whether I am inside a project of any kind (not only existing Kiro projects) and install agent configs at the appropriate scopes, so that project-level hooks are registered automatically on fresh machines and in repos that have never used Kiro before.

#### Acceptance Criteria

1. WHEN `init` is invoked, THE Installer SHALL determine the install scope by walking the filesystem from `cwd` upward looking for any project marker.
2. THE project markers SHALL include: `.kiro/` (existing Kiro project), `.git/` (git repo), `package.json` (Node.js), `Cargo.toml` (Rust), `pyproject.toml` (Python), `setup.py` (Python), `go.mod` (Go), `pom.xml` (Java/Maven), `build.gradle` (Java/Gradle), `build.gradle.kts` (Kotlin/Gradle), `Gemfile` (Ruby), `composer.json` (PHP), `mix.exs` (Elixir), `deno.json` (Deno), `deno.jsonc` (Deno).
3. THE filesystem walk SHALL NOT traverse at or above `$HOME`. The walk stops before reaching `$HOME`.
4. IF `cwd` is above `$HOME` (e.g., `/tmp/`, `/`), THE Installer SHALL print an error message to stderr indicating that kiro-learn cannot be installed from outside the user's home directory tree, and exit with code 1.
5. IF `cwd` is exactly `$HOME`, THE Installer SHALL use global-only scope: agent configs are written only to `~/.kiro/agents/`.
6. IF any project marker is found in `cwd` or an ancestor directory before reaching `$HOME` (project detected), THE Installer SHALL use both global and project scope: agent configs are written to both `~/.kiro/agents/` and `<Project_Root>/.kiro/agents/`, where Project_Root is the directory containing the first project marker found during the walk.
7. IF no project marker is found before the walk reaches `$HOME`, THE Installer SHALL use global-only scope and print a progress message explaining that no project was detected.
8. WHEN multiple markers exist in the walk path (e.g., a git repo with a `package.json`), THE Installer SHALL use the NEAREST marker (first match during upward walk) as the Project_Root. Markers are not ranked — the first one found wins.
9. THE Installer SHALL log the detected scope (global-only or global+project with the Project_Root path and the marker that triggered detection) as a progress message during `init`.
10. THE scope detection result SHALL be subject to user confirmation when running on an interactive TTY (Requirement 18). The final effective scope may differ from the detected scope if the user declines project-scoped installation.

### Requirement 16: Kiro CLI Dependency Check

**User Story:** As a developer, I want the installer to verify that kiro-cli is installed before proceeding, so that I get a clear error message instead of a confusing failure later when the collector tries to invoke kiro-cli for extraction.

#### Acceptance Criteria

1. WHEN `init` is invoked, THE Installer SHALL verify that `kiro-cli` is installed by running `kiro-cli --version` and checking for exit code 0.
2. IF `kiro-cli` is not found or `kiro-cli --version` returns a non-zero exit code, THE Installer SHALL print an error message to stderr with instructions to install kiro-cli first, and exit with code 1.
3. THE kiro-cli dependency check SHALL run before any filesystem modifications (before directory creation, payload deployment, or agent config writing).
4. THE error message SHALL explain that kiro-learn depends on kiro-cli for extraction (the collector spawns `kiro-cli chat --no-interactive --agent kiro-learn-compressor` to transform events into memory records).

### Requirement 17: File Permissions and Security

**User Story:** As a developer, I want the installer to set appropriate file permissions, so that the installed scripts and data are not world-writable.

#### Acceptance Criteria

1. THE Installer SHALL set file permissions on bin wrapper scripts to `0o755`.
2. THE Installer SHALL set file permissions on the PID file to `0o644`.
3. THE Installer SHALL set directory permissions on `~/.kiro-learn/` to `0o755`.
4. THE Installer SHALL NOT store secrets, credentials, or tokens in any file it creates.
5. THE collector daemon started by the Installer SHALL bind only to `127.0.0.1` (no external network exposure).

### Requirement 18: Project Scope Confirmation

**User Story:** As a developer, I want the installer to confirm the detected project root before writing project-scoped agent configs, so that I can verify the heuristic detected the correct project and avoid writing configs to the wrong directory.

#### Acceptance Criteria

1. WHEN `init` detects a Project_Root (Requirement 15) AND the process is connected to an interactive TTY (stdout is a TTY), THE Installer SHALL prompt the user with: `Detected project at <Project_Root> (via <marker>). Install project-scoped agent config here? [Y/n]`
2. IF the user responds with `Y`, `y`, or empty (Enter), THE Installer SHALL proceed with both global and project scope.
3. IF the user responds with `N` or `n`, THE Installer SHALL fall back to global-only scope and print a message confirming global-only installation.
4. WHEN `init` is invoked with the `--yes` or `-y` flag, THE Installer SHALL skip the confirmation prompt and proceed with project scope (auto-accept).
5. WHEN `init` is invoked with the `--global-only` flag, THE Installer SHALL skip the confirmation prompt AND force global-only scope even if a project is detected.
6. WHEN the process is NOT connected to an interactive TTY (e.g., piped, CI environment), THE Installer SHALL skip the confirmation prompt and proceed with project scope (auto-accept). This keeps `npx kiro-learn init` scriptable.
7. WHEN no project is detected (global-only scope), THE Installer SHALL NOT prompt — no confirmation is needed.
8. THE confirmation prompt SHALL include the detected marker name (e.g., `.git`, `package.json`) so the user understands why the directory was identified as a project.

## Non-functional Requirements

### Performance

- N1. THE `init` command SHALL complete in under 60 seconds on a typical developer machine with a warm npm cache.
- N2. THE `start`, `stop`, and `status` commands SHALL complete in under 2 seconds.
- N3. Bin wrapper scripts SHALL add no more than 50ms of overhead to the underlying module's startup time.

### Reliability

- N4. THE `init` command SHALL be idempotent — running it multiple times in succession SHALL produce the same result as running it once.
- N5. THE Installer SHALL handle stale PID files gracefully (process died without cleanup).
- N6. THE Installer SHALL handle missing `~/.kiro-learn/` gracefully in `stop`, `status`, and `uninstall` commands.

### Compatibility

- N7. THE Installer SHALL require Node.js 22 LTS or later. IF the Node.js version is below 22, THE Installer SHALL print an error and exit with code 1.
- N8. THE Installer SHALL work on macOS and Linux. Windows support is not required in v1.
- N9. THE Installer SHALL use only `node:` built-in modules and the project's existing dependencies. No additional runtime dependencies.

### Observability

- N10. THE Installer SHALL print a summary at the end of a successful `init` showing: install path, daemon PID, agent config path(s), detected scope, and version.
- N11. THE `status` command output SHALL be parseable by scripts (key: value format).

### Dependency Verification

- N12. THE Installer SHALL detect kiro-cli availability before proceeding with `init`. IF kiro-cli is not installed, THE Installer SHALL exit with code 1 and a descriptive error message.

## Out of Scope (explicit)

- Homebrew, winget, or standalone binary distribution (v3+)
- Shell install scripts (`curl | bash`) (v3+)
- Graceful online upgrades (drain requests, hot-swap) — "stop first, then re-init" is acceptable for v1
- Remote daemon support — collector is always `127.0.0.1`
- Windows support
- Automatic update checking or self-update mechanism
- Systemd/launchd service integration for daemon management
- Log rotation or log cleanup
- Interactive prompts beyond the project scope confirmation — only `init` prompts, and only when a project is detected on an interactive TTY
