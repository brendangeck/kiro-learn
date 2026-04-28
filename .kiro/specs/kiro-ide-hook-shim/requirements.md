# Requirements: Kiro IDE Hook Shim

## Introduction

This document defines the requirements for the Kiro IDE hook shim — the surface-specific adapter that bridges Kiro IDE's `.kiro/hooks/*.kiro.hook` mechanism and the kiro-learn collector daemon. The IDE shim achieves the same goals as the existing CLI agent shim (`src/shim/cli-agent/`) but through the IDE's hook execution model instead of kiro-cli's stdin-JSON model.

The IDE shim builds on the shared shim internals already established in `src/shim/shared/` (configuration, session management, event building, body truncation, HTTP transport) and the contracts from [event-schema-and-storage](../event-schema-and-storage/requirements.md) (the canonical `KiroMemEvent` type with `source.surface: 'kiro-ide'`) and [collector-pipeline](../collector-pipeline/requirements.md) (the `POST /v1/events` endpoint).

**In scope:** IDE hook file generation (`.kiro/hooks/*.kiro.hook`), the IDE-specific shim executable that those hooks invoke, IDE hook input parsing via the `USER_PROMPT` environment variable, event construction with `source.surface: 'kiro-ide'`, session management for IDE sessions, HTTP transport to the collector, stdout output for retrieval context injection, and installer integration to deploy the hook files.

**Out of scope:** Collector implementation, storage, extraction, CLI agent shim changes, daemon lifecycle, MCP tool wrappers (separate v1 item), local spool/retry (v2+).

### Key Findings from IDE Hook Payload Investigation

The Kiro IDE hook execution model differs from kiro-cli in several important ways, confirmed by empirical testing:

1. **No stdin.** The IDE does not pipe any data to stdin for `runCommand` hooks. All payload data is delivered via the `USER_PROMPT` environment variable.
2. **`USER_PROMPT` is the universal payload env var.** It is set for all hook event types, not just `promptSubmit`.
3. **`promptSubmit` payload is plain text.** `USER_PROMPT` contains the raw user prompt string (e.g., `test message!`), not JSON.
4. **`postToolUse` payload is camelCase JSON.** `USER_PROMPT` contains `{"toolName":"...","toolArgs":{},"toolResult":"...","toolSuccess":true}`. This differs from kiro-cli's snake_case nested format (`tool_name`, `tool_input`, `tool_response.result`, `tool_response.success`).
5. **`runCommand` stdout is injected into agent context on exit 0.** Per the [Kiro docs](https://kiro.dev/docs/hooks/actions/), "If the command returns an exit code of 0 indicating success, the stdout output of the command is added to the agent's context." This enables retrieval context injection.
6. **Non-zero exit blocks the triggering action.** For `promptSubmit`, a non-zero exit blocks the user's prompt. For `preToolUse`, it blocks the tool invocation. The `|| true` suffix and always-exit-0 behavior are therefore load-bearing safety requirements.
7. **No `agentSpawn` equivalent.** The IDE has no spawn lifecycle event. Session creation must be handled implicitly on first event.
8. **`cwd` is the project root.** The IDE executes hook commands with `PWD` set to the workspace root. The shim uses `process.cwd()` instead of a `cwd` field in the payload.
9. **`agentStop` payload is unconfirmed.** We were unable to capture the `agentStop` payload during investigation. The shim should handle both the case where `USER_PROMPT` contains the assistant's response text and the case where it is empty or absent.

## Glossary

- **IDE_Shim**: The surface-specific adapter at `src/shim/ide-hook/index.ts` that handles Kiro IDE hook invocations. Consumes `src/shim/shared/` for event building, transport, and session management. Sets `source.surface` to `'kiro-ide'`.
- **IDE_Hook_File**: A JSON file at `.kiro/hooks/<name>.kiro.hook` that declares a Kiro IDE hook. Contains `enabled` (boolean), `name` (string), `description` (string), `version` (string), `when` (trigger definition), and `then` (action definition) fields.
- **Hook_Manifest**: The complete set of `.kiro.hook` files kiro-learn writes to `.kiro/hooks/` during installation. One file per hook event type: `promptSubmit`, `agentStop`, `postToolUse`.
- **Shim_Executable**: The Node.js wrapper script at `~/.kiro-learn/bin/ide-shim` that the IDE hook files reference in their `then.command` field. Invokes the compiled IDE shim module.
- **Hook_Event_Type**: The Kiro IDE event type string used in the `when.type` field of a hook file. Maps to kiro-learn event kinds: `promptSubmit` → `prompt`, `agentStop` → `session_summary`, `postToolUse` → `tool_use`.
- **USER_PROMPT**: The environment variable set by the Kiro IDE when executing `runCommand` hooks. Contains the hook payload: plain text for `promptSubmit`, JSON for `postToolUse`, and unconfirmed format for `agentStop`.
- **Collector_Endpoint**: The local HTTP endpoint (`POST /v1/events`) hosted by the collector daemon at `127.0.0.1` on a configurable port (default `21100`).
- **Context_Injection**: For `runCommand` hooks that exit 0, the Kiro IDE captures stdout and adds it to the agent's context. The IDE shim uses this mechanism to deliver retrieval context on `promptSubmit`.
- **Shared_Shim**: The `src/shim/shared/` module containing configuration loading, session management, event building, body truncation, and HTTP transport — consumed by both the CLI agent shim and the IDE shim.

## Requirements

### Requirement 1: IDE Hook File Format

**User Story:** As a kiro-learn user, I want kiro-learn to generate valid Kiro IDE hook files, so that memory capture activates automatically when I use Kiro inside the IDE.

#### Acceptance Criteria

1. THE Installer SHALL write IDE hook files to the `.kiro/hooks/` directory within the project root during `kiro-learn init` when a project scope is detected.
2. WHEN a project scope is detected, THE Installer SHALL create the `.kiro/hooks/` directory if it does not exist.
3. THE Installer SHALL generate one `.kiro.hook` file per hook event type: `kiro-learn-prompt.kiro.hook`, `kiro-learn-stop.kiro.hook`, and `kiro-learn-tool.kiro.hook`.
4. Each IDE hook file SHALL be valid JSON conforming to the Kiro IDE hook schema: an object with `enabled` (boolean), `name` (string), `description` (string), `version` (string), `when` (object with `type` string), and `then` (object with `type` string and `command` string).
5. THE `enabled` field SHALL be `true` for all kiro-learn hook files.
6. THE `version` field in each hook file SHALL be `"1"`.
7. THE `then.type` field SHALL be `"runCommand"` for all kiro-learn hook files.
8. THE `then.command` field SHALL reference the Shim_Executable path with the hook event type as a CLI argument and an `|| true` suffix to ensure the IDE session is never blocked by shim failures (e.g., `"~/.kiro-learn/bin/ide-shim" promptSubmit || true`).

### Requirement 2: Hook Event Type Mapping

**User Story:** As a kiro-learn developer, I want each IDE hook event type to map to the correct kiro-learn event kind, so that the collector receives semantically correct events from IDE sessions.

#### Acceptance Criteria

1. THE hook file `kiro-learn-prompt.kiro.hook` SHALL use `when.type: "promptSubmit"` and map to event kind `prompt`.
2. THE hook file `kiro-learn-stop.kiro.hook` SHALL use `when.type: "agentStop"` and map to event kind `session_summary`.
3. THE hook file `kiro-learn-tool.kiro.hook` SHALL use `when.type: "postToolUse"` and map to event kind `tool_use`.
4. THE `kiro-learn-tool.kiro.hook` file SHALL include `when.toolTypes: ["*"]` to capture all tool invocations, matching the CLI shim's `matcher: '*'` behavior.
5. THE IDE_Shim SHALL NOT register a hook for `preToolUse` — kiro-learn captures events passively and must never block tool invocations.

### Requirement 3: IDE Shim Executable

**User Story:** As a kiro-learn developer, I want a dedicated IDE shim entry point, so that IDE hook invocations are handled by code that understands the IDE's input format without coupling to the CLI agent shim.

#### Acceptance Criteria

1. THE IDE_Shim SHALL be implemented at `src/shim/ide-hook/index.ts` as a new surface-specific shim module.
2. THE IDE_Shim SHALL import shared logic from `src/shim/shared/index.ts` for configuration loading, session management, event building, body truncation, and HTTP transport.
3. THE IDE_Shim SHALL NOT import from `src/shim/cli-agent/`, `src/collector/`, or `src/installer/`. The modularity boundary is enforced by guard tests.
4. THE Installer SHALL write a bin wrapper script at `~/.kiro-learn/bin/ide-shim` that invokes the compiled IDE shim module, following the same pattern as the existing `~/.kiro-learn/bin/shim` wrapper.
5. THE IDE_Shim SHALL export a `main()` function as its entry point, matching the CLI shim's convention.

### Requirement 4: IDE Hook Input Parsing

**User Story:** As a kiro-learn developer, I want the IDE shim to correctly parse hook input from the `USER_PROMPT` environment variable, so that event data is extracted from the IDE's payload format.

#### Acceptance Criteria

1. THE IDE_Shim SHALL accept a hook event type as its first command-line argument (e.g., `ide-shim promptSubmit`, `ide-shim postToolUse`, `ide-shim agentStop`).
2. THE IDE_Shim SHALL read hook payload data from the `USER_PROMPT` environment variable. THE IDE_Shim SHALL NOT read from stdin — the Kiro IDE does not pipe data to stdin for `runCommand` hooks.
3. WHEN `USER_PROMPT` is unset or empty, THE IDE_Shim SHALL proceed with default values for the event body (empty string for text content, empty object for JSON data).
4. THE IDE_Shim SHALL derive `cwd` from `process.cwd()` since the IDE executes hook commands in the project's working directory.
5. IF the command-line argument is missing or unrecognized, THE IDE_Shim SHALL log a warning to stderr with the `[kiro-learn]` prefix and exit with code 0.
6. WHEN the hook event type is `promptSubmit`, THE IDE_Shim SHALL treat `USER_PROMPT` as a plain text string containing the user's prompt.
7. WHEN the hook event type is `postToolUse`, THE IDE_Shim SHALL parse `USER_PROMPT` as JSON with the shape `{ toolName: string, toolArgs: object, toolResult: string, toolSuccess: boolean }`.
8. WHEN the hook event type is `agentStop`, THE IDE_Shim SHALL treat `USER_PROMPT` as a plain text string containing the assistant's response. IF `USER_PROMPT` is not a plain string (e.g., JSON), THE IDE_Shim SHALL use it as-is for the summary body.
9. WHEN JSON parsing fails for `postToolUse`, THE IDE_Shim SHALL log a warning to stderr and proceed with default values (`tool_name: "unknown"`, empty objects for input and response).

### Requirement 5: Source Surface Identification

**User Story:** As a kiro-learn developer, I want IDE-originated events to be distinguishable from CLI-originated events, so that the collector and downstream consumers can differentiate between the two surfaces.

#### Acceptance Criteria

1. THE IDE_Shim SHALL set `source.surface` to `'kiro-ide'` on all events it produces.
2. THE Shared_Shim's `buildEvent` function SHALL accept a `surface` parameter to allow surface-specific shims to specify their source surface.
3. THE CLI agent shim SHALL continue to set `source.surface` to `'kiro-cli'` with no behavioral change.
4. THE `source.surface` value `'kiro-ide'` is already a valid value in the `EventSourceSchema` (Zod enum includes both `'kiro-cli'` and `'kiro-ide'`). No schema change is required.

### Requirement 6: Session Management for IDE Sessions

**User Story:** As a kiro-learn user, I want IDE sessions to have stable session IDs, so that events from the same IDE session are grouped correctly even though the IDE does not have an explicit "agent spawn" lifecycle event.

#### Acceptance Criteria

1. THE IDE_Shim SHALL reuse the existing session management functions from Shared_Shim (`createSession`, `readSession`, `sessionFilePath`).
2. THE IDE_Shim SHALL use `readSession` for all hook types, relying on its built-in fallback behavior (generates a new UUID and writes it to the session file if the file is missing or invalid). This provides implicit session creation without an explicit spawn event.
3. THE session file path derivation SHALL use the same algorithm as the CLI shim: `/tmp/kiro-learn-session-<hash>` where `<hash>` is the first 16 hex characters of the MD5 of the resolved `cwd`.
4. IDE sessions and CLI sessions operating on the same `cwd` SHALL share the same session file. This is intentional — it provides continuity when a user switches between CLI and IDE within the same project.

### Requirement 7: Event Construction for IDE Hooks

**User Story:** As a kiro-learn developer, I want the IDE shim to construct well-formed events for each hook type, so that IDE-originated events are indistinguishable from CLI events in the collector pipeline (except for `source.surface`).

#### Acceptance Criteria

1. WHEN the `promptSubmit` hook fires, THE IDE_Shim SHALL produce an event with `kind: "prompt"` and `body: { type: "text", content: <prompt_text> }` where `<prompt_text>` is the `USER_PROMPT` env var value, or an empty string if unset.
2. WHEN the `postToolUse` hook fires, THE IDE_Shim SHALL produce an event with `kind: "tool_use"` and `body: { type: "json", data: { tool_name, tool_input, tool_response } }`. THE IDE_Shim SHALL map the IDE's camelCase payload fields to the kiro-learn snake_case convention: `toolName` → `tool_name`, `toolArgs` → `tool_input`, `toolResult` → `tool_response.result`, `toolSuccess` → `tool_response.success`.
3. WHEN the `agentStop` hook fires, THE IDE_Shim SHALL produce an event with `kind: "session_summary"` and `body: { type: "text", content: <summary_text> }` where `<summary_text>` is the `USER_PROMPT` env var value, or an empty string if unset.
4. THE IDE_Shim SHALL apply body truncation via the Shared_Shim's `truncateBody` function before posting, using the same 512 KiB limit as the CLI shim.
5. WHEN a field required for body construction is missing from the `USER_PROMPT` payload, THE IDE_Shim SHALL use sensible defaults: empty string for text content, `"unknown"` for `tool_name`, empty object `{}` for `tool_input` and `tool_response`.

### Requirement 8: Retrieval Context Output

**User Story:** As a kiro-learn user, I want retrieval context injected into my IDE sessions, so that the agent has access to prior observations when I submit a prompt in the IDE.

#### Acceptance Criteria

1. WHEN the `promptSubmit` hook fires, THE IDE_Shim SHALL POST the event with `retrieve=true` to request synchronous retrieval context from the collector.
2. WHEN the collector response contains a `retrieval` field with a non-empty `context` string, THE IDE_Shim SHALL write the retrieval context to stdout. The Kiro IDE captures stdout from `runCommand` hooks that exit 0 and adds it to the agent's context.
3. WHEN the collector response contains no `retrieval` field or an empty `context`, THE IDE_Shim SHALL write nothing to stdout.
4. WHEN the `postToolUse` or `agentStop` hooks fire, THE IDE_Shim SHALL POST with `retrieve=false` and write nothing to stdout.

### Requirement 9: Installer Integration for IDE Hooks

**User Story:** As a kiro-learn user, I want `kiro-learn init` to set up IDE hooks automatically when a project is detected, so that I don't need manual configuration to use kiro-learn in the IDE.

#### Acceptance Criteria

1. WHEN `kiro-learn init` detects a project scope, THE Installer SHALL write the Hook_Manifest (three `.kiro.hook` files) to `<projectRoot>/.kiro/hooks/`.
2. THE Installer SHALL create the `<projectRoot>/.kiro/hooks/` directory if it does not exist.
3. THE Installer SHALL write the `ide-shim` bin wrapper to `~/.kiro-learn/bin/ide-shim` alongside the existing `shim` wrapper.
4. WHEN `kiro-learn init` runs with `--global-only`, THE Installer SHALL NOT write IDE hook files (IDE hooks are project-scoped only).
5. ON upgrade (re-running `kiro-learn init`), THE Installer SHALL overwrite existing kiro-learn hook files with the current version. Non-kiro-learn hook files in `.kiro/hooks/` SHALL be preserved.
6. THE Installer SHALL NOT write IDE hook files when no project scope is detected (running from `$HOME` or above).
7. THE Installer SHALL deploy the compiled IDE shim module to `~/.kiro-learn/lib/shim/ide-hook/` as part of the payload deployment step.

### Requirement 10: Uninstall Cleanup for IDE Hooks

**User Story:** As a kiro-learn user, I want `kiro-learn uninstall` to remove IDE hook files, so that no orphaned hooks remain after uninstallation.

#### Acceptance Criteria

1. WHEN `kiro-learn uninstall` runs and a project scope is detected, THE Installer SHALL remove the three kiro-learn `.kiro.hook` files from `<projectRoot>/.kiro/hooks/`.
2. THE Installer SHALL NOT remove non-kiro-learn hook files from `.kiro/hooks/`.
3. THE Installer SHALL NOT remove the `.kiro/hooks/` directory itself (it may contain other hooks).
4. IF a kiro-learn hook file does not exist during uninstall, THE Installer SHALL skip it without error (idempotent).
5. THE `ide-shim` bin wrapper SHALL be removed as part of the existing `~/.kiro-learn/bin/` cleanup during uninstall.

### Requirement 11: Error Handling and Exit Behavior

**User Story:** As a Kiro IDE user, I want the IDE shim to never block or crash my IDE session, so that memory capture is invisible when it works and harmless when it fails.

#### Acceptance Criteria

1. THE IDE_Shim SHALL exit with code 0 in all cases — success, collector down, parse error, timeout, or any unexpected exception. This is critical because a non-zero exit from a `promptSubmit` hook blocks the user's prompt, and a non-zero exit from a `preToolUse` hook blocks the tool invocation.
2. THE IDE_Shim SHALL wrap the entire execution in a top-level try/catch. IF an uncaught exception occurs, THE IDE_Shim SHALL log the error to stderr and exit with code 0.
3. THE IDE_Shim SHALL complete execution within a total budget of 3 seconds. The `|| true` suffix in the hook command provides an additional safety net.
4. WHEN the IDE_Shim logs warnings or errors to stderr, THE format SHALL include a `[kiro-learn]` prefix for identification.
5. THE IDE_Shim SHALL NOT write diagnostic messages to stdout. All diagnostic output goes to stderr. Stdout is reserved exclusively for retrieval context injection.

### Requirement 12: Modularity Guard Tests

**User Story:** As a kiro-learn developer, I want modularity boundaries enforced by automated tests, so that the IDE shim cannot accidentally couple to the CLI shim, collector, or installer.

#### Acceptance Criteria

1. A guard test SHALL verify that `src/shim/ide-hook/` does not import from `src/shim/cli-agent/`.
2. A guard test SHALL verify that `src/shim/ide-hook/` does not import from `src/collector/` or `src/installer/`.
3. A guard test SHALL verify that `src/shim/shared/` does not import from `src/shim/ide-hook/` (dependency direction is ide-hook → shared, never reverse).
4. THE existing guard test `no-collector-in-shim` SHALL continue to pass, covering the new `src/shim/ide-hook/` directory.

### Requirement 13: Hook File Serialization and Parsing

**User Story:** As a kiro-learn developer, I want hook file generation to be deterministic and round-trippable, so that tests can verify the output and upgrades produce stable diffs.

#### Acceptance Criteria

1. THE Installer SHALL serialize hook files using `JSON.stringify` with 2-space indentation and a trailing newline, matching the project's JSON formatting convention.
2. FOR ALL valid hook file objects, serializing then parsing SHALL produce an equivalent object (round-trip property).
3. THE hook file names SHALL follow the pattern `kiro-learn-<purpose>.kiro.hook` where `<purpose>` is one of `prompt`, `stop`, `tool`.
4. THE Installer SHALL generate hook files deterministically — the same inputs SHALL always produce byte-identical output.
5. THE hook file field order SHALL be: `enabled`, `name`, `description`, `version`, `when`, `then` — matching the convention observed in existing Kiro IDE hook files.

## Correctness Properties

### Property 1: Event Schema Conformance

FOR ALL events produced by the IDE_Shim, the event SHALL pass `parseEvent()` validation (Zod schema). This ensures IDE-originated events are wire-compatible with CLI-originated events.

### Property 2: Surface Identification Invariant

FOR ALL events produced by the IDE_Shim, `event.source.surface` SHALL equal `'kiro-ide'`. FOR ALL events produced by the CLI shim, `event.source.surface` SHALL equal `'kiro-cli'`. The two surfaces never produce events with the other's surface identifier.

### Property 3: Payload Field Mapping Completeness

FOR ALL `postToolUse` payloads with valid JSON in `USER_PROMPT`, the IDE_Shim SHALL produce an event body containing `tool_name`, `tool_input`, and `tool_response` fields. No IDE payload field SHALL be silently dropped.

### Property 4: Exit Code Safety

FOR ALL possible inputs (valid, invalid, empty, malformed, oversized) and all possible collector states (healthy, down, timeout, error), the IDE_Shim SHALL exit with code 0.

### Property 5: Hook File Round-Trip

FOR ALL hook file objects generated by the Installer, `JSON.parse(JSON.stringify(hookFile, null, 2))` SHALL produce a deeply equal object.

### Property 6: Retrieval Context Purity

THE IDE_Shim SHALL write to stdout ONLY when processing a `promptSubmit` event AND the collector returns a non-empty retrieval context. FOR ALL other event types and error conditions, stdout SHALL remain empty.

## Non-functional Requirements

### Performance

- N1. THE IDE_Shim SHALL complete the full cycle (env var read → event build → HTTP POST → stdout write) in under 200ms on commodity developer hardware when the collector is healthy.
- N2. THE IDE_Shim SHALL abort and exit 0 within 3 seconds in the worst case (collector timeout + cleanup).

### Reliability

- N3. THE IDE_Shim SHALL never cause a Kiro IDE session to fail, hang, or degrade. All failures are silent (stderr warning + exit 0).
- N4. THE `|| true` suffix on hook commands provides a defense-in-depth guarantee that even a non-zero exit from the shim does not propagate to the IDE.

### Observability

- N5. THE IDE_Shim SHALL log all warnings and errors to stderr with a `[kiro-learn]` prefix.
- N6. THE IDE_Shim SHALL NOT log successful operations to stderr (silent on success).

### Security

- N7. THE IDE_Shim SHALL only connect to `127.0.0.1`. No remote collector endpoints in v1.
- N8. THE IDE_Shim SHALL NOT log event body content or `USER_PROMPT` values to stderr (may contain sensitive data including tokens visible in the process environment). Log event IDs and error messages only.
- N9. THE hook file `then.command` field SHALL quote the shim executable path to handle home directories with spaces or special characters.

### Compatibility

- N10. THE IDE_Shim SHALL share the same session file space as the CLI shim, providing continuity when users switch between surfaces within the same project.
- N11. THE IDE_Shim SHALL produce events that are schema-identical to CLI shim events (same `KiroMemEvent` shape, same Zod validation), differing only in `source.surface`.
- N12. THE Shared_Shim's `buildEvent` function change (adding a `surface` parameter) SHALL be backward-compatible — the CLI shim's behavior SHALL not change.
