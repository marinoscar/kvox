/**
 * `/notes/new` — source, template, context, generate. Issue #57, epic #45.
 *
 * =============================================================================
 * THREE STEPS, ONE SCREEN WHERE THERE IS ROOM
 * =============================================================================
 *
 * At `sm` and up all three are visible at once, because they are not a
 * sequence: a user arriving from a transcript already has step 1 answered, and
 * making them press Next past a filled-in field to reach a template picker is
 * ceremony. Below `sm` the same three components go into a vertical `Stepper`,
 * because a phone cannot show three panels and a wall of half-visible form is
 * worse than one question at a time.
 *
 * ONE SET OF COMPONENTS, TWO CONTAINERS. The steps are rendered from the same
 * three functions in both layouts rather than written twice — a second copy is
 * how the phone form quietly loses a field.
 *
 * =============================================================================
 * ⚠ THE AI KEY GATE COMES FIRST, AND IT IS THE SHARED COMPONENT
 * =============================================================================
 *
 * `ai.useAiState().keyConfigured` false renders `AiKeyRequired` (#55) and nothing
 * else — the rule that component's own header states for all four AI surfaces
 * in this epic. The same component is rendered again if `POST /api/notes`
 * answers **409 `ai_key_missing`** anyway, which is not belt-and-braces: the
 * probe and the submit are seconds apart and a key can be removed in another
 * tab between them, and a generic red "Conflict" for that would be the app
 * blaming the user for its own stale answer.
 *
 * =============================================================================
 * A DOCUMENT'S TEXT IS EXTRACTED BY A JOB, SO GENERATE WAITS FOR IT
 * =============================================================================
 *
 * Uploading answers immediately with `status: 'extracting'` and queues
 * `note.source.extract`. Generate stays disabled until the extraction has
 * actually produced text, because the alternative is a note that is created,
 * queued, and fails a minute later against the user's own provider account for
 * a reason this form could have seen coming. A document that cannot be read at
 * all (a scanned PDF, a password-protected one) reports the API's own stored
 * sentence rather than a generic failure — that sentence is the whole reason
 * the API stores one.
 *
 * =============================================================================
 * A DOCUMENT IS KEPT AS THE NOTE BY DEFAULT; REWRITING IT IS THE OPTION (#730)
 * =============================================================================
 *
 * Once a file is chosen the form asks what to do with it. "Keep it as my note"
 * (the default) imports the file itself as the note through the import-batch
 * routes (`importFilesAdHoc`): the server stores it, keeps the file as the
 * note's source, formats it, indexes it and adds it to the graph. Nothing is
 * uploaded until the user presses Import, and the template, model and context
 * steps are hidden because none of them applies. "Rewrite it with a template"
 * is the generation flow above, unchanged: the file is uploaded as a source
 * document only when this choice is made. A document the host already uploaded
 * (`?objectId=`) has no file in this browser to import, so it starts on
 * Rewrite and offers no choice.
 */

import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Step from '@mui/material/Step';
import StepContent from '@mui/material/StepContent';
import StepLabel from '@mui/material/StepLabel';
import Stepper from '@mui/material/Stepper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import { NOTE_IMPORT_ACCEPT, noteImportMimeTypeForExtension } from '@marinoscar/kvox-contract/notes';

import { ModelSelect } from '../components/ModelSelect.js';
import { KvoxApiError, useIsMounted, useKvoxHost, useKvoxTranscriptionEnabled } from '../../../core/headless/index.js';
import { useNoteTemplates } from '../../headless/hooks/useNoteTemplates.js';
import {
  MAX_TITLE_CHARS,
  NOTE_DOCUMENT_ACCEPT_LABEL,
  createNote,
  getNoteDocumentExtraction,
  getNotes,
  noteConflictReason,
  uploadNoteSourceDocument,
} from '../../headless/clients/notes.js';
import type { NoteDocumentExtraction, NoteListItem } from '../../headless/clients/notes.js';
import { getNoteTemplate } from '../../headless/clients/noteTemplates.js';
import type { NoteTemplate } from '../../headless/clients/noteTemplates.js';
import { getTranscripts } from '../../../transcripts/headless/index.js';
import type { TranscriptListItem } from '../../../transcripts/headless/index.js';
import {
  noteSourceKindsFor,
  buildNoteSource,
  buildNoteTitle,
  emptyNewNoteDraft,
  isNewNoteReady,
} from '../../headless/utils/newNote.js';
import type { NewNoteDraft } from '../../headless/utils/newNote.js';
import { useImportBatch, useImportBatchItems } from '../../headless/hooks/useNoteLibraries.js';
import { checkNoteImportFiles, importFilesAdHoc } from '../../headless/sync/librarySync.js';
import type { NoteImportRejectedFile } from '../../headless/sync/librarySync.js';
import { describeNoteImportFailure } from '../../headless/utils/noteImportFailure.js';
import { NO_NOTES_AI_ACCESS } from '../ai.js';
import type { NotesAiAccess } from '../ai.js';

/**
 * How often the form asks whether a document's text has been extracted.
 *
 * Two seconds, faster than any other poll in this app, because a person is
 * watching a spinner with nothing else to do: a text file extracts in
 * milliseconds and a short PDF in a second or two, so a five-second cadence
 * would mean staring at "Reading…" for four seconds after it finished.
 */
const EXTRACTION_POLL_MS = 2_000;

/** How many candidates each source picker offers. */
const PICKER_LIMIT = 50;

/** The manager #56 builds. Named once so the two links here cannot disagree. */
const TEMPLATE_MANAGER_PATH = '/settings/note-templates';

/** What the user wants done with a chosen document (#730). */
type DocumentAction = 'keep' | 'rewrite';

/** The two answers to "What should KVox do with it?", in the order they are offered. */
const DOCUMENT_ACTIONS: readonly { value: DocumentAction; label: string; hint: string }[] = [
  {
    value: 'keep',
    label: 'Keep it as my note',
    hint: 'Your document becomes the note, formatted for KVox. The original file stays linked.',
  },
  {
    value: 'rewrite',
    label: 'Rewrite it with a template',
    hint: "AI writes a new note from it in a template's shape.",
  },
];

/** Where a kept document's import stands, for the inline progress line. */
type KeepPhase = 'uploading' | 'importing' | 'formatting';

const KEEP_PHASE_LABELS: Readonly<Record<KeepPhase, string>> = {
  uploading: 'Uploading the document…',
  importing: 'Importing…',
  formatting: 'Formatting your note…',
};

/** The sentence for a file refused before any byte is sent. */
function rejectionSentence(reason: NoteImportRejectedFile['reason']): string {
  const code = reason === 'unsupported' ? 'unsupported_document' : reason === 'empty' ? 'empty_note' : 'too_large';
  return describeNoteImportFailure(code) ?? 'This file cannot be used.';
}

/**
 * The file, with a media type when the browser gave it none.
 *
 * The source-document route reads the part's media type, and most platforms map
 * no type to `.md` (and some none to `.docx`), so the extension decides.
 */
function withMediaType(file: File): File {
  if (file.type) return file;
  const dot = file.name.lastIndexOf('.');
  const type = dot >= 0 ? noteImportMimeTypeForExtension(file.name.slice(dot + 1)) : null;
  return type ? new File([file], file.name, { type, lastModified: file.lastModified }) : file;
}

/**
 * Props of {@link NewNotePage}.
 *
 * @stability experimental
 */
export interface NewNotePageProps {
  /** The viewer's AI availability and the "add your key" state. Default: no AI. */
  ai?: NotesAiAccess;
}

/**
 * `/notes/new`: pick a source and a template, then generate.
 *
 * @param props - See {@link NewNotePageProps}.
 * @returns The page.
 *
 * @stability experimental
 */
export function NewNotePage({ ai = NO_NOTES_AI_ACCESS }: NewNotePageProps = {}) {
  const theme = useTheme();
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const host = useKvoxHost();
  const sourceKinds = noteSourceKindsFor(useKvoxTranscriptionEnabled());
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const [searchParams] = useSearchParams();

  const {
    models,
    defaultModel: aiDefaultModel,
    keyConfigured,
    available,
    isLoading: aiLoading,
  } = ai.useAiState();
  const AiKeyRequired = ai.KeyRequired;
  // ⚠ The DEFAULT hook: hidden templates are excluded (issue #311), so the
  // pre-selection below can never land on one the user chose to hide.
  const { templates, isLoading: templatesLoading } = useNoteTemplates();

  /**
   * `?templateId=` — a template the link that brought the user here named.
   *
   * Read once, like `transcriptId` below. It may be one the user has HIDDEN,
   * which the list above deliberately omits; an explicit request for it is
   * still honoured, by reading it on its own (`requestedTemplate`) and offering
   * it labelled as hidden, rather than silently swapping in a different one.
   */
  const [requestedTemplateId] = useState(() => searchParams.get('templateId'));
  const [requestedTemplate, setRequestedTemplate] = useState<NoteTemplate | null>(null);

  /**
   * `?transcriptId=` — the whole reason a transcript page can offer "Make a
   * note from this".
   *
   * Read into the INITIAL state rather than applied by an effect: an effect
   * would render the empty picker for a frame and then fill it, and a user who
   * clicked "Make a note" would watch their own choice appear a moment after
   * they made it. Read once (`useState`'s initializer), because the query
   * string is where the user CAME FROM, not a control they are still operating.
   */
  const [draft, setDraft] = useState<NewNoteDraft>(() => {
    const transcriptId = searchParams.get('transcriptId');
    const objectId = searchParams.get('objectId');
    const templateId = searchParams.get('templateId');
    const base = emptyNewNoteDraft();
    const withTemplate = templateId ? { ...base, templateId } : base;
    if (transcriptId) return { ...withTemplate, kind: 'transcript', transcriptId };
    // `?objectId=` (#585): a document the host already uploaded (KVox Desktop's import),
    // offered exactly as if it had been chosen here. Its extraction is polled below.
    if (objectId) return { ...withTemplate, kind: 'document', objectId };
    return withTemplate;
  });

  const [transcripts, setTranscripts] = useState<TranscriptListItem[]>([]);
  const [sourceNotes, setSourceNotes] = useState<NoteListItem[]>([]);

  // `?objectId=` arrives with the name the host showed (`?documentName=`) and starts out
  // extracting, so the poll below reads its real state at once.
  const [documentName, setDocumentName] = useState<string | null>(() =>
    searchParams.get('objectId') ? (searchParams.get('documentName') ?? 'Imported document') : null,
  );
  const [isUploading, setIsUploading] = useState(false);
  const [extraction, setExtraction] = useState<NoteDocumentExtraction | null>(() =>
    searchParams.get('objectId') && !searchParams.get('transcriptId')
      ? { status: 'extracting', message: null, characters: null }
      : null,
  );
  const [documentError, setDocumentError] = useState<string | null>(null);

  /**
   * Keep or rewrite (#730). Keep by default; a document the host already
   * uploaded (`?objectId=`) has no file here to import, so it starts on rewrite.
   */
  const [documentAction, setDocumentAction] = useState<DocumentAction>(() =>
    searchParams.get('objectId') ? 'rewrite' : 'keep',
  );
  /** The file chosen in this browser, whichever action it is for. */
  const [chosenFile, setChosenFile] = useState<File | null>(null);
  /** The file the last source-document upload was for, so it is never sent twice. */
  const uploadedFileRef = useRef<File | null>(null);

  // Keep: the ad-hoc import batch the file went into, polled until it is a note.
  const [importBatchId, setImportBatchId] = useState<string | undefined>(undefined);
  const [isImportUploading, setIsImportUploading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const { batch: importBatch } = useImportBatch(importBatchId);
  const { items: importItems, refresh: refreshImportItems } = useImportBatchItems(importBatchId, undefined, 1);

  /**
   * The model, ONLY when the user has picked one (#109).
   *
   * ⚠ AN OVERRIDE, NOT A VALUE. `null` means "whatever the default resolves to
   * right now", which is what makes switching templates update the picker
   * without an effect and without ever clobbering a choice the user made. The
   * effect-based alternative — mirroring the default into state whenever the
   * template changes — has to decide whether the current value was chosen or
   * inherited, and there is nothing in a `string` that says which.
   */
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** Set by a 409 `ai_key_missing`, which renders `AiKeyRequired` over the form. */
  const [keyMissing, setKeyMissing] = useState(false);
  const [activeStep, setActiveStep] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---------------------------------------------------------------------------
  // The two pickers' candidates
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    // `scope: 'all'`, so a transcript shared WITH this user is offerable: the
    // API's own rule is "a source you can read", and a share is read access.
    void getTranscripts(host, { scope: 'all', limit: PICKER_LIMIT })
      .then((response) => {
        if (!cancelled && isMounted()) setTranscripts(response.items);
      })
      // A picker that cannot load is an empty picker with its own "nothing to
      // choose" line, not a page-level error: the other two source kinds are
      // unaffected and must stay usable.
      .catch(() => {
        if (!cancelled && isMounted()) setTranscripts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [host, isMounted]);

  useEffect(() => {
    let cancelled = false;
    // `status: 'ready'` — a note still generating has an empty body, and
    // offering it would be offering to write from nothing.
    void getNotes(host, { status: 'ready', limit: PICKER_LIMIT })
      .then((response) => {
        if (!cancelled && isMounted()) setSourceNotes(response.items);
      })
      .catch(() => {
        if (!cancelled && isMounted()) setSourceNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [host, isMounted]);

  /**
   * Pre-select the first template once the list lands.
   *
   * Only when nothing is chosen, so it cannot overwrite a choice the user has
   * already made against a slow list. A form whose required field starts empty
   * puts a disabled Generate in front of a user who has answered the question
   * they were asked; every account has at least the seeded built-ins, so there
   * is always something correct to start on.
   */
  /**
   * The requested template, when the list does not carry it (it is hidden).
   *
   * A request that fails — the id is not the caller's to read — drops the
   * choice, so the ordinary pre-selection below takes over instead of leaving
   * the picker pointed at nothing.
   */
  useEffect(() => {
    if (!requestedTemplateId || templatesLoading) return;
    if (templates.some((template) => template.id === requestedTemplateId)) return;
    let cancelled = false;
    void getNoteTemplate(host, requestedTemplateId)
      .then((template) => {
        if (!cancelled && isMounted()) setRequestedTemplate(template);
      })
      .catch(() => {
        if (cancelled || !isMounted()) return;
        setDraft((current) =>
          current.templateId === requestedTemplateId ? { ...current, templateId: '' } : current,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [host, isMounted, requestedTemplateId, templates, templatesLoading]);

  /** What the picker offers: the list, plus the requested template if it is not in it. */
  const templateOptions = useMemo(
    () =>
      requestedTemplate && !templates.some((template) => template.id === requestedTemplate.id)
        ? [...templates, requestedTemplate]
        : templates,
    [requestedTemplate, templates],
  );

  useEffect(() => {
    if (draft.templateId || templates.length === 0) return;
    setDraft((current) =>
      current.templateId ? current : { ...current, templateId: templates[0].id },
    );
  }, [draft.templateId, templates]);

  // ---------------------------------------------------------------------------
  // Document upload and its extraction
  // ---------------------------------------------------------------------------

  /** Rewrite: upload the file as a note source document and start its extraction. */
  const uploadSourceDocument = useCallback(
    async (file: File) => {
      uploadedFileRef.current = file;
      setDocumentError(null);
      setExtraction(null);
      setIsUploading(true);
      // Cleared so a second upload cannot leave the FIRST document's id in the
      // draft while the new one is still in flight — Generate would otherwise
      // be enabled against a file the user has replaced.
      setDraft((current) => ({ ...current, objectId: '' }));

      try {
        const uploaded = await uploadNoteSourceDocument(host, withMediaType(file));
        // A later choice replaced this file while it was in flight: its answer is stale.
        if (!isMounted() || uploadedFileRef.current !== file) return;
        setDraft((current) => ({ ...current, kind: 'document', objectId: uploaded.objectId }));
        setExtraction({ status: 'extracting', message: null, characters: null });
      } catch (err) {
        if (!isMounted() || uploadedFileRef.current !== file) return;
        // Forgotten, so choosing Rewrite again retries the upload.
        uploadedFileRef.current = null;
        setDocumentError(
          err instanceof KvoxApiError
            ? err.message
            : `This document could not be uploaded. Accepted types: ${NOTE_DOCUMENT_ACCEPT_LABEL}.`,
        );
      } finally {
        if (isMounted()) setIsUploading(false);
      }
    },
    [host, isMounted],
  );

  /**
   * A file was chosen. Nothing is uploaded for Keep until Import is pressed; for
   * Rewrite the source-document upload starts at once, as it always has.
   */
  const handleFileChosen = (file: File | undefined | null) => {
    if (!file) return;
    // Size is the server's call for each route; the extension and emptiness are not.
    const rejected = checkNoteImportFiles([file], Number.POSITIVE_INFINITY).rejected[0];
    setImportBatchId(undefined);
    setImportError(null);
    setExtraction(null);
    setDraft((current) => ({ ...current, objectId: '' }));
    uploadedFileRef.current = null;
    if (rejected) {
      setChosenFile(null);
      setDocumentName(null);
      setDocumentError(rejectionSentence(rejected.reason));
      return;
    }
    setDocumentError(null);
    setChosenFile(file);
    setDocumentName(file.name);
    if (documentAction === 'rewrite') void uploadSourceDocument(file);
  };

  const handleDocumentActionChange = (next: DocumentAction) => {
    setDocumentAction(next);
    if (next === 'rewrite' && chosenFile && uploadedFileRef.current !== chosenFile) {
      void uploadSourceDocument(chosenFile);
    }
  };

  /** Keep: import the chosen file as a note through an ad-hoc import batch. */
  const handleImport = async () => {
    if (!chosenFile) return;
    const rejected = checkNoteImportFiles([chosenFile]).rejected[0];
    if (rejected) {
      setImportError(rejectionSentence(rejected.reason));
      return;
    }
    setImportError(null);
    setImportBatchId(undefined);
    setIsImportUploading(true);
    try {
      const result = await importFilesAdHoc({ host, files: [chosenFile] });
      if (!isMounted()) return;
      const failed = result.failed[0];
      if (failed) {
        setImportError(failed.message);
        return;
      }
      setImportBatchId(result.batchId);
    } catch (err) {
      if (!isMounted()) return;
      setImportError(
        err instanceof KvoxApiError ? err.message : 'The document could not be imported. Try again.',
      );
    } finally {
      if (isMounted()) setIsImportUploading(false);
    }
  };

  // Every new read of the batch re-reads its one item, which carries the note id.
  useEffect(() => {
    if (importBatch) void refreshImportItems();
  }, [importBatch, refreshImportItems]);

  const importItem = importBatchId ? (importItems[0] ?? null) : null;
  const importFailure =
    importItem?.status === 'failed' ? describeNoteImportFailure(importItem.failureReason ?? 'internal_error') : null;
  const keepError = importError ?? importFailure;
  // Opened once it is a note AND its formatting has finished: the note page then shows
  // the formatted text, not the raw document it replaces a moment later.
  const importFormatting = importItem?.status === 'imported' && importItem.stage === 'formatting';
  const importedNoteId =
    importItem?.status === 'imported' && importItem.stage !== 'uploaded' && !importFormatting
      ? importItem.noteId
      : null;

  useEffect(() => {
    // `replace: true`, as for Generate: Back returns to the library, not to a finished form.
    if (importedNoteId) navigate(`/notes/${importedNoteId}`, { replace: true });
  }, [importedNoteId, navigate]);

  const keepPhase: KeepPhase | null = isImportUploading
    ? 'uploading'
    : importBatchId && !importFailure
      ? importFormatting || importedNoteId
        ? 'formatting'
        : 'importing'
      : null;
  const keepBusy = keepPhase !== null;

  const objectId = draft.objectId;
  const extractionStatus = extraction?.status;

  useEffect(() => {
    if (!objectId || extractionStatus !== 'extracting') return;

    let cancelled = false;
    const tick = async () => {
      try {
        const next = await getNoteDocumentExtraction(host, objectId);
        if (cancelled || !isMounted()) return;
        setExtraction(next);
      } catch {
        // A failed poll is left alone: the job is still running and the next
        // tick will ask again. Reporting it would put a transient network blip
        // in front of a user waiting on something that is working.
      }
    };

    const timer = setInterval(() => void tick(), EXTRACTION_POLL_MS);
    // One immediate read, so a text file that extracted while the response was
    // in flight does not cost a full interval of "Reading…".
    void tick();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [extractionStatus, host, isMounted, objectId]);

  const documentReady = extraction?.status === 'extracted';

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  /**
   * What the model picker shows when the user has not touched it.
   *
   * The chosen template's own model FIRST, because a template that names one is
   * expressing a requirement of the recipe — but only when the deployment still
   * permits it, since `ai.allowedModels` can narrow at any time and a form that
   * pre-selected a forbidden model would send a request the API refuses.
   * Otherwise the deployment's default.
   */
  const defaultModel = useMemo(() => {
    const chosen = templateOptions.find((template) => template.id === draft.templateId);
    const pinned = chosen?.model;

    if (pinned && models.some((model) => model.id === pinned)) return pinned;

    return aiDefaultModel ?? '';
  }, [aiDefaultModel, draft.templateId, models, templateOptions]);

  const model = modelOverride ?? defaultModel;

  const ready = useMemo(() => isNewNoteReady(draft, documentReady), [documentReady, draft]);

  /** The document is to be kept as the note: no template, model or context applies. */
  const keepMode = draft.kind === 'document' && documentAction === 'keep';

  const handleGenerate = async () => {
    const source = buildNoteSource(draft);
    if (!source || !draft.templateId) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const result = await createNote(host, {
        templateId: draft.templateId,
        source,
        // Omitted when blank, never sent as `''` — see `buildNoteTitle`. A title
        // that IS sent is recorded as the user's (#197) and is then sticky: no
        // titling pass, and no regeneration, ever renames it.
        title: buildNoteTitle(draft),
        // Omitted rather than sent empty: the API treats an absent context as
        // "none", and a blank string would be an empty paragraph in the prompt.
        contextText: draft.contextText.trim() || undefined,
        // ⚠ ONLY WHEN THE USER CHANGED IT. The API resolves the same default
        // this form displays — the template's model, else the deployment's — so
        // sending the unchanged value would pin a model into the request that
        // the user never chose, and freeze it against a template or a policy
        // that later names a different one. An untouched form therefore
        // produces byte-for-byte the body it produced before #109.
        model: model !== '' && model !== defaultModel ? model : undefined,
      });
      // `replace: true` — the form is finished and Back should return to the
      // library, not to a form whose submit has already happened.
      navigate(`/notes/${result.note.id}`, { replace: true });
    } catch (err) {
      if (!isMounted()) return;
      const reason = noteConflictReason(err);
      if (reason === 'ai_key_missing') {
        setKeyMissing(true);
        return;
      }
      if (reason === 'ai_not_configured') {
        setSubmitError(
          'AI features are not enabled for this deployment, so a note cannot be generated. ' +
            'Your administrator can turn them on.',
        );
        return;
      }
      setSubmitError(err instanceof KvoxApiError ? err.message : 'The note could not be created');
    } finally {
      if (isMounted()) setIsSubmitting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // The gates
  // ---------------------------------------------------------------------------

  if (aiLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress aria-label="Checking your AI configuration" />
      </Box>
    );
  }

  // ⚠ `AiKeyRequired` AND NOTHING ELSE. See the file header and the component's.
  if (!keyConfigured || keyMissing) {
    return (
      <Box sx={{ maxWidth: 720, mx: 'auto' }}>
        <Typography variant="h5" component="h1" sx={{ mb: 2 }}>
          New note
        </Typography>
        <AiKeyRequired />
      </Box>
    );
  }

  // ---------------------------------------------------------------------------
  // The three steps
  // ---------------------------------------------------------------------------

  const sourceStep = (
    <Stack spacing={2}>
      <FormControl>
        <FormLabel id="note-source-kind-label">What are you writing from?</FormLabel>
        <RadioGroup
          aria-labelledby="note-source-kind-label"
          value={draft.kind}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              kind: event.target.value as NewNoteDraft['kind'],
            }))
          }
        >
          {sourceKinds.map((option) => (
            <FormControlLabel
              key={option.value}
              value={option.value}
              control={<Radio />}
              label={
                <Box>
                  <Typography variant="body2">{option.label}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {option.hint}
                  </Typography>
                </Box>
              }
            />
          ))}
        </RadioGroup>
      </FormControl>

      {draft.kind === 'transcript' && (
        <FormControl fullWidth size="small">
          <InputLabel id="note-source-transcript">Transcript</InputLabel>
          <Select
            labelId="note-source-transcript"
            label="Transcript"
            value={draft.transcriptId}
            onChange={(event) =>
              setDraft((current) => ({ ...current, transcriptId: event.target.value }))
            }
          >
            {transcripts.map((transcript) => (
              <MenuItem key={transcript.id} value={transcript.id}>
                {transcript.title}
              </MenuItem>
            ))}
            {/* A transcript arrived at through `?transcriptId=` is selected
                before the list has loaded, and may not be in the first page of
                it either. Without an option carrying that value MUI renders an
                empty Select over a perfectly valid choice — so the pre-selected
                id always has one of its own. */}
            {draft.transcriptId &&
              !transcripts.some((transcript) => transcript.id === draft.transcriptId) && (
                <MenuItem value={draft.transcriptId}>Selected transcript</MenuItem>
              )}
          </Select>
        </FormControl>
      )}

      {draft.kind === 'note' && (
        <FormControl fullWidth size="small">
          <InputLabel id="note-source-note">Note</InputLabel>
          <Select
            labelId="note-source-note"
            label="Note"
            value={draft.noteId}
            onChange={(event) =>
              setDraft((current) => ({ ...current, noteId: event.target.value }))
            }
          >
            {sourceNotes.map((note) => (
              <MenuItem key={note.id} value={note.id}>
                {note.title}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      {draft.kind === 'document' && (
        <Box>
          <Button
            variant="outlined"
            startIcon={<UploadFileIcon />}
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading || keepBusy}
          >
            Choose a document
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            // Labelled and off-screen rather than `display: none`: a hidden
            // input is unreachable by assistive technology and by a test that
            // uploads a file, and the button above is what a pointer user sees.
            aria-label="Choose a document"
            // The import list: it names .docx and .pptx, and every extension both
            // routes read, so neither choice can be handed a file the other refuses.
            accept={NOTE_IMPORT_ACCEPT}
            onChange={(event) => {
              handleFileChosen(event.target.files?.[0]);
              // Cleared so choosing the same file again is still a change.
              event.target.value = '';
            }}
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
          />
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
            {NOTE_DOCUMENT_ACCEPT_LABEL}. Scanned PDFs are not read — there is no
            optical character recognition.
          </Typography>

          {documentName && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              {documentName}
            </Typography>
          )}

          {chosenFile && (
            <FormControl sx={{ mt: 2, display: 'block' }} disabled={keepBusy}>
              <FormLabel id="note-document-action-label">What should KVox do with it?</FormLabel>
              <RadioGroup
                aria-labelledby="note-document-action-label"
                value={documentAction}
                onChange={(event) => handleDocumentActionChange(event.target.value as DocumentAction)}
              >
                {DOCUMENT_ACTIONS.map((option) => (
                  <FormControlLabel
                    key={option.value}
                    value={option.value}
                    control={<Radio />}
                    label={
                      <Box>
                        <Typography variant="body2">{option.label}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {option.hint}
                        </Typography>
                      </Box>
                    }
                  />
                ))}
              </RadioGroup>
            </FormControl>
          )}

          {keepMode && keepPhase && (
            <Box sx={{ mt: 1 }} role="status">
              <LinearProgress aria-label={KEEP_PHASE_LABELS[keepPhase]} />
              <Typography variant="caption" color="text.secondary">
                {KEEP_PHASE_LABELS[keepPhase]}
              </Typography>
            </Box>
          )}

          {keepMode && keepError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {keepError}
            </Alert>
          )}

          {!keepMode && isUploading && (
            <Box sx={{ mt: 1 }}>
              <LinearProgress aria-label="Uploading the document" />
              <Typography variant="caption" color="text.secondary">
                Uploading…
              </Typography>
            </Box>
          )}

          {!keepMode && extraction?.status === 'extracting' && (
            <Box sx={{ mt: 1 }} role="status">
              <LinearProgress aria-label="Reading the document" />
              <Typography variant="caption" color="text.secondary">
                Reading the document…
              </Typography>
            </Box>
          )}

          {!keepMode && extraction?.status === 'extracted' && (
            <Alert severity="success" sx={{ mt: 1 }}>
              Document read
              {extraction.characters !== null
                ? ` — ${extraction.characters.toLocaleString()} characters of text.`
                : '.'}
            </Alert>
          )}

          {!keepMode && extraction?.status === 'unextractable' && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              <AlertTitle>No text could be read from this document</AlertTitle>
              {/* The API's OWN stored sentence, not a paraphrase: it is written
                  for the user and it names the actual cause (encrypted, image
                  only, corrupt). A generic line here would throw that away. */}
              {extraction.message ??
                'Try a different file, or one whose text is selectable.'}
            </Alert>
          )}

          {documentError && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {documentError}
            </Alert>
          )}
        </Box>
      )}
    </Stack>
  );

  /**
   * Every template hidden (issue #311): there is nothing to pick, and an empty
   * Select would read as a broken form. Say why, and link to the one place the
   * user can fix it. Generate stays disabled — no template, no note.
   */
  const noTemplatesToPick = !templatesLoading && templateOptions.length === 0;

  const templateStep = (
    <Stack spacing={1.5}>
      {noTemplatesToPick ? (
        <Alert
          severity="info"
          action={
            <Button component={RouterLink} to={TEMPLATE_MANAGER_PATH} color="inherit" size="small">
              Manage templates
            </Button>
          }
        >
          All your templates are hidden.
        </Alert>
      ) : (
        <FormControl fullWidth size="small">
          <InputLabel id="note-template">Template</InputLabel>
          <Select
            labelId="note-template"
            label="Template"
            // Only a value the menu actually offers: a requested id still being
            // read would otherwise be an out-of-range value for a moment.
            value={
              templateOptions.some((template) => template.id === draft.templateId)
                ? draft.templateId
                : ''
            }
            onChange={(event) =>
              setDraft((current) => ({ ...current, templateId: event.target.value }))
            }
          >
            {templateOptions.map((template) => (
              <MenuItem key={template.id} value={template.id}>
                {template.name}
                {template.builtIn ? ' (built-in)' : ''}
                {template.hidden ? ' (hidden)' : ''}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      )}
      {templatesLoading && (
        <Typography variant="caption" color="text.secondary">
          Loading your templates…
        </Typography>
      )}
      <ModelSelect
        value={model}
        onChange={setModelOverride}
        models={models}
        disabled={models.length === 0}
        helperText="Defaults to the template's model."
      />
      <Typography variant="caption" color="text.secondary">
        The template decides the shape of the note — its sections, its tone, its
        length.{' '}
        <Link component={RouterLink} to={TEMPLATE_MANAGER_PATH}>
          Manage or hide templates
        </Link>
        .
      </Typography>
    </Stack>
  );

  /**
   * The two optional inputs, in the step the form's last card holds (#187).
   *
   * The title sits BESIDE the context rather than at the top of the form, and
   * the step keeps its name, because both fields are the same kind of thing:
   * something a user may say and usually does not, on a screen whose three
   * required answers are the source, the template and nothing else. Putting a
   * "Title" box first would ask every user to name a note before they have seen
   * a word of it — which is precisely the question this field exists to let them
   * skip.
   */
  const contextStep = (
    <Stack spacing={2}>
      <TextField
        label="Title (optional)"
        fullWidth
        value={draft.title}
        onChange={(event) =>
          setDraft((current) => ({ ...current, title: event.target.value }))
        }
        // The API's own ceiling, mirrored once in `services/notes.ts` — a longer
        // title is a 400, and a field that lets one be typed is a form that
        // collects a refusal it could have prevented.
        slotProps={{ htmlInput: { maxLength: MAX_TITLE_CHARS } }}
        // ⚠ "NAMED FOR YOU", NOT "NAMED BY THE AI". Titling reads the generated
        // content when it can, falls back to the body's own first heading, and
        // falls back again to the template's name — and a deployment whose
        // provider cannot be reached at all lands on that last rank. All three
        // are "the note arrives with a name"; only the first is the AI, so only
        // the first would be a promise this sentence cannot keep.
        helperText={
          'Leave this blank and the note is named for you once it has been generated. ' +
          'A title you type here is kept — regenerating never changes it.'
        }
      />
      <TextField
        label="Context (optional)"
        multiline
        minRows={3}
        fullWidth
        value={draft.contextText}
        onChange={(event) =>
          setDraft((current) => ({ ...current, contextText: event.target.value }))
        }
        // The placeholder is the explanation. An unexplained free-text box at the
        // end of a form is a box nobody fills in, and the thing it is for — what
        // an outsider writing this up would need to know — is not guessable from
        // the word "Context".
        placeholder="Who was there, why this happened, and what matters most — anything someone writing this up from the outside would need to know."
        helperText="Placed ahead of the source in the prompt, for this note and every regeneration of it."
      />
    </Stack>
  );

  // Keep (#730): the source is the whole form — no template, model or context applies.
  const steps = keepMode
    ? [{ label: 'Source', content: sourceStep }]
    : [
        { label: 'Source', content: sourceStep },
        { label: 'Template', content: templateStep },
        { label: 'Context', content: contextStep },
      ];
  const currentStep = Math.min(activeStep, steps.length - 1);

  const generateButton = (
    <Button
      variant="contained"
      startIcon={<AutoAwesomeIcon />}
      onClick={() => void handleGenerate()}
      disabled={!ready || isSubmitting}
    >
      {isSubmitting ? 'Starting…' : 'Generate'}
    </Button>
  );

  const primaryButton = keepMode ? (
    <Button
      variant="contained"
      startIcon={<NoteAddIcon />}
      onClick={() => void handleImport()}
      disabled={!chosenFile || keepBusy}
    >
      Import note
    </Button>
  ) : (
    generateButton
  );

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <Typography variant="h5" component="h1" sx={{ mb: 2 }}>
        New note
      </Typography>

      {!available && !keepMode && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          AI features are not enabled for this deployment right now. You can fill this
          in, but generating will not succeed until an administrator turns them on.
        </Alert>
      )}

      {submitError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {submitError}
        </Alert>
      )}

      {isPhone ? (
        <Stepper activeStep={currentStep} orientation="vertical">
          {steps.map((step, index) => (
            <Step key={step.label}>
              {/* Clickable labels: the steps are not a sequence with
                  prerequisites (see the file header), so a phone user must be
                  able to go back to one without stepping through the others. */}
              <StepLabel onClick={() => setActiveStep(index)} sx={{ cursor: 'pointer' }}>
                {step.label}
              </StepLabel>
              <StepContent>
                {step.content}
                <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
                  {index > 0 && (
                    <Button onClick={() => setActiveStep(index - 1)}>Back</Button>
                  )}
                  {index < steps.length - 1 ? (
                    <Button
                      variant="contained"
                      onClick={() => setActiveStep(index + 1)}
                      // Nothing to choose on the Template step means nothing
                      // to go on to (issue #311).
                      disabled={step.label === 'Template' && noTemplatesToPick}
                    >
                      Next
                    </Button>
                  ) : (
                    primaryButton
                  )}
                </Stack>
              </StepContent>
            </Step>
          ))}
        </Stepper>
      ) : (
        <Stack spacing={2}>
          {steps.map((step) => (
            <Paper key={step.label} variant="outlined" sx={{ p: 2 }}>
              <Typography variant="subtitle1" component="h2" sx={{ mb: 1.5, fontWeight: 600 }}>
                {step.label}
              </Typography>
              {step.content}
            </Paper>
          ))}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
            <Button onClick={() => navigate('/notes')}>Cancel</Button>
            {primaryButton}
          </Box>
        </Stack>
      )}
    </Box>
  );
}

