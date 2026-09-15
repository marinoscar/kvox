// =============================================================================
// The wizard vocabulary  (issue #129, epic #118)
// =============================================================================
//
// Shared components for the multi-step screens of epic #118 (the install
// wizard, #131; doctor/update/status/certificates/about, #132), so three
// screens do not implement the same keyboard handling three ways. Every
// component here is pure over props, gates its keys on `isActive` exactly as
// `ScrollBox` does, respects the `NARROW_COLUMNS`/`TINY_COLUMNS` tiers from
// layout.tsx, and keeps no state a screen would need to reach into. The
// screen contract each follows is stated in its own file header.
//
// The pure derivations (`wizardReduce`, `stepRail`, `fieldState`,
// `checklistRows`, `renderRows`, `confirmChoices`, ...) are exported beside
// the components because they ARE what the components draw, and because
// tests assert them as data rather than mounting anything.
// =============================================================================

export { wizardReduce, canGoBack, clampIndex } from './wizard-state.js';
export type { WizardStep, WizardAction, WizardTransition } from './wizard-state.js';

export { useWizard } from './use-wizard.js';
export type { UseWizardOptions, WizardControls } from './use-wizard.js';

export { WizardFrame, stepRail, RAIL_SEPARATOR } from './wizard-frame.js';
export type { WizardFrameProps, StepRail } from './wizard-frame.js';

export { fieldState, acceptSuggestion, SECRET_MASK } from './field-state.js';
export type { FieldState, Suggestion, TextFieldSpec } from './field-state.js';

export { TextField } from './text-field.js';
export type { TextFieldProps } from './text-field.js';

export { SelectField, choiceIndex } from './select-field.js';
export type { SelectChoice, SelectFieldProps } from './select-field.js';

export { Form, firstInvalidField, formLabelWidth, formValue } from './form.js';
export type { FormFieldSpec, FormProps } from './form.js';

export { Checklist, checklistRows, CHECKLIST_GLYPHS, CHECKLIST_COLORS } from './checklist.js';
export type { ChecklistItem, ChecklistProps, ChecklistRow, ChecklistStatus } from './checklist.js';

export { KeyValue, renderRows, keyValueLayout, MASKED_VALUE } from './key-value.js';
export type { KeyValueLayout, KeyValueProps, KeyValueRow, RenderedRow } from './key-value.js';

export {
  ConfirmDialog,
  confirmChoices,
  CONFIRM_DEFAULT_INDEX,
  DEFAULT_CANCEL_LABEL,
} from './confirm-dialog.js';
export type { ConfirmChoice, ConfirmDialogProps } from './confirm-dialog.js';

export { contentWidth, useContentWidth, FRAME_CHROME_COLUMNS } from './content-width.js';
export { truncateEnd, ELLIPSIS } from './truncate.js';
