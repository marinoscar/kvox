import type { Prisma } from '@prisma/client';
import {
  registerPlatformUserData,
  registerUserDataCategory,
  registerUserDataModels,
  registerUserDataScope,
  storageObjectModelHint,
  userDataModelRegistry,
} from '@marinoscar/platform-api/user-data';
import type { UserDataModelHint } from '@marinoscar/platform-api/user-data';

import { OWNER_PURGE_MODE } from '../../common/owner-purge';
import { FILES_PURGE_UNMANAGED_JOB_TYPE } from '../../kvox-objects/job-types';

// =============================================================================
// This app's registrations on the platform user-data slice (issue #480, epic #478)
// =============================================================================
//
// The platform owns `/api/user-data/*`, the `user.data.purge` job and the Danger
// Zone page. This file is everything this app adds to it: the categories it owns, the
// five scopes (ids and confirmation phrases are permanent API) and one hint per
// owner model saying what a deletion does with it. The planner computes the
// delete order from the Prisma schema; nothing here orders anything.
//
// IMPORTED BEFORE THE MODULE IS COMPOSED (`user-data.config.ts`), and
// `registerPlatformUserData()` runs LAST in this file. The platform skips an
// entry whose id is already registered, so the entries below win exactly where
// they overlap: the `files` category and the `StorageObject` hint. If the order
// were reversed the platform's `StorageObject` hint (`storageObjects: true`) would
// win and its media step would delete every object the user owns, managed ones
// included. The assertion at the bottom turns that mistake into a boot failure.
//
// -----------------------------------------------------------------------------
// WHAT EACH SCOPE DELETES (unchanged, except `everything`; see below)
// -----------------------------------------------------------------------------
//
//   transcripts   transcripts                                  (delegate transcript.purge)
//   notes         notes                                        (delegate note.purge)
//   files         plain uploads, never a managed object        (delegate files.purge_unmanaged)
//   content       transcripts, notes, noteTemplates, files, graph, ask
//   everything    ALL categories: content + notifications, AI history and keys,
//                 access tokens, credentials and settings
//
// ⚠ `content` IS AN EXPLICIT LIST, NOT `'content'`. The platform's built-in
// `notifications` and `ai` categories are `content: true`, so a scope defined as
// `'content'` would also delete the user's inbox, AI run history and AI keys,
// which this application's `content` never did. Naming the six categories keeps
// `content` exactly what it was. `noteTemplates` is NOT reached by the
// narrow `notes` scope: a template is reusable configuration, not note content.
//
// ⚠ `everything` IS THE PLATFORM'S `'all'`, A SUPERSET OF WHAT IT WAS. Before, it
// was `content` + AI keys + personal access tokens + the `onboarding` settings
// namespace. Now it also deletes the user's notifications, AI run and usage
// history, device codes and stored credentials, and the whole `user_settings` row
// (theme, navigation, data tables and the rest, `onboarding` included), and it
// clears the display name and profile image. All of it is the user's own, none of
// it is content, and the account, roles, memberships and session survive. An
// access token is now DELETED rather than revoked (its audit rows survive). The
// confirmation phrase is still `EVERYTHING`. Recorded in
// `docs/specs/user-data-deletion.md` and `docs/CHANGELOG.md`.
// If product review rejects the wider scope, list the categories instead:
// `[...CONTENT_CATEGORIES, 'ai', 'credentials', 'settings']`.
//
// -----------------------------------------------------------------------------
// THE DELEGATES
// -----------------------------------------------------------------------------
//
// A model with a `delegate` is not deleted inline: after its own rows commit the
// purge enqueues the delegate's job (subject `user:<userId>`, queue dedup makes
// every hint that shares a job type one job). The four jobs:
//
//   transcript.purge { mode: 'owner', userId }   clears notes.source_transcript_id
//   note.purge       { mode: 'owner', userId }   (also on OTHER users' notes) and
//                                                notes.source_note_id, soft-deletes,
//                                                queues the per-item purge, forgets
//                                                the search index
//   kg.purge         { scope: 'all', userId }    the whole graph, re-entrant
//   files.purge_unmanaged { userId }             plain uploads; a `files` deletion
//                                                never touches an object in
//                                                `kvox_object_ownership`
//
// `StorageObject` is delegated and does NOT claim `storageObjects: true`, so the
// platform never collects a user's whole object list. Its media step still deletes
// the objects named by an INLINE model's `storageObjectColumns`; this app has none.
//
// Models that have only an actor column (`TranscriptShare`, `TranscriptVersion`,
// `TranscriptExport`, `TranscriptNameCheck`, `NoteVersion`, `NoteExport`, ...) are
// not owner models and need no hint: they go with their transcript or note when
// the per-item purge deletes it, and another user's history on a transcript keeps
// its rows, as before.
// =============================================================================

// The delegates' type strings are literals, not imports of the domain modules'
// constants: this is a base file (`test/architecture/base-domain-boundary.spec.ts`),
// and the strings are permanent job types in any case.
// `test/user-data/user-data-registrations.spec.ts` pins each against the constant its
// handler registers under.

/** Per-item and owner-level purge of a user's transcripts. */
export const TRANSCRIPT_PURGE_DELEGATE = 'transcript.purge';
/** Per-item and owner-level purge of a user's notes. */
export const NOTE_PURGE_DELEGATE = 'note.purge';
/** The whole-graph purge. */
export const KG_PURGE_DELEGATE = 'kg.purge';

/** The six categories `content` deletes, spelled out (see the header). */
export const CONTENT_CATEGORIES = [
  'transcripts',
  'notes',
  'noteTemplates',
  'files',
  'graph',
  'ask',
] as const;

// Display order: this app's categories first, in the order the Danger Zone has
// always listed them, then the platform's (notifications 20, ai 30, credentials
// 40, settings 50). The delete order is the planner's, never this one.
registerUserDataCategory({
  id: 'transcripts',
  label: 'Recordings and transcripts',
  description:
    'Your recordings and their transcripts: the audio, the playback copy, the version history and every export.',
  content: true,
  order: 1,
});
registerUserDataCategory({
  id: 'notes',
  label: 'Notes',
  description: 'Your notes, their rendered exports and any document you uploaded as a source.',
  content: true,
  order: 2,
});
// The platform's own `files` category is skipped once this one is registered.
registerUserDataCategory({
  id: 'files',
  label: 'Files',
  description:
    'Files you uploaded yourself. Audio and documents that belong to a transcript or note are deleted with them.',
  content: true,
  order: 3,
});
registerUserDataCategory({
  id: 'noteTemplates',
  label: 'Note templates',
  description:
    'Your own custom note templates. Built-in templates are not yours and stay. A template a note still uses is kept.',
  content: true,
  order: 4,
});
registerUserDataCategory({
  id: 'graph',
  label: 'Knowledge graph',
  description:
    'Your knowledge graph. Your recordings and notes are what it was derived from; deleting the graph never changes them.',
  content: true,
  order: 5,
});
registerUserDataCategory({
  id: 'ask',
  label: 'Ask conversations',
  description: 'Your saved Ask conversations and every message in them.',
  content: true,
  order: 6,
});

registerUserDataScope({
  id: 'transcripts',
  label: 'Recordings',
  description: 'Your recordings and their transcripts only.',
  categories: ['transcripts'],
  confirmation: 'TRANSCRIPTS',
  layer: 'specific',
  order: 10,
});
registerUserDataScope({
  id: 'notes',
  label: 'Notes',
  description: 'Your notes only, not your note templates.',
  categories: ['notes'],
  confirmation: 'NOTES',
  layer: 'specific',
  order: 20,
});
registerUserDataScope({
  id: 'files',
  label: 'Files',
  description: 'Your plain uploads only.',
  categories: ['files'],
  confirmation: 'FILES',
  layer: 'specific',
  order: 30,
});
registerUserDataScope({
  id: 'content',
  label: 'All content',
  description:
    'Everything you made: recordings, notes, uploaded files, your own note templates, your knowledge graph and your Ask conversations.',
  categories: CONTENT_CATEGORIES,
  confirmation: 'CONTENT',
  layer: 'danger',
  order: 40,
  overrideBuiltIn: true,
});
registerUserDataScope({
  id: 'everything',
  label: 'Everything',
  description:
    'All content, plus your notifications, AI history and provider keys, personal access tokens, stored credentials and settings (including your display name and profile image) and your first-run guidance. Your account stays.',
  categories: 'all',
  confirmation: 'EVERYTHING',
  layer: 'danger',
  order: 50,
  overrideBuiltIn: true,
});

const ownerDelegate = (jobType: string) => ({
  jobType,
  payload: (userId: string): Record<string, unknown> => ({ mode: OWNER_PURGE_MODE, userId }),
});

/** One delegate for the whole graph: every `Kg*` hint shares it, so it is enqueued once. */
const graphDelegate = {
  jobType: KG_PURGE_DELEGATE,
  payload: (userId: string): Record<string, unknown> => ({ scope: 'all', userId }),
};

const graphModel = (model: Prisma.ModelName): UserDataModelHint<Prisma.ModelName> => ({
  model,
  category: 'graph',
  delegate: graphDelegate,
});

registerUserDataModels<Prisma.ModelName>([
  { model: 'Transcript', category: 'transcripts', delegate: ownerDelegate(TRANSCRIPT_PURGE_DELEGATE) },
  { model: 'Note', category: 'notes', delegate: ownerDelegate(NOTE_PURGE_DELEGATE) },

  { model: 'NoteTemplate', category: 'noteTemplates', keepWhenReferenced: true },
  { model: 'UserHiddenNoteTemplate', category: 'noteTemplates' },

  { model: 'AskConversation', category: 'ask' },

  graphModel('KgEntity'),
  graphModel('KgEntityAlias'),
  graphModel('KgRelation'),
  graphModel('KgItem'),
  graphModel('KgEvidence'),
  graphModel('KgMention'),
  graphModel('KgProposal'),
  graphModel('KgMerge'),
  graphModel('KgDistinctPair'),
  graphModel('KgAttributeDef'),
  graphModel('KgEntityDigest'),
  graphModel('KgExport'),
  graphModel('KgGraphLayout'),
  graphModel('KgEntityView'),

  {
    model: 'SearchIndexState',
    keep:
      'Derived search state. Removed by the transcript and note purge jobs ' +
      '(SearchIndexService.forgetOwnerDocuments), never on its own.',
  },

  // Registered here, ahead of the platform's `{ model: 'StorageObject', storageObjects: true }`
  // (which `registerPlatformUserData()` then skips). DELEGATED and without
  // `storageObjects: true`: see the header.
  {
    model: 'StorageObject',
    category: 'files',
    delegate: {
      jobType: FILES_PURGE_UNMANAGED_JOB_TYPE,
      payload: (userId: string): Record<string, unknown> => ({ userId }),
    },
  },
]);

// The platform's categories, models and factory reset steps, LAST so that ours win.
registerPlatformUserData();

/**
 * Boot-time proof that the registration order held: the platform's
 * `StorageObject` hint did not win, and ours still carries its delegate.
 *
 * @throws Error naming the mistake.
 */
export function assertKvoxUserDataRegistrations(): void {
  if (storageObjectModelHint() !== undefined) {
    throw new Error(
      'user-data: a model is registered with storageObjects: true, so a deletion would remove ' +
        'module-owned objects. user-data.manifest.ts must register the StorageObject hint before ' +
        'registerPlatformUserData() runs.',
    );
  }

  const hint = userDataModelRegistry.get('StorageObject');

  if (hint?.delegate?.jobType !== FILES_PURGE_UNMANAGED_JOB_TYPE) {
    throw new Error(
      `user-data: the StorageObject hint must delegate to ${FILES_PURGE_UNMANAGED_JOB_TYPE}, so a ` +
        '"files" deletion never touches an object in kvox_object_ownership.',
    );
  }
}

assertKvoxUserDataRegistrations();
