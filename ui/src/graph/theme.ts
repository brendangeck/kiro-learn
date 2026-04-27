/**
 * Graph styling constants.
 *
 * All node types use the same outline style (tinted background + saturated border)
 * but different colors per type:
 *   - Project = blue
 *   - Memory = pink/salmon
 *   - Concept = mint/green
 */

export interface NodeColorScheme {
  readonly border: string;
  readonly background: string;
  readonly text: string;
}

/** Light mode node colors. */
export const LIGHT_COLORS = {
  project: { border: '#3B82F6', background: '#DBEAFE', text: '#1E3A5F' },
  memory:  { border: '#F43F5E', background: '#FFE4E6', text: '#7F1D2B' },
  concept: { border: '#10B981', background: '#D1FAE5', text: '#064E3B' },
} as const;

/** Dark mode node colors. */
export const DARK_COLORS = {
  project: { border: '#60A5FA', background: '#1E3A5F', text: '#DBEAFE' },
  memory:  { border: '#FB7185', background: '#7F1D2B', text: '#FFE4E6' },
  concept: { border: '#34D399', background: '#064E3B', text: '#D1FAE5' },
} as const;

/** Returns node colors for the given mode. */
export function getNodeColors(darkMode: boolean) {
  return darkMode ? DARK_COLORS : LIGHT_COLORS;
}

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
  fontFamily: "'Amazon Ember', 'Helvetica Neue', Roboto, Arial, sans-serif",
} as const;
