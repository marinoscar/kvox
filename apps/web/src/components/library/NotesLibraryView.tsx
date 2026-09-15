/**
 * The body of `/notes` — issue #57, epic #45; its own page since #106.
 *
 * `TranscriptsLibraryView`'s sibling, and deliberately its twin in shape: the
 * same debounced search, the same "Any status" sentinel, the same two
 * densities, the same two empty states, the same cursor paging and the same
 * Load more. These were two tabs of one page until #106 made them two
 * destinations; the twinning survives the split and matters more after it,
 * because a user now moves between two PAGES and two different list idioms
 * would make one product feel like two.
 *
 * The `<h1>` ("Notes") and the primary action are
 * `components/library/LibraryPageFrame.tsx`'s, rendered by
 * `pages/NotesPage.tsx`.
 *
 * =============================================================================
 * EVERY ROW SAYS WHAT IT CAME FROM
 * =============================================================================
 *
 * "from *Q3 planning*", linked to the transcript. A note is DERIVED — that is
 * the whole premise of the epic — and a list of twenty notes with no indication
 * of what each was made from would have discarded the fact that makes them
 * trustworthy. The name itself is resolved by `useNoteSourceNames`, which
 * explains at length why the client has to fetch it and what should replace
 * that; a row whose source cannot be named falls back to the category noun and
 * stays perfectly readable.
 *
 * =============================================================================
 * A GENERATING NOTE SHOWS PROGRESS, NOT A PLACEHOLDER
 * =============================================================================
 *
 * A note takes tens of seconds to write. `NoteStatusChip` carries the spinner,
 * and the row swaps its excerpt for an INDETERMINATE bar while the note is in
 * flight, so the list is a progress display rather than a row that sits inert
 * and then changes.
 *
 * ⚠ The bar and the excerpt are EITHER/OR, not both — read the render, which
 * has always been a ternary. This paragraph used to claim the row showed both
 * at once, and described the bar as "determinate-looking" while the comment
 * beside it says the opposite and explains why: the API publishes no
 * percentage, and inventing one would be a bar that lies.
 *
 * The list hook polls only while something is in flight — see `useNotes` — so
 * a settled library costs nothing.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';

import { NoteStatusChip } from '../notes/NoteStatusChip';
import { usePermissions } from '../../hooks/usePermissions';
import { useNoteSourceNames, noteSourceKey } from '../../hooks/useNoteSourceNames';
import { isNoteInFlight, useNotes } from '../../hooks/useNotes';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';
import { feedCacheKey } from '../../utils/feedCache';
import type { NoteListItem, NoteStatus } from '../../services/notes';
import { noteSourceFallbackLabel, noteSourcePath, noteSourceRef } from '../../utils/noteSource';
import { formatRelativeTime } from '../../utils/relativeTime';
import { NOTE_STATUS_FILTERS } from '../../pages/notesLibraryFilters';

/** The same 300 ms the Transcripts tab waits, and for the same reason. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * "from *Q3 planning*" — the row's provenance line.
 *
 * ⚠ RENDERED OUTSIDE THE ROW'S `CardActionArea`, and that placement is the
 * whole design of this row rather than a layout preference. A link inside a
 * button is NESTED INTERACTIVE CONTENT: axe fails it, a screen reader cannot
 * offer both targets, and a keyboard user reaches a control their reader has
 * just told them is part of a button. The `stopPropagation` trick that makes it
 * LOOK fine with a mouse fixes none of that.
 *
 * So the row is two parts: the action area IS the note, and this footer is
 * where it came from. Both are real targets, neither is inside the other.
 *
 * EXPORTED since issue #107, because the home page's `NoteSummaryCard` shows
 * the same provenance line. Not copied: a second implementation would be a
 * second place for the fallback wording, the document-has-no-page rule and —
 * the one that actually bites — the outside-the-action-area placement to drift
 * apart, and the copy that got it wrong would fail axe on a page whose own
 * suite never rendered this component.
 */
export function SourceLine({ note, name }: { note: NoteListItem; name: string | undefined }) {
  const ref = noteSourceRef(note);
  const path = noteSourcePath(note);
  const label = name ?? (ref ? noteSourceFallbackLabel(ref.type) : 'an unknown source');

  return (
    <Typography variant="caption" color="text.secondary" component="p">
      {'from '}
      {path ? (
        <Link component={RouterLink} to={path} sx={{ fontStyle: 'italic' }}>
          {label}
        </Link>
      ) : (
        <Box component="em" sx={{ display: 'inline' }}>
          {label}
        </Box>
      )}
    </Typography>
  );
}

function NoteRow({
  note,
  sourceName,
  dense,
  onOpen,
}: {
  note: NoteListItem;
  sourceName: string | undefined;
  dense: boolean;
  onOpen: () => void;
}) {
  const inFlight = isNoteInFlight(note.status);

  return (
    <Card variant="outlined" component="li" sx={{ listStyle: 'none' }}>
      <CardActionArea
        onClick={onOpen}
        sx={{
          p: dense ? 1.25 : 2,
          display: 'flex',
          alignItems: dense ? 'center' : 'flex-start',
          flexDirection: dense ? 'row' : 'column',
          gap: dense ? 2 : 0.75,
          minWidth: 0,
        }}
      >
        <Box sx={{ flexGrow: 1, minWidth: 0, width: '100%' }}>
          {/* `h2`, for the reason the transcript rows state: the page's one
              `h1` is "Notes" (#106 — it read "Library" while this view was a
              tab) and nothing sits between it and this row, so `h3` would skip
              a level and axe is right to say so. */}
          <Typography variant="subtitle1" component="h2" noWrap sx={{ fontWeight: 600 }}>
            {note.title}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="p">
            {formatRelativeTime(note.createdAt)}
            {note.templateName ? ` · ${note.templateName}` : ''}
          </Typography>
          {inFlight ? (
            <Box sx={{ mt: 1 }}>
              {/* INDETERMINATE, because the API publishes no percentage and
                  inventing one would be a bar that lies. What it says is "this
                  is moving", which is exactly what is known. */}
              <LinearProgress aria-label={`Generating ${note.title}`} />
            </Box>
          ) : note.excerpt ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{
                mt: 0.5,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {note.excerpt}
            </Typography>
          ) : null}
        </Box>
        <Box sx={{ flexShrink: 0 }}>
          <NoteStatusChip status={note.status} />
        </Box>
      </CardActionArea>
      {/* The provenance footer. See `SourceLine` for why it is here and not in
          the action area above. */}
      <Box sx={{ px: dense ? 1.25 : 2, pb: dense ? 1 : 1.5, pt: 0 }}>
        <SourceLine note={note} name={sourceName} />
      </Box>
    </Card>
  );
}

export function NotesLibraryView() {
  const theme = useTheme();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState<NoteStatus | 'all'>('all');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  /**
   * Where this feed's loaded pages and its scroll offset live across a
   * drill-down — issue #168.
   *
   * EVERY ACTIVE FILTER IS IN THE KEY. A key that ignored the search term or
   * the status would replay rows that demonstrably do not match the question
   * on screen; keying on all of them makes a filter change a cache MISS, which
   * correctly starts the list over, and gives each filter its own remembered
   * scroll position for free.
   *
   * ⚠ THE DEBOUNCED TERM, NOT THE RAW INPUT. Keying on every keystroke would
   * mint (and immediately evict) an entry per character, which is both a
   * pointless cost and a good way to push the entry the user is coming back to
   * out of a bounded cache.
   */
  const cacheKey = useMemo(
    () => feedCacheKey('notes', [debouncedSearch, status]),
    [debouncedSearch, status],
  );

  // The other half of the drill-down, and the reason this page reuses the hook
  // the settings hub already uses rather than growing a second implementation:
  // it already handles the restore deadline, the `sessionStorage` namespacing,
  // and the rule that a real gesture wins outright. Called UNCONDITIONALLY and
  // outside any branch, per the rules of hooks. Because the key carries the
  // filters, switching one writes the old filter's offset under the old key and
  // restores the new one's — which is exactly the behaviour you want.
  useScrollRestoration(cacheKey);

  const { notes, isLoading, error, nextCursor, isLoadingMore, loadMore } = useNotes({
    q: debouncedSearch,
    status: status === 'all' ? undefined : status,
    cacheKey,
  });

  const sourceNames = useNoteSourceNames(notes);
  const canCreate = hasPermission('notes:write');

  const isFiltered = useMemo(
    () => debouncedSearch.trim().length > 0 || status !== 'all',
    [debouncedSearch, status],
  );

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        <TextField
          size="small"
          label="Search notes"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          sx={{ flexGrow: 1 }}
        />
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <InputLabel id="note-status-filter">Status</InputLabel>
          <Select
            labelId="note-status-filter"
            label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value as NoteStatus | 'all')}
          >
            {NOTE_STATUS_FILTERS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress aria-label="Loading notes" />
        </Box>
      ) : notes.length === 0 ? (
        <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          {/* TWO EMPTY STATES, for the reason the Transcripts tab gives: a
              filter that matched nothing is fixed by changing the filter, and
              telling a user with two hundred notes to "make your first note"
              because they searched for "zzz" is nonsense. */}
          {isFiltered ? (
            <>
              <Typography variant="h6" component="h2" gutterBottom>
                No notes match those filters
              </Typography>
              <Typography color="text.secondary">
                Try a different search term, or set the status filter back to Any.
              </Typography>
            </>
          ) : (
            <>
              <Typography variant="h6" component="h2" gutterBottom>
                No notes yet
              </Typography>
              <Typography color="text.secondary" sx={{ mb: 3 }}>
                Turn a transcript, another note or a document into a written note —
                minutes, a summary, a brief — using a template you control. It runs on
                your own AI key.
              </Typography>
              {canCreate && (
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => navigate('/notes/new')}
                >
                  New note
                </Button>
              )}
            </>
          )}
        </Paper>
      ) : (
        <Stack component="ul" spacing={1} sx={{ p: 0, m: 0 }}>
          {notes.map((note) => {
            const ref = noteSourceRef(note);
            return (
              <NoteRow
                key={note.id}
                note={note}
                sourceName={ref ? sourceNames[noteSourceKey(ref)] : undefined}
                dense={!isPhone}
                onOpen={() => navigate(`/notes/${note.id}`)}
              />
            );
          })}
        </Stack>
      )}

      {nextCursor && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button onClick={() => void loadMore()} disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </Box>
      )}
    </Box>
  );
}

export default NotesLibraryView;
