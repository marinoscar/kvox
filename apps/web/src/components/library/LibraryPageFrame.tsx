/**
 * The chrome a library page wears: one `h1`, and one primary action rendered
 * two ways. Issue #106.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 *
 * `LibraryPage` used to be one page at two routes, with a Transcripts | Notes
 * tab strip choosing which view to render and a `PRIMARY_ACTIONS` record
 * choosing which button to label. #106 splits that into two sibling
 * destinations and two sibling pages (`pages/TranscriptsPage.tsx`,
 * `pages/NotesPage.tsx`), which leaves the header — the heading, the `>= sm`
 * button, the `< sm` FAB and the 900px measure — as the only thing the two
 * genuinely share.
 *
 * So it moves here verbatim rather than being copied into both pages. Two
 * copies of a FAB whose `bottom` offset is derived from the bottom bar's height
 * is two places to get that derivation wrong, and they would drift the first
 * time only one of them was updated.
 *
 * The `action` is a PROP rather than a lookup keyed by page, deliberately: a
 * record indexed by a page identity is the shape `LibraryPage` had, and it is
 * what made adding a third library surface mean editing a table in a file that
 * knows nothing about it. `null` means this page has no primary action at all —
 * a case no caller has today, and the honest way to express it if one arrives.
 *
 * =============================================================================
 * ⚠ THE `useMediaQuery` BELOW IS A RELOCATED PAGE-LEVEL READ, NOT A NEW GATE
 * =============================================================================
 *
 * It is the same `down('sm')` call `LibraryPage` already made, moved one file
 * over along with the markup that reads it. It decides between two renderings
 * of ONE control on ONE page; it mounts and unmounts nothing in the app shell.
 *
 * The FIVE COUPLED SHELL GATES listed in `docs/specs/settings-ui.md` §5 —
 * `Layout`'s `showRail`, `BottomNav`'s self-gate, `<main>`'s `pb`,
 * `SettingsHub`'s `isCompactWindow` and `AppBar`'s `isCompactWindow` — remain
 * exactly five. This is not a sixth, and it must not be added to that list or
 * "unified" with it: those five have to agree with each other or the user gets
 * a band with two navigation surfaces or none, while this one only ever decides
 * whether a button floats. It uses the same `sm` boundary because the FAB's
 * offset clears the bottom bar, which is gate (2)'s business — a DERIVED
 * relationship, the same one `TranscriptPlayer`'s mini dock documents at
 * length, not a shared gate.
 */

import type { ReactNode } from 'react';

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Fab from '@mui/material/Fab';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useNavigate } from 'react-router-dom';

import { usePermissions } from '../../hooks/usePermissions';

export interface LibraryPageFrameProps {
  /** The page's one `h1`. */
  title: string;
  /**
   * The page's primary action: where it goes, what it is called, and the
   * permission that decides whether it is offered at all. `null` for a page
   * with no primary action.
   */
  action: { label: string; path: string; permission: string } | null;
  children: ReactNode;
}

export function LibraryPageFrame({ title, action, children }: LibraryPageFrameProps) {
  const theme = useTheme();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  // See the file header: a page-level rendering choice, not a shell gate.
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));

  // REACHABILITY IS THE ROUTE'S JOB; this is about CONTENT. `App.tsx` already
  // refused a user who cannot read this surface — what is left to decide is
  // whether the one who CAN read it may also create, which is a different
  // permission (`:write`) and a different question.
  const canCreate = action !== null && hasPermission(action.permission);

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto' }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          mb: 2,
        }}
      >
        <Typography variant="h5" component="h1">
          {title}
        </Typography>
        {/* The FAB below is the phone's primary action; at `sm` and up the same
            action is an ordinary button in the header, where there is room for
            it and where a floating control would only cover content. */}
        {canCreate && !isPhone && action && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => navigate(action.path)}
          >
            {action.label}
          </Button>
        )}
      </Box>

      {children}

      {canCreate && isPhone && action && (
        <Fab
          color="primary"
          aria-label={action.label}
          onClick={() => navigate(action.path)}
          sx={{
            position: 'fixed',
            right: 16,
            // Clears the bottom bar, which exists only below `sm` — and this
            // control only renders below `sm`, so the offset is unconditional.
            // Same derived relationship to `BottomNav`'s gate that
            // `TranscriptPlayer`'s mini dock documents at length.
            bottom: 'calc(72px + env(safe-area-inset-bottom))',
          }}
        >
          <AddIcon />
        </Fab>
      )}
    </Box>
  );
}

export default LibraryPageFrame;
