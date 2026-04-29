# Design: IDE Stop Hook — askAgent Migration

## Overview

This feature changes the `kiro-learn-stop.kiro.hook` IDE hook from `runCommand` (which invokes the IDE shim executable) to `askAgent` (which triggers a new agent turn with a prompt). The motivation is that the IDE sends no payload in `USER_PROMPT` for `agentStop` events, so the shim's `handleStop` bails out on empty input and no session summary is ever captured for IDE sessions.

With `askAgent`, the Kiro IDE triggers a new agent turn at session end. The agent has full conversation context and can call the `save_session_summary` MCP tool (already registered on the `kiro-learn-memory` server) to produce a structured session summary.

**Scope:** Modify the stop hook entry in `writeIdeHookFiles()` in `src/installer/index.ts`. The prompt and tool hooks remain as `runCommand`. The IDE shim's `handleStop` is unchanged. No new modules, types, or exports are introduced.

## Architecture

No architectural changes. The existing three-layer architecture (Installer → Shim → Collector) is unchanged. The only difference is in the generated hook file content:

```text
Before:  agentStop → runCommand → ide-shim → handleStop → (empty input → bail)
After:   agentStop → askAgent → agent turn → save_session_summary MCP tool → collector
```

The `askAgent` path bypasses the shim entirely for the stop hook. The MCP server (`kiro-learn-memory`) is already registered in `.kiro/settings/mcp.json` by `writeMcpConfig()`, so the agent can discover and call `save_session_summary` without any additional configuration.

## Components and Interfaces

### Modified: `writeIdeHookFiles()` in `src/installer/index.ts`

The only code change. The stop hook entry in the `hookEntries` array changes from:

```typescript
{
  fileName: 'kiro-learn-stop.kiro.hook',
  payload: {
    enabled: true,
    name: 'kiro-learn-stop',
    description: 'kiro-learn: capture session summaries for memory',
    version: '1',
    when: { type: 'agentStop' },
    then: {
      type: 'runCommand',
      command: `${QUOTED_IDE_SHIM} agentStop || true`,
    },
  },
}
```

to:

```typescript
{
  fileName: 'kiro-learn-stop.kiro.hook',
  payload: {
    enabled: true,
    name: 'kiro-learn-stop',
    description: 'kiro-learn: capture session summaries for memory',
    version: '1',
    when: { type: 'agentStop' },
    then: {
      type: 'askAgent',
      prompt: SESSION_SUMMARY_PROMPT,
    },
  },
}
```

Where `SESSION_SUMMARY_PROMPT` is a new module-level constant (not exported — internal to the installer).

### Unchanged Components

- **`handleStop`** in `src/shim/ide-hook/index.ts` — remains as-is for the CLI path.
- **`save_session_summary`** MCP tool in `src/mcp/tools.ts` — already implemented.
- **`writeMcpConfig()`** — already registers `kiro-learn-memory` MCP server.
- **`IDE_HOOK_FILES`** constant — file names unchanged.
- **`removeIdeHookFiles()`** — removes by file name, unaffected.
- **Prompt hook** (`kiro-learn-prompt.kiro.hook`) — stays `runCommand`.
- **Tool hook** (`kiro-learn-tool.kiro.hook`) — stays `runCommand`.

### Session Summary Prompt

The prompt is a concise instruction string that tells the agent to call `save_session_summary` on the `kiro-learn-memory` MCP server with all seven required fields derived from the conversation context. Design considerations:

1. **Token efficiency** — Under 200 words (N1). Each `askAgent` invocation consumes a full agent turn.
2. **No commentary** — The agent should call the tool and stop. No user interaction, no extra output.
3. **Field enumeration** — All seven required fields are listed so the agent knows exactly what to provide.
4. **MCP server reference** — The server name `kiro-learn-memory` is included so the agent can locate the tool.

Proposed prompt:

```
Summarize this session by calling the save_session_summary tool on the kiro-learn-memory MCP server. Provide all required fields based on the conversation context:
- request: what the user asked for
- investigated: what was investigated or explored
- learned: key learnings or discoveries
- completed: what was completed or delivered
- next_steps: suggested next steps or follow-ups
- files_read: array of files that were read
- files_modified: array of files that were modified

Call the tool once and do not produce any other output.
```

This is ~80 words, well under the 200-word limit.

## Data Models

No new data models. The hook file schema gains a new valid shape for the `then` block:

**Existing (runCommand):**
```json
{ "type": "runCommand", "command": "<string>" }
```

**New (askAgent):**
```json
{ "type": "askAgent", "prompt": "<string>" }
```

Both shapes coexist in the hook manifest — the prompt and tool hooks use `runCommand`, the stop hook uses `askAgent`.

The `KiroHookFile` interface in `test/helpers/arbitrary.ts` will need to be updated to support both action types. The `then` block becomes a discriminated union:

```typescript
then:
  | { type: 'runCommand'; command: string }
  | { type: 'askAgent'; prompt: string };
```

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Stop Hook Uses askAgent

*For any* invocation of `writeIdeHookFiles`, the generated `kiro-learn-stop.kiro.hook` file SHALL have `then.type` equal to `"askAgent"` and SHALL have a `then.prompt` field that is a non-empty string. The file SHALL NOT have a `then.command` field.

**Validates: Requirements 1.1, 1.2, 1.3**

### Property 2: Prompt and Tool Hooks Use runCommand

*For any* invocation of `writeIdeHookFiles`, the generated `kiro-learn-prompt.kiro.hook` and `kiro-learn-tool.kiro.hook` files SHALL have `then.type` equal to `"runCommand"` and SHALL have a `then.command` field that is a non-empty string. These files SHALL NOT have a `then.prompt` field.

**Validates: Requirements 2.1, 2.2**

### Property 3: Prompt References Required Tool Fields

THE Session_Summary_Prompt embedded in the stop hook's `then.prompt` field SHALL contain the substrings `save_session_summary`, `kiro-learn-memory`, `request`, `investigated`, `learned`, `completed`, `next_steps`, `files_read`, and `files_modified`.

**Validates: Requirements 3.1, 3.2, 3.3**

### Property 4: Hook File Round-Trip

*For any* hook file object generated by `writeIdeHookFiles` (including the updated stop hook), `JSON.parse(JSON.stringify(hookFile, null, 2))` SHALL produce a deeply equal object.

**Validates: Requirements 4.4**

### Property 5: Hook File Schema Conformance

*For any* of the three hook files generated by `writeIdeHookFiles`, each file SHALL be valid JSON with exactly the keys `enabled`, `name`, `description`, `version`, `when`, `then` in that order. The `enabled` field SHALL be `true`, the `version` field SHALL be `"1"`, and the `when` object SHALL have a `type` field that is a non-empty string.

**Validates: Requirements 1.4, 1.5, 4.1, 4.2**

## Error Handling

No new error paths. The `askAgent` action type does not require an `|| true` suffix because it is not a shell command — the IDE handles agent turn failures internally (N2). A failed `save_session_summary` call returns an error `ToolResult` to the agent, which is non-fatal.

The existing error handling in `writeIdeHookFiles` (directory creation with `mkdirSync`, file writing with `writeFileSync`) is unchanged.

## Testing Strategy

### Approach

This is a small, focused change. The testing strategy uses:

1. **Example-based unit tests** — Update existing tests in `test/unit/ide-hook-installer.test.ts` to verify the new stop hook format.
2. **Property-based tests** — Update the existing `ideHookFileArb` generator in `test/helpers/arbitrary.ts` to support both `runCommand` and `askAgent` action types, and update `test/unit/ide-hook-file-roundtrip.property.test.ts` accordingly.

### Unit Tests (example-based)

Update `test/unit/ide-hook-installer.test.ts`:

- **Existing test "stop hook has correct when.type"** — Extend to also verify `then.type === "askAgent"`, `then.prompt` is a non-empty string, and `then.command` is absent.
- **New test "stop hook prompt contains required fields"** — Verify the prompt contains `save_session_summary`, `kiro-learn-memory`, and all seven field names.
- **New test "stop hook prompt is concise"** — Verify word count < 200.
- **Existing test "then.command quotes the shim path"** — Verify this still passes for prompt and tool hooks (stop hook no longer has a command).
- **New test "upgrade from runCommand to askAgent"** — Write old-format stop hook, call `writeIdeHookFiles`, verify new format.

### Property Tests (fast-check)

- **Update `KiroHookFile` interface** in `test/helpers/arbitrary.ts` — The `then` block becomes a discriminated union supporting both `runCommand` and `askAgent`.
- **Update `ideHookFileArb()` generator** — Generate both action types. For `agentStop` events, generate `askAgent` with a prompt. For other events, generate `runCommand` with a command.
- **Update P6 (round-trip)** — Already works with the union type since JSON round-trip is type-agnostic.
- **Update P7 (command format)** — Only applies to `runCommand` hooks. Filter or branch on `then.type`.

**Property test configuration:**
- Library: `fast-check` (already in use)
- Minimum 100 iterations per property test
- Tag format: **Feature: ide-stop-hook-askagent, Property {number}: {property_text}**
