"use strict";
// =============================================================================
// The `work` domain (docs/specs/ontology.md §5.1, §5.2, §5.4, §17.2)
// =============================================================================
//
// On by default; a user may switch it off in the Knowledge graph settings
// card, and then none of these types or relations is ever sent to the model.
// It adds three types, ten relations, and -- through a mixin -- the `title`
// attribute onto core's `Person` (§17.2's worked example), so `core.ts` never
// has to know what this domain chose to add.
//
// Every `description` and `disambiguation` string below is extraction-prompt
// copy (#363 sends it verbatim). Editing one is a PATCH bump of
// ONTOLOGY_VERSION and a CHANGELOG line in `version.ts`.
// =============================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.workDomain = exports.decidedIn = exports.createdIn = exports.owedTo = exports.assignedTo = exports.partOf = exports.discussed = exports.attended = exports.reportsTo = exports.hasRole = exports.worksFor = exports.decision = exports.commitment = exports.project = void 0;
const define_js_1 = require("../define.js");
/** The item subjects a Commitment or Decision may be ABOUT. */
const WORK_SUBJECT_TYPES = ['Person', 'Organization', 'Project'];
exports.project = (0, define_js_1.defineEntityType)({
    key: 'Project',
    domain: 'work',
    label: 'Project',
    pluralLabel: 'Projects',
    description: 'A named effort with a start and an expected (even if fuzzy) end that meetings, decisions and commitments attach to. Positive: "Q2 pilot," "the vendor migration."',
    disambiguation: [
        'Negative: "AI code review" as a recurring meeting topic with no start/end and nothing else attaching to it as a unit of work — that is a topic, not a project; it belongs in the Meeting\'s topics.',
        'Be conservative: do not create a Project for every recurring conversation subject; create one only when a commitment or decision attaches to it as a unit of work.',
    ],
    attributes: {
        status: {
            kind: 'select',
            label: 'Status',
            description: "The project's stage, only when the source states or clearly implies it.",
            extractable: true,
            options: {
                choices: [
                    { value: 'planned', label: 'Planned' },
                    { value: 'active', label: 'Active' },
                    { value: 'done', label: 'Done' },
                    { value: 'cancelled', label: 'Cancelled' },
                ],
            },
        },
        startDate: {
            kind: 'date',
            label: 'Start date',
            description: 'The date the project started or is planned to start, only when the source states it.',
            extractable: true,
        },
        endDate: {
            kind: 'date',
            label: 'End date',
            description: 'The date the project ended or is expected to end, only when the source states it.',
            extractable: true,
        },
    },
    sensitivityDefault: 'business',
    alignment: 'schema:Project',
});
exports.commitment = (0, define_js_1.defineEntityType)({
    key: 'Commitment',
    domain: 'work',
    label: 'Commitment',
    pluralLabel: 'Commitments',
    description: 'A task with an owner and, optionally, a counterparty and a due date, stated or clearly implied by the source text. Positive: "Sarah will send the updated proposal by Friday" (owner: Sarah, due: Friday).',
    disambiguation: [
        'Negative: "we should probably look into that at some point" — no owner named or clearly implied is not a Commitment; it is either a Claim (a statement that this was discussed) or nothing at all.',
        'Never force-fit a sentence into a Commitment because it sounded task-shaped; a choice that was made is a Decision.',
    ],
    attributes: {},
    sensitivityDefault: 'business',
    itemKind: 'commitment',
    statuses: ['open', 'done', 'dropped', 'superseded'],
    subjectTypes: [...WORK_SUBJECT_TYPES],
    subjectRequired: false,
});
exports.decision = (0, define_js_1.defineEntityType)({
    key: 'Decision',
    domain: 'work',
    label: 'Decision',
    pluralLabel: 'Decisions',
    description: 'A choice that was made, with what was chosen and, when the source states it, the option that was rejected.',
    disambiguation: [
        'A later reversal is a new Decision that supersedes the old one; never describe a change of mind as an edit to the earlier Decision.',
        'A task someone agreed to do is a Commitment; a stated fact that involved no choice is a Claim.',
    ],
    attributes: {
        rejectedOption: {
            kind: 'text',
            label: 'Rejected option',
            description: 'The alternative that was considered and not chosen, only when the source states it.',
            extractable: true,
        },
    },
    sensitivityDefault: 'business',
    itemKind: 'decision',
    statuses: ['active', 'superseded'],
    subjectTypes: [...WORK_SUBJECT_TYPES],
    subjectRequired: false,
});
exports.worksFor = (0, define_js_1.defineRelationType)({
    key: 'WORKS_FOR',
    domain: 'work',
    label: 'Works for',
    description: 'A person is employed by, or works on behalf of, an organization during a period of time.',
    from: ['Person'],
    to: ['Organization'],
    temporal: true,
    exclusive: 'soft',
    exclusiveScope: 'from',
    props: {},
    representation: { kind: 'edge' },
    extractable: true,
    alignment: 'schema:worksFor',
});
exports.hasRole = (0, define_js_1.defineRelationType)({
    key: 'HAS_ROLE',
    domain: 'work',
    label: 'Has role',
    description: 'A person holds a titled role at an organization during a period of time; one edge per role period.',
    from: ['Person'],
    to: ['Organization'],
    temporal: true,
    exclusive: 'soft',
    // "HAS_ROLE within one organization" (§5.4): a new role at Acme closes the
    // open Acme role, never an open role somewhere else.
    exclusiveScope: 'from_to',
    props: {
        title: {
            kind: 'text',
            label: 'Title',
            description: 'The title of the role as stated in the source, e.g. "Staff Engineer".',
            required: true,
            extractable: true,
        },
    },
    representation: { kind: 'edge' },
    extractable: true,
});
exports.reportsTo = (0, define_js_1.defineRelationType)({
    key: 'REPORTS_TO',
    domain: 'work',
    label: 'Reports to',
    description: 'A person reports to another person, their manager, during a period of time.',
    from: ['Person'],
    to: ['Person'],
    temporal: true,
    exclusive: 'soft',
    exclusiveScope: 'from',
    props: {},
    representation: { kind: 'edge' },
    extractable: true,
});
exports.attended = (0, define_js_1.defineRelationType)({
    key: 'ATTENDED',
    domain: 'work',
    label: 'Attended',
    description: 'A person took part in a meeting, as a speaker or a named attendee.',
    from: ['Person'],
    to: ['Meeting'],
    temporal: false,
    exclusive: 'none',
    props: {},
    representation: { kind: 'edge' },
    extractable: true,
});
exports.discussed = (0, define_js_1.defineRelationType)({
    key: 'DISCUSSED',
    domain: 'work',
    label: 'Discussed',
    description: 'A meeting discussed a project in substance, not merely in passing.',
    from: ['Meeting'],
    to: ['Project'],
    temporal: false,
    exclusive: 'none',
    props: {},
    representation: { kind: 'edge' },
    extractable: true,
});
exports.partOf = (0, define_js_1.defineRelationType)({
    key: 'PART_OF',
    domain: 'work',
    label: 'Part of',
    description: 'A project belongs to an organization, or a meeting belongs to a project.',
    from: ['Project', 'Meeting'],
    to: ['Organization', 'Project'],
    allowedPairs: [
        ['Project', 'Organization'],
        ['Meeting', 'Project'],
    ],
    temporal: false,
    exclusive: 'none',
    props: {},
    representation: { kind: 'edge' },
    extractable: true,
});
exports.assignedTo = (0, define_js_1.defineRelationType)({
    key: 'ASSIGNED_TO',
    domain: 'work',
    label: 'Assigned to',
    description: "The person who owns a commitment: the one who said they would do it.",
    from: ['Commitment'],
    to: ['Person'],
    temporal: false,
    exclusive: 'none',
    props: {},
    representation: { kind: 'item_column', column: 'owner_person_id' },
    extractable: false,
});
exports.owedTo = (0, define_js_1.defineRelationType)({
    key: 'OWED_TO',
    domain: 'work',
    label: 'Owed to',
    description: 'The counterparty a commitment is owed to, when one is stated: a person or an organization.',
    from: ['Commitment'],
    to: ['Person', 'Organization'],
    temporal: false,
    exclusive: 'none',
    props: {},
    representation: { kind: 'item_column', column: 'counterparty_id' },
    extractable: false,
});
exports.createdIn = (0, define_js_1.defineRelationType)({
    key: 'CREATED_IN',
    domain: 'work',
    label: 'Created in',
    description: 'The meeting in which a commitment was made.',
    from: ['Commitment'],
    to: ['Meeting'],
    temporal: false,
    exclusive: 'none',
    props: {},
    representation: { kind: 'item_column', column: 'meeting_id' },
    extractable: false,
});
exports.decidedIn = (0, define_js_1.defineRelationType)({
    key: 'DECIDED_IN',
    domain: 'work',
    label: 'Decided in',
    description: 'The meeting in which a decision was made.',
    from: ['Decision'],
    to: ['Meeting'],
    temporal: false,
    exclusive: 'none',
    props: {},
    representation: { kind: 'item_column', column: 'meeting_id' },
    extractable: false,
});
exports.workDomain = (0, define_js_1.defineDomain)({
    key: 'work',
    label: 'Work',
    alwaysOn: false,
    defaultEnabled: true,
    entityTypes: [exports.project, exports.commitment, exports.decision],
    relationTypes: [
        exports.worksFor,
        exports.hasRole,
        exports.reportsTo,
        exports.attended,
        exports.discussed,
        exports.partOf,
        exports.assignedTo,
        exports.owedTo,
        exports.createdIn,
        exports.decidedIn,
    ],
    mixins: [
        {
            entityType: 'Person',
            attributes: {
                title: {
                    kind: 'text',
                    label: 'Title',
                    description: "The person's current job title, only when the source states it.",
                    extractable: true,
                    sensitivity: 'business',
                },
            },
        },
    ],
});
