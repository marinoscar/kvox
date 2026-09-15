/**
 * The dark palette, as MUI sees it — issue #110.
 *
 * The mirror of `light.ts`: nothing is decided here either, every value comes
 * from `BRAND_TOKENS.dark`, and `tokens.ts` carries the rationale — in
 * particular why the dark primary is a token chosen for a dark surface rather
 * than `THEME_COLOR` run through MUI's `tonalOffset`.
 *
 * Before issue #110 this file's `primary.main` was a hardcoded `#90caf9` with
 * no relationship to the brand whatsoever, and the only reason that survived is
 * that nothing read this file and `light.ts` together. `tokens.ts` now does.
 */

import { PaletteOptions, alpha } from '@mui/material/styles';
import { BRAND_TOKENS } from './tokens';

const tokens = BRAND_TOKENS.dark;

export const darkPalette: PaletteOptions = {
  primary: {
    main: tokens.primary.main,
    light: tokens.primary.light,
    dark: tokens.primary.dark,
    // Near-black, not white: `#a5b4fc` is a light tint, so a filled primary
    // button in dark mode is dark-ink-on-light-fill. MUI would pick this by
    // luminance anyway; stating it keeps the pair measurable by the token test
    // rather than dependent on MUI's internal threshold.
    contrastText: tokens.primary.contrastText,
  },
  secondary: {
    main: tokens.secondary.main,
    light: tokens.secondary.light,
    dark: tokens.secondary.dark,
    contrastText: tokens.secondary.contrastText,
  },
  background: {
    default: tokens.background.default,
    paper: tokens.background.paper,
  },
  // Opaque, for the reason given in `light.ts`: a translucent text colour
  // cannot be contrast-checked without knowing what is behind it.
  text: {
    primary: tokens.text.primary,
    secondary: tokens.text.secondary,
    disabled: tokens.text.disabled,
  },
  divider: tokens.divider,
  success: { main: tokens.success },
  warning: { main: tokens.warning },
  error: { main: tokens.error },
  info: { main: tokens.info },
  // Twice the light mode's alphas (0.16 / 0.08 against 0.08 / 0.04). A wash
  // has to shift the ground far enough to be seen, and the same proportional
  // step is a much smaller perceptual step near black than near white — the
  // light values applied here are invisible on `#0f1117`.
  action: {
    selected: alpha(tokens.primary.main, 0.16),
    hover: alpha(tokens.primary.main, 0.08),
  },
};
