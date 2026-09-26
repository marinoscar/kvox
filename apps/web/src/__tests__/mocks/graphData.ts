/**
 * Connected-knowledge fixtures for the web tests (#369).
 *
 * The ontology payload is COMPUTED by the real shared package rather than
 * hand-written, so a fixture can never describe a schema the API would not
 * send — `computeEffectiveSchema` is the same function `GET /api/graph/ontology`
 * runs.
 */

import {
  computeEffectiveSchema,
  toEffectiveSchemaPayload,
  type DomainKey,
  type UserAttributeDef,
} from '@app/shared/ontology';

import type {
  AttributeDef,
  GraphOntology,
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

export function mockGraphOntology(
  enabledDomains: DomainKey[] = ['core', 'work'],
  userAttributes: UserAttributeDef[] = [],
): GraphOntology {
  return toEffectiveSchemaPayload(computeEffectiveSchema({ enabledDomains, userAttributes }));
}

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
export const NOTE_ID = 'n1';
export const TRANSCRIPT_ID = 't1';
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
    transcriptId: TRANSCRIPT_ID,
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
    noteId: NOTE_ID,
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
    noteId: NOTE_ID,
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
