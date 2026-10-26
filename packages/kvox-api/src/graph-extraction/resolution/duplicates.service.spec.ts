import { DuplicatesService } from './duplicates.service.js';
import { GraphDuplicatesController } from './graph-duplicates.controller.js';

const OWNER = '0a000000-0000-4000-8000-000000000001';
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const D = '00000000-0000-4000-8000-00000000000d';
const user = { id: OWNER, permissions: ['graph:read', 'graph:write'] } as never;

const ent = (id: string, type: string, label: string, aliases: string[] = []) => ({
  id,
  type,
  label,
  aliases: [label, ...aliases].map((alias) => ({ alias, normalized: alias.toLowerCase() })),
});

interface Opts {
  entities?: ReturnType<typeof ent>[];
  trigram?: Array<{ a_id: string; b_id: string; sim: number }>;
  items?: Array<Record<string, unknown>>;
  distinct?: Array<{ aId: string; bId: string }>;
  mentions?: Array<{ entityId: string; _count: { _all: number } }>;
  enqueue?: { id: string; deduplicated: boolean };
  graphEnabled?: boolean;
}

function harness(o: Opts = {}) {
  const entities = o.entities ?? [];
  const tx = { $queryRaw: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(o.trigram ?? []) };
  const prisma = {
    kgEntity: {
      findMany: jest.fn(async (args: { take?: number; where: { id?: unknown } }) =>
        (args.take ? entities : entities.filter((e) => (args.where.id as { in: string[] }).in.includes(e.id))).map(({ id, type, label }) => ({ id, type, label })),
      ),
    },
    kgEntityAlias: {
      findMany: jest.fn(async (args: { where: { entityId: { in: string[] } } }) =>
        entities.filter((e) => args.where.entityId.in.includes(e.id)).flatMap((e) => e.aliases.map((a) => ({ entityId: e.id, ...a }))),
      ),
    },
    kgProposalItem: { findMany: jest.fn().mockResolvedValue(o.items ?? []) },
    kgDistinctPair: { findMany: jest.fn().mockResolvedValue(o.distinct ?? []) },
    kgMention: { groupBy: jest.fn().mockResolvedValue(o.mentions ?? []) },
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };
  const jobs = { enqueue: jest.fn().mockResolvedValue(o.enqueue ?? { id: 'job-1', deduplicated: false }) };
  const resolver = { graphEnabled: jest.fn().mockResolvedValue(o.graphEnabled ?? true) };
  const service = new DuplicatesService(prisma as never, jobs as never, resolver as never);
  return { service, prisma, jobs, tx };
}

describe('DuplicatesService.list', () => {
  it('returns name pairs with aliases, mention counts and a deterministic score', async () => {
    const { service, prisma } = harness({
      entities: [ent(A, 'Person', 'Oscar', ['Oz']), ent(B, 'Person', 'Oscar Marin'), ent(C, 'Organization', 'EY'), ent(D, 'Organization', 'Ernst & Young')],
      mentions: [{ entityId: A, _count: { _all: 4 } }],
    });
    const out = await service.list(user, { limit: 50 });
    expect(out.pairs.map((p) => [p.a.label, p.b.label, p.score, p.reasons, p.source])).toEqual([
      ['Oscar', 'Oscar Marin', 0.8, ['name_contained'], 'name_pass'],
      ['EY', 'Ernst & Young', 0.75, ['initials'], 'name_pass'],
    ]);
    expect(out.pairs[0].a).toEqual({ id: A, type: 'Person', label: 'Oscar', aliases: ['Oz'], mentionCount: 4 });
    expect(out.pairs[0].b.mentionCount).toBe(0);
    expect(prisma.kgEntity.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ ownerId: OWNER, mergedIntoId: null, reviewStatus: { in: ['accepted', 'edited'] } }),
    );
  });

  it('merges a trigram hit with a name signal and takes the higher base', async () => {
    const { service } = harness({
      entities: [ent(A, 'Person', 'Oscar'), ent(B, 'Person', 'Oscar Marin')],
      trigram: [{ a_id: A, b_id: B, sim: 0.9 }],
    });
    const [pair] = (await service.list(user, { limit: 50 })).pairs;
    expect(pair.reasons).toEqual(['name_contained', 'similar_name']);
    expect(pair.score).toBe(0.95);
  });

  it('drops a pair the owner marked distinct, and any pair with a missing or non-live side', async () => {
    const { service } = harness({
      entities: [ent(A, 'Person', 'Oscar'), ent(B, 'Person', 'Oscar Marin')],
      trigram: [{ a_id: A, b_id: C, sim: 0.7 }],
      distinct: [{ aId: A, bId: B }],
    });
    expect((await service.list(user, { limit: 50 })).pairs).toEqual([]);
  });

  it('maps open resolution proposal items and merges them with a name pair', async () => {
    const { service } = harness({
      entities: [ent(A, 'Person', 'Oscar'), ent(B, 'Person', 'Oscar Marin'), ent(C, 'Person', 'Sara Chen'), ent(D, 'Person', 'S. Chen')],
      items: [
        { id: 'i1', payload: { existingEntityId: B }, resolution: { ref: A, score: 0.9, candidates: [] }, mergeIntoId: null },
        { id: 'i2', payload: { existingEntityId: C }, resolution: { ref: null, score: null, candidates: [{ entityId: D, score: 0.66 }] }, mergeIntoId: null },
        { id: 'i3', payload: {}, resolution: null, mergeIntoId: null },
      ],
    });
    const { pairs } = await service.list(user, { limit: 50 });
    const oscar = pairs.find((p) => p.a.id === A)!;
    expect(oscar).toMatchObject({ source: 'resolution_proposal', proposalItemId: 'i1', reasons: ['name_contained', 'resolution_proposal'], score: 0.95 });
    const sara = pairs.find((p) => p.a.id === C)!;
    expect(sara).toMatchObject({ source: 'resolution_proposal', proposalItemId: 'i2', reasons: ['resolution_proposal'], score: 0.7 });
    expect(pairs).toHaveLength(2);
  });

  it('filters by type, sorts best first and applies the limit', async () => {
    const { service, tx } = harness({
      entities: [ent(A, 'Person', 'Oscar'), ent(B, 'Person', 'Oscar Marin'), ent(C, 'Person', 'Sara Chen'), ent(D, 'Person', 'Sara Chen Jr')],
      trigram: [{ a_id: C, b_id: D, sim: 0.98 }],
    });
    const out = await service.list(user, { type: 'Person', limit: 1 });
    expect(out.pairs).toHaveLength(1);
    expect(out.pairs[0].a.label).toBe('Sara Chen');
    expect(out.pairs[0].score).toBeGreaterThanOrEqual(0.8);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('is empty for an empty graph', async () => {
    expect((await harness().service.list(user, { limit: 50 })).pairs).toEqual([]);
  });
});

describe('DuplicatesService.scan', () => {
  it('enqueues kg.resolve with reason manual for the owner', async () => {
    const { service, jobs } = harness();
    expect(await service.scan(user)).toEqual({ queued: true, alreadyRunning: false, jobId: 'job-1' });
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'kg.resolve',
        subjectType: 'user',
        subjectId: OWNER,
        payload: { userId: OWNER, scope: 'all', reason: 'manual' },
      }),
    );
  });

  it('joins a run already in flight instead of failing', async () => {
    const { service } = harness({ enqueue: { id: 'job-0', deduplicated: true } });
    expect(await service.scan(user)).toEqual({ queued: true, alreadyRunning: true, jobId: 'job-0' });
  });

  it('refuses while connected knowledge is off', async () => {
    const { service, jobs } = harness({ graphEnabled: false });
    await expect(service.scan(user)).rejects.toBeDefined();
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe('GraphDuplicatesController', () => {
  it('delegates and declares its permissions', () => {
    const duplicates = { list: jest.fn().mockResolvedValue({ pairs: [] }), scan: jest.fn().mockResolvedValue({ queued: true }) };
    const controller = new GraphDuplicatesController(duplicates as never);
    void controller.list({ limit: 5 }, user);
    void controller.scan(user);
    expect(duplicates.list).toHaveBeenCalledWith(user, { limit: 5 });
    expect(duplicates.scan).toHaveBeenCalledWith(user);
    expect(Reflect.getMetadataKeys(GraphDuplicatesController.prototype.list).length).toBeGreaterThan(0);
    expect(Reflect.getMetadataKeys(GraphDuplicatesController.prototype.scan).length).toBeGreaterThan(0);
  });
});
