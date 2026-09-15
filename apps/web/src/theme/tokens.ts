/**
 * The brand token map — issue #110.
 *
 * ONE OBJECT, BOTH MODES. Every colour the application paints that is not a
 * per-component one-off comes from here, and `light.ts` / `dark.ts` are thin
 * translations of `BRAND_TOKENS.light` / `BRAND_TOKENS.dark` into MUI's
 * `PaletteOptions` shape. That is the whole reason this file exists: before it,
 * the two palettes were two independent hand-written objects, and they had
 * already drifted exactly the way two independent hand-written objects do —
 * light `primary.main` tracked the brand (`THEME_COLOR`, then `#1976d2`) while
 * dark `primary.main` was a hardcoded `#90caf9` that had no relationship to the
 * brand at all. Nothing in the repository could see the disagreement, because
 * nothing read both files. Now one file does, and a change to one mode is
 * physically beside the other.
 *
 * -----------------------------------------------------------------------------
 * WHY LIGHT `primary.main` IS `THEME_COLOR` AND NOT A LITERAL
 * -----------------------------------------------------------------------------
 *
 * `packages/shared/identity.json` is the rebrand codemod's contract: it is the
 * single field `scripts/rename.mjs` rewrites and the single field
 * `apps/web/scripts/generate-icons.py` paints into the committed PNGs. The
 * installed-app surfaces — the web app manifest's `theme_color`, the icon
 * rasters, the two hand-written SVGs — execute no React code and can never
 * import a palette, so if the brand colour's source of truth lived in this file
 * a rebrand would restyle the running application and leave the browser tab,
 * the Home Screen icon and the OS chrome on the old colour. Reading it here
 * costs one import and makes that failure unrepresentable.
 *
 * The three tints beside it (`light`, `dark`, `contrastText`) stay literals for
 * the reason the old `light.ts` already gave and which has not changed: they
 * are hand-picked steps of the indigo ramp, not something derivable, and MUI
 * would otherwise synthesise them from `main` via `tonalOffset` — a different
 * pair of colours than the two chosen here.
 *
 * -----------------------------------------------------------------------------
 * WHY THE DARK PRIMARY IS A TOKEN BESIDE IT, NOT A DERIVATION OF IT
 * -----------------------------------------------------------------------------
 *
 * The obvious-looking alternative is to give dark mode `THEME_COLOR` too and
 * let MUI lighten it — `createTheme` will happily do that, and it is what a
 * `tonalOffset` bump would buy. It was rejected. `THEME_COLOR` at AA against
 * `#171a23` is a non-starter (today's value measures 2.76:1 as ink on the dark
 * paper), and
 * the lightened variant `tonalOffset` produces is a desaturated, muddy
 * blue-grey: `tonalOffset` mixes toward white in sRGB, which drags an already
 * dark, heavily saturated indigo through exactly the part of the space where it
 * loses its hue identity first. `#a5b4fc` is a *chosen* tint from the same
 * indigo ramp that keeps the hue legible at 8.72:1 on `#171a23`.
 *
 * So: a tint for a dark surface is a DESIGN DECISION, and this file records it
 * as one. What it deliberately does not do is record it somewhere the light
 * palette cannot see — that is the drift described at the top, and putting both
 * modes in one literal is the entire remedy.
 *
 * -----------------------------------------------------------------------------
 * `elevated` — A TONAL SURFACE, NOT A SHADOW
 * -----------------------------------------------------------------------------
 *
 * `elevated` is a Material 3 style tonal surface container: the ground a
 * dialog, a menu, a popover or the bottom navigation bar sits on. Material 2's
 * answer to "this thing floats above the page" is a drop shadow, which works on
 * a light ground and fails on a dark one — a shadow is darkness, and there is
 * no darkness left to spend below `#0f1117`. Material 3's answer is a lighter
 * surface instead, which is what `#1e222d` is.
 *
 * In light mode `elevated` is `#ffffff`, the same as `paper`, on purpose: white
 * paper on a tinted `#f6f7fb` ground already reads as raised, so light mode
 * keeps its (very restrained) shadow and needs no second surface. Having the
 * key present in both modes is what lets `components.ts` reference
 * `BRAND_TOKENS[mode].elevated` without branching at every use site.
 *
 * -----------------------------------------------------------------------------
 * CONTRAST IS TESTED, NOT ASSERTED IN PROSE
 * -----------------------------------------------------------------------------
 *
 * Every pair below is pinned by `src/__tests__/theme/tokens.test.ts`, which
 * recomputes the WCAG 2.1 ratio from these literals on every run. Two of the
 * light speaker colours this issue replaced (`#e65100`, `#00838f`) failed AA
 * against the old `#f5f5f5` page ground and had done since they were written,
 * because nothing measured them. Adding a colour here without adding it there
 * reintroduces exactly that.
 */

import { THEME_COLOR } from '@app/shared';

export const BRAND_TOKENS = {
  light: {
    primary: { main: THEME_COLOR, light: '#818cf8', dark: '#4338ca', contrastText: '#ffffff' },
    secondary: { main: '#b45309', light: '#d97706', dark: '#92400e', contrastText: '#ffffff' },
    background: { default: '#f6f7fb', paper: '#ffffff' },
    elevated: '#ffffff',
    text: { primary: '#1a1b2e', secondary: '#5b5f7a', disabled: '#9497ad' },
    divider: '#e1e4ee',
    success: '#15803d', warning: '#a16207', error: '#b91c1c', info: '#1d4ed8',
  },
  dark: {
    primary: { main: '#a5b4fc', light: '#c7d2fe', dark: '#818cf8', contrastText: '#0f1117' },
    secondary: { main: '#fbbf24', light: '#fcd34d', dark: '#f59e0b', contrastText: '#0f1117' },
    background: { default: '#0f1117', paper: '#171a23' },
    elevated: '#1e222d',
    text: { primary: '#e6e8f0', secondary: '#a2a7bd', disabled: '#6b7089' },
    divider: '#2a2f3d',
    success: '#4ade80', warning: '#fbbf24', error: '#f87171', info: '#60a5fa',
  },
} as const;

/** The two modes the token map is keyed by. Not `ThemeMode` — `'system'` is a
 *  user PREFERENCE that resolves to one of these, never a palette of its own. */
export type PaletteMode = keyof typeof BRAND_TOKENS;
