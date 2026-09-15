// =============================================================================
// What a text field shows for a value  (issue #129, epic #118)
// =============================================================================
//
// `TextField` (text-field.tsx) and `Form` (form.tsx) both need to answer the
// same three questions about one typed value — is it valid, what does the
// terminal show, would Tab accept the suggestion — and they must agree: Form
// moves to the next field on Tab UNLESS the field is about to accept a
// suggestion with it. One pure function is how they agree, and how the logic
// is tested without mounting anything (tui/screens/deploy.test.ts's rule).
// =============================================================================

export interface Suggestion {
  /** The value Tab fills in. */
  value: string;
  /**
   * Why it is suggested — shown beside it in dim text. Epic #118 decision 9:
   * a server-derived default is always shown WITH its reason and always
   * editable, never silently applied.
   */
  reason: string;
}

export interface TextFieldSpec {
  label: string;
  /** Mask the typed characters. The mask never reveals the length is zero. */
  secret?: boolean | undefined;
  /** The error for `value`, or `undefined` when acceptable. */
  validate?: ((value: string) => string | undefined) | undefined;
  /** One line of help shown above the field. */
  help?: string | undefined;
  suggestion?: Suggestion | undefined;
  /** Placeholder while empty. Defaults to the suggestion's value. */
  placeholder?: string | undefined;
}

export interface FieldState {
  value: string;
  /** The validator's message, when there is one. */
  error: string | undefined;
  valid: boolean;
  /** What the terminal shows for the value: masked when `secret`. */
  display: string;
  /** The suggestion, while it is still offered (the field is empty). */
  suggestion: Suggestion | undefined;
  /** `suggestion.value`, masked when `secret` so a generated secret is not printed. */
  suggestionDisplay: string | undefined;
  /** Whether Tab would fill the suggestion in rather than move focus. */
  tabAccepts: boolean;
}

/** One mask character per typed character, matching ink-text-input's `mask`. */
export const SECRET_MASK = '*';

/**
 * The state of a text field for `value` under `spec`.
 *
 * The suggestion is offered only while the field is EMPTY. Once the operator
 * has typed anything, Tab moves to the next field like everywhere else —
 * replacing their text with the suggestion would be the one thing Tab must
 * never do to somebody who pressed it to move on. Clearing the field brings
 * the offer back.
 */
export function fieldState(value: string, spec: TextFieldSpec): FieldState {
  const error = spec.validate?.(value);
  const offered = value === '' ? spec.suggestion : undefined;

  return {
    value,
    error,
    valid: error === undefined,
    display: mask(value, spec),
    suggestion: offered,
    suggestionDisplay: offered === undefined ? undefined : mask(offered.value, spec),
    tabAccepts: offered !== undefined,
  };
}

/** The value after Tab: the suggestion when it is offered, else unchanged. */
export function acceptSuggestion(value: string, spec: TextFieldSpec): string {
  return fieldState(value, spec).suggestion?.value ?? value;
}

function mask(value: string, spec: TextFieldSpec): string {
  return spec.secret === true ? SECRET_MASK.repeat(value.length) : value;
}
