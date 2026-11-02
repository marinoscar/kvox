// =============================================================================
// The `core` domain (docs/specs/ontology.md §5.1, §5.2, §17.2). Always on, for
// every user, unconditionally.
//
// Person and Organization live here rather than in `work` so one real human is
// one row whichever domain later proposes a relation about them (§17.2).
//
// Every `description` and `disambiguation` string below is extraction-prompt
// copy: `kg.extract` sends it to the model verbatim. Write it for the model.
//
// KEYS ARE PERMANENT (§17.1). Renaming or removing a type, relation or
// attribute key orphans stored rows; deprecate instead, and record every new
// key in `shipped-keys.ts`.
// =============================================================================

import { defineDomain, defineEntityType, defineRelationType } from '../define.js';

/**
 * Every type stored in `kg_entities`, across all domains (endpoint lists below).
 * The effective schema prunes each list to the caller's enabled domains, so a
 * `personal` type here is invisible to a user who never turned `personal` on.
 */
const ENTITY_STORAGE_TYPES = ['Person', 'Organization', 'Meeting', 'Project', 'Interest', 'Trip', 'Milestone', 'Topic', 'Product', 'Opportunity'];

/** Every declared type, across all domains, for SUPPORTED_BY. */
const ALL_TYPES = [
  'Person',
  'Organization',
  'Meeting',
  'Claim',
  'PersonFact',
  'Project',
  'Commitment',
  'Decision',
  'Risk',
  'Interest',
  'Trip',
  'Milestone',
  'Topic',
  'Product',
  'Opportunity',
  'Document',
];

/**
 * Wire constant: topic.
 *
 * @stability experimental
 */
export const Topic = defineEntityType({
  key: 'Topic',
  domain: 'core',
  label: 'Topic',
  pluralLabel: 'Topics',
  description:
    'A recurring subject of discussion that is not itself a unit of work, e.g. "AI governance", "licensing cost", "change management".',
  disambiguation: [
    'Something with an owner, a start and an expected end that work attaches to is a Project, not a Topic.',
    'A named product, tool or technology is a Product (when the work domain is on), not a Topic.',
    'Prefer reusing an existing Topic label over creating a near-synonym.',
  ],
  attributes: {
    summary: {
      kind: 'text',
      label: 'Summary',
      description: 'A short summary of the topic, written by the user.',
      extractable: false,
    },
  },
  sensitivityDefault: 'business',
  alignment: 'skos:Concept',
});

/**
 * Wire constant: person.
 *
 * @stability experimental
 */
export const Person = defineEntityType({
  key: 'Person',
  domain: 'core',
  label: 'Person',
  pluralLabel: 'People',
  description:
    'A human being: one specific, individual person named or unambiguously identified in the source.',
  disambiguation: [
    'Never a role ("the CIO"), never a team, never an organization acting collectively.',
    'Positive: "Sasha Example"; "the Kappa CIO whose name was given as Maddox Sample."',
    'Negative: "the data team at OAC" is an Organization, or a Person if and only if one specific human is meant.',
    'Negative: "whoever\'s on call" names no specific human, so there is nothing to create.',
  ],
  attributes: {},
  sensitivityDefault: 'business',
  alignment: 'schema:Person',
});

/**
 * Wire constant: organization.
 *
 * @stability experimental
 */
export const Organization = defineEntityType({
  key: 'Organization',
  domain: 'core',
  label: 'Organization',
  pluralLabel: 'Organizations',
  description:
    'A company, client, vendor or institution, or an internal team specifically when that team acts as a party to a commitment or decision.',
  disambiguation: [
    'Positive: "OAC" (a company); "the data team at OAC" when a commitment is owed to that team specifically rather than to an individual within it.',
    'Negative: a team mentioned only in passing, with no commitment or decision naming it as a party, is not an Organization; do not create one speculatively.',
    'Never a single human being acting for the organization: that is a Person.',
  ],
  attributes: {
    website: {
      kind: 'url',
      label: 'Website',
      description: "The organization's website address, only if the source states it explicitly.",
      extractable: true,
      alignment: 'schema:url',
    },
  },
  sensitivityDefault: 'business',
  alignment: 'schema:Organization',
});

/**
 * Wire constant: meeting.
 *
 * @stability experimental
 */
export const Meeting = defineEntityType({
  key: 'Meeting',
  domain: 'core',
  label: 'Meeting',
  pluralLabel: 'Meetings',
  description:
    'The event anchor: a dated meeting or conversation, its attendees, and the transcript and/or note it was drawn from.',
  disambiguation: [
    'One Meeting per transcript, or per note with no source audio, is created by the system and already exists; propose a Meeting only for a further, separately dated meeting that a document records.',
    'A recurring conversation subject is not a Meeting; it is a topic of the meetings it came up in.',
    'Set occurredOn only to a date the source states for that meeting; set meetingKind only to the kind the source makes clear (client: with a customer, internal: within one organization, partner: with a partner or vendor).',
  ],
  attributes: {
    transcriptId: {
      kind: 'text',
      label: 'Transcript',
      description: 'The id of the transcript this meeting was drawn from, set by the system.',
    },
    noteId: {
      kind: 'text',
      label: 'Note',
      description: 'The id of the note this meeting was drawn from, set by the system.',
    },
    dateSource: {
      kind: 'select',
      label: 'Date source',
      description: "Where the meeting's date came from: stated in the source, or the note's creation date.",
      options: {
        choices: [
          { value: 'stated', label: 'Stated' },
          { value: 'note_created_at', label: 'Note creation date' },
        ],
      },
    },
    topics: {
      kind: 'text',
      list: true,
      label: 'Topics',
      description: 'Free-text subjects discussed in the meeting that are not Projects of their own.',
    },
    occurredOn: {
      kind: 'date',
      label: 'Occurred on',
      description: 'The date the meeting took place, only if the source states it.',
      extractable: true,
    },
    meetingKind: {
      kind: 'select',
      label: 'Kind',
      description: 'What kind of meeting it was, only if the source makes it clear.',
      extractable: true,
      options: {
        choices: [
          { value: 'client', label: 'Client' },
          { value: 'internal', label: 'Internal' },
          { value: 'partner', label: 'Partner' },
          { value: 'other', label: 'Other' },
        ],
      },
    },
  },
  sensitivityDefault: 'business',
  alignment: 'schema:Event',
  // Created by the system per transcript or single note, so it is not offered by
  // default. A host that extracts documents recording several meetings opts in with
  // `buildOfferedSchema(..., { proposeTypes: ['Meeting'] })` (#780).
  extractable: false,
});

/**
 * Wire constant: document.
 *
 * @stability experimental
 */
export const Document = defineEntityType({
  key: 'Document',
  domain: 'core',
  label: 'Document',
  pluralLabel: 'Documents',
  description:
    'A document that was shown, shared or recorded in a meeting, e.g. a slide deck or a proposal; created by the system from the source, never proposed by extraction.',
  disambiguation: [
    'Created by the system, never proposed by extraction: a document merely mentioned in conversation is not a Document row.',
    'The note or transcript the graph was drawn from is evidence, not a Document.',
  ],
  attributes: {
    title: {
      kind: 'text',
      label: 'Title',
      description: "The document's title, set by the system.",
    },
    preparedOn: {
      kind: 'date',
      label: 'Prepared on',
      description: 'The date the document was prepared, set by the system.',
    },
    classification: {
      kind: 'text',
      label: 'Classification',
      description: 'The handling label the document carries, e.g. "internal" or "confidential", set by the system.',
    },
  },
  sensitivityDefault: 'business',
  alignment: 'schema:DigitalDocument',
  extractable: false,
});

/**
 * Wire constant: claim.
 *
 * @stability experimental
 */
export const Claim = defineEntityType({
  key: 'Claim',
  domain: 'core',
  label: 'Claim',
  pluralLabel: 'Claims',
  description:
    'A dated statement of fact about an entity that is neither a decision nor a commitment, e.g. "the budget was cut 20%" or "the pilot moved to Q2".',
  disambiguation: [
    'A choice that was made is a Decision, not a Claim.',
    'A task with an owner is a Commitment, not a Claim.',
    'A fact about a Person as an individual rather than about their work is a PersonFact.',
    'Set claimKind only when the statement clearly is one: metric (a figure such as a budget, headcount or deadline), buying_signal (interest in buying or expanding), warning_sign (a hint that something may go wrong), pain_point (a problem the speaker suffers from), priority (what the speaker says matters most); otherwise fact.',
  ],
  attributes: {
    claimKind: {
      kind: 'select',
      label: 'Kind',
      description: 'What kind of statement it is, only if the source makes it clear; a plain statement of fact is fact.',
      extractable: true,
      options: {
        choices: [
          { value: 'fact', label: 'Fact' },
          { value: 'metric', label: 'Metric' },
          { value: 'buying_signal', label: 'Buying signal' },
          { value: 'warning_sign', label: 'Warning sign' },
          { value: 'pain_point', label: 'Pain point' },
          { value: 'priority', label: 'Priority' },
        ],
      },
    },
    value: {
      kind: 'text',
      label: 'Value',
      description: 'The figure the claim states, copied as written ("20%", "3 to 4 weeks", "120"), only for a metric.',
      extractable: true,
    },
    unit: {
      kind: 'text',
      label: 'Unit',
      description: 'The unit of the value ("percent", "weeks", "seats"), only if the source states it.',
      extractable: true,
    },
  },
  sensitivityDefault: 'business',
  itemKind: 'claim',
  statuses: ['active', 'superseded'],
  subjectTypes: [...ENTITY_STORAGE_TYPES],
  subjectRequired: true,
});

/**
 * Wire constant: person fact.
 *
 * @stability experimental
 */
export const PersonFact = defineEntityType({
  key: 'PersonFact',
  domain: 'core',
  label: 'Person fact',
  pluralLabel: 'Person facts',
  description:
    'A statement about a Person as an individual rather than about their work: an interest, a preference, a personal-life detail, or their communication style.',
  disambiguation: [
    'A fact about the person\'s job, employer or role is a Claim (or a relation), not a PersonFact.',
    'Health, legal, financial or similarly weighty personal information is sensitive and must be marked so.',
  ],
  attributes: {},
  sensitivityDefault: 'personal',
  itemKind: 'person_fact',
  statuses: ['active', 'superseded'],
  subjectTypes: ['Person'],
  subjectRequired: true,
});

/**
 * Wire constant: core domain.
 *
 * @stability experimental
 */
export const coreDomain = defineDomain({
  key: 'core',
  label: 'Core',
  alwaysOn: true,
  defaultEnabled: true,
  entityTypes: [Person, Organization, Meeting, Claim, PersonFact, Topic, Document],
  relationTypes: [
    defineRelationType({
      key: 'ABOUT',
      domain: 'core',
      label: 'About',
      description: 'The entity an item (a claim, decision, commitment or person fact) is about: its subject.',
      from: ['Claim', 'Decision', 'Commitment', 'PersonFact', 'Risk'],
      to: [...ENTITY_STORAGE_TYPES],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'item_column', column: 'subject_id' },
      extractable: false,
    }),
    defineRelationType({
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
    }),
    defineRelationType({
      key: 'SUPERSEDES',
      domain: 'core',
      label: 'Supersedes',
      description: 'A newer decision, claim or commitment that replaces an older one of the same type.',
      from: ['Decision', 'Claim', 'Commitment', 'Risk'],
      to: ['Decision', 'Claim', 'Commitment', 'Risk'],
      allowedPairs: [
        ['Decision', 'Decision'],
        ['Claim', 'Claim'],
        ['Commitment', 'Commitment'],
        ['Risk', 'Risk'],
      ],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'supersedes' },
      extractable: false,
    }),
    defineRelationType({
      key: 'MENTIONS',
      domain: 'core',
      label: 'Mentions',
      description: 'A note or transcript that mentions an entity somewhere in its text.',
      from: ['Note', 'Transcript'],
      to: [...ENTITY_STORAGE_TYPES],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'mention' },
      extractable: false,
    }),
    defineRelationType({
      key: 'SUPPORTED_BY',
      domain: 'core',
      label: 'Supported by',
      description: 'The transcript segment or note span that is evidence for a graph row.',
      from: [...ALL_TYPES],
      to: ['Transcript', 'Note'],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'evidence' },
      extractable: false,
    }),
    defineRelationType({
      key: 'BROADER',
      domain: 'core',
      label: 'Broader',
      description: 'A topic that is a narrower part of a broader theme: "licensing cost" BROADER "AI governance" rolls the narrower topic up into the theme.',
      from: ['Topic'],
      to: ['Topic'],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'edge' },
      extractable: true,
      alignment: 'skos:broader',
    }),
    defineRelationType({
      key: 'RECORDED_IN',
      domain: 'core',
      label: 'Recorded in',
      description: 'The document in which a meeting was recorded (minutes, a deck, a briefing), written by the system.',
      from: ['Meeting'],
      to: ['Document'],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'edge' },
      extractable: false,
    }),
    defineRelationType({
      key: 'PREPARED_FOR',
      domain: 'core',
      label: 'Prepared for',
      description: 'The person a document was prepared for, written by the system.',
      from: ['Document'],
      to: ['Person'],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'edge' },
      extractable: false,
    }),
  ],
  mixins: [],
});
