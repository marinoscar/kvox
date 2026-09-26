import type { Page, Route } from '@playwright/test';

import { onboardingResponse } from './onboardingApi';

/**
 * A mocked knowledge-graph API for the visual harness. Two surfaces, each
 * with its own fixed fixtures so neither's baselines move when the other's
 * change (select with `GraphApiOptions.surface`):
 *
 *   - `'settings'` (the default) — the Knowledge graph settings page (issue
 *     #369, epic #346): ontology, the user's own attribute definitions and
 *     `GET /api/ai/config`.
 *   - `'pages'` — the `/graph` index and entity page (issue #373, epic #347).
 *     Shapes mirror #370's read API and #372's brief (and
 *     `apps/web/src/services/graph.ts`, which mirrors those field for field).
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

const PAGES_ONTOLOGY = {
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
  /** Which surface's fixtures to serve. Default `'settings'`. */
  surface?: 'settings' | 'pages';
  /** `'pages'`: an empty graph — the index's first-run state. */
  empty?: boolean;
  /** `'settings'`: answer `GET /api/ai/config` with `graphEnabled: false`. */
  graphDisabled?: boolean;
}

function json(route: Route, data: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data }),
  });
}

export async function installGraphApi(page: Page, options: GraphApiOptions = {}): Promise<void> {
  if ((options.surface ?? 'settings') === 'settings') return installSettingsApi(page, options);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');

    if (path === '/graph/ontology') return json(route, PAGES_ONTOLOGY);

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

// =============================================================================
// Settings surface (#369) — the Knowledge graph settings page's fixtures,
// hand-copied from what `computeEffectiveSchema` returns for `core` + `work`,
// trimmed to the fields the page reads.
// =============================================================================

function attribute(key: string, label: string, source: 'builtin' | 'mixin' = 'builtin') {
  return {
    key,
    label,
    kind: 'text',
    required: false,
    list: false,
    options: null,
    extractable: true,
    description: label,
    sensitivity: 'business',
    source,
    domain: source === 'mixin' ? 'work' : 'core',
    attributeDefId: null,
    deprecated: false,
    sortOrder: 0,
  };
}

function settingsEntityType(key: string, label: string, attributes: unknown[], domain = 'core') {
  return {
    key,
    domain,
    label,
    pluralLabel: `${label}s`,
    description: label,
    disambiguation: [],
    storage: 'entity',
    itemKind: null,
    statuses: null,
    subjectTypes: null,
    subjectRequired: false,
    sensitivityDefault: key === 'Person' ? 'personal' : 'business',
    alignment: null,
    extractable: true,
    deprecated: false,
    attributes,
  };
}

const SETTINGS_ONTOLOGY = {
  version: '1.0.0',
  domains: [
    { key: 'core', label: 'Core', enabled: true, alwaysOn: true },
    { key: 'work', label: 'Work', enabled: true, alwaysOn: false },
  ],
  entityTypes: [
    settingsEntityType('Person', 'Person', [attribute('title', 'Job title', 'mixin')]),
    settingsEntityType('Organization', 'Organization', [attribute('website', 'Website')]),
    settingsEntityType('Meeting', 'Meeting', [attribute('topics', 'Topics')]),
    settingsEntityType('Project', 'Project', [attribute('status', 'Status')], 'work'),
  ],
  relationTypes: [],
};

/**
 * main's own name for the settings-surface ontology (#367/#368's review and
 * guide mocks spread it); an alias so code merged from main keeps working.
 */
const ONTOLOGY = SETTINGS_ONTOLOGY;

function def(overrides: Record<string, unknown>) {
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
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    ...overrides,
  };
}

const ATTRIBUTE_DEFS = [
  def({}),
  def({
    id: '66666666-6666-4666-8666-666666666666',
    key: 'u_oldfield01',
    label: 'Desk number',
    extractable: false,
    extractionHint: null,
    deprecatedAt: FIXED_ISO,
  }),
  def({
    id: '77777777-7777-4777-8777-777777777777',
    entityType: 'Organization',
    key: 'u_industry01',
    label: 'Industry',
    kind: 'select',
    options: { choices: [{ value: 'saas', label: 'SaaS' }] },
    extractable: false,
    extractionHint: null,
    sensitivity: 'business',
  }),
];

async function installSettingsApi(page: Page, options: GraphApiOptions): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');

    if (path === '/ai/config') {
      return json(route, {
        available: true,
        provider: 'openai',
        providerLabel: 'OpenAI',
        models: [],
        defaultModel: 'gpt-4o-mini',
        maxInputTokens: 100_000,
        maxOutputTokens: 8_000,
        keyConfigured: true,
        graphEnabled: !options.graphDisabled,
      });
    }
    if (path === '/graph/ontology') return json(route, SETTINGS_ONTOLOGY);
    if (path === '/graph/attribute-defs') return json(route, { items: ATTRIBUTE_DEFS });

    const onboarding = onboardingResponse(path);
    if (onboarding) return json(route, onboarding);

    return json(route, {});
  });
}

// =============================================================================
// The proposal review sheet on `/notes/n1` (issue #367)
// =============================================================================
//
// Layered OVER `installNotesApi` (Playwright runs the most recently registered
// matching route first): this installer answers `/ai/config` with the graph
// switched on and every `/graph/*` route the sheet reads, and hands every
// other path back with `route.fallback()` to the notes stubs. Fixed ids,
// fixed timestamps, one draft covering every group the sheet draws.

export type GraphReviewState = 'draft' | 'extracting' | 'committed';

const PROPOSAL_ID = 'a0000000-0000-4000-8000-000000000001';

function evidence(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `d0000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    source: 'segment',
    transcriptId: 't1',
    segmentId: 'seg-4',
    segmentRev: 1,
    startMs: 65_000,
    endMs: 72_000,
    noteId: null,
    noteVersion: null,
    charStart: null,
    charEnd: null,
    quote: 'Ana will ship the storage migration behind a flag.',
    speakerName: 'Oscar',
    stale: false,
    ...overrides,
  };
}

function reviewRow(
  n: number,
  groupKey: string,
  title: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    kind: 'entity',
    origin: 'ai',
    groupKey,
    decision: 'accept',
    payload,
    editedPayload: null,
    effectivePayload: payload,
    display: { title, subtitle: groupKey === 'relations' ? null : groupKey },
    resolution: null,
    mergeIntoId: null,
    distinctFrom: [],
    flags: [],
    prechecked: true,
    evidence: [evidence(n)],
    committedRefId: null,
    ...overrides,
  };
}

function entity(ref: string, type: string, label: string, props: Record<string, unknown> = {}) {
  return { ref, type, label, aliases: [], props, occurredAt: null };
}

function itemPayload(ref: string, kind: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    ref,
    kind,
    title,
    statement: title,
    subject: null,
    owner: null,
    counterparty: null,
    meeting: null,
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

const REVIEW_ITEMS = [
  reviewRow(1, 'Person', 'Ana Ruiz', entity('e1', 'Person', 'Ana Ruiz', { title: 'Staff engineer' }), {
    resolution: {
      ref: 'b0000000-0000-4000-8000-000000000001',
      score: 0.94,
      source: 'speaker',
      candidates: [],
      adjudication: null,
      refLabel: 'Ana Ruiz',
    },
  }),
  reviewRow(2, 'Person', 'Tom', entity('e2', 'Person', 'Tom'), {
    decision: 'pending',
    prechecked: false,
    flags: ['possible_duplicate'],
    resolution: {
      ref: null,
      score: null,
      source: null,
      candidates: [
        { entityId: 'b0000000-0000-4000-8000-000000000002', label: 'Tom Baker', type: 'Person', score: 0.71, signals: [] },
      ],
      adjudication: null,
      refLabel: 'Tom Baker',
    },
    evidence: [evidence(2, { quote: 'Tom will check with legal.', startMs: 130_000, stale: true })],
  }),
  reviewRow(3, 'Person', 'Ben Okafor', entity('k1', 'Person', 'Ben Okafor'), { flags: ['known'] }),
  reviewRow(4, 'Organization', 'Northwind Robotics', entity('e3', 'Organization', 'Northwind Robotics')),
  reviewRow(5, 'Project', 'Storage migration', entity('e4', 'Project', 'Storage migration')),
  reviewRow(6, 'Meeting', 'Weekly engineering standup', entity('meeting', 'Meeting', 'Weekly engineering standup'), {
    display: { title: 'Weekly engineering standup', subtitle: 'Meeting · 1 Mar 2024' },
  }),
  reviewRow(7, 'Decision', 'Ship behind a flag', itemPayload('i1', 'decision', 'Ship behind a flag'), {
    kind: 'item',
  }),
  reviewRow(8, 'Commitment', 'Write the rollback plan', itemPayload('i2', 'commitment', 'Write the rollback plan', { owner: { ref: 'e1' }, status: 'open' }), {
    kind: 'item',
    display: { title: 'Write the rollback plan', subtitle: 'Commitment · Ana Ruiz · due 8 Mar 2024' },
  }),
  reviewRow(9, 'PersonFact', 'On parental leave in April', itemPayload('i3', 'person_fact', 'On parental leave in April', { subject: { ref: 'e1' }, sensitivity: 'sensitive' }), {
    kind: 'item',
    decision: 'pending',
    prechecked: false,
    flags: ['sensitive'],
  }),
  reviewRow(10, 'relations', 'Ana Ruiz → works for → Northwind Robotics', {
    ref: 'r1', type: 'WORKS_FOR', from: { ref: 'e1' }, to: { ref: 'e3' }, validFrom: null, validTo: null, precision: 'unknown', props: {},
  }, { kind: 'relation' }),
  reviewRow(11, 'relations', 'Tom → works for → Northwind Robotics', {
    ref: 'r2', type: 'WORKS_FOR', from: { ref: 'e2' }, to: { ref: 'e3' }, validFrom: null, validTo: null, precision: 'unknown', props: {},
  }, { kind: 'relation', decision: 'pending', prechecked: false }),
  reviewRow(12, 'closings', 'Closes: Ana Ruiz → works for → Contoso', { relationId: 'b1000000-0000-4000-8000-000000000001' }, {
    kind: 'closing',
    decision: 'pending',
    prechecked: false,
    flags: ['closing_affects_commitments'],
    display: { title: 'Closes: Ana Ruiz → works for → Contoso', subtitle: 'ended Mar 2024' },
  }),
];

function reviewDetail(state: GraphReviewState) {
  const items = state === 'extracting' ? [] : REVIEW_ITEMS;
  const pending = items.filter((row) => row.decision === 'pending').length;
  return {
    proposal: {
      id: PROPOSAL_ID,
      kind: 'extraction',
      status: state,
      noteId: 'n1',
      noteTitle: 'Weekly engineering standup — minutes',
      noteVersion: 3,
      noteCurrentVersion: 3,
      model: 'gpt-4o-mini',
      providerId: 'openai',
      userGuidance: null,
      counts: {
        total: items.length,
        pending,
        accepted: items.length - pending,
        rejected: 0,
        known: 1,
        byGroup: {},
      },
      stats: {},
      failure: null,
      createdAt: FIXED_ISO,
      committedAt: state === 'committed' ? FIXED_ISO : null,
      revertedAt: null,
    },
    items,
    context: null,
  };
}

export async function installGraphReviewApi(
  page: Page,
  options: { state?: GraphReviewState } = {},
): Promise<void> {
  const detail = reviewDetail(options.state ?? 'draft');
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');

    if (path === '/ai/config') {
      return json(route, {
        available: true,
        provider: 'openai',
        providerLabel: 'OpenAI',
        models: [
          {
            id: 'gpt-4o-mini',
            label: 'GPT-4o mini',
            contextWindowTokens: 128_000,
            maxOutputTokens: 16_000,
            source: 'catalogue',
            derivedFrom: null,
            structuredOutput: true,
            toolCalling: true,
          },
        ],
        defaultModel: 'gpt-4o-mini',
        maxInputTokens: 100_000,
        maxOutputTokens: 8_000,
        keyConfigured: true,
        graphEnabled: true,
      });
    }
    if (path === '/graph/ontology') return json(route, SETTINGS_ONTOLOGY);
    if (path === '/graph/notes/n1/proposal') return json(route, { proposal: detail });
    if (path === `/graph/proposals/${PROPOSAL_ID}`) return json(route, detail);
    if (path === '/graph/entities') return json(route, { items: [], nextCursor: null });

    return route.fallback();
  });
}

// -----------------------------------------------------------------------------
// Guide the graph, add from a selection, Home "Waiting for review" (#368)
// -----------------------------------------------------------------------------
//
// Registered AFTER `installNotesApi`/`installHomeApi` (and after
// `installGraphReviewApi` when both are used): Playwright tries the most
// recently registered route first, so these answers win and everything else
// falls back. Adds the #360 `taskModels`, a capable and an incapable model,
// the #363 estimate, guidance on the draft, and the drafts list Home reads.

const GUIDE_AI_CONFIG = {
  available: true,
  provider: 'openai',
  providerLabel: 'OpenAI',
  models: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', contextWindowTokens: 128_000, maxOutputTokens: 16_000, source: 'catalogue', derivedFrom: null, structuredOutput: true, toolCalling: true },
    { id: 'gpt-4.1', label: 'GPT-4.1', contextWindowTokens: 1_000_000, maxOutputTokens: 32_000, source: 'catalogue', derivedFrom: null, structuredOutput: true, toolCalling: true },
    { id: 'legacy-text', label: 'Legacy text model', contextWindowTokens: 16_000, maxOutputTokens: 4_000, source: 'catalogue', derivedFrom: null, structuredOutput: false, toolCalling: false },
  ],
  defaultModel: 'gpt-4o-mini',
  maxInputTokens: 100_000,
  maxOutputTokens: 8_000,
  keyConfigured: true,
  graphEnabled: true,
  taskModels: Object.fromEntries(
    ['graph.extract', 'graph.adjudicate', 'graph.digest', 'graph.agent'].map((key) => [
      key,
      {
        model: key === 'graph.extract' ? 'gpt-4.1' : 'gpt-4o-mini',
        source: key === 'graph.extract' ? 'task' : 'default',
        reasoningEffort: 'medium',
        requires: ['structuredOutput'],
        usable: true,
        reason: null,
      },
    ]),
  ),
};

const GUIDE_ESTIMATE = {
  providerId: 'openai',
  model: 'gpt-4.1',
  inputTokens: 6_840,
  maxOutputTokens: 16_000,
  availableInputTokens: 900_000,
  fits: true,
  requests: 1,
  keyConfigured: true,
};

function itemType(key: string, label: string, itemKind: string) {
  return {
    ...entityType(key, label, [], 'work'),
    storage: 'item',
    itemKind,
    subjectTypes: ['Person', 'Organization', 'Project'],
  };
}

function relationType(key: string, label: string, from: string[], to: string[], temporal: boolean) {
  return {
    key,
    domain: 'work',
    label,
    description: label,
    from,
    to,
    allowedPairs: null,
    temporal,
    exclusive: 'none',
    exclusiveScope: 'from',
    representation: 'relation',
    extractable: true,
    alignment: null,
    deprecated: false,
    props: [],
  };
}

const GUIDE_ONTOLOGY = {
  ...ONTOLOGY,
  entityTypes: [
    ...ONTOLOGY.entityTypes,
    itemType('Decision', 'Decision', 'decision'),
    itemType('Commitment', 'Commitment', 'commitment'),
  ],
  relationTypes: [
    relationType('WORKS_FOR', 'Works for', ['Person'], ['Organization'], true),
    relationType('REPORTS_TO', 'Reports to', ['Person'], ['Person'], true),
    relationType('ATTENDED', 'Attended', ['Person'], ['Meeting'], false),
  ],
};

const RESOLUTION_PROPOSAL_ID ='a0000000-0000-4000-8000-000000000009';

function guidedDetail() {
  const detail = reviewDetail('draft');
  return {
    ...detail,
    proposal: {
      ...detail.proposal,
      userGuidance: {
        // Ana Ruiz — named from the draft's own resolution (`refLabel`).
        pinnedEntityIds: ['b0000000-0000-4000-8000-000000000001'],
        entityTypes: ['Person', 'Organization', 'Project', 'Decision', 'Commitment'],
        instructions: 'Only the storage migration; ignore the lunch plans. Ben is our SRE lead, not a vendor.',
      },
    },
  };
}

function homeDrafts() {
  const base = reviewDetail('draft').proposal;
  return [
    { ...base, id: PROPOSAL_ID, noteTitle: 'Weekly engineering standup — minutes' },
    {
      ...base,
      id: 'a0000000-0000-4000-8000-000000000002',
      noteId: 'n2',
      noteTitle: 'Customer discovery — Northwind',
      counts: { ...base.counts, pending: 7 },
    },
    {
      ...base,
      id: RESOLUTION_PROPOSAL_ID,
      kind: 'resolution',
      noteId: null,
      noteTitle: null,
      noteVersion: null,
      noteCurrentVersion: null,
      counts: { ...base.counts, pending: 2 },
    },
  ];
}

export async function installGraphGuideApi(page: Page): Promise<void> {
  const detail = guidedDetail();
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');

    if (path === '/ai/config') return json(route, GUIDE_AI_CONFIG);
    if (path === '/graph/ontology') return json(route, GUIDE_ONTOLOGY);
    if (path === '/graph/extract/estimate') return json(route, GUIDE_ESTIMATE);
    if (path === '/graph/notes/n1/proposal') return json(route, { proposal: detail });
    if (path === `/graph/proposals/${PROPOSAL_ID}`) return json(route, detail);
    if (path === '/graph/proposals') return json(route, { items: homeDrafts(), nextCursor: null });
    if (path === '/graph/entities') return json(route, { items: [], nextCursor: null });

    return route.fallback();
  });
}
