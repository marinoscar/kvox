/**
 * The light palette, as MUI sees it — issue #110.
 *
 * NOTHING IS DECIDED HERE. Every value is read out of `BRAND_TOKENS.light`;
 * this file's only job is the translation from the token map's shape into
 * MUI's `PaletteOptions`. Read `tokens.ts` for why a colour is what it is —
 * including why light `primary.main` is `THEME_COLOR` rather than a literal,
 * which is reproduced below because it is the one thing most likely to be
 * "simplified" away by somebody reading only this file.
 */

import { PaletteOptions, alpha } from '@mui/material/styles';
import { BRAND_TOKENS } from './tokens';

const tokens = BRAND_TOKENS.light;

export const lightPalette: PaletteOptions = {
  primary: {
    // Issue #216: the brand colour is `THEME_COLOR` in `packages/shared/index.js`,
    // not a literal here. The manifest's `theme_color` and the committed icons
    // under `public/icons/` cannot import this palette, so if the value lived in
    // the theme a rebrand would restyle the app and leave the installed-app
    // surfaces on the old blue.
    //
    // `light` and `dark` stay hardcoded on purpose: they are hand-picked tints
    // of the brand indigo, not something derivable, and MUI would otherwise
    // compute them from `main` with `tonalOffset` — a different pair of colours
    // than the two below, i.e. a visual change nobody asked this issue for.
    //
    // Issue #110 moved all four values into `tokens.ts` so the dark mode's
    // counterparts sit beside them and cannot drift; the argument above is
    // unchanged and is why `main` is still an import rather than a hex.
    main: tokens.primary.main,
    light: tokens.primary.light,
    dark: tokens.primary.dark,
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
  // Opaque hex, NOT `rgba(0, 0, 0, 0.87)` as this palette used to state them.
  // A translucent text colour is a colour whose real contrast depends on every
  // surface it happens to land on, which is why
  // `datatable/__tests__/testUtils/contrast.ts` has to composite before it can
  // measure anything, and why forgetting the third argument there silently
  // reports 21:1 for both text tiers. Opaque values are measurable as written.
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
  // The selection/hover washes MUI paints on list items, menu items, table
  // rows and toggle buttons. MUI's defaults are neutral black at 4%/8%, which
  // on a brand-tinted application reads as grime rather than as selection;
  // tinting them with the primary hue is what makes a selected row look
  // deliberately selected. Light mode uses the LOWER pair of the two (0.08 /
  // 0.04) because the ground is bright: the same alpha that reads as a gentle
  // wash on `#0f1117` reads as a solid block on `#ffffff`.
  action: {
    selected: alpha(tokens.primary.main, 0.08),
    hover: alpha(tokens.primary.main, 0.04),
  },
};
