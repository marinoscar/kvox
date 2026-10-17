import type { Prisma } from '@prisma/client';
import type { UserDataModelHint } from '@marinoscar/platform-api/user-data';
import { NOTE_PURGE_JOB_TYPE } from '@marinoscar/kvox-api/notes';

// =============================================================================
// The notes slice's registrations with the platform's user-data slice (the Danger Zone)
// (issue #80, epic #78; moved next to the slice's configuration by issue #495, epic #491)
// =============================================================================
//
// What the platform's "delete my data" feature needs to know about the notes: two categories
// (`notes`, `noteTemplates`), the `notes` scope, and a hint per Prisma model saying how its rows
// go. `Note` DELEGATES to `note.purge` (the slice's owner-level payload, `{ mode: 'owner',
// userId }`): the platform enqueues it after its own rows commit and the handler soft-deletes
// every live note, fans out to the per-note purge (the note's bytes, exports and source
// document) and detaches the notes derived from another note first
// (`NotesUserDataService.clearDerivedReferences`). `NoteTemplate` is deleted with the user's
// own rows but KEPT while a note still names it (`keepWhenReferenced`), the same rule
// `NoteTemplatesService.remove` applies one template at a time.
//
// `user-data.manifest.ts` registers these, in the same relative position the entries had
// before the move; the scope `content` and `everything` list the category ids there.
// =============================================================================

/** Per-item and owner-level purge of a user's notes (the permanent job type string). */
export const NOTE_PURGE_DELEGATE = NOTE_PURGE_JOB_TYPE;

/** The categories the notes own, in the order the Danger Zone shows them. */
export const NOTES_USER_DATA_CATEGORIES = [
  {
    id: 'notes',
    label: 'Notes',
    description: 'Your notes, their rendered exports and any document you uploaded as a source.',
    content: true,
    order: 2,
  },
  {
    id: 'noteTemplates',
    label: 'Note templates',
    description:
      'Your own custom note templates. Built-in templates are not yours and stay. A template a note still uses is kept.',
    content: true,
    order: 4,
  },
] as const;

/** The scope that deletes only the notes (not the templates). */
export const NOTES_USER_DATA_SCOPE = {
  id: 'notes',
  label: 'Notes',
  description: 'Your notes only, not your note templates.',
  categories: ['notes'],
  confirmation: 'NOTES',
  layer: 'specific',
  order: 20,
} as const;

/**
 * The model hints of the notes tables.
 *
 * @param ownerDelegate - builds the delegate (the job type and the owner-level payload) for a job type.
 * @returns the hints for `Note`, `NoteTemplate` and `UserHiddenNoteTemplate`.
 */
export function notesUserDataModels(
  ownerDelegate: (jobType: string) => NonNullable<UserDataModelHint<Prisma.ModelName>['delegate']>,
): Array<UserDataModelHint<Prisma.ModelName>> {
  return [
    { model: 'Note', category: 'notes', delegate: ownerDelegate(NOTE_PURGE_DELEGATE) },

    { model: 'NoteTemplate', category: 'noteTemplates', keepWhenReferenced: true },
    { model: 'UserHiddenNoteTemplate', category: 'noteTemplates' },
  ];
}
