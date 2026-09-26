import type { Page, Route } from '@playwright/test';

import { onboardingResponse } from './onboardingApi';

/**
 * `/api` stubs for the Knowledge graph settings page (issue #369, epic #346).
 *
 * Deterministic by construction: fixed timestamps, a fixed ontology payload
 * (hand-copied from what `computeEffectiveSchema` returns for `core` + `work`,
 * trimmed to the fields the page reads), and a fixed set of the user's own
 * attribute definitions covering every chip the browser draws.
 */

const FIXED_ISO = '2024-03-01T09:00:00.000Z';

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

function entityType(key: string, label: string, attributes: unknown[], domain = 'core') {
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

const ONTOLOGY = {
  version: '1.0.0',
  domains: [
    { key: 'core', label: 'Core', enabled: true, alwaysOn: true },
    { key: 'work', label: 'Work', enabled: true, alwaysOn: false },
  ],
  entityTypes: [
    entityType('Person', 'Person', [attribute('title', 'Job title', 'mixin')]),
    entityType('Organization', 'Organization', [attribute('website', 'Website')]),
    entityType('Meeting', 'Meeting', [attribute('topics', 'Topics')]),
    entityType('Project', 'Project', [attribute('status', 'Status')], 'work'),
  ],
  relationTypes: [],
};

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

function json(route: Route, data: unknown): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data }),
  });
}

export interface GraphApiOptions {
  /** Answer `GET /api/ai/config` with `graphEnabled: false`. */
  graphDisabled?: boolean;
}

export async function installGraphApi(page: Page, options: GraphApiOptions = {}): Promise<void> {
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
    if (path === '/graph/ontology') return json(route, ONTOLOGY);
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
    if (path === '/graph/ontology') return json(route, ONTOLOGY);
    if (path === '/graph/notes/n1/proposal') return json(route, { proposal: detail });
    if (path === `/graph/proposals/${PROPOSAL_ID}`) return json(route, detail);
    if (path === '/graph/entities') return json(route, { items: [], nextCursor: null });

    return route.fallback();
  });
}
