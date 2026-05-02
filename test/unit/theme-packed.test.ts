/**
 * Unit test for `ui/src/graph/theme.ts`.
 *
 * Pins down the exact demo palette so future palette drift is caught at
 * test time, not by a human squinting at a screenshot.
 */

import { describe, it, expect } from 'vitest';

import { getPackedTheme, hexToRgba01 } from '../../ui/src/graph/theme.js';

describe('hexToRgba01', () => {
  it('parses #RRGGBB into a four-float tuple in [0, 1]', () => {
    expect(hexToRgba01('#000000')).toEqual([0, 0, 0, 1]);
    expect(hexToRgba01('#ffffff')).toEqual([1, 1, 1, 1]);
    expect(hexToRgba01('#ED69B4')).toEqual([
      0xed / 255,
      0x69 / 255,
      0xb4 / 255,
      1,
    ]);
  });

  it('parses #RRGGBBAA and respects the alpha channel', () => {
    const [, , , a] = hexToRgba01('#00000080');
    expect(a).toBeCloseTo(0x80 / 255);
  });

  it('throws on malformed input', () => {
    expect(() => hexToRgba01('')).toThrow();
    expect(() => hexToRgba01('red')).toThrow();
    expect(() => hexToRgba01('#fff')).toThrow(); // short form unsupported
    expect(() => hexToRgba01('#GGGGGG')).toThrow();
  });
});

describe('getPackedTheme — dark mode', () => {
  const theme = getPackedTheme(true);

  it('uses the point-labels demo palette verbatim', () => {
    // #ED69B4 hot pink for projects.
    expect(theme.projectFill).toEqual(hexToRgba01('#ED69B4'));
    // #4B5BBF blue-purple for memories and concepts (they share a color).
    expect(theme.memoryFill).toEqual(hexToRgba01('#4B5BBF'));
    expect(theme.conceptFill).toEqual(hexToRgba01('#4B5BBF'));
    // #5F74C2 for edges in the demo.
    expect(theme.edgeColor).toEqual(hexToRgba01('#5F74C2'));
    // #2d313a dark charcoal canvas.
    expect(theme.backgroundColor).toBe('#2d313a');
    expect(theme.darkMode).toBe(true);
  });
});

describe('getPackedTheme — light mode', () => {
  const theme = getPackedTheme(false);

  it('keeps the accent colors and swaps the canvas to near-white', () => {
    // Same accents across modes.
    expect(theme.projectFill).toEqual(hexToRgba01('#ED69B4'));
    expect(theme.memoryFill).toEqual(hexToRgba01('#4B5BBF'));
    expect(theme.conceptFill).toEqual(hexToRgba01('#4B5BBF'));
    // Edge darkens slightly so it remains visible on #f2f3f3.
    expect(theme.edgeColor).toEqual(hexToRgba01('#4B5BBF'));
    expect(theme.backgroundColor).toBe('#f2f3f3');
    expect(theme.darkMode).toBe(false);
  });
});

describe('getPackedTheme — memory and concept always share a color', () => {
  it('memoryFill equals conceptFill in both modes', () => {
    for (const darkMode of [true, false]) {
      const t = getPackedTheme(darkMode);
      expect(t.memoryFill).toEqual(t.conceptFill);
    }
  });
});
