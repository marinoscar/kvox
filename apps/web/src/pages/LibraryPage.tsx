/**
 * `/transcripts` and `/notes` — the library. Issues #30 (epic #19) and #57
 * (epic #45).
 *
 * =============================================================================
 * ONE PAGE, TWO ROUTES, AND THE ROUTE IS THE TAB
 * =============================================================================
 *
 * This page replaces `TranscriptsLibraryPage`, keeping its body verbatim as the
 * Transcripts tab (`components/library/TranscriptsLibraryView.tsx`) and adding
 * Notes beside it. It is reached at two paths and renders the tab the path
 * names — see `libraryTabs.ts` for why that is derived rather than held in
 * state, and what a `useState` tab would silently get wrong about deep links,
 * reloads and the Back button.
 *
 * =============================================================================
 * TABS ARE CORRECT HERE, AND THIS IS EXACTLY THE CASE THE RULE ALLOWS
 * =============================================================================
 *
 * CLAUDE.md's Settings UI Pattern rule 2 forbids bolting a settings page on as
 * a tab and permits tabs only for genuinely PARALLEL content — two views of the
 * same question. Transcripts and Notes are that: one question ("what do I
 * have?"), two answers, neither reachable "inside" the other, and a note is not
 * a child of the library's transcript half — it may have been made from a
 * document or from another note. The counter-example the rule was written about
 * — `SystemSettingsPage`'s three tabs — was hierarchical content wearing a tab
 * strip; this is not that.
 *
 * (This is also not a settings surface at all, so the registry rules do not
 * reach it. `config/destinations.ts` is what declares it, and the AppBar's
 * drill-down table is what handles its children.)
 *
 * The tab strip inside the Transcripts view (Mine | Shared with me) is the same
 * judgement one level down, which is why the nesting is a hierarchy of
 * QUESTIONS rather than of content.
 *
 * =============================================================================
 * THE TAB GATE IS CONTENT; THE DESTINATION GATE IS REACHABILITY
 * =============================================================================
 *
 * `destinations.ts` makes the Library row visible on EITHER `transcripts:read`
 * or `notes:read`, because it fronts two controllers. This page then shows only
 * the tabs the user can actually open — the same reachability-vs-content split
 * `/admin/settings` draws between its `anyPermission` and its per-card
 * permissions, and the reason a user holding one permission never meets a tab
 * that would bounce them on click.
 */

import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Fab from '@mui/material/Fab';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useLocation, useNavigate } from 'react-router-dom';

import { NotesLibraryView } from '../components/library/NotesLibraryView';
import { TranscriptsLibraryView } from '../components/library/TranscriptsLibraryView';
import { usePermissions } from '../hooks/usePermissions';
import { LIBRARY_TAB_PATHS, libraryTabFromPath } from './libraryTabs';
import type { LibraryTab } from './libraryTabs';

/** The primary action for each tab: where it goes, what it is called, its gate. */
const PRIMARY_ACTIONS: Record<
  LibraryTab,
  { label: string; path: string; permission: string }
> = {
  transcripts: {
    label: 'New transcript',
    path: '/transcripts/new',
    permission: 'transcripts:write',
  },
  notes: { label: 'New note', path: '/notes/new', permission: 'notes:write' },
};

export function LibraryPage() {
  const theme = useTheme();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { hasPermission } = usePermissions();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));

  // DERIVED FROM THE URL ON EVERY RENDER. There is no tab state — see
  // `libraryTabs.ts`.
  const tab = libraryTabFromPath(pathname);

  const canReadTranscripts = hasPermission('transcripts:read');
  const canReadNotes = hasPermission('notes:read');

  const action = PRIMARY_ACTIONS[tab];
  const canCreate = hasPermission(action.permission);

  /**
   * A tab click is a NAVIGATION, and nothing else happens here.
   *
   * `replace: false`, deliberately: switching tabs is a move the user made and
   * Back should undo it. That is the whole behavioural difference between this
   * and a state-held tab, and it costs one word.
   */
  const handleTabChange = (_: React.SyntheticEvent, value: LibraryTab) => {
    navigate(LIBRARY_TAB_PATHS[value]);
  };

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
          Library
        </Typography>
        {/* The FAB below is the phone's primary action; at `sm` and up the same
            action is an ordinary button in the header, where there is room for
            it and where a floating control would only cover content. */}
        {canCreate && !isPhone && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => navigate(action.path)}
          >
            {action.label}
          </Button>
        )}
      </Box>

      <Tabs
        value={tab}
        onChange={handleTabChange}
        aria-label="Library"
        sx={{ mb: 2 }}
      >
        {/* Rendered CONDITIONALLY rather than disabled: a tab a user cannot
            open is not a thing they should be able to focus, and a disabled tab
            advertises a surface while refusing it. MUI tolerates a `false` child
            here, which is why this is an inline conditional rather than a
            filtered array of elements. */}
        {canReadTranscripts && <Tab value="transcripts" label="Transcripts" />}
        {canReadNotes && <Tab value="notes" label="Notes" />}
      </Tabs>

      {tab === 'notes' ? <NotesLibraryView /> : <TranscriptsLibraryView />}

      {canCreate && isPhone && (
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

export default LibraryPage;
