/**
 * What the regenerate dialog needs to fetch, fetched only when it is open.
 * Issue #109, epic #45.
 *
 * =============================================================================
 * ⚠ THE POINT IS THE `open &&` AT THE CALL SITE
 * =============================================================================
 *
 * `RegenerateNoteDialog` needs the template list and the note's own template
 * row; `useNoteTemplates()` fires `GET /api/note-templates` on mount and
 * `useNoteTemplateDetail()` fires a second request. Putting either hook in
 * `NotePage` would mean that READING a note — by far the most common thing that
 * happens on that page, and the thing the page is for — issued two requests for
 * a dialog most readers never open.
 *
 * Hooks cannot be called conditionally, so the condition has to be a component
 * boundary: `NotePage` renders `{open && <RegenerateNoteDialogContainer …/>}`
 * and this file's hooks run only inside that branch. The alternative — a
 * `skip` flag threaded through both hooks — would put the same condition in two
 * more places and leave the page importing them anyway.
 *
 * It also keeps `NotePage.tsx` from growing: it is already 788 lines, and three
 * more pieces of state plus two hooks for a dialog it renders once is exactly
 * the kind of accretion that makes a page unreadable.
 *
 * =============================================================================
 * IT FETCHES THE TEMPLATE THE CONTEXT PANEL ALSO FETCHES, DELIBERATELY
 * =============================================================================
 *
 * `NotePage` holds its own `useNoteTemplateDetail(note.templateId)` for the
 * "How this note was generated" panel, so opening this dialog reads the same
 * row a second time. That is one indexed row read on a user gesture, against a
 * self-contained component that can be mounted anywhere a note is in scope —
 * and the alternative, threading the page's result down as a prop, would tie
 * this dialog's correctness to a hook its caller happens to run. The panel is
 * free to stop reading templates without breaking regeneration.
 */

import { useCallback, useState } from 'react';

import { useNoteTemplateDetail, useNoteTemplates } from '../../hooks/useNoteTemplates';
import type { AiConfigModel } from '../../services/ai';
import type { Note, RegenerateNoteInput } from '../../services/notes';
import { RegenerateNoteDialog } from './RegenerateNoteDialog';

/**
 * Where "Show hidden templates" is remembered (#312) — per viewer, per browser.
 *
 * A convenience, not state anybody else needs, so `localStorage` rather than a
 * user setting; every access is wrapped because storage can be absent or throw
 * (a private window, blocked site data), and the dialog must work without it.
 */
const SHOW_HIDDEN_KEY = 'regenerate.showHiddenTemplates';

function readShowHidden(): boolean {
  try {
    return window.localStorage.getItem(SHOW_HIDDEN_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeShowHidden(value: boolean): void {
  try {
    window.localStorage.setItem(SHOW_HIDDEN_KEY, value ? 'true' : 'false');
  } catch {
    // Not remembered; the choice still applies for this dialog.
  }
}

export interface RegenerateNoteDialogContainerProps {
  open: boolean;
  note: Note;
  models: AiConfigModel[];
  defaultModel: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (input: RegenerateNoteInput) => void;
  /** Passed through: `template` focuses the template select on open (#312). */
  initialFocus?: 'template';
}

export function RegenerateNoteDialogContainer({
  open,
  note,
  models,
  defaultModel,
  busy,
  error,
  onCancel,
  onConfirm,
  initialFocus,
}: RegenerateNoteDialogContainerProps) {
  // ⚠ HIDDEN TEMPLATES ARE EXCLUDED BY DEFAULT, like every other picker (#311):
  // a template the user hid must not be offered unless they ask for it. The
  // option is derived from state rather than branching between two hook calls,
  // and `useNoteTemplates` re-reads the list whenever it changes.
  const [showHidden, setShowHidden] = useState(readShowHidden);
  const { templates, isLoading: templatesLoading } = useNoteTemplates({
    includeHidden: showHidden,
  });
  const detail = useNoteTemplateDetail(note.templateId);

  const handleShowHiddenChange = useCallback((value: boolean) => {
    setShowHidden(value);
    writeShowHidden(value);
  }, []);

  return (
    <RegenerateNoteDialog
      open={open}
      note={note}
      templates={templates}
      templatesLoading={templatesLoading}
      // `detail.template` is `null` for every state but `loaded` — including
      // `missing`, which is a template this user can no longer read. The dialog
      // treats that exactly like "not in the list": it falls back to the note's
      // denormalised `templateName`, so the select still shows a name rather
      // than a blank.
      currentTemplate={detail.template}
      currentTemplateState={detail.state}
      initialFocus={initialFocus}
      showHiddenTemplates={showHidden}
      onShowHiddenTemplatesChange={handleShowHiddenChange}
      models={models}
      defaultModel={defaultModel}
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export default RegenerateNoteDialogContainer;
