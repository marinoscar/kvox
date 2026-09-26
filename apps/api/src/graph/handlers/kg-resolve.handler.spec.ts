import type { Job } from '@prisma/client';

import type { MentionOutcome, MentionToRank } from '../resolution/resolution.service';
import { decide } from '../resolution/resolution.service';
import { KG_RESOLVE_MAX_ENTITIES, KgResolveHandler, readKgResolvePayload } from './kg-resolve.handler';

const USER = '11111111-1111-4111-8111-111111111111';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const job = (payload: unknown) => ({ id: '99999999-9999-4999-8999-999999999999', payload }) as unknown as Job;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function outcome(candidateId: string | null, score: number, band: MentionOutcome['band']): MentionOutcome {
  return {
    candidates: candidateId ? [{ entityId: candidateId, label: 'X', type: 'Person', score, signals: ['alias_exact'], arm: 'alias_exact' }] : [],
    ambiguous: false,
    band,
  };
}

function build(options: { entities: Array<{ id: string }>; outcomes: (m: MentionToRank) => MentionOutcome; openItems?: any[] }) {
  const created: { proposal?: any; items?: any[] } = {};
  const tx = {
    kgProposal: { create: jest.fn(async ({ data }: any) => ((created.proposal = data), { id: 'prop-1', ...data })) },
    kgProposalItem: { createMany: jest.fn(async ({ data }: any) => ((created.items = data), { count: data.length })) },
  };
  const prisma = {
    kgEntity: {
      findMany: jest.fn(async () => options.entities.map((e) => ({ type: 'Person', label: 'Sarah', embeddingHash: null, ...e }))),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    kgEntityAlias: { findMany: jest.fn(async () => []) },
    kgRelation: { findMany: jest.fn(async () => []) },
    kgProposalItem: { findMany: jest.fn(async () => options.openItems ?? []) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    $executeRaw: jest.fn(),
  };
  const preferences = { get: jest.fn(async () => ({ resolution: { mode: 'precheck_confident', autoLinkThreshold: 0.9, newThreshold: 0.55, adjudication: 'llm' } })) };
  const resolution = {
    rankMentions: jest.fn(async (_o: string, mentions: MentionToRank[]) => new Map(mentions.map((m) => [m.key, options.outcomes(m)]))),
    adjudicateSafely: jest.fn(async () => ({ verdicts: new Map([['p1', { verdict: 'different', rationale: 'no', model: 'm' }]]), reason: null })),
  };
  const adjudication = {
    buildCandidateDossiers: jest.fn(async (_o: string, ids: string[]) =>
      new Map(ids.map((id) => [id, { entityId: id, label: 'X', aliases: [], props: {}, quotes: [], neighbourhood: [] }])),
    ),
  };
  const handler = new KgResolveHandler({ register: jest.fn() } as never, prisma as never, preferences as never, resolution as never, adjudication as never);
  return { handler, prisma, resolution, created, tx };
}

describe('kg.resolve', () => {
  it('declares its profile and payload', () => {
    const { handler } = build({ entities: [], outcomes: () => outcome(null, 0, 'new') });
    expect(handler.type).toBe('kg.resolve');
    expect(handler.profile).toEqual({ maxRuntimeMs: 20 * 60_000, maxAttempts: 1 });
    expect(readKgResolvePayload({ userId: USER, scope: 'entity', reason: 'manual' })).toBeNull();
    expect(readKgResolvePayload({ userId: USER, scope: 'all', reason: 'threshold_change' })).not.toBeNull();
  });

  it('writes one resolution proposal of suggestions — and never merges anything', async () => {
    const t = build({
      entities: [{ id: A }, { id: B }, { id: C }],
      outcomes: (m) => (m.key === A ? outcome(B, 0.95, 'link') : m.key === B ? outcome(A, 0.95, 'link') : outcome(null, 0, 'new')),
    });
    await t.handler.process(job({ userId: USER, scope: 'all', reason: 'manual' }));

    expect(t.created.proposal).toMatchObject({ ownerId: USER, kind: 'resolution', status: 'draft' });
    expect(t.created.proposal.noteId).toBeUndefined();
    // A↔B suggested once, not twice.
    expect(t.created.items).toHaveLength(1);
    expect(t.created.items![0]).toMatchObject({
      kind: 'entity',
      decision: 'pending',
      payload: { ref: 'x1', existingEntityId: A, aliases: [], props: {} },
      resolution: { ref: B, score: 0.95 },
    });
    expect(t.created.items![0].flags).toContain('possible_duplicate');
    // No write to the graph itself.
    expect(t.prisma.kgEntity.update).not.toHaveBeenCalled();
    expect(t.prisma.kgEntity.updateMany).not.toHaveBeenCalled();
    expect(t.prisma.$executeRaw).not.toHaveBeenCalled();
    // Each entity excludes itself (and so its distinct pairs) from its candidates.
    const mentions = t.resolution.rankMentions.mock.calls[0][1] as MentionToRank[];
    expect(mentions.find((m) => m.key === A)?.excludeIds).toEqual([A]);
  });

  it('writes no proposal when nothing reaches the new threshold', async () => {
    const t = build({ entities: [{ id: A }], outcomes: () => outcome(B, 0.4, 'new') });
    await t.handler.process(job({ userId: USER, scope: 'entity', entityId: A, reason: 'merge_reversed' }));
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('drops a middle-band pair the adjudicator called different', async () => {
    const t = build({ entities: [{ id: A }], outcomes: () => outcome(B, 0.7, 'middle') });
    await t.handler.process(job({ userId: USER, scope: 'all', reason: 'manual' }));
    expect(t.resolution.adjudicateSafely).toHaveBeenCalledWith(USER, expect.any(Array), 'kg.resolve');
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips a pair an open resolution proposal already suggests', async () => {
    const t = build({
      entities: [{ id: A }],
      outcomes: () => outcome(B, 0.95, 'link'),
      openItems: [{ payload: { existingEntityId: B }, resolution: { ref: A } }],
    });
    await t.handler.process(job({ userId: USER, scope: 'all', reason: 'manual' }));
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
  });

  it(`scans at most ${KG_RESOLVE_MAX_ENTITIES} entities and records the truncation`, async () => {
    const entities = Array.from({ length: KG_RESOLVE_MAX_ENTITIES + 1 }, (_, i) => ({ id: uuid(i + 1) }));
    const t = build({ entities, outcomes: (m) => (m.key === uuid(1) ? outcome(uuid(2), 0.95, 'link') : outcome(null, 0, 'new')) });
    await t.handler.process(job({ userId: USER, scope: 'all', reason: 'threshold_change' }));
    expect((t.resolution.rankMentions.mock.calls[0][1] as unknown[]).length).toBe(KG_RESOLVE_MAX_ENTITIES);
    expect(t.created.proposal.stats).toMatchObject({ truncated: true, resolution: { scanned: KG_RESOLVE_MAX_ENTITIES, truncated: true } });
  });

  it('uses the same decision rule as proposal mode', () => {
    expect(decide(outcome(B, 0.95, 'link'), { mode: 'precheck_confident', autoLinkThreshold: 0.9, newThreshold: 0.55, adjudication: 'llm' }, null).resolution.ref).toBe(B);
  });
});
