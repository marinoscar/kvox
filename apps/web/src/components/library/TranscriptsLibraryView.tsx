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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { TranscriptRowActions } from './TranscriptRowActions';
import { TranscriptStatusChip } from '../transcripts/TranscriptStatusChip';
import { useLibraryAudioPreview } from '../../hooks/useLibraryAudioPreview';
import type { AudioPreviewState } from '../../hooks/useLibraryAudioPreview';
import { usePermissions } from '../../hooks/usePermissions';
import { useTranscripts } from '../../hooks/useTranscripts';
import type { TranscriptListItem, TranscriptStatus } from '../../services/transcripts';
import { formatDuration } from '../../utils/playbackIntervals';
import { formatRelativeTime } from '../../utils/relativeTime';
import { TRANSCRIPT_STATUS_FILTERS } from '../../pages/transcriptsLibraryFilters';

type ScopeTab = 'owned' | 'shared';

/**
 * How long the search box waits before asking the API.
 *
 * The list is cursor-paginated over a text filter, so every keystroke is a
 * query against a `LIKE` on a column the database is also ordering by. 300 ms
 * is the usual "finished typing a word" threshold; the hook additionally drops
 * out-of-order responses, so a slow request for a prefix cannot overwrite a
 * fast one for the full term.
 */
const SEARCH_DEBOUNCE_MS = 300;

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

  const [tab, setTab] = useState<ScopeTab>('owned');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState<TranscriptStatus | 'all'>('all');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const { transcripts, isLoading, error, nextCursor, isLoadingMore, loadMore, refresh } =
    useTranscripts(tab, {
      q: debouncedSearch,
      status: status === 'all' ? undefined : status,
    });

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

  const isFiltered = useMemo(
    () => debouncedSearch.trim().length > 0 || status !== 'all',
    [debouncedSearch, status],
  );

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
        <TextField
          size="small"
          label="Search titles"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          sx={{ flexGrow: 1 }}
        />
        <FormControl size="small" sx={{ minWidth: 180 }}>
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

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

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
                Try a different search term, or set the status filter back to Any.
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
          {transcripts.map((transcript) => (
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
        </Stack>
      )}

      {nextCursor && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Button onClick={() => void loadMore()} disabled={isLoadingMore}>
            {isLoadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </Box>
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
