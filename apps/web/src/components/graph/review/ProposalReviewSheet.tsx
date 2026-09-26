/**
 * The graph proposal review sheet (#367, epic #346; ontology.md §8, §13, §19).
 *
 * A SIDE SHEET OVER THE NOTE, NOT A TAB (§13; CLAUDE.md Settings UI rule 2):
 * the proposal is a transient review surface over one note, and evidence
 * review needs the note beside the rows.
 *
 * LAYOUT is one page-level `down('sm')` read — the `NameSuggestionsPanel`
 * pattern, deciding where one page puts one panel, never whether app chrome
 * mounts (so it is not a sixth breakpoint gate, CLAUDE.md rule 5):
 *   - phone: a bottom sheet (92vh, drag handle, sticky header and footer);
 *   - sm and up: a persistent right drawer, `min(480px, 100vw - 72px)` wide.
 *     The note page shifts its column with an `lg` sx margin so the note stays
 *     readable beside it; below `lg` the sheet overlays the note, and an
 *     evidence jump hides the sheet with a "Back to review" snackbar, exactly
 *     as on a phone. (That width check happens at click time — it is not a
 *     media-query subscription.)
 *
 * Everything the reviewer does is one #366 call through `useGraphProposal`;
 * the sheet only turns answers into snackbars, a polite live region and
 * dialogs. It never re-derives what the server computed (`display`,
 * `groupKey`, `prechecked`, `counts`, `stale`).
 */

import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Drawer from '@mui/material/Drawer';
import GlobalStyles from '@mui/material/GlobalStyles';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Snackbar from '@mui/material/Snackbar';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { alpha, useTheme } from '@mui/material/styles';
import visuallyHidden from '@mui/utils/visuallyHidden';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

import { CopyButton } from '../../common/CopyButton';
import { useAiConfig } from '../../../hooks/useAiConfig';
import { useGraphOntology } from '../../../hooks/useGraphOntology';
import { useGraphProposal } from '../../../hooks/useGraphProposal';
import type { GraphProposalSource, UseGraphProposalReturn } from '../../../hooks/useGraphProposal';
import { usePermissions } from '../../../hooks/usePermissions';
import { useSourceAudio } from '../../../hooks/useSourceAudio';
import { ApiError } from '../../../services/api';
import { getProposal, graphConflictReason } from '../../../services/graph';
import type {
  BulkDecision,
  PatchProposalItemInput,
  ProposalDetail,
  ProposalEvidence,
  ProposalItem,
  RelinkField,
} from '../../../services/graph';
import { formatTimestamp } from '../../../utils/playbackIntervals';
import { CommitBar } from './CommitBar';
import { EVIDENCE_HIGHLIGHT_NAME, highlightQuoteInElement } from './noteSpanHighlight';
import { ProposalHeader } from './ProposalHeader';
import { ProposalItemEditor } from './ProposalItemEditor';
import { ProposalReviewContent, reviewState } from './ProposalReviewContent';
import { describeSkipped } from './proposalGrouping';
import type { ProposalGroupView } from './proposalGrouping';
import { RelinkDialog } from './RelinkDialog';
import { RevertDialog } from './RevertDialog';

export interface ProposalReviewSheetProps {
  open: boolean;
  onClose: () => void;
  source: { noteId: string } | { proposalId: string };
  /** The rendered note body, for jump-to-span highlighting. Absent off the note page. */
  noteBodyRef?: RefObject<HTMLElement | null>;
  /** Origin transcript for ▶ playback; absent for note-only meetings. */
  originTranscriptId?: string | null;
  /** Default: requestExtraction(noteId, {}). #368 passes a handler that opens its ExtractDialog. */
  onRequestExtract?: (mode: 'extract' | 're-extract') => void;
  /** Extra header content (#368 mounts its Guide summary here). */
  headerSlot?: ReactNode;
  /**
   * A `useGraphProposal` the page already holds (the note page does, for the
   * entry button's badge). Absent: the sheet reads the proposal itself.
   */
  proposal?: UseGraphProposalReturn;
  /**
   * A row to bring into view once it is rendered (#368: the row "Add to
   * graph" just created). Scrolled to once per id.
   */
  focusItemId?: string | null;
}

/** Desktop drawer width. The note page's `lg` margin matches it. */
export const REVIEW_SHEET_WIDTH = 480;
/** The sticky AppBar's height at `sm` and up; the drawer sits below it. */
const APP_BAR_HEIGHT = 64;

interface SnackbarState {
  key: number;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

function ContextDialog({ proposalId, onClose }: { proposalId: string; onClose: () => void }) {
  const [context, setContext] = useState<ProposalDetail['context'] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getProposal(proposalId, { includeContext: true }).then(
      (detail) => live && setContext(detail.context),
      (err: unknown) => live && setError(errorMessage(err, 'What the AI saw could not be loaded')),
    );
    return () => {
      live = false;
    };
  }, [proposalId]);

  const text = context ? `${context.systemPrompt}\n\n---\n\n${context.userContent}` : '';

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" aria-labelledby="proposal-context-title">
      <DialogTitle id="proposal-context-title">What the AI saw</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error">{error}</Alert>}
        {!error && context === undefined && <LinearProgress aria-label="Loading what the AI saw" />}
        {context === null && (
          <DialogContentText>Nothing was recorded for this proposal.</DialogContentText>
        )}
        {context && (
          <>
            <Typography variant="subtitle2" component="h3">
              Instructions
            </Typography>
            <Box component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12, mt: 0.5 }}>
              {context.systemPrompt}
            </Box>
            <Typography variant="subtitle2" component="h3" sx={{ mt: 2 }}>
              Your note and transcript
            </Typography>
            <Box component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12, mt: 0.5 }}>
              {context.userContent}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        {context && <CopyButton text={text} variant="button" label="Copy" />}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export function ProposalReviewSheet({
  open,
  onClose,
  source,
  noteBodyRef,
  originTranscriptId,
  onRequestExtract,
  headerSlot,
  proposal: external,
  focusItemId = null,
}: ProposalReviewSheetProps) {
  const theme = useTheme();
  const isCompactWindow = useMediaQuery(theme.breakpoints.down('sm'));
  const { hasPermission } = usePermissions();
  const canWrite = hasPermission('graph:write');
  const headingId = useId();

  const own = useGraphProposal(source as GraphProposalSource, { enabled: open && !external });
  const ctl = external ?? own;
  const { ontology } = useGraphOntology({ enabled: open });
  const { config: aiConfig } = useAiConfig();
  const audio = useSourceAudio(originTranscriptId ?? '');

  const [suspended, setSuspended] = useState(false);
  const [snackbar, setSnackbar] = useState<SnackbarState | null>(null);
  const [live, setLive] = useState('');
  const [editor, setEditor] = useState<{ item: ProposalItem; mode: 'edit' | 'type' } | null>(null);
  const [relink, setRelink] = useState<{ item: ProposalItem; field?: RelinkField } | null>(null);
  const [revertOpen, setRevertOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const snackKey = useRef(0);

  const detail = ctl.detail;
  const summary = detail?.proposal ?? null;
  const items = detail?.items ?? [];
  const state = reviewState(detail, ctl.error);
  const modelLabel =
    (summary?.model && aiConfig?.models.find((model) => model.id === summary.model)?.label) || null;

  useEffect(() => {
    if (!open) setSuspended(false);
  }, [open]);

  // The persistent drawer is not modal, so nothing moves focus into it: do it
  // here, onto the heading, so a keyboard user lands in the sheet they opened.
  // (The phone's bottom sheet is a Modal, which focuses itself.)
  useEffect(() => {
    if (!open || isCompactWindow) return;
    const timer = window.setTimeout(() => document.getElementById(headingId)?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [headingId, isCompactWindow, open]);

  // #368: bring a just-added row into view, once, as soon as it is drawn.
  const focusedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !focusItemId || focusedRef.current === focusItemId) return;
    if (!items.some((item) => item.id === focusItemId)) return;
    const timer = window.setTimeout(() => {
      const row = document.querySelector<HTMLElement>(`[data-testid="proposal-row-${focusItemId}"]`);
      if (!row) return;
      focusedRef.current = focusItemId;
      row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusItemId, items, open]);

  const notify = useCallback((message: string, actionLabel?: string, onAction?: () => void) => {
    snackKey.current += 1;
    setSnackbar({ key: snackKey.current, message, actionLabel, onAction });
  }, []);

  const onMutationError = useCallback(
    (err: unknown, fallback: string) => {
      if (graphConflictReason(err) === 'proposal_not_draft') {
        void ctl.refresh();
        notify('This proposal changed in another tab');
        return;
      }
      notify(errorMessage(err, fallback));
    },
    [ctl, notify],
  );

  const decide = useCallback(
    (item: ProposalItem, body: PatchProposalItemInput) => {
      ctl.decide(item.id, body).catch((err: unknown) => onMutationError(err, 'That change was not saved'));
    },
    [ctl, onMutationError],
  );

  const bulk = useCallback(
    (_group: ProposalGroupView, itemIds: string[], decision: BulkDecision) => {
      ctl
        .bulk(itemIds, decision)
        .then((result) => {
          const skipped = describeSkipped(result.skipped);
          if (skipped) notify(skipped);
        })
        .catch((err: unknown) => onMutationError(err, 'Those changes were not saved'));
    },
    [ctl, notify, onMutationError],
  );

  const requestExtract = useCallback(
    (mode: 'extract' | 're-extract') => {
      if (onRequestExtract) {
        onRequestExtract(mode);
        return;
      }
      ctl.requestExtract({}).catch((err: unknown) => {
        notify(
          graphConflictReason(err) === 'extraction_running'
            ? 'An extraction is already running for this note'
            : errorMessage(err, 'The extraction could not be started'),
        );
      });
    },
    [ctl, notify, onRequestExtract],
  );

  const commit = useCallback(async () => {
    const sending = summary?.counts.accepted ?? 0;
    setBusy(true);
    try {
      await ctl.commit();
      const message = `Sent ${sending} ${sending === 1 ? 'row' : 'rows'} to your graph`;
      setLive(message);
      notify(message, 'Undo', () => setRevertOpen(true));
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) void ctl.refresh();
      onMutationError(err, 'The proposal could not be sent');
    } finally {
      setBusy(false);
    }
  }, [ctl, notify, onMutationError, summary?.counts.accepted]);

  const discard = useCallback(async () => {
    setDiscardOpen(false);
    setBusy(true);
    try {
      await ctl.discard();
      setLive('Proposal discarded');
    } catch (err) {
      onMutationError(err, 'The proposal could not be discarded');
    } finally {
      setBusy(false);
    }
  }, [ctl, onMutationError]);

  const play = useCallback(
    (evidence: ProposalEvidence) => {
      if (evidence.startMs === null) return;
      audio.seek(evidence.startMs);
      if (audio.status !== 'playing' && audio.status !== 'loading') audio.toggle();
    },
    [audio],
  );

  const showInNote = useCallback(
    (evidence: ProposalEvidence) => {
      const found = highlightQuoteInElement(noteBodyRef?.current, evidence.quote);
      if (!found) {
        notify('That passage is no longer in the note');
        return;
      }
      const overlays = isCompactWindow || window.innerWidth < theme.breakpoints.values.lg;
      if (overlays) {
        setSuspended(true);
        notify('Showing the passage in your note', 'Back to review', () => setSuspended(false));
      }
    },
    [isCompactWindow, noteBodyRef, notify, theme.breakpoints.values.lg],
  );

  const rowHandlers = {
    onDecide: decide,
    onEdit: (item: ProposalItem, mode: 'edit' | 'type') => setEditor({ item, mode }),
    onRelink: (item: ProposalItem, field?: RelinkField) => setRelink({ item, field }),
    onPlay: originTranscriptId ? play : undefined,
    onShowInNote: noteBodyRef ? showInNote : undefined,
  };

  const audioBar =
    originTranscriptId && audio.status !== 'idle' ? (
      <Box
        sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2, py: 0.5, borderBottom: 1, borderColor: 'divider' }}
      >
        <IconButton
          size="small"
          aria-label={audio.status === 'playing' ? 'Pause the recording' : 'Play the recording'}
          onClick={audio.toggle}
        >
          {audio.status === 'playing' ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
        </IconButton>
        <Typography variant="caption" color={audio.error ? 'error' : 'text.secondary'}>
          {audio.error ?? (audio.status === 'loading' ? 'Loading the recording…' : formatTimestamp(audio.positionMs))}
        </Typography>
      </Box>
    ) : null;

  const body = (
    <>
      <ProposalHeader
        headingId={headingId}
        summary={summary}
        modelLabel={modelLabel}
        canWrite={canWrite}
        onClose={onClose}
        onReextract={() => requestExtract('re-extract')}
        onDiscard={() => setDiscardOpen(true)}
        onShowContext={() => setContextOpen(true)}
        headerSlot={headerSlot}
      />
      {audioBar}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 2, py: 1.5 }}>
        <ProposalReviewContent
          detail={detail}
          loadError={ctl.error}
          canWrite={canWrite}
          modelLabel={modelLabel}
          pendingItemIds={ctl.pendingItemIds}
          onRetry={() => void ctl.refresh()}
          onRequestExtract={requestExtract}
          onRevert={() => setRevertOpen(true)}
          onBulk={bulk}
          rowHandlers={rowHandlers}
        />
      </Box>
      {state === 'draft' && canWrite && summary && (
        <CommitBar
          counts={summary.counts}
          busy={busy}
          onCommit={() => void commit()}
          onDiscard={() => setDiscardOpen(true)}
        />
      )}
    </>
  );

  const paperLayout = { display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' };

  return (
    <>
      <GlobalStyles
        styles={{
          [`::highlight(${EVIDENCE_HIGHLIGHT_NAME})`]: {
            backgroundColor: alpha(theme.palette.warning.main, 0.45),
          },
        }}
      />
      {isCompactWindow ? (
        <Drawer
          anchor="bottom"
          open={open && !suspended}
          onClose={onClose}
          slotProps={{
            paper: {
              role: 'dialog',
              'aria-modal': true,
              'aria-labelledby': headingId,
              sx: { ...paperLayout, borderTopLeftRadius: 12, borderTopRightRadius: 12, height: '92vh' },
            } as object,
          }}
        >
          <Box aria-hidden sx={{ display: 'flex', justifyContent: 'center', pt: 1 }}>
            <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: 'divider' }} />
          </Box>
          {body}
        </Drawer>
      ) : (
        <Drawer
          anchor="right"
          variant="persistent"
          open={open && !suspended}
          slotProps={{
            paper: {
              role: 'region',
              'aria-labelledby': headingId,
              sx: {
                ...paperLayout,
                width: `min(${REVIEW_SHEET_WIDTH}px, calc(100vw - 72px))`,
                top: APP_BAR_HEIGHT,
                height: `calc(100% - ${APP_BAR_HEIGHT}px)`,
              },
            } as object,
          }}
        >
          {body}
        </Drawer>
      )}

      {/* Always mounted, so an announcement is not lost to a region inserted
          at the same moment as its text. */}
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {live}
      </Box>

      <Snackbar
        key={snackbar?.key}
        open={snackbar !== null}
        autoHideDuration={snackbar?.actionLabel ? 10_000 : 6_000}
        onClose={(_event, reason) => {
          if (reason !== 'clickaway') setSnackbar(null);
        }}
        message={snackbar?.message}
        action={
          snackbar?.actionLabel ? (
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                const action = snackbar.onAction;
                setSnackbar(null);
                action?.();
              }}
            >
              {snackbar.actionLabel}
            </Button>
          ) : undefined
        }
      />

      <ProposalItemEditor
        open={editor !== null}
        item={editor?.item ?? null}
        mode={editor?.mode ?? 'edit'}
        ontology={ontology}
        items={items}
        fullScreen={isCompactWindow}
        onCancel={() => setEditor(null)}
        onRelink={(field) => {
          const item = editor?.item;
          setEditor(null);
          if (item) setRelink({ item, field });
        }}
        onSave={async (editedPayload) => {
          if (!editor) return;
          await ctl.decide(editor.item.id, { decision: 'edit', editedPayload });
          setEditor(null);
        }}
      />

      <RelinkDialog
        open={relink !== null}
        item={relink?.item ?? null}
        initialField={relink?.field}
        items={items}
        ontology={ontology}
        fullScreen={isCompactWindow}
        onCancel={() => setRelink(null)}
        onConfirm={(patch) => {
          const item = relink?.item;
          setRelink(null);
          if (item) decide(item, patch);
        }}
      />

      <RevertDialog
        open={revertOpen}
        onClose={() => setRevertOpen(false)}
        onRevert={(confirmPartial) => ctl.revert(confirmPartial)}
        onStale={() => void ctl.refresh()}
        onReverted={(result) => {
          const message = `Reverted ${result.reverted} ${result.reverted === 1 ? 'change' : 'changes'}${
            result.kept.length > 0 ? `; kept ${result.kept.length}` : ''
          }`;
          setLive(message);
          notify(message);
        }}
      />

      <Dialog open={discardOpen} onClose={() => setDiscardOpen(false)} aria-labelledby="proposal-discard-title">
        <DialogTitle id="proposal-discard-title">Discard this proposal?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Nothing from it will be sent to your graph. You can extract the note again later.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDiscardOpen(false)}>Cancel</Button>
          <Button color="error" onClick={() => void discard()}>
            Discard
          </Button>
        </DialogActions>
      </Dialog>

      {contextOpen && summary && <ContextDialog proposalId={summary.id} onClose={() => setContextOpen(false)} />}
    </>
  );
}

export default ProposalReviewSheet;
