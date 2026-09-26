/**
 * Knowledge-graph MSW fixtures (#373's read side; #367 appends proposal fixtures).
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

import { computeEffectiveSchema, toEffectiveSchemaPayload } from '@app/shared/ontology';

import type {
  EntityBrief,
  EntityMention,
  EvidenceLink,
  GraphEntityDetail,
  GraphEntitySummary,
  GraphOntology,
  GraphSlice,
  TimelineEvent,
} from '../../services/graph';

/** A deterministic v4-shaped uuid, so fixtures read as ids and sort predictably. */
export function gid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

// ---------------------------------------------------------------------------
// Ontology
// ---------------------------------------------------------------------------

export const graphOntologyFixture: GraphOntology = toEffectiveSchemaPayload(
  computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] }),
) as GraphOntology;

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
