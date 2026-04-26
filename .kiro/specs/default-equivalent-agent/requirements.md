# Requirements Document

## Introduction

This document specifies the requirements for making the installer-deployed `kiro-learn` agent behave as a drop-in replacement for Kiro's built-in `kiro_default` agent, with kiro-learn's lifecycle hooks layered on top.

### Problem

Today the installer writes `~/.kiro/agents/kiro-learn.json` (and, when a project scope is detected, `.kiro/agents/kiro-learn.json`) as a hand-authored JSON document containing only a `name`, `description`, and a `hooks` block pointing at the shim. After `kiro-cli agent set-default kiro-learn` runs, that agent becomes the user's default — but it has no tool list, no system prompt, no MCP server configuration, and no built-in knowledge tool access. The user experience silently regresses the moment memory capture is enabled: tools the user had in `kiro_default` stop appearing, the agent personality shifts, and any MCP servers Kiro ships with the default agent go missing. kiro-learn is positioned as a transparent capture-and-inject layer, but the current installer forces the user to accept a stripped-down agent as the cost of that transparency.

### Constraint

The installer cannot copy `kiro_default`'s contents by hand. `kiro_default` is owned by `kiro-cli` and its shape evolves across `kiro-cli` releases — a hardcoded snapshot in this repository would drift. We need to reuse whatever `kiro_default` looks like on the user's machine at install time, then merge our four hooks on top.

### Solution

The installer SHALL use `kiro-cli agent create --from kiro_default` to seed each `kiro-learn.json` it writes (global always; project-scoped when a project is detected), then merge its own `name`, `description`, and four hook triggers onto the seed. The `--directory` flag targets the exact destination so `kiro-cli` writes the seed directly in place. The delete-then-reseed-then-merge cycle runs on every `kiro-learn init` invocation, so upgrades of `kiro-cli` that ship a newer `kiro_default` propagate into the kiro-learn agent the next time the user runs init.

If `kiro-cli` is unavailable, rejects the seed command, or emits output that does not parse as JSON or resolves to an empty object, the installer SHALL fall back to writing the current minimal hooks-only config and print a clearly-worded warning so the user understands what happened and how to recover.

### Scope

In scope:

- The installer's creation of `~/.kiro/agents/kiro-learn.json` (always).
- The installer's creation of `.kiro/agents/kiro-learn.json` at the detected project root (when project scope is detected).
- Both global and project-local files go through the same seed-then-merge flow, each with its own delete-and-reseed cycle.
- Fallback behaviour when seeding fails.

Out of scope:

- `kiro-learn-compressor.json`. The compressor agent is deliberately minimal (zero tools, XML-extraction prompt) and is not affected by this change.
- When `kiro-cli agent set-default kiro-learn` runs. The installer already invokes `set-default` after the agent file is written; this spec changes only the file's content, not the timing of `set-default`.
- Changes to the shim, the hook command strings, or the triggers kiro-learn owns (`agentSpawn`, `userPromptSubmit`, `postToolUse`, `stop`).

## Glossary

- **Kiro_Default_Agent**: The agent configuration owned by `kiro-cli` and addressed by the name `kiro_default`. Used as the seed for the kiro-learn agent via `kiro-cli agent create --from kiro_default`. Its concrete shape (tools, prompt, MCP servers, etc.) is `kiro-cli`'s responsibility and may evolve across `kiro-cli` releases.
- **Pristine_Default**: A freshly-seeded agent JSON file as written by `kiro-cli agent create --from kiro_default` before any kiro-learn merge has been applied. Represents "what `kiro-cli` would give you if you asked for a copy of the default agent."
- **Seed_Command**: The shell invocation `EDITOR=true kiro-cli agent create --from kiro_default --directory <target-dir> kiro-learn`. Produces a Pristine_Default at `<target-dir>/kiro-learn.json`.
- **Seed_Target_Directory**: The exact directory `kiro-cli` writes the Pristine_Default into — either the global agents directory (`~/.kiro/agents/`) or the project-scoped agents directory (`<projectRoot>/.kiro/agents/`).
- **Seed_Payload**: The object produced by parsing `<target-dir>/kiro-learn.json` as JSON after the Seed_Command completes.
- **Hook_Merge**: The operation that takes the Seed_Payload, overwrites its `name`, `description`, and the four kiro-learn hook entries (`agentSpawn`, `userPromptSubmit`, `postToolUse`, `stop`), preserves all other fields including any hooks on other triggers, and writes the result back to the same file.
- **Installer_Hook_Triggers**: The exact set of hook trigger names kiro-learn owns: `agentSpawn`, `userPromptSubmit`, `postToolUse`, `stop`. Hooks on any other trigger (e.g. `preToolUse`) are not installer-owned.
- **Fallback_Config**: The hand-authored minimal agent JSON — containing only `name`, `description`, and the four Installer_Hook_Triggers — that the installer writes when seeding fails. This is the same structure the installer writes today.
- **Fallback_Warning**: The message written to stderr when the installer uses the Fallback_Config. Must communicate scope, cause, effect, and recovery.
- **Agent_Scope**: One of `global` (`~/.kiro/agents/`) or `project` (`<projectRoot>/.kiro/agents/`). Each scope has its own seed-then-merge cycle.
- **Installer**: The Node process that runs `cmdInit` in `src/installer/index.ts`.
- **Seed_Validation**: The two-step check applied to the Seed_Payload: (a) the file contents parse as valid JSON, and (b) the parsed value is a non-null, non-undefined object with at least one own key.

## Requirements

### Requirement 1: Seed Command Invocation

**User Story:** As a kiro-learn user, I want the installed kiro-learn agent to inherit the same tools, prompt, and MCP servers as Kiro's built-in default agent, so that enabling memory capture does not silently remove functionality I already had.

#### Acceptance Criteria

1. FOR EACH Agent_Scope the Installer is writing, THE Installer SHALL invoke the Seed_Command with `<target-dir>` set to the exact Seed_Target_Directory for that scope.
2. THE Installer SHALL set the environment variable `EDITOR` to the literal string `true` for the Seed_Command invocation, so `kiro-cli agent create` does not open an interactive editor.
3. THE Installer SHALL pass the agent name `kiro-learn` as the positional argument to `kiro-cli agent create`.
4. THE Installer SHALL pass `--from kiro_default` to `kiro-cli agent create` to select the seed source.
5. THE Installer SHALL pass `--directory <target-dir>` to `kiro-cli agent create` so the Pristine_Default is written directly into the Seed_Target_Directory (no temporary directory and no post-write move).
6. WHEN the Seed_Command exits with a non-zero status, THE Installer SHALL treat the seed as failed and apply the fallback behaviour defined in Requirement 6.
7. WHEN the Seed_Command exits with a zero status but writes no file at `<target-dir>/kiro-learn.json`, THE Installer SHALL treat the seed as failed and apply the fallback behaviour defined in Requirement 6.

### Requirement 2: Pre-Seed Delete-If-Exists

**User Story:** As an installer author, I want the installer to own the target agent file outright, so that stale content from a prior install does not leak into the merged result and so `kiro-cli agent create` can write the file without file-exists errors.

#### Acceptance Criteria

1. FOR EACH Agent_Scope the Installer is writing, WHEN the file at `<target-dir>/kiro-learn.json` exists prior to Seed_Command invocation, THE Installer SHALL delete that file before invoking the Seed_Command.
2. WHEN the file at `<target-dir>/kiro-learn.json` does not exist prior to Seed_Command invocation, THE Installer SHALL proceed to the Seed_Command without performing a delete.
3. THE Installer SHALL delete only the target kiro-learn agent file — no other agent file in the Seed_Target_Directory is touched.
4. THE pre-seed delete SHALL apply independently per Agent_Scope: deleting the global `kiro-learn.json` does not affect the project-scoped file, and vice versa.

### Requirement 3: Seed Validation

**User Story:** As an installer author, I want minimal but necessary validation of the seed payload, so that the installer inherits whatever `kiro-cli` produces today and in future versions without demanding specific fields that `kiro-cli` may or may not ship.

#### Acceptance Criteria

1. WHEN the Seed_Command completes with zero status and writes a file, THE Installer SHALL read the file and attempt to parse the contents as JSON.
2. IF parsing the seed file as JSON throws an error, THEN THE Installer SHALL treat the seed as failed and apply the fallback behaviour defined in Requirement 6.
3. IF the parsed JSON value is `null`, `undefined`, not an object (e.g. an array, a string, a number, a boolean), or an object with zero own keys, THEN THE Installer SHALL treat the seed as failed and apply the fallback behaviour defined in Requirement 6.
4. WHEN the parsed JSON value is a non-null object with at least one own key, THE Installer SHALL treat the seed as valid and proceed to Hook_Merge.
5. THE Installer SHALL NOT require the presence of any specific field (including `tools`, `prompt`, `description`, `mcpServers`, or `allowedTools`) in the Seed_Payload.

### Requirement 4: Hook Merge Semantics

**User Story:** As a kiro-learn user, I want kiro-learn's four hooks to be active on the installed agent while every other field from `kiro_default` is preserved, so that capture runs on the triggers kiro-learn owns without otherwise disturbing the default agent.

#### Acceptance Criteria

1. WHEN Hook_Merge runs, THE Installer SHALL set the merged object's `name` field to the string `kiro-learn`, overwriting any value in the Seed_Payload.
2. WHEN Hook_Merge runs, THE Installer SHALL set the merged object's `description` field to the kiro-learn description string, overwriting any value in the Seed_Payload.
3. WHEN Hook_Merge runs, FOR EACH trigger in Installer_Hook_Triggers, THE Installer SHALL set the merged object's `hooks.<trigger>` array to the kiro-learn hook entry for that trigger, overwriting any array present in the Seed_Payload at that trigger.
4. WHEN the Seed_Payload contains a `hooks` object with entries on trigger names outside Installer_Hook_Triggers (e.g. `preToolUse`), THE Installer SHALL preserve those entries unchanged in the merged object.
5. WHEN the Seed_Payload does not contain a `hooks` field at all, THE Installer SHALL produce a merged object whose `hooks` field contains only the four Installer_Hook_Triggers.
6. WHEN the Seed_Payload carries an existing hook array on one of the four Installer_Hook_Triggers, THE Installer SHALL overwrite that array with kiro-learn's hook and SHALL NOT emit a warning about the overwrite — hook ownership of those four triggers is expected behaviour, not an exceptional condition.
7. FOR EACH key in the Seed_Payload that is not `name`, `description`, or `hooks`, THE Installer SHALL copy the value into the merged object unchanged.

### Requirement 5: Merged File Write

**User Story:** As an installer author, I want the merged result to land at the same file path `kiro-cli` wrote, so that there is exactly one kiro-learn agent file per scope at the end of the install flow.

#### Acceptance Criteria

1. WHEN Hook_Merge completes, THE Installer SHALL serialize the merged object to JSON with two-space indentation followed by a trailing newline.
2. THE Installer SHALL write the serialized merged object to `<target-dir>/kiro-learn.json`, overwriting the Pristine_Default at that path.
3. THE Installer SHALL perform the merged-file write for each Agent_Scope independently — the global merged file and the project-scoped merged file are written in separate steps from their respective Seed_Payloads.

### Requirement 6: Fallback Behaviour

**User Story:** As a kiro-learn user on a machine where `kiro-cli` is absent or the seed command fails, I want `kiro-learn init` to still complete and leave a working (if degraded) agent in place, so that a stale or missing `kiro-cli` does not block installation.

#### Acceptance Criteria

1. WHEN the seed for a given Agent_Scope fails per Requirement 1.6, 1.7, 3.2, or 3.3, THE Installer SHALL write the Fallback_Config to `<target-dir>/kiro-learn.json` for that scope.
2. THE Fallback_Config SHALL contain the fields `name` (set to `kiro-learn`), `description` (set to the kiro-learn description string), and `hooks` (containing exactly the four Installer_Hook_Triggers and no others).
3. WHEN the Installer writes a Fallback_Config for any Agent_Scope, THE Installer SHALL emit a single Fallback_Warning to stderr, prefixed with `[kiro-learn]`, that communicates the scope affected, the cause (kiro-cli unavailable or seed command failed), the effect (minimal hooks-only config — no default tools, prompt, or MCP servers), and the recovery step (install or upgrade kiro-cli and rerun `kiro-learn init`).
4. WHEN the seed fails for one scope but succeeds for another (e.g. global seeds successfully but project-scoped fails), THE Installer SHALL apply fallback only to the failing scope — the other scope keeps its merged result.
5. WHEN fallback applies, THE Installer SHALL return from `cmdInit` with a zero exit code — a seed failure is not an install failure.

### Requirement 7: Idempotency on Re-run

**User Story:** As a kiro-learn user who upgrades `kiro-cli`, I want each `kiro-learn init` run to pick up any changes in `kiro_default` since the last install, so that kiro-learn's inherited tools, prompt, and MCP servers stay in lockstep with whatever `kiro-cli` ships.

#### Acceptance Criteria

1. WHEN `kiro-learn init` is invoked and a prior merged kiro-learn agent file exists in the Seed_Target_Directory, THE Installer SHALL still perform the pre-seed delete and re-invoke the Seed_Command — it SHALL NOT skip seeding on the grounds that the file already exists.
2. WHEN `kiro_default` as resolved by `kiro-cli` has changed between two successive `kiro-learn init` invocations, THE merged kiro-learn agent after the second run SHALL reflect the updated Seed_Payload with kiro-learn's four hooks reapplied on top.
3. WHEN `kiro_default` as resolved by `kiro-cli` has not changed between two successive `kiro-learn init` invocations, the merged kiro-learn agent after each run SHALL be byte-for-byte equivalent with respect to all fields the Installer controls (Hook_Merge is deterministic).

### Requirement 8: Compressor Agent Unchanged

**User Story:** As a maintainer, I want the compressor agent to remain a minimal zero-tools XML-extraction agent, so that extraction prompts stay deterministic and unaffected by changes to `kiro_default`.

#### Acceptance Criteria

1. THE Installer SHALL NOT invoke the Seed_Command for `kiro-learn-compressor.json`.
2. THE Installer SHALL write `kiro-learn-compressor.json` with the same hand-authored content it writes today (name, description, XML-extraction prompt, empty `tools`, empty `allowedTools`).
3. THE compressor agent SHALL remain at global scope only — no project-scoped compressor file is written.

### Requirement 9: Scope Parity

**User Story:** As a kiro-learn user working in a project, I want the project-scoped kiro-learn agent to have the same default-equivalent content as the global one, so that overriding the global agent in a workspace does not silently drop back to a stripped-down config.

#### Acceptance Criteria

1. WHEN the Installer writes a project-scoped `.kiro/agents/kiro-learn.json`, THE Installer SHALL seed it using the Seed_Command against the project's `.kiro/agents/` directory and apply Hook_Merge — the same flow as for the global scope.
2. THE project-scoped file and the global file SHALL each have their own pre-seed delete, their own Seed_Command invocation, and their own Hook_Merge result.
3. WHEN seeding fails for one scope, THE other scope SHALL proceed independently per Requirement 6.4.
4. THE Installer SHALL NOT copy the global merged file into the project scope as a shortcut — each scope reseeds from `kiro_default` so that project-local customisations of `kiro_default` (if any) take effect for the project-scoped file.

### Requirement 10: Inheritance of User Customisations to kiro_default

**User Story:** As a user who has customised `~/.kiro/agents/kiro_default.json`, I want my customisations to flow through into the installed kiro-learn agent, so that the agent I use daily continues to reflect my configuration after kiro-learn is installed.

#### Acceptance Criteria

1. THE Installer SHALL rely on `kiro-cli`'s own `--from kiro_default` resolution, which follows `kiro-cli`'s precedence order (local > global > built-in) for resolving the name `kiro_default`.
2. WHEN the user has a customised `~/.kiro/agents/kiro_default.json`, the Seed_Payload for any scope SHALL reflect that customisation to the extent `kiro-cli` exposes it through `agent create --from kiro_default`.
3. THE Installer SHALL NOT attempt to read `kiro_default.json` directly — all inheritance goes through `kiro-cli agent create`.

### Requirement 11: Warning Wording

**User Story:** As a user who sees the Fallback_Warning on stderr, I want the message to tell me what happened and what to do about it, so that I can recover without hunting through docs.

#### Acceptance Criteria

1. THE Fallback_Warning SHALL begin with the literal prefix `[kiro-learn] warning:`.
2. THE Fallback_Warning SHALL name the cause as one of: `kiro-cli unavailable` or `seed command failed`.
3. THE Fallback_Warning SHALL state the effect as: writing a minimal hooks-only config, with no default tools, prompt, or MCP servers.
4. THE Fallback_Warning SHALL name the recovery as: install or upgrade `kiro-cli` and rerun `kiro-learn init`.
5. A reference message that satisfies 11.1–11.4 is: `[kiro-learn] warning: could not seed kiro-learn agent from kiro_default (kiro-cli unavailable or seed command failed). Writing minimal hooks-only config — the agent will not have the default tools, prompt, or MCP servers until you install/upgrade kiro-cli and rerun 'kiro-learn init'.`

### Requirement 12: Observable Ordering

**User Story:** As a test author, I want the observable order of filesystem operations per scope to be fixed, so that integration tests can reason about intermediate states deterministically.

#### Acceptance Criteria

1. FOR EACH Agent_Scope, the Installer SHALL perform the following steps in this order: (a) delete the existing `<target-dir>/kiro-learn.json` if present, (b) invoke the Seed_Command, (c) read and validate the Seed_Payload, (d) on seed success, apply Hook_Merge and write the merged result to `<target-dir>/kiro-learn.json`, (e) on seed failure, write the Fallback_Config to `<target-dir>/kiro-learn.json` and emit the Fallback_Warning.
2. THE Installer SHALL complete all steps for one Agent_Scope before beginning step (a) for the next scope, so the two scopes' filesystem operations do not interleave.
3. THE Installer SHALL run the Seed_Command with `EDITOR=true` so step (b) terminates without user interaction.
