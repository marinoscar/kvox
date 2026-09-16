/**
 * `/transcripts/:id` — read AND correct. Issues #30 and #31, epic #19.
 *
 * Four states, in this order, because they are what the user can actually be
 * looking at:
 *
 *   1. **Not ready.** The pipeline stepper, or the failed state with a reason
 *      and (for the owner) a Retry. There are no segments to show and there is
 *      no audio worth playing, so the page IS the stepper.
 *   2. **Ready, one column.** Below `md`: speaker chips, the virtualized
 *      segment list, and the mini player fixed above the bottom bar.
 *   3. **Ready, two columns.** At `md` and up: segments on the left, a sticky
 *      right column carrying the player and the speakers panel.
 *   4. **Ready, and being corrected.** The same layouts, plus a save indicator,
 *      an inline editor, per-segment and per-speaker action sheets, and find &
 *      replace.
 *
 * =============================================================================
 * WHAT DECIDES WHETHER THE CORRECTION TOOLS EXIST
 * =============================================================================
 *
 * `transcript.access`, and nothing else. A `viewer` gets the reader #30
 * shipped — not a disabled version of the editor, but a page with no editing
 * controls in it at all, because a disabled control is still something a screen
 * reader announces and a keyboard user tabs through.
 *
 * ⚠ IT IS DELIBERATELY NOT GATED ON `transcripts:write`. An `editor` whose ROLE
 * lacks that permission is a real state: the API answers their first edit with
 * a **403**, not the 404 it uses for "no such transcript". Hiding the tools
 * from them would turn a clear, correctable answer ("ask an admin for edit
 * access") into a page that silently offers less than the sharing dialog
 * promised. So the tools are shown, the 403 comes back, and
 * `useTranscriptOperations` renders it verbatim rather than swallowing it.
 *
 * =============================================================================
 * THE CREATE-NOTE ENTRY POINT AND ITS THREE GATES (issue #59, epic #45)
 * =============================================================================
 *
 * The moment somebody wants a note is the moment they have finished reading and
 * correcting a transcript, so the action lives here and deep-links to
 * `/notes/new?transcriptId=<id>`, which #57 reads to pre-select the source.
 *
 * Each gate is decided by what the user can actually DO about the thing being
 * gated on, which is why they are three different treatments and not one:
 *
 *   no `notes:write`      ABSENT. A control a role can never use is noise, and
 *                         nothing on the destination would help them.
 *   `keyConfigured` false PRESENT, and it navigates. ⚠ This page deliberately
 *                         does NOT read `useAiConfig()`. Hiding the feature
 *                         from the users who have not set up a key yet hides it
 *                         from exactly the people who have never heard of it;
 *                         the destination renders `AiKeyRequired` (#55), which
 *                         explains the problem and links to the one page that
 *                         fixes it. Discoverability beats a tidy toolbar.
 *   not `ready`           DISABLED, with the reason. A note generated from a
 *                         half-ingested transcript is a confident summary of
 *                         half a conversation.
 *
 * The disabled state is `aria-disabled` + a `aria-describedby` reason, NOT the
 * `disabled` + `<span>`-wrapped-Tooltip arrangement `JobsPage` uses: a truly
 * disabled control is not focusable, so its tooltip never opens for a keyboard
 * user and the reason reaches them as grey text and nothing else. Here the
 * control stays reachable and the reason is in the accessibility tree whether
 * or not the tooltip is showing.
 *
 * Notes already generated from this transcript are listed below it
 * (`TranscriptNotesSection`) — the other half of the provenance #58 renders
 * from the note side, and what stops a transcript looking like a dead end.
 *
 * =============================================================================
 * KEYBOARD SHORTCUTS ARE DESKTOP-ONLY, AND GUARDED
 * =============================================================================
 *
 * Space, J and L are bound at the document level, which is the only way a
 * transport shortcut can work while the reader's focus is in the segment list.
 * That makes it essential to IGNORE the key when the user is typing: a Space in
 * the rename field must insert a space, not pause the audio. The guard is on
 * the event target's tag and `isContentEditable`, checked before anything else.
 *
 * Cmd/Ctrl+F is bound SEPARATELY and is deliberately NOT subject to that guard:
 * "find" is exactly the thing a user reaches for while their cursor is in a
 * field, and it is the one shortcut here that must beat the browser's own.
 */

import MoreVertIcon from '@mui/icons-material/MoreVert';
import NoteAddOutlinedIcon from '@mui/icons-material/NoteAddOutlined';
import SearchIcon from '@mui/icons-material/Search';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Grid from '@mui/material/Grid';
import IconButton from '@mui/material/IconButton';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Snackbar from '@mui/material/Snackbar';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import visuallyHidden from '@mui/utils/visuallyHidden';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { TranscriptNotesSection } from '../components/notes/TranscriptNotesSection';
import { ConflictCards } from '../components/transcripts/ConflictCard';
import { FindReplacePanel } from '../components/transcripts/FindReplacePanel';
import { SaveIndicator } from '../components/transcripts/SaveIndicator';
import { SegmentActions } from '../components/transcripts/SegmentActions';
import { SegmentList } from '../components/transcripts/SegmentList';
import type { TextRange } from '../components/transcripts/SegmentList';
import { SpeakerActions } from '../components/transcripts/SpeakerActions';
import { SpeakerFilter, computeSpeakerStats } from '../components/transcripts/SpeakerFilter';
import { SpeakerMergeDialog, planSpeakerMerge } from '../components/transcripts/SpeakerMergeDialog';
import type { SpeakerMergePlan } from '../components/transcripts/SpeakerMergeDialog';
import { SplitSegmentDialog } from '../components/transcripts/SplitSegmentDialog';
import { TranscriptPipeline } from '../components/transcripts/TranscriptPipeline';
import {
  MINI_PLAYER_HEIGHT,
  TranscriptPlayer,
} from '../components/transcripts/TranscriptPlayer';
import { TranscriptStatusChip } from '../components/transcripts/TranscriptStatusChip';
import { useAuth } from '../contexts/AuthContext';
import { usePermissions } from '../hooks/usePermissions';
import { usePlaybackEngine, SKIP_MS } from '../hooks/usePlaybackEngine';
import { useTranscriptOperations } from '../hooks/useTranscriptOperations';
import { useTranscriptSearch, EMPTY_FIND_QUERY } from '../hooks/useTranscriptSearch';
import type { FindQuery } from '../hooks/useTranscriptSearch';
import { useTranscript, useTranscriptSegments } from '../hooks/useTranscripts';
import { useTranscriptWords } from '../hooks/useTranscriptWords';
import { ApiError } from '../services/api';
import { deleteTranscript, retryTranscript } from '../services/transcripts';
import { removeShare } from '../services/transcriptShares';
import { ExportDialog } from '../components/transcripts/ExportDialog';
import { ShareDialog } from '../components/transcripts/ShareDialog';
import { formatDuration } from '../utils/playbackIntervals';
import { hasPlaybackRendition } from '../utils/transcriptDisplay';

/**
 * Should a document-level transport shortcut be ignored for this event?
 *
 * Exported for its own test: the failure it prevents (Space pausing the audio
 * instead of typing a space) is trivially reproducible by hand and completely
 * invisible in a snapshot.
 */
/** #57's new-note flow. `?transcriptId=` is what pre-selects the source. */
const NEW_NOTE_PATH = '/notes/new';

const CREATE_NOTE_LABEL = 'Create note';

/**
 * Why the action is disabled, as a sentence a screen reader can read out.
 *
 * Exported so the test asserting the announcement and the element rendering it
 * cannot drift into agreeing about the behaviour while disagreeing about the
 * words.
 */
export const CREATE_NOTE_NOT_READY_REASON =
  'Wait for transcription to finish before creating a note from this transcript.';

const CREATE_NOTE_REASON_ID = 'transcript-create-note-reason';

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function TranscriptPage() {
  const { id } = useParams<{ id: string }>();
  const theme = useTheme();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { hasPermission } = usePermissions();
  const isWide = useMediaQuery(theme.breakpoints.up('md'));

  const { transcript, isLoading, error, setTranscript } = useTranscript(id);
  const isReady = transcript?.status === 'ready';
  const { segments: serverSegments, version: serverVersion } = useTranscriptSegments(
    id,
    isReady,
  );

  const [selectedSpeakerIds, setSelectedSpeakerIds] = useState<string[]>([]);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const serverSpeakers = useMemo(() => transcript?.speakers ?? [], [transcript?.speakers]);

  /**
   * Editing exists for an owner or an editor, and for nobody else.
   *
   * Access, not permission — see the file header for why an editor missing
   * `transcripts:write` still gets the tools and then gets a 403 they can read.
   */
  const canEdit =
    transcript?.access === 'owner' || transcript?.access === 'editor';

  /**
   * Permission, not access: `notes:write` is what `POST /api/notes` enforces,
   * and it is orthogonal to whether this user owns or was shared this
   * transcript. A `viewer` share on a transcript plus `notes:write` is a real
   * and allowed combination — taking a note out of something you were shown is
   * a read of the transcript and a write of a note.
   */
  const canCreateNote = hasPermission('notes:write');
  const canListNotes = hasPermission('notes:read');

  const goToCreateNote = useCallback(() => {
    if (!id) return;
    navigate(`${NEW_NOTE_PATH}?transcriptId=${encodeURIComponent(id)}`);
  }, [id, navigate]);

  const ops = useTranscriptOperations({
    transcriptId: id,
    speakers: serverSpeakers,
    segments: serverSegments,
    version: serverVersion,
    enabled: canEdit,
  });

  const speakers = ops.speakers;
  const segments = ops.segments;

  const speakerName = useCallback(
    (speakerId: string) =>
      speakers.find((speaker) => speaker.id === speakerId)?.displayName ?? '',
    [speakers],
  );

  const engine = usePlaybackEngine({
    // The engine is only given an id once the transcript is READY. Before that
    // `GET /:id/audio` has nothing to sign, and mounting an element that 404s
    // would put the player into its error state for the whole processing wait.
    transcriptId: isReady ? id : undefined,
    segments,
    selectedSpeakerIds,
    title: transcript?.title ?? 'Transcript',
    speakerName,
    playbackReady: transcript ? hasPlaybackRendition(transcript.playbackStatus) : false,
  });

  const { wordsBySegment } = useTranscriptWords(id, engine.positionMs, isReady);

  // ---------------------------------------------------------------------------
  // Correction UI state
  // ---------------------------------------------------------------------------
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [caretOffset, setCaretOffset] = useState<number | null>(null);
  const [segmentMenu, setSegmentMenu] = useState<{
    segmentId: string;
    anchor: HTMLElement | null;
  } | null>(null);
  const [speakerMenu, setSpeakerMenu] = useState<{
    speakerId: string;
    anchor: HTMLElement | null;
  } | null>(null);
  const [splitFor, setSplitFor] = useState<string | null>(null);
  const [mergeSelection, setMergeSelection] = useState<string[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [newSpeakerFor, setNewSpeakerFor] = useState<string | null>(null);
  const [newSpeakerName, setNewSpeakerName] = useState('');
  const [pageMenuAnchor, setPageMenuAnchor] = useState<HTMLElement | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'leave' | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState<FindQuery>(EMPTY_FIND_QUERY);
  const [activeIndex, setActiveIndex] = useState(0);

  const search = useTranscriptSearch(id, findQuery, findOpen && isReady);
  const matches = search.result?.matches ?? [];
  const activeMatch = matches[activeIndex] ?? null;

  // A new result set is a new list of places; staying on index 7 of a list that
  // now has three entries would point "Next" at nothing.
  useEffect(() => setActiveIndex(0), [search.result]);

  const matchesBySegment = useMemo(() => {
    const map = new Map<string, TextRange[]>();
    for (const match of matches) {
      const list = map.get(match.segmentId) ?? [];
      list.push({ start: match.start, end: match.end });
      map.set(match.segmentId, list);
    }
    return map;
  }, [matches]);

  const segmentCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const stat of computeSpeakerStats(speakers, segments)) {
      map.set(stat.speaker.id, stat.segmentCount);
    }
    return map;
  }, [segments, speakers]);

  const speakerOrder = useMemo(() => speakers.map((speaker) => speaker.id), [speakers]);

  const activeSegment = useMemo(
    () => segments.find((segment) => segment.id === segmentMenu?.segmentId) ?? null,
    [segmentMenu?.segmentId, segments],
  );
  const splitSegment = useMemo(
    () => segments.find((segment) => segment.id === splitFor) ?? null,
    [segments, splitFor],
  );
  const activeSpeaker = useMemo(
    () => speakers.find((speaker) => speaker.id === speakerMenu?.speakerId) ?? null,
    [speakerMenu?.speakerId, speakers],
  );

  const toggleSpeaker = useCallback((speakerId: string) => {
    setSelectedSpeakerIds((current) =>
      current.includes(speakerId)
        ? current.filter((value) => value !== speakerId)
        : [...current, speakerId],
    );
  }, []);

  const clearSpeakerFilter = useCallback(() => setSelectedSpeakerIds([]), []);

  const handleRetry = useCallback(async () => {
    if (!id) return;
    setIsRetrying(true);
    setRetryError(null);
    try {
      setTranscript(await retryTranscript(id));
    } catch (err) {
      setRetryError(
        err instanceof ApiError ? err.message : 'The retry could not be started.',
      );
    } finally {
      setIsRetrying(false);
    }
  }, [id, setTranscript]);

  // Leaving the page must not leave a debounced edit in limbo. The unload guard
  // covers a closing tab; this covers a router navigation, which fires no
  // `beforeunload` at all.
  const flushRef = useRef(ops.flush);
  flushRef.current = ops.flush;
  useEffect(
    () => () => {
      void flushRef.current();
    },
    [],
  );

  // Desktop transport shortcuts. Bound whenever the engine is usable, and not
  // gated on width: a keyboard attached to a tablet is still a keyboard, and a
  // device with no keys never fires these.
  useEffect(() => {
    if (!isReady) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Find first, and outside the typing guard — see the file header.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFindOpen(true);
        return;
      }
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.code === 'Space') {
        // Prevented BEFORE toggling: Space also scrolls the page, and a
        // transcript that jumps a screenful every time playback starts is
        // worse than no shortcut.
        event.preventDefault();
        engine.togglePlay();
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'j') {
        event.preventDefault();
        engine.skip(-SKIP_MS);
      } else if (key === 'l') {
        event.preventDefault();
        engine.skip(SKIP_MS);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [engine, isReady]);

  const navigateMatch = useCallback(
    (delta: 1 | -1) => {
      if (matches.length === 0) return;
      setActiveIndex((current) => {
        const next = (current + delta + matches.length) % matches.length;
        return next;
      });
    },
    [matches.length],
  );

  const handleReplaceOne = useCallback(() => {
    if (!activeMatch) return;
    ops.replaceOne(
      activeMatch.segmentId,
      activeMatch.start,
      activeMatch.end,
      findQuery.replace,
    );
    void ops.flush().then(() => search.refresh());
  }, [activeMatch, findQuery.replace, ops, search]);

  const handleReplaceAll = useCallback(async () => {
    await ops.replaceAll({
      find: findQuery.find,
      replace: findQuery.replace,
      matchCase: findQuery.matchCase,
      wholeWord: findQuery.wholeWord,
      speakerId: findQuery.speakerId || null,
    });
    search.refresh();
  }, [findQuery, ops, search]);

  const handleMerge = useCallback(
    (plan: SpeakerMergePlan) => {
      setMergeSelection([]);
      void ops.mergeSpeakers(plan.sourceIds, plan.targetId, plan.keepName);
    },
    [ops],
  );

  const handleMergeInto = useCallback(
    (sourceId: string, targetId: string) => {
      const plan = planSpeakerMerge([sourceId, targetId], segmentCounts, targetId, speakerOrder);
      if (plan) void ops.mergeSpeakers(plan.sourceIds, plan.targetId, plan.keepName);
    },
    [ops, segmentCounts, speakerOrder],
  );

  const handleConfirm = useCallback(async () => {
    if (!id || !confirm) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (confirm === 'delete') await deleteTranscript(id);
      else if (user?.id) await removeShare(id, user.id);
      navigate('/transcripts');
    } catch (err) {
      setConfirmError(
        err instanceof ApiError ? err.message : 'That could not be completed.',
      );
    } finally {
      setConfirmBusy(false);
    }
  }, [confirm, id, navigate, user?.id]);

  if (isLoading && !transcript) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress aria-label="Loading transcript" />
      </Box>
    );
  }

  if (error && !transcript) {
    return (
      <Box sx={{ maxWidth: 700, mx: 'auto' }}>
        <Alert severity="error">{error}</Alert>
        <Button sx={{ mt: 2 }} onClick={() => navigate('/transcripts')}>
          Back to transcripts
        </Button>
      </Box>
    );
  }

  if (!transcript) return null;

  const isOwner = transcript.access === 'owner';

  /**
   * Mounted only for a caller holding `notes:read` — the hook inside fetches on
   * mount, so gating any deeper would still have fired the request that 403s.
   * It renders `null` when there are no notes; see the component.
   *
   * AND ONLY ONCE THE TRANSCRIPT'S OWN CONTENT HAS ARRIVED (`serverVersion`, or
   * a transcript that is not ready and therefore has none to wait for). This is
   * a secondary, additive relationship on a page whose whole purpose is the
   * segments: a third request racing the two the reader is actually waiting on
   * buys nothing, and the list it fills is below the fold in every layout.
   */
  const notesSection =
    canListNotes && id && (!isReady || serverVersion !== null) ? (
      <TranscriptNotesSection transcriptId={id} />
    ) : null;

  const pageMenu = (
    <Menu
      anchorEl={pageMenuAnchor}
      open={Boolean(pageMenuAnchor)}
      onClose={() => setPageMenuAnchor(null)}
    >
      {/* Compact only — above `md` this is a visible button in the header, the
          same "overflow menu on phones, a real control where there is room"
          split the Find action already uses. Rendering both would put two
          controls for one action on one page. */}
      {canCreateNote && !isWide ? (
        <MenuItem
          // `aria-disabled`, not `disabled`: a disabled MenuItem is skipped by
          // the menu's own keyboard navigation, so the reason below it would be
          // unreachable for the user most likely to need it read out.
          aria-disabled={!isReady || undefined}
          onClick={() => {
            if (!isReady) return;
            setPageMenuAnchor(null);
            goToCreateNote();
          }}
        >
          <ListItemText
            primary={CREATE_NOTE_LABEL}
            // The reason rides in the item's own accessible name rather than a
            // tooltip: a tooltip inside an open menu is announced by almost
            // nothing.
            secondary={isReady ? undefined : CREATE_NOTE_NOT_READY_REASON}
            slotProps={
              isReady ? undefined : { primary: { color: 'text.disabled' } }
            }
          />
        </MenuItem>
      ) : null}
      <MenuItem
        onClick={() => {
          setPageMenuAnchor(null);
          navigate(`/transcripts/${transcript.id}/history`);
        }}
      >
        <ListItemText>Version history</ListItemText>
      </MenuItem>
      {/* Export is offered to EVERY role that can open this page. A viewer's
          share is explicitly a read-play-export grant (issue #29), so gating
          this on ownership would withhold something the API already allows. */}
      <MenuItem
        onClick={() => {
          setPageMenuAnchor(null);
          setExportOpen(true);
        }}
      >
        <ListItemText>Export…</ListItemText>
      </MenuItem>
      {/* Share is owner-only, and the gate is not cosmetic: the four share
          routes answer a stranger's 404 to anyone who is not the owner, so an
          offered-but-failing menu item would be the UI promising something the
          API refuses. */}
      {isOwner ? (
        <MenuItem
          onClick={() => {
            setPageMenuAnchor(null);
            setShareOpen(true);
          }}
        >
          <ListItemText>Share…</ListItemText>
        </MenuItem>
      ) : null}
      {isOwner ? (
        <MenuItem
          onClick={() => {
            setPageMenuAnchor(null);
            setConfirm('delete');
          }}
        >
          <ListItemText slotProps={{ primary: { color: 'error.main' } }}>
            Delete transcript
          </ListItemText>
        </MenuItem>
      ) : (
        <MenuItem
          onClick={() => {
            setPageMenuAnchor(null);
            setConfirm('leave');
          }}
        >
          <ListItemText>Leave this transcript</ListItemText>
        </MenuItem>
      )}
    </Menu>
  );

  const header = (
    <Box sx={{ mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Typography variant="h5" component="h1" sx={{ mb: 0.5, flexGrow: 1, minWidth: 0 }}>
          {transcript.title}
        </Typography>
        {canCreateNote && isWide ? (
          <Tooltip
            title={isReady ? '' : CREATE_NOTE_NOT_READY_REASON}
            // DESCRIBES, never renames. Without this MUI's default puts the
            // title in `aria-label`, and the control a screen reader announces
            // stops being called "Create note" the moment it is disabled —
            // the reason would have eaten the name.
            describeChild
          >
            {/* No `<span>` wrapper and no `disabled`: the button is
                `aria-disabled`, so it still receives focus and the tooltip
                still opens for a keyboard user. See the file header. */}
            <Button
              variant="outlined"
              size="small"
              startIcon={<NoteAddOutlinedIcon />}
              aria-disabled={!isReady || undefined}
              aria-describedby={isReady ? undefined : CREATE_NOTE_REASON_ID}
              onClick={() => {
                if (!isReady) return;
                goToCreateNote();
              }}
              sx={
                isReady
                  ? undefined
                  : { color: 'text.disabled', borderColor: 'action.disabled' }
              }
            >
              {CREATE_NOTE_LABEL}
            </Button>
          </Tooltip>
        ) : null}
        {/* The sentence `aria-describedby` above points at. It exists only
            alongside the button that references it — an orphan id is a
            description nothing is described by. */}
        {canCreateNote && isWide && !isReady ? (
          <Box component="span" id={CREATE_NOTE_REASON_ID} sx={visuallyHidden}>
            {CREATE_NOTE_NOT_READY_REASON}
          </Box>
        ) : null}
        {isReady && (
          <IconButton
            aria-label="Find and replace"
            onClick={() => setFindOpen((open) => !open)}
          >
            <SearchIcon />
          </IconButton>
        )}
        <IconButton
          aria-label="Transcript actions"
          onClick={(event) => setPageMenuAnchor(event.currentTarget)}
        >
          <MoreVertIcon />
        </IconButton>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <TranscriptStatusChip transcript={transcript} showStage />
        <Typography variant="caption" color="text.secondary">
          {formatDuration(transcript.durationMs)} · {transcript.speakerCount}{' '}
          {transcript.speakerCount === 1 ? 'speaker' : 'speakers'}
        </Typography>
        {/* Only once there is something to save. Before the transcript is
            ready there are no segments and no corrections, and a second
            `role="status"` beside the pipeline's own live region would have a
            screen reader announcing "All changes saved" over the progress the
            user is actually waiting on. */}
        {canEdit && isReady && (
          <Box sx={{ ml: 'auto' }}>
            <SaveIndicator state={ops.saveState} pendingCount={ops.pendingCount} />
          </Box>
        )}
      </Box>
      {pageMenu}
      {/* Mounted beside the menu that opens them, so they exist in every branch
          that renders a header — including the processing and failed states,
          where Export is still legitimate (an older version may well be ready
          to take away even when the newest attempt failed). Both portal out of
          this Box, so its layout is unaffected. */}
      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        transcriptId={transcript.id}
        currentVersion={transcript.currentVersion}
      />
      {isOwner ? (
        <ShareDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          transcriptId={transcript.id}
          transcriptTitle={transcript.title}
        />
      ) : null}
    </Box>
  );

  const confirmDialog = (
    <Dialog open={confirm !== null} onClose={() => setConfirm(null)}>
      <DialogTitle>
        {confirm === 'delete' ? 'Delete this transcript?' : 'Leave this transcript?'}
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          {confirm === 'delete'
            ? 'The recording, the transcript and every version of it are removed. This cannot be undone.'
            : 'You will lose access to it immediately. Only the owner can share it with you again.'}
        </DialogContentText>
        {confirmError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {confirmError}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => setConfirm(null)}>Cancel</Button>
        <Button color="error" disabled={confirmBusy} onClick={() => void handleConfirm()}>
          {confirm === 'delete' ? 'Delete' : 'Leave'}
        </Button>
      </DialogActions>
    </Dialog>
  );

  if (!isReady) {
    return (
      <Box sx={{ maxWidth: 800, mx: 'auto' }}>
        {header}
        <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
          <TranscriptPipeline
            transcript={transcript}
            // Owner only: the API answers a retry from anyone else with a 404,
            // so offering the button to an editor would be offering a control
            // that cannot work.
            canRetry={isOwner}
            onRetry={() => void handleRetry()}
            isRetrying={isRetrying}
            retryError={retryError}
          />
        </Paper>
        {notesSection ? <Box sx={{ mt: 2 }}>{notesSection}</Box> : null}
        {confirmDialog}
      </Box>
    );
  }

  const playerBlocked = engine.status === 'preparing' || engine.status === 'error';
  const playerNotice = playerBlocked ? (
    <Alert severity={engine.status === 'error' ? 'error' : 'info'}>
      {engine.status === 'error'
        ? (engine.error ?? 'The audio could not be loaded.')
        : 'Preparing audio… the transcript below is ready to read now.'}
    </Alert>
  ) : null;

  const segmentList = (
    <SegmentList
      segments={segments}
      speakers={speakers}
      currentSegmentIndex={engine.currentSegmentIndex}
      positionMs={engine.positionMs}
      wordsBySegment={wordsBySegment}
      onPlayFrom={engine.playFromMs}
      selectedSpeakerIds={selectedSpeakerIds}
      // Per-line playback (#108). Unconditional, unlike the editing props
      // below: hearing one line is a READ, so a viewer gets it too.
      activeSegmentId={engine.activeSegmentId}
      isPlaying={engine.isPlaying}
      onPlaySegment={engine.playSegment}
      onPause={engine.pause}
      editable={canEdit}
      editingSegmentId={editingSegmentId}
      onStartEdit={setEditingSegmentId}
      onCancelEdit={() => setEditingSegmentId(null)}
      onChangeText={ops.updateText}
      onCommitEdit={() => {
        setEditingSegmentId(null);
        void ops.flush();
      }}
      onCaretChange={setCaretOffset}
      onOpenActions={(segmentId, anchor) => setSegmentMenu({ segmentId, anchor })}
      // #220: the speaker name in a row header opens the SAME menu the chip
      // rail opens, off the same state, so naming a voice from the line you are
      // reading renames it everywhere. Passed only when `canEdit` — the prop's
      // presence is what mounts the button at all.
      onOpenSpeakerActions={
        canEdit
          ? (speakerId, anchor) => setSpeakerMenu({ speakerId, anchor })
          : undefined
      }
      matchesBySegment={findOpen ? matchesBySegment : undefined}
      activeMatch={findOpen && activeMatch ? activeMatch : null}
      scrollToSegmentId={findOpen ? (activeMatch?.segmentId ?? null) : null}
    />
  );

  const findPanel = (
    <FindReplacePanel
      open={findOpen}
      query={findQuery}
      onQueryChange={setFindQuery}
      result={search.result}
      isSearching={search.isSearching}
      activeIndex={activeIndex}
      speakers={speakers}
      canEdit={canEdit}
      onNavigate={navigateMatch}
      onReplaceOne={handleReplaceOne}
      onReplaceAll={() => void handleReplaceAll()}
      onClose={() => setFindOpen(false)}
    />
  );

  const corrections = canEdit ? (
    <>
      <SegmentActions
        open={Boolean(segmentMenu)}
        anchorEl={segmentMenu?.anchor ?? null}
        segment={activeSegment}
        speakers={speakers}
        nameSuggestions={speakers.map((speaker) => speaker.displayName)}
        speakerSegmentCount={
          activeSegment ? (segmentCounts.get(activeSegment.speakerId) ?? 0) : 0
        }
        canJoin={
          activeSegment
            ? segments.findIndex((segment) => segment.id === activeSegment.id) <
              segments.length - 1
            : false
        }
        onClose={() => setSegmentMenu(null)}
        // All lines — the same `speaker.rename` op the chip rail issues, so the
        // two entry points cannot drift apart (#220).
        onRenameSpeaker={(displayName) => {
          if (activeSegment) void ops.renameSpeaker(activeSegment.speakerId, displayName);
        }}
        onSetSpeaker={(speakerId) => {
          if (activeSegment) void ops.setSpeaker(activeSegment.id, speakerId);
        }}
        onCreateSpeaker={() => {
          setNewSpeakerFor(activeSegment?.id ?? null);
          setNewSpeakerName('');
        }}
        onSplit={() => setSplitFor(activeSegment?.id ?? null)}
        onJoin={() => {
          if (activeSegment) void ops.joinWithNext(activeSegment.id);
        }}
        onDelete={() => {
          if (activeSegment) void ops.deleteSegment(activeSegment.id);
        }}
        onPlayFrom={() => {
          if (activeSegment) engine.playFromMs(activeSegment.startMs);
        }}
      />

      <SpeakerActions
        open={Boolean(speakerMenu)}
        anchorEl={speakerMenu?.anchor ?? null}
        speaker={activeSpeaker}
        speakers={speakers}
        nameSuggestions={speakers.map((speaker) => speaker.displayName)}
        isPlayingOnly={
          activeSpeaker ? selectedSpeakerIds.includes(activeSpeaker.id) : false
        }
        onClose={() => setSpeakerMenu(null)}
        onRename={(displayName) => {
          if (activeSpeaker) void ops.renameSpeaker(activeSpeaker.id, displayName);
        }}
        onMergeInto={(targetId) => {
          if (activeSpeaker) handleMergeInto(activeSpeaker.id, targetId);
        }}
        onTogglePlayOnly={() => {
          if (activeSpeaker) toggleSpeaker(activeSpeaker.id);
        }}
      />

      <SplitSegmentDialog
        open={Boolean(splitFor)}
        segment={splitSegment}
        speakers={speakers}
        initialOffset={caretOffset}
        onClose={() => setSplitFor(null)}
        onSplit={(offset, newSpeakerId) => {
          if (splitFor) void ops.splitSegment(splitFor, offset, newSpeakerId);
        }}
      />

      <SpeakerMergeDialog
        open={mergeOpen}
        selected={speakers.filter((speaker) => mergeSelection.includes(speaker.id))}
        segmentCounts={segmentCounts}
        order={speakerOrder}
        onClose={() => setMergeOpen(false)}
        onMerge={handleMerge}
      />

      <Dialog open={newSpeakerFor !== null} onClose={() => setNewSpeakerFor(null)}>
        <DialogTitle>New speaker</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Speaker name"
            fullWidth
            value={newSpeakerName}
            onChange={(event) => setNewSpeakerName(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNewSpeakerFor(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!newSpeakerName.trim()}
            onClick={() => {
              const segmentId = newSpeakerFor;
              setNewSpeakerFor(null);
              void (async () => {
                // The speaker has to EXIST before a segment can be pointed at
                // it: the id and the colour are the server's to choose, so this
                // is deliberately two round trips and not one clever batch.
                const created = await ops.createSpeaker(newSpeakerName);
                if (created && segmentId) await ops.setSpeaker(segmentId, created.id);
              })();
            }}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={Boolean(ops.undoableMerge)}
        onClose={ops.dismissUndo}
        autoHideDuration={12_000}
        message={ops.undoableMerge?.summary ?? 'Speakers merged'}
        action={
          <Button color="secondary" size="small" onClick={() => void ops.undoMerge()}>
            Undo
          </Button>
        }
      />
    </>
  ) : null;

  const notices = (
    <>
      {canEdit && ops.isOffline && (
        <SaveIndicator state="offline" pendingCount={ops.pendingCount} />
      )}
      {ops.error && (
        <Alert severity="error" onClose={ops.dismissError} sx={{ mb: 2 }}>
          {ops.error}
        </Alert>
      )}
      <ConflictCards conflicts={ops.conflicts} onResolve={ops.resolveConflict} />
    </>
  );

  if (isWide) {
    return (
      <Box>
        {header}
        {notices}
        <Grid container spacing={3}>
          <Grid size={{ md: 8 }} sx={{ minWidth: 0 }}>
            {segmentList}
          </Grid>
          <Grid size={{ md: 4 }}>
            {/* Sticky, not fixed: it scrolls with the page until it reaches the
                top and then stays, which keeps it inside the grid column
                instead of having to be positioned against the viewport. The
                offset clears the sticky AppBar above it. */}
            <Box
              sx={{
                position: 'sticky',
                top: theme.spacing(10),
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
            >
              {findPanel}
              {playerNotice}
              {!playerBlocked && (
                <TranscriptPlayer
                  engine={engine}
                  segments={segments}
                  speakers={speakers}
                  selectedSpeakerIds={selectedSpeakerIds}
                  onClearSpeakerFilter={clearSpeakerFilter}
                  variant="card"
                />
              )}
              <Paper variant="outlined" sx={{ p: 2 }}>
                <SpeakerFilter
                  speakers={speakers}
                  segments={segments}
                  selectedSpeakerIds={selectedSpeakerIds}
                  onToggleSpeaker={toggleSpeaker}
                  variant="panel"
                  editable={canEdit}
                  onOpenSpeakerActions={(speakerId, anchor) =>
                    setSpeakerMenu({ speakerId, anchor })
                  }
                  mergeSelection={mergeSelection}
                  onToggleMergeSelection={(speakerId) =>
                    setMergeSelection((current) =>
                      current.includes(speakerId)
                        ? current.filter((value) => value !== speakerId)
                        : [...current, speakerId],
                    )
                  }
                  onMerge={() => setMergeOpen(true)}
                />
              </Paper>
              {notesSection}
            </Box>
          </Grid>
        </Grid>
        {corrections}
        {confirmDialog}
      </Box>
    );
  }

  return (
    <Box>
      {header}
      {notices}
      <Box sx={{ mb: 1.5 }}>
        <SpeakerFilter
          speakers={speakers}
          segments={segments}
          selectedSpeakerIds={selectedSpeakerIds}
          onToggleSpeaker={toggleSpeaker}
          variant="chips"
          editable={canEdit}
          onOpenSpeakerActions={(speakerId, anchor) =>
            setSpeakerMenu({ speakerId, anchor })
          }
        />
      </Box>
      {playerNotice && <Box sx={{ mb: 2 }}>{playerNotice}</Box>}
      {segmentList}
      {findPanel}
      {notesSection ? <Box sx={{ mt: 2 }}>{notesSection}</Box> : null}

      {!playerBlocked && (
        <>
          <TranscriptPlayer
            engine={engine}
            segments={segments}
            speakers={speakers}
            selectedSpeakerIds={selectedSpeakerIds}
            onClearSpeakerFilter={clearSpeakerFilter}
            variant="mini"
          />
          {/* The spacer for the FIXED player above. Without it the last segment
              is permanently underneath the transport and cannot be scrolled
              into view — see `MINI_PLAYER_HEIGHT`. */}
          <Box aria-hidden sx={{ height: MINI_PLAYER_HEIGHT }} />
        </>
      )}
      {corrections}
      {confirmDialog}
    </Box>
  );
}

export default TranscriptPage;
