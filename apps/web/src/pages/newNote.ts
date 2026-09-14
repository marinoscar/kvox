/**
 * The new-note flow's pure parts — issue #57, epic #45.
 *
 * A SEPARATE MODULE from the page, like `newTranscript.ts` beside
 * `NewTranscriptPage`, so the two decisions that are actually easy to get wrong
 * — "what body does this form produce?" and "is this form finished?" — can be
 * asserted by calling a function rather than by driving a three-step form and
 * inspecting a request.
 */

import type { NoteSource, NoteSourceType } from '../services/notes';

/** The three choices in step 1, in the order they are offered. */
export interface NoteSourceKindOption {
  value: NoteSourceType;
  label: string;
  /** One line under the radio, saying what this choice is FOR. */
  hint: string;
}

export const NOTE_SOURCE_KINDS: readonly NoteSourceKindOption[] = [
  {
    value: 'transcript',
    label: 'A transcript',
    hint: 'A conversation this application has already transcribed.',
  },
  {
    value: 'note',
    label: 'Another note',
    hint: 'Rewrite or reshape a note you already have — a summary of a summary.',
  },
  {
    value: 'document',
    label: 'A document',
    hint: 'Upload a PDF, plain text or Markdown file to write from.',
  },
];

/** What the form holds while it is being filled in. */
export interface NewNoteDraft {
  kind: NoteSourceType;
  transcriptId: string;
  noteId: string;
  /** The storage object id an uploaded document produced, once it has one. */
  objectId: string;
  templateId: string;
  contextText: string;
}

export function emptyNewNoteDraft(): NewNoteDraft {
  return { kind: 'transcript', transcriptId: '', noteId: '', objectId: '', templateId: '', contextText: '' };
}

/**
 * The `source` member of a `POST /api/notes` body, or `null` if step 1 is not
 * finished.
 *
 * ⚠ EXACTLY ONE ID CROSSES THE WIRE, whatever the form happens to be holding.
 * A user who picks a transcript, changes their mind, uploads a document and
 * submits must not send the transcript id as well — the API's source is a
 * DISCRIMINATED union and a body carrying two ids is a body it rejects. Reading
 * only the field the current `kind` names makes that unrepresentable rather
 * than merely avoided, which is why the form keeps three separate fields and
 * this function narrows them, instead of one field the three pickers fight over.
 */
export function buildNoteSource(draft: NewNoteDraft): NoteSource | null {
  switch (draft.kind) {
    case 'transcript':
      return draft.transcriptId ? { type: 'transcript', transcriptId: draft.transcriptId } : null;
    case 'note':
      return draft.noteId ? { type: 'note', noteId: draft.noteId } : null;
    case 'document':
      return draft.objectId ? { type: 'document', objectId: draft.objectId } : null;
    default:
      return null;
  }
}

/**
 * Is this draft ready to generate?
 *
 * `documentReady` is passed in rather than read off the draft because it is not
 * a property of the FORM — it is the state of a queue job (`note.source.extract`)
 * that is still running somewhere else. A draft naming an uploaded document
 * whose text has not been extracted is complete as a form and not yet
 * generatable, and collapsing the two would either block a transcript source on
 * a flag that never applies to it or let a document through before its text
 * exists (the generation then fails minutes later, on the user's own provider
 * account, for a reason the form could have seen).
 */
export function isNewNoteReady(draft: NewNoteDraft, documentReady: boolean): boolean {
  if (!draft.templateId) return false;
  if (buildNoteSource(draft) === null) return false;
  if (draft.kind === 'document' && !documentReady) return false;
  return true;
}
