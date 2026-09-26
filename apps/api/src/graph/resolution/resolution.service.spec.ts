import { RateLimitError } from '../../jobs/rate-limit.error';
import { GRAPH_PREFERENCE_DEFAULTS, type GraphPreferences } from '../preferences/graph-preferences.defaults';
import type { ProposalStageContext } from '../extraction/proposal-stage';
import type { RawCandidate } from './candidate.service';
import { decide, ResolutionService, type MentionOutcome } from './resolution.service';

const USER = '11111111-1111-4111-8111-111111111111';
const PROPOSAL = '22222222-2222-4222-8222-222222222222';
const TRANSCRIPT = '33333333-3333-4333-8333-333333333333';
const SARAH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MEETING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const thresholds = GRAPH_PREFERENCE_DEFAULTS.resolution;

describe('decide (outcome bands)', () => {
  const outcome = (score: number, band: MentionOutcome['band'], ambiguous = false): MentionOutcome => ({
    candidates: [{ entityId: SARAH, label: 'Sarah Chen', type: 'Person', score, signals: ['alias_exact'], arm: 'alias_exact' }],
    ambiguous,
    band,
  });
  const verdict = (v: 'same' | 'different' | 'uncertain') => ({ verdict: v, rationale: 'why', model: 'm' });

  it('links the top candidate at or above auto-link, sourced from its arm', () => {
    const d = decide(outcome(0.95, 'link'), thresholds, null);
    expect(d.resolution).toMatchObject({ ref: SARAH, score: 0.95, source: 'alias', adjudication: null });
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
      resolution: { ref: SARAH, score: 0.9, source: 'adjudication', adjudication: { verdict: 'same' } },
      flags: [],
    });
    expect(decide(outcome(0.7, 'middle'), thresholds, verdict('different')).resolution).toMatchObject({ ref: null, adjudication: { verdict: 'different' } });
    const uncertain = decide(outcome(0.7, 'middle'), thresholds, verdict('uncertain'));
    expect(uncertain.resolution.ref).toBe(SARAH);
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
    transcriptSpeaker: { findMany: jest.fn(async () => [{ id: 'spk-a', label: 'A', displayName: 'Sarah Chen' }]) },
    kgRelation: { findMany: jest.fn(async () => [{ fromSpeakerId: 'spk-a', toId: SARAH }]) },
    kgEntity: {
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        where.reviewStatus ? [{ id: SARAH }] : [],
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
  const throttle = { registerProviderKey: jest.fn() };
  const service = new ResolutionService(
    prisma as never,
    candidates as never,
    features as never,
    embedder as never,
    adjudication as never,
    throttle as never,
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
  return { service, ctx, updates, candidates, adjudication, embedder, throttle };
}

const raw = (entityId: string, over: Partial<RawCandidate> = {}): RawCandidate => ({
  entityId,
  label: 'Sarah Chen',
  type: 'Person',
  aliasExact: false,
  trigram: null,
  cosine: null,
  ...over,
});

describe('ResolutionService.resolveProposal', () => {
  it('links a speaker-identified Person without scoring it', async () => {
    const t = build({ items: [entityItem('i1', 'e1', 'sarah chen')], speakerLinked: true });
    const stats = await t.service.resolveProposal(t.ctx(), 'kg.extract');
    expect(t.updates[0].resolution).toMatchObject({ ref: SARAH, score: 1, source: 'speaker', candidates: [] });
    expect(t.candidates.forMention).not.toHaveBeenCalled();
    expect(stats).toMatchObject({ entities: 1, linked: 1, speaker: 1 });
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
    const claimed = entityItem('i1', 'k1', 'Sarah', {
      resolution: { ref: OTHER, score: null, source: 'model', candidates: [], adjudication: null },
      flags: ['model_claimed_match'],
    });
    const t = build({ items: [claimed], candidates: { Sarah: [raw(SARAH, { trigram: 0.5 })] } });
    await t.service.resolveProposal(t.ctx(), 'kg.extract');
    const u = t.updates[0];
    expect(u.resolution.ref).toBeNull(); // 0.467 < newThreshold: new, whatever the model claimed
    expect(u.resolution.source).toBeNull();
    expect(u.flags).toContain('model_claimed_match');
  });

  it('writes the same resolution under review_all — that mode only changes the pre-check', async () => {
    const items = () => [entityItem('i1', 'e1', 'Sarah Chen')];
    const candidates = { 'Sarah Chen': [raw(SARAH, { aliasExact: true })] };
    const a = build({ items: items(), candidates });
    const b = build({ items: items(), candidates });
    await a.service.resolveProposal(a.ctx(), 'kg.extract');
    await b.service.resolveProposal(b.ctx({ mode: 'review_all' }), 'kg.extract');
    expect(b.updates).toEqual(a.updates);
  });

  it('records why the vector arm was skipped, and still resolves by name', async () => {
    const t = build({
      items: [entityItem('i1', 'e1', 'Sarah Chen')],
      candidates: { 'Sarah Chen': [raw(SARAH, { aliasExact: true })] },
      embedder: { ok: false, reason: 'embedding_unsupported' },
    });
    const stats = await t.service.resolveProposal(t.ctx(), 'kg.extract');
    expect(stats.vectorArm).toBe('skipped:embedding_unsupported');
    expect(t.candidates.forMention.mock.calls[0][1]).toMatchObject({ vector: null });
  });

  it('passes a mention vector to the candidates when the caller can embed, registering the throttle key first', async () => {
    const t = build({ items: [entityItem('i1', 'e1', 'Sarah Chen')], embedder: { ok: true } });
    const stats = await t.service.resolveProposal(t.ctx(), 'kg.extract');
    expect(stats.vectorArm).toBe('ok');
    expect(t.throttle.registerProviderKey).toHaveBeenCalledWith('kg.extract', `ai-provider:${USER}`);
    expect(t.candidates.forMention.mock.calls[0][1]).toMatchObject({ vector: { values: [0.1], model: 'emb' } });
  });

  it('adjudicates the middle band, and makes no provider call with adjudication off', async () => {
    const candidates = { 'S. Chen': [raw(SARAH, { trigram: 0.85 })] }; // 0.7 → middle
    const on = build({
      items: [entityItem('i1', 'e1', 'S. Chen')],
      candidates,
      adjudicate: jest.fn(async () => new Map([['p1', { verdict: 'uncertain', rationale: 'maybe', model: 'm' }]])),
    });
    const onStats = await on.service.resolveProposal(on.ctx(), 'kg.extract');
    expect(on.adjudication.adjudicate).toHaveBeenCalledTimes(1);
    expect(on.updates[0].resolution).toMatchObject({ ref: SARAH, adjudication: { verdict: 'uncertain' } });
    expect(on.updates[0].flags).toContain('possible_duplicate');
    expect(onStats).toMatchObject({ adjudicated: 1, uncertain: 1 });

    const off = build({ items: [entityItem('i1', 'e1', 'S. Chen')], candidates });
    const offStats = await off.service.resolveProposal(off.ctx({ adjudication: 'off' }), 'kg.extract');
    expect(off.adjudication.adjudicate).not.toHaveBeenCalled();
    expect(off.updates[0].resolution.ref).toBeNull();
    expect(off.updates[0].flags).toEqual(['possible_duplicate']);
    expect(offStats.adjudication).toBe('off');
  });

  it('rethrows a rate limit from adjudication and degrades any other refusal', async () => {
    const candidates = { 'S. Chen': [raw(SARAH, { trigram: 0.85 })] };
    const limited = build({
      items: [entityItem('i1', 'e1', 'S. Chen')],
      candidates,
      adjudicate: jest.fn(async () => {
        throw new RateLimitError('429');
      }),
    });
    await expect(limited.service.resolveProposal(limited.ctx(), 'kg.extract')).rejects.toBeInstanceOf(RateLimitError);

    const refused = build({
      items: [entityItem('i1', 'e1', 'S. Chen')],
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
