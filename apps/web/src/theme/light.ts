import { PaletteOptions } from '@mui/material/styles';
import { THEME_COLOR } from '@app/shared';

export const lightPalette: PaletteOptions = {
  primary: {
    // Issue #216: the brand colour is `THEME_COLOR` in `packages/shared/index.js`,
    // not a literal here. The manifest's `theme_color` and the committed icons
    // under `public/icons/` cannot import this palette, so if the value lived in
    // the theme a rebrand would restyle the app and leave the installed-app
    // surfaces on the old blue.
    //
    // `light` and `dark` stay hardcoded on purpose: they are hand-picked tints
    // of the default blue, not something derivable, and MUI would otherwise
    // compute them from `main` with `tonalOffset` — a different pair of colours
    // than the two below, i.e. a visual change nobody asked this issue for.
    main: THEME_COLOR,
    light: '#42a5f5',
    dark: '#1565c0',
  },
  secondary: {
    main: '#9c27b0',
    light: '#ba68c8',
    dark: '#7b1fa2',
  },
  background: {
    default: '#f5f5f5',
    paper: '#ffffff',
  },
  text: {
    primary: 'rgba(0, 0, 0, 0.87)',
    secondary: 'rgba(0, 0, 0, 0.6)',
  },
};
