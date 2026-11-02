import { GRAPH_PREFERENCE_DEFAULTS, type GraphPreferences } from '../../graph/index.js';
import type { ProposalStageContext } from '../extraction/proposal-stage.js';
import type { RawCandidate } from './candidate.service.js';
import { decide, ResolutionService, type MentionOutcome } from './resolution.service.js';
import { KvoxRateLimitError } from '../../ports/index.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PROPOSAL = '22222222-2222-4222-8222-222222222222';
const TRANSCRIPT = '33333333-3333-4333-8333-333333333333';
const SASHA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEETING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const thresholds = GRAPH_PREFERENCE_DEFAULTS.resolution;

describe('decide (outcome bands)', () => {
  const outcome = (score: number, band: MentionOutcome['band'], ambiguous = false): MentionOutcome => ({
    candidates: [{ entityId: SASHA, label: 'Sasha Example', type: 'Person', score, signals: ['alias_exact'], arm: 'alias_exact' }],
    ambiguous,
    band,
  });
  const verdict = (v: 'same' | 'different' | 'uncertain') => ({ verdict: v, rationale: 'why', model: 'm' });

  it('links the top candidate at or above auto-link, sourced from its arm', () => {
    const d = decide(outcome(0.95, 'link'), thresholds, null);
    expect(d.resolution).toMatchObject({ ref: SASHA, score: 0.95, source: 'alias', adjudication: null });
    expect(d.flags).toEqual([]);
  });

  it('proposes new below the new threshold, keeping the candidates for review', () => {
    const d = decide(outcome(0.4, 'new'), thresholds, null);
    expect(d.resolution).toMatchObject({ ref: null, score: 0.4, source: null });
    expect(d.resolution.candidates).toHaveLength(1);
  });

  it('proposes new with no candidates at all', () => {
    expect(decide({ candidates: [], ambiguous: false, band: 'new' }, thresholds, null).resolution).toMatchObject({ ref: null, score: null });
  });

  it('flags the middle band possible_duplicate when adjudication did not run', () => {
    const d = decide(outcome(0.7, 'middle'), thresholds, null);
    expect(d.resolution.ref).toBeNull();
    expect(d.flags).toEqual(['possible_duplicate']);
  });

  it('maps the three verdicts', () => {
    expect(decide(outcome(0.7, 'middle'), thresholds, verdict('same'))).toMatchObject({
      resolution: { ref: SASHA, score: 0.9, source: 'adjudication', adjudication: { verdict: 'same' } },
      flags: [],
    });
    expect(decide(outcome(0.7, 'middle'), thresholds, verdict('different')).resolution).toMatchObject({ ref: null, adjudication: { verdict: 'different' } });
    const uncertain = decide(outcome(0.7, 'middle'), thresholds, verdict('uncertain'));
    expect(uncertain.resolution.ref).toBe(SASHA);
    expect(uncertain.flags).toEqual(['possible_duplicate']);
  });

  it('carries the ambiguous flag', () => {
    expect(decide(outcome(0.89, 'middle', true), thresholds, null).flags).toEqual(['ambiguous', 'possible_duplicate']);
  });
});

// ---------------------------------------------------------------------------
// Proposal mode, against mocked collaborators
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function entityItem(id: string, ref: string, label: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    kind: 'entity',
    payload: { ref, type: 'Person', label, aliases: [], props: {}, occurredAt: null },
    resolution: null,
    flags: [],
    distinctFrom: [],
    ...extra,
  };
}

function build(options: {
  items: Row[];
  candidates?: Record<string, RawCandidate[]>;
  embedder?: { ok: false; reason: string } | { ok: true };
  speakerLinked?: boolean;
  adjudicate?: jest.Mock;
  self?: { entityId: string; label: string; aliases: string[] } | null;
}) {
  const updates: Array<{ id: string; resolution: any; flags: string[] }> = [];
  const prisma = {
    kgProposalItem: {
      findMany: jest.fn(async () => options.items),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        updates.push({ id: where.id, resolution: data.resolution, flags: data.flags });
        return {};
      }),
    },
    kgEvidence: {
      findFirst: jest.fn(async () => (options.speakerLinked ? { transcriptId: TRANSCRIPT } : null)),
      findMany: jest.fn(async () => []),
    },
    transcript: { findFirst: jest.fn(async () => ({ id: TRANSCRIPT, speakerIdentities: {} })) },
    transcriptSpeaker: { findMany: jest.fn(async () => [{ id: 'spk-a', label: 'A', displayName: 'Sasha Example' }]) },
    kgRelation: { findMany: jest.fn(async () => [{ fromSpeakerId: 'spk-a', toId: SASHA }]) },
    kgEntity: {
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        where.reviewStatus ? [{ id: SASHA }] : [],
      ),
    },
  };
  const candidates = {
    forMention: jest.fn(async (_owner: string, mention: { label: string }) => options.candidates?.[mention.label] ?? []),
  };
  const features = {
    features: jest.fn(async (_o: string, ids: string[]) =>
      new Map(ids.map((id) => [id, { sameMeeting: false, orgCoMention: false, sharedNeighbour: false, recent: false }])),
    ),
  };
  const embedResult = options.embedder ?? { ok: false, reason: 'ai_key_missing' };
  const embedder = {
    resolve: jest.fn(async () =>
      embedResult.ok
        ? { ok: true, model: 'emb', providerId: 'openai', maxBatchSize: 128, embed: async (t: string[]) => t.map(() => [0.1]) }
        : embedResult,
    ),
  };
  const adjudication = {
    adjudicate: options.adjudicate ?? jest.fn(async () => new Map()),
    buildCandidateDossiers: jest.fn(async (_o: string, ids: string[]) =>
      new Map(ids.map((id) => [id, { entityId: id, label: 'X', aliases: [], props: {}, quotes: [], neighbourhood: [] }])),
    ),
  };
  const service = new ResolutionService(
    prisma as never,
    candidates as never,
    features as never,
    embedder as never,
    adjudication as never,
    { resolve: jest.fn(async () => options.self ?? null) } as never,
  );
  const ctx = (prefs: Partial<GraphPreferences['resolution']> = {}): ProposalStageContext => ({
    proposalId: PROPOSAL,
    userId: USER,
    noteId: 'note',
    preferences: { ...GRAPH_PREFERENCE_DEFAULTS, resolution: { ...GRAPH_PREFERENCE_DEFAULTS.resolution, ...prefs } },
    ai: null,
    prisma: prisma as never,
    stats: {},
  });
  return { service, ctx, updates, candidates, adjudication, embedder };
}

const raw = (entityId: string, over: Partial<RawCandidate> = {}): RawCandidate => ({
  entityId,
  label: 'Sasha Example',
  type: 'Person',
  aliasExact: false,
  trigram: null,
  cosine: null,
  ...over,
});

describe('ResolutionService.resolveProposal', () => {
  it('links a speaker-identified Person without scoring it', async () => {
    const t = build({ items: [entityItem('i1', 'e1', 'sasha example')], speakerLinked: true });
    const stats = await t.service.resolveProposal(t.ctx(), 'kg.extract');
    expect(t.updates[0].resolution).toMatchObject({ ref: SASHA, score: 1, source: 'speaker', candidates: [] });
    expect(t.candidates.forMention).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ entities: 1, linked: 1, speaker: 1 });
  });

  describe('the owner\'s own node (#778)', () => {
    const SELF = { entityId: OTHER, label: 'Avery Example', aliases: ['Avery'] };

    it('links a Person named by the owner\'s label or alias above the auto-link threshold, without scoring it', async () => {
      const t = build({ items: [entityItem('i1', 'e1', 'AVERY EXAMPLE'), entityItem('i2', 'e2', 'Someone', { payload: { ref: 'e2', type: 'Person', label: 'Someone', aliases: ['avery'], props: {}, occurredAt: null } })], self: SELF });
      const stats = await t.service.resolveProposal(t.ctx(), 'kg.extract');
      for (const update of t.updates) {
        expect(update.resolution).toMatchObject({ ref: OTHER, source: 'self', adjudication: null });
        expect(update.resolution.score).toBeGreaterThanOrEqual(0.9);
        expect(update.resolution.candidates[0]).toMatchObject({ entityId: OTHER, signals: ['self'] });
      }
      expect(t.candidates.forMention).not.toHaveBeenCalled();
      expect(stats).toMatchObject({ entities: 2, linked: 2, self: 2 });
    });

    it('stays above a raised threshold', async () => {
      const t = build({ items: [entityItem('i1', 'e1', 'Avery')], self: SELF });
      await t.service.resolveProposal(t.ctx({ autoLinkThreshold: 0.99, newThreshold: 0.5 }), 'kg.extract');
      expect(t.updates[0].resolution.score).toBeGreaterThanOrEqual(0.99);
    });

    it('does not touch another name, another type, or any name when no self is set', async () => {
      const other = entityItem('i1', 'e1', 'Jordan Example');
      const org = entityItem('i2', 'e2', 'Avery Example', { payload: { ref: 'e2', type: 'Organization', label: 'Avery Example', aliases: [], props: {} } });
      const withSelf = build({ items: [other, org], self: SELF });
      const stats = await withSelf.service.resolveProposal(withSelf.ctx(), 'kg.extract');
      expect(withSelf.candidates.forMention).toHaveBeenCalledTimes(2);
      expect(stats.self).toBeUndefined();
      const none = build({ items: [entityItem('i1', 'e1', 'Avery Example')], self: null });
      await none.service.resolveProposal(none.ctx(), 'kg.extract');
      expect(none.candidates.forMention).toHaveBeenCalledTimes(1);
    });
  });

  it('leaves the deterministic Meeting row as extraction decided it', async () => {
    const meeting = entityItem('m', 'meeting', 'Weekly', {
      payload: { ref: 'meeting', type: 'Meeting', label: 'Weekly', aliases: [], props: {} },
      resolution: { ref: MEETING, score: 1, source: 'meeting', candidates: [], adjudication: null },
    });
    const t = build({ items: [meeting] });
    await t.service.resolveProposal(t.ctx(), 'kg.extract');
    expect(t.updates).toHaveLength(0);
  });

  it('re-scores a model_claimed_match row like any other — the claim adds nothing', async () => {
    const claimed = entityItem('i1', 'k1', 'Sasha', {
      resolution: { ref: OTHER, score: null, source: 'model', candidates: [], adjudication: null },
      flags: ['model_claimed_match'],
    });
    const t = build({ items: [claimed], candidates: { Sasha: [raw(SASHA, { trigram: 0.5 })] } });
    await t.service.resolveProposal(t.ctx(), 'kg.extract');
    const u = t.updates[0];
    expect(u.resolution.ref).toBeNull(); // 0.467 < newThreshold: new, whatever the model claimed
    expect(u.resolution.source).toBeNull();
    expect(u.flags).toContain('model_claimed_match');
  });

  it('writes the same resolution under review_all — that mode only changes the pre-check', async () => {
    const items = () => [entityItem('i1', 'e1', 'Sasha Example')];
    const candidates = { 'Sasha Example': [raw(SASHA, { aliasExact: true })] };
    const a = build({ items: items(), candidates });
    const b = build({ items: items(), candidates });
    await a.service.resolveProposal(a.ctx(), 'kg.extract');
    await b.service.resolveProposal(b.ctx({ mode: 'review_all' }), 'kg.extract');
    expect(b.updates).toEqual(a.updates);
  });

  it('records why the vector arm was skipped, and still resolves by name', async () => {
    const t = build({
      items: [entityItem('i1', 'e1', 'Sasha Example')],
      candidates: { 'Sasha Example': [raw(SASHA, { aliasExact: true })] },
      embedder: { ok: false, reason: 'embedding_unsupported' },
    });
    const stats = await t.service.resolveProposal(t.ctx(), 'kg.extract');
    expect(stats.vectorArm).toBe('skipped:embedding_unsupported');
    expect(t.candidates.forMention.mock.calls[0][1]).toMatchObject({ vector: null });
  });

  it('passes a mention vector to the candidates when the caller can embed', async () => {
    const t = build({ items: [entityItem('i1', 'e1', 'Sasha Example')], embedder: { ok: true } });
    const stats = await t.service.resolveProposal(t.ctx(), 'kg.extract');
    expect(stats.vectorArm).toBe('ok');
    expect(t.candidates.forMention.mock.calls[0][1]).toMatchObject({ vector: { values: [0.1], model: 'emb' } });
  });

  it('adjudicates the middle band, and makes no provider call with adjudication off', async () => {
    const candidates = { 'S. Example': [raw(SASHA, { trigram: 0.85 })] }; // 0.7 → middle
    const on = build({
      items: [entityItem('i1', 'e1', 'S. Example')],
      candidates,
      adjudicate: jest.fn(async () => new Map([['p1', { verdict: 'uncertain', rationale: 'maybe', model: 'm' }]])),
    });
    const onStats = await on.service.resolveProposal(on.ctx(), 'kg.extract');
    expect(on.adjudication.adjudicate).toHaveBeenCalledTimes(1);
    expect(on.updates[0].resolution).toMatchObject({ ref: SASHA, adjudication: { verdict: 'uncertain' } });
    expect(on.updates[0].flags).toContain('possible_duplicate');
    expect(onStats).toMatchObject({ adjudicated: 1, uncertain: 1 });

    const off = build({ items: [entityItem('i1', 'e1', 'S. Example')], candidates });
    const offStats = await off.service.resolveProposal(off.ctx({ adjudication: 'off' }), 'kg.extract');
    expect(off.adjudication.adjudicate).not.toHaveBeenCalled();
    expect(off.updates[0].resolution.ref).toBeNull();
    expect(off.updates[0].flags).toEqual(['possible_duplicate']);
    expect(offStats.adjudication).toBe('off');
  });

  it('rethrows a rate limit from adjudication and degrades any other refusal', async () => {
    const candidates = { 'S. Example': [raw(SASHA, { trigram: 0.85 })] };
    const limited = build({
      items: [entityItem('i1', 'e1', 'S. Example')],
      candidates,
      adjudicate: jest.fn(async () => {
        throw new KvoxRateLimitError('ai-provider:u', undefined, '429');
      }),
    });
    await expect(limited.service.resolveProposal(limited.ctx(), 'kg.extract')).rejects.toBeInstanceOf(KvoxRateLimitError);

    const refused = build({
      items: [entityItem('i1', 'e1', 'S. Example')],
      candidates,
      adjudicate: jest.fn(async () => {
        throw new Error('graph off');
      }),
    });
    const stats = await refused.service.resolveProposal(refused.ctx(), 'kg.extract');
    expect(stats.adjudication).toBe('unavailable:Error');
    expect(refused.updates[0].flags).toEqual(['possible_duplicate']);
  });
});
