/**
 * Unit tests for IDE hook installer integration.
 *
 * Tests writeIdeHookFiles, removeIdeHookFiles, ide-shim bin wrapper,
 * and cmdUninstall cleanup.
 *
 * Test file: test/unit/ide-hook-installer.test.ts
 * Requirements: 1.1, 1.2, 1.3, 9.1, 9.4, 10.1, 10.2, 10.3, 10.4
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve symlinks (macOS /var → /private/var).
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-ide-installer-test-')),
);

// Mock homedir BEFORE importing the installer module so INSTALL_DIR
// resolves to a temp directory instead of the real ~/.kiro-learn.
vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

const {
  IDE_HOOK_FILES,
  INSTALL_DIR,
  removeIdeHookFiles,
  writeBinWrappers,
  writeIdeHookFiles,
} = await import('../../src/installer/index.js');

// ── Setup / teardown ────────────────────────────────────────────────────

let tmpProjectRoot: string;

beforeEach(() => {
  tmpProjectRoot = mkdtempSync(join(tmpdir(), 'kiro-learn-ide-proj-'));
});

afterEach(() => {
  rmSync(tmpProjectRoot, { recursive: true, force: true });
  rmSync(INSTALL_DIR, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────

describe('writeIdeHookFiles', () => {
  it('creates .kiro/hooks/ directory and three hook files', () => {
    writeIdeHookFiles(tmpProjectRoot);

    const hooksDir = join(tmpProjectRoot, '.kiro', 'hooks');
    expect(existsSync(hooksDir)).toBe(true);

    for (const fileName of IDE_HOOK_FILES) {
      const filePath = join(hooksDir, fileName);
      expect(existsSync(filePath)).toBe(true);
    }
  });

  it('writes valid JSON with correct field order', () => {
    writeIdeHookFiles(tmpProjectRoot);

    const hooksDir = join(tmpProjectRoot, '.kiro', 'hooks');

    for (const fileName of IDE_HOOK_FILES) {
      const raw = readFileSync(join(hooksDir, fileName), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;

      // Must be valid JSON
      expect(parsed).toBeDefined();

      // Must have required fields
      expect(parsed['enabled']).toBe(true);
      expect(typeof parsed['name']).toBe('string');
      expect(typeof parsed['description']).toBe('string');
      expect(parsed['version']).toBe('1');
      expect(parsed['when']).toBeDefined();
      expect(parsed['then']).toBeDefined();

      // Field order: enabled, name, description, version, when, then
      const keys = Object.keys(parsed);
      expect(keys).toEqual(['enabled', 'name', 'description', 'version', 'when', 'then']);
    }
  });

  it('prompt hook has correct when.type and then.command', () => {
    writeIdeHookFiles(tmpProjectRoot);

    const raw = readFileSync(
      join(tmpProjectRoot, '.kiro', 'hooks', 'kiro-learn-prompt.kiro.hook'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const when = parsed['when'] as Record<string, unknown>;
    const then = parsed['then'] as Record<string, unknown>;

    expect(when['type']).toBe('promptSubmit');
    expect(then['type']).toBe('runCommand');
    expect(then['command']).toContain('promptSubmit');
    expect(then['command']).toMatch(/\|\| true$/);
  });

  it('stop hook has correct when.type', () => {
    writeIdeHookFiles(tmpProjectRoot);

    const raw = readFileSync(
      join(tmpProjectRoot, '.kiro', 'hooks', 'kiro-learn-stop.kiro.hook'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const when = parsed['when'] as Record<string, unknown>;

    expect(when['type']).toBe('agentStop');
  });

  it('tool hook has when.toolTypes: ["*"]', () => {
    writeIdeHookFiles(tmpProjectRoot);

    const raw = readFileSync(
      join(tmpProjectRoot, '.kiro', 'hooks', 'kiro-learn-tool.kiro.hook'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const when = parsed['when'] as Record<string, unknown>;

    expect(when['type']).toBe('postToolUse');
    expect(when['toolTypes']).toEqual(['*']);
  });

  it('then.command quotes the shim path', () => {
    writeIdeHookFiles(tmpProjectRoot);

    const raw = readFileSync(
      join(tmpProjectRoot, '.kiro', 'hooks', 'kiro-learn-prompt.kiro.hook'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const then = parsed['then'] as Record<string, unknown>;
    const command = then['command'] as string;

    // Command should start with a quoted path
    expect(command).toMatch(/^"[^"]+"/);
  });

  it('overwrites existing kiro-learn hook files on upgrade', () => {
    writeIdeHookFiles(tmpProjectRoot);

    // Modify a hook file
    const hookPath = join(tmpProjectRoot, '.kiro', 'hooks', 'kiro-learn-prompt.kiro.hook');
    writeFileSync(hookPath, '{"modified": true}');

    // Re-run writeIdeHookFiles (simulating upgrade)
    writeIdeHookFiles(tmpProjectRoot);

    const raw = readFileSync(hookPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['enabled']).toBe(true);
    expect(parsed['modified']).toBeUndefined();
  });

  it('preserves non-kiro-learn hook files', () => {
    const hooksDir = join(tmpProjectRoot, '.kiro', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, 'my-custom-hook.kiro.hook'), '{"custom": true}');

    writeIdeHookFiles(tmpProjectRoot);

    // Custom hook should still exist
    const raw = readFileSync(join(hooksDir, 'my-custom-hook.kiro.hook'), 'utf8');
    expect(JSON.parse(raw)).toEqual({ custom: true });
  });

  it('serializes with 2-space indentation and trailing newline', () => {
    writeIdeHookFiles(tmpProjectRoot);

    const raw = readFileSync(
      join(tmpProjectRoot, '.kiro', 'hooks', 'kiro-learn-prompt.kiro.hook'),
      'utf8',
    );

    // Must end with newline
    expect(raw.endsWith('\n')).toBe(true);

    // Must use 2-space indentation
    expect(raw).toContain('  "enabled"');
  });
});

describe('removeIdeHookFiles', () => {
  it('removes only kiro-learn hook files', () => {
    const hooksDir = join(tmpProjectRoot, '.kiro', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Write kiro-learn hooks
    writeIdeHookFiles(tmpProjectRoot);

    // Write a custom hook
    writeFileSync(join(hooksDir, 'my-custom-hook.kiro.hook'), '{"custom": true}');

    // Remove kiro-learn hooks
    removeIdeHookFiles(tmpProjectRoot);

    // kiro-learn hooks should be gone
    for (const fileName of IDE_HOOK_FILES) {
      expect(existsSync(join(hooksDir, fileName))).toBe(false);
    }

    // Custom hook should still exist
    expect(existsSync(join(hooksDir, 'my-custom-hook.kiro.hook'))).toBe(true);
  });

  it('does not remove the .kiro/hooks/ directory', () => {
    writeIdeHookFiles(tmpProjectRoot);
    removeIdeHookFiles(tmpProjectRoot);

    const hooksDir = join(tmpProjectRoot, '.kiro', 'hooks');
    expect(existsSync(hooksDir)).toBe(true);
  });

  it('is idempotent — skips missing files without error', () => {
    // No hooks exist — should not throw
    expect(() => removeIdeHookFiles(tmpProjectRoot)).not.toThrow();
  });
});

describe('writeBinWrappers — ide-shim', () => {
  it('writes ide-shim wrapper with correct content', () => {
    const binDir = join(INSTALL_DIR, 'bin');
    mkdirSync(binDir, { recursive: true });

    writeBinWrappers();

    const ideShimPath = join(binDir, 'ide-shim');
    expect(existsSync(ideShimPath)).toBe(true);

    const content = readFileSync(ideShimPath, 'utf8');
    expect(content).toContain('#!/usr/bin/env node');
    expect(content).toContain('import { main } from "../lib/shim/ide-hook/index.js"');
    expect(content).toContain('main().catch(() => {})');

    // Check executable permissions
    const stat = statSync(ideShimPath);
    expect(stat.mode & 0o755).toBe(0o755);
  });
});
