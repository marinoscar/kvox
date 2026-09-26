// =============================================================================
// The `core` domain (docs/specs/ontology.md §5.1, §5.2, §17.2)
// =============================================================================
//
// Always on, for every user, unconditionally. `Person` and `Organization`
// live here rather than in `work` so the same human is one row whichever
// domain proposed them (§17.2); other domains add relations onto these types,
// and attributes through mixins, without editing this file.
//
// Every `description` and `disambiguation` string below is extraction-prompt
// copy: #363 sends it to the model verbatim. Editing one is a PATCH bump of
// ONTOLOGY_VERSION (§17.4) and a CHANGELOG line in `version.ts`.
//
// Some core relations name `work` types as endpoints (ABOUT, SUPERSEDES,
// SUPPORTED_BY). That is deliberate: `computeEffectiveSchema()` prunes every
// endpoint list to the types a caller actually has, so a core-only caller
// sees `ABOUT: Claim | PersonFact -> Person | Organization | Meeting`.
// =============================================================================

import { defineDomain, defineEntityType, defineRelationType } from '../define.js';

/** Every `kg_entities`-stored type across the shipped domains, in registry order. */
const ENTITY_STORAGE_TYPES = ['Person', 'Organization', 'Meeting', 'Project'];
/** Every `kg_items`-stored type across the shipped domains, in registry order. */
const ITEM_STORAGE_TYPES = ['Claim', 'PersonFact', 'Commitment', 'Decision'];

export const person = defineEntityType({
  key: 'Person',
  domain: 'core',
  label: 'Person',
  pluralLabel: 'People',
  description:
    'A human being: one specific individual who is named, or identified unambiguously enough that exactly one real person is meant.',
  disambiguation: [
    'Never a role ("the CIO"), never a team, never an organization acting collectively.',
    'Positive: "Sarah Chen," "the Acme CIO whose name was given as Marcus Webb."',
    'Negative: "the data team at EY" (an `Organization`, or a `Person` if and only if one specific human is meant); "whoever\'s on call" (no specific human named — nothing to create).',
  ],
  attributes: {},
  sensitivityDefault: 'business',
  alignment: 'schema:Person',
});

export const organization = defineEntityType({
  key: 'Organization',
  domain: 'core',
  label: 'Organization',
  pluralLabel: 'Organizations',
  description:
    'A company, client, vendor, institution, or an internal team specifically when that team acts as a party to a commitment or decision rather than merely being mentioned.',
  disambiguation: [
    'Positive: "EY" (a company); "the data team at EY," when a commitment is owed to that team specifically rather than to an individual within it.',
    'Negative: "the data team at EY," mentioned only in passing with no commitment or decision naming it as a party — that mention lives as evidence on whatever it actually relates to, not as a new `Organization` created speculatively.',
  ],
  attributes: {
    website: {
      kind: 'url',
      label: 'Website',
      description: "The organization's public website address, only when it is stated in the source.",
      extractable: true,
    },
  },
  sensitivityDefault: 'business',
  alignment: 'schema:Organization',
});

export const meeting = defineEntityType({
  key: 'Meeting',
  domain: 'core',
  label: 'Meeting',
  pluralLabel: 'Meetings',
  description:
    'The event anchor: a date, its attendees, and the source transcript(s) and/or note(s) it was drawn from. Created by the system for each source, never proposed by extraction.',
  disambiguation: [
    'One Meeting per transcript by default; a note with no source audio still gets one, dated from what the user stated or else from the note itself.',
    'A recurring conversation subject is not a Meeting and not a Project; it is a free-text entry in the Meeting\'s topics.',
  ],
  attributes: {
    transcriptId: {
      kind: 'text',
      label: 'Transcript',
      description: 'The id of the transcript this meeting was created from, when it has one.',
    },
    noteId: {
      kind: 'text',
      label: 'Note',
      description: 'The id of the note this meeting was created from, when it has no source audio.',
    },
    dateSource: {
      kind: 'select',
      label: 'Date source',
      description: "Where the meeting's date came from: stated in the source, or the note's own creation time.",
      options: {
        choices: [
          { value: 'stated', label: 'Stated' },
          { value: 'note_created_at', label: 'Note created at' },
        ],
      },
    },
    topics: {
      kind: 'text',
      list: true,
      label: 'Topics',
      description: 'Free-text subjects discussed that are not Projects: recurring themes with no start, end or attached work.',
    },
  },
  sensitivityDefault: 'business',
  alignment: 'schema:Event',
  extractable: false,
});

export const claim = defineEntityType({
  key: 'Claim',
  domain: 'core',
  label: 'Claim',
  pluralLabel: 'Claims',
  description:
    'A dated statement of fact about an entity that is neither a decision nor a commitment: "Acme\'s CIO is leaving in March," "the budget was cut 20%," "the pilot moved to Q2."',
  disambiguation: [
    'A choice that was made is a Decision; a task with an owner is a Commitment. A Claim is what remains: a stated fact about its subject.',
    'A statement about a person as an individual rather than about their work (an interest, a preference, a personal-life detail) is a PersonFact, not a Claim.',
  ],
  attributes: {},
  sensitivityDefault: 'business',
  itemKind: 'claim',
  statuses: ['active', 'superseded'],
  subjectTypes: [...ENTITY_STORAGE_TYPES],
  subjectRequired: true,
});

export const personFact = defineEntityType({
  key: 'PersonFact',
  domain: 'core',
  label: 'Person fact',
  pluralLabel: 'Person facts',
  description:
    'A statement about a Person as an individual rather than about their work: an interest, a preference, a personal-life detail, or a note on communication style.',
  disambiguation: [
    'Its subject is always a Person. A fact about that person\'s job, employer or role is a Claim (or a WORKS_FOR / HAS_ROLE relation), not a PersonFact.',
    'Health, legal, financial or similarly weighty personal information is still a PersonFact, and is marked sensitive.',
  ],
  attributes: {},
  // §5.6 / §15: never 'business'. The parity test pins this.
  sensitivityDefault: 'personal',
  itemKind: 'person_fact',
  statuses: ['active', 'superseded'],
  subjectTypes: ['Person'],
  subjectRequired: true,
});

export const about = defineRelationType({
  key: 'ABOUT',
  domain: 'core',
  label: 'About',
  description: 'Links a claim, decision, commitment or person fact to the entity it is about (its subject).',
  from: ['Claim', 'Decision', 'Commitment', 'PersonFact'],
  to: [...ENTITY_STORAGE_TYPES],
  temporal: false,
  exclusive: 'none',
  props: {},
  representation: { kind: 'item_column', column: 'subject_id' },
  extractable: false,
});

export const identifiedAs = defineRelationType({
  key: 'IDENTIFIED_AS',
  domain: 'core',
  label: 'Identified as',
  description: 'Links a diarized transcript speaker to the Person that speaker was identified as.',
  from: ['Speaker'],
  to: ['Person'],
  temporal: false,
  exclusive: 'none',
  props: {},
  representation: { kind: 'speaker_link' },
  extractable: false,
});

export const supersedes = defineRelationType({
  key: 'SUPERSEDES',
  domain: 'core',
  label: 'Supersedes',
  description: 'A newer decision, claim or commitment that replaces an older one of the same type; history is kept, never edited in place.',
  from: ['Decision', 'Claim', 'Commitment'],
  to: ['Decision', 'Claim', 'Commitment'],
  allowedPairs: [
    ['Decision', 'Decision'],
    ['Claim', 'Claim'],
    ['Commitment', 'Commitment'],
  ],
  temporal: false,
  exclusive: 'none',
  props: {},
  representation: { kind: 'supersedes' },
  extractable: false,
});

export const mentions = defineRelationType({
  key: 'MENTIONS',
  domain: 'core',
  label: 'Mentions',
  description: 'The coarse, overview-level link from a note or transcript to every entity it touches somewhere in the document.',
  from: ['Note', 'Transcript'],
  to: [...ENTITY_STORAGE_TYPES],
  temporal: false,
  exclusive: 'none',
  props: {},
  representation: { kind: 'mention' },
  extractable: false,
});

export const supportedBy = defineRelationType({
  key: 'SUPPORTED_BY',
  domain: 'core',
  label: 'Supported by',
  description: 'The fine-grained link from a generated entity, relation or item to the transcript segment or note span that supports it.',
  from: [...ENTITY_STORAGE_TYPES, ...ITEM_STORAGE_TYPES],
  to: ['Transcript', 'Note'],
  temporal: false,
  exclusive: 'none',
  props: {},
  representation: { kind: 'evidence' },
  extractable: false,
});

export const coreDomain = defineDomain({
  key: 'core',
  label: 'Core',
  alwaysOn: true,
  defaultEnabled: true,
  entityTypes: [person, organization, meeting, claim, personFact],
  relationTypes: [about, identifiedAs, supersedes, mentions, supportedBy],
  mixins: [],
});
