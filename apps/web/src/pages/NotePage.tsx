/**
 * `/notes/:id` — read a note, change it, and take it with you. Issues #57 and
 * #58, epic #45.
 *
 * #57 landed the GENERATION view: the live stream, the stop affordance, the
 * failure and its regenerate. #58 builds the rest ON TOP of that file rather
 * than instead of it — the title is editable, the body has an editor, a save is
 * a version, a conflict is a decision, and the note can leave the application.
 * Everything #57 wrote about the stream still holds and is unchanged.
 *
 * =============================================================================
 * THE STREAM IS ADDITIVE. CLOSING THIS PAGE CANCELS NOTHING. (#57)
 * =============================================================================
 *
 * `note.generate` completes the note — body, version, status, notification —
 * with no knowledge of whether anyone is connected. So this page never claims
 * to be cancelling anything, and the stop affordance is "Stop watching" rather
 * than "Stop": it closes one SSE connection and says, in the same breath, that
 * the note is still being written. There is no cancel endpoint for a note
 * generation, by design — the provider has been paid for the tokens either way.
 *
 * =============================================================================
 * THE BODY IS NEVER TRUSTED AS MARKUP (#57)
 * =============================================================================
 *
 * Everything rendered here is model output generated from a transcript this
 * application did not write, so it goes through `MarkdownView` —
 * `react-markdown`, `remark-gfm`, and NO `rehype-raw`. A `<script>` in the
 * output is inert text, because the renderer builds a React tree and never sets
 * HTML from a string. The EDITOR'S PREVIEW uses the same component for the same
 * reason: text a user pastes into their own note is no more trusted markup than
 * text a model wrote.
 *
 * =============================================================================
 * ⚠ NO AUTOSAVE, AND THE DIRTY GUARD IS WHAT REPLACES IT
 * =============================================================================
 *
 * Every save is a version (#48). An autosaving editor would turn a five-minute
 * edit into thirty history rows and make the history useless for the one thing
 * it exists for. #58 rejects it by name and accepts the risk it would have
 * covered — a user navigating away from unsaved text — which is covered instead
 * by `useUnsavedChangesWarning` (leaving the tab) and by the in-app
 * confirmation below (leaving the page). See that hook's header for why
 * `useBlocker` is not used.
 *
 * =============================================================================
 * ⚠ A 409 IS A DECISION, NOT AN ERROR MESSAGE
 * =============================================================================
 *
 * A stale `baseVersion` means somebody else's save landed first and BOTH bodies
 * are real work. This page re-reads the note so it can show what the other
 * version contains, then hands the choice to the user through
 * `NoteConflictDialog`. There is no Retry button anywhere on this path: a retry
 * would re-send the same text against a fresh version, which is precisely the
 * silent overwrite the API's version check exists to prevent.
 *
 * A 409 whose reason is `generating` is a different thing and gets a different
 * answer: nothing is in conflict, the generation is simply the only writer
 * until it settles, so the page says to wait rather than offering a choice
 * between two texts.
 *
 * =============================================================================
 * ⚠ A MISSING AI KEY MUST NOT LOCK A USER OUT OF THEIR OWN NOTE
 * =============================================================================
 *
 * With `keyConfigured: false` the REGENERATE control is replaced by
 * `AiKeyRequired` and nothing else changes: the note still reads, still edits,
 * still saves and still exports. A key is needed to spend money at a provider;
 * it is not needed to read text this user already owns. A page that gated
 * everything on it would be holding a user's own work hostage to a credential.
 *
 * =============================================================================
 * ⚠ "SUGGEST A TITLE" IS QUEUE WORK, AND THE PAGE NEVER PRETENDS OTHERWISE (#185)
 * =============================================================================
 *
 * `POST /api/notes/{id}/retitle` answers **202** with a job id and no title.
 * So the menu item does not wait, does not block, and does not write a name of
 * its own: it records the title the note had, starts `useNote`'s existing poll
 * by handing it an interval, and lets the row itself bring the new name back.
 * That poll is bounded (`RETITLE_WATCH_MS`) because a `ready` note polls for
 * nothing otherwise, and a job that failed would leave it running forever.
 *
 * The action stays offered for a note the user renamed themselves. That is the
 * API's own rule, not an oversight — this is the one route that overrides a
 * chosen name, because pressing the item IS the explicit request.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import EditIcon from '@mui/icons-material/Edit';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import HistoryIcon from '@mui/icons-material/History';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import StopCircleIcon from '@mui/icons-material/StopCircle';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { AiKeyRequired } from '../components/ai/AiKeyRequired';
import { GraphReviewButton } from '../components/graph/GraphReviewButton';
import { ExtractDialog } from '../components/graph/guide/ExtractDialog';
import { GuidanceSummary } from '../components/graph/guide/GuidanceSummary';
import { userDecisionCount } from '../components/graph/guide/guidance';
import { GraphSelectionAdd } from '../components/graph/selection/GraphSelectionAdd';
import { resolveNoteSelection } from '../components/graph/selection/resolvers';
import {
  ProposalReviewSheet,
  REVIEW_SHEET_WIDTH,
} from '../components/graph/review/ProposalReviewSheet';
import { NoteBody } from '../components/notes/NoteBody';
import { NoteCopyButton } from '../components/notes/NoteCopyButton';
import { NoteBodyEditor } from '../components/notes/NoteBodyEditor';
import type { NoteEditorView } from '../components/notes/NoteBodyEditor';
import { NoteConflictDialog } from '../components/notes/NoteConflictDialog';
import { NoteContextDialog } from '../components/notes/NoteContextDialog';
import { NoteExportDialog } from '../components/notes/NoteExportDialog';
import { NoteGenerationContext } from '../components/notes/NoteGenerationContext';
import { NoteProvenance } from '../components/notes/NoteProvenance';
import { NoteSourceMedia } from '../components/notes/NoteSourceMedia';
import { NoteStatusChip } from '../components/notes/NoteStatusChip';
import { RegenerateMenuButton } from '../components/notes/RegenerateMenuButton';
import { RegenerateNoteDialogContainer } from '../components/notes/RegenerateNoteDialogContainer';
import { RegenerateSameConfirmDialog } from '../components/notes/RegenerateSameConfirmDialog';
import { useAiConfig } from '../hooks/useAiConfig';
import { useGraphProposal } from '../hooks/useGraphProposal';
import { useNoteTemplateDetail } from '../hooks/useNoteTemplates';
import { NOTE_ACTIVE_POLL_MS, isNoteInFlight, useNote } from '../hooks/useNotes';
import { usePermissions } from '../hooks/usePermissions';
import { useUnsavedChangesWarning } from '../hooks/useUnsavedChangesWarning';
import { ApiError } from '../services/api';
import { connectNoteStream, describeStreamError } from '../services/noteGenerationStream';
import type { SseConnection } from '../services/noteGenerationStream';
import { effectiveBodyFormat } from '../services/noteTemplates';
import {
  getNote,
  noteConflictCurrentVersion,
  noteConflictReason,
  regenerateNote,
  retitleNote,
  updateNote,
} from '../services/notes';
import type { NoteStatus, RegenerateNoteInput } from '../services/notes';

const SUGGEST_TITLE_LABEL = 'Suggest a title';

/**
 * How long this page keeps polling for a title it asked for.
 *
 * ⚠ A BOUND, NOT A DEADLINE THE JOB KNOWS ABOUT. `note.retitle` is queue work
 * and will finish whenever it finishes; this number only decides how long the
 * page keeps ASKING. Without it a `ready` note — which `useNote` does not poll
 * at all — would poll every five seconds forever the moment a retitle job
 * failed, because the title it is waiting for is never going to change. When it
 * expires the page says so rather than falling silent.
 */
const RETITLE_WATCH_MS = 90_000;

/**
 * Why "Suggest a title" cannot be pressed right now, or `undefined`.
 *
 * Returned as PROSE because it is rendered as the menu item's own secondary
 * text — see the item for why a tooltip would not do. `undefined` is the only
 * value that means "pressable", so the item and its reason can never disagree.
 */
function suggestTitleBlockedReason(
  status: NoteStatus,
  pending: boolean,
): string | undefined {
  if (pending) return 'A title is already on its way';

  switch (status) {
    case 'draft':
    case 'generating':
      // The generation names the note itself when it commits, and the API
      // answers this route a 409 until it does.
      return 'Available once this note has finished generating';
    case 'failed':
      return 'This note has no content to take a title from';
    case 'deleting':
      return 'This note is being deleted';
    default:
      return undefined;
  }
}

export function NotePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { hasPermission } = usePermissions();
  /**
   * `notes:write` — the exact string `notes.controller.ts` enforces on
   * `POST /api/notes/{id}/retitle`, read the same way `TranscriptPage` and
   * `HomePage` read theirs. A control a role can never use is noise, so with
   * the permission absent the whole overflow menu is absent rather than being
   * an affordance that 403s.
   */
  const canWriteNotes = hasPermission('notes:write');

  // --- "Suggest a title" (#185, epic #163) ---------------------------------
  /** The POST itself is in flight. Seconds, not the wait for the title. */
  const [isSuggestingTitle, setIsSuggestingTitle] = useState(false);
  /**
   * The title this page had when the job was queued, or `null` when it is not
   * waiting for one.
   *
   * ⚠ THE OLD TITLE IS THE WHOLE STATE MACHINE. The 202 carries a job id and no
   * title (see `retitleNote`), so "has it landed?" can only be answered by
   * comparing what the note says now against what it said when we asked. A
   * boolean would have nothing to compare against and would have to guess.
   */
  const [retitleWatch, setRetitleWatch] = useState<string | null>(null);
  const [retitleNotice, setRetitleNotice] = useState<string | null>(null);
  const [retitleError, setRetitleError] = useState<string | null>(null);
  const [pageMenuAnchor, setPageMenuAnchor] = useState<HTMLElement | null>(null);

  const retitlePending = isSuggestingTitle || retitleWatch !== null;

  /**
   * ⚠ THE POLL OVERRIDE IS THE REFRESH MECHANISM, AND IT IS THE PAGE'S OWN.
   *
   * `useNote` already polls, but only while the note is `draft`/`generating` —
   * a `ready` note changes for nobody, so the interval it derives is `0`. A
   * retitle is the one thing that changes a ready note with nobody touching it,
   * so this hands the hook the same `NOTE_ACTIVE_POLL_MS` it would have derived
   * for itself, for exactly as long as there is something to wait for. Nothing
   * new was invented: the override parameter and the visibility-aware interval
   * behind it are the ones `useNote` has always exposed.
   */
  const { note, isLoading, error, refresh, setNote } = useNote(
    id,
    retitleWatch !== null ? NOTE_ACTIVE_POLL_MS : undefined,
  );
  const { config: aiConfig, keyConfigured, isLoading: isAiLoading } = useAiConfig();
  // Straight off the note since #192 — the API denormalises the source's name
  // onto the detail shape, so the page no longer resolves it with a second
  // request. `null` covers both "gone" and "no longer readable by you", which
  // both render the category noun.
  const sourceName = note?.sourceName ?? null;
  /**
   * The template this note was generated from, for the context panel (#109).
   *
   * ⚠ CALLED WITH `note?.templateId`, WHICH IS `undefined` UNTIL THE NOTE
   * LANDS — and `useNoteTemplateDetail` answers `idle` with no request for
   * that, which is why this can sit above the page's early returns without
   * either breaking the rules of hooks or firing a request for an id nobody
   * has yet.
   */
  const templateDetail = useNoteTemplateDetail(note?.templateId);

  /**
   * The graph proposal review sheet (#367). Visible only to `graph:read` on a
   * deployment with connected knowledge switched on — `graphEnabled`
   * undefined (an older API) reads as "not on", so the page is unchanged.
   * The proposal is read here rather than inside the sheet so the entry
   * button's badge and the sheet share one request and one poll.
   */
  const graphVisible = hasPermission('graph:read') && aiConfig?.graphEnabled === true;
  const graphProposal = useGraphProposal(
    { noteId: id ?? '' },
    { enabled: graphVisible && Boolean(id) },
  );
  const [reviewOpen, setReviewOpen] = useState(false);
  /** #368: the extract / re-extract dialog, mounted only while open. */
  const [extractMode, setExtractMode] = useState<'extract' | 're-extract' | null>(null);
  const canWriteGraph = hasPermission('graph:write');
  /** #368: the row "Add to graph" just created, scrolled to in the sheet. */
  const [focusItemId, setFocusItemId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const reviewRequested = searchParams.get('review') === '1';

  /** `?review=1` opens the sheet once, then leaves the URL (`replace`). */
  useEffect(() => {
    if (!reviewRequested || isAiLoading) return;
    if (graphVisible) setReviewOpen(true);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('review');
        return next;
      },
      { replace: true },
    );
  }, [graphVisible, isAiLoading, reviewRequested, setSearchParams]);

  /** The buffer the stream has produced, offset-reconciled by the service. */
  const [streamed, setStreamed] = useState('');
  /**
   * Whether this page holds a live connection.
   *
   * Distinct from "is the note in flight": the user can stop watching a note
   * that is very much still being written, which is the whole point of the stop
   * affordance.
   */
  const [watching, setWatching] = useState(true);
  const [streamError, setStreamError] = useState<string | null>(null);

  // --- Editing -------------------------------------------------------------
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [editorView, setEditorView] = useState<NoteEditorView>('visual');
  /** The rendered body, read by the copy controls at click time (issue #334). */
  const renderedBodyRef = useRef<HTMLDivElement | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // --- The title, edited in place ------------------------------------------
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [titleError, setTitleError] = useState<string | null>(null);

  // --- The 409 -------------------------------------------------------------
  const [conflict, setConflict] = useState<
    { baseVersion: number; currentVersion: number | null; theirs: string | null } | null
  >(null);

  // --- Leaving with unsaved work -------------------------------------------
  const [pendingLeave, setPendingLeave] = useState<string | null>(null);

  // --- The other two dialogs -----------------------------------------------
  const [exportOpen, setExportOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  // #312: `same` is the one-click "same again" confirmation, `options` the full
  // dialog. `optionsFocus` records which door opened `options`.
  const [regenerateMode, setRegenerateMode] = useState<'closed' | 'same' | 'options'>('closed');
  const [optionsFocus, setOptionsFocus] = useState<'template' | undefined>(undefined);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);

  const inFlight = note ? isNoteInFlight(note.status) : false;
  const isDirty = isEditing && note !== null && draft !== note.body;

  // The browser's own confirmation. The in-app half is `pendingLeave` below.
  useUnsavedChangesWarning(isDirty);

  // Reset EVERYTHING page-shaped when the note changes. `/notes/a` →
  // `/notes/b` must not render a's half-streamed buffer or a's draft under b's
  // heading, and must not inherit a's "you stopped watching" state either.
  useEffect(() => {
    setStreamed('');
    setStreamError(null);
    setWatching(true);
    setIsEditing(false);
    setDraft('');
    setSaveError(null);
    setTitleDraft(null);
    setConflict(null);
    setPageMenuAnchor(null);
    setRetitleWatch(null);
    setRetitleNotice(null);
    setRetitleError(null);
    setReviewOpen(false);
  }, [id]);

  /**
   * The suggested title has landed.
   *
   * ⚠ IT IS DETECTED, NOT DELIVERED. `note.retitle` settles in the queue with
   * nobody watching, so the only signal this page gets is the poll above
   * bringing back a row whose title is not the one we asked about. Clearing the
   * watch is what stops that poll — this effect is the loop's exit condition,
   * not a nicety.
   */
  useEffect(() => {
    if (retitleWatch === null || !note) return;
    if (note.title === retitleWatch) return;

    setRetitleWatch(null);
    setRetitleNotice('Title updated.');
  }, [note, retitleWatch]);

  /**
   * Stop waiting eventually, and SAY SO.
   *
   * The deadline is reset only when a new watch begins — `retitleWatch` holds a
   * title, so it does not change while the wait is running. A job that failed,
   * or one that decided the note was already best named what it was, both look
   * identical from here: the title never changes. Falling silent would leave a
   * spinner up forever; this replaces it with a sentence that is true either
   * way.
   */
  useEffect(() => {
    if (retitleWatch === null) return;

    const timer = window.setTimeout(() => {
      setRetitleWatch(null);
      setRetitleNotice(
        'Still working on a title. It will appear here, or the next time you open this note.',
      );
    }, RETITLE_WATCH_MS);

    return () => window.clearTimeout(timer);
  }, [retitleWatch]);

  useEffect(() => {
    if (!id || !inFlight || !watching) return;

    const connection: SseConnection = connectNoteStream(id, {
      onContent: setStreamed,
      // Re-read rather than trust the buffer: the committed body is what the
      // job wrote, `currentVersion` moved, and the status is no longer
      // `generating`. The buffer and the row agree in the normal case; the row
      // is the one that is true.
      onDone: () => {
        void refresh();
      },
      onError: (failure) => {
        setStreamError(describeStreamError(failure));
        // The note's own `failureReason` is the durable record of this, and it
        // is what a reload will show.
        void refresh();
      },
    });

    // ⚠ THE TEARDOWN IS LOAD-BEARING, not hygiene. Navigating away mid-stream
    // must close the socket.
    return () => connection.close();
  }, [id, inFlight, refresh, watching]);

  // ---------------------------------------------------------------------------
  // Editing the body
  // ---------------------------------------------------------------------------

  const startEditing = useCallback(() => {
    if (!note) return;
    setDraft(note.body);
    // Issue #334: the visual editor is the default for a markdown note. A
    // plain-text note has only a textarea, so its view is irrelevant.
    setEditorView('visual');
    setSaveError(null);
    setIsEditing(true);
  }, [note]);

  const cancelEditing = useCallback(() => {
    setIsEditing(false);
    setDraft('');
    setSaveError(null);
  }, []);

  /**
   * Save, and treat the refusal as the thing it is.
   *
   * ⚠ `baseVersion` IS THE VERSION THIS DRAFT WAS OPENED AGAINST, read off the
   * note the page is holding. Sending anything else — a version re-read at save
   * time, say — would defeat the check entirely: the whole point is to send the
   * number the user's text is based on and let the server decide.
   */
  const save = useCallback(async () => {
    if (!id || !note) return;

    const baseVersion = note.currentVersion;

    setIsSaving(true);
    setSaveError(null);

    try {
      const saved = await updateNote(id, { body: draft, baseVersion });

      setNote(saved);
      setIsEditing(false);
      setDraft('');
    } catch (err) {
      const reason = noteConflictReason(err);

      if (reason === 'stale_base_version') {
        // Open the dialog IMMEDIATELY with what the 409 itself carried, then
        // fill in the other body when the re-read lands. A conflict dialog that
        // waited for a second round trip would leave the user staring at a
        // spinner over their own unsaved text.
        setConflict({
          baseVersion,
          currentVersion: noteConflictCurrentVersion(err),
          theirs: null,
        });

        try {
          const fresh = await getNote(id);

          setNote(fresh);
          setConflict((current) =>
            current === null
              ? null
              : {
                  ...current,
                  currentVersion: current.currentVersion ?? fresh.currentVersion,
                  theirs: fresh.body,
                },
          );
        } catch {
          // The dialog still works: it names the version, shows the user's own
          // text and offers the copy. Only the other half is missing, and it
          // says so rather than claiming the note is empty.
          setConflict((current) =>
            current === null ? null : { ...current, theirs: null },
          );
        }

        return;
      }

      if (reason === 'generating') {
        setSaveError(
          'This note is being written right now. Your text is still here — save again once the generation finishes.',
        );

        return;
      }

      setSaveError(
        err instanceof ApiError ? err.message : 'Your changes could not be saved',
      );
    } finally {
      setIsSaving(false);
    }
  }, [draft, id, note, setNote]);

  /** Take the server's version and lose the draft. Only ever a user's choice. */
  const discardAndReload = useCallback(() => {
    setConflict(null);
    setIsEditing(false);
    setDraft('');
    setSaveError(null);
    void refresh();
  }, [refresh]);

  // ---------------------------------------------------------------------------
  // Editing the title
  // ---------------------------------------------------------------------------

  /**
   * ⚠ A RENAME SENDS NO `baseVersion` AND CREATES NO VERSION. The API is
   * explicit about it: a title is metadata about the note, not content of it,
   * so recording a rename would put a no-op in the history that a later restore
   * could "undo" into a name nobody chose.
   */
  const saveTitle = useCallback(async () => {
    if (!id || !note || titleDraft === null) return;

    const next = titleDraft.trim();

    if (next.length === 0 || next === note.title) {
      setTitleDraft(null);
      setTitleError(null);

      return;
    }

    try {
      const saved = await updateNote(id, { title: next });

      setNote(saved);
      setTitleDraft(null);
      setTitleError(null);
    } catch (err) {
      setTitleError(
        err instanceof ApiError ? err.message : 'The title could not be changed',
      );
    }
  }, [id, note, setNote, titleDraft]);

  /**
   * Ask the API to name this note from what it actually says (#185).
   *
   * ⚠ NOTHING IS WAITED ON. `POST /api/notes/{id}/retitle` is a **202**: it
   * queues `note.retitle` and returns, so the title on screen is still the old
   * one when this resolves. Blocking the menu — or the page — until a new title
   * appeared would be holding the UI open across a provider round trip that is
   * explicitly designed not to need one.
   *
   * ⚠ IT IS OFFERED FOR A NOTE THE USER NAMED THEMSELVES, on purpose. This is
   * the one route that overrides a `titleSource: 'user'` title, because pressing
   * this button IS the explicit request about this note; the bulk sweep is the
   * one that leaves a chosen name alone. See `retitleNote`'s own header.
   */
  const suggestTitle = useCallback(async () => {
    if (!id || !note || retitlePending) return;

    const previousTitle = note.title;

    setPageMenuAnchor(null);
    setIsSuggestingTitle(true);
    setRetitleError(null);
    setRetitleNotice(null);

    try {
      await retitleNote(id);

      // Only NOW does the wait begin — and the title it is measured against is
      // the one read a moment ago, before any poll could have moved it.
      setRetitleWatch(previousTitle);
      setRetitleNotice('Suggesting a title… you can keep working, or close this page.');
    } catch (err) {
      // A 409 here is not a failure of anything the user did: the generation
      // that is running names the note itself when it commits.
      if (noteConflictReason(err) === 'generating') {
        setRetitleError(
          'This note is being generated right now — the generation will name it when it finishes.',
        );

        return;
      }

      setRetitleError(
        err instanceof ApiError ? err.message : 'A title could not be suggested',
      );
    } finally {
      setIsSuggestingTitle(false);
    }
  }, [id, note, retitlePending]);

  // ---------------------------------------------------------------------------
  // Regeneration
  // ---------------------------------------------------------------------------

  /**
   * Regenerate with whatever the dialog decided to change (#109).
   *
   * ⚠ THE INPUT IS A DIFF THE DIALOG BUILT, NOT THIS PAGE'S STATE. An unchanged
   * confirmation hands over `{}` — byte-for-byte the request #58 sent — so the
   * "same again" path is untouched by this feature. See `regenerateInput.ts`.
   */
  const handleRegenerate = useCallback(async (input: RegenerateNoteInput) => {
    if (!id) return;

    setIsRegenerating(true);
    setRegenerateError(null);
    setStreamError(null);
    setStreamed('');

    try {
      const result = await regenerateNote(id, input);

      // Adopt the returned row immediately — it is already `generating` — so
      // the stream effect re-opens on this render rather than after a poll.
      setNote(result.note);
      setWatching(true);
      setRegenerateMode('closed');
    } catch (err) {
      // ⚠ `template_required` IS A QUESTION, NOT A FAILURE — AND THE DIALOG
      // STAYS OPEN. The note's template row is gone, the API cannot guess a
      // replacement, and the one control that can answer is the select the user
      // is already looking at. Closing the dialog to show this on the page
      // would put the answer and the question on different screens.
      //
      // From the one-click confirmation (#312) there IS no select to answer
      // with, so the full dialog takes over, carrying the same question.
      if (noteConflictReason(err) === 'template_required') {
        setRegenerateError('Choose a template to regenerate with');
        setRegenerateMode((mode) => (mode === 'same' ? 'options' : mode));
        setOptionsFocus('template');

        return;
      }

      setRegenerateError(
        err instanceof ApiError ? err.message : 'The note could not be regenerated',
      );
    } finally {
      setIsRegenerating(false);
    }
  }, [id, setNote]);

  const openRegenerateSame = useCallback(() => {
    setRegenerateError(null);
    setRegenerateMode('same');
  }, []);

  const openRegenerateOptions = useCallback(() => {
    setRegenerateError(null);
    setOptionsFocus('template');
    setRegenerateMode('options');
  }, []);

  const closeRegenerate = useCallback(() => {
    setRegenerateMode('closed');
    setRegenerateError(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Leaving the page with unsaved work
  // ---------------------------------------------------------------------------

  /**
   * Intercept an in-app link while the editor is dirty.
   *
   * The link keeps its `href` — so it is still a real link, still
   * middle-clickable and still readable by assistive technology — and the
   * default is prevented only when there is something to lose.
   */
  const guardLeaving = useCallback(
    (to: string) => (event: { preventDefault: () => void }) => {
      if (!isDirty) return;

      event.preventDefault();
      setPendingLeave(to);
    },
    [isDirty],
  );

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress aria-label="Loading this note" />
      </Box>
    );
  }

  if (error || !note) {
    return (
      <Box sx={{ maxWidth: 900, mx: 'auto' }}>
        <Alert severity="error">{error ?? 'This note could not be loaded'}</Alert>
      </Box>
    );
  }

  // The streamed buffer while it is being written; the committed body after.
  // Never both, and never the buffer once the row has the real thing.
  const body = inFlight && streamed ? streamed : note.body;
  const canEdit = !inFlight && note.status !== 'deleting';
  const bodyFormat = effectiveBodyFormat(note.bodyFormat);

  // `undefined` means pressable — see `suggestTitleBlockedReason`.
  const suggestTitleReason = suggestTitleBlockedReason(note.status, retitlePending);
  const canSuggestTitle = suggestTitleReason === undefined;

  return (
    <Box
      sx={{
        maxWidth: 900,
        mx: 'auto',
        // #367: at `lg` and up the note moves aside for the review sheet; below
        // it the sheet overlays. A responsive sx value, not a media-query read.
        mr: { lg: reviewOpen ? `${REVIEW_SHEET_WIDTH}px` : 'auto' },
      }}
    >
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1}
        sx={{ alignItems: { sm: 'flex-start' }, justifyContent: 'space-between', mb: 1 }}
      >
        {titleDraft === null ? (
          <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
            <Typography variant="h5" component="h1" sx={{ minWidth: 0 }}>
              {note.title}
            </Typography>
            <Tooltip title="Rename this note">
              <IconButton
                size="small"
                aria-label="Rename this note"
                onClick={() => {
                  setTitleDraft(note.title);
                  setTitleError(null);
                }}
              >
                <EditIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          </Stack>
        ) : (
          <Box
            component="form"
            sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flex: 1, minWidth: 0 }}
            onSubmit={(event) => {
              event.preventDefault();
              void saveTitle();
            }}
          >
            <TextField
              size="small"
              fullWidth
              autoFocus
              label="Title"
              value={titleDraft}
              error={titleError !== null}
              helperText={titleError ?? undefined}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                // Escape abandons the rename. A title edit holds no versioned
                // content, so there is nothing here worth a confirmation.
                if (event.key === 'Escape') {
                  setTitleDraft(null);
                  setTitleError(null);
                }
              }}
            />
            <IconButton size="small" type="submit" aria-label="Save the title">
              <CheckIcon fontSize="inherit" />
            </IconButton>
            <IconButton
              size="small"
              aria-label="Cancel renaming"
              onClick={() => {
                setTitleDraft(null);
                setTitleError(null);
              }}
            >
              <CloseIcon fontSize="inherit" />
            </IconButton>
          </Box>
        )}

        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}
        >
          <NoteStatusChip status={note.status} />
          {/* Copying is a READ, like Export — available whenever there is a
              settled body to copy, and never while it is still being written. */}
          <NoteCopyButton
            markdown={note.body}
            getRendered={() => renderedBodyRef.current}
            bodyFormat={bodyFormat}
            disabled={inFlight || isEditing}
          />
          <Button
            size="small"
            startIcon={<FileDownloadOutlinedIcon />}
            onClick={() => setExportOpen(true)}
            // Exporting is a READ. It stays available with no AI key, and while
            // a regeneration is running — an export names the version it
            // rendered, so there is no ambiguity about what came out.
            disabled={note.currentVersion === 0}
          >
            Export
          </Button>
          <Button
            size="small"
            startIcon={<HistoryIcon />}
            component={RouterLink}
            to={`/notes/${note.id}/history`}
            onClick={guardLeaving(`/notes/${note.id}/history`)}
          >
            History
          </Button>
          {graphVisible && (
            <GraphReviewButton
              summary={graphProposal.detail === undefined ? undefined : (graphProposal.detail?.proposal ?? null)}
              open={reviewOpen}
              onClick={() => setReviewOpen((value) => !value)}
            />
          )}
          {/* ⚠ THE WHOLE MENU IS GATED, not just the item inside it — with
              `notes:write` absent there is nothing in it to open. */}
          {canWriteNotes && (
            <IconButton
              size="small"
              aria-label="Note actions"
              onClick={(event) => setPageMenuAnchor(event.currentTarget)}
            >
              <MoreVertIcon fontSize="inherit" />
            </IconButton>
          )}
        </Stack>
      </Stack>

      {canWriteNotes && (
        <Menu
          anchorEl={pageMenuAnchor}
          open={Boolean(pageMenuAnchor)}
          onClose={() => setPageMenuAnchor(null)}
        >
          <MenuItem
            // `aria-disabled`, not `disabled`, the same choice `TranscriptPage`
            // makes and for the same reason: a `disabled` MenuItem is skipped
            // by the menu's own keyboard navigation, so the reason underneath
            // it would be unreachable for the user most likely to need it read
            // out. The click handler is what actually refuses.
            aria-disabled={!canSuggestTitle || undefined}
            onClick={() => {
              if (!canSuggestTitle) return;
              void suggestTitle();
            }}
          >
            <ListItemText
              primary={SUGGEST_TITLE_LABEL}
              // The reason rides in the item's own accessible name rather than
              // a tooltip: a tooltip inside an open menu is announced by almost
              // nothing.
              secondary={suggestTitleReason}
              slotProps={
                canSuggestTitle ? undefined : { primary: { color: 'text.disabled' } }
              }
            />
          </MenuItem>
        </Menu>
      )}

      {/* ⚠ A LIVE REGION THAT IS ALWAYS MOUNTED. The queued state has to be
          ANNOUNCED, not merely shown — the title changes minutes later, with no
          other signal — and a `role="status"` inserted at the same moment as
          its text is frequently not announced at all. Empty, it costs no
          height. `polite`, never `assertive`: this must not talk over the note
          somebody is reading. Same shape as `SaveIndicator`. */}
      <Box
        role="status"
        aria-live="polite"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          mb: retitleNotice || retitlePending ? 1 : 0,
        }}
      >
        {retitlePending && <CircularProgress size={12} aria-hidden />}
        {retitleNotice && (
          <Typography variant="caption" color="text.secondary">
            {retitleNotice}
          </Typography>
        )}
      </Box>

      {/* ⚠ ON SCREEN, NOT IN A MENU. The epic's trust-and-provenance premise
          made concrete — see `NoteProvenance`'s own header. */}
      <Box sx={{ mb: 2 }}>
        <NoteProvenance note={note} sourceName={sourceName} />
      </Box>

      {/* The recording itself, one press away (#309). Lazy: nothing is signed
          until Play is pressed. Keyed so a different origin gets a fresh player. */}
      {note.originTranscript ? (
        <NoteSourceMedia key={note.originTranscript.id} origin={note.originTranscript} />
      ) : null}

      {/* The long form of the same question (#109): the template's actual
          recipe, the free-text context — which is rendered NOWHERE else in this
          application — and the model. Collapsed, directly under the sentence it
          expands on; see `NoteGenerationContext`'s own header for why the two
          are not one control. */}
      <NoteGenerationContext
        note={note}
        sourceName={sourceName}
        template={templateDetail.template}
        templateState={templateDetail.state}
        templateError={templateDetail.error}
        onOpenContext={() => setContextOpen(true)}
      />

      {inFlight && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={1.5}
            sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
          >
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" component="h2">
                {watching ? 'Writing your note…' : 'Still writing in the background'}
              </Typography>
              {/* THE HONEST SENTENCE. Said whether or not the user is watching,
                  because the thing it promises is true either way. */}
              <Typography variant="caption" color="text.secondary">
                You can close this page — the note keeps being written and a
                notification will arrive when it is ready.
              </Typography>
            </Box>
            {watching && (
              <Button
                size="small"
                startIcon={<StopCircleIcon />}
                onClick={() => setWatching(false)}
                sx={{ flexShrink: 0 }}
              >
                Stop watching
              </Button>
            )}
          </Stack>
          {watching && <LinearProgress aria-hidden sx={{ mt: 1.5 }} />}
        </Paper>
      )}

      {note.status === 'failed' && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            keyConfigured ? (
              <RegenerateMenuButton
                note={note}
                color="inherit"
                size="small"
                variant="outlined"
                disabled={isRegenerating}
                onRegenerateSame={openRegenerateSame}
                onRegenerateWithOptions={openRegenerateOptions}
              />
            ) : undefined
          }
        >
          <AlertTitle>This note could not be generated</AlertTitle>
          {/* The RECORDED reason, in this order: the row (durable, survives a
              reload), then the frame (seen seconds earlier), then — only if
              neither exists — a sentence that at least says where to look. */}
          {note.failureReason ??
            streamError ??
            'Your AI provider did not return a note, and recorded no reason. Try again.'}
        </Alert>
      )}

      {/* A stream error that has NOT (yet) become a failed row. */}
      {streamError && note.status !== 'failed' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {streamError}
        </Alert>
      )}

      {regenerateError && regenerateMode === 'closed' && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {regenerateError}
        </Alert>
      )}

      {saveError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {saveError}
        </Alert>
      )}

      {retitleError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {retitleError}
        </Alert>
      )}

      <Paper
        variant="outlined"
        sx={{ p: { xs: 2, sm: 3 } }}
        // ⚠ THE LIVE REGION. `polite`, so a screen-reader user hears the note
        // arriving without it interrupting whatever they are reading, and
        // `aria-busy` while it is still being written.
        component="section"
        role="region"
        aria-label="Note"
        aria-live="polite"
        aria-busy={inFlight}
      >
        {isEditing ? (
          <Stack spacing={2}>
            <NoteBodyEditor
              value={draft}
              onChange={setDraft}
              view={editorView}
              onViewChange={setEditorView}
              bodyFormat={bodyFormat}
              disabled={isSaving}
            />
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              sx={{ alignItems: { sm: 'center' }, justifyContent: 'space-between' }}
            >
              {/* NO AUTOSAVE, SAID OUT LOUD. A user who expects one and does
                  not get it loses work; this is the cheapest possible way to
                  stop that, and it also explains why the history stays
                  readable. */}
              <Typography variant="caption" color="text.secondary">
                Saving records a new version — there is no autosave, so nothing is
                written until you press Save.
              </Typography>
              <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
                <Button onClick={cancelEditing} disabled={isSaving}>
                  Cancel
                </Button>
                <Button
                  variant="contained"
                  onClick={() => void save()}
                  disabled={isSaving || !isDirty}
                >
                  {isSaving ? 'Saving…' : 'Save'}
                </Button>
              </Stack>
            </Stack>
          </Stack>
        ) : body ? (
          <>
            <NoteBody ref={renderedBodyRef} bodyFormat={bodyFormat}>
              {body}
            </NoteBody>
            {canEdit && (
              <>
                <Divider sx={{ my: 2 }} />
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Button size="small" startIcon={<EditIcon />} onClick={startEditing}>
                    Edit
                  </Button>
                  <NoteCopyButton
                    variant="icon"
                    markdown={note.body}
                    getRendered={() => renderedBodyRef.current}
                    bodyFormat={bodyFormat}
                  />
                </Stack>
              </>
            )}
          </>
        ) : inFlight ? (
          <Typography color="text.secondary">
            Waiting for the first words from your AI provider…
          </Typography>
        ) : (
          <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
            <Typography color="text.secondary">This note is empty.</Typography>
            {canEdit && (
              <Button size="small" startIcon={<EditIcon />} onClick={startEditing}>
                Edit
              </Button>
            )}
          </Stack>
        )}
      </Paper>

      {note.currentVersion > 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="caption" color="text.secondary">
            Version {note.currentVersion}
            {note.provider ? ` · generated by ${note.provider}` : ''}
          </Typography>
        </>
      )}

      {/* ⚠ THE REGENERATE CONTROL, AND THE ONE THING THAT REPLACES IT. Reading,
          editing and exporting above are untouched by a missing key. */}
      {!isAiLoading && note.status !== 'failed' && (
        <Box sx={{ mt: 3 }}>
          {keyConfigured ? (
            <Stack spacing={1} sx={{ alignItems: 'flex-start' }}>
              <RegenerateMenuButton
                note={note}
                variant="outlined"
                disabled={inFlight || isRegenerating}
                onRegenerateSame={openRegenerateSame}
                onRegenerateWithOptions={openRegenerateOptions}
              />
              <Typography variant="caption" color="text.secondary">
                Writes this note again on your own AI account. The current text is kept as
                a version.
              </Typography>
            </Stack>
          ) : (
            <AiKeyRequired />
          )}
        </Box>
      )}
      {!isAiLoading && note.status === 'failed' && !keyConfigured && (
        <Box sx={{ mt: 3 }}>
          <AiKeyRequired />
        </Box>
      )}

      <NoteConflictDialog
        open={conflict !== null}
        baseVersion={conflict?.baseVersion ?? note.currentVersion}
        currentVersion={conflict?.currentVersion ?? null}
        mine={draft}
        theirs={conflict?.theirs ?? null}
        onKeepEditing={() => setConflict(null)}
        onDiscardAndReload={discardAndReload}
      />

      {/* Mounted only while open: the prompt can be megabytes, and simply
          reading a note must not download it (issue #308). */}
      {contextOpen && (
        <NoteContextDialog
          open
          noteId={note.id}
          noteTitle={note.title}
          generationId={note.currentGenerationId ?? undefined}
          onClose={() => setContextOpen(false)}
        />
      )}

      <NoteExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        noteId={note.id}
        currentVersion={note.currentVersion}
      />

      {/* ⚠ MOUNTED ONLY WHILE OPEN. The container owns the two template reads
          the dialog needs, so simply READING a note — which is what this page
          is for — issues neither. See the container's own header. */}
      {/* #312: the one-click confirmation reads nothing and sends `{}`. Mounted
          only while open, so switching to the options dialog replaces it at
          once rather than stacking two dialogs through a close transition. */}
      {regenerateMode === 'same' && (
        <RegenerateSameConfirmDialog
          open
          note={note}
          busy={isRegenerating}
          error={regenerateError}
          onCancel={closeRegenerate}
          onConfirm={() => void handleRegenerate({})}
          onChangeOptions={() => {
            setRegenerateError(null);
            setOptionsFocus(undefined);
            setRegenerateMode('options');
          }}
        />
      )}
      {regenerateMode === 'options' && (
        <RegenerateNoteDialogContainer
          open
          note={note}
          models={aiConfig?.models ?? []}
          defaultModel={aiConfig?.defaultModel ?? null}
          busy={isRegenerating}
          error={regenerateError}
          initialFocus={optionsFocus}
          onCancel={closeRegenerate}
          onConfirm={(input) => void handleRegenerate(input)}
        />
      )}

      {graphVisible && id && (
        <ProposalReviewSheet
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          source={{ noteId: id }}
          proposal={graphProposal}
          noteBodyRef={renderedBodyRef}
          originTranscriptId={note.originTranscript?.id ?? null}
          focusItemId={focusItemId}
          onRequestExtract={canWriteGraph ? (mode) => setExtractMode(mode) : undefined}
          headerSlot={
            <GuidanceSummary
              guidance={graphProposal.detail?.proposal.userGuidance}
              items={graphProposal.detail?.items}
              onEdit={canWriteGraph ? () => setExtractMode('re-extract') : undefined}
            />
          }
        />
      )}

      {/* #368: "Add to graph" from a selection in the rendered body — never
          while editing (the editor has its own selection semantics) or while
          the body is still being written (it is not a version yet). */}
      {graphVisible && canWriteGraph && id && (
        <GraphSelectionAdd
          containerRef={renderedBodyRef}
          enabled={!isEditing && !inFlight && note.currentVersion > 0}
          resolve={(range, container) =>
            resolveNoteSelection(range, container, {
              noteId: id,
              noteVersion: note.currentVersion,
              markdown: note.body,
            })
          }
          target={{
            kind: 'note',
            detail: graphProposal.detail,
            onExtract: () => setExtractMode(graphProposal.detail ? 're-extract' : 'extract'),
          }}
          onReload={() => void refresh()}
          onAdded={(result) => {
            setFocusItemId(result.item.id);
            void graphProposal.refresh();
            setReviewOpen(true);
          }}
        />
      )}

      {graphVisible && canWriteGraph && id && extractMode && (
        <ExtractDialog
          open
          onClose={() => setExtractMode(null)}
          noteId={id}
          mode={extractMode}
          initialGuidance={graphProposal.detail?.proposal.userGuidance ?? null}
          pendingDecisions={
            graphProposal.detail?.proposal.status === 'draft'
              ? userDecisionCount(graphProposal.detail.items)
              : 0
          }
          items={graphProposal.detail?.items}
          submit={(_noteId, body) => graphProposal.requestExtract(body)}
          onStarted={() => setReviewOpen(true)}
        />
      )}

      <Dialog
        open={pendingLeave !== null}
        onClose={() => setPendingLeave(null)}
        aria-labelledby="note-leave-title"
      >
        <DialogTitle id="note-leave-title">Leave without saving?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This note has changes you have not saved. There is no autosave — leaving now
            loses them.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={() => setPendingLeave(null)}>
            Stay and keep editing
          </Button>
          <Button
            color="error"
            onClick={() => {
              const to = pendingLeave;

              setPendingLeave(null);
              setIsEditing(false);
              setDraft('');

              if (to) navigate(to);
            }}
          >
            Leave and lose them
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default NotePage;
