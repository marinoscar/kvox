// The brand entry of @marinoscar/kvox-web: the one source of the KVox look (MUI
// theme, tokens, mark, lockup, identity values) for every host. Assets (SVG, PNG,
// the Inter font) are separate package exports, listed in the README.
//
// It is the one entry that imports the platform: `createKvoxTheme` builds on
// `createShellTheme` from `@marinoscar/platform-web/shell/headless`, which is why
// `@marinoscar/platform-web` is a peer of this entry (rule host-neutral allows
// exactly that specifier for this package).

import type { PaletteOptions, ThemeOptions } from '@mui/material/styles';
import { componentOverrides } from './components.js';
import { darkPalette } from './dark.js';
import { KVOX_BRAND } from './identity.js';
import { lightPalette } from './light.js';
import { BRAND_TOKENS } from './tokens.js';
import { MARK_ACCENT } from './mark-geometry.js';

export { BrandLockup } from './BrandLockup.js';
export type { BrandLockupProps } from './BrandLockup.js';
export { BrandMark } from './BrandMark.js';
export type { BrandMarkProps } from './BrandMark.js';
export { KVOX_BRAND } from './identity.js';
export type { KvoxBrand } from './identity.js';
export { createKvoxTheme, kvoxDarkTheme, kvoxLightTheme } from './theme.js';

/**
 * One ramp of a colour: the main shade, a lighter and a darker step, and the
 * ink that reads on `main`.
 *
 * @stability experimental
 */
export interface KvoxColorRamp {
  /** The main shade. */
  readonly main: string;
  /** The lighter step, a hand-picked tint (not derived by MUI's `tonalOffset`). */
  readonly light: string;
  /** The darker step, a hand-picked shade. */
  readonly dark: string;
  /** The text colour that reads on `main`. */
  readonly contrastText: string;
}

/**
 * The two grounds a colour can land on.
 *
 * @stability experimental
 */
export interface KvoxBackgroundTokens {
  /** The page ground. */
  readonly default: string;
  /** The ground of cards and panels. */
  readonly paper: string;
}

/**
 * The three text tiers.
 *
 * @stability experimental
 */
export interface KvoxTextTokens {
  /** Body text. */
  readonly primary: string;
  /** Supporting text. */
  readonly secondary: string;
  /** Disabled text. */
  readonly disabled: string;
}

/**
 * The two colours of the mark.
 *
 * @stability experimental
 */
export interface KvoxBrandColors {
  /** The plate: the brand colour of `identity.json`. */
  readonly indigo: string;
  /** The waveform: the brand's amber accent. */
  readonly amber: string;
}

/**
 * One mode's colour tokens: every colour the KVox UI paints that is not a
 * per-component one-off. Opaque hex strings, so contrast can be measured as
 * written.
 *
 * @stability experimental
 */
export interface KvoxPaletteTokens {
  /** The brand ramp: `main` is the light brand colour or the dark tint. */
  readonly primary: KvoxColorRamp;
  /** The accent ramp (amber). */
  readonly secondary: KvoxColorRamp;
  /** The page and card grounds. */
  readonly background: KvoxBackgroundTokens;
  /** The tonal surface of dialogs, menus, popovers and the bottom bar (same as `paper` in light). */
  readonly elevated: string;
  /** The three text tiers. */
  readonly text: KvoxTextTokens;
  /** Hairlines and borders. */
  readonly divider: string;
  /** Success status. */
  readonly success: string;
  /** Warning status. */
  readonly warning: string;
  /** Error status. */
  readonly error: string;
  /** Info status. */
  readonly info: string;
}

/**
 * The KVox colour tokens for both modes, plus the two brand colours of the mark.
 *
 * @stability experimental
 */
export interface KvoxTokens {
  /** Light mode. Its `primary.main` is the brand colour of `identity.json`. */
  readonly light: KvoxPaletteTokens;
  /** Dark mode. Its `primary.main` is a chosen tint of the indigo ramp, not a derivation. */
  readonly dark: KvoxPaletteTokens;
  /** The two colours of the mark: the plate and the waveform. */
  readonly brand: KvoxBrandColors;
}

/**
 * The KVox colour tokens, both modes.
 *
 * @stability experimental
 */
export const kvoxTokens: KvoxTokens = {
  light: BRAND_TOKENS.light,
  dark: BRAND_TOKENS.dark,
  brand: { indigo: KVOX_BRAND.themeColor, amber: MARK_ACCENT },
};

/**
 * The light palette as MUI `PaletteOptions`, translated from the tokens.
 *
 * @stability experimental
 */
export const kvoxLightPalette: PaletteOptions = lightPalette;

/**
 * The dark palette as MUI `PaletteOptions`, translated from the tokens.
 *
 * @stability experimental
 */
export const kvoxDarkPalette: PaletteOptions = darkPalette;

/**
 * The KVox component overrides for `mode`: sentence-case 500-weight buttons, a
 * bordered shadowless dark card, the divider-driven AppBar, chips, toggle
 * buttons, tab indicator, focus ring, and the data-table and dialog rules.
 *
 * @param mode - `light` or `dark`.
 * @returns the MUI `components` option.
 *
 * @stability experimental
 */
export function kvoxComponentOverrides(mode: 'light' | 'dark'): ThemeOptions['components'] {
  return componentOverrides(mode);
}
