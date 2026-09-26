"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.coreDomain = exports.PersonFact = exports.Claim = exports.Meeting = exports.Organization = exports.Person = void 0;
const define_js_1 = require("../define.js");
/** Every type stored in `kg_entities`, across all domains (endpoint lists below). */
const ENTITY_STORAGE_TYPES = ['Person', 'Organization', 'Meeting', 'Project'];
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
];
exports.Person = (0, define_js_1.defineEntityType)({
    key: 'Person',
    domain: 'core',
    label: 'Person',
    pluralLabel: 'People',
    description: 'A human being: one specific, individual person named or unambiguously identified in the source.',
    disambiguation: [
        'Never a role ("the CIO"), never a team, never an organization acting collectively.',
        'Positive: "Sarah Chen"; "the Acme CIO whose name was given as Marcus Webb."',
        'Negative: "the data team at EY" is an Organization, or a Person if and only if one specific human is meant.',
        'Negative: "whoever\'s on call" names no specific human, so there is nothing to create.',
    ],
    attributes: {},
    sensitivityDefault: 'business',
    alignment: 'schema:Person',
});
exports.Organization = (0, define_js_1.defineEntityType)({
    key: 'Organization',
    domain: 'core',
    label: 'Organization',
    pluralLabel: 'Organizations',
    description: 'A company, client, vendor or institution, or an internal team specifically when that team acts as a party to a commitment or decision.',
    disambiguation: [
        'Positive: "EY" (a company); "the data team at EY" when a commitment is owed to that team specifically rather than to an individual within it.',
        'Negative: a team mentioned only in passing, with no commitment or decision naming it as a party, is not an Organization; do not create one speculatively.',
        'Never a single human being acting for the organization: that is a Person.',
    ],
    attributes: {
        website: {
            kind: 'url',
            label: 'Website',
            description: "The organization's website address, only if the source states it explicitly.",
            extractable: true,
        },
    },
    sensitivityDefault: 'business',
    alignment: 'schema:Organization',
});
exports.Meeting = (0, define_js_1.defineEntityType)({
    key: 'Meeting',
    domain: 'core',
    label: 'Meeting',
    pluralLabel: 'Meetings',
    description: 'The event anchor: a dated meeting or conversation, its attendees, and the transcript and/or note it was drawn from.',
    disambiguation: [
        'One Meeting per transcript, or per note with no source audio; created by the system, never proposed by extraction.',
        'A recurring conversation subject is not a Meeting; it is a topic of the meetings it came up in.',
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
    },
    sensitivityDefault: 'business',
    alignment: 'schema:Event',
    extractable: false,
});
exports.Claim = (0, define_js_1.defineEntityType)({
    key: 'Claim',
    domain: 'core',
    label: 'Claim',
    pluralLabel: 'Claims',
    description: 'A dated statement of fact about an entity that is neither a decision nor a commitment, e.g. "the budget was cut 20%" or "the pilot moved to Q2".',
    disambiguation: [
        'A choice that was made is a Decision, not a Claim.',
        'A task with an owner is a Commitment, not a Claim.',
        'A fact about a Person as an individual rather than about their work is a PersonFact.',
    ],
    attributes: {},
    sensitivityDefault: 'business',
    itemKind: 'claim',
    statuses: ['active', 'superseded'],
    subjectTypes: [...ENTITY_STORAGE_TYPES],
    subjectRequired: true,
});
exports.PersonFact = (0, define_js_1.defineEntityType)({
    key: 'PersonFact',
    domain: 'core',
    label: 'Person fact',
    pluralLabel: 'Person facts',
    description: 'A statement about a Person as an individual rather than about their work: an interest, a preference, a personal-life detail, or their communication style.',
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
exports.coreDomain = (0, define_js_1.defineDomain)({
    key: 'core',
    label: 'Core',
    alwaysOn: true,
    defaultEnabled: true,
    entityTypes: [exports.Person, exports.Organization, exports.Meeting, exports.Claim, exports.PersonFact],
    relationTypes: [
        (0, define_js_1.defineRelationType)({
            key: 'ABOUT',
            domain: 'core',
            label: 'About',
            description: 'The entity an item (a claim, decision, commitment or person fact) is about: its subject.',
            from: ['Claim', 'Decision', 'Commitment', 'PersonFact'],
            to: [...ENTITY_STORAGE_TYPES],
            temporal: false,
            exclusive: 'none',
            props: {},
            representation: { kind: 'item_column', column: 'subject_id' },
            extractable: false,
        }),
        (0, define_js_1.defineRelationType)({
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
        (0, define_js_1.defineRelationType)({
            key: 'SUPERSEDES',
            domain: 'core',
            label: 'Supersedes',
            description: 'A newer decision, claim or commitment that replaces an older one of the same type.',
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
        }),
        (0, define_js_1.defineRelationType)({
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
        (0, define_js_1.defineRelationType)({
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
    ],
    mixins: [],
});
