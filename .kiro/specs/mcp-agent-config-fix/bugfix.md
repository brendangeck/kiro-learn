# Bugfix Requirements Document

## Introduction

The `kiro-learn init` installer writes the `kiro-learn-memory` MCP server configuration to `.kiro/settings/mcp.json` (the project-level Kiro IDE config) but does not inject the MCP server entry into the Kiro CLI agent config JSON's `mcpServers` field. This means global-only installs get no MCP server at all, and project-scoped installs only work because `kiro-cli` reads `.kiro/settings/mcp.json` as a legacy source that may be deprecated. The MCP server provides the `search_memory`, `save_observation`, and `save_session_summary` tools that are core to kiro-learn's functionality.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `kiro-learn init` runs with `--global-only` flag (or no project root is detected) THEN the system writes `~/.kiro/agents/kiro-learn.json` without a `kiro-learn-memory` entry in its `mcpServers` field, and skips writing `.kiro/settings/mcp.json` entirely, leaving the MCP server unreachable by both Kiro IDE and Kiro CLI agents.

1.2 WHEN `kiro-learn init` runs with a detected project root (project-scoped install) THEN the system writes `kiro-learn.json` at both global and project scopes without a `kiro-learn-memory` entry in the `mcpServers` field of either agent config, relying solely on the legacy `.kiro/settings/mcp.json` path for MCP server discovery.

1.3 WHEN `writeKiroLearnAgent()` successfully seeds from `kiro_default` and merges hooks via `mergeHooks()` THEN the system preserves any `mcpServers` inherited from the seed but never upserts the `kiro-learn-memory` MCP server entry into the merged config.

1.4 WHEN `writeKiroLearnAgent()` falls back to the minimal hooks-only config (seed failure) THEN the system writes a config with only `name`, `description`, and `hooks` — no `mcpServers` field at all — making the MCP server completely unavailable.

### Expected Behavior (Correct)

2.1 WHEN `kiro-learn init` runs with `--global-only` flag (or no project root is detected) THEN the system SHALL write `~/.kiro/agents/kiro-learn.json` with a `kiro-learn-memory` entry in its `mcpServers` field pointing to the MCP server binary at `~/.kiro-learn/bin/mcp-server`, making the MCP tools available to Kiro CLI agents.

2.2 WHEN `kiro-learn init` runs with a detected project root (project-scoped install) THEN the system SHALL write `kiro-learn.json` at both global and project scopes with a `kiro-learn-memory` entry in the `mcpServers` field of each agent config, in addition to writing `.kiro/settings/mcp.json` as belt-and-suspenders for the IDE.

2.3 WHEN `writeKiroLearnAgent()` successfully seeds from `kiro_default` and merges hooks via `mergeHooks()` THEN the system SHALL upsert the `kiro-learn-memory` MCP server entry into the merged config's `mcpServers` field after the merge completes, preserving any other MCP servers inherited from the seed.

2.4 WHEN `writeKiroLearnAgent()` falls back to the minimal hooks-only config (seed failure) THEN the system SHALL include a `mcpServers` field containing the `kiro-learn-memory` entry in the fallback config, so the MCP tools remain available even when seeding fails.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `writeKiroLearnAgent()` seeds from `kiro_default` THEN the system SHALL CONTINUE TO preserve all non-owned fields from the seed (including `tools`, `prompt`, `allowedTools`, and any pre-existing `mcpServers` entries other than `kiro-learn-memory`) via the existing `mergeHooks()` shallow-copy behavior.

3.2 WHEN `writeKiroLearnAgent()` merges hooks THEN the system SHALL CONTINUE TO overwrite only the four owned hook triggers (`agentSpawn`, `userPromptSubmit`, `postToolUse`, `stop`) and the `name`/`description` fields, leaving all other seed fields intact.

3.3 WHEN `kiro-learn init` runs with a detected project root THEN the system SHALL CONTINUE TO write `.kiro/settings/mcp.json` with the `kiro-learn-memory` entry via `writeMcpConfig()`, preserving the existing IDE integration path.

3.4 WHEN `writeAgentConfigs()` is called THEN the system SHALL CONTINUE TO write the compressor and compactor agent configs at global scope only, without modification.

3.5 WHEN `writeKiroLearnAgent()` falls back to the minimal config THEN the system SHALL CONTINUE TO emit the `[kiro-learn] warning:` message to stderr indicating the seed failure.

3.6 WHEN the MCP server entry is written to the agent config THEN the system SHALL CONTINUE TO use the same binary path (`~/.kiro-learn/bin/mcp-server`) and empty args array as used by `writeMcpConfig()` for `.kiro/settings/mcp.json`.
