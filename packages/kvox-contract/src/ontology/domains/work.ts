// =============================================================================
// The `work` domain (docs/specs/ontology.md §5.1, §5.2, §5.4, §17.2). On by
// default; a user may turn it off, and then none of these types or relations is
// ever shown to them or sent to the model.
//
// Every `description` and `disambiguation` string below is extraction-prompt
// copy: `kg.extract` sends it to the model verbatim.
//
// KEYS ARE PERMANENT (§17.1): deprecate, never rename or delete, and record
// every new key in `shipped-keys.ts`.
// =============================================================================

import { defineDomain, defineEntityType, defineRelationType } from '../define.js';

/**
 * Wire constant: project.
 *
 * @stability experimental
 */
export const Project = defineEntityType({
  key: 'Project',
  domain: 'work',
  label: 'Project',
  pluralLabel: 'Projects',
  description:
    'A named effort with a start and an expected (even if fuzzy) end that meetings, decisions and commitments attach to, e.g. "Q2 pilot" or "the vendor migration".',
  disambiguation: [
    'A recurring meeting topic with no start or end and nothing attaching to it as a unit of work is a topic, not a Project.',
    'Do not create a Project for every recurring conversation subject; create one only when it anchors work.',
  ],
  attributes: {
    status: {
      kind: 'select',
      label: 'Status',
      description: 'Where the project stands, only if the source says so.',
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
      description: 'The date the project started or is planned to start, if stated.',
      extractable: true,
    },
    endDate: {
      kind: 'date',
      label: 'End date',
      description: 'The date the project ended or is expected to end, if stated.',
      extractable: true,
    },
  },
  sensitivityDefault: 'business',
  alignment: 'schema:Project',
});

/**
 * Wire constant: product.
 *
 * @stability experimental
 */
export const Product = defineEntityType({
  key: 'Product',
  domain: 'work',
  label: 'Product',
  pluralLabel: 'Products',
  description:
    'A named product, service, tool, platform or technology that organizations offer, adopt or evaluate, e.g. "Microsoft Copilot", "Salesforce", "SAP S/4HANA".',
  disambiguation: [
    'The rollout or adoption effort is a Project ("Copilot rollout"); the thing being rolled out is the Product ("Microsoft Copilot").',
    'The vendor company is an Organization linked by OFFERED_BY, never folded into the product label.',
  ],
  attributes: {
    category: {
      kind: 'select',
      label: 'Category',
      description: 'What kind of product this is, only if the source says so.',
      extractable: true,
      options: {
        choices: [
          { value: 'software', label: 'Software' },
          { value: 'platform', label: 'Platform' },
          { value: 'ai_model', label: 'AI model or assistant' },
          { value: 'hardware', label: 'Hardware' },
          { value: 'service', label: 'Service' },
          { value: 'other', label: 'Other' },
        ],
      },
    },
    vendorName: {
      kind: 'text',
      label: 'Vendor',
      description: 'The name of the vendor that offers the product, only if the source states it. A resolution hint, not a link.',
      extractable: true,
    },
  },
  sensitivityDefault: 'business',
  alignment: 'schema:Product',
});

/**
 * Wire constant: commitment.
 *
 * @stability experimental
 */
export const Commitment = defineEntityType({
  key: 'Commitment',
  domain: 'work',
  label: 'Commitment',
  pluralLabel: 'Commitments',
  description:
    'A task with an owner and, optionally, a counterparty and a due date, stated or clearly implied by the source, e.g. "Sarah will send the updated proposal by Friday".',
  disambiguation: [
    'No owner named or clearly implied means it is not a Commitment: "we should probably look into that" is a Claim at most, or nothing.',
    'Never force-fit a sentence into a Commitment because it sounds task-shaped.',
  ],
  attributes: {},
  sensitivityDefault: 'business',
  itemKind: 'commitment',
  statuses: ['open', 'done', 'dropped', 'superseded'],
  subjectTypes: ['Person', 'Organization', 'Project', 'Product', 'Topic'],
  subjectRequired: false,
});

/**
 * Wire constant: decision.
 *
 * @stability experimental
 */
export const Decision = defineEntityType({
  key: 'Decision',
  domain: 'work',
  label: 'Decision',
  pluralLabel: 'Decisions',
  description:
    'A choice that was made: what was chosen and, when the source states it, the option that was rejected.',
  disambiguation: [
    'A later reversal is a new Decision that supersedes the old one; never edit the earlier Decision.',
    'A statement of fact that involves no choice is a Claim, not a Decision.',
  ],
  attributes: {
    rejectedOption: {
      kind: 'text',
      label: 'Rejected option',
      description: 'The option that was considered and rejected, only if the source states it.',
      extractable: true,
    },
  },
  sensitivityDefault: 'business',
  itemKind: 'decision',
  statuses: ['active', 'superseded'],
  subjectTypes: ['Person', 'Organization', 'Project', 'Product', 'Topic'],
  subjectRequired: false,
});

/**
 * Wire constant: risk.
 *
 * @stability experimental
 */
export const Risk = defineEntityType({
  key: 'Risk',
  domain: 'work',
  label: 'Risk',
  pluralLabel: 'Risks',
  description:
    'A risk, issue or blocker that someone raised about a project, product or organization, e.g. "licence budget not approved could delay the rollout".',
  disambiguation: [
    'A task someone will do is a Commitment.',
    'A choice made is a Decision.',
    'A neutral statement of fact is a Claim.',
    'Only create a Risk when the source frames something as a threat, blocker or problem.',
  ],
  attributes: {
    severity: {
      kind: 'select',
      label: 'Severity',
      description: 'How serious the source makes the risk sound, only if it says so.',
      extractable: true,
      options: {
        choices: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
    },
    riskKind: {
      kind: 'select',
      label: 'Kind',
      description:
        'Whether it is a possible future problem (risk), a problem that is already happening (issue) or something that stops work now (blocker).',
      extractable: true,
      options: {
        choices: [
          { value: 'risk', label: 'Risk' },
          { value: 'issue', label: 'Issue' },
          { value: 'blocker', label: 'Blocker' },
        ],
      },
    },
    mitigation: {
      kind: 'text',
      label: 'Mitigation',
      description: 'What was said about reducing or removing the risk, only if the source states it.',
      extractable: true,
    },
  },
  sensitivityDefault: 'business',
  itemKind: 'risk',
  statuses: ['open', 'mitigated', 'closed', 'superseded'],
  subjectTypes: ['Person', 'Organization', 'Project', 'Product', 'Topic'],
  subjectRequired: false,
});

/**
 * Wire constant: work domain.
 *
 * @stability experimental
 */
export const workDomain = defineDomain({
  key: 'work',
  label: 'Work',
  alwaysOn: false,
  defaultEnabled: true,
  entityTypes: [Project, Product, Commitment, Decision, Risk],
  relationTypes: [
    defineRelationType({
      key: 'WORKS_FOR',
      domain: 'work',
      label: 'Works for',
      description:
        'A person is employed by, or works on behalf of, an organization — the one way a person\'s employer is recorded: "Joe works for Microsoft" is Joe WORKS_FOR Microsoft (an Organization); his role and business unit there are a HAS_ROLE to the same Organization.',
      from: ['Person'],
      to: ['Organization'],
      temporal: true,
      exclusive: 'soft',
      exclusiveScope: 'from',
      props: {},
      representation: { kind: 'edge' },
      extractable: true,
      alignment: 'schema:worksFor',
    }),
    defineRelationType({
      key: 'HAS_ROLE',
      domain: 'work',
      label: 'Has role',
      description:
        'A person holds a titled role, optionally within a business unit, at an organization for a period of time: "Joe, VP of Supply Chain at Microsoft" is Joe HAS_ROLE Microsoft {title: "VP", businessUnit: "Supply Chain"}.',
      from: ['Person'],
      to: ['Organization'],
      temporal: true,
      exclusive: 'soft',
      exclusiveScope: 'from_to',
      props: {
        title: {
          kind: 'text',
          label: 'Role',
          description: 'The job title the person holds in this role, e.g. "Staff Engineer".',
          required: true,
          extractable: true,
        },
        businessUnit: {
          kind: 'text',
          label: 'Business unit',
          description:
            'The business unit, division, practice or department within the organization this role sits in, e.g. "Supply Chain", only if the source states it.',
          extractable: true,
          identity: true,
        },
      },
      representation: { kind: 'edge' },
      extractable: true,
      alignment: 'schema:hasOccupation',
    }),
    defineRelationType({
      key: 'REPORTS_TO',
      domain: 'work',
      label: 'Reports to',
      description: 'A person reports to another person, their manager, for a period of time.',
      from: ['Person'],
      to: ['Person'],
      temporal: true,
      exclusive: 'soft',
      exclusiveScope: 'from',
      props: {},
      representation: { kind: 'edge' },
      extractable: true,
    }),
    defineRelationType({
      key: 'ATTENDED',
      domain: 'work',
      label: 'Attended',
      description: 'A person took part in a meeting.',
      from: ['Person'],
      to: ['Meeting'],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'edge' },
      extractable: true,
      alignment: 'schema:attendee',
    }),
    defineRelationType({
      key: 'DISCUSSED',
      domain: 'work',
      label: 'Discussed',
      description:
        'A meeting discussed a project, topic, product or organization as a substantive subject.',
      from: ['Meeting'],
      to: ['Project', 'Topic', 'Product', 'Organization'],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'edge' },
      extractable: true,
    }),
    defineRelationType({
      key: 'PART_OF',
      domain: 'work',
      label: 'Part of',
      description:
        'A project belongs to an organization, a meeting belongs to a project, or a topic is scoped under a project.',
      from: ['Project', 'Meeting', 'Topic'],
      to: ['Organization', 'Project'],
      allowedPairs: [
        ['Project', 'Organization'],
        ['Meeting', 'Project'],
        ['Topic', 'Project'],
      ],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'edge' },
      extractable: true,
    }),
    // ---- Stakeholder and market relations (1.3.0, #663) ----
    defineRelationType({
      key: 'INVOLVED_IN',
      domain: 'work',
      label: 'Involved in',
      description:
        'A person has a stated role in a project, and optionally a stance toward it: "Joe is the budget approver for the Copilot rollout and is skeptical of it" is Joe INVOLVED_IN Copilot rollout {role: approver, stance: skeptical}.' +
        ' Assigned tasks are Commitments with ASSIGNED_TO; attending one meeting about a project is ATTENDED + DISCUSSED, not INVOLVED_IN unless the source states a role. Set role only to the role the source states or clearly implies; if no role is stated, do not create INVOLVED_IN. Set stance only when the source states it or the person\'s position is unmistakably implied (an explicit objection, endorsement or refusal). Never infer stance from tone, a single question, or silence; when in doubt, omit it.',
      from: ['Person'],
      to: ['Project'],
      temporal: true,
      exclusive: 'none',
      props: {
        role: {
          kind: 'select',
          label: 'Role',
          description: 'The role the person plays in the project, as the source states it.',
          required: true,
          extractable: true,
          options: {
            choices: [
              { value: 'sponsor', label: 'Sponsor' },
              { value: 'owner', label: 'Owner' },
              { value: 'lead', label: 'Lead' },
              { value: 'contributor', label: 'Contributor' },
              { value: 'stakeholder', label: 'Stakeholder' },
              { value: 'approver', label: 'Approver' },
              { value: 'end_user', label: 'End user' },
              { value: 'advisor', label: 'Advisor' },
            ],
          },
        },
        stance: {
          kind: 'select',
          label: 'Stance',
          description:
            "The person's position toward the project, only when the source states it or it is unmistakably implied; never inferred from tone alone.",
          extractable: true,
          options: {
            choices: [
              { value: 'champion', label: 'Champion' },
              { value: 'supportive', label: 'Supportive' },
              { value: 'neutral', label: 'Neutral' },
              { value: 'skeptical', label: 'Skeptical' },
              { value: 'resistant', label: 'Resistant' },
            ],
          },
        },
      },
      representation: { kind: 'edge' },
      extractable: true,
    }),
    defineRelationType({
      key: 'USES',
      domain: 'work',
      label: 'Uses',
      description:
        'An organization or a project adopts, evaluates or runs a product, at a stage: "Company A is piloting Copilot" is Company A USES Copilot {stage: piloting}.' +
        ' A move to a later stage (piloting to adopted) is a new USES with the new stage, which closes the earlier one; never edit the old stage. The vendor of the product is OFFERED_BY, not USES; a project about a product without adopting it is CONCERNS. Set stage only when the source states it; "evaluating" is for a stated assessment, not for a passing mention.',
      from: ['Organization', 'Project'],
      to: ['Product'],
      temporal: true,
      exclusive: 'soft',
      exclusiveScope: 'from_to',
      props: {
        stage: {
          kind: 'select',
          label: 'Stage',
          description: 'How far the adoption has gone, only if the source states it.',
          extractable: true,
          identity: true,
          options: {
            choices: [
              { value: 'evaluating', label: 'Evaluating' },
              { value: 'piloting', label: 'Piloting' },
              { value: 'rolling_out', label: 'Rolling out' },
              { value: 'adopted', label: 'Adopted' },
              { value: 'retired', label: 'Retired' },
            ],
          },
        },
      },
      representation: { kind: 'edge' },
      extractable: true,
    }),
    defineRelationType({
      key: 'OFFERED_BY',
      domain: 'work',
      label: 'Offered by',
      description:
        'The vendor of a product: "Copilot is Microsoft\'s" is Microsoft Copilot OFFERED_BY Microsoft.' +
        ' A product has one current vendor; a change of vendor (an acquisition) is a new OFFERED_BY that closes the old one. A customer that merely uses the product is USES or CUSTOMER_OF, never OFFERED_BY.',
      from: ['Product'],
      to: ['Organization'],
      temporal: true,
      exclusive: 'soft',
      exclusiveScope: 'from',
      props: {},
      representation: { kind: 'edge' },
      extractable: true,
      alignment: 'schema:manufacturer',
    }),
    defineRelationType({
      key: 'CUSTOMER_OF',
      domain: 'work',
      label: 'Customer of',
      description:
        'An organization buys from another organization: "Company A is a Microsoft customer" is Company A CUSTOMER_OF Microsoft. Direction matters: customer first, supplier second.' +
        ' Using a specific product is USES; CUSTOMER_OF is the commercial relationship between the two organizations. A partner, reseller or integrator is PARTNER_OF, not CUSTOMER_OF.',
      from: ['Organization'],
      to: ['Organization'],
      temporal: true,
      exclusive: 'none',
      props: {},
      representation: { kind: 'edge' },
      extractable: true,
    }),
    defineRelationType({
      key: 'PARTNER_OF',
      domain: 'work',
      label: 'Partner of',
      description:
        'Two organizations are business partners (alliance, reseller, integrator): "Accenture is Company A\'s partner". Direction does not matter: record it once.' +
        ' A buyer and supplier is CUSTOMER_OF; organizations that compete are COMPETITOR_OF.',
      from: ['Organization'],
      to: ['Organization'],
      temporal: true,
      exclusive: 'none',
      symmetric: true,
      props: {},
      representation: { kind: 'edge' },
      extractable: true,
    }),
    defineRelationType({
      key: 'COMPETITOR_OF',
      domain: 'work',
      label: 'Competitor of',
      description:
        'Two organizations compete in the same market: "Google and Microsoft compete on productivity suites". Direction does not matter: record it once.' +
        ' Only when the source says or clearly implies the organizations compete; two organizations merely mentioned together are not competitors.',
      from: ['Organization'],
      to: ['Organization'],
      temporal: true,
      exclusive: 'none',
      symmetric: true,
      props: {},
      representation: { kind: 'edge' },
      extractable: true,
    }),
    defineRelationType({
      key: 'CONCERNS',
      domain: 'work',
      label: 'Concerns',
      description:
        'What a project is about: "The Copilot rollout concerns Microsoft Copilot and licensing cost" gives the project CONCERNS the product and CONCERNS the topic.' +
        ' A meeting covering a subject is DISCUSSED; CONCERNS ties a project to its own subject matter. A project that adopts or runs a product is USES; use CONCERNS for the product the effort is about.',
      from: ['Project'],
      to: ['Product', 'Topic'],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'edge' },
      extractable: true,
    }),
    defineRelationType({
      key: 'KNOWS_ABOUT',
      domain: 'work',
      label: 'Knows about',
      description:
        'A person has expertise in a topic or product: "Maria is our expert on AI governance" is Maria KNOWS_ABOUT AI governance {level: expert}.' +
        ' Hobbies and lasting private interests are not KNOWS_ABOUT. Set level only when the source states it ("expert", "hands-on", "just heard of it"); attending a meeting about a topic does not make someone know about it.',
      from: ['Person'],
      to: ['Topic', 'Product'],
      temporal: false,
      exclusive: 'none',
      props: {
        level: {
          kind: 'select',
          label: 'Level',
          description: 'How deep the knowledge is, only if the source states it.',
          extractable: true,
          options: {
            choices: [
              { value: 'aware', label: 'Aware' },
              { value: 'practitioner', label: 'Practitioner' },
              { value: 'expert', label: 'Expert' },
            ],
          },
        },
      },
      representation: { kind: 'edge' },
      extractable: true,
      alignment: 'schema:knowsAbout',
    }),
    defineRelationType({
      key: 'ASSIGNED_TO',
      domain: 'work',
      label: 'Assigned to',
      description: 'The person who owns a commitment and is expected to carry it out.',
      from: ['Commitment'],
      to: ['Person'],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'item_column', column: 'owner_person_id' },
      extractable: false,
    }),
    defineRelationType({
      key: 'OWED_TO',
      domain: 'work',
      label: 'Owed to',
      description: 'The person or organization a commitment is owed to, when one is stated.',
      from: ['Commitment'],
      to: ['Person', 'Organization'],
      temporal: false,
      exclusive: 'none',
      props: {},
      representation: { kind: 'item_column', column: 'counterparty_id' },
      extractable: false,
    }),
    defineRelationType({
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
    }),
    defineRelationType({
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
    }),
  ],
  mixins: [
    {
      entityType: 'Person',
      attributes: {
        title: {
          kind: 'text',
          label: 'Job title',
          description: "The person's job title, only if the source states it.",
          extractable: false,
          sensitivity: 'business',
          alignment: 'schema:jobTitle',
          deprecated: {
            since: '1.2.0',
            reason: 'A role belongs to the employment, not the person: it is recorded as HAS_ROLE.title (with HAS_ROLE.businessUnit) to the Organization (#440).',
          },
        },
      },
    },
  ],
});
