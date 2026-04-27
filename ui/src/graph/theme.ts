/**
 * Graph color palette and styling constants.
 *
 * Six hues at ~60° intervals for project-based coloring.
 * Each project gets a color from this palette (cycling).
 * Memory nodes inherit their project's color.
 */

export interface NodeColorScheme {
  readonly border: string;
  readonly background: string;
  /** Text color for tinted-background nodes (dark, readable on light bg). */
  readonly text: string;
  /** Text color for solid-background nodes (white on saturated bg). */
  readonly textInverse: string;
}

/** Light-mode palette — tinted pastel backgrounds. */
export const LIGHT_PALETTE: readonly NodeColorScheme[] = [
  { border: '#3B82F6', background: '#DBEAFE', text: '#1E3A5F', textInverse: '#FFFFFF' },  // Blue
  { border: '#8B5CF6', background: '#EDE9FE', text: '#3B1F7E', textInverse: '#FFFFFF' },  // Violet
  { border: '#F43F5E', background: '#FFE4E6', text: '#7F1D2B', textInverse: '#FFFFFF' },  // Rose
  { border: '#F59E0B', background: '#FEF3C7', text: '#78350F', textInverse: '#FFFFFF' },  // Amber
  { border: '#10B981', background: '#D1FAE5', text: '#064E3B', textInverse: '#FFFFFF' },  // Emerald
  { border: '#14B8A6', background: '#CCFBF1', text: '#134E4A', textInverse: '#FFFFFF' },  // Teal
] as const;

/** Dark-mode palette — deeper tinted backgrounds with light text. */
export const DARK_PALETTE: readonly NodeColorScheme[] = [
  { border: '#60A5FA', background: '#1E3A5F', text: '#DBEAFE', textInverse: '#FFFFFF' },  // Blue
  { border: '#A78BFA', background: '#3B1F7E', text: '#EDE9FE', textInverse: '#FFFFFF' },  // Violet
  { border: '#FB7185', background: '#7F1D2B', text: '#FFE4E6', textInverse: '#FFFFFF' },  // Rose
  { border: '#FBBF24', background: '#78350F', text: '#FEF3C7', textInverse: '#FFFFFF' },  // Amber
  { border: '#34D399', background: '#064E3B', text: '#D1FAE5', textInverse: '#FFFFFF' },  // Emerald
  { border: '#2DD4BF', background: '#134E4A', text: '#CCFBF1', textInverse: '#FFFFFF' },  // Teal
] as const;

/** Returns the palette for the given mode. */
export function getPalette(darkMode: boolean): readonly NodeColorScheme[] {
  return darkMode ? DARK_PALETTE : LIGHT_PALETTE;
}

/** Kept for backward compatibility — defaults to light palette. */
export const PROJECT_PALETTE = LIGHT_PALETTE;

interface GraphThemeColors {
  readonly edgeStroke: string;
  readonly canvasBackground: string;
}

/** Returns canvas/edge colors for the given mode. */
export function getGraphColors(darkMode: boolean): GraphThemeColors {
  return darkMode
    ? { edgeStroke: '#4B5563', canvasBackground: '#0f1b2d' }
    : { edgeStroke: '#7d8998', canvasBackground: '#f2f3f3' };
}

export const graphTheme = {
  /** Edge styling — mid-gray for visibility (light mode default). */
  edge: {
    stroke: '#7d8998',
  },

  /** Canvas background — light gray (light mode default). */
  canvas: {
    background: '#f2f3f3',
  },

  /**
   * Font family matching Cloudscape's global styles.
   */
  fontFamily:
    "'Amazon Ember', 'Helvetica Neue', Roboto, Arial, sans-serif",
} as const;
