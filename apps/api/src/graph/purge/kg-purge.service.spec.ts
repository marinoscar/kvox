import type { PrismaService } from '../../prisma/prisma.service';
import {
  chunk,
  KG_PURGE_ALL_PLAN,
  KG_PURGE_BATCH,
  KG_PURGE_MAX_BATCHES,
  KG_PURGE_PERSON_PLAN,
  KgPurgeService,
} from './kg-purge.service';

// =============================================================================
// KgPurgeService — the plan, the batching, the merged-set closure (#357)
// =============================================================================
//
// A recording fake Prisma: every delegate call, raw statement and transaction
// boundary is appended to one log, so the ORDER of statements — which the
// deferred no-orphans trigger makes load-bearing — is asserted directly.
// `test/graph/kg-purge.db.spec.ts` proves the same plan against real COMMITs.
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const P = '22222222-2222-4222-8222-222222222222';
const P_PRIME = '33333333-3333-4333-8333-333333333333';

type Responder = (args: unknown) => unknown;

/** Successive answers, then `rest` forever. */
function queue(values: unknown[], rest: unknown = []): Responder {
  const pending = [...values];
  return () => (pending.length > 0 ? pending.shift() : rest);
}

function defaultFor(op: string): unknown {
  if (op === 'findMany') return [];
  if (op === 'findUnique') return null;
  return { count: 0 };
}

function fakePrisma(responses: Record<string, Responder> = {}) {
  const log: string[] = [];
  const calls: Array<{ key: string; args: unknown }> = [];

  const make = (prefix: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, model: string | symbol) {
          if (typeof model !== 'string' || model === 'then') return undefined;
          if (model === '$transaction') {
            return async (fn: (tx: unknown) => Promise<unknown>) => {
              log.push('BEGIN');
              const result = await fn(make('tx.'));
              log.push('COMMIT');
              return result;
            };
          }
          if (model === '$queryRaw' || model === '$executeRaw') {
            return async (strings: TemplateStringsArray, ...values: unknown[]) => {
              const key = `${prefix}${model}`;
              log.push(key);
              calls.push({ key, args: { sql: strings.join('?'), values } });
              const responder = responses[model];
              return responder ? responder({ sql: strings.join('?'), values }) : model === '$queryRaw' ? [] : 0;
            };
          }
          return new Proxy(
            {},
            {
              get(_t, op: string | symbol) {
                if (typeof op !== 'string' || op === 'then') return undefined;
                return async (args: unknown) => {
                  const key = `${prefix}${model}.${op}`;
                  log.push(key);
                  calls.push({ key, args });
                  const responder = responses[`${model}.${op}`];
                  return responder ? responder(args) : defaultFor(op);
                };
              },
            },
          );
        },
      },
    );

  return { prisma: make('') as PrismaService, log, calls };
}

const person = { id: P, ownerId: USER, type: 'Person' };

/** Only writes and transaction boundaries — the part of the log the trigger cares about. */
const writes = (log: string[]) =>
  log.filter((l) => l === 'BEGIN' || l === 'COMMIT' || /deleteMany|updateMany|\$executeRaw/.test(l));

describe('chunk', () => {
  it('splits at the batch size', () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `id-${i}`);
    expect(chunk(ids).map((c) => c.length)).toEqual([500, 500, 201]);
    expect(KG_PURGE_BATCH).toBe(500);
  });

  it('returns nothing for nothing, and refuses a size below one', () => {
    expect(chunk([])).toEqual([]);
    expect(() => chunk(['a'], 0)).toThrow();
  });
});

describe('KgPurgeService.collectPersonSet — the merged-set closure', () => {
  it('collects the target plus every tombstone recursively merged into it, scoped to the owner', async () => {
    const { prisma, calls } = fakePrisma({
      'kgEntity.findUnique': () => person,
      // P ← P′ ← P″ (a tombstone of a tombstone), then nothing.
      'kgEntity.findMany': queue([[{ id: P_PRIME }], [{ id: 'p-double-prime' }], []]),
    });
    const service = new KgPurgeService(prisma);

    const set = await service.collectPersonSet(USER, P);

    expect(set).toEqual([P, P_PRIME, 'p-double-prime']);
    const closureQueries = calls.filter((c) => c.key === 'kgEntity.findMany').map((c) => c.args);
    expect(closureQueries[0]).toEqual({
      where: { ownerId: USER, mergedIntoId: { in: [P] } },
      select: { id: true },
    });
    expect(closureQueries[1]).toEqual({
      where: { ownerId: USER, mergedIntoId: { in: [P_PRIME] } },
      select: { id: true },
    });
  });

  it('terminates on a (never legitimate) merge cycle', async () => {
    const { prisma } = fakePrisma({
      'kgEntity.findUnique': () => person,
      'kgEntity.findMany': queue([[{ id: P_PRIME }], [{ id: P }]]),
    });

    await expect(new KgPurgeService(prisma).collectPersonSet(USER, P)).resolves.toEqual([P, P_PRIME]);
  });

  it.each([
    ['missing', null],
    ["another user's", { ...person, ownerId: '99999999-9999-4999-8999-999999999999' }],
    ['a non-Person', { ...person, type: 'Organization' }],
  ])('is null for a %s entity', async (_label, row) => {
    const { prisma } = fakePrisma({ 'kgEntity.findUnique': () => row });

    await expect(new KgPurgeService(prisma).collectPersonSet(USER, P)).resolves.toBeNull();
  });
});

describe('KgPurgeService.purgePerson', () => {
  it('declares its plan in the order the issue fixes', () => {
    expect(KG_PURGE_PERSON_PLAN).toEqual(['items', 'relations', 'entityRows', 'draftProposalItems', 'entities']);
  });

  it('runs items → relations → rows about the entities → draft proposal items → entities, evidence with its subject', async () => {
    const { prisma, log, calls } = fakePrisma({
      'kgEntity.findUnique': () => person,
      'kgEntity.findMany': queue([[{ id: P_PRIME }], []]),
      'kgItem.findMany': queue([[{ id: 'item-1' }]]),
      'kgRelation.findMany': queue([[{ id: 'rel-1' }]]),
      $queryRaw: queue([[{ id: 'draft-item-1' }]]),
    });

    const result = await new KgPurgeService(prisma).purgePerson(USER, P);

    expect(result?.entityIds).toEqual([P, P_PRIME]);
    expect(writes(log)).toEqual([
      // items: evidence, pointers onto them, then the items — one transaction
      'BEGIN',
      'tx.kgEvidence.deleteMany',
      'tx.kgItem.updateMany',
      'tx.kgItem.deleteMany',
      'COMMIT',
      // relations: the same shape
      'BEGIN',
      'tx.kgEvidence.deleteMany',
      'tx.kgRelation.updateMany',
      'tx.kgRelation.deleteMany',
      'COMMIT',
      // rows about the entities
      'BEGIN',
      'tx.kgEntityAlias.deleteMany',
      'tx.kgMention.deleteMany',
      'tx.kgEntityDigest.deleteMany',
      'tx.kgEntityView.deleteMany',
      'tx.kgMerge.deleteMany',
      'tx.kgDistinctPair.deleteMany',
      'COMMIT',
      // draft proposal items (BEFORE the entities, while merge_into_id still names them)
      'BEGIN',
      'tx.kgEvidence.deleteMany',
      'tx.kgProposalItem.deleteMany',
      'COMMIT',
      '$executeRaw', // strip distinct_from
      // the entities, with their own evidence
      'BEGIN',
      'tx.kgEvidence.deleteMany',
      'tx.kgEntity.deleteMany',
      'COMMIT',
    ]);

    const evidenceKinds = calls
      .filter((c) => c.key === 'tx.kgEvidence.deleteMany')
      .map((c) => (c.args as { where: { subjectKind: string } }).where.subjectKind);
    expect(evidenceKinds).toEqual(['item', 'relation', 'proposal_item', 'entity']);
  });

  it('selects items where the person is subject, owner or counterparty, and relations on either end', async () => {
    const { prisma, calls } = fakePrisma({
      'kgEntity.findUnique': () => person,
      'kgEntity.findMany': queue([[{ id: P_PRIME }], []]),
    });

    await new KgPurgeService(prisma).purgePerson(USER, P);

    const set = [P, P_PRIME];
    expect(calls.find((c) => c.key === 'kgItem.findMany')?.args).toEqual({
      where: {
        ownerId: USER,
        OR: [{ subjectId: { in: set } }, { ownerPersonId: { in: set } }, { counterpartyId: { in: set } }],
      },
      select: { id: true },
      take: KG_PURGE_BATCH,
    });
    expect(calls.find((c) => c.key === 'kgRelation.findMany')?.args).toEqual({
      where: { ownerId: USER, OR: [{ fromId: { in: set } }, { toId: { in: set } }] },
      select: { id: true },
      take: KG_PURGE_BATCH,
    });
  });

  it('only touches OPEN proposals, by every reference shape — merge_into_id, resolution, payload at any depth', async () => {
    const { prisma, calls } = fakePrisma({ 'kgEntity.findUnique': () => person });

    await new KgPurgeService(prisma).purgePerson(USER, P);

    const select = calls.find((c) => c.key === '$queryRaw')!.args as { sql: string; values: unknown[] };
    expect(select.sql).toContain('merge_into_id');
    expect(select.sql).toContain("resolution->>'ref'");
    expect(select.sql).toContain('$.candidates[*] ? (@.entityId == $id)');
    expect(select.sql).toContain('$.** ? (@.entityId == $id || @.existingEntityId == $id)');
    expect(select.sql).toContain('edited_payload');
    expect(select.values).toContainEqual(['draft', 'extracting']);
  });

  it('deletes the person set in transactions of at most 500 ids', async () => {
    const tombstones = Array.from({ length: 1200 }, (_, i) => ({ id: `tomb-${i}` }));
    const { prisma, calls } = fakePrisma({
      'kgEntity.findUnique': () => person,
      'kgEntity.findMany': queue([tombstones, []]),
    });

    await new KgPurgeService(prisma).purgePerson(USER, P);

    const sizes = calls
      .filter((c) => c.key === 'tx.kgEntity.deleteMany')
      .map((c) => (c.args as { where: { id: { in: string[] } } }).where.id.in.length);
    expect(sizes).toEqual([500, 500, 201]);
  });

  it('keeps draining a step until its selection comes back empty', async () => {
    const { prisma, calls } = fakePrisma({
      'kgEntity.findUnique': () => person,
      'kgItem.findMany': queue([[{ id: 'a' }], [{ id: 'b' }], []]),
    });

    await new KgPurgeService(prisma).purgePerson(USER, P);

    expect(calls.filter((c) => c.key === 'tx.kgItem.deleteMany')).toHaveLength(2);
  });

  it('is a no-op for a non-Person — no transaction, no delete', async () => {
    const { prisma, log } = fakePrisma({ 'kgEntity.findUnique': () => ({ ...person, type: 'Organization' }) });

    await expect(new KgPurgeService(prisma).purgePerson(USER, P)).resolves.toBeNull();
    expect(writes(log)).toEqual([]);
  });

  it('fails loudly, naming the step, when a selected row never goes away', async () => {
    const { prisma } = fakePrisma({
      'kgEntity.findUnique': () => person,
      'kgItem.findMany': () => [{ id: 'stuck' }],
    });

    await expect(new KgPurgeService(prisma).purgePerson(USER, P)).rejects.toThrow(
      `kg.purge step "items" did not converge after ${KG_PURGE_MAX_BATCHES} batches`,
    );
  });
});

describe('KgPurgeService.purgeAll', () => {
  it('declares its plan, with subject evidence riding along and a final evidence sweep', () => {
    expect(KG_PURGE_ALL_PLAN).toEqual([
      'mentions',
      'proposalItems',
      'proposals',
      'merges',
      'distinctPairs',
      'digests',
      'views',
      'items',
      'relations',
      'aliases',
      'entities',
      'evidence',
      'attributeDefs',
      'graphLayouts',
    ]);
  });

  it('deletes every table in plan order, evidence in the same transaction as its subject', async () => {
    const once = (row: unknown) => queue([[row]]);
    const { prisma, log, calls } = fakePrisma({
      'kgMention.findMany': once({ id: 'm' }),
      'kgProposalItem.findMany': once({ id: 'pi' }),
      'kgProposal.findMany': once({ id: 'pr' }),
      'kgMerge.findMany': once({ id: 'mg' }),
      'kgDistinctPair.findMany': once({ aId: 'a', bId: 'b' }),
      'kgEntityDigest.findMany': once({ entityId: 'e' }),
      'kgEntityView.findMany': once({ id: 'v' }),
      'kgItem.findMany': once({ id: 'i' }),
      'kgRelation.findMany': once({ id: 'r' }),
      'kgEntityAlias.findMany': once({ id: 'al' }),
      'kgEntity.findMany': once({ id: 'e' }),
      'kgEvidence.findMany': once({ id: 'ev' }),
      'kgAttributeDef.findMany': once({ id: 'ad' }),
    });

    await new KgPurgeService(prisma).purgeAll(USER);

    const deletes = writes(log).filter((l) => l !== 'BEGIN' && l !== 'COMMIT');
    expect(deletes).toEqual([
      'tx.kgMention.deleteMany',
      'tx.kgEvidence.deleteMany',
      'tx.kgProposalItem.deleteMany',
      'tx.kgProposal.deleteMany',
      'tx.kgMerge.deleteMany',
      'tx.kgDistinctPair.deleteMany',
      'tx.kgEntityDigest.deleteMany',
      'tx.kgEntityView.deleteMany',
      'tx.kgEvidence.deleteMany',
      'tx.kgItem.updateMany',
      'tx.kgItem.deleteMany',
      'tx.kgEvidence.deleteMany',
      'tx.kgRelation.updateMany',
      'tx.kgRelation.deleteMany',
      'tx.kgEntityAlias.deleteMany',
      'tx.kgEvidence.deleteMany',
      'tx.kgEntity.deleteMany',
      'tx.kgEvidence.deleteMany',
      'tx.kgAttributeDef.deleteMany',
      'kgGraphLayout.deleteMany',
    ]);
    // #371: the owner's layout snapshots go too, owner-scoped.
    expect(calls.find((c) => c.key === 'kgGraphLayout.deleteMany')?.args).toEqual({ where: { ownerId: USER } });

    // Owner-scoped selection everywhere; views by the VIEWER.
    expect(calls.find((c) => c.key === 'kgEntity.findMany')?.args).toMatchObject({ where: { ownerId: USER } });
    expect(calls.find((c) => c.key === 'kgEntityView.findMany')?.args).toMatchObject({ where: { userId: USER } });
    expect(calls.find((c) => c.key === 'kgProposalItem.findMany')?.args).toMatchObject({
      where: { proposal: { ownerId: USER } },
    });
    // A distinct pair has no id: it is deleted by its composite key.
    expect(calls.find((c) => c.key === 'tx.kgDistinctPair.deleteMany')?.args).toEqual({
      where: { ownerId: USER, OR: [{ aId: 'a', bId: 'b' }] },
    });
  });

  it('counts what each delete reports', async () => {
    const { prisma } = fakePrisma({
      'kgEntity.findMany': queue([[{ id: 'e1' }, { id: 'e2' }]]),
      'kgEntity.deleteMany': () => ({ count: 2 }),
      'kgEvidence.deleteMany': () => ({ count: 3 }),
    });

    const counts = await new KgPurgeService(prisma).purgeAll(USER);

    expect(counts.entities).toBe(2);
    expect(counts.evidence).toBe(3);
  });
});
