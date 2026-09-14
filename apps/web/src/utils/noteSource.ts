/**
 * "What was this note made from?" — the pure half. Issue #57, epic #45.
 *
 * A note's whole premise is that it is DERIVED: the epic's own title is
 * "Trusted Transcript → AI Notes", and a list that showed twenty notes with no
 * indication of what each came from would have thrown away the one fact that
 * makes them trustworthy. So every row says "from <the thing>", and the thing
 * is a link wherever the application has a page for it.
 *
 * Pure and free of React so the three-way mapping can be asserted by calling a
 * function, exactly as `utils/transcriptDisplay.ts` is.
 */

import type { Note, NoteListItem, NoteSourceType } from '../services/notes';

/** The minimum a caller must hold to answer any question in this file. */
export type NoteSourceFields = Pick<
  Note | NoteListItem,
  'sourceType' | 'sourceTranscriptId' | 'sourceNoteId' | 'sourceObjectId'
>;

/** One resolved reference: which kind of thing, and which one. */
export interface NoteSourceRef {
  type: NoteSourceType;
  id: string;
}

/**
 * The id this note's `sourceType` says to read, or `null`.
 *
 * `null` is reachable through a row whose type and id columns disagree — which
 * the API's own union makes unrepresentable on the way IN, but which a row
 * written by a different build could still present on the way OUT. Every caller
 * here degrades to "a transcript" rather than rendering a broken link.
 */
export function noteSourceRef(note: NoteSourceFields): NoteSourceRef | null {
  switch (note.sourceType) {
    case 'transcript':
      return note.sourceTranscriptId ? { type: 'transcript', id: note.sourceTranscriptId } : null;
    case 'note':
      return note.sourceNoteId ? { type: 'note', id: note.sourceNoteId } : null;
    case 'document':
      return note.sourceObjectId ? { type: 'document', id: note.sourceObjectId } : null;
    default:
      return null;
  }
}

/**
 * Where clicking the source goes, or `null` for one with nowhere to go.
 *
 * ⚠ A DOCUMENT HAS NO PAGE, AND THAT IS NOT AN OVERSIGHT. An uploaded source
 * document is a storage object `managed_by: 'notes'` — deliberately absent from
 * `GET /api/storage/objects` and refusing its generic DELETE — so there is no
 * route in this application that renders one, and inventing a link to a
 * download would hand the user a file they uploaded rather than the note they
 * are reading. It is named, and not linked.
 */
export function noteSourcePath(note: NoteSourceFields): string | null {
  const ref = noteSourceRef(note);
  if (!ref) return null;

  switch (ref.type) {
    case 'transcript':
      return `/transcripts/${ref.id}`;
    case 'note':
      return `/notes/${ref.id}`;
    case 'document':
      return null;
  }
}

/**
 * What to say before the source's own name has been resolved — or when it
 * cannot be.
 *
 * A NOUN, never an id. The row is trying to tell a human what this note came
 * from; a uuid where a title should be is worse than the category alone,
 * because it looks like the answer.
 */
export function noteSourceFallbackLabel(type: NoteSourceType): string {
  switch (type) {
    case 'transcript':
      return 'a transcript';
    case 'note':
      return 'another note';
    case 'document':
      return 'an uploaded document';
    default:
      return 'a source';
  }
}
