/**
 * The body of `/transcripts`. Issue #30, epic #19; moved here by #57 and given
 * back its own page by #106.
 *
 * =============================================================================
 * THIS FILE IS #30's PAGE BODY, UNCHANGED, MINUS ITS CHROME
 * =============================================================================
 *
 * The `<h1>` and the primary action live in
 * `components/library/LibraryPageFrame.tsx`, which `pages/TranscriptsPage.tsx`
 * wraps this in — the frame is shared with `NotesPage` because the header
 * genuinely is the same header. Everything else about this view is what #30
 * shipped: the scope tabs, the debounced search, the status filter, the three
 * empty states, the two densities and the cursor paging.
 *
 * ⚠ THE HEADING ABOVE THIS VIEW NOW NAMES IT. Between #57 and #106 the page's
 * one `h1` read "Library" and this was its Transcripts tab; since #106 it reads
 * "Transcripts", because the tab strip is gone and the page IS this view. That
 * changes nothing here — the rows are still `h2`, and the reason is the same
 * one stated at the row itself — but it is why the old "the page is the library
 * and Transcripts is only half of it" reasoning no longer appears anywhere.
 *
 * =============================================================================
 * ITS OWN TABS ARE STILL CORRECT, AND THEY ARE NOW THE ONLY PAIR
 * =============================================================================
 *
 * CLAUDE.md's Settings UI Pattern rule 2 permits tabs for genuinely PARALLEL
 * content — two views of the same question. "Mine" and "Shared with me" are
 * exactly that: one question ("which transcripts can I open?"), one endpoint,
 * one row shape, and the only difference between them is a `scope` query
 * parameter the API already models as a filter. #106 deleted the Transcripts |
 * Notes strip that used to sit above them and left this pair untouched, which
 * is the distinction working rather than a half-finished removal: that strip
 * was a hierarchy wearing a tab strip (one row in the bottom bar fronting two
 * whole subtrees), and this one is two views of one question.
 *
 * =============================================================================
 * TWO DENSITIES, ONE LIST
 * =============================================================================
 *
 * A phone gets cards with the metadata stacked; `sm` and up get a denser row
 * with the same facts on one line. The DATA is identical — this is a layout
 * decision, not a content one — so a transcript never says one thing on a phone
 * and another on a laptop.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import visuallyHidden from '@mui/utils/visuallyHidden';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { FeedCountLine } from './FeedCountLine';
import { FeedDateSeparator } from './FeedDateSeparator';
import { TranscriptRowActions } from './TranscriptRowActions';
import { SearchResultsView } from '../search/SearchResultsView';
import { TranscriptStatusChip } from '../transcripts/TranscriptStatusChip';
import { useLibraryAudioPreview } from '../../hooks/useLibraryAudioPreview';
import type { AudioPreviewState } from '../../hooks/useLibraryAudioPreview';
import { usePermissions } from '../../hooks/usePermissions';
import { useSearch } from '../../hooks/useSearch';
import { useTranscripts } from '../../hooks/useTranscripts';
import { useScrollRestoration } from '../../hooks/useScrollRestoration';
import { feedCountLabel, groupFeedByDate } from '../../utils/feedDateGroups';
import { feedCacheKey } from '../../utils/feedCache';
import type { SearchResult, SearchType } from '../../services/search';
import type { TranscriptListItem, TranscriptStatus } from '../../services/transcripts';
import { formatDuration } from '../../utils/playbackIntervals';
import { formatRelativeTime } from '../../utils/relativeTime';
import {
  TRANSCRIPT_STATUS_FILTERS,
  searchFromQuery,
  transcriptScopeFromQuery,
  transcriptStatusFromQuery,
} from '../../pages/transcriptsLibraryFilters';
import type { TranscriptScopeFilter } from '../../pages/transcriptsLibraryFilters';

/**
 * The two scope tabs. Named by `transcriptsLibraryFilters.ts` rather than here,
 * because `?scope=` seeds it and a second spelling of the pair would be a URL
 * this view accepts and a tab it cannot select.
 */
type ScopeTab = TranscriptScopeFilter;

/**
 * ⚠ THE DEBOUNCE MOVED INTO THE HOOK — issue #176, epic #164.
 *
 * This view used to hold a `debouncedSearch` state and a 300 ms timer, because
 * the box fed `GET /api/transcripts?q=`, whose hook takes an already-settled
 * term. The box now feeds `useSearch`, which debounces internally AND aborts
 * the superseded request — see its header for why those are two separate jobs.
 *
 * Keeping a second timer here would debounce a debounce: 300 ms of nothing,
 * then 300 ms more before the request, and a box that felt broken on a slow
 * connection. So there is deliberately no timer in this file any more, and
 * `search` — the raw box value — is what everything below reads.
 */

/**
 * What this view asks `GET /api/search` for — issue #176, epic #164.
 *
 * ONE type, its own. The endpoint can search both, and the Notes library passes
 * `['note']` from its own copy of this constant; neither page borrows the
 * other's rows, because a page titled "Transcripts" that returned notes would
 * be answering a question nobody asked it.
 *
 * Module-level rather than inline so its identity is stable: `useSearch`
 * derives its effect's dependency from the list, and a fresh array on every
 * render would re-issue the search on every keystroke in any other control.
 */
const SEARCH_TYPES: SearchType[] = ['transcript'];

function TranscriptRow({
  transcript,
  dense,
  onOpen,
  previewState,
  previewError,
  onTogglePreview,
  onChanged,
}: {
  transcript: TranscriptListItem;
  dense: boolean;
  onOpen: () => void;
  /** What the list's ONE audio element is doing for this row. */
  previewState: AudioPreviewState;
  /** The preview's last failure, when it was this row's. */
  previewError: string | null;
  onTogglePreview: () => void;
  onChanged: () => void;
}) {
  const meta = [
    formatRelativeTime(transcript.createdAt),
    formatDuration(transcript.durationMs),
    `${transcript.speakerCount} ${transcript.speakerCount === 1 ? 'speaker' : 'speakers'}`,
  ].join(' · ');

  return (
    <Card variant="outlined" component="li" sx={{ listStyle: 'none' }}>
      {/* TWO SIBLINGS, NOT ONE ACTION AREA. The card body opens the transcript
          and the cluster acts on it, and neither may contain the other: a
          button inside a button is invalid HTML, fails axe, and leaves a
          keyboard user tabbing to a control their screen reader has just
          described as part of something else. See `TranscriptRowActions`. */}
      <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
        <CardActionArea
          onClick={onOpen}
          sx={{
            p: dense ? 1.25 : 2,
            display: 'flex',
            alignItems: dense ? 'center' : 'flex-start',
            flexDirection: dense ? 'row' : 'column',
            gap: dense ? 2 : 0.75,
            // Without this the action area's content can report a wider
            // min-content width than the column it sits in and push the page
            // sideways — the same reason the shell sets `minWidth: 0` all the
            // way down. It is now doing that job for a flex ITEM as well as a
            // flex container, which is what keeps the cluster on the card at
            // 360px instead of the title shoving it off the edge.
            minWidth: 0,
            flexGrow: 1,
          }}
        >
          <Box sx={{ flexGrow: 1, minWidth: 0, width: '100%' }}>
            {/* `h2`: the page's one `h1` is "Transcripts" (#106 — it read
                "Library" while this view was a tab) and there is still no
                heading between it and this row — the scope strip is a
                `tablist`, not a heading — so `h3` here would skip a level.
                Asserted by the axe pass in `TranscriptsPage.test.tsx`, which is
                where that gets caught. */}
            <Typography variant="subtitle1" component="h2" noWrap sx={{ fontWeight: 600 }}>
              {transcript.title}
            </Typography>
            <Typography variant="caption" color="text.secondary" component="p">
              {meta}
            </Typography>
          </Box>
          <Box sx={{ flexShrink: 0 }}>
            {/* The stage is only shown while something is moving — see
                `TranscriptStatusChip`'s own note on why a settled list does not
                want forty chips carrying a redundant second clause. */}
            <TranscriptStatusChip transcript={transcript} showStage />
          </Box>
        </CardActionArea>
        <TranscriptRowActions
          transcript={transcript}
          dense={dense}
          previewState={previewState}
          onTogglePreview={onTogglePreview}
          onOpen={onOpen}
          onChanged={onChanged}
        />
      </Box>
      {/* On the row it happened to, not in a banner above the list: a message
          about a recording the reader would then have to go and find is a
          message about nothing they can act on.

          NOT a live region of its own. It is announced through the list's one
          standing region instead — a `role="status"` element that is inserted
          at the same moment as the text inside it is announced by some screen
          readers and silently ignored by others, and this row has a persistent
          region a few lines below it that has neither problem. */}
      {previewError ? (
        <Box sx={{ px: dense ? 1.25 : 2, pb: dense ? 1 : 1.5 }}>
          <Typography variant="caption" color="error" component="p">
            {previewError}
          </Typography>
        </Box>
      ) : null}
    </Card>
  );
}

export function TranscriptsLibraryView() {
  const theme = useTheme();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));

  /**
   * THE URL SEEDS THIS VIEW, ONCE, AND NOTHING WRITES BACK TO IT.
   *
   * `/transcripts?scope=shared&status=failed&q=budget` is a deep link — the
   * home page's counts strip (#170) is the first thing that builds one — and
   * every parameter below is read in a LAZY INITIALISER, so it applies on mount
   * and never again. A subsequent tab click, filter change or keystroke updates
   * component state alone.
   *
   * Full two-way sync was considered and rejected; the argument is in
   * `transcriptsLibraryFilters.ts` beside the parsers.
   *
   * ⚠ `?q=` NOW SEEDS A SEARCH, not a list filter (#176), and there is no
   * second `debouncedSearch` state to seed alongside it. The flash that state
   * existed to prevent — an unfiltered list rendered and then replaced 300 ms
   * later — cannot happen through this path any more: a non-empty box puts the
   * view in search mode on the FIRST render, and `useSearch` raises its loading
   * flag synchronously, so the 300 ms before the request is a spinner rather
   * than an answer to a question the link did not ask.
   */
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<ScopeTab>(() => transcriptScopeFromQuery(searchParams));
  const [search, setSearch] = useState(() => searchFromQuery(searchParams));
  const [status, setStatus] = useState<TranscriptStatus | 'all'>(() =>
    transcriptStatusFromQuery(searchParams),
  );

  /**
   * Where this feed's loaded pages and its scroll offset live across a
   * drill-down — issue #168.
   *
   * EVERY ACTIVE FILTER IS IN THE KEY, the scope tab included. A key that
   * ignored the tab would replay "Mine" under "Shared with me"; one that
   * ignored the search term would replay a previous search's results under a
   * new one. Keying on all three makes a filter change a cache MISS, which
   * correctly starts the list over, and gives each filter its own remembered
   * scroll position for free.
   *
   * ⚠ THE DEBOUNCED TERM, NOT THE RAW INPUT. Keying on every keystroke would
   * mint (and immediately evict) an entry per character, which is both a
   * pointless cost and a good way to push the entry the user is coming back to
   * out of a bounded cache.
   */
  /**
   * IS THE BOX ASKING A SEARCH QUESTION? — issue #176, epic #164.
   *
   * A non-empty box renders `GET /api/search` — relevance-ordered, with
   * snippets saying WHY each result matched — instead of the newest-first list
   * filtered by a title substring. An empty box renders the list exactly as it
   * did before this issue.
   *
   * ⚠ Deliberately `.length > 0` rather than `.trim().length > 0`. A box
   * holding only spaces IS a search question the user has begun to ask — it is
   * just not one that can be answered yet — and `SearchResultsView` renders
   * "Type to search" for it. Trimming here would drop that user back onto an
   * unfiltered list, which says nothing about what they typed and looks like
   * the app ignoring them.
   *
   * ⚠ THE RAW VALUE, not a debounced one. The switch has to be immediate: the
   * moment the box has content, what is on screen must be about the search, and
   * `useSearch` is already loading. A debounced switch would leave the
   * PREVIOUS source rendered for 300 ms after every change — including the
   * unfiltered list sitting under a just-cleared box's last query.
   */
  const searchMode = search.length > 0;

  /**
   * ⚠ THE LIST IS NEVER ASKED A TEXT FILTER ANY MORE (#176).
   *
   * `GET /api/transcripts?q=` is untouched and still does exactly what it did;
   * this view simply stops being the thing that calls it with a term, because a
   * term now goes to the search endpoint instead. Since the list is rendered
   * ONLY when the box is empty, the request it issues is the one it issued for
   * an empty box before this issue — so the empty-box path is unchanged, and
   * search mode no longer pays for a filtered query nobody reads.
   *
   * The cache key (#168) loses its search component for the same reason: it
   * still carries every filter that can actually vary while this list is on
   * screen, which is now the scope tab and the status.
   */
  const cacheKey = useMemo(
    () => feedCacheKey('transcripts', [tab, status]),
    [status, tab],
  );

  // The other half of the drill-down, and the reason this page reuses the hook
  // the settings hub already uses rather than growing a second implementation:
  // it already handles the restore deadline, the `sessionStorage` namespacing,
  // and the rule that a real gesture wins outright. Called UNCONDITIONALLY and
  // outside any branch, per the rules of hooks. Because the key carries the
  // filters, switching the scope tab writes the old tab's offset under the old
  // key and restores the new tab's — which is exactly the behaviour you want.
  useScrollRestoration(cacheKey);

  const { transcripts, total, isLoading, error, nextCursor, isLoadingMore, loadMore, refresh } =
    useTranscripts(tab, {
      status: status === 'all' ? undefined : status,
      cacheKey,
    });

  /**
   * The other source this view can show — issue #176.
   *
   * Called UNCONDITIONALLY and outside any branch, per the rules of hooks. It
   * is inert while the box is empty: `useSearch` treats a blank query as NO
   * SEARCH rather than as a search for nothing, and issues no request at all.
   * The debounce and the abort-on-keystroke both live inside it, which is why
   * it is handed the raw box value rather than the debounced one.
   */
  const searchState = useSearch({ q: search, types: SEARCH_TYPES });

  /**
   * ONE audio element for the whole list — see the hook for why that is a
   * structure rather than a rule, and why nothing is fetched until a press.
   * It lives here, above the rows, because it is the list that owns the
   * "exactly one at a time" guarantee.
   */
  const preview = useLibraryAudioPreview();

  /**
   * A row that leaves the list takes its playback with it.
   *
   * Filtering, searching, switching scope tabs or deleting the row all remove
   * it from `transcripts` while the shared element happily keeps playing — with
   * no pause control anywhere on screen, because the only one was on the row
   * that just disappeared. Guarded on `isLoading`, since the list is
   * momentarily empty during every refetch and stopping on THAT would make a
   * search keystroke cut the audio off.
   */
  useEffect(() => {
    if (isLoading || !preview.activeId) return;
    if (transcripts.some((item) => item.id === preview.activeId)) return;
    preview.stop();
  }, [isLoading, preview, transcripts]);

  /**
   * Entering search mode stops playback, for the reason the effect above exists.
   *
   * The Play/Pause control lives on a LIST row, and the list is not rendered
   * while results are — so a recording started from the list and left playing
   * would keep playing with no control anywhere on screen to stop it. The
   * effect above cannot catch this: the rows it checks are still loaded and
   * still contain the playing transcript; they are simply not on screen.
   */
  useEffect(() => {
    if (searchMode && preview.activeId) preview.stop();
  }, [preview, searchMode]);

  /**
   * What the list's one live region says — playback state AND failures.
   *
   * Both go through here rather than each row announcing for itself, because a
   * region that is inserted at the same moment as its own content is announced
   * inconsistently across screen readers, while this one is mounted for the
   * life of the list. It is empty between states, so what a reader hears is the
   * transition rather than the same sentence read twice.
   *
   * The Play button's own name already flips between Play and Pause, but a name
   * is only announced when the control is touched — this is what tells somebody
   * who pressed Play and moved on that the recording actually started, or that
   * it did not.
   *
   * Every message names its transcript: one list, one player, forty rows, and
   * "Playing" on its own answers the wrong question.
   */
  const announcement = useMemo(() => {
    const titleOf = (transcriptId: string): string | null =>
      transcripts.find((item) => item.id === transcriptId)?.title ?? null;

    if (preview.error) {
      const title = titleOf(preview.error.transcriptId);
      return title ? `"${title}": ${preview.error.message}` : preview.error.message;
    }
    if (!preview.activeId) return '';
    const title = titleOf(preview.activeId);
    if (!title) return '';
    if (preview.status === 'playing') return `Playing "${title}"`;
    if (preview.status === 'paused') return `Paused "${title}"`;
    return '';
  }, [preview.activeId, preview.error, preview.status, transcripts]);

  const openTranscript = useCallback(
    (transcriptId: string) => navigate(`/transcripts/${transcriptId}`),
    [navigate],
  );

  const canCreate = hasPermission('transcripts:write');

  // The status filter is now the ONLY thing that can filter this list — a
  // search term takes the reader to `SearchResultsView` and its own two empty
  // states instead of to this one.
  const isFiltered = status !== 'all';

  /**
   * The feed cut into date groups — issue #190.
   *
   * `new Date()` is read HERE and passed down, rather than inside the grouper.
   * One clock reading per render means every row in one paint is bucketed
   * against the same instant; a grouper calling `Date.now()` per row could put
   * two rows a microsecond apart in different groups across a midnight, which
   * is a heading that appears for one row and a bug nobody would reproduce.
   */
  const dateGroups = useMemo(() => groupFeedByDate(transcripts, new Date()), [transcripts]);

  return (
    <Box>
      <Tabs
        value={tab}
        onChange={(_, value: ScopeTab) => setTab(value)}
        aria-label="Transcript scope"
        sx={{ mb: 2 }}
      >
        <Tab value="owned" label="Mine" />
        <Tab value="shared" label="Shared with me" />
      </Tabs>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
        {/* THE LABEL CHANGED WITH THE BEHAVIOUR (#176). It read "Search
            titles" while this box filtered the list by a title substring; it
            now runs a full-text search over the recordings themselves, and a
            label still promising titles would be describing the old feature. */}
        <TextField
          size="small"
          label="Search transcripts"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          sx={{ flexGrow: 1 }}
        />
        {/* DISABLED WHILE SEARCHING, because `GET /api/search` has no status
            parameter. Filtering the ranked page client-side instead would make
            the count above it disagree with the rows below it — twenty fetched,
            four shown, "the top 200 matches" over them — and a control that
            silently does nothing is worse than one that visibly cannot. */}
        <FormControl size="small" sx={{ minWidth: 180 }} disabled={searchMode}>
          <InputLabel id="transcript-status-filter">Status</InputLabel>
          <Select
            labelId="transcript-status-filter"
            label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value as TranscriptStatus | 'all')}
          >
            {TRANSCRIPT_STATUS_FILTERS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {searchMode ? (
        <SearchResultsView
          type="transcript"
          query={search}
          search={searchState}
          dense={!isPhone}
          onOpen={(result: SearchResult) => openTranscript(result.id)}
          unappliedStatusFilter={status !== 'all'}
        />
      ) : (
        <>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Rendered unconditionally — see `FeedCountLine` for why a live region
            must exist before it has anything to say. Empty while the first page
            is in flight, so it never announces at a reader who is simply
            waiting.

            No search term is passed, and there never can be one here: this
            branch only renders when the box is EMPTY (#176 sends a term to
            `SearchResultsView`, which reports its own match count). */}
        <FeedCountLine
          label={
            isLoading ? '' : feedCountLabel(total, { one: 'transcript', many: 'transcripts' })
          }
        />

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress aria-label="Loading transcripts" />
          </Box>
        ) : transcripts.length === 0 ? (
          <Paper variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
            {/* TWO EMPTY STATES, because they need different things from the
                reader. A filter that matched nothing is fixed by changing the
                filter; an empty library is fixed by making a transcript, and
                offering "clear your filters" there would be nonsense. */}
            {isFiltered ? (
              <>
                <Typography variant="h6" component="h2" gutterBottom>
                  No transcripts match those filters
                </Typography>
                <Typography color="text.secondary">
                  Set the status filter back to Any to see everything.
                </Typography>
              </>
            ) : tab === 'shared' ? (
              <>
                <Typography variant="h6" component="h2" gutterBottom>
                  Nothing has been shared with you yet
                </Typography>
                <Typography color="text.secondary">
                  Transcripts other people share with you will appear here.
                </Typography>
              </>
            ) : (
              <>
                <Typography variant="h6" component="h2" gutterBottom>
                  No transcripts yet
                </Typography>
                <Typography color="text.secondary" sx={{ mb: 3 }}>
                  Upload a recording and we will transcribe it, work out who is
                  speaking, and let you read and correct it.
                </Typography>
                {canCreate && (
                  <Button
                    variant="contained"
                    startIcon={<AddIcon />}
                    onClick={() => navigate('/transcripts/new')}
                  >
                    New transcript
                  </Button>
                )}
              </>
            )}
          </Paper>
        ) : (
          <Stack component="ul" spacing={1} sx={{ p: 0, m: 0 }}>
            {/* ONE flat list with separators among the rows — not a list per
                group. See `FeedDateSeparator` for why nesting would change what
                a screen reader announces for all 300 rows. */}
            {dateGroups.map((group) => (
              <Fragment key={group.key}>
                <FeedDateSeparator label={group.label} />
                {group.items.map((transcript) => (
              <TranscriptRow
                key={transcript.id}
                transcript={transcript}
                dense={!isPhone}
                onOpen={() => openTranscript(transcript.id)}
                previewState={
                  preview.activeId === transcript.id ? preview.status : 'idle'
                }
                previewError={
                  preview.error?.transcriptId === transcript.id
                    ? preview.error.message
                    : null
                }
                onTogglePreview={() => preview.toggle(transcript.id)}
                onChanged={() => void refresh()}
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
        </>
      )}

      {/* ONE live region for the whole list rather than one per row: the
          guarantee this list makes is that a single recording plays at a time,
          so there is only ever one thing to announce, and fifty regions would
          be fifty things a screen reader has to keep watching. Rendered
          unconditionally — see `announcement` for why it has to exist before it
          has anything to say. */}
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {announcement}
      </Box>
    </Box>
  );
}

export default TranscriptsLibraryView;
