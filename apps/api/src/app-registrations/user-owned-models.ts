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
// EXPORT (issue #532, "Download your data") is a decision per model, because the
// platform `user-data` source exports a model's rows by the registry alone:
//   * `include`: owner-keyed, small, the user's own content or configuration. The
//     platform source exports it; `exportOmit` lists the columns it must not.
//   * `exclude`: derived or bulky or transient, or never allowed to leave
//     (`KgItem` and `KgEvidence`: a `sensitive` PersonFact never leaves the deployment).
//     An excluded model that carries user content is exported by the app's own
//     `kvox-content` source instead (`platform/exports/kvox-content.source.ts`), keyed by
//     ownership of the PARENT row, because an actor-only model (`TranscriptSegment.editedById`,
//     `NoteVersion.authorId`) would otherwise export the wrong rows.
// The user's AI provider keys are the platform's (`user_ai_keys`), classified by the
// platform AI slice, not here.
//
// OWNER vs ACTOR. A row with an `ownerField` belongs to the user. A row with
// only `actorFields` merely records who acted (an editor, an author, a
// requester, the requester of an export) and is not the actor's data.
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
    rationale:
      'The owner’s transcript of a private recording; deleted with the user and exported to them (its speakers and segments by the kvox-content source).',
  },
  {
    model: 'TranscriptSegment',
    actorFields: ['editedById'],
    purge: 'detach',
    export: 'exclude',
    rationale:
      'A segment belongs to its transcript; the editor is only recorded and the text outlives them. Exported by the kvox-content source, keyed by ownership of the parent transcript: the platform source filters an actor-only model by editedById, which would export what the user merely edited in someone else’s shared transcript and miss the segments of their own transcript that others edited.',
  },
  {
    model: 'TranscriptVersion',
    actorFields: ['authorId'],
    purge: 'detach',
    export: 'exclude',
    rationale:
      'A snapshot of a transcript; the author is only recorded and the version outlives them. Derived (a compaction of the edit log) and bulky: the current text is exported with the segments.',
  },
  {
    model: 'TranscriptExport',
    actorFields: ['requestedById'],
    purge: 'delete',
    export: 'exclude',
    rationale: 'A rendered export the user requested; transient and re-creatable, deleted with the requester.',
  },
  {
    model: 'TranscriptNameCheck',
    actorFields: ['requestedById'],
    purge: 'detach',
    export: 'exclude',
    rationale:
      'A name-correction run on a transcript; the requester is only recorded and the run belongs to the transcript. A derived AI run: its outcome is the speaker names.',
  },
  {
    model: 'TranscriptNameSuggestion',
    actorFields: ['decidedById'],
    purge: 'detach',
    export: 'exclude',
    rationale: 'A suggested speaker name; the user who accepted or rejected it is only recorded. Derived AI output; the accepted name is on the speaker.',
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
    export: 'exclude',
    rationale:
      'A snapshot of a note; the author is only recorded and the version outlives them. Exported by the kvox-content source, keyed by ownership of the parent note: the platform source filters an actor-only model by authorId, which would export the history of notes the user only edited and miss versions of their own note written by others.',
  },
  {
    model: 'NoteExport',
    actorFields: ['requestedById'],
    purge: 'delete',
    export: 'exclude',
    rationale: 'A rendered export the user requested; transient and re-creatable, deleted with the requester.',
  },
  {
    model: 'NoteLibrary',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'include',
    rationale:
      'The owner’s watched note library (its name and import policy); deleted with the user and exported to them. Its file rows and batches hang off it and are re-derivable from the folder.',
  },
  {
    model: 'NoteImportBatch',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'exclude',
    rationale: 'Bookkeeping of one scan-and-import run; transient and re-creatable, deleted with the owner.',
  },

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------
  {
    model: 'SearchIndexState',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'exclude',
    rationale: 'Indexing bookkeeping for the owner’s documents; derived, rebuilt on demand.',
  },

  // -------------------------------------------------------------------------
  // Connected-knowledge graph (every row owned by `ownerId`, Cascade)
  //
  // EXPORT. A `sensitive` PersonFact never leaves the deployment (root AGENTS.md), so
  // `KgItem` (where the facts live) and `KgEvidence` (the quotes that justify them) are
  // `exclude`, as is everything derived or transient. What is exported is the user's own
  // map of people, places and topics: the entities, their aliases and the relations
  // between them. `props` of an entity and of a relation is WITHHELD: it can hold an
  // attribute value whose definition resolves to `sensitive`, and a column cannot be
  // filtered per key. The embedding vector is `Unsupported` (not in the datamodel, so
  // never a column); its model and hash are derived.
  // -------------------------------------------------------------------------
  {
    model: 'KgEntity',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'include',
    exportOmit: ['props', 'embeddingModel', 'embeddingHash'],
    rationale:
      'A node in the owner’s graph; deleted with the user and exported to them without props (may carry a sensitive attribute value) and without embedding bookkeeping (derived).',
  },
  {
    model: 'KgEntityAlias',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'include',
    rationale: OWN_CONTENT,
  },
  {
    model: 'KgRelation',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'include',
    exportOmit: ['props'],
    rationale:
      'An edge in the owner’s graph; deleted with the user and exported to them without props (a relation prop defaults to its type’s sensitivity, which may be sensitive).',
  },
  {
    model: 'KgItem',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'exclude',
    rationale:
      'Commitments, decisions, claims and person facts. A sensitive PersonFact never leaves the deployment, for any purpose or setting, and is never exported; the platform source cannot filter by sensitivity, so the whole model stays out.',
  },
  {
    model: 'KgEvidence',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'exclude',
    rationale:
      'The quotes that justify graph rows, including a sensitive PersonFact’s: never exported with it (a sensitive PersonFact never leaves the deployment). The source documents are exported as transcripts and notes.',
  },
  {
    model: 'KgMention',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'exclude',
    rationale: 'Where an entity is mentioned in a document; derived by extraction and rebuilt on demand.',
  },
  {
    model: 'KgProposal',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'exclude',
    rationale: 'A review-queue entry (and its items) that can carry a sensitive PersonFact before it is decided; transient.',
  },
  {
    model: 'KgMerge',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'exclude',
    rationale: 'The log of an entity merge; derived bookkeeping that only serves an undo.',
  },
  {
    model: 'KgDistinctPair',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'exclude',
    rationale: 'A "these are different" decision that only steers duplicate suggestions; derived bookkeeping.',
  },
  {
    model: 'KgAttributeDef',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'exclude',
    rationale:
      'The owner’s attribute definitions. Exported by the kvox-content source with every definition classed sensitive left out (a sensitive definition is never exported, as in the ontology and RDF artefacts); the platform source cannot filter rows by sensitivity.',
  },
  {
    model: 'KgEntityDigest',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'exclude',
    rationale: 'A derived AI summary of an entity, rebuilt on demand.',
  },
  {
    model: 'KgExport',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'exclude',
    rationale: 'A rendered RDF export the user requested; transient and re-creatable.',
  },
  {
    model: 'KgGraphLayout',
    ownerField: 'ownerId',
    purge: 'delete',
    export: 'exclude',
    rationale: 'A computed layout of the graph; derived and large.',
  },
  {
    model: 'KgEntityView',
    ownerField: 'userId',
    purge: 'delete',
    export: 'exclude',
    rationale: 'The last-viewed marker of an entity in the explorer; usage bookkeeping, not content.',
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
