/**
 * Cloudscape theme overrides for kiro-learn.
 *
 * Swaps the default Cloudscape blue chrome for the kiro-learn purple brand
 * palette (matching the docs site at kiro-learn.mintlify.app). Only the
 * app-level chrome tokens are themed — primary buttons, links, focus rings,
 * and the generic accent color.
 *
 * The memory graph node colors (blue = project, pink = memory, mint = concept)
 * are deliberately NOT themed here. Those colors are semantic, not brand.
 * See `ui/src/graph/theme.ts`.
 */

import type { Theme } from '@cloudscape-design/components/theming';

/** Brand primary — matches `docs.json.colors.primary`. */
const PURPLE = '#8D47FF';

/** Brand dark — matches `docs.json.colors.dark`. Used for hover/active depth. */
const PURPLE_DARK = '#7D25E6';

/** Brand light — matches `docs.json.colors.light`. Readable on dark backgrounds. */
const PURPLE_LIGHT = '#C7A0FF';

/**
 * Theme object consumed by `applyTheme` from
 * `@cloudscape-design/components/theming`. Each color token sets `light` and
 * `dark` values so Cloudscape's `Mode.Dark` toggle automatically picks the
 * readable variant.
 */
export const kiroLearnTheme: Theme = {
  tokens: {
    // Generic accent (icons, selected states, subtle emphasis).
    colorTextAccent: { light: PURPLE, dark: PURPLE_LIGHT },

    // Primary button — background.
    colorBackgroundButtonPrimaryDefault: { light: PURPLE, dark: PURPLE_LIGHT },
    colorBackgroundButtonPrimaryHover: { light: PURPLE_DARK, dark: PURPLE },
    colorBackgroundButtonPrimaryActive: { light: PURPLE_DARK, dark: PURPLE },

    // Links.
    colorTextLinkDefault: { light: PURPLE, dark: PURPLE_LIGHT },
    colorTextLinkHover: { light: PURPLE_DARK, dark: '#FFFFFF' },

    // Focus ring — used everywhere keyboard focus lands.
    colorBorderItemFocused: { light: PURPLE, dark: PURPLE_LIGHT },
  },
};
