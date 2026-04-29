# Requirements: IDE Stop Hook — askAgent Migration

## Introduction

This document defines the requirements for migrating the `kiro-learn-stop.kiro.hook` IDE hook from `runCommand` to `askAgent`. The current `runCommand` stop hook invokes the IDE shim executable, but the Kiro IDE sends no payload in `USER_PROMPT` for `agentStop` events. The shim's `handleStop` function bails out early on empty input (`if (userPrompt === '') return;`), so no `session_summary` event is ever published for IDE sessions. This means the memory system has zero session-end signal from IDE usage.

The `askAgent` action type triggers a new agent turn with a prompt. Because `agentStop` fires "when the agent has completed its turn and finished responding to the user," the agent has full conversation context at that point. The prompt instructs the agent to call the `save_session_summary` MCP tool (already implemented in `src/mcp/tools.ts` and registered on the `kiro-learn-memory` MCP server), which POSTs a structured session summary to the collector.

**In scope:** Changing the stop hook file format from `runCommand` to `askAgent`, crafting the `askAgent` prompt, updating the installer's `writeIdeHookFiles()` function, and updating tests for the new hook format.

**Out of scope:** Changes to the `handleStop` function in `src/shim/ide-hook/index.ts` (it remains as-is for the CLI path and backward compatibility), changes to the `save_session_summary` MCP tool (already implemented and tested), changes to the prompt and tool hooks (they remain as `runCommand`).

## Glossary

- **Stop_Hook_File**: The IDE hook file at `.kiro/hooks/kiro-learn-stop.kiro.hook` that declares the `agentStop` trigger. Currently uses `runCommand`; this feature changes it to `askAgent`.
- **askAgent_Action**: A Kiro IDE hook action type (`"type": "askAgent"`) that triggers a new agent turn with a specified prompt string, giving the agent full conversation context. Defined in the `then` block of a `.kiro.hook` file as `{ "type": "askAgent", "prompt": "<instruction>" }`.
- **runCommand_Action**: A Kiro IDE hook action type (`"type": "runCommand"`) that executes a shell command. The existing prompt and tool hooks use this action type and are unaffected by this change.
- **save_session_summary_Tool**: The MCP tool registered on the `kiro-learn-memory` MCP server at `src/mcp/tools.ts`. Accepts `request`, `investigated`, `learned`, `completed`, `next_steps`, `files_read`, and `files_modified` fields. POSTs a structured memory record to the collector daemon.
- **Session_Summary_Prompt**: The instruction string embedded in the stop hook's `then.prompt` field. Directs the agent to call the `save_session_summary` MCP tool with the required fields derived from the conversation context.
- **Installer**: The `src/installer/index.ts` module that generates IDE hook files via `writeIdeHookFiles()`.
- **IDE_Shim**: The surface-specific adapter at `src/shim/ide-hook/index.ts`. Its `handleStop` function remains unchanged — it continues to handle the CLI path where `USER_PROMPT` might eventually be populated.
- **Hook_Manifest**: The complete set of three `.kiro.hook` files kiro-learn writes to `.kiro/hooks/` during installation: `kiro-learn-prompt.kiro.hook`, `kiro-learn-stop.kiro.hook`, and `kiro-learn-tool.kiro.hook`.

## Requirements

### Requirement 1: Stop Hook Action Type Change

**User Story:** As a kiro-learn user, I want the IDE stop hook to use `askAgent` instead of `runCommand`, so that session summaries are captured at the end of every IDE session using the agent's full conversation context.

#### Acceptance Criteria

1. THE Installer SHALL generate `kiro-learn-stop.kiro.hook` with `then.type` set to `"askAgent"` instead of `"runCommand"`.
2. THE Installer SHALL generate `kiro-learn-stop.kiro.hook` with a `then.prompt` field containing the Session_Summary_Prompt string.
3. THE Installer SHALL NOT include a `then.command` field in the stop hook file, since `askAgent` actions use `prompt` instead of `command`.
4. THE stop hook file SHALL retain `when.type` set to `"agentStop"` with no change to the trigger configuration.
5. THE stop hook file SHALL retain `enabled: true`, `version: "1"`, and the same `name` and `description` fields as the current stop hook.

### Requirement 2: Prompt and Tool Hooks Unchanged

**User Story:** As a kiro-learn developer, I want the prompt and tool hooks to remain as `runCommand`, so that only the stop hook behavior changes and the existing event capture pipeline is unaffected.

#### Acceptance Criteria

1. THE Installer SHALL continue to generate `kiro-learn-prompt.kiro.hook` with `then.type` set to `"runCommand"` and a `then.command` field referencing the IDE shim executable.
2. THE Installer SHALL continue to generate `kiro-learn-tool.kiro.hook` with `then.type` set to `"runCommand"` and a `then.command` field referencing the IDE shim executable.
3. THE prompt hook file SHALL retain `when.type: "promptSubmit"` and the `|| true` suffix on the command.
4. THE tool hook file SHALL retain `when.type: "postToolUse"`, `when.toolTypes: ["*"]`, and the `|| true` suffix on the command.

### Requirement 3: Session Summary Prompt Content

**User Story:** As a kiro-learn developer, I want the askAgent prompt to instruct the agent to call the `save_session_summary` MCP tool with all required fields, so that the agent produces a structured, useful session summary from its conversation context.

#### Acceptance Criteria

1. THE Session_Summary_Prompt SHALL reference the `save_session_summary` tool by its exact registered name.
2. THE Session_Summary_Prompt SHALL reference the `kiro-learn-memory` MCP server by name so the agent can locate the tool.
3. THE Session_Summary_Prompt SHALL list all seven required fields of the `save_session_summary` tool: `request`, `investigated`, `learned`, `completed`, `next_steps`, `files_read`, and `files_modified`.
4. THE Session_Summary_Prompt SHALL instruct the agent to derive field values from the conversation context of the current session.
5. THE Session_Summary_Prompt SHALL be concise to minimize token consumption, since each `askAgent` invocation consumes a full agent turn with associated credits.
6. THE Session_Summary_Prompt SHALL instruct the agent to complete the tool call without additional commentary or user interaction, since the session is ending.

### Requirement 4: Hook File Format Validity

**User Story:** As a kiro-learn developer, I want the updated stop hook file to conform to the Kiro IDE hook schema for `askAgent` actions, so that the IDE correctly triggers the agent turn on session stop.

#### Acceptance Criteria

1. THE stop hook file SHALL be valid JSON conforming to the Kiro IDE hook schema: an object with `enabled` (boolean), `name` (string), `description` (string), `version` (string), `when` (object with `type` string), and `then` (object with `type` string and `prompt` string).
2. THE stop hook file field order SHALL be: `enabled`, `name`, `description`, `version`, `when`, `then` — matching the convention used by the other two hook files.
3. THE Installer SHALL serialize the stop hook file using `JSON.stringify` with 2-space indentation and a trailing newline, matching the project's JSON formatting convention.
4. FOR ALL valid stop hook file objects, serializing then parsing SHALL produce an equivalent object (round-trip property).

### Requirement 5: IDE Shim Backward Compatibility

**User Story:** As a kiro-learn developer, I want the existing `handleStop` function in the IDE shim to remain unchanged, so that the CLI path and any future `USER_PROMPT` population for `agentStop` events continue to work.

#### Acceptance Criteria

1. THE `handleStop` function in `src/shim/ide-hook/index.ts` SHALL NOT be modified as part of this change.
2. THE IDE shim's `main()` function SHALL continue to dispatch `agentStop` events to `handleStop` when invoked via the CLI path.
3. THE IDE shim's early return on empty `USER_PROMPT` (`if (userPrompt === '') return;`) SHALL remain in place — it correctly handles the case where the shim is invoked without payload data.

### Requirement 6: Upgrade Behavior

**User Story:** As a kiro-learn user, I want re-running `kiro-learn init` to update the stop hook from `runCommand` to `askAgent`, so that existing installations get the new behavior without manual intervention.

#### Acceptance Criteria

1. WHEN `kiro-learn init` runs on a project that already has a `kiro-learn-stop.kiro.hook` file with `then.type: "runCommand"`, THE Installer SHALL overwrite it with the new `askAgent` format.
2. THE Installer SHALL preserve non-kiro-learn hook files in `.kiro/hooks/` during the upgrade.
3. THE upgrade behavior SHALL be identical to the existing overwrite-on-upgrade behavior — no special migration logic is needed since `writeIdeHookFiles` always writes all three hook files.

### Requirement 7: Hook File Name Stability

**User Story:** As a kiro-learn developer, I want the stop hook file name to remain `kiro-learn-stop.kiro.hook`, so that the `IDE_HOOK_FILES` constant, `removeIdeHookFiles`, and uninstall cleanup continue to work without modification.

#### Acceptance Criteria

1. THE stop hook file name SHALL remain `kiro-learn-stop.kiro.hook` with no change.
2. THE `IDE_HOOK_FILES` constant in `src/installer/index.ts` SHALL NOT require modification.
3. THE `removeIdeHookFiles` function SHALL continue to correctly remove the stop hook file during uninstall without modification.

## Correctness Properties

### Property 1: Stop Hook Uses askAgent

FOR ALL invocations of `writeIdeHookFiles`, the generated `kiro-learn-stop.kiro.hook` file SHALL have `then.type` equal to `"askAgent"` and SHALL have a `then.prompt` field that is a non-empty string. The file SHALL NOT have a `then.command` field.

**Validates: Requirements 1.1, 1.2, 1.3**

### Property 2: Prompt and Tool Hooks Use runCommand

FOR ALL invocations of `writeIdeHookFiles`, the generated `kiro-learn-prompt.kiro.hook` and `kiro-learn-tool.kiro.hook` files SHALL have `then.type` equal to `"runCommand"` and SHALL have a `then.command` field that is a non-empty string. These files SHALL NOT have a `then.prompt` field.

**Validates: Requirements 2.1, 2.2**

### Property 3: Prompt References Required Tool Fields

THE Session_Summary_Prompt embedded in the stop hook's `then.prompt` field SHALL contain the substrings `save_session_summary`, `request`, `investigated`, `learned`, `completed`, `next_steps`, `files_read`, and `files_modified`.

**Validates: Requirements 3.1, 3.3**

### Property 4: Hook File Round-Trip

FOR ALL hook file objects generated by `writeIdeHookFiles` (including the updated stop hook), `JSON.parse(JSON.stringify(hookFile, null, 2))` SHALL produce a deeply equal object.

**Validates: Requirements 4.4**

### Property 5: Hook File Schema Conformance

FOR ALL three hook files generated by `writeIdeHookFiles`, each file SHALL be valid JSON with exactly the keys `enabled`, `name`, `description`, `version`, `when`, `then` in that order. The `enabled` field SHALL be `true`, the `version` field SHALL be `"1"`, and the `when` object SHALL have a `type` field that is a non-empty string.

**Validates: Requirements 1.4, 1.5, 4.1, 4.2**

### Property 6: Action Type Partitioning

FOR ALL three hook files generated by `writeIdeHookFiles`, exactly one file (the stop hook) SHALL have `then.type: "askAgent"` and exactly two files (prompt and tool hooks) SHALL have `then.type: "runCommand"`. No hook file SHALL have any other `then.type` value.

**Validates: Requirements 1.1, 2.1, 2.2**

## Non-functional Requirements

### Token Efficiency

- N1. THE Session_Summary_Prompt SHALL be under 200 words to minimize token consumption per agent turn, since `askAgent` actions consume credits.

### Reliability

- N2. THE `askAgent` action does not require an `|| true` suffix because it is not a shell command — the IDE handles agent turn failures internally. A failed agent turn does not block the IDE session.
- N3. THE `askAgent` action fires once per session (on `agentStop`), so the credit cost is bounded to one additional agent turn per session.

### Compatibility

- N4. THE change is backward-compatible at the uninstall level — `removeIdeHookFiles` removes files by name, and the file name is unchanged.
- N5. THE kiro-cli path is unaffected — the CLI stop hook carries `assistant_response` in its stdin payload and continues to work via the cli-agent shim.
- N6. THE `handleStop` function in the IDE shim remains as-is for backward compatibility with any future `runCommand` invocations.
