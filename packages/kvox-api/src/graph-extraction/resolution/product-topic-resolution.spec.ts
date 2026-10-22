import { GRAPH_PREFERENCE_DEFAULTS } from '../../graph/index.js';
import type { ProposalStageContext } from '../extraction/proposal-stage.js';
import { buildAdjudicationSystemPrompt } from './adjudication-prompt.js';
import type { RawCandidate } from './candidate.service.js';
import { ContextFeatureService, ORG_AFFILIATION_RELATIONS, emptyContext } from './context-features.service.js';
import { buildEntityProfileText } from './profile-text.js';
import { ResolutionService } from './resolution.service.js';
import { computeEffectiveSchema } from '@marinoscar/kvox-contract/ontology';

// =============================================================================
// Topic and Product take part in entity resolution (#665, epic #661)
// =============================================================================
//
// The product "Microsoft 365 Copilot" is already in the graph, OFFERED_BY
// Microsoft. Three notes name it three ways. The Product's vendor is the
// context feature that tells "Copilot" (a weak trigram match on its own) from
// an unrelated "Copilot": a vendor named in the same proposal lifts it into
// adjudication. The fakes stand in for Prisma, the candidate arms and the
// model; the scoring, context features and decisions are the real ones.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const PROPOSAL = '22222222-2222-4222-8222-222222222222';
const PRODUCT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MICROSOFT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_VENDOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TOPIC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

type Row = Record<string, any>;

const entityItem = (id: string, ref: string, type: string, label: string, props: Row = {}): Row => ({
  id,
  kind: 'entity',
  payload: { ref, type, label, aliases: [], props, occurredAt: null },
  resolution: null,
  flags: [],
  distinctFrom: [],
});

const raw = (entityId: string, type: string, label: string, over: Partial<RawCandidate> = {}): RawCandidate => ({
  entityId,
  label,
  type,
  aliasExact: false,
  trigram: null,
  cosine: null,
  ...over,
});

function build(options: { items: Row[]; candidates: Record<string, RawCandidate[]>; verdict?: 'same' | 'different' | 'uncertain' }) {
  const updates: Array<{ id: string; resolution: any; flags: string[] }> = [];
  const prisma = {
    kgProposalItem: {
      findMany: jest.fn(async () => options.items),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        updates.push({ id: where.id, resolution: data.resolution, flags: data.flags });
        return {};
      }),
    },
    kgEvidence: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    kgEntity: { findMany: jest.fn(async () => []) },
    // The graph: the Product is OFFERED_BY Microsoft; Microsoft is also known as "microsoft".
    kgRelation: {
      findMany: jest.fn(async () => [{ type: 'OFFERED_BY', fromId: PRODUCT, toId: MICROSOFT }]),
    },
    kgEntityAlias: {
      findMany: jest.fn(async () => [{ entityId: MICROSOFT, normalized: 'microsoft' }]),
    },
  };
  const candidates = {
    forMention: jest.fn(async (_owner: string, mention: { label: string }) => options.candidates[mention.label] ?? []),
  };
  const adjudicate = jest.fn(async (_u: string, pairs: Array<{ pairId: string }>) =>
    new Map(pairs.map((p) => [p.pairId, { verdict: options.verdict ?? 'same', rationale: 'same product, same vendor', model: 'm' }])),
  );
  const adjudication = {
    adjudicate,
    buildCandidateDossiers: jest.fn(async (_o: string, ids: string[]) =>
      new Map(ids.map((id) => [id, { entityId: id, label: 'Microsoft 365 Copilot', aliases: [], props: {}, quotes: [], neighbourhood: ['OFFERED_BY → Microsoft'] }])),
    ),
  };
  const embedder = { resolve: jest.fn(async () => ({ ok: false, reason: 'ai_key_missing' })) };
  const service = new ResolutionService(
    prisma as never,
    candidates as never,
    new ContextFeatureService(prisma as never),
    embedder as never,
    adjudication as never,
  );
  const ctx: ProposalStageContext = {
    proposalId: PROPOSAL,
    userId: USER,
    noteId: 'note',
    preferences: GRAPH_PREFERENCE_DEFAULTS,
    ai: null,
    prisma: prisma as never,
    stats: {},
  };
  return { service, ctx, updates, adjudicate };
}

const microsoftRow = () => entityItem('org', 'e2', 'Organization', 'Microsoft');

describe('Product resolution (#665)', () => {
  it('treats the vendor relation as an organization affiliation, like WORKS_FOR and HAS_ROLE', () => {
    expect(ORG_AFFILIATION_RELATIONS).toEqual(expect.arrayContaining(['WORKS_FOR', 'HAS_ROLE', 'OFFERED_BY']));
  });

  it('"Copilot", "M365 Copilot" and "Microsoft 365 Copilot" resolve to the one Product when OFFERED_BY Microsoft matches', async () => {
    const mentions = [
      { label: 'Microsoft 365 Copilot', arm: { aliasExact: true } },
      // A learned alias (an earlier accepted link) is an exact alias hit.
      { label: 'M365 Copilot', arm: { aliasExact: true } },
      // A weak name match on its own: trigram 0.5 scores 0.47, below the 0.55 new threshold.
      { label: 'Copilot', arm: { trigram: 0.5 } },
    ];
    for (const [i, mention] of mentions.entries()) {
      const t = build({
        items: [entityItem(`p${i}`, 'e1', 'Product', mention.label), microsoftRow()],
        candidates: { [mention.label]: [raw(PRODUCT, 'Product', 'Microsoft 365 Copilot', mention.arm)] },
      });
      await t.service.resolveProposal(t.ctx, 'kg.extract');
      const decision = t.updates.find((u) => u.id === `p${i}`)!;
      expect({ label: mention.label, ref: decision.resolution.ref }).toEqual({ label: mention.label, ref: PRODUCT });
      expect(decision.resolution.candidates[0].signals).toContain('org_co_mention');
    }
  });

  it('the vendor is what lifts "Copilot" into adjudication: without Microsoft in the proposal it is a new product', async () => {
    const candidates = { Copilot: [raw(PRODUCT, 'Product', 'Microsoft 365 Copilot', { trigram: 0.5 })] };
    const withVendor = build({ items: [entityItem('p', 'e1', 'Product', 'Copilot'), microsoftRow()], candidates });
    await withVendor.service.resolveProposal(withVendor.ctx, 'kg.extract');
    expect(withVendor.adjudicate).toHaveBeenCalledTimes(1);
    expect(withVendor.updates.find((u) => u.id === 'p')!.resolution).toMatchObject({ ref: PRODUCT, source: 'adjudication' });

    const alone = build({ items: [entityItem('p', 'e1', 'Product', 'Copilot')], candidates });
    await alone.service.resolveProposal(alone.ctx, 'kg.extract');
    expect(alone.adjudicate).not.toHaveBeenCalled();
    expect(alone.updates.find((u) => u.id === 'p')!.resolution).toMatchObject({ ref: null });
  });

  it("a Product's stated vendorName counts as the vendor named in the proposal, with no Organization row", async () => {
    const t = build({
      items: [entityItem('p', 'e1', 'Product', 'Copilot', { vendorName: 'Microsoft' })],
      candidates: { Copilot: [raw(PRODUCT, 'Product', 'Microsoft 365 Copilot', { trigram: 0.5 })] },
    });
    await t.service.resolveProposal(t.ctx, 'kg.extract');
    expect(t.updates[0].resolution).toMatchObject({ ref: PRODUCT });
    expect(t.updates[0].resolution.candidates[0].signals).toContain('org_co_mention');
  });

  it('a different vendor is no co-mention: the same weak name match stays new', async () => {
    const t = build({
      items: [entityItem('p', 'e1', 'Product', 'Copilot', { vendorName: 'Acme Software' })],
      candidates: { Copilot: [raw(PRODUCT, 'Product', 'Microsoft 365 Copilot', { trigram: 0.5 })] },
    });
    await t.service.resolveProposal(t.ctx, 'kg.extract');
    expect(t.updates[0].resolution.ref).toBeNull();
  });

  it('the adjudicator can still say a same-vendor product is different (Copilot vs another Microsoft product)', async () => {
    const t = build({
      items: [entityItem('p', 'e1', 'Product', 'Copilot Studio'), microsoftRow()],
      candidates: { 'Copilot Studio': [raw(PRODUCT, 'Product', 'Microsoft 365 Copilot', { trigram: 0.5 })] },
      verdict: 'different',
    });
    await t.service.resolveProposal(t.ctx, 'kg.extract');
    expect(t.updates.find((u) => u.id === 'p')!.resolution).toMatchObject({ ref: null, adjudication: { verdict: 'different' } });
  });

  it("the Product's embedding profile carries its vendor, so vector arm candidates agree on it", () => {
    expect(buildEntityProfileText({ type: 'Product', label: 'Microsoft 365 Copilot' }, { orgLabels: ['Microsoft'] })).toBe(
      'Product: Microsoft 365 Copilot\nOrganization: Microsoft',
    );
  });

  it('the context features report the vendor as an organization co-mention by id and by name', async () => {
    const prisma = {
      kgRelation: { findMany: jest.fn(async () => [{ type: 'OFFERED_BY', fromId: PRODUCT, toId: MICROSOFT }]) },
      kgEntityAlias: { findMany: jest.fn(async () => [{ entityId: MICROSOFT, normalized: 'microsoft' }]) },
      kgEvidence: { findMany: jest.fn(async () => []) },
    };
    const features = new ContextFeatureService(prisma as never);
    const byId = await features.features(USER, [PRODUCT], { ...emptyContext(), orgIds: new Set([MICROSOFT]) });
    expect(byId.get(PRODUCT)!.orgCoMention).toBe(true);
    const byName = await features.features(USER, [PRODUCT], { ...emptyContext(), orgNames: new Set(['microsoft']) });
    expect(byName.get(PRODUCT)!.orgCoMention).toBe(true);
    const none = await features.features(USER, [PRODUCT], { ...emptyContext(), orgIds: new Set([OTHER_VENDOR]) });
    expect(none.get(PRODUCT)!.orgCoMention).toBe(false);
  });
});

describe('Topic resolution (#665)', () => {
  it('"licence costs" is linked to the existing Topic "licensing cost" through adjudication', async () => {
    const t = build({
      items: [entityItem('t', 'e1', 'Topic', 'licence costs')],
      candidates: { 'licence costs': [raw(TOPIC, 'Topic', 'licensing cost', { trigram: 0.8 })] }, // 0.4 + 0.4 × (0.4/0.6) = 0.667 → middle
    });
    await t.service.resolveProposal(t.ctx, 'kg.extract');
    expect(t.adjudicate).toHaveBeenCalledTimes(1);
    expect(t.updates[0].resolution).toMatchObject({ ref: TOPIC, source: 'adjudication' });
  });

  it('only candidates of the same type are asked for: a Topic is never matched against a Product', async () => {
    const t = build({ items: [entityItem('t', 'e1', 'Topic', 'Copilot')], candidates: {} });
    await t.service.resolveProposal(t.ctx, 'kg.extract');
    expect(t.updates[0].resolution.ref).toBeNull();
  });

  it('the adjudicator is told to favour merging near-synonym Topics and to keep Products apart from their vendor', () => {
    const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });
    const types = ['Topic', 'Product'].map((key) => {
      const t = schema.entityType(key)!;
      return { key, label: t.label, description: t.description, disambiguation: t.disambiguation };
    });
    const prompt = buildAdjudicationSystemPrompt(types);
    expect(prompt).toContain('How to tell them apart — Topic');
    expect(prompt).toContain('Prefer reusing an existing Topic label over creating a near-synonym.');
    expect(prompt).toContain('How to tell them apart — Product');
    expect(prompt).toContain('The vendor company is an Organization linked by OFFERED_BY, never folded into the product label.');
  });
});
