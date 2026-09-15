import { Components, Theme } from '@mui/material/styles';

export const componentOverrides = (mode: 'light' | 'dark'): Components<Theme> => ({
  MuiButton: {
    styleOverrides: {
      root: {
        textTransform: 'none',
        fontWeight: 500,
      },
    },
  },
  MuiCard: {
    styleOverrides: {
      root: {
        boxShadow: mode === 'light'
          ? '0 2px 8px rgba(0, 0, 0, 0.1)'
          : '0 2px 8px rgba(0, 0, 0, 0.3)',
      },
    },
  },
  MuiAppBar: {
    styleOverrides: {
      root: {
        boxShadow: 'none',
        borderBottom: `1px solid ${mode === 'light' ? '#e0e0e0' : '#333333'}`,
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
  // COLOUR IS NOT SET HERE, deliberately: the selected/unselected palette for
  // this bar belongs to a later issue, and mixing a colour rule into this
  // override would make it look as though #106 had an opinion about it.
  MuiBottomNavigationAction: {
    styleOverrides: {
      label: {
        whiteSpace: 'nowrap',
        '&.Mui-selected': { fontSize: '0.75rem' },
      },
    },
  },
});
