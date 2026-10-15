// =============================================================================
// Notes and note templates in the Danger Zone (issue #80; declared here by
// issue #460)
// =============================================================================
//
// Two user-data categories and one narrow scope:
//
//   • `notes`         — a note, its rendered exports and its uploaded source
//                       document (the narrow `notes` scope reaches ONLY this).
//   • `noteTemplates` — the caller's own custom templates (`content` and
//                       `everything` only).
//
// They used to be two `case`s in `user-data/job-types.ts`, a count plus
// `noteBytes` (and the extracted-text rule that imported `NOTES_MANAGED_BY` and
// `readExtractedObjectId`) in `UserDataService`, and `deleteNotes`,
// `deleteNoteTemplates` plus a search-index sweep in `UserDataPurgeHandler`; the
// hooks now live in `notes.user-data.hooks.ts`. `kvox.manifest.ts` registers the
// exports below.
//
// ⚠ THIS FILE MUST STAY LIGHT (see `ask/ask.user-data.ts`): the hook class is
// referenced by `import type` and provided under the string token below.
// =============================================================================

import {
  userDataCategorySchema,
  userDataCountOnlySchema,
} from '../user-data/dto/user-data-summary-parts';
import type { UserDataCategoryDef, UserDataScopeDef } from '../user-data/user-data.registries';
import type { NotesUserDataHooks } from './notes.user-data.hooks';

/** The provider token `NotesModule` binds `NotesUserDataHooks` under. */
export const NOTES_USER_DATA_HOOKS = 'NOTES_USER_DATA_HOOKS';

export const NOTES_USER_DATA_CATEGORY: UserDataCategoryDef = {
  id: 'notes',
  label: 'Notes',
  description: "The caller's notes, their rendered exports and any uploaded source document.",
  content: true,
  order: 20,
  summary: {
    key: 'notes',
    schema: userDataCategorySchema.describe(
      "The caller's notes, their rendered exports and any uploaded source document.",
    ),
    inject: NOTES_USER_DATA_HOOKS,
    run: (hooks: NotesUserDataHooks, userId: string) => hooks.summarizeNotes(userId),
  },
  purge: {
    order: 40,
    inject: NOTES_USER_DATA_HOOKS,
    run: (hooks: NotesUserDataHooks, userId: string) => hooks.purgeNotes(userId),
  },
};

export const NOTE_TEMPLATES_USER_DATA_CATEGORY: UserDataCategoryDef = {
  id: 'noteTemplates',
  label: 'Note templates',
  description:
    "The caller's own custom note templates. Removed by `content` and `everything` only — " +
    'the narrow `notes` scope leaves them alone, because a template is reusable ' +
    'configuration with its own settings page rather than note content. Built-ins are ' +
    'excluded from this count entirely: they belong to the deployment, are readable by ' +
    'everyone, and no user can delete one.',
  // ⚠ NOTE TEMPLATES ARE `content`/`everything` ONLY — THE NARROW `notes`
  // SCOPE DOES NOT TOUCH THEM. (`content: true` and no narrow scope listing
  // `noteTemplates` is what encodes that.)
  //
  // A template is not note CONTENT; it is reusable CONFIGURATION. It has its
  // own settings destination (`/settings/note-templates`), it is authored
  // deliberately and independently of any particular note, and its whole
  // purpose is to be used by notes that DO NOT EXIST YET — so "the notes are
  // gone, therefore the recipes are meaningless" is exactly backwards.
  //
  // The user-facing consequence is the argument. A person clicking "Delete
  // notes" on a row whose inventory reads "12 notes · 340 MB" has been told
  // they are deleting notes; silently emptying a different settings page they
  // did not open is the kind of surprise a Danger Zone can least afford. And
  // unlike the data itself, templates were HAND-WRITTEN and are recoverable
  // from nowhere — there is no provider, no bucket and no source recording to
  // rebuild one from.
  //
  // The composites still take them, and that is consistent rather than a
  // compromise: `content` means "everything you made", and a template is
  // something you made.
  content: true,
  order: 40,
  summary: {
    key: 'noteTemplates',
    schema: userDataCountOnlySchema.describe(
      "The caller's own custom note templates. Removed by `content` and `everything` only — " +
        'the narrow `notes` scope leaves them alone, because a template is reusable ' +
        'configuration with its own settings page rather than note content. Built-ins are ' +
        'excluded from this count entirely: they belong to the deployment, are readable by ' +
        'everyone, and no user can delete one.',
    ),
    inject: NOTES_USER_DATA_HOOKS,
    run: (hooks: NotesUserDataHooks, userId: string) => hooks.summarizeNoteTemplates(userId),
  },
  purge: {
    order: 60,
    inject: NOTES_USER_DATA_HOOKS,
    run: (hooks: NotesUserDataHooks, userId: string) => hooks.purgeNoteTemplates(userId),
  },
};

export const NOTES_USER_DATA_CATEGORIES: readonly UserDataCategoryDef[] = [
  NOTES_USER_DATA_CATEGORY,
  NOTE_TEMPLATES_USER_DATA_CATEGORY,
];

export const NOTES_USER_DATA_SCOPE: UserDataScopeDef = {
  id: 'notes',
  label: 'Notes',
  description: 'Your notes only — not your note templates.',
  categories: ['notes'],
  confirmation: 'NOTES',
  layer: 'user',
  order: 20,
};
