/**
 * How a model's token limits are DESCRIBED, and how they are overridden —
 * issue #97, epic #45.
 *
 * =============================================================================
 * WHY THIS IS ONE SHARED MODULE AND NOT TWO SIMILAR-LOOKING ONES
 * =============================================================================
 *
 * Two surfaces show the same fact about the same model: the discovery dialog
 * (`AiModelDiscoveryDialog`) while deciding whether to permit it, and the
 * permitted-models editor (`AiPermittedModels`) afterwards. Before #97 they had
 * drifted into saying different things — the dialog spoke of what the VENDOR
 * listed, the editor of what the BUILD knew — and an administrator ticking
 * "Needs token limits" in one place and reading "Needs token limits" in the
 * other had no way to tell they were two different sentences about two different
 * questions.
 *
 * So the chip, its colour, its explanation and the override control all live
 * here once. A future third surface gets them by importing, and the two existing
 * ones cannot disagree without an edit to this file.
 *
 * =============================================================================
 * ⚠ THE CHIP STATES PROVENANCE. IT IS NOT A TO-DO ITEM.
 * =============================================================================
 *
 * The chip this replaced was an orange "Needs token limits" — a demand, and the
 * visible half of issue #97's bug. What replaces it says where the numbers came
 * from and stops there, because after #97 every one of these states is a model
 * that works right now:
 *
 *   catalogue  this release was written against these exact numbers
 *   derived    a dated snapshot matched a family; `derivedFrom` names which, so
 *              the inference is auditable rather than magic
 *   default    nothing matched, so a conservative floor applies
 *   override   the administrator supplied the numbers themselves
 *
 * ⚠ `'default'` IS THE ONE THAT NEEDS A SENTENCE, AND IT IS NOT A WARNING. A
 * floor below the vendor's real window has exactly one consequence: a very large
 * source is refused by docs/specs/notes.md §3.3's budget, with a message naming
 * the numbers. Nothing is truncated, nothing is mis-billed, and nothing silently
 * degrades. Saying so is what stops an administrator treating the chip as an
 * error to clear — while still telling them that the override below is the fix
 * if their sources are large. The colour is `warning` in OUTLINE, deliberately
 * lighter than the filled orange badge it replaced.
 *
 * =============================================================================
 * ⚠ AN EXISTING OVERRIDE IS ALWAYS EXPANDED. THAT IS A CORRECTNESS RULE.
 * =============================================================================
 *
 * The override is collapsed by default — that collapse is the point of #97, and
 * it is what lets several models fit on a 360px screen instead of one. But a row
 * that hid numbers the administrator had ALREADY typed would render an override
 * they could neither see nor remove, and the next save (built from what the form
 * holds) would carry it silently forever. So `expanded` is derived rather than
 * stored: an override present means open, always, and the control offered in
 * that state is "Use detected limits" — a way OUT of the override, not a way to
 * hide it.
 */

import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ChipProps } from '@mui/material/Chip';

import type { AiModelLimitSource } from '../../services/ai';
import {
  AiModelNumberFields,
  EMPTY_MODEL_NUMBERS,
  isModelNumbersEmpty,
  parseModelNumbers,
  validateModelNumbers,
  type EffectiveModelLimits,
  type ModelNumbersDraft,
  type ModelNumbersErrors,
} from './AiModelNumberFields';

/**
 * What the API resolved for one model, carried to wherever it is rendered.
 *
 * ⚠ DISPLAY ONLY. Nothing built from this is ever sent back — `toAllowedModels`
 * writes the four policy fields and nothing else. Echoing the server's own
 * inference to it as though an administrator had chosen it would freeze today's
 * numbers into the stored policy and outlive the release that corrects them.
 *
 * `null` for the whole thing is a legitimate state, not a loading one: a model
 * added by hand has no provenance until the next load answers for it, and an
 * older API sends none at all. Both render as "the server decides", with the
 * override still available.
 */
export interface ModelLimitProvenance {
  source: AiModelLimitSource;
  /** The catalogue id the numbers came from when `source` is `'derived'`. */
  derivedFrom: string | null;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
}

/** The chip's words, colour, and the one sentence some of them need. */
export interface ModelLimitDescription {
  label: string;
  color: ChipProps['color'];
  variant: ChipProps['variant'];
  /** A sentence worth showing under the row, or `null` when the chip says it all. */
  explanation: string | null;
}

/**
 * Describe one model's limits.
 *
 * ⚠ AN OVERRIDE OUTRANKS EVERYTHING, because it is what will actually be used:
 * the entry's own numbers beat the catalogue, the derivation and the floor
 * alike. Reporting a model as "Known" while an override silently replaced the
 * known numbers would be the most misleading state this component could produce.
 */
export function describeModelLimits(
  provenance: ModelLimitProvenance | null,
  hasOverride: boolean,
): ModelLimitDescription {
  if (hasOverride) {
    return {
      label: 'Custom limits',
      color: 'primary',
      variant: 'filled',
      explanation:
        'These numbers are yours and replace whatever this deployment would have detected.',
    };
  }

  if (!provenance) {
    return {
      label: 'Limits set by this deployment',
      color: 'default',
      variant: 'outlined',
      explanation: null,
    };
  }

  switch (provenance.source) {
    case 'catalogue':
      return {
        label: 'Known model',
        color: 'success',
        variant: 'outlined',
        explanation: null,
      };
    case 'derived':
      return {
        label: provenance.derivedFrom
          ? `Auto-detected — matched ${provenance.derivedFrom}`
          : 'Auto-detected',
        color: 'info',
        variant: 'outlined',
        explanation: null,
      };
    case 'default':
      return {
        label: 'Auto-detected (conservative default)',
        color: 'warning',
        variant: 'outlined',
        explanation:
          'This deployment did not recognise the model, so a safe floor is used. ' +
          'It works normally; the only effect of a window smaller than the real one is ' +
          'that a very large source is refused rather than silently cut. Override below ' +
          'if you know the real numbers.',
      };
  }
}

/**
 * The numbers that apply when nothing is overridden.
 *
 * ⚠ DELIBERATELY IGNORES THE DRAFT. This is what the fields fall back to when a
 * box is left blank and what `validateModelNumbers` compares a lone override
 * against, so it has to describe the world WITHOUT the draft — folding the draft
 * in would make every helper text echo whatever was just typed ("16,384 is used
 * if you leave this blank", under a box containing 16,384) and would compare the
 * cross-field check against itself.
 */
export function effectiveModelLimits(
  provenance: ModelLimitProvenance | null,
): EffectiveModelLimits {
  return {
    contextWindowTokens: provenance?.contextWindowTokens ?? null,
    maxOutputTokens: provenance?.maxOutputTokens ?? null,
  };
}

/** Whether this model's draft is a real override rather than an empty pair. */
export function isModelOverridden(draft: ModelNumbersDraft): boolean {
  return !isModelNumbersEmpty(draft);
}

/** The provenance chip, rendered the same way on every surface. */
export function AiModelLimitChip({
  description,
  sx,
  ...chipProps
}: { description: ModelLimitDescription } & Omit<
  ChipProps,
  'label' | 'color' | 'variant'
>) {
  return (
    <Chip
      size="small"
      label={description.label}
      color={description.color}
      variant={description.variant}
      // ⚠ WRAPPING, NOT THE DEFAULT NOWRAP-AND-ELLIPSIS. A derived chip carries
      // a full model id (`Auto-detected — matched gpt-5.4-mini`), and at 360px
      // an ellipsis would hide the one word that makes the inference auditable.
      // Wrapping is taller; guessing is worse.
      //
      // The caller's `sx` is COMPOSED, not replaced — MUI merges an array of
      // style objects left to right, so a caller adding a margin cannot silently
      // drop the wrapping rules that keep this legible on a phone.
      sx={[
        {
          height: 'auto',
          maxWidth: '100%',
          '& .MuiChip-label': { whiteSpace: 'normal', py: 0.25 },
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
      {...chipProps}
    />
  );
}

function formatLimit(value: number | null): string {
  return value === null ? 'not stated' : `${value.toLocaleString()} tokens`;
}

export interface AiModelLimitsProps {
  /** Disambiguates the fields' accessible names. Must be the model id. */
  modelId: string;
  /** What the API resolved, or `null` when nothing has answered for it yet. */
  provenance: ModelLimitProvenance | null;
  draft: ModelNumbersDraft;
  onChange: (next: ModelNumbersDraft) => void;
  /**
   * Whether an override may be typed at all.
   *
   * False for a read-only administrator, and for a row in the discovery dialog
   * that has not been ticked: numbers typed against a model nobody is permitting
   * would be collected, validated and thrown away on close.
   */
  canOverride: boolean;
  disabled?: boolean;
  /**
   * Whether to spell out a provenance that needs a sentence (the conservative
   * default). Off for an unticked discovery row, where forty copies of the same
   * paragraph is the wall of text #97 exists to remove.
   */
  showExplanation?: boolean;
}

/**
 * The effective limits, stated compactly, with the override behind one press.
 *
 * ⚠ THE DEFAULT STATE IS ONE LINE OF TEXT. That is the whole mobile budget this
 * component gets: the screenshot in issue #97 fits exactly ONE model on a phone
 * because every row carried two full-size inputs it did not need. Everything
 * here is `caption`-sized, wraps rather than scrolls, and expands only when
 * asked.
 */
export function AiModelLimits({
  modelId,
  provenance,
  draft,
  onChange,
  canOverride,
  disabled,
  showExplanation,
}: AiModelLimitsProps) {
  const [requestedOpen, setRequestedOpen] = useState(false);

  const overridden = isModelOverridden(draft);
  // Derived, never stored — see the file header. An override present is always
  // visible, so it can always be removed.
  const expanded = canOverride && (overridden || requestedOpen);

  const effective = effectiveModelLimits(provenance);
  const description = describeModelLimits(provenance, overridden);
  const errors: ModelNumbersErrors = validateModelNumbers(draft, effective);

  const fieldsId = `ai-model-limits-${modelId}`;

  // What is ACTUALLY in force, field by field: a valid override where there is
  // one, the resolved number otherwise. A half-typed override therefore shows
  // one of each, which is exactly what would be saved.
  const typed = parseModelNumbers(draft);
  const shownContext = typed.contextWindowTokens ?? effective.contextWindowTokens;
  const shownOutput = typed.maxOutputTokens ?? effective.maxOutputTokens;
  // ⚠ "NOT STATED" TWICE IS A SENTENCE NOBODY CAN ACT ON. When neither number is
  // known to this screen — a model being typed into the add form, or an API too
  // old to report provenance — say what will happen instead of printing two
  // blanks: the deployment resolves them, which since #97 is always true.
  const summary =
    shownContext === null && shownOutput === null
      ? 'Token limits are worked out by this deployment'
      : `Context ${formatLimit(shownContext)} · Output ${formatLimit(shownOutput)}`;

  return (
    <Box sx={{ minWidth: 0 }}>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{ flexWrap: 'wrap', alignItems: 'center' }}
      >
        <Typography variant="caption" color="text.secondary">
          {summary}
        </Typography>

        {canOverride &&
          (overridden ? (
            <Button
              size="small"
              onClick={() => {
                onChange(EMPTY_MODEL_NUMBERS);
                setRequestedOpen(false);
              }}
              disabled={disabled}
              sx={{ minWidth: 0, px: 1 }}
            >
              Use detected limits
            </Button>
          ) : (
            <Button
              size="small"
              onClick={() => setRequestedOpen((open) => !open)}
              disabled={disabled}
              aria-expanded={expanded}
              aria-controls={fieldsId}
              sx={{ minWidth: 0, px: 1 }}
            >
              {expanded ? 'Cancel override' : 'Override'}
            </Button>
          ))}
      </Stack>

      {showExplanation && description.explanation && (
        <Typography
          variant="caption"
          color="text.secondary"
          component="p"
          sx={{ mt: 0.5 }}
        >
          {description.explanation}
        </Typography>
      )}

      {/* `unmountOnExit` so a collapsed row costs nothing in the accessibility
          tree either: two labelled inputs per model, forty models, is a tab
          order nobody can get through — and they are inputs the administrator
          has said they do not want. */}
      <Collapse in={expanded} unmountOnExit>
        <Box id={fieldsId} sx={{ mt: 1.5 }}>
          <AiModelNumberFields
            modelId={modelId}
            draft={draft}
            errors={errors}
            onChange={onChange}
            disabled={disabled}
            effective={effective}
          />
        </Box>
      </Collapse>
    </Box>
  );
}

export default AiModelLimits;
