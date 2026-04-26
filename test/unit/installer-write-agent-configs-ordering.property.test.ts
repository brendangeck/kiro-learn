// Feature: default-equivalent-agent, Property 6: Per-scope ordering holds and scopes do not interleave
/**
 * Property-based test: `writeAgentConfigs` produces a fixed, per-scope
 * ordered trace of observable filesystem/spawn/stderr operations, and
 * operations from the project scope never appear before the last
 * operation of the global scope.
 *
 * For each `(scope1_outcome, scope2_outcome)` pair drawn from the
 * cartesian product of
 *   { 'success', 'spawn-failed', 'non-zero-exit', 'missing-file', 'invalid-payload' }
 * crossed with { 'no-project', 'with-project' }, we drive
 * `writeAgentConfigs` with the corresponding `InstallScope` and
 * configure the mocked `execFileSync` to produce the required outcome
 * for each scope. A shared recorder, installed via `vi.mock('node:fs')`,
 * `vi.mock('node:child_process')`, and `vi.spyOn(process.stderr,
 * 'write')`, captures `{ op, path?, scope? }` entries for every
 * `unlinkSync`, `execFileSync`, `readFileSync`, `writeFileSync`, and
 * `stderrWrite` call — tagged by which scope's `<dir>/kiro-learn.json`
 * the path belongs to.
 *
 * We then assert:
 *   (a) The recorded trace equals the ordered concatenation
 *       `trace(scope1) ++ trace(scope2_if_defined) ++ trace(compressor_write)`,
 *       where each per-scope trace matches the explicit shape below
 *       (see OUTCOME_TRACE_SHAPES).
 *   (b) No op tagged with `scope: 'project'` appears before the last op
 *       tagged with `scope: 'global'` — the non-interleaving guarantee
 *       (Requirement 12.2).
 *
 * Note on trace shapes. The spec task describes two shapes — success
 * `[unlink, spawn, readFileSync, writeFileSync]` and failure
 * `[unlink, spawn, writeFileSync, stderrWrite]`. The failure summary is
 * correct for `spawn-failed`, `non-zero-exit`, and `missing-file`, all
 * of which short-circuit before the payload is read. The
 * `invalid-payload` branch is subtly different: the seed file IS read
 * (that's how validation discovers the payload is malformed), so its
 * trace is `[unlink, spawn, readFileSync, writeFileSync, stderrWrite]`
 * with an extra `readFileSync` before the fallback write. We encode all
 * five shapes explicitly below — the goal is accurate per-scope
 * ordering, not strict adherence to a simplified summary.
 *
 * Shape of `writeAgentConfigs` execution (after Task 7.1):
 *   1. writeKiroLearnAgent(globalDir)                    — global scope
 *   2. writeKiroLearnAgent(projectDir) if projectRoot    — project scope
 *   3. writeFileSync(globalDir/kiro-learn-compressor.json) — compressor
 * The compressor write is tagged with `scope: 'compressor'` and is the
 * only op in the compressor segment of the trace.
 *
 * **Validates: Requirements 6.4, 9.3, 12.1, 12.2**
 *
 * @see .kiro/specs/default-equivalent-agent/design.md § Correctness Properties — Property 6
 * @see test/unit/installer-write-kiro-learn-agent.test.ts — execFileSync mocking pattern
 * @see test/unit/installer-write-agent-configs.test.ts — tmpHome / node:os mocking pattern
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import type * as nodeFs from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Hoisted shared state ────────────────────────────────────────────────

/**
 * Shared recorder and mock references. `vi.hoisted` runs before any
 * `vi.mock` factory, and both the fs and child_process mock factories
 * below close over this object — so the per-test code, the fs wrappers,
 * and the execFileSync mock all append to and read from the same
 * recorder array.
 *
 * `realWriteFileSync` is populated by the fs mock factory (which has
 * access to the real `node:fs` via `importOriginal`) and is used by the
 * `execFileSync` mock to write the simulated seed payload WITHOUT
 * recording that write in the trace.
 */
const hoisted = vi.hoisted(
  (): {
    recorder: TraceEntry[];
    execFileSyncMock: ReturnType<typeof vi.fn>;
    realWriteFileSync: ((p: string, data: string) => void) | null;
  } => ({
    recorder: [] as TraceEntry[],
    execFileSyncMock: vi.fn(),
    realWriteFileSync: null,
  }),
);

/** A single recorded operation in the trace. */
interface TraceEntry {
  /** The observable op that happened. */
  op: 'unlink' | 'spawn' | 'readFileSync' | 'writeFileSync' | 'stderrWrite';
  /** The path touched, when the op is file-bound. Absent for `stderrWrite`. */
  path?: string;
  /**
   * Which scope this op belongs to. `'global'` for ops touching
   * `<tmpHome>/.kiro/agents/kiro-learn.json`, `'project'` for ops
   * touching `<projectDir>/.kiro/agents/kiro-learn.json`,
   * `'compressor'` for the final `<tmpHome>/.kiro/agents/kiro-learn-compressor.json`
   * write, `undefined` for anything else (should not happen in this test).
   */
  scope?: 'global' | 'project' | 'compressor';
}

// ── tmpHome setup (before mocks so paths are available to taggers) ─────

// Resolve symlinks so paths match what the installer sees via
// `homedir()` on systems that wrap /tmp behind /private/tmp (macOS).
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-order-')),
);
const globalAgentsDir: string = join(tmpHome, '.kiro', 'agents');
const globalKiroLearnPath: string = join(globalAgentsDir, 'kiro-learn.json');
const globalCompressorPath: string = join(
  globalAgentsDir,
  'kiro-learn-compressor.json',
);

// Parent dir for per-test project directories.
const projectParent: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-order-proj-')),
);

/** Derive the scope tag for a path. */
function tagFor(
  p: string,
  projectKiroLearnPath: string | null,
): TraceEntry['scope'] {
  if (p === globalKiroLearnPath) return 'global';
  if (projectKiroLearnPath !== null && p === projectKiroLearnPath)
    return 'project';
  if (p === globalCompressorPath) return 'compressor';
  return undefined;
}

/**
 * The current test's project-scoped `kiro-learn.json` path, or `null`
 * when the current test runs with no project root. Set per test so the
 * fs wrappers can resolve the `'project'` tag correctly.
 */
let currentProjectKiroLearnPath: string | null = null;

// ── Mocks ───────────────────────────────────────────────────────────────

// Mock `node:os.homedir` so the installer sees `tmpHome` everywhere —
// critical because `scopeLabel` inside `writeKiroLearnAgent` compares
// `targetDir` against `path.join(homedir(), '.kiro', 'agents')` to
// decide whether to emit `for global scope` or `for project scope` in
// the Fallback_Warning.
vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Mock `node:fs` with recording wrappers around the three ops we care
// about — `unlinkSync`, `readFileSync`, `writeFileSync` — and pass the
// rest of the module through unchanged. The wrappers tag each op with
// its scope (if any) and then delegate to the real implementation.
vi.mock('node:fs', async (importOriginal) => {
  const real = (await importOriginal()) as typeof nodeFs;

  // Publish the real writeFileSync so the execFileSync mock can write a
  // simulated seed payload WITHOUT appearing in the recorded trace.
  hoisted.realWriteFileSync = (p: string, data: string): void => {
    real.writeFileSync(p, data);
  };

  return {
    ...real,
    unlinkSync: (p: Parameters<typeof real.unlinkSync>[0]) => {
      hoisted.recorder.push({
        op: 'unlink',
        path: typeof p === 'string' ? p : String(p),
        ...(tagFor(String(p), currentProjectKiroLearnPath) !== undefined
          ? { scope: tagFor(String(p), currentProjectKiroLearnPath)! }
          : {}),
      });
      return real.unlinkSync(p);
    },
    readFileSync: ((...args: unknown[]) => {
      const p = args[0];
      hoisted.recorder.push({
        op: 'readFileSync',
        path: typeof p === 'string' ? p : String(p),
        ...(tagFor(String(p), currentProjectKiroLearnPath) !== undefined
          ? { scope: tagFor(String(p), currentProjectKiroLearnPath)! }
          : {}),
      });
      // Pass-through to the real implementation with the caller's args.
      return (real.readFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof real.readFileSync,
    writeFileSync: ((...args: unknown[]) => {
      const p = args[0];
      hoisted.recorder.push({
        op: 'writeFileSync',
        path: typeof p === 'string' ? p : String(p),
        ...(tagFor(String(p), currentProjectKiroLearnPath) !== undefined
          ? { scope: tagFor(String(p), currentProjectKiroLearnPath)! }
          : {}),
      });
      return (real.writeFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof real.writeFileSync,
  };
});

// Mock `node:child_process`. Only `execFileSync` is called on the hot
// path by `runSeedCommand`; `execSync` and `spawn` are listed so the
// installer module loads without pulling real implementations into the
// test. `execFileSync` records a `spawn` trace entry first, then
// dispatches based on the configured outcome for the current call —
// see `configureExecFileSync` below.
vi.mock('node:child_process', () => ({
  execFileSync: hoisted.execFileSyncMock,
  execSync: vi.fn(() => Buffer.from('')),
  spawn: vi.fn(() => ({
    pid: 99999,
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

// Import after mocks so vitest intercepts the modules.
const { writeAgentConfigs } = await import('../../src/installer/index.js');

// ── Per-test lifecycle ─────────────────────────────────────────────────

let projectDir: string | undefined;
let stderrSpy: { mockRestore: () => void };

beforeAll(() => {
  // Ensure INSTALL_DIR/bin exists for parity with the real install
  // layout; not required for the fallback path, but harmless.
  mkdirSync(globalAgentsDir, { recursive: true });
});

beforeEach(() => {
  hoisted.recorder.length = 0;
  hoisted.execFileSyncMock.mockReset();

  // Fresh agents dir per test so residue from one iteration does not
  // affect the next.
  rmSync(globalAgentsDir, { recursive: true, force: true });
  mkdirSync(globalAgentsDir, { recursive: true });

  // `process.stderr.write` is spied with a recording implementation so
  // every `[kiro-learn] warning:` line lands as a `stderrWrite` entry
  // in the shared trace. The chunk itself is not recorded — only the
  // fact that a write happened, which is what P6 cares about.
  stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => {
      hoisted.recorder.push({ op: 'stderrWrite' });
      return true;
    });

  currentProjectKiroLearnPath = null;
  projectDir = undefined;
});

afterEach(() => {
  stderrSpy.mockRestore();
  if (projectDir !== undefined) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(projectParent, { recursive: true, force: true });
});

// ── Outcome configuration ─────────────────────────────────────────────

/** Every outcome `writeKiroLearnAgent` can take on a per-scope basis. */
type Outcome =
  | 'success'
  | 'spawn-failed'
  | 'non-zero-exit'
  | 'missing-file'
  | 'invalid-payload';

const ALL_OUTCOMES: readonly Outcome[] = [
  'success',
  'spawn-failed',
  'non-zero-exit',
  'missing-file',
  'invalid-payload',
] as const;

/** Whether the current test includes a project scope. */
type ProjectMode = 'no-project' | 'with-project';

const ALL_PROJECT_MODES: readonly ProjectMode[] = [
  'no-project',
  'with-project',
] as const;

/**
 * A valid seed JSON string for `success` and a malformed (non-object)
 * JSON string for `invalid-payload`. Reused across every iteration so
 * generator inputs stay simple — P6 is about ordering, not content.
 */
const VALID_SEED_JSON: string = JSON.stringify(
  { name: 'kiro_default', tools: ['fs_read'] },
  null,
  2,
);
const INVALID_SEED_JSON: string = '[1, 2, 3]';

/**
 * Install a per-call implementation of `execFileSync`. For
 * `with-project` runs we need different outcomes for the global and
 * project scopes, so we drive off the `--directory` argv to decide
 * which outcome to apply. For `no-project` runs only `globalOutcome` is
 * consulted.
 */
function configureExecFileSync(
  globalOutcome: Outcome,
  projectOutcome: Outcome | null,
): void {
  hoisted.execFileSyncMock.mockImplementation(
    (_cmd: string, args: readonly string[]) => {
      // Record every spawn attempt, tagged by which scope's directory
      // the argv targets. This is one of the few places where a scope
      // tag is derived from argv rather than path — it ensures the
      // `spawn` entry lands in the correct per-scope slot of the trace.
      const dirIdx = args.indexOf('--directory');
      const dir =
        dirIdx !== -1 && dirIdx < args.length - 1 ? args[dirIdx + 1]! : '';
      const scope: TraceEntry['scope'] =
        dir === globalAgentsDir
          ? 'global'
          : projectDir !== undefined &&
              dir === join(projectDir, '.kiro', 'agents')
            ? 'project'
            : undefined;

      hoisted.recorder.push({
        op: 'spawn',
        path: join(dir, 'kiro-learn.json'),
        ...(scope !== undefined ? { scope } : {}),
      });

      // Choose the outcome for THIS spawn. In `with-project` mode we
      // apply `globalOutcome` to the call targeting the global agents
      // dir and `projectOutcome` to the call targeting the project
      // agents dir. In `no-project` mode only `globalOutcome` fires.
      const outcome: Outcome =
        scope === 'project' && projectOutcome !== null
          ? projectOutcome
          : globalOutcome;

      // Simulate the outcome.
      switch (outcome) {
        case 'success': {
          // kiro-cli writes a valid seed payload to <dir>/kiro-learn.json.
          // We use `realWriteFileSync` (bypassing our recorder) so the
          // mock's write doesn't appear as a `writeFileSync` entry.
          if (hoisted.realWriteFileSync === null) {
            throw new Error(
              'configureExecFileSync: realWriteFileSync not initialized',
            );
          }
          hoisted.realWriteFileSync(
            join(dir, 'kiro-learn.json'),
            VALID_SEED_JSON,
          );
          return Buffer.from('');
        }
        case 'invalid-payload': {
          // kiro-cli returns zero but writes a non-object JSON payload.
          if (hoisted.realWriteFileSync === null) {
            throw new Error(
              'configureExecFileSync: realWriteFileSync not initialized',
            );
          }
          hoisted.realWriteFileSync(
            join(dir, 'kiro-learn.json'),
            INVALID_SEED_JSON,
          );
          return Buffer.from('');
        }
        case 'missing-file': {
          // kiro-cli returns zero but writes no file. The defensive
          // `existsSync` check in `runSeedCommand` catches this.
          return Buffer.from('');
        }
        case 'spawn-failed': {
          // No numeric `status` on the thrown error — spawn-failed.
          throw Object.assign(new Error('spawn kiro-cli ENOENT'), {
            code: 'ENOENT',
            stderr: '',
          });
        }
        case 'non-zero-exit': {
          // Numeric `status` — non-zero-exit.
          throw Object.assign(new Error('Command failed'), {
            status: 1,
            stderr: 'error: bad flag',
          });
        }
      }
    },
  );
}

// ── Expected trace shapes ─────────────────────────────────────────────

/**
 * The ordered per-scope trace shape for each outcome. Expressed as the
 * ops in order; paths and scope tags are filled in by
 * `expectedScopeTrace` based on the concrete scope the outcome applies
 * to.
 *
 * See the module-level docstring for why `invalid-payload` has an extra
 * `readFileSync` relative to the other failure reasons.
 */
const OUTCOME_TRACE_SHAPES: Record<Outcome, readonly TraceEntry['op'][]> = {
  success: ['unlink', 'spawn', 'readFileSync', 'writeFileSync'],
  'spawn-failed': ['unlink', 'spawn', 'writeFileSync', 'stderrWrite'],
  'non-zero-exit': ['unlink', 'spawn', 'writeFileSync', 'stderrWrite'],
  'missing-file': ['unlink', 'spawn', 'writeFileSync', 'stderrWrite'],
  'invalid-payload': [
    'unlink',
    'spawn',
    'readFileSync',
    'writeFileSync',
    'stderrWrite',
  ],
};

/**
 * Build the expected per-scope trace for a given outcome and scope.
 * Every `unlink`, `spawn`, `readFileSync`, and `writeFileSync` entry
 * carries the scope's `kiro-learn.json` path and the scope tag;
 * `stderrWrite` entries carry no path and no scope (since the warning
 * is global-process output, not file-bound).
 */
function expectedScopeTrace(
  outcome: Outcome,
  scope: 'global' | 'project',
  kiroLearnPath: string,
): TraceEntry[] {
  const ops = OUTCOME_TRACE_SHAPES[outcome];
  return ops.map((op): TraceEntry => {
    if (op === 'stderrWrite') {
      return { op };
    }
    return { op, path: kiroLearnPath, scope };
  });
}

/** The compressor trace — a single `writeFileSync` entry, always present. */
const compressorTrace: readonly TraceEntry[] = [
  {
    op: 'writeFileSync',
    path: globalCompressorPath,
    scope: 'compressor',
  },
];

// ── Property 6 ────────────────────────────────────────────────────────

/**
 * Full cartesian product: 5 global outcomes × 5 project outcomes × 2
 * project modes = 50 cases. For `no-project` runs the project outcome
 * is ignored at drive time — we still enumerate all 25 pairs so every
 * global outcome is exercised once per each project-mode, matching the
 * spec task's "cartesian product" phrasing verbatim.
 */
const CASES: ReadonlyArray<
  readonly [globalOutcome: Outcome, projectOutcome: Outcome, mode: ProjectMode]
> = ALL_OUTCOMES.flatMap((g) =>
  ALL_OUTCOMES.flatMap((p) =>
    ALL_PROJECT_MODES.map((m) => [g, p, m] as const),
  ),
);

describe('Installer — property: per-scope ordering holds and scopes do not interleave (P6)', () => {
  it.each(CASES)(
    'trace matches expected ordered concatenation: global=%s, project=%s, mode=%s',
    (globalOutcome, projectOutcome, mode) => {
      /**
       * **Validates: Requirements 6.4, 9.3, 12.1, 12.2**
       *
       * (a) The recorded trace equals
       *     `trace(scope1) ++ trace(scope2_if_defined) ++ trace(compressor)`.
       * (b) No `scope: 'project'` op appears before the last
       *     `scope: 'global'` op — scopes do not interleave.
       */
      if (mode === 'with-project') {
        projectDir = mkdtempSync(join(projectParent, 'project-'));
        mkdirSync(join(projectDir, '.kiro', 'agents'), { recursive: true });
        currentProjectKiroLearnPath = join(
          projectDir,
          '.kiro',
          'agents',
          'kiro-learn.json',
        );
      }

      configureExecFileSync(
        globalOutcome,
        mode === 'with-project' ? projectOutcome : null,
      );

      writeAgentConfigs({
        global: true,
        projectRoot: mode === 'with-project' ? projectDir : undefined,
        detectedMarker: mode === 'with-project' ? '.git' : undefined,
      });

      // Build the expected trace.
      const expected: TraceEntry[] = [
        ...expectedScopeTrace(globalOutcome, 'global', globalKiroLearnPath),
        ...(mode === 'with-project' && currentProjectKiroLearnPath !== null
          ? expectedScopeTrace(
              projectOutcome,
              'project',
              currentProjectKiroLearnPath,
            )
          : []),
        ...compressorTrace,
      ];

      // (a) Exact trace match — ordering AND per-entry shape.
      expect(hoisted.recorder).toEqual(expected);

      // (b) Non-interleaving: no 'project' op appears before the last
      // 'global' op. For the no-project mode this is trivially true
      // (no 'project' entries exist). For with-project mode, the last
      // 'global' index must strictly precede the first 'project'
      // index.
      if (mode === 'with-project') {
        const lastGlobalIdx = hoisted.recorder
          .map((e, i) => (e.scope === 'global' ? i : -1))
          .reduce((a, b) => Math.max(a, b), -1);
        const firstProjectIdx = hoisted.recorder.findIndex(
          (e) => e.scope === 'project',
        );

        expect(lastGlobalIdx).toBeGreaterThanOrEqual(0);
        expect(firstProjectIdx).toBeGreaterThanOrEqual(0);
        expect(lastGlobalIdx).toBeLessThan(firstProjectIdx);
      } else {
        expect(
          hoisted.recorder.every((e) => e.scope !== 'project'),
        ).toBe(true);
      }
    },
  );
});
