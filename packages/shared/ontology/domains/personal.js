"use strict";
// =============================================================================
// The `personal` domain (docs/specs/ontology.md §5.6, §15, §16 P6, §17.2).
// OFF by default: a user turns it on in the Knowledge graph settings page, and
// until they do none of these types or relations is ever shown to them or sent
// to the model.
//
// Every type and relation here is `sensitivityDefault: 'personal'`, so §15's
// handling applies automatically the moment the domain is enabled: never
// pre-checked in review, excluded from note-prompt enrichment unless the user
// opts in. These are facts about OTHER people, who never agreed to be profiled.
//
// `Person` stays in `core` (§17.2): this module adds relations onto it, so one
// real human is one row whether `work`, `personal` or both proposed them.
//
// INTERESTED_IN, TRAVELED_ON and HAS_MILESTONE are additions to §17.2's
// original list: without them an Interest, Trip or Milestone could never be
// connected to a Person and would always be an orphan node.
//
// Every `description` and `disambiguation` string below is extraction-prompt
// copy: `kg.extract` sends it to the model verbatim.
//
// KEYS ARE PERMANENT (§17.1): deprecate, never rename or delete, and record
// every new key in `shipped-keys.ts`.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.personalDomain = exports.Milestone = exports.Trip = exports.Interest = void 0;
const define_js_1 = require("../define.js");
exports.Interest = (0, define_js_1.defineEntityType)({
    key: 'Interest',
    domain: 'personal',
    label: 'Interest',
    pluralLabel: 'Interests',
    description: 'A lasting personal interest a person has outside work — a hobby, a sport, music, food, travel or a cause — e.g. "trail running", "jazz piano" or "the local food bank".',
    disambiguation: [
        'A lasting personal interest, never a one-off activity mentioned once; never a work skill (that is a Person attribute).',
        'Name the interest itself ("marathon running"), not a single event of it ("the Berlin marathon" is at most a Trip).',
    ],
    attributes: {
        category: {
            kind: 'select',
            label: 'Category',
            description: 'What kind of interest this is, only if it is clear from the source.',
            extractable: true,
            options: {
                choices: [
                    { value: 'hobby', label: 'Hobby' },
                    { value: 'sport', label: 'Sport' },
                    { value: 'music', label: 'Music' },
                    { value: 'food', label: 'Food' },
                    { value: 'travel', label: 'Travel' },
                    { value: 'cause', label: 'Cause' },
                    { value: 'other', label: 'Other' },
                ],
            },
        },
    },
    sensitivityDefault: 'personal',
    alignment: 'schema:Thing',
});
exports.Trip = (0, define_js_1.defineEntityType)({
    key: 'Trip',
    domain: 'personal',
    label: 'Trip',
    pluralLabel: 'Trips',
    description: 'A specific personal journey with a destination and rough dates, e.g. "the family trip to Lisbon in June".',
    disambiguation: [
        'A specific journey with a destination and rough dates; never a commute or a business trip already captured as a Meeting.',
        'A work trip — a site visit, a conference for the job, a client meeting away — is never a Trip, whatever the destination.',
    ],
    attributes: {
        destination: {
            kind: 'text',
            label: 'Destination',
            description: 'Where the trip goes, as the source names it.',
            extractable: true,
        },
        startDate: {
            kind: 'date',
            label: 'Start date',
            description: 'The date the trip starts or started, if stated.',
            extractable: true,
        },
        endDate: {
            kind: 'date',
            label: 'End date',
            description: 'The date the trip ends or ended, if stated.',
            extractable: true,
        },
    },
    sensitivityDefault: 'personal',
    alignment: 'schema:Trip',
});
exports.Milestone = (0, define_js_1.defineEntityType)({
    key: 'Milestone',
    domain: 'personal',
    label: 'Milestone',
    pluralLabel: 'Milestones',
    description: 'A dated life event of one person — a birthday, an anniversary, a wedding, a birth, a graduation, a move or a retirement.',
    disambiguation: [
        'A dated life event of one person; never a project milestone (that is a Project/Decision).',
        'Label it by person and event ("Priya\'s 40th birthday"), so two people\'s birthdays never collapse into one row.',
    ],
    attributes: {
        date: {
            kind: 'date',
            label: 'Date',
            description: 'The date of the event, if stated.',
            extractable: true,
        },
        kind: {
            kind: 'select',
            label: 'Kind',
            description: 'What kind of life event this is.',
            extractable: true,
            options: {
                choices: [
                    { value: 'birthday', label: 'Birthday' },
                    { value: 'anniversary', label: 'Anniversary' },
                    { value: 'wedding', label: 'Wedding' },
                    { value: 'birth', label: 'Birth' },
                    { value: 'graduation', label: 'Graduation' },
                    { value: 'move', label: 'Move' },
                    { value: 'retirement', label: 'Retirement' },
                    { value: 'other', label: 'Other' },
                ],
            },
        },
    },
    sensitivityDefault: 'personal',
    alignment: 'schema:Event',
});
exports.personalDomain = (0, define_js_1.defineDomain)({
    key: 'personal',
    label: 'Personal life',
    alwaysOn: false,
    defaultEnabled: false,
    entityTypes: [exports.Interest, exports.Trip, exports.Milestone],
    relationTypes: [
        (0, define_js_1.defineRelationType)({
            key: 'SPOUSE_OF',
            domain: 'personal',
            label: 'Spouse of',
            description: 'Two people are married to, or the life partners of, each other. Direction does not matter: record it once.',
            from: ['Person'],
            to: ['Person'],
            temporal: true,
            exclusive: 'soft',
            exclusiveScope: 'from',
            symmetric: true,
            sensitivityDefault: 'personal',
            props: {},
            representation: { kind: 'edge' },
            extractable: true,
            alignment: 'schema:spouse',
        }),
        (0, define_js_1.defineRelationType)({
            key: 'PARENT_OF',
            domain: 'personal',
            label: 'Parent of',
            description: 'A person is the parent of another person: from is the parent, to is the child.',
            from: ['Person'],
            to: ['Person'],
            temporal: false,
            exclusive: 'none',
            symmetric: false,
            sensitivityDefault: 'personal',
            props: {},
            representation: { kind: 'edge' },
            extractable: true,
            alignment: 'schema:children',
        }),
        (0, define_js_1.defineRelationType)({
            key: 'FRIEND_OF',
            domain: 'personal',
            label: 'Friend of',
            description: 'Two people are personal friends, beyond working together. Direction does not matter: record it once.',
            from: ['Person'],
            to: ['Person'],
            temporal: true,
            exclusive: 'none',
            symmetric: true,
            sensitivityDefault: 'personal',
            props: {},
            representation: { kind: 'edge' },
            extractable: true,
            alignment: 'foaf:knows',
        }),
        (0, define_js_1.defineRelationType)({
            key: 'INTERESTED_IN',
            domain: 'personal',
            label: 'Interested in',
            description: 'A person has a lasting personal interest.',
            from: ['Person'],
            to: ['Interest'],
            temporal: false,
            exclusive: 'none',
            symmetric: false,
            sensitivityDefault: 'personal',
            props: {},
            representation: { kind: 'edge' },
            extractable: true,
            alignment: 'foaf:topic_interest',
        }),
        (0, define_js_1.defineRelationType)({
            key: 'TRAVELED_ON',
            domain: 'personal',
            label: 'Traveled on',
            description: 'A person went, or is going, on a personal trip.',
            from: ['Person'],
            to: ['Trip'],
            temporal: false,
            exclusive: 'none',
            symmetric: false,
            sensitivityDefault: 'personal',
            props: {},
            representation: { kind: 'edge' },
            extractable: true,
        }),
        (0, define_js_1.defineRelationType)({
            key: 'HAS_MILESTONE',
            domain: 'personal',
            label: 'Has milestone',
            description: 'A life event belongs to this person: it is their birthday, wedding, graduation or move.',
            from: ['Person'],
            to: ['Milestone'],
            temporal: false,
            exclusive: 'none',
            symmetric: false,
            sensitivityDefault: 'personal',
            props: {},
            representation: { kind: 'edge' },
            extractable: true,
        }),
    ],
    mixins: [],
});
