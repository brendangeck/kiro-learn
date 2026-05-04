/**
 * Unit tests for {@link validateCollectorConfig}.
 *
 * Pins the range checks introduced by Task 13.4: every new
 * reconciliation numeric field plus `bufferIdleMs` must lie within
 * the range documented in Requirements 10.1–10.6, and an out-of-range
 * value must throw an `Error` whose message names the offending field
 * AND the observed value so operators can diagnose from stderr alone.
 *
 * Ranges under test:
 *
 * - `bufferIdleMs` ∈ [5_000, 300_000]
 * - `intraBatchSimilarityThreshold` ∈ [0, 1]
 * - `neighborSimilarityThreshold` ∈ [0, 1]
 * - `neighborPoolMaxSize` ∈ [1, 100]
 * - `judgeModelTimeoutMs` ∈ [5_000, 300_000]
 *
 * Pre-existing config knobs (ports, retrieval budgets, extraction
 * concurrency, etc.) are deliberately NOT validated — the feature
 * scope is the new reconciliation fields plus `bufferIdleMs`. The
 * tests here mirror that scope; a regression that accidentally
 * validates (and therefore rejects) a pre-existing knob would show up
 * as a newly-failing test elsewhere, not here.
 *
 * @see .kiro/specs/reconciliation-engine/tasks.md § Task 13.7
 * @see .kiro/specs/reconciliation-engine/requirements.md §§ 10.1–10.7
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COLLECTOR_CONFIG,
  validateCollectorConfig,
} from '../../src/collector/index.js';
import type { CollectorConfig } from '../../src/collector/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a fully-populated config by merging `overrides` into the
 * repo's `DEFAULT_COLLECTOR_CONFIG`. Callers override only the field
 * under test so a single out-of-range value isn't masked by a default
 * that would itself fail validation.
 */
function makeConfig(overrides: Partial<CollectorConfig>): CollectorConfig {
  return { ...DEFAULT_COLLECTOR_CONFIG, ...overrides };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('validateCollectorConfig', () => {
  it('accepts the default config unchanged', () => {
    // Regression guard: the defaults shipped in the repo must pass
    // their own validator. A failure here means either the defaults
    // drifted out of range or the validator rejects its own baseline.
    expect(() => {
      validateCollectorConfig(DEFAULT_COLLECTOR_CONFIG);
    }).not.toThrow();
  });

  describe('bufferIdleMs ∈ [5_000, 300_000]', () => {
    it('accepts the documented in-range value (30_000)', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ bufferIdleMs: 30_000 }));
      }).not.toThrow();
    });

    it('accepts the exact lower bound (5_000)', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ bufferIdleMs: 5_000 }));
      }).not.toThrow();
    });

    it('accepts the exact upper bound (300_000)', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ bufferIdleMs: 300_000 }));
      }).not.toThrow();
    });

    it('rejects below the lower bound and names the field + observed value', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ bufferIdleMs: 1_000 }));
      }).toThrow(/bufferIdleMs.*1000/);
    });

    it('rejects above the upper bound and names the field + observed value', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ bufferIdleMs: 600_000 }));
      }).toThrow(/bufferIdleMs.*600000/);
    });
  });

  describe('intraBatchSimilarityThreshold ∈ [0, 1]', () => {
    it('accepts the documented in-range value (0.85)', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ intraBatchSimilarityThreshold: 0.85 }));
      }).not.toThrow();
    });

    it('accepts the exact lower bound (0)', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ intraBatchSimilarityThreshold: 0 }));
      }).not.toThrow();
    });

    it('accepts the exact upper bound (1)', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ intraBatchSimilarityThreshold: 1 }));
      }).not.toThrow();
    });

    it('rejects a negative value and names the field + observed value', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ intraBatchSimilarityThreshold: -0.5 }));
      }).toThrow(/intraBatchSimilarityThreshold.*-0\.5/);
    });

    it('rejects a value > 1 and names the field + observed value', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ intraBatchSimilarityThreshold: 1.5 }));
      }).toThrow(/intraBatchSimilarityThreshold.*1\.5/);
    });
  });

  describe('neighborSimilarityThreshold ∈ [0, 1]', () => {
    it('accepts the documented in-range value (0.80)', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ neighborSimilarityThreshold: 0.8 }));
      }).not.toThrow();
    });

    it('accepts the exact bounds (0, 1)', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ neighborSimilarityThreshold: 0 }));
      }).not.toThrow();
      expect(() => {
        validateCollectorConfig(makeConfig({ neighborSimilarityThreshold: 1 }));
      }).not.toThrow();
    });

    it('rejects a negative value and names the field + observed value', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ neighborSimilarityThreshold: -1 }));
      }).toThrow(/neighborSimilarityThreshold.*-1/);
    });

    it('rejects a value > 1 and names the field + observed value', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ neighborSimilarityThreshold: 2 }));
      }).toThrow(/neighborSimilarityThreshold.*2/);
    });
  });

  describe('neighborPoolMaxSize ∈ [1, 100]', () => {
    it('accepts the documented in-range value (10)', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ neighborPoolMaxSize: 10 }));
      }).not.toThrow();
    });

    it('accepts the exact bounds (1, 100)', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ neighborPoolMaxSize: 1 }));
      }).not.toThrow();
      expect(() => {
        validateCollectorConfig(makeConfig({ neighborPoolMaxSize: 100 }));
      }).not.toThrow();
    });

    it('rejects 0 and names the field + observed value', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ neighborPoolMaxSize: 0 }));
      }).toThrow(/neighborPoolMaxSize.*0/);
    });

    it('rejects a value > 100 and names the field + observed value', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ neighborPoolMaxSize: 1_000 }));
      }).toThrow(/neighborPoolMaxSize.*1000/);
    });
  });

  describe('judgeModelTimeoutMs ∈ [5_000, 300_000]', () => {
    it('accepts the documented in-range value (30_000)', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ judgeModelTimeoutMs: 30_000 }));
      }).not.toThrow();
    });

    it('accepts the exact bounds (5_000, 300_000)', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ judgeModelTimeoutMs: 5_000 }));
      }).not.toThrow();
      expect(() => {
        validateCollectorConfig(makeConfig({ judgeModelTimeoutMs: 300_000 }));
      }).not.toThrow();
    });

    it('rejects below the lower bound and names the field + observed value', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ judgeModelTimeoutMs: 500 }));
      }).toThrow(/judgeModelTimeoutMs.*500/);
    });

    it('rejects above the upper bound and names the field + observed value', () => {
      expect(() => {
        validateCollectorConfig(makeConfig({ judgeModelTimeoutMs: 600_000 }));
      }).toThrow(/judgeModelTimeoutMs.*600000/);
    });
  });

  describe('error message format', () => {
    it('includes the field name, both range bounds, and the observed value', () => {
      // Pick one field — the same message-building helper runs for
      // every range check, so one high-signal assertion pins the
      // shape for all of them. Operators reading stderr need
      // (a) the field name, (b) the allowed range, and (c) what
      // they actually passed — all three must be present.
      try {
        validateCollectorConfig(makeConfig({ neighborPoolMaxSize: 0 }));
        expect.fail('expected validateCollectorConfig to throw');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).toContain('neighborPoolMaxSize');
        expect(message).toContain('1');
        expect(message).toContain('100');
        expect(message).toContain('0');
      }
    });

    it('leaves undefined fields untouched — optional fields are allowed to be absent', () => {
      // The validator treats `undefined` as "not present; skip"
      // — a typed `Partial<CollectorConfig>` overlay doesn't have
      // to supply every new field to pass validation. This is the
      // contract that lets callers drop one knob at a time.
      const sparse: CollectorConfig = {
        ...DEFAULT_COLLECTOR_CONFIG,
      };
      // Delete is used rather than `undefined` assignment because
      // of `exactOptionalPropertyTypes`.
      delete sparse.reconciliationEnabled;
      delete sparse.intraBatchSimilarityThreshold;
      delete sparse.neighborSimilarityThreshold;
      delete sparse.neighborPoolMaxSize;
      delete sparse.judgeModelTimeoutMs;
      delete sparse.bufferIdleMs;

      expect(() => {
        validateCollectorConfig(sparse);
      }).not.toThrow();
    });
  });

  describe('startCollector rejection on invalid config', () => {
    it('throws before any DB handle is opened when a reconciliation field is out of range', async () => {
      // `startCollector` invokes `validateCollectorConfig` before
      // `openSqliteStorage`, so a bad config must reject synchronously
      // via the validator rather than partway through wiring. Testing
      // the throw message is enough — a CLI wrapper that writes this
      // message to stderr and exits 1 can be validated separately
      // (here we only own the library surface).
      const { startCollector } = await import('../../src/collector/index.js');
      await expect(
        startCollector({ intraBatchSimilarityThreshold: 1.5 }),
      ).rejects.toThrow(/intraBatchSimilarityThreshold.*1\.5/);
    });
  });
});
