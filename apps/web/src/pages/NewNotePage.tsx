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
 * `useAiConfig().keyConfigured` false renders `AiKeyRequired` (#55) and nothing
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
import UploadFileIcon from '@mui/icons-material/UploadFile';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';

import { AiKeyRequired } from '../components/ai/AiKeyRequired';
import { ModelSelect } from '../components/notes/ModelSelect';
import { useAiConfig } from '../hooks/useAiConfig';
import { useIsMounted } from '../hooks/useIsMounted';
import { useNoteTemplates } from '../hooks/useNoteTemplates';
import { ApiError } from '../services/api';
import {
  MAX_TITLE_CHARS,
  NOTE_DOCUMENT_ACCEPT,
  NOTE_DOCUMENT_ACCEPT_LABEL,
  createNote,
  getNoteDocumentExtraction,
  getNotes,
  noteConflictReason,
  uploadNoteSourceDocument,
} from '../services/notes';
import type { NoteDocumentExtraction, NoteListItem } from '../services/notes';
import { getNoteTemplate } from '../services/noteTemplates';
import type { NoteTemplate } from '../services/noteTemplates';
import { getTranscripts } from '../services/transcripts';
import type { TranscriptListItem } from '../services/transcripts';
import {
  NOTE_SOURCE_KINDS,
  buildNoteSource,
  buildNoteTitle,
  emptyNewNoteDraft,
  isNewNoteReady,
} from './newNote';
import type { NewNoteDraft } from './newNote';

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

export function NewNotePage() {
  const theme = useTheme();
  const navigate = useNavigate();
  const isMounted = useIsMounted();
  const isPhone = useMediaQuery(theme.breakpoints.down('sm'));
  const [searchParams] = useSearchParams();

  const { config, keyConfigured, available, isLoading: aiLoading } = useAiConfig();
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
    const templateId = searchParams.get('templateId');
    const base = emptyNewNoteDraft();
    const withTemplate = templateId ? { ...base, templateId } : base;
    return transcriptId
      ? { ...withTemplate, kind: 'transcript', transcriptId }
      : withTemplate;
  });

  const [transcripts, setTranscripts] = useState<TranscriptListItem[]>([]);
  const [sourceNotes, setSourceNotes] = useState<NoteListItem[]>([]);

  const [documentName, setDocumentName] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [extraction, setExtraction] = useState<NoteDocumentExtraction | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);

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
    void getTranscripts({ scope: 'all', limit: PICKER_LIMIT })
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
  }, [isMounted]);

  useEffect(() => {
    let cancelled = false;
    // `status: 'ready'` — a note still generating has an empty body, and
    // offering it would be offering to write from nothing.
    void getNotes({ status: 'ready', limit: PICKER_LIMIT })
      .then((response) => {
        if (!cancelled && isMounted()) setSourceNotes(response.items);
      })
      .catch(() => {
        if (!cancelled && isMounted()) setSourceNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isMounted]);

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
    void getNoteTemplate(requestedTemplateId)
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
  }, [isMounted, requestedTemplateId, templates, templatesLoading]);

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

  const handleFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return;
      setDocumentError(null);
      setExtraction(null);
      setDocumentName(file.name);
      setIsUploading(true);
      // Cleared so a second upload cannot leave the FIRST document's id in the
      // draft while the new one is still in flight — Generate would otherwise
      // be enabled against a file the user has replaced.
      setDraft((current) => ({ ...current, objectId: '' }));

      try {
        const uploaded = await uploadNoteSourceDocument(file);
        if (!isMounted()) return;
        setDraft((current) => ({ ...current, kind: 'document', objectId: uploaded.objectId }));
        setExtraction({ status: 'extracting', message: null, characters: null });
      } catch (err) {
        if (!isMounted()) return;
        setDocumentName(null);
        setDocumentError(
          err instanceof ApiError
            ? err.message
            : `This document could not be uploaded. Accepted types: ${NOTE_DOCUMENT_ACCEPT_LABEL}.`,
        );
      } finally {
        if (isMounted()) setIsUploading(false);
      }
    },
    [isMounted],
  );

  const objectId = draft.objectId;
  const extractionStatus = extraction?.status;

  useEffect(() => {
    if (!objectId || extractionStatus !== 'extracting') return;

    let cancelled = false;
    const tick = async () => {
      try {
        const next = await getNoteDocumentExtraction(objectId);
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
  }, [extractionStatus, isMounted, objectId]);

  const documentReady = extraction?.status === 'extracted';

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------

  const models = useMemo(() => config?.models ?? [], [config]);

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

    return config?.defaultModel ?? '';
  }, [config, draft.templateId, models, templateOptions]);

  const model = modelOverride ?? defaultModel;

  const ready = useMemo(() => isNewNoteReady(draft, documentReady), [documentReady, draft]);

  const handleGenerate = async () => {
    const source = buildNoteSource(draft);
    if (!source || !draft.templateId) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const result = await createNote({
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
      setSubmitError(err instanceof ApiError ? err.message : 'The note could not be created');
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
          {NOTE_SOURCE_KINDS.map((option) => (
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
            disabled={isUploading}
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
            accept={NOTE_DOCUMENT_ACCEPT}
            onChange={(event) => void handleFile(event.target.files?.[0])}
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}
          />
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
            {NOTE_DOCUMENT_ACCEPT_LABEL}. Scanned pages are not read — there is no
            optical character recognition.
          </Typography>

          {documentName && (
            <Typography variant="body2" sx={{ mt: 1 }}>
              {documentName}
            </Typography>
          )}

          {isUploading && (
            <Box sx={{ mt: 1 }}>
              <LinearProgress aria-label="Uploading the document" />
              <Typography variant="caption" color="text.secondary">
                Uploading…
              </Typography>
            </Box>
          )}

          {extraction?.status === 'extracting' && (
            <Box sx={{ mt: 1 }} role="status">
              <LinearProgress aria-label="Reading the document" />
              <Typography variant="caption" color="text.secondary">
                Reading the document…
              </Typography>
            </Box>
          )}

          {extraction?.status === 'extracted' && (
            <Alert severity="success" sx={{ mt: 1 }}>
              Document read
              {extraction.characters !== null
                ? ` — ${extraction.characters.toLocaleString()} characters of text.`
                : '.'}
            </Alert>
          )}

          {extraction?.status === 'unextractable' && (
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

  const steps = [
    { label: 'Source', content: sourceStep },
    { label: 'Template', content: templateStep },
    { label: 'Context', content: contextStep },
  ];

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

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto' }}>
      <Typography variant="h5" component="h1" sx={{ mb: 2 }}>
        New note
      </Typography>

      {!available && (
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
        <Stepper activeStep={activeStep} orientation="vertical">
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
                    generateButton
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
            {generateButton}
          </Box>
        </Stack>
      )}
    </Box>
  );
}

export default NewNotePage;
