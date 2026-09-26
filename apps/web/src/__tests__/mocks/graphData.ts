/**
 * Knowledge-graph MSW fixtures (#369's settings card; #373's read side; #367
 * appends proposal fixtures).
 *
 * TYPED BY `services/graph.ts`, which mirrors #370/#372's Zod shapes field for
 * field — so a field renamed on the API fails `tsc` here instead of leaving a
 * suite green against a shape the server no longer sends. If either API PR
 * changes a field, update this file in that PR.
 *
 * The ontology is NOT hand-written: it is the real `toEffectiveSchemaPayload`
 * output for the default domains, computed from `@app/shared/ontology`, so
 * forms render exactly what `GET /api/graph/ontology` would send.
 *
 * Contents: 12 entities (Joe Rivera is the rich one — a promotion, a
 * superseded decision, a sensitive fact), evidence for a segment, a note, an
 * edited segment and an unavailable source.
 */

import {
  computeEffectiveSchema,
  toEffectiveSchemaPayload,
  type DomainKey,
  type UserAttributeDef,
} from '@app/shared/ontology';

import type {
  AttributeDef,
  EntityBrief,
  EntityMention,
  EvidenceLink,
  GraphEntityDetail,
  GraphEdge,
  GraphEntitySummary,
  GraphOntology,
  GraphOverview,
  GraphOverviewNode,
  GraphSlice,
  TimelineEvent,
  CommitResult,
  EndpointRef,
  GraphEntitySearchResult,
  ProposalCounts,
  ProposalDecision,
  ProposalDetail,
  ProposalEvidence,
  ProposalGroupKey,
  ProposalItem,
  ProposalStatus,
  ProposalSummary,
  RevertKept,
} from '../../services/graph';

/** A deterministic v4-shaped uuid, so fixtures read as ids and sort predictably. */
export function gid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

// ---------------------------------------------------------------------------
// Ontology
// ---------------------------------------------------------------------------

export function mockGraphOntology(
  enabledDomains: DomainKey[] = ['core', 'work'],
  userAttributes: UserAttributeDef[] = [],
): GraphOntology {
  return toEffectiveSchemaPayload(computeEffectiveSchema({ enabledDomains, userAttributes }));
}

/** The default-domains ontology the read-side suites share. */
export const graphOntologyFixture: GraphOntology = mockGraphOntology();

/** One of the caller's own attribute definitions (#355's shape). */
export function mockAttributeDef(overrides: Partial<AttributeDef> = {}): AttributeDef {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    entityType: 'Person',
    key: 'u_nickname01',
    label: 'Nickname',
    kind: 'text',
    options: null,
    extractable: true,
    extractionHint: 'How teammates address them informally',
    sensitivity: null,
    sortOrder: 0,
    deprecatedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const JOE_ID = gid(1);
export const ANA_ID = gid(2);
export const BEN_ID = gid(3);
export const ACME_ID = gid(4);
export const GLOBEX_ID = gid(5);
export const ATLAS_ID = gid(6);
export const Q3_MEETING_ID = gid(7);
export const SYNC_MEETING_ID = gid(8);
export const CARLA_ID = gid(9);
export const INITECH_ID = gid(10);
export const BEACON_ID = gid(11);
export const DANA_ID = gid(12);

export const TRANSCRIPT_ID = gid(900);
export const SEGMENT_ID = gid(901);
export const NOTE_ID = gid(950);
export const SPEAKER_A_ID = gid(801);
export const SPEAKER_B_ID = gid(802);

export const graphEntitySummaries: GraphEntitySummary[] = [
  { id: JOE_ID, type: 'Person', label: 'Joe Rivera', aliases: ['Joseph Rivera', 'Joe R.'], mentionCount: 14, lastSeenAt: '2026-09-20T15:00:00.000Z' },
  { id: ACME_ID, type: 'Organization', label: 'Acme Corp', aliases: ['Acme'], mentionCount: 22, lastSeenAt: '2026-09-20T15:00:00.000Z' },
  { id: ANA_ID, type: 'Person', label: 'Ana Diaz', aliases: [], mentionCount: 9, lastSeenAt: '2026-09-18T10:00:00.000Z' },
  { id: GLOBEX_ID, type: 'Organization', label: 'Globex', aliases: ['Globex Corporation'], mentionCount: 4, lastSeenAt: '2026-09-02T09:00:00.000Z' },
  { id: BEN_ID, type: 'Person', label: 'Ben Okafor', aliases: [], mentionCount: 6, lastSeenAt: '2026-08-30T09:00:00.000Z' },
  { id: INITECH_ID, type: 'Organization', label: 'Initech', aliases: [], mentionCount: 2, lastSeenAt: null },
  { id: CARLA_ID, type: 'Person', label: 'Carla Mendes', aliases: ['Carla'], mentionCount: 3, lastSeenAt: '2026-07-11T09:00:00.000Z' },
  { id: DANA_ID, type: 'Person', label: 'Dana Li', aliases: [], mentionCount: 1, lastSeenAt: null },
  { id: ATLAS_ID, type: 'Project', label: 'Project Atlas', aliases: ['Atlas'], mentionCount: 11, lastSeenAt: '2026-09-20T15:00:00.000Z' },
  { id: BEACON_ID, type: 'Project', label: 'Project Beacon', aliases: [], mentionCount: 2, lastSeenAt: '2026-06-01T09:00:00.000Z' },
  { id: Q3_MEETING_ID, type: 'Meeting', label: 'Q3 planning', aliases: [], mentionCount: 1, lastSeenAt: '2026-09-20T15:00:00.000Z' },
  { id: SYNC_MEETING_ID, type: 'Meeting', label: 'Weekly sync', aliases: [], mentionCount: 1, lastSeenAt: '2026-09-13T15:00:00.000Z' },
];

export function summaryFor(id: string): GraphEntitySummary {
  const found = graphEntitySummaries.find((row) => row.id === id);
  if (!found) throw new Error(`no fixture entity ${id}`);
  return found;
}

export function entityDetail(
  id: string,
  overrides: Partial<GraphEntityDetail> = {},
): GraphEntityDetail {
  const summary = summaryFor(id);
  return {
    id,
    type: summary.type,
    label: summary.label,
    props: summary.type === 'Person' ? { title: 'VP Engineering' } : {},
    aliases: summary.aliases.map((alias, index) => ({
      id: gid(500 + index + Number(id.slice(-3)) * 10),
      alias,
      source: 'extraction',
    })),
    occurredAt: summary.type === 'Meeting' ? summary.lastSeenAt : null,
    reviewStatus: 'accepted',
    ontologyVersion: graphOntologyFixture.version,
    firstSeenAt: '2026-03-04T09:00:00.000Z',
    lastSeenAt: summary.lastSeenAt,
    counts: {
      relations: 5,
      mentions: summary.mentionCount,
      evidence: 18,
      items: { commitment: 3, decision: 2, claim: 1, person_fact: 2 },
      openCommitments: 2,
    },
    createdAt: '2026-03-04T09:00:00.000Z',
    updatedAt: '2026-09-20T15:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const EV_SEGMENT = gid(701);
export const EV_NOTE = gid(702);
export const EV_GONE = gid(703);
export const EV_EDITED = gid(704);

export const evidenceFixtures: EvidenceLink[] = [
  {
    id: EV_SEGMENT,
    subjectKind: 'item',
    subjectId: gid(301),
    quote: 'We will ship the Atlas beta by the end of October.',
    createdAt: '2026-09-20T16:00:00.000Z',
    source: {
      kind: 'segment',
      transcriptId: TRANSCRIPT_ID,
      transcriptTitle: 'Q3 planning call',
      segmentId: SEGMENT_ID,
      segmentRev: 1,
      currentSegmentRev: 1,
      startMs: 754_000,
      endMs: 760_000,
      textChanged: false,
      available: true,
      href: `/transcripts/${TRANSCRIPT_ID}?segment=${SEGMENT_ID}&t=754000`,
    },
  },
  {
    id: EV_NOTE,
    subjectKind: 'relation',
    subjectId: gid(401),
    quote: 'Joe now leads the platform group.',
    createdAt: '2026-09-20T16:00:00.000Z',
    source: {
      kind: 'note',
      noteId: NOTE_ID,
      noteTitle: 'Q3 planning — decisions',
      noteVersion: 2,
      currentNoteVersion: 3,
      charStart: 10,
      charEnd: 42,
      versionChanged: true,
      available: true,
      href: `/notes/${NOTE_ID}?v=2`,
    },
  },
  {
    id: EV_GONE,
    subjectKind: 'item',
    subjectId: gid(302),
    quote: 'Budget is frozen until Q4.',
    createdAt: '2026-08-01T16:00:00.000Z',
    source: {
      kind: 'segment',
      transcriptId: null,
      transcriptTitle: null,
      segmentId: null,
      segmentRev: null,
      currentSegmentRev: null,
      startMs: null,
      endMs: null,
      textChanged: false,
      available: false,
      href: null,
    },
  },
  {
    id: EV_EDITED,
    subjectKind: 'item',
    subjectId: gid(303),
    quote: 'Ana will review the hiring plan.',
    createdAt: '2026-09-13T16:00:00.000Z',
    source: {
      kind: 'segment',
      transcriptId: TRANSCRIPT_ID,
      transcriptTitle: 'Q3 planning call',
      segmentId: gid(902),
      segmentRev: 1,
      currentSegmentRev: 2,
      startMs: 65_000,
      endMs: 70_000,
      textChanged: true,
      available: true,
      href: `/transcripts/${TRANSCRIPT_ID}?segment=${gid(902)}&t=65000`,
    },
  },
];

// ---------------------------------------------------------------------------
// Brief (#372)
// ---------------------------------------------------------------------------

const joeRef = { id: JOE_ID, label: 'Joe Rivera', type: 'Person' };
const anaRef = { id: ANA_ID, label: 'Ana Diaz', type: 'Person' };
const acmeRef = { id: ACME_ID, label: 'Acme Corp', type: 'Organization' };

export function briefFixture(overrides: Partial<EntityBrief> = {}): EntityBrief {
  return {
    entity: joeRef,
    window: {
      since: '2026-09-01T00:00:00.000Z',
      sinceSource: 'last_viewed',
      asOf: '2026-09-26T00:00:00.000Z',
      lastViewedAt: '2026-09-01T00:00:00.000Z',
    },
    digest: {
      statements: [
        { text: 'Joe was promoted to VP Engineering in September.', evidenceIds: [EV_NOTE] },
        { text: 'He committed to ship the Atlas beta by the end of October.', evidenceIds: [EV_SEGMENT, EV_EDITED] },
      ],
      coversUntil: '2026-09-20T15:00:00.000Z',
      generatedAt: '2026-09-21T08:00:00.000Z',
      model: 'gpt-4o-mini',
    },
    digestStale: false,
    digestPending: false,
    digestUnavailable: null,
    sections: {
      whatChanged: [
        {
          itemId: gid(301),
          kind: 'commitment',
          title: 'Ship the Atlas beta',
          statement: 'Joe will ship the Atlas beta by the end of October.',
          occurredAt: '2026-09-20T15:00:00.000Z',
          precision: 'day',
          status: 'open',
          dueAt: '2026-10-31T00:00:00.000Z',
          ownerPerson: joeRef,
          counterparty: anaRef,
          superseded: false,
          evidenceIds: [EV_SEGMENT],
        },
      ],
      decisions: [
        {
          itemId: gid(310),
          kind: 'decision',
          title: 'Move Atlas to the new cluster',
          statement: 'Atlas moves to the new cluster in Q4.',
          occurredAt: '2026-09-13T15:00:00.000Z',
          precision: 'day',
          status: null,
          dueAt: null,
          ownerPerson: null,
          counterparty: null,
          superseded: false,
          evidenceIds: [EV_EDITED],
        },
        {
          itemId: gid(311),
          kind: 'decision',
          title: 'Keep Atlas on the old cluster',
          statement: 'Atlas stays on the old cluster.',
          occurredAt: '2026-06-01T15:00:00.000Z',
          precision: 'month',
          status: null,
          dueAt: null,
          ownerPerson: null,
          counterparty: null,
          superseded: true,
          evidenceIds: [EV_GONE],
        },
      ],
      openCommitments: {
        theirs: [
          {
            itemId: gid(301),
            kind: 'commitment',
            title: 'Ship the Atlas beta',
            statement: 'Joe will ship the Atlas beta by the end of October.',
            occurredAt: '2026-09-20T15:00:00.000Z',
            precision: 'day',
            status: 'open',
            dueAt: '2026-10-31T00:00:00.000Z',
            ownerPerson: joeRef,
            counterparty: anaRef,
            superseded: false,
            evidenceIds: [EV_SEGMENT],
          },
        ],
        yours: [
          {
            itemId: gid(320),
            kind: 'commitment',
            title: 'Send Joe the hiring plan',
            statement: 'Ana will send Joe the hiring plan.',
            occurredAt: '2026-09-13T15:00:00.000Z',
            precision: 'day',
            status: 'open',
            dueAt: null,
            ownerPerson: anaRef,
            counterparty: joeRef,
            superseded: false,
            evidenceIds: [EV_EDITED],
          },
        ],
      },
      risksClaims: [
        {
          itemId: gid(330),
          kind: 'claim',
          title: null,
          statement: 'Joe thinks the beta date is at risk if hiring slips.',
          occurredAt: '2026-09-20T15:00:00.000Z',
          precision: 'day',
          status: null,
          dueAt: null,
          ownerPerson: null,
          counterparty: null,
          superseded: false,
          evidenceIds: [EV_SEGMENT],
        },
      ],
      peopleChanges: [
        {
          relationId: gid(401),
          type: 'HAS_ROLE',
          change: 'ended',
          at: '2026-09-01T00:00:00.000Z',
          precision: 'month',
          person: joeRef,
          other: acmeRef,
          title: 'Director of Engineering',
          evidenceIds: [EV_NOTE],
        },
        {
          relationId: gid(402),
          type: 'HAS_ROLE',
          change: 'started',
          at: '2026-09-01T00:00:00.000Z',
          precision: 'month',
          person: joeRef,
          other: acmeRef,
          title: 'VP Engineering',
          evidenceIds: [EV_NOTE],
        },
      ],
    },
    related: [
      {
        kind: 'transcript',
        id: TRANSCRIPT_ID,
        title: 'Q3 planning call',
        snippetHtml: 'We will ship the <mark>Atlas</mark> beta &amp; review hiring',
        startMs: 754_000,
        score: 0.82,
        inGraph: true,
        occurredAt: '2026-09-20T15:00:00.000Z',
      },
      {
        kind: 'note',
        id: NOTE_ID,
        title: 'Q3 planning — decisions',
        snippetHtml: '<mark>Joe</mark> now leads the platform group',
        startMs: null,
        score: 0.61,
        inGraph: false,
        occurredAt: null,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Neighbourhood (#370)
// ---------------------------------------------------------------------------

export function neighborhoodFixture(overrides: Partial<GraphSlice> = {}): GraphSlice {
  const node = (id: string, depth: number) => {
    const s = summaryFor(id);
    return {
      id,
      nodeKind: 'entity' as const,
      type: s.type,
      label: s.label,
      depth,
      degree: 3,
      status: null,
      occurredAt: s.type === 'Meeting' ? s.lastSeenAt : null,
    };
  };
  return {
    seedIds: [JOE_ID],
    asOf: '2026-09-26T00:00:00.000Z',
    nodes: [
      node(JOE_ID, 0),
      node(ACME_ID, 1),
      node(ANA_ID, 1),
      node(Q3_MEETING_ID, 1),
      node(SYNC_MEETING_ID, 1),
      {
        id: gid(301),
        nodeKind: 'item',
        type: 'commitment',
        label: 'Ship the Atlas beta',
        depth: 1,
        degree: 2,
        status: 'open',
        occurredAt: '2026-09-20T15:00:00.000Z',
      },
    ],
    edges: [
      { id: gid(410), type: 'WORKS_FOR', source: JOE_ID, target: ACME_ID, valid: null, confidence: 0.94, virtual: false },
      { id: gid(411), type: 'REPORTS_TO', source: JOE_ID, target: ANA_ID, valid: { from: '2026-09-01T00:00:00.000Z', to: null, precision: 'month' }, confidence: 0.9, virtual: false },
      { id: gid(412), type: 'ATTENDED', source: JOE_ID, target: Q3_MEETING_ID, valid: null, confidence: null, virtual: false },
      { id: gid(413), type: 'ATTENDED', source: JOE_ID, target: SYNC_MEETING_ID, valid: null, confidence: null, virtual: false },
      { id: `virt:${gid(301)}:ASSIGNED_TO`, type: 'ASSIGNED_TO', source: gid(301), target: JOE_ID, valid: null, confidence: null, virtual: true },
    ],
    truncated: false,
    cap: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Timeline (#370)
// ---------------------------------------------------------------------------

export const SENSITIVE_FACT_STATEMENT = 'Joe is recovering from knee surgery.';

export function timelineFixture(includeSensitive = false): TimelineEvent[] {
  const events: TimelineEvent[] = [
    {
      id: gid(301),
      eventKind: 'item',
      at: '2026-09-20T15:00:00.000Z',
      precision: 'day',
      item: {
        id: gid(301),
        kind: 'commitment',
        title: 'Ship the Atlas beta',
        statement: 'Joe will ship the Atlas beta by the end of October.',
        status: 'open',
        dueAt: '2026-10-31T00:00:00.000Z',
        ownerPerson: joeRef,
        counterparty: anaRef,
        sensitivity: null,
        superseded: false,
        supersededById: null,
      },
      evidenceIds: [EV_SEGMENT],
      evidenceCount: 1,
    },
    {
      id: `rel:${gid(402)}:start`,
      eventKind: 'relation_started',
      at: '2026-09-01T00:00:00.000Z',
      precision: 'month',
      relation: {
        id: gid(402),
        type: 'HAS_ROLE',
        direction: 'out',
        other: acmeRef,
        valid: { from: '2026-09-01T00:00:00.000Z', to: null, precision: 'month' },
      },
      evidenceIds: [EV_NOTE],
      evidenceCount: 1,
    },
    {
      id: `rel:${gid(401)}:end`,
      eventKind: 'relation_ended',
      at: '2026-09-01T00:00:00.000Z',
      precision: 'month',
      relation: {
        id: gid(401),
        type: 'HAS_ROLE',
        direction: 'out',
        other: acmeRef,
        valid: { from: '2024-01-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z', precision: 'month' },
      },
      evidenceIds: [EV_NOTE],
      evidenceCount: 1,
    },
    {
      id: gid(311),
      eventKind: 'item',
      at: '2026-06-01T15:00:00.000Z',
      precision: 'month',
      item: {
        id: gid(311),
        kind: 'decision',
        title: 'Keep Atlas on the old cluster',
        statement: 'Atlas stays on the old cluster.',
        status: null,
        dueAt: null,
        ownerPerson: null,
        counterparty: null,
        sensitivity: null,
        superseded: true,
        supersededById: gid(310),
      },
      evidenceIds: [EV_GONE],
      evidenceCount: 1,
    },
    {
      id: Q3_MEETING_ID,
      eventKind: 'meeting',
      at: '2025-01-01T00:00:00.000Z',
      precision: 'year',
      meeting: { id: Q3_MEETING_ID, label: 'Q3 planning', type: 'Meeting' },
      evidenceIds: [],
      evidenceCount: 0,
    },
  ];
  if (includeSensitive) {
    events.splice(1, 0, {
      id: gid(340),
      eventKind: 'item',
      at: '2026-09-15T00:00:00.000Z',
      precision: 'day',
      item: {
        id: gid(340),
        kind: 'person_fact',
        title: null,
        statement: SENSITIVE_FACT_STATEMENT,
        status: null,
        dueAt: null,
        ownerPerson: null,
        counterparty: null,
        sensitivity: 'sensitive',
        superseded: false,
        supersededById: null,
      },
      evidenceIds: [EV_SEGMENT],
      evidenceCount: 1,
    });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Mentions (#370)
// ---------------------------------------------------------------------------

export const mentionFixtures: EntityMention[] = [
  { kind: 'transcript', id: TRANSCRIPT_ID, title: 'Q3 planning call', occurredAt: '2026-09-20T15:00:00.000Z', available: true },
  { kind: 'note', id: NOTE_ID, title: 'Q3 planning — decisions', occurredAt: '2026-09-20T16:00:00.000Z', available: true },
  { kind: 'transcript', id: gid(990), title: null, occurredAt: '2026-05-01T10:00:00.000Z', available: false },
];

// =============================================================================
// Proposal fixtures (#367) — shaped exactly like #366's Contract
// =============================================================================
//
// One draft covering every group and every row treatment the review sheet
// draws: a linked row ≥ 0.9, an uncertain row, a `known` (collapsed) row, a
// sensitive person fact, a closing that affects commitments, a user-added row,
// stale segment evidence, and a relation blocked by a pending endpoint. Plus
// an extracting, a failed and a committed proposal.
//
// `proposalMock` is a tiny in-memory stand-in for #366 so the default MSW
// handlers answer every endpoint the way the Contract says; tests reset it
// and read `proposalMock.requests` to assert exact request bodies.


export const PROPOSAL_ID = 'a0000000-0000-4000-8000-000000000001';
export const PROPOSAL_NOTE_ID = 'n1';
export const PROPOSAL_TRANSCRIPT_ID = 't1';
const FIXED = '2026-09-20T10:00:00.000Z';

export const EXISTING_SARAH_ID = 'b0000000-0000-4000-8000-000000000001';
export const EXISTING_TOM_ID = 'b0000000-0000-4000-8000-000000000002';
export const EXISTING_ANA_ID = 'b0000000-0000-4000-8000-000000000003';

export const ITEM = {
  sarah: 'c0000000-0000-4000-8000-000000000001',
  tom: 'c0000000-0000-4000-8000-000000000002',
  northwind: 'c0000000-0000-4000-8000-000000000003',
  atlas: 'c0000000-0000-4000-8000-000000000004',
  meeting: 'c0000000-0000-4000-8000-000000000005',
  ana: 'c0000000-0000-4000-8000-000000000006',
  contoso: 'c0000000-0000-4000-8000-000000000007',
  decision: 'c0000000-0000-4000-8000-000000000008',
  commitment: 'c0000000-0000-4000-8000-000000000009',
  claim: 'c0000000-0000-4000-8000-00000000000a',
  personFact: 'c0000000-0000-4000-8000-00000000000b',
  other: 'c0000000-0000-4000-8000-00000000000c',
  worksFor: 'c0000000-0000-4000-8000-00000000000d',
  tomWorksFor: 'c0000000-0000-4000-8000-00000000000e',
  closing: 'c0000000-0000-4000-8000-00000000000f',
} as const;

let evidenceSeq = 0;

export function segmentEvidence(overrides: Partial<ProposalEvidence> = {}): ProposalEvidence {
  evidenceSeq += 1;
  return {
    id: `d0000000-0000-4000-8000-${String(evidenceSeq).padStart(12, '0')}`,
    source: 'segment',
    transcriptId: PROPOSAL_TRANSCRIPT_ID,
    segmentId: 'seg-4',
    segmentRev: 1,
    startMs: 65_000,
    endMs: 72_000,
    noteId: null,
    noteVersion: null,
    charStart: null,
    charEnd: null,
    quote: 'Sarah from Northwind will lead the Atlas migration.',
    speakerName: 'Oscar',
    stale: false,
    ...overrides,
  };
}

export function noteEvidence(overrides: Partial<ProposalEvidence> = {}): ProposalEvidence {
  evidenceSeq += 1;
  return {
    id: `d0000000-0000-4000-8000-${String(evidenceSeq).padStart(12, '0')}`,
    source: 'note',
    transcriptId: null,
    segmentId: null,
    segmentRev: null,
    startMs: null,
    endMs: null,
    noteId: PROPOSAL_NOTE_ID,
    noteVersion: 3,
    charStart: 10,
    charEnd: 42,
    quote: 'ship the storage migration behind a flag',
    speakerName: null,
    stale: false,
    ...overrides,
  };
}

function entityPayload(ref: string, type: string, label: string, props: Record<string, unknown> = {}) {
  return { ref, type, label, aliases: [], props, occurredAt: null };
}

function itemPayload(
  ref: string,
  kind: 'commitment' | 'decision' | 'claim' | 'person_fact',
  title: string,
  statement: string,
  extra: Record<string, unknown> = {},
) {
  return {
    ref,
    kind,
    title,
    statement,
    subject: null as EndpointRef | null,
    owner: null as EndpointRef | null,
    counterparty: null as EndpointRef | null,
    meeting: null as EndpointRef | null,
    status: null,
    occurredAt: null,
    dueAt: null,
    sensitivity: null,
    statementHash: `hash-${ref}`,
    props: {},
    validFrom: null,
    validTo: null,
    precision: 'unknown',
    ...extra,
  };
}

export function proposalItem(overrides: Partial<ProposalItem> & { id: string }): ProposalItem {
  const payload = overrides.payload ?? entityPayload('e0', 'Person', 'Someone');
  return {
    kind: 'entity',
    origin: 'ai',
    groupKey: 'Person',
    decision: 'accept',
    payload,
    editedPayload: null,
    effectivePayload: overrides.editedPayload ?? payload,
    display: { title: String(payload.label ?? payload.title ?? 'Row'), subtitle: null },
    resolution: null,
    mergeIntoId: null,
    distinctFrom: [],
    flags: [],
    prechecked: true,
    evidence: [segmentEvidence()],
    committedRefId: null,
    ...overrides,
  };
}

function resolution(overrides: Partial<NonNullable<ProposalItem['resolution']>> = {}) {
  return {
    ref: null,
    score: null,
    source: null,
    candidates: [],
    adjudication: null,
    refLabel: null,
    ...overrides,
  };
}

/** Every row of the fixture draft, in #366's order (group order, then title). */
export function draftItems(): ProposalItem[] {
  evidenceSeq = 0;
  return [
    proposalItem({
      id: ITEM.sarah,
      payload: entityPayload('e1', 'Person', 'Sarah Chen', { title: 'Head of Platform' }),
      display: { title: 'Sarah Chen', subtitle: 'Person' },
      resolution: resolution({
        ref: EXISTING_SARAH_ID,
        score: 0.94,
        source: 'alias',
        candidates: [
          { entityId: EXISTING_SARAH_ID, label: 'Sarah Chen', type: 'Person', score: 0.94, signals: ['alias'] },
        ],
        refLabel: 'Sarah Chen',
      }),
      evidence: [segmentEvidence({ startMs: 65_000 })],
    }),
    proposalItem({
      id: ITEM.tom,
      decision: 'pending',
      prechecked: false,
      payload: entityPayload('e2', 'Person', 'Tom'),
      display: { title: 'Tom', subtitle: 'Person' },
      flags: ['possible_duplicate'],
      resolution: resolution({
        candidates: [
          { entityId: EXISTING_TOM_ID, label: 'Tom Baker', type: 'Person', score: 0.71, signals: ['trigram'] },
        ],
        refLabel: 'Tom Baker',
      }),
      evidence: [
        segmentEvidence({
          segmentId: 'seg-7',
          startMs: 130_000,
          quote: 'Tom said he would check with legal.',
          stale: true,
        }),
      ],
    }),
    proposalItem({
      id: ITEM.ana,
      payload: entityPayload('k1', 'Person', 'Ana Ruiz'),
      display: { title: 'Ana Ruiz', subtitle: 'Person' },
      flags: ['known'],
      resolution: resolution({ ref: EXISTING_ANA_ID, score: 1, source: 'speaker', refLabel: 'Ana Ruiz' }),
    }),
    proposalItem({
      id: ITEM.northwind,
      groupKey: 'Organization',
      payload: entityPayload('e3', 'Organization', 'Northwind Robotics'),
      display: { title: 'Northwind Robotics', subtitle: 'Organization' },
    }),
    proposalItem({
      id: ITEM.contoso,
      groupKey: 'Organization',
      origin: 'user',
      payload: entityPayload('u1', 'Organization', 'Contoso'),
      display: { title: 'Contoso', subtitle: 'Organization' },
      evidence: [noteEvidence({ quote: 'Contoso' })],
    }),
    proposalItem({
      id: ITEM.atlas,
      groupKey: 'Project',
      payload: entityPayload('e4', 'Project', 'Atlas migration'),
      display: { title: 'Atlas migration', subtitle: 'Project' },
    }),
    proposalItem({
      id: ITEM.meeting,
      groupKey: 'Meeting',
      payload: { ...entityPayload('meeting', 'Meeting', 'Weekly sync'), occurredAt: '2026-09-18' },
      display: { title: 'Weekly sync', subtitle: 'Meeting · 18 Sep 2026' },
    }),
    proposalItem({
      id: ITEM.decision,
      kind: 'item',
      groupKey: 'Decision',
      payload: itemPayload('i1', 'decision', 'Ship behind a flag', 'The team will ship behind a flag.', {
        meeting: { ref: 'meeting' },
      }),
      display: { title: 'Ship behind a flag', subtitle: 'Decision' },
      evidence: [noteEvidence()],
    }),
    proposalItem({
      id: ITEM.commitment,
      kind: 'item',
      groupKey: 'Commitment',
      payload: itemPayload('i2', 'commitment', 'Write the rollback plan', 'Sarah will write the rollback plan.', {
        owner: { ref: 'e1' },
        meeting: { ref: 'meeting' },
        status: 'open',
        dueAt: '2026-10-01',
      }),
      display: { title: 'Write the rollback plan', subtitle: 'Commitment · Sarah Chen · due 1 Oct 2026' },
    }),
    proposalItem({
      id: ITEM.claim,
      kind: 'item',
      groupKey: 'Claim',
      payload: itemPayload('i3', 'claim', 'Northwind is hiring', 'Northwind is hiring engineers.', {
        subject: { ref: 'e3' },
      }),
      display: { title: 'Northwind is hiring', subtitle: 'Claim' },
    }),
    proposalItem({
      id: ITEM.personFact,
      kind: 'item',
      groupKey: 'PersonFact',
      decision: 'pending',
      prechecked: false,
      flags: ['sensitive'],
      payload: itemPayload('i4', 'person_fact', 'On medical leave', 'Sarah is on medical leave until May.', {
        subject: { ref: 'e1' },
        sensitivity: 'sensitive',
      }),
      display: { title: 'On medical leave', subtitle: 'Person fact · Sarah Chen' },
    }),
    proposalItem({
      id: ITEM.other,
      groupKey: 'Other',
      decision: 'pending',
      prechecked: false,
      payload: entityPayload('e6', 'Place', 'Lisbon office'),
      display: { title: 'Lisbon office', subtitle: 'Place' },
    }),
    proposalItem({
      id: ITEM.worksFor,
      kind: 'relation',
      groupKey: 'relations',
      payload: {
        ref: 'r1',
        type: 'WORKS_FOR',
        from: { ref: 'e1' },
        to: { ref: 'e3' },
        validFrom: '2026-01-01',
        validTo: null,
        precision: 'month',
        props: {},
      },
      display: { title: 'Sarah Chen → works for → Northwind Robotics', subtitle: 'since Jan 2026' },
    }),
    proposalItem({
      id: ITEM.tomWorksFor,
      kind: 'relation',
      groupKey: 'relations',
      decision: 'pending',
      prechecked: false,
      payload: {
        ref: 'r2',
        type: 'WORKS_FOR',
        from: { ref: 'e2' },
        to: { ref: 'e3' },
        validFrom: null,
        validTo: null,
        precision: 'unknown',
        props: {},
      },
      display: { title: 'Tom → works for → Northwind Robotics', subtitle: null },
    }),
    proposalItem({
      id: ITEM.closing,
      kind: 'closing',
      groupKey: 'closings',
      decision: 'pending',
      prechecked: false,
      flags: ['closing_affects_commitments'],
      payload: { relationId: 'b1000000-0000-4000-8000-000000000001', validTo: '2026-09-18' },
      display: { title: 'Closes: Sarah Chen → works for → Acme', subtitle: 'ended Sep 2026' },
    }),
  ];
}

const CHECKED: ProposalDecision[] = ['accept', 'edit', 'merge_into'];

export function countsFor(items: readonly ProposalItem[]): ProposalCounts {
  const byGroup: Partial<Record<ProposalGroupKey, number>> = {};
  let pending = 0;
  let accepted = 0;
  let rejected = 0;
  let known = 0;
  for (const item of items) {
    byGroup[item.groupKey] = (byGroup[item.groupKey] ?? 0) + 1;
    if (item.flags.includes('known')) known += 1;
    if (item.decision === 'pending') pending += 1;
    else if (item.decision === 'reject') rejected += 1;
    else if (CHECKED.includes(item.decision)) accepted += 1;
  }
  return { total: items.length, pending, accepted, rejected, known, byGroup };
}

export function proposalSummary(
  items: readonly ProposalItem[],
  overrides: Partial<ProposalSummary> = {},
): ProposalSummary {
  return {
    id: PROPOSAL_ID,
    kind: 'extraction',
    status: 'draft',
    noteId: PROPOSAL_NOTE_ID,
    noteTitle: 'Weekly sync — minutes',
    noteVersion: 3,
    noteCurrentVersion: 3,
    model: 'gpt-4o-mini',
    providerId: 'openai',
    userGuidance: null,
    counts: countsFor(items),
    stats: {},
    failure: null,
    createdAt: FIXED,
    committedAt: null,
    revertedAt: null,
    ...overrides,
  };
}

export type ProposalFixtureState = 'draft' | 'extracting' | 'failed' | 'committed' | 'reverted' | 'stale';

/** A detail in one of the States-table states. */
export function mockProposalDetail(
  state: ProposalFixtureState = 'draft',
  items: ProposalItem[] = state === 'extracting' || state === 'failed' ? [] : draftItems(),
): ProposalDetail {
  const status: ProposalStatus = state === 'stale' ? 'draft' : state;
  const overrides: Partial<ProposalSummary> = { status };
  if (state === 'failed') {
    overrides.failure = { errorClass: 'invalid_output', message: 'The model returned something unreadable.' };
  }
  if (state === 'committed') overrides.committedAt = FIXED;
  if (state === 'reverted') {
    overrides.committedAt = FIXED;
    overrides.revertedAt = FIXED;
  }
  if (state === 'stale') overrides.noteCurrentVersion = 4;
  return { proposal: proposalSummary(items, overrides), items, context: null };
}

export const mockEntitySearchResults: GraphEntitySearchResult[] = [
  { id: EXISTING_TOM_ID, type: 'Person', label: 'Tom Baker', aliases: ['Tommy'] },
  { id: EXISTING_SARAH_ID, type: 'Person', label: 'Sarah Chen', aliases: [] },
];

export interface RecordedGraphRequest {
  method: string;
  path: string;
  body: unknown;
}

/** In-memory #366 for the default MSW handlers. */
export const proposalMock = {
  detail: null as ProposalDetail | null,
  requests: [] as RecordedGraphRequest[],
  /** Rows a revert would have to keep; non-empty makes an unconfirmed revert 409. */
  revertConflicts: [] as RevertKept[],
  context: { systemPrompt: 'You extract a knowledge graph.', userContent: 'Note body…' },
  reset(detail: ProposalDetail | null = null) {
    this.detail = detail;
    this.requests = [];
    this.revertConflicts = [];
  },
};

export function emptyCommitResult(overrides: Partial<CommitResult> = {}): CommitResult {
  return {
    created: { entities: 0, relations: 0, items: 0 },
    linked: 0,
    evidenceAdded: 0,
    closingsApplied: 0,
    closingsSkipped: 0,
    superseded: 0,
    aliasesAdded: 0,
    distinctPairsRecorded: 0,
    skippedPending: 0,
    ...overrides,
  };
}

// =============================================================================
// #368 — guide the graph, add from a selection, Home "Waiting for review"
// =============================================================================

/** `GET /api/ai/config` with the graph on and three models, one without structured output. */
export function mockGraphAiConfig(overrides: Record<string, unknown> = {}) {
  const model = (id: string, label: string, structuredOutput: boolean) => ({
    id,
    label,
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_000,
    source: 'catalogue',
    derivedFrom: null,
    structuredOutput,
    toolCalling: structuredOutput,
  });
  const task = (taskModel: string | null) => ({
    model: taskModel,
    source: taskModel ? 'task' : 'none',
    reasoningEffort: 'medium',
    requires: ['structuredOutput'],
    usable: taskModel !== null,
    reason: taskModel ? null : 'no_model',
  });
  return {
    available: true,
    provider: 'openai',
    providerLabel: 'OpenAI',
    models: [
      model('gpt-4o-mini', 'GPT-4o mini', true),
      model('gpt-4.1', 'GPT-4.1', true),
      model('legacy-text', 'Legacy text model', false),
    ],
    defaultModel: 'gpt-4o-mini',
    maxInputTokens: 100_000,
    maxOutputTokens: 8_000,
    keyConfigured: true,
    graphEnabled: true,
    taskModels: {
      'graph.extract': task('gpt-4.1'),
      'graph.adjudicate': task('gpt-4o-mini'),
      'graph.digest': task('gpt-4o-mini'),
      'graph.agent': task('gpt-4o-mini'),
    },
    ...overrides,
  };
}

/** `GET /api/graph/extract/estimate`'s answer. */
export function mockExtractEstimate(
  overrides: Partial<import('../../services/graph').ExtractionEstimate> = {},
): import('../../services/graph').ExtractionEstimate {
  return {
    providerId: 'openai',
    model: 'gpt-4.1',
    inputTokens: 4_200,
    maxOutputTokens: 8_000,
    availableInputTokens: 100_000,
    fits: true,
    requests: 1,
    keyConfigured: true,
    ...overrides,
  };
}

/** One row of `GET /api/graph/proposals` (a `ProposalSummary`). */
export function proposalSummaryRow(
  id: string,
  overrides: Partial<ProposalSummary> = {},
): ProposalSummary {
  return proposalSummary(draftItems(), { id, ...overrides });
}

// ---------------------------------------------------------------------------
// Explorer (#374) — a small, fixed graph `POST /api/graph/explore/expand`
// walks one hop over, honouring `types`, `relationTypes`, `as_of` and `cap`
// the way #370's service does. Joe's manager CHANGES on 2026-09-01: Ben
// before, Ana after — the `as_of` fixture the explorer tests read.
// ---------------------------------------------------------------------------

export const ATLAS_COMMITMENT_ID = gid(301);
export const Q3_DECISION_ID = gid(302);
export const EXPLORER_DEFAULT_AS_OF = '2026-09-26';
/** The day Joe's REPORTS_TO moved from Ben to Ana. */
export const MANAGER_CHANGE_DATE = '2026-09-01';

interface ExplorerFixtureNode {
  id: string;
  nodeKind: 'entity' | 'item';
  type: string;
  label: string;
  status: string | null;
  occurredAt: string | null;
}

const explorerItems: ExplorerFixtureNode[] = [
  { id: ATLAS_COMMITMENT_ID, nodeKind: 'item', type: 'commitment', label: 'Ship the Atlas beta', status: 'open', occurredAt: '2026-09-20T15:00:00.000Z' },
  { id: Q3_DECISION_ID, nodeKind: 'item', type: 'decision', label: 'Move Atlas to the new cluster', status: null, occurredAt: '2026-09-20T15:00:00.000Z' },
];

export const explorerFixtureNodes: ExplorerFixtureNode[] = [
  ...graphEntitySummaries.map((s) => ({
    id: s.id,
    nodeKind: 'entity' as const,
    type: s.type,
    label: s.label,
    status: null,
    occurredAt: s.type === 'Meeting' ? s.lastSeenAt : null,
  })),
  ...explorerItems,
];

const edge = (
  n: number,
  type: string,
  source: string,
  target: string,
  valid: GraphEdge['valid'] = null,
): GraphEdge => ({ id: gid(n), type, source, target, valid, confidence: 0.9, virtual: false });

export const explorerFixtureEdges: GraphEdge[] = [
  edge(410, 'WORKS_FOR', JOE_ID, ACME_ID),
  edge(411, 'REPORTS_TO', JOE_ID, ANA_ID, { from: '2026-09-01T00:00:00.000Z', to: null, precision: 'month' }),
  edge(414, 'REPORTS_TO', JOE_ID, BEN_ID, { from: '2026-03-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z', precision: 'month' }),
  edge(412, 'ATTENDED', JOE_ID, Q3_MEETING_ID),
  edge(413, 'ATTENDED', JOE_ID, SYNC_MEETING_ID),
  { id: `virt:${ATLAS_COMMITMENT_ID}:ASSIGNED_TO`, type: 'ASSIGNED_TO', source: ATLAS_COMMITMENT_ID, target: JOE_ID, valid: null, confidence: null, virtual: true },
  edge(415, 'WORKS_FOR', ANA_ID, ACME_ID),
  edge(416, 'ATTENDED', ANA_ID, Q3_MEETING_ID),
  edge(417, 'WORKS_FOR', BEN_ID, GLOBEX_ID),
  edge(418, 'WORKS_FOR', CARLA_ID, INITECH_ID),
  edge(419, 'ATTENDED', CARLA_ID, SYNC_MEETING_ID),
  edge(420, 'WORKS_FOR', DANA_ID, ACME_ID),
  edge(421, 'PART_OF', ATLAS_ID, ACME_ID),
  edge(422, 'PART_OF', BEACON_ID, GLOBEX_ID),
  { id: `virt:${Q3_DECISION_ID}:DECIDED_IN`, type: 'DECIDED_IN', source: Q3_DECISION_ID, target: Q3_MEETING_ID, valid: null, confidence: null, virtual: true },
];

function validAt(e: GraphEdge, asOf: string): boolean {
  if (!e.valid) return true;
  const at = Date.parse(asOf.length === 10 ? `${asOf}T00:00:00Z` : asOf);
  if (e.valid.from && Date.parse(e.valid.from) > at) return false;
  if (e.valid.to && Date.parse(e.valid.to) <= at) return false;
  return true;
}

export interface ExpandFixtureRequest {
  nodeIds: string[];
  types?: string[];
  relationTypes?: string[];
  as_of?: string;
  cap?: number;
}

/**
 * One hop from every seed, as #370 answers it — or `null` when any seed is
 * unknown (the handler turns that into the all-or-nothing 404).
 */
export function expandFixture(req: ExpandFixtureRequest): GraphSlice | null {
  const asOf = req.as_of ?? EXPLORER_DEFAULT_AS_OF;
  const cap = req.cap ?? 100;
  const byId = new Map(explorerFixtureNodes.map((n) => [n.id, n]));
  const seeds = [...new Set(req.nodeIds)];
  if (seeds.some((id) => !byId.has(id))) return null;

  const live = explorerFixtureEdges.filter((e) => validAt(e, asOf));
  const degree = new Map<string, number>();
  for (const e of live) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const walkable = live.filter((e) => !req.relationTypes || req.relationTypes.includes(e.type));
  const depth = new Map<string, number>(seeds.map((id) => [id, 0]));
  for (const e of walkable) {
    for (const [from, to] of [[e.source, e.target], [e.target, e.source]] as const) {
      if (!seeds.includes(from) || depth.has(to)) continue;
      const node = byId.get(to)!;
      if (req.types && !req.types.includes(node.type)) continue;
      depth.set(to, 1);
    }
  }
  const ordered = [...depth.keys()].sort((a, b) => {
    const da = depth.get(a)!;
    const db = depth.get(b)!;
    if (da !== db) return da - db;
    return (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : 1);
  });
  const kept = new Set(ordered.slice(0, cap));
  return {
    seedIds: seeds,
    asOf: `${asOf.slice(0, 10)}T00:00:00.000Z`,
    nodes: [...kept].map((id) => ({ ...byId.get(id)!, depth: depth.get(id)!, degree: degree.get(id) ?? 0 })),
    edges: walkable.filter((e) => kept.has(e.source) && kept.has(e.target)),
    truncated: ordered.length > cap,
    cap,
  };
}

/** A synthetic slice of `count` neighbours around `seedId` — for the 300-node cap. */
export function manyNodesSlice(seedId: string, count: number, offset = 5000): GraphSlice {
  const seed = explorerFixtureNodes.find((n) => n.id === seedId)!;
  const nodes: GraphSlice['nodes'] = [{ ...seed, depth: 0, degree: count }];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = gid(offset + i);
    nodes.push({ id, nodeKind: 'entity', type: 'Person', label: `Person ${i + 1}`, depth: 1, degree: 1 + (i % 7), status: null, occurredAt: null });
    edges.push({ id: gid(offset + 100_000 + i), type: 'WORKS_FOR', source: id, target: seedId, valid: null, confidence: 0.8, virtual: false });
  }
  return { seedIds: [seedId], asOf: '2026-09-26T00:00:00.000Z', nodes, edges, truncated: false, cap: 300 };
}

// ---------------------------------------------------------------------------
// Whole-graph overview (#375, against #371's `GET /api/graph/overview`)
// ---------------------------------------------------------------------------

export const LONE_ID = gid(20);
export const OVERVIEW_COMPUTED_AT = '2026-09-20T15:00:00.000Z';

/** Positioned nodes: three clusters around the fixture's entities, plus one isolated person. */
export const overviewNodes: GraphOverviewNode[] = [
  { id: ACME_ID, label: 'Acme Corp', type: 'Organization', x: -400, y: 120, clusterId: 0, degree: 5 },
  { id: JOE_ID, label: 'Joe Rivera', type: 'Person', x: -330, y: 60, clusterId: 0, degree: 5 },
  { id: ATLAS_ID, label: 'Project Atlas', type: 'Project', x: -470, y: 40, clusterId: 0, degree: 3 },
  { id: BEN_ID, label: 'Ben Okafor', type: 'Person', x: -350, y: 210, clusterId: 0, degree: 2 },
  { id: DANA_ID, label: 'Dana Li', type: 'Person', x: -460, y: 200, clusterId: 0, degree: 1 },
  { id: Q3_MEETING_ID, label: 'Q3 planning', type: 'Meeting', x: -300, y: 160, clusterId: 0, degree: 2 },
  { id: GLOBEX_ID, label: 'Globex', type: 'Organization', x: 380, y: -150, clusterId: 1, degree: 3 },
  { id: ANA_ID, label: 'Ana Diaz', type: 'Person', x: 440, y: -90, clusterId: 1, degree: 3 },
  { id: CARLA_ID, label: 'Carla Mendes', type: 'Person', x: 320, y: -210, clusterId: 1, degree: 2 },
  { id: SYNC_MEETING_ID, label: 'Weekly sync', type: 'Meeting', x: 450, y: -220, clusterId: 1, degree: 2 },
  { id: INITECH_ID, label: 'Initech', type: 'Organization', x: 150, y: 420, clusterId: 2, degree: 1 },
  { id: BEACON_ID, label: 'Project Beacon', type: 'Project', x: 210, y: 470, clusterId: 2, degree: 1 },
  { id: LONE_ID, label: 'Lee Park', type: 'Person', x: 700, y: 600, clusterId: -1, degree: 0 },
];

function sampleOf(clusterId: number) {
  return overviewNodes
    .filter((n) => n.clusterId === clusterId)
    .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))
    .slice(0, 8)
    .map(({ id, label, type, degree }) => ({ id, label, type, degree }));
}

/** A ready, fresh snapshot. Override any field for the other states. */
export function overviewFixture(overrides: Partial<GraphOverview> = {}): GraphOverview {
  return {
    status: 'ready',
    pending: false,
    computedAt: OVERVIEW_COMPUTED_AT,
    stale: false,
    tooLarge: false,
    nodeCount: 13,
    edgeCount: 16,
    clusters: [
      { id: 0, label: 'Acme Corp', labelEntityId: ACME_ID, size: 6, x: -385, y: 125, radius: 48.99, typeCounts: { Person: 3, Organization: 1, Project: 1, Meeting: 1 }, memberSample: sampleOf(0) },
      { id: 1, label: 'Globex', labelEntityId: GLOBEX_ID, size: 4, x: 397, y: -167, radius: 40, typeCounts: { Person: 2, Organization: 1, Meeting: 1 }, memberSample: sampleOf(1) },
      { id: 2, label: 'Cluster 3', labelEntityId: null, size: 2, x: 180, y: 445, radius: 28.28, typeCounts: { Organization: 1, Project: 1 }, memberSample: sampleOf(2) },
      { id: -1, label: 'Unconnected', labelEntityId: null, size: 1, x: 700, y: 600, radius: 20, typeCounts: { Person: 1 }, memberSample: sampleOf(-1) },
    ],
    clusterEdges: [
      { a: 0, b: 1, weight: 3 },
      { a: 0, b: 2, weight: 1 },
    ],
    nodes: overviewNodes,
    nodesTruncated: false,
    ...overrides,
  };
}

/** The named states the page renders, for `?fixture`-style lookups in tests. */
export const overviewStates = {
  ready: () => overviewFixture(),
  stale: () => overviewFixture({ stale: true }),
  pending: () => overviewFixture({ stale: true, pending: true }),
  building: () => overviewFixture({ status: 'none', pending: true, computedAt: null, nodeCount: 0, edgeCount: 0, clusters: [], clusterEdges: [], nodes: [] }),
  empty: () => overviewFixture({ status: 'none', pending: false, computedAt: null, nodeCount: 0, edgeCount: 0, clusters: [], clusterEdges: [], nodes: [] }),
  tooLarge: () => overviewFixture({ tooLarge: true, nodeCount: 60_000, edgeCount: 250_000, clusters: [], clusterEdges: [], nodes: [] }),
  truncated: () => overviewFixture({ nodesTruncated: true, nodeCount: 6_200, edgeCount: 21_000 }),
} satisfies Record<string, () => GraphOverview>;
