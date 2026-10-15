// =============================================================================
// This app's model ownership classification (issue #465, epic #462)
// =============================================================================
//
// Every this app model is classified (`user`, `org`, `org-optional` or `system`);
// the `user-owned-data` conformance suite fails on any model it cannot find
// here. Single-organization deployment: this app content belongs to a USER, not to
// an organization, so every domain model is `user`. The org-isolated models are
// the platform's (storage, AI runs, groups, ...).
//
// ONE-LINE RATIONALE EACH, because the tripwire prints it when it fails.
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { ModelOwnershipDef } from '@marinoscar/platform-api/core';

type Def = ModelOwnershipDef<Prisma.ModelName>;

const user = (model: Prisma.ModelName, rationale: string): Def => ({
  model,
  kind: 'user',
  rationale,
});

export const KVOX_MODEL_OWNERSHIP: readonly Def[] = [
  // Transcripts
  user('Transcript', 'A transcript belongs to the user who owns the recording.'),
  user('TranscriptSpeaker', 'A speaker belongs to its transcript, and so to the transcript’s owner.'),
  user('TranscriptSegment', 'A segment belongs to its transcript, and so to the transcript’s owner.'),
  user('TranscriptVersion', 'A snapshot belongs to its transcript, and so to the transcript’s owner.'),
  user('TranscriptShare', 'A share is the owner’s grant of access to one other user, not an organization asset.'),
  user('TranscriptExport', 'An export is requested by, and served to, one user.'),
  user('TranscriptNameCheck', 'A name check runs on, and belongs to, one transcript.'),
  user('TranscriptNameSuggestion', 'A suggestion belongs to a name check, and so to the transcript’s owner.'),

  // Notes
  user('Note', 'A note belongs to the user who generated it.'),
  user('NoteTemplate', 'A custom template belongs to its author; a built-in has no owner.'),
  user('UserHiddenNoteTemplate', 'Which templates one user hid from their own picker.'),
  user('NoteGeneration', 'A generation belongs to its note, and so to the note’s owner.'),
  user('NoteVersion', 'A snapshot belongs to its note, and so to the note’s owner.'),
  user('NoteExport', 'An export is requested by, and served to, one user.'),

  // AI credentials
  user('UserAiCredential', 'A user’s own provider key; deliberately never an organization or deployment credential.'),

  // Search
  user('SearchChunk', 'Indexed text derived from one user’s documents.'),
  user('SearchEmbedding', 'A vector derived from one user’s indexed text.'),
  user('SearchIndexState', 'Indexing bookkeeping for one user’s documents.'),

  // Graph
  user('KgEntity', 'A node in one user’s private knowledge graph.'),
  user('KgEntityAlias', 'An alias of an entity in one user’s graph.'),
  user('KgRelation', 'An edge in one user’s graph.'),
  user('KgItem', 'A commitment, decision, claim or person fact in one user’s graph.'),
  user('KgEvidence', 'The source span that justifies a row in one user’s graph.'),
  user('KgMention', 'A mention of an entity in one user’s documents.'),
  user('KgProposal', 'A proposal awaiting review by the one user whose graph it targets.'),
  user('KgProposalItem', 'An item of a proposal, and so of one user’s review queue.'),
  user('KgMerge', 'A merge in one user’s graph.'),
  user('KgDistinctPair', 'A "these are different" decision in one user’s graph.'),
  user('KgAttributeDef', 'An attribute definition in one user’s ontology.'),
  user('KgEntityDigest', 'A derived summary of an entity in one user’s graph.'),
  user('KgEntityView', 'One user’s saved view of an entity.'),
  user('KgExport', 'An export of one user’s graph.'),
  user('KgGraphLayout', 'A computed layout of one user’s graph.'),

  // Ask
  user('AskConversation', 'A conversation between one user and the graph agent.'),
  user('AskMessage', 'A message of a conversation, and so one user’s.'),

  // Allowlist bookkeeping (#465)
  {
    model: 'KvoxAllowlistReminder',
    kind: 'system',
    rationale: 'Allowlist bookkeeping, keyed by an allowlist row id',
  },
];
