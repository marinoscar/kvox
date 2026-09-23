/**
 * "Regenerate this note?" — issue #58, extended by issue #109, epic #45.
 *
 * =============================================================================
 * TWO FACTS, BOTH STATED, BOTH EASY TO GET WRONG BY OMISSION (#58)
 * =============================================================================
 *
 * 1. **IT SPENDS THE USER'S OWN MONEY.** This application has no AI key of its
 *    own; a generation is billed to the provider account whose key the user
 *    saved (#55). A regenerate button that quietly re-ran a model would be
 *    spending somebody else's money without telling them, which is the one
 *    thing an AI feature funded this way must never do. So the confirmation
 *    names it in the dialog, not in a tooltip and not in the settings page.
 *
 * 2. **NOTHING IS LOST.** The current body is already a version and stays one:
 *    a successful regeneration APPENDS the next version rather than overwriting
 *    anything, and a `ready` note keeps showing its last good text until the
 *    new generation commits. A user who does not know that reads "Regenerate"
 *    as "throw away what I have and hope", which makes the feature unusable on
 *    a note they care about — precisely the note they most want to improve.
 *
 * Both sentences are in the dialog body rather than in the button label,
 * because a button cannot carry them and a user who has already pressed it is
 * past the point where they help. #109 adds three controls ABOVE them and
 * changes neither sentence: the facts are about what pressing the button does,
 * and that has not changed.
 *
 * =============================================================================
 * #109 — WHY A CONFIRMATION GREW A FORM
 * =============================================================================
 *
 * `POST /api/notes/{id}/regenerate` has always accepted `{ templateId,
 * contextText, model }`; until now this dialog sent `{}` and there was no way
 * for a user to reach any of the three. The result was that "regenerate" could
 * only ever mean "do the same thing again" — so a note that came out wrong
 * because the CONTEXT was wrong, or because the template was the wrong recipe,
 * had exactly one remedy: delete it and start at `/notes/new`. The most common
 * reason to press this button was the one reason it could not help with.
 *
 * The three controls are therefore the point of the dialog now, and the
 * confirmation is what wraps them. What is sent is a DIFF
 * (`regenerateInput.ts`), so a user who changes nothing produces the same empty
 * body #58 produced and nothing about the unchanged path moves.
 *
 * =============================================================================
 * ⚠ THIS DIALOG DOES NOT CHECK FOR A KEY — ITS CALLER DOES, ONE LEVEL UP (#58)
 * =============================================================================
 *
 * With `keyConfigured: false` the note page renders `AiKeyRequired` in place of
 * the regenerate control entirely, and READING AND EXPORTING GO ON WORKING. A
 * missing key gates the one action that needs a provider account; it must never
 * gate the user's own note. Putting that branch here would mean a dialog that
 * sometimes opens onto a refusal, which is a worse version of the same thing.
 */

import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Checkbox from '@mui/material/Checkbox';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import InputLabel from '@mui/material/InputLabel';
import ListSubheader from '@mui/material/ListSubheader';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { UseNoteTemplateDetailResult } from '../../hooks/useNoteTemplates';
import type { AiConfigModel } from '../../services/ai';
import type { Note, RegenerateNoteInput } from '../../services/notes';
import type { NoteTemplate } from '../../services/noteTemplates';
import { ModelSelect } from './ModelSelect';
import { REGENERATE_COST_SENTENCE, buildRegenerateInput } from './regenerateInput';
import { TemplateSummary } from './TemplateSummary';

/**
 * `MAX_CONTEXT_CHARS` in `apps/api/src/notes/dto/note-template.dto.ts`.
 *
 * Mirrored so the field stops accepting characters the API would refuse, which
 * PREVENTS a 400 rather than reporting one. The schema is still the guarantee;
 * this is a courtesy, exactly as `MAX_INSTRUCTIONS_CHARS` is in
 * `services/noteTemplates.ts`.
 */
const MAX_CONTEXT_CHARS = 4_000;

export interface RegenerateNoteDialogProps {
  open: boolean;
  note: Note;
  templates: NoteTemplate[];
  templatesLoading: boolean;
  /**
   * The note's own template, read by id.
   *
   * Distinct from "the one in `templates`" and that is the whole reason it is a
   * separate prop: `GET /api/note-templates` excludes ARCHIVED rows, so a note
   * generated from a template that has since been archived has a perfectly
   * valid `templateId` that appears nowhere in the list. Without this, the
   * select would render blank over a real choice and the user would be forced
   * to change a template they never asked to change.
   */
  currentTemplate: NoteTemplate | null;
  /**
   * Where the read of `currentTemplate` stands (#312), so the summary under the
   * select can say "loading" or "no longer available" rather than nothing.
   * Defaults to `loaded` when a row is given and `idle` when none is.
   */
  currentTemplateState?: UseNoteTemplateDetailResult['state'];
  /** `template` focuses the template select on open — the "another template…" door (#312). */
  initialFocus?: 'template';
  /**
   * Whether the list includes templates the user has hidden (#312). The
   * checkbox is rendered only when `onShowHiddenTemplatesChange` is given: the
   * list itself is fetched by the caller, which is the only one that can
   * re-read it with the option flipped.
   */
  showHiddenTemplates?: boolean;
  onShowHiddenTemplatesChange?: (value: boolean) => void;
  models: AiConfigModel[];
  defaultModel: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (input: RegenerateNoteInput) => void;
}

/**
 * Which model the form should open on.
 *
 * Three ranks, in this order and for these reasons:
 *
 *   1. **The note's own model, if the deployment still permits it.** The
 *      default action of this dialog is "the same again", and the same again
 *      means the same model.
 *   2. **The template's model, if it names one and it is permitted.** A
 *      template that pins a model is expressing a requirement of the recipe,
 *      and it is the next most specific answer available.
 *   3. **The deployment's default**, then the first permitted model.
 *
 * ⚠ EVERY RANK IS CHECKED AGAINST `models`. An administrator can narrow
 * `ai.allowedModels` at any time, and a form that pre-selected a model the
 * deployment no longer permits would send a request the API refuses — with the
 * refusal arriving after the user pressed a button that spends money.
 */
function initialModel(
  note: Note,
  models: AiConfigModel[],
  currentTemplate: NoteTemplate | null,
  defaultModel: string | null,
): string {
  const permitted = (id: string | null | undefined): id is string =>
    typeof id === 'string' && models.some((model) => model.id === id);

  if (permitted(note.model)) return note.model;
  if (permitted(currentTemplate?.model)) return currentTemplate.model;

  return defaultModel ?? models[0]?.id ?? '';
}

export function RegenerateNoteDialog({
  open,
  note,
  templates,
  templatesLoading,
  currentTemplate,
  currentTemplateState,
  initialFocus,
  showHiddenTemplates = false,
  onShowHiddenTemplatesChange,
  models,
  defaultModel,
  busy,
  error,
  onCancel,
  onConfirm,
}: RegenerateNoteDialogProps) {
  const [templateId, setTemplateId] = useState('');
  const [contextText, setContextText] = useState('');
  const [model, setModel] = useState('');

  /**
   * ⚠ INITIALISE ON THE FALSE → TRUE TRANSITION, NEVER ON EVERY DEP CHANGE.
   *
   * `models`, `templates` and `currentTemplate` all arrive asynchronously and
   * all change identity when they do. An effect that re-seeded the form
   * whenever one of them moved would wipe out whatever the user had typed into
   * the context box the moment a request they never asked about came back —
   * which, on a slow connection, is precisely while they are typing.
   */
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setTemplateId(note.templateId ?? '');
      setContextText(note.contextText ?? '');
      setModel(initialModel(note, models, currentTemplate, defaultModel));
    }

    wasOpen.current = open;
  }, [currentTemplate, defaultModel, models, note, open]);

  /**
   * Fill the model in once the list lands — and ONLY then.
   *
   * The dialog can open before `GET /api/ai/config` has answered, in which case
   * the seed above resolves to `''` because nothing is permitted yet. This is
   * the narrowest possible repair: it fires only while the selection is empty,
   * which is a state the user cannot produce themselves (the select offers no
   * empty option), so it can never overwrite a choice.
   */
  useEffect(() => {
    if (!open || model !== '') return;

    const resolved = initialModel(note, models, currentTemplate, defaultModel);
    if (resolved !== '') setModel(resolved);
  }, [currentTemplate, defaultModel, model, models, note, open]);

  /**
   * A selection the list stopped carrying goes back to the note's own template.
   *
   * The one way to get there is to pick a HIDDEN template with "Show hidden
   * templates" ticked and then untick it: the list is re-read without that row,
   * and a select holding a value with no option would show a blank box over a
   * choice the user can no longer see. The note's own template is exempt — it
   * is always offered, below — and so is the frame while the list is loading,
   * which still holds the previous answer.
   */
  useEffect(() => {
    if (!open || templatesLoading) return;
    if (templateId === '' || templateId === note.templateId) return;
    if (templates.some((template) => template.id === templateId)) return;

    setTemplateId(note.templateId ?? '');
  }, [note.templateId, open, templateId, templates, templatesLoading]);

  // --- The options, grouped (#312) -----------------------------------------
  //
  // ⚠ THE NOTE'S OWN TEMPLATE IS ALWAYS OFFERED, whether or not the list
  // carries it. `GET /api/note-templates` excludes ARCHIVED rows always and
  // HIDDEN rows by default, so a note generated from either has a perfectly
  // valid `templateId` that appears nowhere in the list. Without this option the
  // select would render blank over a real choice and force the user to change a
  // template they never asked to change — and hiding a template is a listing
  // preference, never a reason it cannot be used again.
  //
  // ⚠ A FLAT ARRAY, NOT FRAGMENTS. MUI's Select reads its options off its
  // direct children; a `<>…</>` would hide every option inside it.
  const currentId = note.templateId;
  const currentInList = currentId
    ? (templates.find((template) => template.id === currentId) ?? null)
    : null;
  const currentRow = currentInList ?? currentTemplate;

  const currentLabel = (() => {
    if (!currentRow) return note.templateName ?? 'Current template';
    const flags = [
      currentRow.isArchived ? 'archived' : null,
      currentRow.hidden ? 'hidden' : null,
    ].filter((flag): flag is string => flag !== null);
    return flags.length > 0
      ? `${currentRow.name} (current, ${flags.join(', ')})`
      : currentRow.name;
  })();

  const optionLabel = (template: NoteTemplate) =>
    template.hidden ? `${template.name} (hidden)` : template.name;

  const others = templates.filter((template) => template.id !== currentId);
  const own = others.filter((template) => !template.builtIn);
  const builtIns = others.filter((template) => template.builtIn);

  const options: ReactElement[] = [];
  if (currentId) {
    options.push(
      <ListSubheader key="h-current">Current</ListSubheader>,
      <MenuItem key={`t-${currentId}`} value={currentId}>
        {currentLabel}
      </MenuItem>,
    );
  }
  if (own.length > 0) {
    options.push(<ListSubheader key="h-own">Your templates</ListSubheader>);
    for (const template of own) {
      options.push(
        <MenuItem key={`t-${template.id}`} value={template.id}>
          {optionLabel(template)}
        </MenuItem>,
      );
    }
  }
  if (builtIns.length > 0) {
    options.push(<ListSubheader key="h-builtin">Built-in</ListSubheader>);
    for (const template of builtIns) {
      options.push(
        <MenuItem key={`t-${template.id}`} value={template.id}>
          {optionLabel(template)}
        </MenuItem>,
      );
    }
  }

  // --- What the selected template is (#312) ---------------------------------
  // The list row when there is one — it is already in memory, so no request —
  // and the by-id read only for the note's own template when the list does not
  // carry it.
  const selectedInList = templates.find((template) => template.id === templateId) ?? null;
  const summary: { template: NoteTemplate | null; state: UseNoteTemplateDetailResult['state'] } =
    templateId === ''
      ? { template: null, state: 'idle' }
      : selectedInList
        ? { template: selectedInList, state: 'loaded' }
        : templateId === currentId
          ? {
              template: currentTemplate,
              state: currentTemplateState ?? (currentTemplate ? 'loaded' : 'idle'),
            }
          : { template: null, state: 'idle' };
  const templateChanged = templateId !== '' && templateId !== note.templateId;

  // ⚠ NO MODELS MEANS NO REQUEST. Either the config is still in flight or this
  // deployment permits nothing; in both cases a confirm would send a
  // regeneration whose model the user never saw. The button says why.
  const modelsUnavailable = models.length === 0;
  const templateMissing = templateId === '';

  const recordedModelUnavailable =
    !modelsUnavailable &&
    note.model !== null &&
    !models.some((candidate) => candidate.id === note.model);
  const selectedModelLabel =
    models.find((candidate) => candidate.id === model)?.label ?? model;

  const selectedTemplateName =
    selectedInList?.name ??
    (templateId === note.templateId ? (currentRow?.name ?? note.templateName) : null);

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onCancel}
      fullWidth
      maxWidth="sm"
      aria-labelledby="note-regenerate-title"
    >
      <DialogTitle id="note-regenerate-title">Regenerate this note?</DialogTitle>

      <DialogContent>
        <DialogContentText component="div">
          <Typography variant="body2" component="p">
            Your AI provider will write this note again
            {selectedTemplateName ? ` using ${selectedTemplateName}` : ''}.{' '}
            {/* FACT 1 — the cost, in the user's own terms. Shared with the
                one-click confirmation so the two cannot drift (#312). */}
            <strong>{REGENERATE_COST_SENTENCE}</strong>
          </Typography>
          <Typography variant="body2" component="p" sx={{ mt: 1.5 }}>
            {/* FACT 2 — what happens to what is already here. */}
            Nothing is lost. The note as it stands is kept as{' '}
            <strong>version {note.currentVersion}</strong> in the history, and the new text
            is added as the next version — so you can read both and go back at any time.
          </Typography>
        </DialogContentText>

        <Stack spacing={2} sx={{ mt: 2.5 }}>
          <FormControl fullWidth size="small" error={templateMissing}>
            <InputLabel id="note-regenerate-template">Template</InputLabel>
            <Select
              labelId="note-regenerate-template"
              label="Template"
              value={templateId}
              disabled={busy}
              autoFocus={initialFocus === 'template'}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              {options}
            </Select>
            <FormHelperText>
              {templateMissing
                ? // The note's template row is gone for good (the API nulls the
                  // column), so there is nothing to keep — the user has to pick
                  // one, and Regenerate stays disabled until they do.
                  'The template this note used no longer exists — choose one'
                : templatesLoading
                  ? 'Loading your templates…'
                  : 'The recipe the note is written from — its sections, its tone, its length.'}
            </FormHelperText>
            {onShowHiddenTemplatesChange && (
              <FormControlLabel
                sx={{ mt: 0.5 }}
                control={
                  <Checkbox
                    size="small"
                    checked={showHiddenTemplates}
                    disabled={busy}
                    onChange={(event) => onShowHiddenTemplatesChange(event.target.checked)}
                  />
                }
                label={<Typography variant="body2">Show hidden templates</Typography>}
              />
            )}
            <TemplateSummary template={summary.template} state={summary.state} />
            {templateChanged && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
                Changing the template rewrites the note&apos;s structure; the current version
                stays in History.
              </Typography>
            )}
          </FormControl>

          <TextField
            label="Context"
            multiline
            minRows={3}
            fullWidth
            size="small"
            value={contextText}
            disabled={busy}
            onChange={(event) => setContextText(event.target.value)}
            helperText="Leave as is to keep the current context; clear it to regenerate without any."
            slotProps={{ htmlInput: { maxLength: MAX_CONTEXT_CHARS } }}
          />

          <ModelSelect
            value={model}
            onChange={setModel}
            models={models}
            disabled={busy || modelsUnavailable}
            helperText={
              modelsUnavailable
                ? 'Checking which models you can use…'
                : recordedModelUnavailable
                  ? // ⚠ BOTH ARE NAMED. "That model is no longer available" with
                    // no replacement leaves the user unable to tell what they
                    // are about to pay for.
                    `The model this note used (${note.model}) is no longer permitted; ${selectedModelLabel} will be used`
                  : undefined
            }
          />
        </Stack>

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() =>
            onConfirm(buildRegenerateInput(note, { templateId, contextText, model }))
          }
          disabled={busy || templateMissing || modelsUnavailable}
        >
          {busy ? 'Starting…' : 'Regenerate'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default RegenerateNoteDialog;
