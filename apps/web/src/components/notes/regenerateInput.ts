/**
 * "What actually changed?" — the regenerate request body. Issue #109, epic #45.
 *
 * =============================================================================
 * ⚠ A DIFF, NOT A SNAPSHOT — AND THE DIFFERENCE IS BILLED TO THE USER
 * =============================================================================
 *
 * `POST /api/notes/{id}/regenerate` takes `{ templateId?, contextText?, model? }`
 * with every field optional, and an OMITTED field means "keep what the note
 * already has". Sending the form's three values unconditionally would work for
 * a while and then quietly stop being the same request: a note whose template
 * has since been archived would have its `templateId` re-asserted against a row
 * the API may refuse, and a `model` the deployment no longer permits would be
 * re-sent by a form that merely displayed it.
 *
 * So this function sends a DIFF. The no-change case produces `{}`, which is
 * byte-for-byte the request #58's confirm-only dialog sent — which is what lets
 * this feature be added without changing what an unchanged regeneration does,
 * and what `NotePage.test.tsx` pins by asserting the body.
 *
 * =============================================================================
 * ⚠ `null` IS A VALUE HERE, NOT AN ABSENCE
 * =============================================================================
 *
 * The context is the one field with three states rather than two, because the
 * API defines three: absent keeps it, a string replaces it, and an explicit
 * `null` CLEARS it. A user who selects the context text and deletes it is
 * asking for the third, and a builder that treated "empty" as "omit" would
 * silently regenerate with the very context they just removed — the failure
 * mode this file exists to make impossible.
 *
 * Pure and free of React, like `utils/noteSource.ts`, so every branch below can
 * be asserted by calling a function rather than by driving a dialog.
 */

import type { Note, RegenerateNoteInput } from '../../services/notes';

/** The three controls the regenerate dialog holds, as strings from the DOM. */
export interface RegenerateFormValues {
  /** `''` means "no template chosen" — a state the dialog refuses to submit. */
  templateId: string;
  contextText: string;
  /** `''` means "the model list has not arrived" — likewise unsubmittable. */
  model: string;
}

/**
 * The note's own three values, and nothing else.
 *
 * `Pick` rather than the whole `Note`: this function must not be able to read
 * the body, the status or the version, because any of those creeping into the
 * decision would make the request depend on state the user was not editing.
 */
export type RegenerateNoteFields = Pick<Note, 'templateId' | 'contextText' | 'model'>;

export function buildRegenerateInput(
  note: RegenerateNoteFields,
  form: RegenerateFormValues,
): RegenerateNoteInput {
  const input: RegenerateNoteInput = {};

  // --- The template ---------------------------------------------------------
  // Included only when it differs from the note's own. The empty string is
  // never sent: the API's `templateId` is `string | undefined` with no way to
  // express "no template", and the dialog disables its confirm button on an
  // empty value precisely so this branch is unreachable from the UI — the guard
  // is here because a builder that could produce `templateId: ''` is one a
  // future caller could reach.
  if (form.templateId !== '' && form.templateId !== note.templateId) {
    input.templateId = form.templateId;
  }

  // --- The context ----------------------------------------------------------
  // ⚠ THE TRIMMED FORM VALUE AGAINST THE NOTE'S STORED ONE. Trimming before the
  // comparison means a user who added a stray newline at the end of a textarea
  // has changed nothing, and is not charged for a regeneration that produces
  // the same prompt. The three outcomes are the API's own three states:
  //
  //   equal                     → omit (keep what the note has)
  //   empty, note had text      → `null` (the explicit clear)
  //   anything else             → the trimmed string
  const trimmedContext = form.contextText.trim();
  const currentContext = note.contextText ?? '';

  if (trimmedContext !== currentContext) {
    input.contextText = trimmedContext === '' ? null : trimmedContext;
  }

  // --- The model ------------------------------------------------------------
  // Same rule as the template, and the empty string is excluded for the same
  // reason: while `GET /api/ai/config` is still in flight the dialog has no
  // model list, shows no selection, and must not turn that into a request that
  // names no model at all.
  if (form.model !== '' && form.model !== note.model) {
    input.model = form.model;
  }

  return input;
}

export default buildRegenerateInput;
