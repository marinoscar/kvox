/**
 * Find & replace — issue #31, epic #19.
 *
 * A bottom sheet below `sm` and a side panel above it, over the SAME controls:
 * the two treatments differ in where the box sits, never in what it can do.
 *
 * =============================================================================
 * "REPLACE ALL" IS ONE OP, AND THAT IS THE WHOLE REASON THIS TALKS TO THE API
 * =============================================================================
 *
 * The obvious implementation — find the matches in the segments already loaded,
 * then send one `segment.update_text` per hit — produces the right text and the
 * wrong history: a hundred ops in a batch, or worse a hundred batches, for one
 * thing the user did once. `transcript.find_replace` is a single op that the
 * server expands into concrete text ops before recording, so the version log
 * says "replaced X with Y" once and a restore replays exactly that.
 *
 * The match COUNT comes from the same server matcher for the same reason: a
 * client-side `indexOf` preview would disagree with the replacement it is
 * previewing the moment a whole-word boundary involves a non-ASCII letter.
 *
 * `total` and `matches.length` are deliberately reported separately when they
 * differ. The API caps the returned matches at 500 while keeping `total`
 * exact — understating what a replacement is about to rewrite would be the one
 * unforgivable bug in this panel.
 */

import CloseIcon from '@mui/icons-material/Close';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Drawer from '@mui/material/Drawer';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';

import type { FindQuery } from '../../hooks/useTranscriptSearch';
import type { TranscriptSearchResult } from '../../services/transcriptEditing';
import type { TranscriptSpeaker } from '../../services/transcripts';

export interface FindReplacePanelProps {
  open: boolean;
  query: FindQuery;
  onQueryChange: (query: FindQuery) => void;
  result: TranscriptSearchResult | null;
  isSearching: boolean;
  /** Index into `result.matches`, or -1 when nothing is current. */
  activeIndex: number;
  speakers: readonly TranscriptSpeaker[];
  /** False for a viewer: find still works, replace does not exist. */
  canEdit: boolean;
  onNavigate: (delta: 1 | -1) => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}

/** "3 of 12", or the honest sentence when there is nothing to count. */
export function matchCountLabel(
  result: TranscriptSearchResult | null,
  activeIndex: number,
  isSearching: boolean,
): string {
  if (isSearching) return 'Searching…';
  if (!result) return '';
  if (result.total === 0) return 'No matches';
  const position = activeIndex >= 0 ? activeIndex + 1 : 1;
  const suffix = result.truncated
    ? ` (showing the first ${result.matches.length})`
    : '';
  return `${position} of ${result.total}${suffix}`;
}

function PanelBody({
  query,
  onQueryChange,
  result,
  isSearching,
  activeIndex,
  speakers,
  canEdit,
  onNavigate,
  onReplaceOne,
  onReplaceAll,
  onClose,
}: Omit<FindReplacePanelProps, 'open'>) {
  const set = <K extends keyof FindQuery>(key: K, value: FindQuery[K]) =>
    onQueryChange({ ...query, [key]: value });

  const hasMatches = (result?.total ?? 0) > 0;

  return (
    <Box sx={{ p: 2 }} role="search" aria-label="Find and replace">
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
        <Typography variant="subtitle2" component="h2" sx={{ flexGrow: 1 }}>
          Find {canEdit ? '& replace' : ''}
        </Typography>
        <IconButton size="small" onClick={onClose} aria-label="Close find and replace">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <TextField
        autoFocus
        fullWidth
        size="small"
        label="Find"
        value={query.find}
        onChange={(event) => set('find', event.target.value)}
      />

      {canEdit && (
        <TextField
          fullWidth
          size="small"
          margin="dense"
          label="Replace with"
          value={query.replace}
          onChange={(event) => set('replace', event.target.value)}
        />
      )}

      <Stack direction="row" sx={{ flexWrap: 'wrap' }}>
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={query.matchCase}
              onChange={(event) => set('matchCase', event.target.checked)}
            />
          }
          label="Match case"
        />
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={query.wholeWord}
              onChange={(event) => set('wholeWord', event.target.checked)}
            />
          }
          label="Whole word"
        />
      </Stack>

      <TextField
        select
        fullWidth
        size="small"
        margin="dense"
        label="Limit to speaker"
        value={query.speakerId}
        onChange={(event) => set('speakerId', event.target.value)}
      >
        <MenuItem value="">Every speaker</MenuItem>
        {speakers.map((speaker) => (
          <MenuItem key={speaker.id} value={speaker.id}>
            {speaker.displayName}
          </MenuItem>
        ))}
      </TextField>

      <Box
        sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}
      >
        {/* `role="status"`, because the count changes without the user doing
            anything visible to it — a screen-reader user typing into Find has
            no other way to learn there are now four matches. */}
        <Typography variant="caption" color="text.secondary" role="status" sx={{ flexGrow: 1 }}>
          {matchCountLabel(result, activeIndex, isSearching)}
        </Typography>
        <IconButton
          size="small"
          aria-label="Previous match"
          disabled={!hasMatches}
          onClick={() => onNavigate(-1)}
        >
          <KeyboardArrowUpIcon fontSize="small" />
        </IconButton>
        <IconButton
          size="small"
          aria-label="Next match"
          disabled={!hasMatches}
          onClick={() => onNavigate(1)}
        >
          <KeyboardArrowDownIcon fontSize="small" />
        </IconButton>
      </Box>

      {canEdit && (
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
          <Button size="small" disabled={!hasMatches} onClick={onReplaceOne}>
            Replace
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={!hasMatches}
            onClick={onReplaceAll}
          >
            Replace all
          </Button>
        </Stack>
      )}
    </Box>
  );
}

export function FindReplacePanel(props: FindReplacePanelProps) {
  const { open, onClose, ...rest } = props;
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  if (isCompactWindow) {
    return (
      <Drawer
        anchor="bottom"
        open={open}
        onClose={onClose}
        slotProps={{
          paper: {
            sx: { borderTopLeftRadius: 12, borderTopRightRadius: 12 },
            'aria-label': 'Find and replace',
          },
        }}
      >
        <PanelBody {...rest} onClose={onClose} />
      </Drawer>
    );
  }

  if (!open) return null;

  return (
    <Paper variant="outlined">
      <PanelBody {...rest} onClose={onClose} />
    </Paper>
  );
}

export default FindReplacePanel;
