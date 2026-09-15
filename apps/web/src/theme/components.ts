/**
 * Component overrides — issue #110.
 *
 * WHY MOST OF THESE ARE `({ theme }) => ...` CALLBACKS NOW
 * =============================================================================
 * They were plain style objects branching on the `mode` argument, which meant
 * every value a component needed from the palette had to be restated as a
 * literal here — that is how `MuiAppBar` ended up with a hardcoded
 * `#e0e0e0`/`#333333` border that had nothing to do with `palette.divider`, and
 * how it stayed wrong through two palette changes. A callback receives the
 * fully-built theme, so an override can ASK for `theme.palette.divider` and be
 * correct by construction for any palette, including a fork's.
 *
 * `mode` survives as an argument anyway, for exactly one thing the theme cannot
 * answer: `BRAND_TOKENS[mode].elevated`. That is a token this design adds and
 * MUI's `Palette` type has no slot for, so it is read from the token map
 * directly rather than smuggled into the palette through a module augmentation
 * — a `declare module '@mui/material/styles'` block would make `elevated`
 * available everywhere at the cost of teaching MUI's types about a key MUI
 * knows nothing about, and it would still not be a colour MUI's own components
 * consult. Two call sites do not justify that.
 *
 * ELEVATION IS A SURFACE, NOT A SHADOW, IN DARK MODE
 * =============================================================================
 * `MuiPaper` sets `backgroundImage: 'none'` unconditionally. MUI's dark mode
 * ships an `elevation` overlay as a `linear-gradient` background IMAGE, which
 * fights every explicit `backgroundColor` a component sets (the gradient wins,
 * because it paints on top) and is exactly why dialogs in this app used to be a
 * slightly different, unpredictable grey from the menus beside them. With the
 * overlay off, `elevated` is the single stated answer to "this floats".
 */

import { Components, Theme, alpha } from '@mui/material/styles';
import { BRAND_TOKENS } from './tokens';

/**
 * Elevation at or above which a dark-mode `Paper` moves onto the tonal
 * surface. MUI gives dialogs 24, menus/popovers 8, and cards/app bars 0–1, so
 * 4 is the gap between "part of the page" and "floating over it".
 */
const FLOATING_ELEVATION = 4;

export const componentOverrides = (mode: 'light' | 'dark'): Components<Theme> => {
  const isDark = mode === 'dark';
  const elevated = BRAND_TOKENS[mode].elevated;

  return {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 500,
        },
      },
    },

    // A card is a surface at rest, not a floating one. Light mode gets a single
    // hairline shadow (1px, 6% black) rather than the old `0 2px 8px rgba(0,0,0,0.1)`
    // — on the tinted `#f6f7fb` ground the paper edge already does most of the
    // separating, and a heavier shadow reads as a dialog. Dark mode gets NO
    // shadow at all: a shadow is darkness, and on `#0f1117` there is no darkness
    // left to spend, so the card is separated by a divider-coloured border
    // instead. That is the same Material 3 argument `elevated` rests on.
    MuiCard: {
      styleOverrides: {
        root: ({ theme }) =>
          isDark
            ? { boxShadow: 'none', border: `1px solid ${theme.palette.divider}` }
            : { boxShadow: '0 1px 2px rgba(16,24,40,0.06)' },
      },
    },

    MuiPaper: {
      styleOverrides: {
        root: ({ ownerState }) => ({
          // See the header: MUI's dark elevation overlay is a background IMAGE
          // and overrides any colour a component sets. Off, everywhere, in both
          // modes — a light-mode Paper never had one, so this costs nothing
          // there and removes a mode branch.
          backgroundImage: 'none',
          // Dialogs (elevation 24), menus and popovers (8) land here; cards and
          // app bars (0–1) do not. Keyed off the `elevation` PROP rather than
          // listed per component, so anything that floats gets the same surface
          // without each component having to remember to ask for it — including
          // the ones a fork adds. Light mode is excluded because its `elevated`
          // IS `paper`, so the branch would be a no-op that only made the rule
          // look mode-dependent.
          ...(isDark && (ownerState.elevation ?? 0) >= FLOATING_ELEVATION
            ? { backgroundColor: elevated }
            : {}),
        }),
      },
    },

    MuiAppBar: {
      styleOverrides: {
        root: ({ theme }) => ({
          boxShadow: 'none',
          // Was `#e0e0e0`/`#333333`, two literals that agreed with no palette in
          // this repository. The app bar's underline and a `<Divider />` two
          // pixels below it are the same line as far as a reader is concerned,
          // so they are the same token.
          borderBottom: `1px solid ${theme.palette.divider}`,
        }),
      },
    },

    // The phone's bottom bar floats over the content it scrolls above, so it
    // takes the tonal surface for the same reason a menu does — and in light
    // mode `elevated` is `paper`, which is what it already was.
    MuiBottomNavigation: {
      styleOverrides: {
        root: {
          backgroundColor: elevated,
        },
      },
    },

    // Issue #106 — the phone bottom bar's labels, and ONLY their geometry.
    //
    // MUI grows the SELECTED action's label from 0.75rem to 0.875rem, which is a
    // reasonable default for short words and wrong for this app's: "Transcripts"
    // at 14px measures ~70px, and a 4-up bar on a 360px phone gives each tab a
    // text box of roughly 66px. So the selected tab — the one the user is
    // looking at — is the one that wraps or ellipsises. Pinning the selected
    // size back to 0.75rem keeps every label the same width whatever is
    // selected, and `nowrap` makes a too-long label truncate cleanly rather than
    // break onto a second line and grow the bar's height under the content.
    //
    // Issue #110 adds the COLOUR rule #106 deliberately left out, and it is
    // additive: the two `label` rules above are untouched, because the geometry
    // argument they encode is independent of what colour the bar is painted in
    // and would be just as true under a third palette.
    MuiBottomNavigationAction: {
      styleOverrides: {
        root: ({ theme }) => ({
          '&.Mui-selected': { color: theme.palette.primary.main },
        }),
        label: {
          whiteSpace: 'nowrap',
          '&.Mui-selected': { fontSize: '0.75rem' },
        },
      },
    },

    // A chip's default (non-`color`ed) fill. MUI's own is a fixed grey that
    // ignores the palette entirely, so on the dark ground it sat a shade
    // lighter than the `elevated` surfaces around it. Derived from
    // `text.primary` at 6% rather than from `primary.main`: a DEFAULT chip is
    // deliberately the one that carries no semantic colour, and tinting it with
    // the brand hue would make every status chip look faintly selected.
    MuiChip: {
      styleOverrides: {
        filled: ({ theme }) => ({
          backgroundColor: alpha(theme.palette.text.primary, 0.06),
        }),
      },
    },

    MuiToggleButton: {
      styleOverrides: {
        root: ({ theme }) => ({
          '&.Mui-selected': {
            backgroundColor: alpha(theme.palette.primary.main, 0.12),
            color: theme.palette.primary.main,
            // MUI's own hover on a selected toggle falls back to the neutral
            // action wash, which on a tinted selection reads as the button
            // un-selecting itself under the pointer. One step up the same
            // alpha ramp instead.
            '&:hover': {
              backgroundColor: alpha(theme.palette.primary.main, 0.18),
            },
          },
        }),
      },
    },

    // 3px, not MUI's 2px. The indicator is the only thing distinguishing the
    // active tab in a strip whose labels are otherwise identical in weight, and
    // at 2px it is a hairline next to this theme's 1px dividers — near enough
    // to read as one.
    MuiTabs: {
      styleOverrides: {
        indicator: {
          height: 3,
        },
      },
    },

    // Underline on hover rather than always. With indigo as the brand colour a
    // permanently underlined link inside body text is two signals for one fact;
    // the colour already distinguishes it, and the underline is what confirms
    // it is interactive at the moment the pointer is on it. Keyboard users are
    // not left out: focus-visible below draws a real outline.
    MuiLink: {
      defaultProps: {
        underline: 'hover',
      },
    },

    // The focus ring, stated once for the whole application.
    //
    // ⚠ `:focus-visible`, NEVER `:focus`. `:focus` fires on a mouse click too,
    // which is how an application ends up with a ring stuck around the last
    // button somebody pressed and, eventually, with somebody "fixing" it by
    // removing the ring for everybody — the keyboard user included.
    //
    // Light mode uses `primary.main`; dark mode uses `primary.dark`, which in
    // this palette is the DARKER end of a LIGHT ramp (`#818cf8` against
    // `#a5b4fc`). That is not a mistake and not a copy of the light rule: the
    // ring is drawn over surfaces that are themselves already tinted with
    // `primary.main` at 16% when selected, and a ring in exactly that hue
    // disappears into its own selection wash. One step down separates them.
    MuiCssBaseline: {
      styleOverrides: (theme) => ({
        ':focus-visible': {
          outline: `2px solid ${
            isDark ? theme.palette.primary.dark : theme.palette.primary.main
          }`,
          outlineOffset: 2,
        },
      }),
    },
  };
};
