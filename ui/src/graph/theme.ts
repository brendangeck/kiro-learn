/**
 * Graph styling constants for the cosmos.gl memory graph.
 *
 * Palette is ported from the cosmos.gl `point-labels` storybook demo. Two
 * node kinds visually:
 *
 *   - Projects (hubs, labeled):  #ED69B4  (hot pink, both modes)
 *   - Memories / concepts:       #4B5BBF  (medium blue-purple, both modes)
 *   - Edges:                     #5F74C2 on dark,  #4B5BBF on light
 *   - Canvas background:         #2d313a on dark,  #f2f3f3 on light
 *
 * The demo has two node kinds (theaters + performances). We map our three
 * kinds onto them: `project` is the hub; `memory` and `concept` are both
 * leaves and share the same blue-purple.
 */

import type { PackedTheme } from './transform.js';

/**
 * Parse `#RRGGBB` or `#RRGGBBAA` into a four-float RGBA tuple in `[0, 1]`.
 * Throws on malformed input.
 */
export function hexToRgba01(hex: string): [number, number, number, number] {
  if (typeof hex !== 'string' || (hex.length !== 7 && hex.length !== 9) || hex[0] !== '#') {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const body = hex.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(body)) throw new Error(`Invalid hex color: ${hex}`);
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  const a = body.length === 8 ? parseInt(body.slice(6, 8), 16) : 255;
  return [r / 255, g / 255, b / 255, a / 255];
}

/**
 * Packed theme for the cosmos.gl renderer. Dark mode is the demo's
 * verbatim scheme; light mode is a surface swap — same accents, light
 * canvas, slightly darker edge color for contrast against near-white.
 */
export function getPackedTheme(darkMode: boolean): PackedTheme {
  return {
    darkMode,
    projectFill: hexToRgba01('#ED69B4'),
    memoryFill:  hexToRgba01('#4B5BBF'),
    conceptFill: hexToRgba01('#4B5BBF'),
    // Darken the edge slightly in light mode so it remains visible against
    // the near-white canvas. The demo's #5F74C2 works against #2d313a but
    // washes out against #f2f3f3.
    edgeColor:   hexToRgba01(darkMode ? '#5F74C2' : '#4B5BBF'),
    backgroundColor: darkMode ? '#2d313a' : '#f2f3f3',
  };
}
