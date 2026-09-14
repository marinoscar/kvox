/**
 * `/transcripts` — the library. Issue #30, epic #19.
 *
 * =============================================================================
 * TABS ARE CORRECT HERE, AND THIS IS THE ONE CASE THE RULE ALLOWS
 * =============================================================================
 *
 * CLAUDE.md's Settings UI Pattern rule 2 forbids adding a settings page as a
 * tab, and permits tabs only for genuinely PARALLEL content — two views of the
 * same question. "Mine" and "Shared with me" are exactly that: one question
 * ("which transcripts can I open?"), one endpoint, one row shape, and the only
 * difference between them is a `scope` query parameter the API already models
 * as a filter. They are not a hierarchy, and neither is reachable "inside" the
 * other. The counter-example the rule was written about —
 * `SystemSettingsPage`'s three tabs — was hierarchical content wearing a tab
 * strip; this is not that.
 *
 * (This is also not a settings surface at all, so the registry rules do not
 * reach it. `config/destinations.ts` is what declares it, and the AppBar's
 * drill-down table is what handles its children.)
 *
 * =============================================================================
 * TWO DENSITIES, ONE LIST
 * =============================================================================
 *
 * A phone gets cards with the metadata stacked, and a FAB for the primary
 * action; `sm` and up get a denser row with the same facts on one line. The
 * DATA is identical — this is a layout decision, not a content one — so a
 * transcript never says one thing on a phone and another on a laptop.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import CircularProgress from '@mui/material/CircularProgress';
import Fab from '@mui/material/Fab';
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
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { TranscriptStatusChip } from '../components/transcripts/TranscriptStatusChip';
import { usePermissions } from '../hooks/usePermissions';
import { useTranscripts } from '../hooks/useTranscripts';
import type { TranscriptListItem, TranscriptStatus } from '../services/transcripts';
import { formatDuration } from '../utils/playbackIntervals';
import { formatRelativeTime } from '../utils/relativeTime';
import { TRANSCRIPT_STATUS_FILTERS } from './transcriptsLibraryFilters';

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
}: {
  transcript: TranscriptListItem;
  dense: boolean;
  onOpen: () => void;
}) {
  const meta = [
    formatRelativeTime(transcript.createdAt),
    formatDuration(transcript.durationMs),
    `${transcript.speakerCount} ${transcript.speakerCount === 1 ? 'speaker' : 'speakers'}`,
  ].join(' · ');

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
          // Without this the action area's content can report a wider
          // min-content width than the column it sits in and push the page
          // sideways — the same reason the shell sets `minWidth: 0` all the
          // way down.
          minWidth: 0,
        }}
      >
        <Box sx={{ flexGrow: 1, minWidth: 0, width: '100%' }}>
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
    </Card>
  );
}

export function TranscriptsLibraryPage() {
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

  const { transcripts, isLoading, error, nextCursor, isLoadingMore, loadMore } =
    useTranscripts(tab, {
      q: debouncedSearch,
      status: status === 'all' ? undefined : status,
    });

  const canCreate = hasPermission('transcripts:write');

  const isFiltered = useMemo(
    () => debouncedSearch.trim().length > 0 || status !== 'all',
    [debouncedSearch, status],
  );

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
          Transcripts
        </Typography>
        {/* The FAB is the phone's primary action; at `sm` and up the same
            action is an ordinary button in the header, where there is room for
            it and where a floating control would only cover content. */}
        {canCreate && !isPhone && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => navigate('/transcripts/new')}
          >
            New transcript
          </Button>
        )}
      </Box>

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
              onOpen={() => navigate(`/transcripts/${transcript.id}`)}
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

      {canCreate && isPhone && (
        <Fab
          color="primary"
          aria-label="New transcript"
          onClick={() => navigate('/transcripts/new')}
          sx={{
            position: 'fixed',
            right: 16,
            // Clears the bottom bar, which exists only below `sm` — and this
            // component only renders below `sm`, so the offset is
            // unconditional. Same derived relationship to `BottomNav`'s gate
            // that `TranscriptPlayer`'s mini dock documents at length.
            bottom: 'calc(72px + env(safe-area-inset-bottom))',
          }}
        >
          <AddIcon />
        </Fab>
      )}
    </Box>
  );
}

export default TranscriptsLibraryPage;
