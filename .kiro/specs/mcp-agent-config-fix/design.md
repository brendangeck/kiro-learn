# MCP Agent Config Fix — Bugfix Design

## Overview

`writeKiroLearnAgent()` in `src/installer/index.ts` merges kiro-learn's four owned hook triggers onto the seeded `kiro_default` agent config but never injects the `kiro-learn-memory` MCP server into the config's `mcpServers` field. The separate `writeMcpConfig()` function writes the MCP server entry to `.kiro/settings/mcp.json`, but that only runs for project-scoped installs — global-only installs get no MCP server configuration at all. The fix adds an `mcpServers` upsert step to `writeKiroLearnAgent()` after the hook merge (and in the fallback path), using the same binary path and entry shape as `writeMcpConfig()`.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — `writeKiroLearnAgent()` writes a `kiro-learn.json` agent config without a `kiro-learn-memory` entry in its `mcpServers` field
- **Property (P)**: The desired behavior — every `kiro-learn.json` written by `writeKiroLearnAgent()` contains a `kiro-learn-memory` entry in `mcpServers` pointing to `~/.kiro-learn/bin/mcp-server`
- **Preservation**: Existing behaviors that must remain unchanged — hook merging, seed field preservation, fallback warning, compressor/compactor agent configs, `writeMcpConfig()` for `.kiro/settings/mcp.json`
- **`writeKiroLearnAgent()`**: The function in `src/installer/index.ts` (~line 1047) that seeds from `kiro_default`, merges hooks, and writes `kiro-learn.json` to a target directory
- **`mergeHooks()`**: The function that shallow-copies the seed config and overwrites kiro-learn's four owned hook triggers
- **`writeMcpConfig()`**: The function that writes the MCP server entry to `.kiro/settings/mcp.json` (project-scoped only)
- **`INSTALL_DIR`**: `~/.kiro-learn/` — the root of the kiro-learn installation layout
- **MCP server binary**: `path.join(INSTALL_DIR, 'bin', 'mcp-server')` — the stdio-based MCP server executable

## Bug Details

### Bug Condition

The bug manifests whenever `writeKiroLearnAgent()` writes a `kiro-learn.json` file — both in the successful seed-then-merge path and in the fallback path. After `mergeHooks()` returns the merged config, the function writes it directly to disk without injecting the `kiro-learn-memory` MCP server entry. The fallback config is a hand-built object with only `name`, `description`, and `hooks` — no `mcpServers` field at all.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { targetDir: string, seedResult: SeedResult }
  OUTPUT: boolean

  config := readJsonFile(path.join(input.targetDir, 'kiro-learn.json'))
  mcpServers := config['mcpServers']

  RETURN mcpServers IS undefined OR mcpServers IS null
         OR typeof mcpServers !== 'object' OR Array.isArray(mcpServers)
         OR mcpServers['kiro-learn-memory'] IS undefined
         OR mcpServers['kiro-learn-memory'].command !== path.join(INSTALL_DIR, 'bin', 'mcp-server')
END FUNCTION
```

### Examples

- **Global-only install, seed succeeds, seed has no `mcpServers`**: `kiro-learn.json` is written with merged hooks but no `mcpServers` field. The MCP tools (`search_memory`, `save_observation`, `save_session_summary`) are unreachable by Kiro CLI agents. Expected: `mcpServers` field with `kiro-learn-memory` entry is present.
- **Global-only install, seed fails**: Fallback config has `name`, `description`, `hooks` only. No `mcpServers` at all. Expected: fallback config includes `mcpServers` with `kiro-learn-memory` entry.
- **Project-scoped install, seed succeeds, seed has other MCP servers**: `kiro-learn.json` preserves the seed's existing `mcpServers` (e.g., `some-other-server`) via `mergeHooks()` shallow copy, but `kiro-learn-memory` is never added. Expected: both `some-other-server` and `kiro-learn-memory` are present.
- **Project-scoped install, seed succeeds, seed has `mcpServers: null`**: The `null` value is preserved as-is. Expected: `mcpServers` is replaced with an object containing `kiro-learn-memory`.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `mergeHooks()` must continue to shallow-copy all top-level seed fields and overwrite only the four owned hook triggers (`agentSpawn`, `userPromptSubmit`, `postToolUse`, `stop`) plus `name` and `description`
- Any MCP servers inherited from the seed (other than `kiro-learn-memory`) must be preserved in the merged config
- The fallback config must continue to emit the `[kiro-learn] warning:` message to stderr
- `writeMcpConfig()` must continue to write `.kiro/settings/mcp.json` for project-scoped installs (belt-and-suspenders)
- `writeCompressorAgent()` and `writeCompactorAgent()` must remain unchanged
- The `prompt` suffix append logic must remain unchanged
- The pre-seed delete and seed command invocation must remain unchanged

**Scope:**
All inputs that do NOT involve the `mcpServers` field of the agent config should be completely unaffected by this fix. This includes:
- Hook trigger content and merging behavior
- Agent `name`, `description`, and `prompt` fields
- `tools`, `allowedTools`, and any other seed fields
- The compressor and compactor agent configs
- The `.kiro/settings/mcp.json` write path
- Daemon lifecycle, payload deployment, and all other installer commands

## Hypothesized Root Cause

Based on the code analysis, the root cause is straightforward:

1. **Missing upsert step in the success path**: After `mergeHooks()` returns the merged config (line ~1131), the code appends the prompt suffix and writes to disk. There is no step between the merge and the write that injects `kiro-learn-memory` into `merged['mcpServers']`. The `mergeHooks()` function correctly preserves any `mcpServers` from the seed via shallow copy, but it has no knowledge of `kiro-learn-memory` — that is not its responsibility.

2. **Missing `mcpServers` in the fallback config**: The `writeFallback()` inner function (line ~1064) constructs a minimal object with only `name`, `description`, and `hooks`. The `mcpServers` field was never added to this object because the MCP server was originally only configured via `writeMcpConfig()` in the project-scoped path.

3. **Design assumption that `writeMcpConfig()` was sufficient**: The original implementation assumed that `.kiro/settings/mcp.json` was the canonical MCP server discovery path. This assumption breaks for global-only installs (where `writeMcpConfig()` never runs) and is fragile for project-scoped installs (where `.kiro/settings/mcp.json` is a legacy path that may be deprecated).

## Correctness Properties

Property 1: Bug Condition — Agent config contains kiro-learn-memory MCP server

_For any_ call to `writeKiroLearnAgent(targetDir)` — whether the seed succeeds or fails — the resulting `kiro-learn.json` file SHALL contain a `mcpServers` object with a `kiro-learn-memory` entry whose `command` is `path.join(INSTALL_DIR, 'bin', 'mcp-server')` and whose `args` is an empty array.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

Property 2: Preservation — Seed MCP servers and non-mcpServers fields unchanged

_For any_ call to `writeKiroLearnAgent(targetDir)` where the seed succeeds and the seed config contains MCP servers other than `kiro-learn-memory` or any other non-owned fields (`tools`, `prompt`, `allowedTools`, etc.), the fixed function SHALL produce the same result as the original function for all fields except `mcpServers['kiro-learn-memory']`, preserving all inherited seed content.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `src/installer/index.ts`

**Function**: `writeKiroLearnAgent()`

**Specific Changes**:

1. **Extract a helper to build the MCP server entry**: Create a small helper (or inline the logic) that produces the `kiro-learn-memory` MCP server object: `{ command: path.join(INSTALL_DIR, 'bin', 'mcp-server'), args: [] }`. This is the same shape used by `writeMcpConfig()`.

2. **Add upsert logic after `mergeHooks()` in the success path**: After the `mergeHooks()` call and prompt suffix append (around line 1131–1135), add a block that:
   - Reads `merged['mcpServers']`
   - If it is `undefined`, `null`, not an object, or an array, replaces it with `{}`
   - Sets `mcpServers['kiro-learn-memory']` to the MCP server entry
   - Assigns the result back to `merged['mcpServers']`

3. **Add `mcpServers` to the fallback config**: In the `writeFallback()` inner function, add a `mcpServers` field to the fallback object containing the `kiro-learn-memory` entry. The key order should place `mcpServers` after `hooks` to maintain a logical structure.

4. **Defensive handling of malformed `mcpServers`**: The upsert logic must handle the case where the seed's `mcpServers` is `null`, a primitive, or an array — coerce to `{}` before inserting, mirroring the defensive pattern already used in `writeMcpConfig()`.

5. **No changes to `mergeHooks()`**: The merge function remains a generic shallow-copy-plus-hook-overwrite utility. The MCP server injection is the caller's responsibility, keeping `mergeHooks()` single-purpose.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that call `writeKiroLearnAgent()` with mocked filesystem and seed command, then inspect the written JSON for the presence of `mcpServers['kiro-learn-memory']`. Run these tests on the UNFIXED code to observe failures and confirm the bug.

**Test Cases**:
1. **Seed success, no existing mcpServers**: Seed returns a config with `tools`, `prompt`, `hooks` but no `mcpServers`. Assert `kiro-learn-memory` is present in the output. (will fail on unfixed code)
2. **Seed success, existing mcpServers with other entries**: Seed returns a config with `mcpServers: { 'other-server': { command: '/usr/bin/other', args: [] } }`. Assert both `other-server` and `kiro-learn-memory` are present. (will fail on unfixed code)
3. **Seed failure (fallback path)**: Seed command fails. Assert the fallback config contains `mcpServers['kiro-learn-memory']`. (will fail on unfixed code)
4. **Seed success, mcpServers is null**: Seed returns `mcpServers: null`. Assert `kiro-learn-memory` is present and `mcpServers` is a valid object. (will fail on unfixed code)

**Expected Counterexamples**:
- `kiro-learn.json` is written without `mcpServers` field or without `kiro-learn-memory` entry
- Possible causes: missing upsert step after `mergeHooks()`, missing field in fallback config

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := writeKiroLearnAgent_fixed(input.targetDir)
  config := readJsonFile(path.join(input.targetDir, 'kiro-learn.json'))
  ASSERT config['mcpServers'] IS object
  ASSERT config['mcpServers']['kiro-learn-memory'] IS object
  ASSERT config['mcpServers']['kiro-learn-memory'].command === path.join(INSTALL_DIR, 'bin', 'mcp-server')
  ASSERT config['mcpServers']['kiro-learn-memory'].args DEEP_EQUALS []
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT writeKiroLearnAgent_original(input) = writeKiroLearnAgent_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain (random seed configs with varying field combinations)
- It catches edge cases that manual unit tests might miss (e.g., seed with `mcpServers` as an array, seed with deeply nested structures)
- It provides strong guarantees that behavior is unchanged for all non-mcpServers fields

**Test Plan**: Observe behavior on UNFIXED code first for non-mcpServers fields (hooks, name, description, prompt, tools, allowedTools), then write property-based tests capturing that behavior.

**Test Cases**:
1. **Hook merge preservation**: Verify that the four owned hook triggers are still correctly overwritten and non-owned hooks are preserved after the fix
2. **Seed field preservation**: Verify that `tools`, `prompt`, `allowedTools`, and any other arbitrary seed fields are unchanged by the fix
3. **Other MCP server preservation**: Verify that MCP servers inherited from the seed (other than `kiro-learn-memory`) are preserved in the output
4. **Fallback warning preservation**: Verify that the stderr warning message is still emitted when the seed fails

### Unit Tests

- Test `writeKiroLearnAgent()` with a successful seed that has no `mcpServers` — assert `kiro-learn-memory` is present
- Test `writeKiroLearnAgent()` with a successful seed that has other MCP servers — assert both are present
- Test `writeKiroLearnAgent()` with a successful seed that has `mcpServers: null` — assert `kiro-learn-memory` is present
- Test `writeKiroLearnAgent()` with a successful seed that has `mcpServers` as an array — assert coerced to object with `kiro-learn-memory`
- Test `writeKiroLearnAgent()` fallback path — assert `mcpServers['kiro-learn-memory']` is present
- Test that the MCP server entry uses the correct binary path (`~/.kiro-learn/bin/mcp-server`) and empty args
- Test that `mergeHooks()` is NOT modified (no `mcpServers` logic in merge)

### Property-Based Tests

- Generate random seed configs (with varying combinations of `tools`, `prompt`, `hooks`, `mcpServers`, `allowedTools`, and arbitrary extra fields) and verify that the fixed `writeKiroLearnAgent()` always produces a config with `kiro-learn-memory` in `mcpServers`
- Generate random seed configs with existing MCP servers and verify all non-`kiro-learn-memory` entries are preserved byte-for-byte
- Generate random seed configs and verify all non-`mcpServers` fields are identical between the original and fixed function output (preservation property)

### Integration Tests

- Test full `kiro-learn init --global-only` flow and verify the global `kiro-learn.json` contains `mcpServers['kiro-learn-memory']`
- Test full `kiro-learn init` with project scope and verify both global and project `kiro-learn.json` contain `mcpServers['kiro-learn-memory']`, and `.kiro/settings/mcp.json` is also written (belt-and-suspenders)
- Test upgrade scenario: existing `kiro-learn.json` without `mcpServers` is replaced with one that has it
