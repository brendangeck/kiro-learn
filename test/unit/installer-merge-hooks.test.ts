/**
 * Unit tests for `mergeHooks` in `src/installer/index.ts`.
 *
 * Covers the specified examples and edge cases from the design:
 *  - Happy path with rich seed fields and a non-owned `preToolUse` trigger.
 *  - Seed with no `hooks` field at all.
 *  - Seed with existing owned hook entries (must be overwritten, no merge).
 *  - Seed with `hooks` set to a non-object (string, array, number) — coerced
 *    to `{}` so only the four owned triggers survive.
 *  - Seed with name `'kiro_default'` and kiro-cli's default description —
 *    both must be overwritten with kiro-learn's values.
 *  - Input-mutation check: `mergeHooks` must not mutate the caller's `seed`.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import { describe, expect, it } from 'vitest';

import {
  KIRO_LEARN_DESCRIPTION,
  mergeHooks,
  OWNED_TRIGGERS,
} from '../../src/installer/index.js';
import type { HookTriggerMap } from '../../src/installer/index.js';

// Distinctive command strings make it trivial to assert that the owned
// triggers were overwritten with *these* entries and not anything the seed
// carried. Using sentinel markers rather than the real shim path keeps the
// test decoupled from the production command string.
const TRIGGERS: HookTriggerMap = {
  agentSpawn: [{ command: 'KIRO_LEARN_AGENT_SPAWN' }],
  userPromptSubmit: [{ command: 'KIRO_LEARN_USER_PROMPT_SUBMIT' }],
  postToolUse: [{ matcher: '*', command: 'KIRO_LEARN_POST_TOOL_USE' }],
  stop: [{ command: 'KIRO_LEARN_STOP' }],
};

describe('mergeHooks', () => {
  it('preserves non-owned top-level fields and non-owned hook triggers (happy path)', () => {
    /**
     * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.7
     *
     * Seed with `tools`, `prompt`, `description`, `mcpServers`,
     * `allowedTools`, and a non-owned `hooks.preToolUse`. The merged output
     * must carry every non-owned field unchanged and overwrite only the
     * four owned triggers, `name`, and `description`.
     */
    const preToolUseEntries = [{ matcher: '*', command: 'user-pre-tool-use' }];

    const seed: Record<string, unknown> = {
      name: 'seed-name',
      description: 'seed-description',
      prompt: 'You are the default agent.',
      tools: ['fs_read', 'fs_write', 'execute_bash'],
      allowedTools: ['fs_read'],
      mcpServers: { example: { command: 'mcp-server', args: [] } },
      hooks: {
        preToolUse: preToolUseEntries,
      },
    };

    const merged = mergeHooks(seed, TRIGGERS);

    // Owned top-level fields overwritten.
    expect(merged['name']).toBe('kiro-learn');
    expect(merged['description']).toBe(KIRO_LEARN_DESCRIPTION);

    // Non-owned top-level fields preserved verbatim.
    expect(merged['prompt']).toBe('You are the default agent.');
    expect(merged['tools']).toEqual(['fs_read', 'fs_write', 'execute_bash']);
    expect(merged['allowedTools']).toEqual(['fs_read']);
    expect(merged['mcpServers']).toEqual({
      example: { command: 'mcp-server', args: [] },
    });

    // Non-owned hook trigger preserved verbatim.
    const mergedHooks = merged['hooks'] as Record<string, unknown>;
    expect(mergedHooks['preToolUse']).toEqual(preToolUseEntries);

    // Owned triggers overwritten with the supplied entries.
    expect(mergedHooks['agentSpawn']).toEqual(TRIGGERS.agentSpawn);
    expect(mergedHooks['userPromptSubmit']).toEqual(TRIGGERS.userPromptSubmit);
    expect(mergedHooks['postToolUse']).toEqual(TRIGGERS.postToolUse);
    expect(mergedHooks['stop']).toEqual(TRIGGERS.stop);
  });

  it('produces hooks with exactly the four owned triggers when seed has no hooks field', () => {
    /**
     * Validates: Requirement 4.5
     */
    const seed: Record<string, unknown> = {
      name: 'kiro_default',
      tools: ['fs_read'],
    };

    const merged = mergeHooks(seed, TRIGGERS);

    const mergedHooks = merged['hooks'] as Record<string, unknown>;
    expect(Object.keys(mergedHooks).sort()).toEqual(
      [...OWNED_TRIGGERS].sort(),
    );
    expect(mergedHooks['agentSpawn']).toEqual(TRIGGERS.agentSpawn);
    expect(mergedHooks['userPromptSubmit']).toEqual(TRIGGERS.userPromptSubmit);
    expect(mergedHooks['postToolUse']).toEqual(TRIGGERS.postToolUse);
    expect(mergedHooks['stop']).toEqual(TRIGGERS.stop);
  });

  it('overwrites existing owned hook entries without merging (no "old" command leaks through)', () => {
    /**
     * Validates: Requirement 4.6
     *
     * The existing owned trigger value must be REPLACED, not merged. The
     * stale `'old'` command must not appear anywhere in the merged output.
     */
    const seed: Record<string, unknown> = {
      hooks: {
        agentSpawn: [{ command: 'old' }],
        userPromptSubmit: [{ command: 'old' }],
        postToolUse: [{ matcher: '*', command: 'old' }],
        stop: [{ command: 'old' }],
      },
    };

    const merged = mergeHooks(seed, TRIGGERS);

    // Not a single `'old'` command anywhere in the serialised output.
    expect(JSON.stringify(merged)).not.toContain('"old"');

    const mergedHooks = merged['hooks'] as Record<string, unknown>;
    expect(mergedHooks['agentSpawn']).toEqual(TRIGGERS.agentSpawn);
    expect(mergedHooks['userPromptSubmit']).toEqual(TRIGGERS.userPromptSubmit);
    expect(mergedHooks['postToolUse']).toEqual(TRIGGERS.postToolUse);
    expect(mergedHooks['stop']).toEqual(TRIGGERS.stop);
  });

  describe('coerces non-object `hooks` to {}', () => {
    /**
     * Validates: Requirement 4.5 (via coercion) + defensive handling of
     * malformed kiro_default seeds. Whatever garbage `hooks` holds, the
     * merged output must still have exactly the four owned triggers under
     * `hooks` and nothing else.
     */
    const malformedHooks: ReadonlyArray<{ readonly label: string; readonly value: unknown }> = [
      { label: 'string', value: 'not-an-object' },
      { label: 'array', value: [{ command: 'stray' }] },
      { label: 'number', value: 42 },
      { label: 'null', value: null },
    ];

    for (const { label, value } of malformedHooks) {
      it(`coerces hooks when set to a ${label}`, () => {
        const seed: Record<string, unknown> = { hooks: value };

        const merged = mergeHooks(seed, TRIGGERS);

        const mergedHooks = merged['hooks'] as Record<string, unknown>;
        expect(Object.keys(mergedHooks).sort()).toEqual(
          [...OWNED_TRIGGERS].sort(),
        );
        expect(mergedHooks['agentSpawn']).toEqual(TRIGGERS.agentSpawn);
        expect(mergedHooks['userPromptSubmit']).toEqual(
          TRIGGERS.userPromptSubmit,
        );
        expect(mergedHooks['postToolUse']).toEqual(TRIGGERS.postToolUse);
        expect(mergedHooks['stop']).toEqual(TRIGGERS.stop);
      });
    }
  });

  it("overwrites a seed named 'kiro_default' with kiro-learn's name and description", () => {
    /**
     * Validates: Requirements 4.1, 4.2
     */
    const defaultDescription =
      'The default Kiro agent with access to the full toolset.';

    const seed: Record<string, unknown> = {
      name: 'kiro_default',
      description: defaultDescription,
    };

    const merged = mergeHooks(seed, TRIGGERS);

    expect(merged['name']).toBe('kiro-learn');
    expect(merged['description']).toBe(KIRO_LEARN_DESCRIPTION);
    expect(merged['description']).not.toBe(defaultDescription);
  });

  it('does not mutate the input seed', () => {
    /**
     * Validates: Requirement 4.7 — purity. The caller's `seed` object and
     * all its nested arrays/objects must be untouched after `mergeHooks`
     * returns. Cloning via `structuredClone` and asserting deep-equality
     * against the original catches both top-level and nested mutation.
     */
    const seed: Record<string, unknown> = {
      name: 'seed-name',
      description: 'seed-description',
      tools: ['fs_read', 'fs_write'],
      mcpServers: { example: { command: 'mcp-server' } },
      hooks: {
        preToolUse: [{ matcher: '*', command: 'user-pre-tool-use' }],
        agentSpawn: [{ command: 'old' }],
      },
    };

    const snapshot = structuredClone(seed);

    mergeHooks(seed, TRIGGERS);

    expect(seed).toEqual(snapshot);
  });
});
