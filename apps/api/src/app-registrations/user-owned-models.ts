// =============================================================================
// This app's user-owned models (issue #465, epic #462)
// =============================================================================
//
// Every this app model with a foreign key to `User`, classified for the platform's
// user-data machinery (the scoped client, the user-data export and purge
// planner, and the `user-owned-data` conformance suite, which fails when this
// list and `prisma/schema/` disagree).
//
// PURGE FOLLOWS `onDelete`: `Cascade` is `delete`, `SetNull` is `detach`.
// EXPORT is `include` for every model here. The user's AI provider keys are the
// platform's (`user_ai_keys`), classified by the platform AI slice, not here.
//
// OWNER vs ACTOR. A row with an `ownerField` belongs to the user. A row with
// only `actorFields` merely records who acted (an editor, an author, a
// requester, the two parties of a share) and is not the actor's data.
//
// The registration itself (`registerPlatformUserOwnedModels`) is
// `registrations.ts`; this file only declares.
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { UserOwnedModelDef } from '@marinoscar/platform-api/core';

type Def = UserOwnedModelDef<Prisma.ModelName>;

const OWN_CONTENT =
  'Content derived from the owner’s private recordings; deleted with the user and exported to them.';

export const KVOX_USER_OWNED_MODELS: readonly Def[] = [
  // -------------------------------------------------------------------------
  // Transcripts
  // -------------------------------------------------------------------------
  {
    model: 'Transcript',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'include',
    rationale: 'The owner’s transcript of a private recording; deleted with the user and exported to them.',
  },
  {
    model: 'TranscriptSegment',
    actorFields: ['editedById'],
    purge: 'detach',
    export: 'include',
    rationale: 'A segment belongs to its transcript; the editor is only recorded and the text outlives them.',
  },
  {
    model: 'TranscriptVersion',
    actorFields: ['authorId'],
    purge: 'detach',
    export: 'include',
    rationale: 'A snapshot of a transcript; the author is only recorded and the version outlives them.',
  },
  {
    model: 'TranscriptShare',
    // Both keys are `Cascade`, and the `user-owned-data` suite refuses an
    // owned model whose ACTOR field cascades ("deleting the actor would delete
    // a row another user owns"). A share is deleted when EITHER party is, so it
    // is registered as actor-only on both keys and purged with `delete`, rather
    // than as owned by the grantee with the granter as an actor (the issue's
    // first draft).
    // PLATFORM-ADOPTION-SHIM(#465): deviation from the issue's table, see above.
    actorFields: ['userId', 'grantedById'],
    purge: 'delete',
    export: 'include',
    rationale:
      'A transcript shared with a user. The row is deleted when either the grantee or the granting owner is (both keys cascade), and neither owns it alone.',
  },
  {
    model: 'TranscriptExport',
    actorFields: ['requestedById'],
    purge: 'delete',
    export: 'include',
    rationale: 'A rendered export the user requested; transient, deleted with the requester.',
  },
  {
    model: 'TranscriptNameCheck',
    actorFields: ['requestedById'],
    purge: 'detach',
    export: 'include',
    rationale: 'A name-correction run on a transcript; the requester is only recorded and the run belongs to the transcript.',
  },
  {
    model: 'TranscriptNameSuggestion',
    actorFields: ['decidedById'],
    purge: 'detach',
    export: 'include',
    rationale: 'A suggested speaker name; the user who accepted or rejected it is only recorded.',
  },

  // -------------------------------------------------------------------------
  // Notes
  // -------------------------------------------------------------------------
  {
    model: 'Note',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'include',
    rationale: 'The owner’s note, derived from their private conversations; deleted with the user and exported to them.',
  },
  {
    model: 'NoteTemplate',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'include',
    rationale: 'The owner’s custom note template (a built-in has no owner); deleted with the user and exported to them.',
  },
  {
    model: 'UserHiddenNoteTemplate',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: 'Which built-in templates the user hid from their own picker.',
  },
  {
    model: 'NoteVersion',
    actorFields: ['authorId'],
    purge: 'detach',
    export: 'include',
    rationale: 'A snapshot of a note; the author is only recorded and the version outlives them.',
  },
  {
    model: 'NoteExport',
    actorFields: ['requestedById'],
    purge: 'delete',
    export: 'include',
    rationale: 'A rendered export the user requested; transient, deleted with the requester.',
  },

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------
  {
    model: 'SearchIndexState',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'include',
    rationale: 'Indexing bookkeeping for the owner’s documents; derived, rebuilt on demand.',
  },

  // -------------------------------------------------------------------------
  // Connected-knowledge graph (every row owned by `ownerId`, Cascade)
  // -------------------------------------------------------------------------
  ...(
    [
      'KgEntity',
      'KgEntityAlias',
      'KgRelation',
      'KgItem',
      'KgEvidence',
      'KgMention',
      'KgProposal',
      'KgMerge',
      'KgDistinctPair',
      'KgAttributeDef',
      'KgEntityDigest',
      'KgExport',
      'KgGraphLayout',
    ] as const
  ).map(
    (model): Def => ({
      model,
      ownerField: 'ownerId',
      purge: 'delete',
      export: 'include',
      rationale: OWN_CONTENT,
    }),
  ),
  {
    model: 'KgEntityView',
    ownerField: 'userId',
    purge: 'delete',
    export: 'include',
    rationale: 'The user’s own saved view of an entity in the explorer.',
  },

  // -------------------------------------------------------------------------
  // Ask
  // -------------------------------------------------------------------------
  {
    model: 'AskConversation',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'include',
    rationale: 'The owner’s saved conversation with the graph agent; deleted with the user and exported to them.',
  },
];
