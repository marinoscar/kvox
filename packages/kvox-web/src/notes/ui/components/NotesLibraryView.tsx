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
 * `LibraryPageFrame` (`@marinoscar/kvox-web/core/ui`)'s, rendered by
 * `pages/NotesPage.tsx`.
 *
 * =============================================================================
 * EVERY ROW SAYS WHAT IT CAME FROM
 * =============================================================================
 *
 * "from *Q3 planning*", linked to the transcript. A note is DERIVED — that is
 * the whole premise of the epic — and a list of twenty notes with no indication
 * of what each was made from would have discarded the fact that makes them
 * trustworthy. The name arrives ON THE ROW as `sourceName` since #192 — the
 * client used to resolve it with one request per distinct source on the page,
 * which is up to sixty extra round trips after three "Load more" presses. A row
 * whose source cannot be named (deleted, or no longer readable by this caller)
 * falls back to the category noun and stays perfectly readable.
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
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import CheckBoxOutlinedIcon from '@mui/icons-material/CheckBoxOutlined';
import ToggleButton from '@mui/material/ToggleButton';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';

import {
  ActiveStatusFilterChip,
  FeedCountLine,
  FeedDateSeparator,
} from '../../../core/ui/index.js';
import { NoteStatusChip } from './NoteStatusChip.js';
import { SearchResultsView } from '../../../search/ui/index.js';
import { NotesSlotBoundary } from '../slots.js';
import type { NotesLibrarySlots } from '../slots.js';
import { isNoteInFlight, useNotes } from '../../headless/hooks/useNotes.js';
import { useSearch } from '../../../search/headless/index.js';
import {
  feedCacheKey,
  feedCountLabel,
  formatRelativeTime,
  groupFeedByDate,
  useKvoxPermissionCheck,
  useScrollRestoration,
} from '../../../core/headless/index.js';
import type { NoteListItem, NoteStatus } from '../../headless/clients/notes.js';
import type { SearchResult, SearchType } from '../../../search/headless/index.js';
import { noteSourceFallbackLabel, noteSourcePath, noteSourceRef } from '../../headless/utils/noteSource.js';
import {
  NOTE_STATUS_FILTERS,
  noteStatusFromQuery,
  searchFromQuery,
} from '../../headless/utils/notesLibraryFilters.js';

/**
 * ⚠ THE DEBOUNCE MOVED INTO THE HOOK — issue #176, epic #164.
 *
 * The twin of the note `TranscriptsLibraryView` carries in the same place, for
 * the same reason: this box now feeds `useSearch`, which debounces internally
 * and aborts the superseded request, so a second timer here would debounce a
 * debounce and make the box feel broken.
 */

/**
 * What this view asks `GET /api/search` for — its own type and nothing else.
 *
 * Module-level so its identity is stable: `useSearch` derives its effect's
 * dependency from the list, and a fresh array every render would re-issue the
 * search on every unrelated re-render. `TranscriptsLibraryView` carries the
 * same constant with `['transcript']`.
 */
const SEARCH_TYPES: SearchType[] = ['note'];

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
 *
 * @param props - The note whose provenance to draw.
 * @returns The line.
 *
 * @stability experimental
 */
export function SourceLine({ note }: { note: NoteListItem }) {
  const ref = noteSourceRef(note);
  const path = noteSourcePath(note);
  // `note.sourceName` comes straight off the list row since #192. It is `null`
  // when the source is gone OR when the caller may no longer read it — both of
  // which render the category noun, which is what a reader should see either
  // way and what the client's own 404 path used to produce.
  const label = note.sourceName ?? (ref ? noteSourceFallbackLabel(ref.type) : 'an unknown source');

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

/** How long a finger must rest on a note card to start selecting (ms), and how far it may wander (px). */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

/** Selection state of one row (GIC-14): absent when the host offers no multi-select. */
interface RowSelection {
  /** Selection mode is on: the row shows a checkbox and a click toggles it. */
  selecting: boolean;
  /** This note is selected. */
  selected: boolean;
  /** The limit is reached and this note is not selected, so it cannot be added. */
  blocked: boolean;
  /** Toggle this note. */
  onToggle: () => void;
  /** A long press on a touch screen: start selecting with this note. */
  onLongPress: () => void;
}

function NoteRow({
  note,
  dense,
  onOpen,
  selection,
}: {
  note: NoteListItem;
  dense: boolean;
  onOpen: () => void;
  selection?: RowSelection;
}) {
  const inFlight = isNoteInFlight(note.status);
  const selecting = selection?.selecting === true;

  // A touch long-press starts selection mode; the click the finger-up then sends is swallowed.
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancelPress = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }, []);
  useEffect(() => cancelPress, [cancelPress]);
  const onPointerDown = (event: ReactPointerEvent) => {
    if (!selection || selecting || event.pointerType !== 'touch') return;
    fired.current = false;
    cancelPress();
    press.current = {
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        press.current = null;
        fired.current = true;
        selection.onLongPress();
      }, LONG_PRESS_MS),
    };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const current = press.current;
    if (current && Math.hypot(event.clientX - current.x, event.clientY - current.y) > LONG_PRESS_SLOP_PX) cancelPress();
  };

  const body = (
    <>
      <CardActionArea
        onClick={selecting ? selection?.onToggle : onOpen}
        tabIndex={selecting ? -1 : undefined}
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
        <SourceLine note={note} />
      </Box>
    </>
  );

  if (!selection) {
    return (
      <Card variant="outlined" component="li" sx={{ listStyle: 'none' }}>
        {body}
      </Card>
    );
  }
  return (
    <Card
      variant="outlined"
      component="li"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onClickCapture={(event) => {
        if (fired.current) {
          fired.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onContextMenu={(event) => {
        // A long press also asks for the browser's menu on Android; selecting replaces it.
        if (fired.current || press.current !== null) event.preventDefault();
      }}
      sx={{
        listStyle: 'none',
        borderColor: selection.selected ? 'primary.main' : undefined,
        borderWidth: selection.selected ? 2 : undefined,
        '@media (pointer: coarse)': { WebkitTouchCallout: 'none', userSelect: 'none' },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'stretch' }}>
        {selecting && (
          <Box sx={{ display: 'flex', alignItems: 'center', pl: 0.5 }}>
            <Checkbox
              checked={selection.selected}
              disabled={selection.blocked}
              onChange={selection.onToggle}
              slotProps={{ input: { 'aria-label': `Select ${note.title}` } }}
              sx={{ p: 1.25 }}
            />
          </Box>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>{body}</Box>
      </Box>
    </Card>
  );
}

/** The most notes a library selection holds unless the host says otherwise. */
const DEFAULT_SELECTION_LIMIT = 10;

/** The default of the `useSelectionEnabled` slot: no multi-select. */
function useNeverEnabled(): boolean {
  return false;
}

/**
 * Props of {@link NotesLibraryView}.
 *
 * @stability experimental
 */
export interface NotesLibraryViewProps {
  /** What the host adds to the library (the search-hits slot). */
  slots?: NotesLibrarySlots;
}

/**
 * The notes library: the feed, its filters and, while the box holds a term,
 * ranked search results.
 *
 * @param props - See {@link NotesLibraryViewProps}.
 * @returns The view.
 *
 * @stability experimental
 */
export function NotesLibraryView({ slots }: NotesLibraryViewProps = {}) {
  const SearchPrefix = slots?.SearchPrefix;
  const SelectionActions = slots?.SelectionActions;
  // Multi-select (GIC-14) exists only when the host fills the slots AND its hook says the feature is on.
  const useSelectionEnabled = slots?.useSelectionEnabled ?? useNeverEnabled;
  const selectionAvailable = useSelectionEnabled() && SelectionActions !== undefined;
  const selectionLimit = slots?.selectionLimit ?? DEFAULT_SELECTION_LIMIT;
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const stopSelecting = useCallback(() => {
    setSelecting(false);
    setSelectedIds([]);
  }, []);
  const toggleSelected = useCallback(
    (id: string) =>
      setSelectedIds((current) =>
        current.includes(id)
          ? current.filter((value) => value !== id)
          : current.length >= selectionLimit
            ? current
            : [...current, id],
      ),
    [selectionLimit],
  );
  const theme = useTheme();
  const navigate = useNavigate();
  const hasPermission = useKvoxPermissionCheck();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));

  /**
   * THE URL SEEDS THIS VIEW, ONCE, AND NOTHING WRITES BACK TO IT.
   *
   * `/notes?status=failed&q=budget` is a deep link, read in LAZY INITIALISERS
   * so it applies on mount and never again — the twin of what
   * `TranscriptsLibraryView` does, minus the `?scope` this library has no tab
   * for. The decision, and the rejected full two-way sync, are recorded once in
   * `transcriptsLibraryFilters.ts`.
   *
   * ⚠ `?q=` NOW SEEDS A SEARCH, not a list filter (#176), and there is no
   * second `debouncedSearch` state to seed alongside it — the flash that state
   * prevented cannot happen through this path any more, because a non-empty box
   * puts the view in search mode on the FIRST render and `useSearch` raises its
   * loading flag synchronously. `TranscriptsLibraryView` carries the long form.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState(() => searchFromQuery(searchParams));
  const [status, setStatus] = useState<NoteStatus | 'all'>(() =>
    noteStatusFromQuery(searchParams),
  );

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
  /**
   * IS THE BOX ASKING A SEARCH QUESTION? — issue #176, the twin of the switch
   * `TranscriptsLibraryView` makes, whose comment carries the full argument:
   * the RAW value (so the switch is immediate), and `.length > 0` rather than
   * `.trim().length > 0` (so an all-whitespace box reaches "Type to search"
   * rather than falling back to an unfiltered list).
   */
  const searchMode = search.length > 0;

  /**
   * ⚠ THE LIST IS NEVER ASKED A TEXT FILTER ANY MORE (#176).
   *
   * `GET /api/notes?q=` is untouched; this view simply stops calling it with a
   * term, because a term now goes to the search endpoint. The list renders only
   * when the box is empty, so the request it issues is the one an empty box
   * issued before this issue — and the cache key (#168) drops its search
   * component for the same reason, still carrying every filter that can vary
   * while this list is on screen.
   */
  const cacheKey = useMemo(() => feedCacheKey('notes', [status]), [status]);

  // The other half of the drill-down, and the reason this page reuses the hook
  // the settings hub already uses rather than growing a second implementation:
  // it already handles the restore deadline, the `sessionStorage` namespacing,
  // and the rule that a real gesture wins outright. Called UNCONDITIONALLY and
  // outside any branch, per the rules of hooks. Because the key carries the
  // filters, switching one writes the old filter's offset under the old key and
  // restores the new one's — which is exactly the behaviour you want.
  useScrollRestoration(cacheKey);

  const { notes, total, isLoading, error, nextCursor, isLoadingMore, loadMore } = useNotes({
    status: status === 'all' ? undefined : status,
    cacheKey,
  });

  /**
   * The other source this view can show — issue #176.
   *
   * Called UNCONDITIONALLY and outside any branch, per the rules of hooks, and
   * inert while the box is empty: `useSearch` treats a blank query as NO SEARCH
   * rather than as a search for nothing, and issues no request at all.
   */
  const searchState = useSearch({ q: search, types: SEARCH_TYPES });
  const canCreate = hasPermission('notes:write');

  // The status filter is now the ONLY thing that can filter this list — a
  // search term takes the reader to `SearchResultsView` and its own two empty
  // states instead of to this one.
  const isFiltered = status !== 'all';

  /**
   * The offered filter's own LABEL for an active `?status=`, or `null`.
   *
   * Read from `NOTE_STATUS_FILTERS` rather than title-casing the raw API value,
   * so the wording stays in the one place that already owns it — the same list
   * `noteStatusFromQuery` validates against.
   */
  const activeStatusLabel = useMemo(() => {
    if (status === 'all') return null;
    return NOTE_STATUS_FILTERS.find((option) => option.value === status)?.label ?? null;
  }, [status]);

  /**
   * Clearing has to clear the URL too, not only the state — `?status=` SEEDS
   * this view, and #168 makes remounts routine. `replace: true` so Back does
   * not reapply the filter the user just dismissed.
   * `TranscriptsLibraryView` carries the long form.
   */
  const clearStatusFilter = useCallback(() => {
    setStatus('all');
    const next = new URLSearchParams(searchParams);
    next.delete('status');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  /**
   * The feed cut into date groups — issue #190.
   *
   * `new Date()` is read HERE and passed down, rather than inside the grouper —
   * one clock reading per render, so every row in one paint is bucketed against
   * the same instant. `TranscriptsLibraryView` carries the long form.
   */
  const dateGroups = useMemo(() => groupFeedByDate(notes, new Date()), [notes]);

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
        {selectionAvailable && !searchMode && (
          <ToggleButton
            value="select"
            size="small"
            selected={selecting}
            aria-pressed={selecting}
            onChange={() => (selecting ? stopSelecting() : setSelecting(true))}
            sx={{ textTransform: 'none', px: 1.5, minHeight: 44, whiteSpace: 'nowrap' }}
          >
            <CheckBoxOutlinedIcon fontSize="small" sx={{ mr: 0.5 }} />
            Select
          </ToggleButton>
        )}
      </Stack>

      {/* ONE SEARCH BOX — see `TranscriptsLibraryView`, which carries the
          argument (#193). The twinning is the point: two library surfaces with
          two different filter bars would make one product feel like two. */}
      {activeStatusLabel && (
        <ActiveStatusFilterChip label={activeStatusLabel} onClear={clearStatusFilter} />
      )}

      {searchMode ? (
        <>
        {/* The `SearchPrefix` slot ABOVE the ranked results: the web edition draws
            knowledge-graph entity hits (#373) here, and they render nothing
            without `graph:read`, with no hits, or on any graph error — library
            search never depends on them. */}
        {SearchPrefix ? (
          <NotesSlotBoundary name="SearchPrefix">
            <SearchPrefix query={search} />
          </NotesSlotBoundary>
        ) : null}
        <SearchResultsView
          type="note"
          query={search}
          search={searchState}
          dense={!isPhone}
          onOpen={(result: SearchResult) => navigate(`/notes/${result.id}`)}
          unappliedStatusFilter={status !== 'all'}
        />
        </>
      ) : (
        <>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Rendered unconditionally — see `FeedCountLine` for why a live region
            must exist before it has anything to say. No search term is passed,
            and there never can be one here: this branch only renders when the
            box is EMPTY (#176 sends a term to `SearchResultsView`, which
            reports its own match count). */}
        <FeedCountLine
          label={isLoading ? '' : feedCountLabel(total, { one: 'note', many: 'notes' })}
        />

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
                  Clear the status filter above to see everything.
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
            {/* ONE flat list with separators among the rows — not a list per
                group. See `FeedDateSeparator` for why nesting would change what
                a screen reader announces for every row in the feed. */}
            {dateGroups.map((group) => (
              <Fragment key={group.key}>
                <FeedDateSeparator label={group.label} />
                {group.items.map((note) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    dense={!isPhone}
                    onOpen={() => navigate(`/notes/${note.id}`)}
                    selection={
                      selectionAvailable
                        ? {
                            selecting,
                            selected: selectedIds.includes(note.id),
                            blocked: !selectedIds.includes(note.id) && selectedIds.length >= selectionLimit,
                            onToggle: () => toggleSelected(note.id),
                            onLongPress: () => {
                              setSelecting(true);
                              setSelectedIds((current) => (current.includes(note.id) ? current : [...current, note.id]));
                            },
                          }
                        : undefined
                    }
                  />
                ))}
              </Fragment>
            ))}
          </Stack>
        )}

        {nextCursor && (
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
            <Button onClick={() => void loadMore()} disabled={isLoadingMore}>
              {isLoadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </Box>
        )}
        {selectionAvailable && selecting && SelectionActions && (
          <Paper
            elevation={4}
            role="region"
            aria-label="Selected notes"
            onKeyDown={(event) => {
              if (event.key === 'Escape') stopSelecting();
            }}
            sx={{
              position: 'sticky',
              // Above the bottom navigation on a phone (the shell pads <main> by 80px there).
              bottom: { xs: 'calc(72px + env(safe-area-inset-bottom))', sm: 16 },
              zIndex: 2,
              mt: 2,
              p: 1.5,
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 1,
            }}
          >
            <Typography variant="body2" role="status" sx={{ flex: '1 1 auto', fontVariantNumeric: 'tabular-nums' }}>
              {selectedIds.length === 0
                ? 'Select notes'
                : selectedIds.length >= selectionLimit
                  ? `${selectedIds.length} selected (the most you can compare)`
                  : `${selectedIds.length} selected`}
            </Typography>
            <NotesSlotBoundary name="SelectionActions">
              <SelectionActions noteIds={selectedIds} onDone={stopSelecting} />
            </NotesSlotBoundary>
            <Button onClick={stopSelecting} sx={{ minHeight: 44 }}>
              Cancel
            </Button>
          </Paper>
        )}
        </>
      )}
    </Box>
  );
}

