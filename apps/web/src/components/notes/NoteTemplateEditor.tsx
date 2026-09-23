/**
 * The template editor form — issue #56, epic #45.
 *
 * =============================================================================
 * STRUCTURED FIELDS, NOT ONE PROMPT BOX
 * =============================================================================
 *
 * Issue #56 rejects a single free-text prompt box explicitly, and the reason is
 * worth keeping next to the code: a user whose output is wrong needs a
 * VOCABULARY for what to change. "The tone is off" and "it skipped the
 * decisions section" are edits to two different controls here; in one textarea
 * they are both "rewrite the paragraph and hope". The same structure is what
 * lets the server assemble prompts consistently (#49) and what lets the model
 * picker be bounded by deployment policy at all.
 *
 * =============================================================================
 * ⚠ THE MODEL PICKER OFFERS ONLY WHAT `GET /api/ai/config` PERMITS
 * =============================================================================
 *
 * `models` on that response is ALREADY narrowed by the deployment's policy, so
 * this component renders it verbatim and never adds to it — no free-text model
 * box, no "other", no remembered value from a previous deployment. A model an
 * administrator has withdrawn cannot be selected here, which is the difference
 * between a control that refuses and a generation that 400s after the user has
 * already waited for it.
 *
 * ONE EXCEPTION, AND IT IS NOT A LOOPHOLE: a SAVED template may name a model
 * that policy has since withdrawn (the API stores the string and validates it
 * at generation time, deliberately — see `modelSchema`). Opening such a row
 * would otherwise silently rewrite the user's choice to "deployment default"
 * the moment they pressed Save. So the stale value is rendered as a disabled,
 * clearly-labelled option: visible, explained, and impossible to re-select once
 * changed away from.
 */

import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { StructureListEditor } from './StructureListEditor';
import {
  MAX_DESCRIPTION_CHARS,
  MAX_HINT_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_NAME_CHARS,
  NOTE_BODY_FORMATS,
  NOTE_BODY_FORMAT_LABELS,
  NOTE_OUTPUT_FORMATS,
  NOTE_OUTPUT_FORMAT_LABELS,
} from '../../services/noteTemplates';
import type {
  NoteBodyFormat,
  NoteOutputFormat,
  NoteTemplateDraft,
} from '../../services/noteTemplates';
import type { AiConfigModel } from '../../services/ai';

/**
 * The placeholder for `instructions` — a WORKED EXAMPLE, not a hint.
 *
 * Issue #56 asks for this specifically, and it is the single highest-leverage
 * piece of copy on the page: the field is a prompt body, and a user who has
 * never written one has no idea what shape an answer takes. "Describe what the
 * note should contain" tells them nothing they did not already know; a real
 * example tells them the register, the length and the kind of instruction that
 * works.
 */
export const INSTRUCTIONS_PLACEHOLDER = `Example:

You are writing notes from a recorded meeting. Work only from the transcript —
never invent a decision, an owner or a date that was not said out loud.

Open with two or three sentences on what the meeting was for. Then list the
decisions that were actually made, each with who made it. Then list the follow-up
actions, each with an owner and a due date when one was given, and mark the ones
where no owner was named.

If something was discussed but left unresolved, say so plainly rather than
rounding it up to a decision.`;

/** Tone suggestions. Free text on the wire — these are a starting vocabulary. */
const TONE_SUGGESTIONS = ['neutral', 'warm', 'formal', 'direct', 'concise'];

/** Length suggestions, likewise free text. */
const LENGTH_SUGGESTIONS = ['short', 'medium', 'detailed'];

export interface NoteTemplateEditorProps {
  draft: NoteTemplateDraft;
  onChange: (draft: NoteTemplateDraft) => void;
  /** The permitted models, from `GET /api/ai/config`. Never widened here. */
  models: AiConfigModel[];
  /** The deployment default, named in the "use the default" option. */
  defaultModel: string | null;
  disabled?: boolean;
}

export function NoteTemplateEditor({
  draft,
  onChange,
  models,
  defaultModel,
  disabled = false,
}: NoteTemplateEditorProps) {
  const set = <K extends keyof NoteTemplateDraft>(key: K, value: NoteTemplateDraft[K]) => {
    onChange({ ...draft, [key]: value });
  };

  // See the header: a saved row may name a model policy has since withdrawn.
  // It is shown, disabled, rather than silently dropped from the picker.
  const isStaleModel =
    draft.model !== '' && !models.some((model) => model.id === draft.model);

  return (
    <Paper
      variant="outlined"
      component="section"
      aria-labelledby="template-editor-heading"
      sx={{ p: { xs: 2, sm: 3 } }}
    >
      <Typography id="template-editor-heading" variant="h6" component="h2" gutterBottom>
        Template
      </Typography>

      <Stack spacing={2.5}>
        <TextField
          fullWidth
          required
          label="Name"
          value={draft.name}
          onChange={(event) => set('name', event.target.value)}
          disabled={disabled}
          slotProps={{ htmlInput: { maxLength: MAX_NAME_CHARS } }}
        />

        <TextField
          fullWidth
          label="Description"
          value={draft.description}
          onChange={(event) => set('description', event.target.value)}
          disabled={disabled}
          helperText="One line explaining what this template produces. Shown when you pick a template."
          slotProps={{ htmlInput: { maxLength: MAX_DESCRIPTION_CHARS } }}
        />

        <TextField
          fullWidth
          required
          multiline
          minRows={8}
          label="Instructions"
          value={draft.instructions}
          onChange={(event) => set('instructions', event.target.value)}
          disabled={disabled}
          placeholder={INSTRUCTIONS_PLACEHOLDER}
          helperText={`What the model should do with the recording. ${draft.instructions.length.toLocaleString()} of ${MAX_INSTRUCTIONS_CHARS.toLocaleString()} characters.`}
          error={draft.instructions.length > MAX_INSTRUCTIONS_CHARS}
        />

        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            alignItems: { sm: 'flex-start' },
            gap: 2,
          }}
        >
          <TextField
            select
            fullWidth
            label="Output format"
            value={draft.outputFormat}
            onChange={(event) => set('outputFormat', event.target.value as NoteOutputFormat)}
            disabled={disabled}
          >
            {NOTE_OUTPUT_FORMATS.map((format) => (
              <MenuItem key={format} value={format}>
                {NOTE_OUTPUT_FORMAT_LABELS[format]}
              </MenuItem>
            ))}
          </TextField>

          {/* Issue #334: the SHAPE of the text, independent of what kind of note it is. */}
          <TextField
            select
            fullWidth
            label="Body format"
            value={draft.bodyFormat}
            onChange={(event) => set('bodyFormat', event.target.value as NoteBodyFormat)}
            disabled={disabled}
            helperText="Markdown keeps headings, lists and bold; Plain text asks the AI for text with no formatting symbols."
          >
            {NOTE_BODY_FORMATS.map((format) => (
              <MenuItem key={format} value={format}>
                {NOTE_BODY_FORMAT_LABELS[format]}
              </MenuItem>
            ))}
          </TextField>
        </Box>

        <StructureListEditor
          sections={draft.structure}
          onChange={(structure) => set('structure', structure)}
          disabled={disabled}
        />

        <Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 2 }}>
          <TextField
            fullWidth
            label="Tone"
            value={draft.tone}
            onChange={(event) => set('tone', event.target.value)}
            disabled={disabled}
            helperText={`Optional. Leave empty to let the model decide. e.g. ${TONE_SUGGESTIONS.join(', ')}`}
            slotProps={{ htmlInput: { maxLength: MAX_HINT_CHARS } }}
          />
          <TextField
            fullWidth
            label="Length"
            value={draft.length}
            onChange={(event) => set('length', event.target.value)}
            disabled={disabled}
            helperText={`Optional. Leave empty to let the model decide. e.g. ${LENGTH_SUGGESTIONS.join(', ')}`}
            slotProps={{ htmlInput: { maxLength: MAX_HINT_CHARS } }}
          />
        </Box>

        <TextField
          select
          fullWidth
          label="Model"
          value={draft.model}
          onChange={(event) => set('model', event.target.value)}
          disabled={disabled}
          helperText={
            isStaleModel
              ? 'The model saved on this template is no longer permitted here. Pick another one.'
              : 'Optional override. Only models this deployment permits are listed.'
          }
        >
          <MenuItem value="">
            {defaultModel
              ? `Use the deployment default (${defaultModel})`
              : 'Use the deployment default'}
          </MenuItem>
          {models.map((model) => (
            <MenuItem key={model.id} value={model.id}>
              {model.label}
            </MenuItem>
          ))}
          {isStaleModel && (
            // Rendered so the Select has a matching option (MUI warns and
            // renders blank otherwise), disabled so it cannot be chosen again.
            <MenuItem value={draft.model} disabled>
              {draft.model} — no longer permitted
            </MenuItem>
          )}
        </TextField>
      </Stack>
    </Paper>
  );
}

export default NoteTemplateEditor;
