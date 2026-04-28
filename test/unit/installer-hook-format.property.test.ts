/**
 * Property-based test: Hook command format.
 *
 * Feature: installer, Property 3: Hook command format
 *
 * For any generated kiro-learn.json agent config, every command field
 * contains the absolute path to ~/.kiro-learn/bin/shim (with actual home
 * directory, no tilde) and ends with ` || true`.
 *
 * **Validates: Requirements 6.4**
 *
 * @see .kiro/specs/installer/design.md § Property 3
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve symlinks (macOS /var → /private/var).
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-hook-prop-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Mock child_process so runSeedCommand doesn't spawn real kiro-cli.
// execFileSync writes a minimal valid seed payload to the target file
// (derived from the --directory argv), simulating a successful seed.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn((_cmd: string, args: readonly string[]) => {
    // Extract --directory <dir> from argv
    const dirIdx = args.indexOf('--directory');
    if (dirIdx === -1 || dirIdx + 1 >= args.length) return Buffer.from('');
    const targetDir = args[dirIdx + 1]!;
    const targetFile = join(targetDir, 'kiro-learn.json');

    // Write a minimal valid seed payload
    const seed = {
      name: 'kiro-learn',
      description: 'seeded',
      prompt: 'default prompt',
      tools: ['tool1'],
      hooks: {},
    };
    writeFileSync(targetFile, JSON.stringify(seed, null, 2) + '\n');
    return Buffer.from('');
  }),
  execSync: vi.fn(() => Buffer.from('')),
  spawn: vi.fn(() => ({
    pid: 1,
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

// Import after mocks so vitest intercepts the modules.
const { writeAgentConfigs, INSTALL_DIR } = await import(
  '../../src/installer/index.js'
);

/** Type for the parsed kiro-learn.json agent config. */
interface AgentConfig {
  hooks: Record<string, Array<{ command: string; matcher?: string }>>;
}

beforeEach(() => {
  rmSync(INSTALL_DIR, { recursive: true, force: true });
  rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('Installer — property: hook command format (P3)', () => {
  it('every hook command contains absolute shim path and ends with || true', () => {
    /**
     * **Validates: Requirements 6.4**
     *
     * Generate different scope configurations and verify every command
     * field in the generated agent config uses the absolute shim path
     * (no tilde) and ends with ` || true`.
     */
    fc.assert(
      fc.property(
        fc.record({
          hasProject: fc.boolean(),
          projectDepth: fc.integer({ min: 1, max: 5 }),
          projectName: fc
            .string({ minLength: 1, maxLength: 20 })
            .filter(
              (s) =>
                s.length > 0 &&
                !/[/\\\0]/.test(s) &&
                s !== '.' &&
                s !== '..',
            ),
        }),
        ({ hasProject, projectDepth, projectName }) => {
          // Clean up from previous iteration
          rmSync(INSTALL_DIR, { recursive: true, force: true });
          rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });

          mkdirSync(join(INSTALL_DIR, 'bin'), { recursive: true });
          mkdirSync(join(tmpHome, '.kiro', 'agents'), { recursive: true });

          // Build a project path if needed
          let projectRoot: string | undefined;
          if (hasProject) {
            const segments = [tmpHome];
            for (let i = 0; i < projectDepth; i++) {
              segments.push(
                i === projectDepth - 1 ? projectName : `dir${String(i)}`,
              );
            }
            projectRoot = join(...segments);
            mkdirSync(join(projectRoot, '.kiro', 'agents'), { recursive: true });
          }

          const scope = {
            global: true as const,
            projectRoot,
            detectedMarker: hasProject ? '.git' : undefined,
          };

          writeAgentConfigs(scope);

          // Check global config
          const shimPath = join(INSTALL_DIR, 'bin', 'shim');
          const globalConfigPath = join(
            tmpHome,
            '.kiro',
            'agents',
            'kiro-learn.json',
          );
          const globalConfig = JSON.parse(
            readFileSync(globalConfigPath, 'utf8'),
          ) as AgentConfig;

          for (const [, hookEntries] of Object.entries(globalConfig.hooks)) {
            for (const entry of hookEntries) {
              // Must contain absolute path (no tilde), quoted
              expect(entry.command).toContain(shimPath);
              expect(entry.command).not.toContain('~');
              expect(entry.command).toContain('"');
              // Must end with || true
              expect(entry.command).toMatch(/\|\| true$/);
            }
          }

          // Check project config if applicable
          if (projectRoot !== undefined) {
            const projectConfigPath = join(
              projectRoot,
              '.kiro',
              'agents',
              'kiro-learn.json',
            );
            const projectConfig = JSON.parse(
              readFileSync(projectConfigPath, 'utf8'),
            ) as AgentConfig;

            for (const [, hookEntries] of Object.entries(projectConfig.hooks)) {
              for (const entry of hookEntries) {
                expect(entry.command).toContain(shimPath);
                expect(entry.command).not.toContain('~');
                expect(entry.command).toContain('"');
                expect(entry.command).toMatch(/\|\| true$/);
              }
            }
          }

          // Clean up project dirs
          if (projectRoot !== undefined) {
            try {
              rmSync(projectRoot, { recursive: true, force: true });
            } catch {
              // Ignore
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
