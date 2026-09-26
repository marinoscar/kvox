import type { Page, Route } from '@playwright/test';

import { onboardingResponse } from './onboardingApi';

/**
 * A mocked knowledge-graph read API for the visual harness — issue #373,
 * epic #347. Shapes mirror #370's read API and #372's brief (and
 * `apps/web/src/services/graph.ts`, which mirrors those field for field).
 *
 * Self-contained on purpose, like `notesApi.ts`: this project never imports
 * app source or workspace packages at runtime, so the effective ontology is a
 * hand-written subset carrying only the fields the graph pages read.
 *
 * =============================================================================
 * EVERY VALUE IS FIXED
 * =============================================================================
 *
 * A pixel baseline cannot contain "3 minutes ago", so every timestamp is pinned
 * to an absolute instant far enough in the past that its relative rendering
 * does not move between the day a baseline is generated and the day it is
 * compared — the `notesApi.ts` convention.
 */

const FIXED_ISO = '2024-03-01T09:00:00.000Z';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const JOE_ID = id(1);
const ANA_ID = id(2);
const ACME_ID = id(4);
const Q3_ID = id(7);
const TRANSCRIPT_ID = id(900);
const SEGMENT_ID = id(901);
const NOTE_ID = id(950);
const EV_SEGMENT = id(701);
const EV_NOTE = id(702);
const EV_GONE = id(703);

const attr = (key: string, label: string, kind: string, sortOrder: number) => ({
  key,
  label,
  kind,
  required: false,
  list: false,
  options: null,
  extractable: true,
  description: label,
  sensitivity: 'business',
  source: 'builtin',
  domain: 'core',
  attributeDefId: null,
  deprecated: false,
  sortOrder,
});

const entityType = (key: string, label: string, pluralLabel: string, attributes: unknown[]) => ({
  key,
  domain: 'core',
  label,
  pluralLabel,
  description: label,
  disambiguation: [],
  storage: 'entity',
  itemKind: null,
  statuses: null,
  subjectTypes: null,
  subjectRequired: false,
  sensitivityDefault: 'business',
  alignment: null,
  extractable: true,
  deprecated: false,
  attributes,
});

const ONTOLOGY = {
  version: '1.0.0',
  domains: [
    { key: 'core', label: 'Core', enabled: true, alwaysOn: true },
    { key: 'work', label: 'Work', enabled: true, alwaysOn: false },
  ],
  entityTypes: [
    entityType('Person', 'Person', 'People', [attr('title', 'Job title', 'text', 0)]),
    entityType('Organization', 'Organization', 'Organizations', [attr('website', 'Website', 'url', 0)]),
    entityType('Meeting', 'Meeting', 'Meetings', []),
    entityType('Project', 'Project', 'Projects', [attr('startDate', 'Start date', 'date', 0)]),
  ],
  relationTypes: [
    { key: 'WORKS_FOR', label: 'Works for' },
    { key: 'REPORTS_TO', label: 'Reports to' },
    { key: 'ATTENDED', label: 'Attended' },
    { key: 'HAS_ROLE', label: 'Has role' },
    { key: 'ASSIGNED_TO', label: 'Assigned to' },
  ],
};

const SUMMARIES = [
  { id: JOE_ID, type: 'Person', label: 'Joe Rivera', aliases: ['Joseph Rivera'], mentionCount: 14, lastSeenAt: FIXED_ISO },
  { id: ACME_ID, type: 'Organization', label: 'Acme Corp', aliases: ['Acme'], mentionCount: 22, lastSeenAt: FIXED_ISO },
  { id: ANA_ID, type: 'Person', label: 'Ana Diaz', aliases: [], mentionCount: 9, lastSeenAt: FIXED_ISO },
  { id: id(5), type: 'Organization', label: 'Globex', aliases: ['Globex Corporation'], mentionCount: 4, lastSeenAt: FIXED_ISO },
  { id: id(3), type: 'Person', label: 'Ben Okafor', aliases: [], mentionCount: 6, lastSeenAt: FIXED_ISO },
  { id: id(10), type: 'Organization', label: 'Initech', aliases: [], mentionCount: 2, lastSeenAt: null },
  { id: id(9), type: 'Person', label: 'Carla Mendes', aliases: ['Carla'], mentionCount: 3, lastSeenAt: FIXED_ISO },
];

const DETAIL = {
  id: JOE_ID,
  type: 'Person',
  label: 'Joe Rivera',
  props: { title: 'VP Engineering' },
  aliases: [
    { id: id(501), alias: 'Joseph Rivera', source: 'extraction' },
    { id: id(502), alias: 'Joe R.', source: 'speaker_naming' },
  ],
  occurredAt: null,
  reviewStatus: 'accepted',
  ontologyVersion: '1.0.0',
  firstSeenAt: '2024-01-04T09:00:00.000Z',
  lastSeenAt: FIXED_ISO,
  counts: {
    relations: 5,
    mentions: 14,
    evidence: 18,
    items: { commitment: 3, decision: 2, claim: 1, person_fact: 2 },
    openCommitments: 2,
  },
  createdAt: FIXED_ISO,
  updatedAt: FIXED_ISO,
};

const joe = { id: JOE_ID, label: 'Joe Rivera', type: 'Person' };
const ana = { id: ANA_ID, label: 'Ana Diaz', type: 'Person' };
const acme = { id: ACME_ID, label: 'Acme Corp', type: 'Organization' };

const commitment = {
  itemId: id(301),
  kind: 'commitment',
  title: 'Ship the Atlas beta',
  statement: 'Joe will ship the Atlas beta by the end of October.',
  occurredAt: '2024-02-20T15:00:00.000Z',
  precision: 'day',
  status: 'open',
  dueAt: '2024-03-31T00:00:00.000Z',
  ownerPerson: joe,
  counterparty: ana,
  superseded: false,
  evidenceIds: [EV_SEGMENT],
};

const BRIEF = {
  entity: joe,
  window: {
    since: '2024-02-01T00:00:00.000Z',
    sinceSource: 'last_viewed',
    asOf: FIXED_ISO,
    lastViewedAt: '2024-02-01T00:00:00.000Z',
  },
  digest: {
    statements: [
      { text: 'Joe was promoted to VP Engineering in February.', evidenceIds: [EV_NOTE] },
      { text: 'He committed to ship the Atlas beta by the end of March.', evidenceIds: [EV_SEGMENT] },
    ],
    coversUntil: '2024-02-20T15:00:00.000Z',
    generatedAt: '2024-02-21T08:00:00.000Z',
    model: 'gpt-4o-mini',
  },
  digestStale: false,
  digestPending: false,
  digestUnavailable: null,
  sections: {
    whatChanged: [commitment],
    decisions: [
      {
        ...commitment,
        itemId: id(310),
        kind: 'decision',
        title: 'Move Atlas to the new cluster',
        statement: 'Atlas moves to the new cluster in Q2.',
        status: null,
        dueAt: null,
        ownerPerson: null,
        counterparty: null,
      },
      {
        ...commitment,
        itemId: id(311),
        kind: 'decision',
        title: 'Keep Atlas on the old cluster',
        statement: 'Atlas stays on the old cluster.',
        occurredAt: '2023-11-01T00:00:00.000Z',
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
      theirs: [commitment],
      yours: [
        {
          ...commitment,
          itemId: id(320),
          title: 'Send Joe the hiring plan',
          statement: 'Ana will send Joe the hiring plan.',
          dueAt: null,
          ownerPerson: ana,
          counterparty: joe,
        },
      ],
    },
    risksClaims: [
      {
        ...commitment,
        itemId: id(330),
        kind: 'claim',
        title: null,
        statement: 'Joe thinks the beta date is at risk if hiring slips.',
        status: null,
        dueAt: null,
        ownerPerson: null,
        counterparty: null,
      },
    ],
    peopleChanges: [
      {
        relationId: id(401),
        type: 'HAS_ROLE',
        change: 'ended',
        at: '2024-02-01T00:00:00.000Z',
        precision: 'month',
        person: joe,
        other: acme,
        title: 'Director of Engineering',
        evidenceIds: [EV_NOTE],
      },
      {
        relationId: id(402),
        type: 'HAS_ROLE',
        change: 'started',
        at: '2024-02-01T00:00:00.000Z',
        precision: 'month',
        person: joe,
        other: acme,
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
      snippetHtml: 'We will ship the <mark>Atlas</mark> beta and review hiring',
      startMs: 754_000,
      score: 0.8,
      inGraph: true,
      occurredAt: '2024-02-20T15:00:00.000Z',
    },
  ],
};

const node = (nodeId: string, type: string, label: string, depth: number) => ({
  id: nodeId,
  nodeKind: 'entity',
  type,
  label,
  depth,
  degree: 3,
  status: null,
  occurredAt: null,
});

const NEIGHBORHOOD = {
  seedIds: [JOE_ID],
  asOf: FIXED_ISO,
  nodes: [
    node(JOE_ID, 'Person', 'Joe Rivera', 0),
    node(ACME_ID, 'Organization', 'Acme Corp', 1),
    node(ANA_ID, 'Person', 'Ana Diaz', 1),
    node(Q3_ID, 'Meeting', 'Q3 planning', 1),
  ],
  edges: [
    { id: id(410), type: 'WORKS_FOR', source: JOE_ID, target: ACME_ID, valid: null, confidence: 0.9, virtual: false },
    { id: id(411), type: 'REPORTS_TO', source: JOE_ID, target: ANA_ID, valid: null, confidence: 0.9, virtual: false },
    { id: id(412), type: 'ATTENDED', source: JOE_ID, target: Q3_ID, valid: null, confidence: null, virtual: false },
  ],
  truncated: false,
  cap: 100,
};

const TIMELINE = {
  items: [
    {
      id: id(301),
      eventKind: 'item',
      at: '2024-02-20T15:00:00.000Z',
      precision: 'day',
      item: {
        id: id(301),
        kind: 'commitment',
        title: 'Ship the Atlas beta',
        statement: 'Joe will ship the Atlas beta by the end of March.',
        status: 'open',
        dueAt: '2024-03-31T00:00:00.000Z',
        ownerPerson: joe,
        counterparty: ana,
        sensitivity: null,
        superseded: false,
        supersededById: null,
      },
      evidenceIds: [EV_SEGMENT],
      evidenceCount: 1,
    },
    {
      id: `rel:${id(402)}:start`,
      eventKind: 'relation_started',
      at: '2024-02-01T00:00:00.000Z',
      precision: 'month',
      relation: { id: id(402), type: 'HAS_ROLE', direction: 'out', other: acme, valid: null },
      evidenceIds: [EV_NOTE],
      evidenceCount: 1,
    },
    {
      id: id(311),
      eventKind: 'item',
      at: '2023-11-01T00:00:00.000Z',
      precision: 'month',
      item: {
        id: id(311),
        kind: 'decision',
        title: 'Keep Atlas on the old cluster',
        statement: 'Atlas stays on the old cluster.',
        status: null,
        dueAt: null,
        ownerPerson: null,
        counterparty: null,
        sensitivity: null,
        superseded: true,
        supersededById: id(310),
      },
      evidenceIds: [EV_GONE],
      evidenceCount: 1,
    },
  ],
  nextCursor: null,
  asOf: FIXED_ISO,
};

const MENTIONS = {
  items: [
    { kind: 'transcript', id: TRANSCRIPT_ID, title: 'Q3 planning call', occurredAt: FIXED_ISO, available: true },
    { kind: 'note', id: NOTE_ID, title: 'Q3 planning — decisions', occurredAt: FIXED_ISO, available: true },
    { kind: 'transcript', id: id(990), title: null, occurredAt: '2023-10-01T10:00:00.000Z', available: false },
  ],
  nextCursor: null,
};

const EVIDENCE = [
  {
    id: EV_SEGMENT,
    subjectKind: 'item',
    subjectId: id(301),
    quote: 'We will ship the Atlas beta by the end of March.',
    createdAt: FIXED_ISO,
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
    subjectId: id(401),
    quote: 'Joe now leads the platform group.',
    createdAt: FIXED_ISO,
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
    subjectId: id(311),
    quote: 'Budget is frozen until Q4.',
    createdAt: FIXED_ISO,
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
];

/** The permissions a graph baseline runs with — a reader AND a writer. */
export const GRAPH_PERMS = [
  'user_settings:read',
  'user_settings:write',
  'transcripts:read',
  'notes:read',
  'graph:read',
  'graph:write',
];

export interface GraphApiOptions {
  /** An empty graph — the index's first-run state. */
  empty?: boolean;
}

function json(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data }),
  });
}

export async function installGraphApi(page: Page, options: GraphApiOptions = {}): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');

    if (path === '/graph/ontology') return json(route, ONTOLOGY);

    if (path === '/graph/entities') {
      if (options.empty) return json(route, { items: [], nextCursor: null });
      const types = url.searchParams.get('type')?.split(',').filter(Boolean) ?? [];
      const items = SUMMARIES.filter((row) => types.length === 0 || types.includes(row.type));
      return json(route, { items, nextCursor: 'page-2' });
    }

    if (/^\/graph\/entities\/[^/]+\/brief$/.test(path)) return json(route, BRIEF);
    if (/^\/graph\/entities\/[^/]+\/neighborhood$/.test(path)) return json(route, NEIGHBORHOOD);
    if (/^\/graph\/entities\/[^/]+\/timeline$/.test(path)) return json(route, TIMELINE);
    if (/^\/graph\/entities\/[^/]+\/mentions$/.test(path)) return json(route, MENTIONS);
    if (/^\/graph\/entities\/[^/]+$/.test(path)) return json(route, DETAIL);

    if (path === '/graph/evidence') {
      const ids = url.searchParams.get('ids')?.split(',') ?? [];
      return json(route, { items: EVIDENCE.filter((ev) => ids.includes(ev.id)) });
    }

    const onboarding = onboardingResponse(path);
    if (onboarding) return json(route, onboarding);

    // Anything else the chrome asks for (notification bell, etc.) gets the
    // quietest answer.
    return json(route, {});
  });
}
