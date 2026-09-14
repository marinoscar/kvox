/**
 * The preview panel — pick a source, run it, watch the sample arrive.
 * Issue #56, epic #45.
 *
 * =============================================================================
 * SIDE BY SIDE WITH THE FORM, AND THE FORM STAYS LIVE
 * =============================================================================
 *
 * The loop this feature exists for is *adjust → re-run → compare*, and it only
 * works if both halves are on screen at once: a preview that replaced the form,
 * or opened in a dialog over it, would make every iteration a navigation. So
 * this is a panel beside the editor, the editor's fields stay editable while a
 * stream is running, and a failure renders INSIDE the panel rather than as a
 * toast that takes the reason away after five seconds.
 *
 * =============================================================================
 * ⚠ COMPLETION IS ANNOUNCED, NOT JUST DRAWN
 * =============================================================================
 *
 * A stream that finishes by a spinner disappearing is a change no screen reader
 * reports. This panel therefore carries ONE polite live region
 * (`role="status"`) holding a short status sentence — "Generating…", "Preview
 * complete", "Preview failed: …" — and the streaming text itself is
 * deliberately NOT inside it.
 *
 * That separation is the whole design. Marking the output live would re-announce
 * the entire sample on every token: SSE deltas arrive many times a second, and
 * an `aria-live` region whose contents are rewritten that often is read
 * continuously and interrupts itself, which is worse than silence. The sample is
 * a normal, navigable region the user reads when the status tells them it is
 * finished.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import LinearProgress from '@mui/material/LinearProgress';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';

import { MarkdownView } from './MarkdownView';
import { PREVIEW_COST_NOTICE_ID, PreviewCostNotice } from './PreviewCostNotice';
import type { PreviewStatus } from '../../hooks/useTemplatePreview';
import type { NoteTemplatePreview } from '../../services/noteTemplates';

/** One thing a preview can be run against. Transcripts today; the shape is the API's. */
export interface PreviewSourceOption {
  id: string;
  label: string;
}

export interface TemplatePreviewPanelProps {
  sources: PreviewSourceOption[];
  isLoadingSources: boolean;
  /** Why there is nothing to pick, when there is nothing to pick. */
  sourcesError: string | null;
  selectedSourceId: string;
  onSelectSource: (id: string) => void;
  status: PreviewStatus;
  content: string;
  preview: NoteTemplatePreview | null;
  error: string | null;
  isRunning: boolean;
  /** False when the form is not yet in a state the API would accept. */
  canRun: boolean;
  onRun: () => void;
}

/** The sentence the live region holds. One per status, and never empty. */
function statusMessage(
  status: PreviewStatus,
  error: string | null,
  hasContent: boolean,
): string {
  switch (status) {
    case 'idle':
      return 'No preview has been run yet.';
    case 'requesting':
      return 'Starting the preview…';
    case 'streaming':
      return hasContent ? 'Generating the preview…' : 'Waiting for the first words…';
    case 'done':
      return 'Preview complete.';
    case 'error':
      return `Preview failed. ${error ?? ''}`.trim();
  }
}

export function TemplatePreviewPanel({
  sources,
  isLoadingSources,
  sourcesError,
  selectedSourceId,
  onSelectSource,
  status,
  content,
  preview,
  error,
  isRunning,
  canRun,
  onRun,
}: TemplatePreviewPanelProps) {
  const hasSources = sources.length > 0;

  return (
    <Paper
      variant="outlined"
      component="section"
      aria-labelledby="template-preview-heading"
      sx={{ p: { xs: 2, sm: 3 } }}
    >
      <Typography id="template-preview-heading" variant="h6" component="h2" gutterBottom>
        Preview
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Generate a sample from one of your own recordings, using exactly what is in the
        form right now — including changes you have not saved.
      </Typography>

      {sourcesError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {sourcesError}
        </Alert>
      )}

      {!isLoadingSources && !hasSources && !sourcesError && (
        <Alert severity="info" sx={{ mb: 2 }}>
          You have no transcripts yet. A preview runs against one of your own recordings,
          so there is nothing to try this template on until you have made one.
        </Alert>
      )}

      <TextField
        select
        fullWidth
        label="Source recording"
        value={hasSources ? selectedSourceId : ''}
        onChange={(event) => onSelectSource(event.target.value)}
        disabled={!hasSources || isRunning}
        helperText={
          isLoadingSources
            ? 'Loading your recordings…'
            : 'Defaults to your most recent recording.'
        }
        sx={{ mb: 2 }}
      >
        {sources.map((source) => (
          <MenuItem key={source.id} value={source.id}>
            {source.label}
          </MenuItem>
        ))}
      </TextField>

      <Stack spacing={1.5} sx={{ mb: 2 }}>
        <Box>
          <Button
            variant="contained"
            startIcon={isRunning ? <CircularProgress size={16} color="inherit" /> : <PlayArrowIcon />}
            onClick={onRun}
            disabled={!canRun || isRunning || !hasSources}
            // Points at the cost notice below, so the price of pressing this is
            // part of the button's own description rather than a line a screen
            // reader only meets afterwards.
            aria-describedby={PREVIEW_COST_NOTICE_ID}
          >
            {isRunning ? 'Generating…' : status === 'idle' ? 'Preview' : 'Run again'}
          </Button>
        </Box>

        {/* ⚠ BEFORE THE BUTTON IS PRESSED, next to the action. See the
            component's own header for why this is not a modal. */}
        <PreviewCostNotice />
      </Stack>

      {/* The live region. Status only — never the sample. See the header. */}
      <Typography
        role="status"
        aria-live="polite"
        variant="body2"
        color={status === 'error' ? 'error' : 'text.secondary'}
        sx={{ mb: 1 }}
      >
        {statusMessage(status, error, content.length > 0)}
      </Typography>

      {isRunning && <LinearProgress sx={{ mb: 2 }} />}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          <AlertTitle>The preview did not finish</AlertTitle>
          {error}
        </Alert>
      )}

      {preview && (
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mb: 2 }}>
          Generated with {preview.model} on your {preview.providerId} account.
        </Typography>
      )}

      {content && (
        <Box
          // A labelled region so the sample can be jumped to, and
          // `tabIndex={0}` so a keyboard user can scroll it without a mouse.
          component="section"
          aria-label="Generated sample"
          tabIndex={0}
          sx={{
            p: 2,
            borderRadius: 1,
            bgcolor: 'action.hover',
            maxHeight: 480,
            overflowY: 'auto',
          }}
        >
          {/* Rendered as markdown, with raw HTML disabled — see `MarkdownView`. */}
          <MarkdownView>{content}</MarkdownView>
        </Box>
      )}
    </Paper>
  );
}

export default TemplatePreviewPanel;
