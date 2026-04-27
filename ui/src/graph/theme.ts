/**
 * Cloudscape-derived color constants for graph styling.
 *
 * Values are the resolved hex colors from Cloudscape's light-theme design tokens.
 * We hardcode them here because React Flow needs plain CSS values at render time
 * and we can't read CSS custom properties at build time.
 *
 * Token sources (Cloudscape light theme):
 *   colorBackgroundStatusInfo      → #0972d3  (blue)
 *   colorBackgroundStatusSuccess   → #037f0c  (green)
 *   colorBackgroundStatusWarning   → #8d6605  (amber)
 *   colorBorderDividerDefault      → #e9ebed
 *   colorBackgroundContainerContent→ #ffffff
 *   colorTextBodyDefault           → #000716
 *   colorBackgroundLayoutMain      → #f2f3f3
 *   colorBorderStatusInfo          → #0972d3
 *   colorBorderStatusSuccess       → #037f0c
 *   colorBorderStatusWarning       → #8d6605
 */

export const graphTheme = {
  /** Project supernode — blue tones from status-info tokens. */
  projectNode: {
    /** Semi-transparent blue background for the supernode body. */
    background: 'rgba(9, 114, 211, 0.06)',
    /** Border derived from colorBorderStatusInfo. */
    border: '#0972d3',
    /** Header bar background from colorBackgroundStatusInfo. */
    headerBackground: '#0972d3',
    /** Header text — white on blue for contrast. */
    headerText: '#ffffff',
    /** Body text from colorTextBodyDefault. */
    text: '#000716',
  },

  /** Concept node — green tones from status-success tokens. */
  conceptNode: {
    /** Light green background. */
    background: 'rgba(3, 127, 12, 0.08)',
    /** Border derived from colorBorderStatusSuccess. */
    border: '#037f0c',
    /** Label text from colorTextBodyDefault. */
    text: '#000716',
  },

  /** Memory node — amber/warm tones from status-warning tokens. */
  memoryNode: {
    /** Light amber background. */
    background: 'rgba(141, 102, 5, 0.08)',
    /** Border derived from colorBorderStatusWarning. */
    border: '#8d6605',
    /** Label text from colorTextBodyDefault. */
    text: '#000716',
  },

  /** Edge styling — uses Cloudscape divider token so edges blend with the page. */
  edge: {
    /** Stroke color from colorBorderDividerDefault. */
    stroke: '#e9ebed',
  },

  /** Canvas background — matches Cloudscape layout background. */
  canvas: {
    /** Background from colorBackgroundLayoutMain. */
    background: '#f2f3f3',
  },

  /**
   * Font family matching Cloudscape's global styles.
   * Cloudscape applies 'Amazon Ember' with a standard sans-serif fallback stack
   * via @cloudscape-design/global-styles.
   */
  fontFamily:
    "'Amazon Ember', 'Helvetica Neue', Roboto, Arial, sans-serif",
} as const;
