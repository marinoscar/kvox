/**
 * "Fix names with AI" — the review panel (issues #329 and #330, epic #326).
 *
 * A bottom sheet below `sm` and a side panel above it — the exact treatment
 * `FindReplacePanel` uses, read from the same page-level `down('sm')` query
 * (this is where ONE page puts ONE panel, not a piece of app chrome, so it is
 * not a sixth breakpoint gate; see CLAUDE.md's Settings UI Pattern rule 5).
 *
 * Everything shown comes from `GET /name-checks/latest`, via `useNameCheck`:
 *
 *   no run            an invitation to start one
 *   pending/running   progress, and the reassurance that editing is still fine
 *   failed            the reason, and a way to try again
 *   ready, nothing    "No likely misspellings found"
 *   ready, something  suggestions GROUPED by `original → replacement`
 *
 * WHY GROUPED. The same mis-hearing recurs: "Skar" for "Oscar" twelve times in
 * one meeting. Reviewing twelve identical rows one at a time is the kind of
 * chore that makes people click "Accept all" without reading; a group header
 * that says "Skar → Oscar ×12" makes that decision ONE honest decision, and
 * the rows stay underneath for the one occurrence that really was "scar".
 * The key is case-insensitive so "skar"/"Skar" do not split one mistake into
 * two groups.
 *
 * A STALE row (its line was edited since the check ran and the span could not
 * be relocated) cannot be accepted — the server would skip it anyway — so its
 * Accept is disabled and the reason is written out rather than implied.
 */

import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import GpsFixedIcon from '@mui/icons-material/GpsFixed';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useMemo } from 'react';
import type { ReactNode } from 'react';

import type { LatestNameCheck, NameSuggestion } from '../../services/transcriptNameChecks';
import { formatTimestamp } from '../../utils/playbackIntervals';

export const NAME_PANEL_HEADING_ID = 'name-suggestions-heading';

export interface NameSuggestionGroup {
  key: string;
  original: string;
  replacement: string;
  suggestions: NameSuggestion[];
  /** The ids a group-level Accept may send: every non-stale row. */
  acceptableIds: string[];
}

/** Group by `original → replacement`, case-insensitively, in first-seen order. */
export function groupNameSuggestions(
  suggestions: readonly NameSuggestion[],
): NameSuggestionGroup[] {
  const groups = new Map<string, NameSuggestionGroup>();
  for (const suggestion of suggestions) {
    const key = `${suggestion.original.toLowerCase()}→${suggestion.replacement.toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        original: suggestion.original,
        replacement: suggestion.replacement,
        suggestions: [],
        acceptableIds: [],
      };
      groups.set(key, group);
    }
    group.suggestions.push(suggestion);
    if (!suggestion.stale) group.acceptableIds.push(suggestion.id);
  }
  return [...groups.values()];
}

export interface NameSuggestionsPanelProps {
  open: boolean;
  latest: LatestNameCheck | null;
  isLoading: boolean;
  loadError: string | null;
  /** An apply or reject is in flight — every decision control waits. */
  busy: boolean;
  onAccept: (suggestionIds: string[]) => void;
  onReject: (suggestionIds: string[]) => void;
  onJump: (suggestion: NameSuggestion) => void;
  /** Open the start dialog — for "no run yet" and "failed, try again". */
  onStartNew: () => void;
  onClose: () => void;
}

/** The preview with the mis-heard span marked, so the reader sees WHAT changes. */
function PreviewText({ suggestion }: { suggestion: NameSuggestion }) {
  const { preview, original } = suggestion;
  let index = preview.indexOf(original);
  if (index < 0) index = preview.toLowerCase().indexOf(original.toLowerCase());
  if (index < 0) {
    return <>{preview}</>;
  }
  return (
    <>
      {preview.slice(0, index)}
      <Box
        component="mark"
        sx={{
          bgcolor: 'warning.light',
          color: 'warning.contrastText',
          textDecoration: 'line-through',
          borderRadius: 0.5,
          px: 0.25,
        }}
      >
        {preview.slice(index, index + original.length)}
      </Box>
      <Box component="span" sx={{ fontWeight: 600, color: 'success.main', px: 0.25 }}>
        {suggestion.replacement}
      </Box>
      {preview.slice(index + original.length)}
    </>
  );
}

function SuggestionRow({
  suggestion,
  busy,
  onAccept,
  onReject,
  onJump,
}: {
  suggestion: NameSuggestion;
  busy: boolean;
  onAccept: (ids: string[]) => void;
  onReject: (ids: string[]) => void;
  onJump: (suggestion: NameSuggestion) => void;
}) {
  const at = formatTimestamp(suggestion.startMs);
  const confidence =
    suggestion.confidence !== null ? `${Math.round(suggestion.confidence * 100)}% sure` : null;

  return (
    <Box
      component="li"
      data-testid={`name-suggestion-${suggestion.id}`}
      aria-disabled={suggestion.stale || undefined}
      sx={{
        listStyle: 'none',
        py: 1,
        display: 'flex',
        gap: 1,
        alignItems: 'flex-start',
        opacity: suggestion.stale ? 0.6 : 1,
      }}
    >
      <Tooltip title="Go to this line">
        <IconButton
          size="small"
          aria-label={`Go to ${at}`}
          onClick={() => onJump(suggestion)}
        >
          <GpsFixedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
          <PreviewText suggestion={suggestion} />
        </Typography>
        <Typography variant="caption" color="text.secondary" component="div">
          {suggestion.stale
            ? 'Text changed since the check'
            : [at, confidence, suggestion.reason].filter(Boolean).join(' · ')}
        </Typography>
      </Box>
      <IconButton
        size="small"
        color="success"
        disabled={busy || suggestion.stale}
        aria-label={`Accept "${suggestion.replacement}" at ${at}`}
        onClick={() => onAccept([suggestion.id])}
      >
        <CheckIcon fontSize="small" />
      </IconButton>
      <IconButton
        size="small"
        disabled={busy}
        aria-label={`Reject "${suggestion.replacement}" at ${at}`}
        onClick={() => onReject([suggestion.id])}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
    </Box>
  );
}

function PanelBody({
  latest,
  isLoading,
  loadError,
  busy,
  onAccept,
  onReject,
  onJump,
  onStartNew,
  onClose,
}: Omit<NameSuggestionsPanelProps, 'open'>) {
  const run = latest?.run ?? null;
  const suggestions = useMemo(() => latest?.suggestions ?? [], [latest?.suggestions]);
  const groups = useMemo(() => groupNameSuggestions(suggestions), [suggestions]);
  const acceptable = groups.flatMap((group) => group.acceptableIds);

  let content: ReactNode;
  if (!latest && isLoading) {
    content = <LinearProgress aria-label="Loading name suggestions" />;
  } else if (loadError && !latest) {
    content = <Alert severity="error">{loadError}</Alert>;
  } else if (!run) {
    content = (
      <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
        <Typography variant="body2" color="text.secondary">
          No name check has been run on this transcript yet.
        </Typography>
        <Button size="small" variant="contained" onClick={onStartNew}>
          Check names
        </Button>
      </Stack>
    );
  } else if (run.status === 'pending' || run.status === 'running') {
    content = (
      <Stack spacing={1}>
        <LinearProgress aria-label="Checking for misheard names" />
        <Typography variant="body2">Checking for misheard names…</Typography>
        <Typography variant="caption" color="text.secondary">
          You can keep editing; results appear here.
        </Typography>
      </Stack>
    );
  } else if (run.status === 'failed') {
    content = (
      <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
        <Alert severity="error" sx={{ width: '100%' }}>
          {run.error ?? 'The name check did not finish.'}
        </Alert>
        <Button size="small" onClick={onStartNew}>
          Try again
        </Button>
      </Stack>
    );
  } else if (suggestions.length === 0) {
    const decided = (latest?.counts.accepted ?? 0) + (latest?.counts.rejected ?? 0);
    content = (
      <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
        <Typography variant="body2">
          {decided > 0 ? 'All suggestions reviewed.' : 'No likely misspellings found.'}
        </Typography>
        <Button size="small" onClick={onStartNew}>
          Run another check
        </Button>
      </Stack>
    );
  } else {
    content = (
      <>
        <Box
          component="ul"
          aria-label="Name suggestions"
          sx={{ m: 0, p: 0, maxHeight: { xs: '50vh', sm: '55vh' }, overflowY: 'auto' }}
        >
          {groups.map((group, index) => (
            <Box component="li" key={group.key} sx={{ listStyle: 'none' }}>
              {index > 0 && <Divider sx={{ my: 1 }} />}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography
                  variant="subtitle2"
                  component="h3"
                  sx={{ flexGrow: 1, minWidth: 0 }}
                >
                  {group.original} → {group.replacement}{' '}
                  <Typography component="span" variant="body2" color="text.secondary">
                    ×{group.suggestions.length}
                  </Typography>
                </Typography>
                <Button
                  size="small"
                  disabled={busy || group.acceptableIds.length === 0}
                  aria-label={`Accept all "${group.original}" → "${group.replacement}"`}
                  onClick={() => onAccept(group.acceptableIds)}
                >
                  Accept all
                </Button>
                <Button
                  size="small"
                  color="inherit"
                  disabled={busy}
                  aria-label={`Reject all "${group.original}" → "${group.replacement}"`}
                  onClick={() => onReject(group.suggestions.map((item) => item.id))}
                >
                  Reject all
                </Button>
              </Box>
              <Box component="ul" sx={{ m: 0, p: 0 }}>
                {group.suggestions.map((suggestion) => (
                  <SuggestionRow
                    key={suggestion.id}
                    suggestion={suggestion}
                    busy={busy}
                    onAccept={onAccept}
                    onReject={onReject}
                    onJump={onJump}
                  />
                ))}
              </Box>
            </Box>
          ))}
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
          <Button
            variant="contained"
            size="small"
            disabled={busy || acceptable.length === 0}
            onClick={() => onAccept(acceptable)}
          >
            Accept all ({acceptable.length})
          </Button>
        </Box>
      </>
    );
  }

  const counts = latest?.counts;
  const summary =
    run?.status === 'ready' && counts
      ? [
          `${counts.pending} to review`,
          counts.accepted > 0 ? `${counts.accepted} accepted` : null,
          counts.rejected > 0 ? `${counts.rejected} rejected` : null,
          counts.stale > 0 ? `${counts.stale} skipped` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';

  return (
    <Box
      component="section"
      aria-labelledby={NAME_PANEL_HEADING_ID}
      sx={{ p: 2 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
        <Typography
          id={NAME_PANEL_HEADING_ID}
          variant="subtitle2"
          component="h2"
          sx={{ flexGrow: 1 }}
        >
          Name suggestions
        </Typography>
        <IconButton size="small" onClick={onClose} aria-label="Close name suggestions">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      <Typography
        variant="caption"
        color="text.secondary"
        role="status"
        component="div"
        sx={{ mb: summary ? 1 : 0 }}
      >
        {summary}
      </Typography>
      {content}
    </Box>
  );
}

export function NameSuggestionsPanel(props: NameSuggestionsPanelProps) {
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
            sx: { borderTopLeftRadius: 12, borderTopRightRadius: 12, maxHeight: '80vh' },
            'aria-label': 'Name suggestions',
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

export default NameSuggestionsPanel;
