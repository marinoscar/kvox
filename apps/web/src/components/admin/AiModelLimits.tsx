/**
 * "Limits and default model" — the deployment-wide ceilings and the default
 * model of the `ai` namespace on `/admin/settings/ai` (issue #477, epic #472;
 * repurposed from the per-model limits control of #97).
 *
 * WHAT IS HERE. The fields the app's extension of the platform `ai` namespace
 * carries and the platform's AI page has no control for:
 *
 *   `defaultModel`      the model a task with no model of its own runs on
 *   `maxInputTokens`    optional cap on the assembled prompt
 *   `maxOutputTokens`   optional cap on one answer
 *   `requestTimeoutMs`  how long one provider request may run
 *   `maxDocumentBytes`  ceiling on one uploaded source document
 *   `reasoningEffort`   the page-wide reasoning effort
 *
 * Per-model limits, the model catalogue and the per-user / per-org rate limits
 * are the platform's (AI models page, AI page); this section never duplicates
 * them.
 *
 * ⚠ `xhigh` RUNS AS `high`. The platform's AI runtime accepts
 * `minimal | low | medium | high`, so the API clamps `xhigh` to `high` before
 * the call. The value stays selectable so a stored setting reads back, and the
 * control's help text says what it does.
 *
 * ⚠ A STALE DEFAULT BLOCKS THE SAVE. A `defaultModel` that is not an enabled
 * model (somebody disabled it on the AI models page) is a policy offering
 * nobody anything: it stays a visible, flagged option rather than silently
 * becoming "None", and {@link limitsHaveError} is true until it is fixed.
 *
 * Presentational: the container owns the draft. No `useMediaQuery` (rule 5).
 */

import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { AI_TASKS_BOUNDS } from '../../services/aiTasks';
import type { AiReasoningEffort, AiTasksSettings } from '../../services/aiTasks';
import {
  AiLimitNumberField,
  integerFieldError,
  parseOptionalInteger,
} from './AiModelNumberFields';

/** The limits section mid-edit. Numbers are strings; `defaultModel` `''` means none. */
export interface AiLimitsDraft {
  defaultModel: string;
  maxInputTokens: string;
  maxOutputTokens: string;
  requestTimeoutMs: string;
  maxDocumentBytes: string;
  reasoningEffort: AiReasoningEffort;
}

/** Per-field messages, `null` where the field is fine. */
export interface AiLimitsErrors {
  defaultModel: string | null;
  maxInputTokens: string | null;
  maxOutputTokens: string | null;
  requestTimeoutMs: string | null;
  maxDocumentBytes: string | null;
}

/** An enabled model, as the default-model select lists it. */
export interface AiLimitsModelOption {
  id: string;
  label: string;
}

/**
 * The reasoning-effort options, LABELLED WITH THEIR TRADE-OFF. Ascending order
 * of spend, so the list itself is the scale. `xhigh` says what it really does.
 */
export const REASONING_EFFORT_OPTIONS: ReadonlyArray<{
  value: AiReasoningEffort;
  label: string;
}> = [
  { value: 'none', label: 'None (fastest, no reasoning)' },
  { value: 'low', label: 'Low (brief reasoning, few extra tokens)' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High (slower, many more output tokens)' },
  { value: 'xhigh', label: 'Extra high (runs as High)' },
];

/** Stored settings → editable draft. */
export function toLimitsDraft(settings: AiTasksSettings): AiLimitsDraft {
  return {
    defaultModel: settings.defaultModel ?? '',
    maxInputTokens: settings.maxInputTokens === null ? '' : String(settings.maxInputTokens),
    maxOutputTokens: settings.maxOutputTokens === null ? '' : String(settings.maxOutputTokens),
    requestTimeoutMs: String(settings.requestTimeoutMs),
    maxDocumentBytes: String(settings.maxDocumentBytes),
    reasoningEffort: settings.reasoningEffort,
  };
}

/**
 * Validate a draft. `enabledModelIds` is the catalogue the default is checked
 * against; when it is empty (the catalogue has not loaded, or no model is
 * enabled yet) the default is not judged, and the server decides.
 */
export function validateLimits(draft: AiLimitsDraft, enabledModelIds: string[]): AiLimitsErrors {
  const defaultModel = draft.defaultModel.trim();
  return {
    defaultModel:
      defaultModel.length > 0 &&
      enabledModelIds.length > 0 &&
      !enabledModelIds.includes(defaultModel)
        ? 'This model is not enabled, so nothing would be able to select it. Choose another or enable it on the AI models page.'
        : null,
    maxInputTokens: integerFieldError(
      draft.maxInputTokens,
      AI_TASKS_BOUNDS.maxInputTokens,
      'tokens',
      true,
    ),
    maxOutputTokens: integerFieldError(
      draft.maxOutputTokens,
      AI_TASKS_BOUNDS.maxOutputTokens,
      'tokens',
      true,
    ),
    requestTimeoutMs: integerFieldError(
      draft.requestTimeoutMs,
      AI_TASKS_BOUNDS.requestTimeoutMs,
      'milliseconds',
      false,
    ),
    maxDocumentBytes: integerFieldError(
      draft.maxDocumentBytes,
      AI_TASKS_BOUNDS.maxDocumentBytes,
      'bytes',
      false,
    ),
  };
}

/** Whether any field is wrong. */
export function limitsHaveError(errors: AiLimitsErrors): boolean {
  return Object.values(errors).some((message) => message !== null);
}

/**
 * The draft as the write body's limit fields. Blank caps are `null` (the model's
 * own maximum), never `undefined`; an empty default is `null` (none chosen).
 * Assumes the draft has been validated.
 */
export function toLimitsInput(
  draft: AiLimitsDraft,
): Pick<
  AiTasksSettings,
  | 'defaultModel'
  | 'maxInputTokens'
  | 'maxOutputTokens'
  | 'requestTimeoutMs'
  | 'maxDocumentBytes'
  | 'reasoningEffort'
> {
  const defaultModel = draft.defaultModel.trim();
  return {
    defaultModel: defaultModel.length === 0 ? null : defaultModel,
    maxInputTokens: parseOptionalInteger(draft.maxInputTokens),
    maxOutputTokens: parseOptionalInteger(draft.maxOutputTokens),
    requestTimeoutMs: Number.parseInt(draft.requestTimeoutMs, 10),
    maxDocumentBytes: Number.parseInt(draft.maxDocumentBytes, 10),
    reasoningEffort: draft.reasoningEffort,
  };
}

export interface AiModelLimitsProps {
  value: AiLimitsDraft;
  onChange: (next: AiLimitsDraft) => void;
  errors: AiLimitsErrors;
  /** The enabled models the default can be chosen from. */
  models: AiLimitsModelOption[];
  /** True for a read-only administrator (`ai_config:read` only). */
  disabled: boolean;
}

export function AiModelLimits({ value, onChange, errors, models, disabled }: AiModelLimitsProps) {
  const set = <K extends keyof AiLimitsDraft>(key: K, next: AiLimitsDraft[K]) =>
    onChange({ ...value, [key]: next });

  const stale =
    value.defaultModel.trim().length > 0 &&
    !models.some((model) => model.id === value.defaultModel.trim());

  return (
    <Paper sx={{ mt: 3, p: { xs: 2, sm: 3 } }}>
      <Typography variant="h6" component="h2" gutterBottom>
        Limits and default model
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Every token is spent on the requesting user&apos;s own provider account. By default each
        request may use the selected model&apos;s full capacity; the two token fields are optional
        spend caps for bounding a surprise on somebody else&apos;s bill. Leave them blank to use
        each model&apos;s maximum. Per-model limits and rate limits are on the AI and AI models
        pages.
      </Typography>

      <TextField
        select
        fullWidth
        label="Default model"
        value={value.defaultModel}
        onChange={(event) => set('defaultModel', event.target.value)}
        disabled={disabled}
        error={!!errors.defaultModel}
        helperText={
          errors.defaultModel ??
          'The model offered first, and the one a task runs on when it has none of its own. Only enabled models are listed.'
        }
        slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
        sx={{ mb: 3 }}
      >
        <MenuItem value="">None</MenuItem>
        {stale && (
          <MenuItem value={value.defaultModel}>{`${value.defaultModel} (not enabled)`}</MenuItem>
        )}
        {models.map((model) => (
          <MenuItem key={model.id} value={model.id}>
            {model.label === model.id ? model.id : `${model.label} (${model.id})`}
          </MenuItem>
        ))}
      </TextField>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 3 }}>
        <AiLimitNumberField
          label="Max input tokens (optional)"
          placeholder="Model maximum"
          value={value.maxInputTokens}
          onChange={(next) => set('maxInputTokens', next)}
          disabled={disabled}
          error={errors.maxInputTokens}
          helperText="Optional cap on the assembled prompt. Blank means the model’s own context window; a cap never raises it."
        />
        <AiLimitNumberField
          label="Max output tokens (optional)"
          placeholder="Model maximum"
          value={value.maxOutputTokens}
          onChange={(next) => set('maxOutputTokens', next)}
          disabled={disabled}
          error={errors.maxOutputTokens}
          helperText="Optional cap on one answer. Blank means the model’s own output ceiling; a cap never raises it."
        />
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mb: 3 }}>
        <AiLimitNumberField
          label="Request timeout (ms)"
          value={value.requestTimeoutMs}
          onChange={(next) => set('requestTimeoutMs', next)}
          disabled={disabled}
          error={errors.requestTimeoutMs}
          helperText="How long one provider request may take before it is abandoned. A streamed completion legitimately runs for minutes."
        />
        <AiLimitNumberField
          label="Max document size (bytes)"
          value={value.maxDocumentBytes}
          onChange={(next) => set('maxDocumentBytes', next)}
          disabled={disabled}
          error={errors.maxDocumentBytes}
          helperText="Ceiling on one uploaded source document. An AI policy, not a storage one: every byte becomes input tokens on the uploading user’s account."
        />
      </Stack>

      <TextField
        select
        fullWidth
        label="Reasoning effort"
        value={value.reasoningEffort}
        onChange={(event) => set('reasoningEffort', event.target.value as AiReasoningEffort)}
        disabled={disabled}
        helperText={
          <>
            How hard the model is asked to think before it answers. Reasoning is billed and counted
            as <strong>output</strong> tokens. Higher effort is slower and costs more.{' '}
            <strong>None</strong> sends no reasoning setting at all, leaving the vendor&apos;s own
            default. <strong>Extra high runs as High</strong>: the AI runtime accepts Low, Medium
            and High, so Extra high is treated as High.
          </>
        }
      >
        {REASONING_EFFORT_OPTIONS.map((option) => (
          <MenuItem key={option.value} value={option.value}>
            {option.label}
          </MenuItem>
        ))}
      </TextField>
    </Paper>
  );
}

export default AiModelLimits;
