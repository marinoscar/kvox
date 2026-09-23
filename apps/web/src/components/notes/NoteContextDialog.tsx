/**
 * "Context sent to the AI" — issue #308.
 *
 * The long form of the "How this note was generated" panel: the EXACT system
 * prompt and user message a generation sent, as the API recorded them
 * (`GET /api/notes/{id}/context`). Three tabs because the three views are
 * parallel — the same prompt, whole or in its two halves — not a hierarchy.
 *
 * ⚠ MOUNT ONLY WHILE OPEN. The prompt carries the whole source (a long
 * transcript can make it megabytes), so the fetch is gated on `open` and the
 * page mounts this component only while the user has asked for it.
 *
 * ⚠ COPY AND DOWNLOAD ALWAYS USE THE FULL TEXT. A very large prompt is shown
 * truncated (rendering millions of characters in one `pre` stalls the tab), but
 * truncation is a display decision only — what leaves through the clipboard or
 * a file is always everything that was sent.
 */

import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import { useEffect, useMemo, useState } from 'react';

import { useNoteGenerationContext } from '../../hooks/useNoteGenerationContext';
import type { NoteGenerationContext } from '../../services/notes';
import { CopyButton } from '../common/CopyButton';

/** Above this many characters the view is truncated (copy/download are not). */
export const CONTEXT_TRUNCATE_THRESHOLD = 1_000_000;
/** How much of a truncated text is shown until "Show all" is pressed. */
export const CONTEXT_TRUNCATED_PREVIEW = 200_000;

export const CONTEXT_SEPARATOR = '\n\n---\n\n';

type ContextTab = 'full' | 'instructions' | 'source';

const TABS: { value: ContextTab; label: string }[] = [
  { value: 'full', label: 'Full prompt' },
  { value: 'instructions', label: 'Instructions' },
  { value: 'source', label: 'Context & source' },
];

export interface NoteContextDialogProps {
  open: boolean;
  noteId: string;
  noteTitle?: string;
  generationId?: string;
  onClose: () => void;
}

/** The whole prompt: the system prompt, then the user message — only the parts that exist. */
export function fullPromptText(context: NoteGenerationContext): string {
  return [context.systemPrompt, context.userContent]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(CONTEXT_SEPARATOR);
}

/** A filesystem-safe download name: `<title> – context.txt`. */
export function contextFileName(noteTitle?: string): string {
  const base = (noteTitle ?? 'note')
    // Characters Windows, macOS or a shell would refuse or misread, plus controls.
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim();
  return `${base || 'note'} – context.txt`;
}

function formatCapturedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatTokens(prompt: number | null, completion: number | null): string | null {
  const parts: string[] = [];
  if (prompt !== null) parts.push(`${prompt.toLocaleString()} in`);
  if (completion !== null) parts.push(`${completion.toLocaleString()} out`);
  return parts.length > 0 ? parts.join(' / ') : null;
}

function headerFacts(context: NoteGenerationContext): string[] {
  const facts: string[] = [];
  const captured = formatCapturedAt(context.capturedAt);
  if (captured) facts.push(`Captured ${captured}`);
  if (context.templateNameSnapshot) facts.push(context.templateNameSnapshot);

  const modelLine = [context.model, context.provider].filter(Boolean).join(' · ');
  if (modelLine) facts.push(modelLine);

  if (context.sourceType !== 'document' && context.sourceVersion !== null) {
    facts.push(`${context.sourceType} v${context.sourceVersion}`);
  }

  const tokens = formatTokens(context.promptTokens, context.completionTokens);
  if (tokens) facts.push(tokens);
  return facts;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function downloadText(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    document.body.removeChild(anchor);
    // Deferred so the browser has started the download before the URL goes.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function TextView({ text, label }: { text: string; label: string }) {
  const [showAll, setShowAll] = useState(false);
  const truncated = !showAll && text.length > CONTEXT_TRUNCATE_THRESHOLD;
  const shown = truncated ? text.slice(0, CONTEXT_TRUNCATED_PREVIEW) : text;

  return (
    <>
      <Box
        component="pre"
        tabIndex={0}
        aria-label={label}
        sx={{
          m: 0,
          p: 1.5,
          fontFamily: 'monospace',
          fontSize: '0.8125rem',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: '60vh',
          overflow: 'auto',
          borderRadius: 1,
          bgcolor: 'action.hover',
          '&:focus-visible': {
            outline: (theme) => `2px solid ${theme.palette.primary.main}`,
            outlineOffset: 2,
          },
        }}
      >
        {shown}
      </Box>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ mt: 1, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Typography variant="caption" color="text.secondary">
          {`${text.length.toLocaleString()} characters · ${countLines(text).toLocaleString()} lines`}
          {truncated &&
            ` · showing the first ${CONTEXT_TRUNCATED_PREVIEW.toLocaleString()} characters`}
        </Typography>
        {truncated && (
          <Button size="small" onClick={() => setShowAll(true)}>
            Show all
          </Button>
        )}
      </Stack>
    </>
  );
}

function LoadingState() {
  return (
    <Box aria-busy="true" aria-label="Loading the context">
      <Skeleton width="60%" />
      <Skeleton width="90%" />
      <Skeleton width="85%" />
      <Skeleton width="75%" />
      <Skeleton width="40%" />
    </Box>
  );
}

export function NoteContextDialog({
  open,
  noteId,
  noteTitle,
  generationId,
  onClose,
}: NoteContextDialogProps) {
  const theme = useTheme();
  // The `down('sm')` compact-window convention shared with the other note
  // dialogs — never `md`.
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));

  const { context, isLoading, error, refresh } = useNoteGenerationContext(noteId, {
    enabled: open,
    generationId,
  });

  const [tab, setTab] = useState<ContextTab>('full');

  // A different generation is a different prompt; start again on the whole of it.
  useEffect(() => {
    setTab('full');
  }, [generationId]);

  const full = useMemo(() => (context ? fullPromptText(context) : ''), [context]);

  const sourceRecorded = context !== null && context.stored && context.userContent !== null;

  const tabText: Record<ContextTab, string | null> = {
    full: full.length > 0 ? full : null,
    instructions: context?.systemPrompt ?? null,
    source: sourceRecorded ? (context?.userContent ?? null) : null,
  };

  const currentLabel = TABS.find((t) => t.value === tab)?.label ?? '';
  const currentText = tabText[tab];

  const renderBody = () => {
    if (isLoading) return <LoadingState />;

    if (error) {
      return (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={refresh}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      );
    }

    if (!context) {
      return (
        <Typography variant="body2" color="text.secondary">
          This note has no generation yet.
        </Typography>
      );
    }

    const facts = headerFacts(context);

    return (
      <Stack spacing={2}>
        {facts.length > 0 && (
          <Typography variant="body2" color="text.secondary" data-testid="note-context-facts">
            {facts.join(' · ')}
          </Typography>
        )}

        {context.status === 'failed' && (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
            This generation failed; this is what was sent.
          </Typography>
        )}

        {!context.stored && (
          <Alert severity="warning">
            This note was generated before full context capture existed. The instructions below
            are rebuilt from the template as it is today, and the source material was not
            recorded.
          </Alert>
        )}

        {context.sourceRedacted && (
          <Alert severity="info">
            You no longer have access to this note&apos;s source, so the source material is
            withheld.
          </Alert>
        )}

        <Box>
          <Tabs
            value={tab}
            onChange={(_event, value: ContextTab) => setTab(value)}
            variant="scrollable"
            allowScrollButtonsMobile
            aria-label="Context views"
            sx={{ borderBottom: 1, borderColor: 'divider' }}
          >
            {TABS.map((t) => (
              <Tab
                key={t.value}
                value={t.value}
                label={t.label}
                id={`note-context-tab-${t.value}`}
                aria-controls={`note-context-tabpanel-${t.value}`}
              />
            ))}
          </Tabs>

          <Box
            role="tabpanel"
            id={`note-context-tabpanel-${tab}`}
            aria-labelledby={`note-context-tab-${tab}`}
            sx={{ pt: 1.5 }}
          >
            <Stack
              direction="row"
              sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1 }}
            >
              <Typography variant="subtitle2" component="h3">
                {currentLabel}
              </Typography>
              <CopyButton
                // Keyed by tab so a "Copied" from one tab is not shown on another.
                key={tab}
                text={currentText ?? ''}
                label={`Copy ${currentLabel.toLowerCase()}`}
                variant="icon"
                disabled={currentText === null}
              />
            </Stack>

            {currentText === null ? (
              <Typography variant="body2" color="text.secondary">
                Not recorded
              </Typography>
            ) : (
              // Keyed by tab so "Show all" is a per-view choice.
              <TextView key={tab} text={currentText} label={currentLabel} />
            )}
          </Box>
        </Box>
      </Stack>
    );
  };

  const canExport = context !== null && full.length > 0 && !isLoading && !error;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={isCompactWindow}
      fullWidth
      maxWidth="md"
      aria-labelledby="note-context-dialog-title"
    >
      <DialogTitle id="note-context-dialog-title">Context sent to the AI</DialogTitle>
      <DialogContent dividers>{renderBody()}</DialogContent>
      <DialogActions disableSpacing sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onClose}>Close</Button>
        <Button
          variant="outlined"
          startIcon={<FileDownloadOutlinedIcon />}
          disabled={!canExport}
          onClick={() => downloadText(full, contextFileName(noteTitle))}
        >
          Download .txt
        </Button>
        {/* Always the Full prompt, whichever tab is showing. */}
        <CopyButton text={() => full} label="Copy all" variant="button" disabled={!canExport} />
      </DialogActions>
    </Dialog>
  );
}

export default NoteContextDialog;
