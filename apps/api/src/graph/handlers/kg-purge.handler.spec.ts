import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import type { PrismaService } from '../../prisma/prisma.service';
import { KG_PURGE_JOB_TYPE } from '../job-types';
import { emptyKgPurgeCounts, type KgPurgeService } from '../purge/kg-purge.service';
import {
  GRAPH_PERSON_FORGOTTEN_ACTION,
  GRAPH_PURGED_ACTION,
  KgPurgeHandler,
} from './kg-purge.handler';

// =============================================================================
// `kg.purge` handler (#357) — profile, server-only, payload handling, audit
// =============================================================================

const USER = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';
const TOMBSTONE = '33333333-3333-4333-8333-333333333333';

function harness() {
  const registry = new JobHandlerRegistry();
  const prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };
  const counts = {
    ...emptyKgPurgeCounts(),
    entities: 2,
    aliases: 3,
    relations: 2,
    items: 3,
    evidence: 15,
    mentions: 3,
    proposalItems: 6,
    merges: 1,
  };
  const purge = {
    purgePerson: jest.fn().mockResolvedValue({ counts, entityIds: [ENTITY, TOMBSTONE] }),
    purgeAll: jest.fn().mockResolvedValue(counts),
  };
  const handler = new KgPurgeHandler(
    registry,
    prisma as unknown as PrismaService,
    purge as unknown as KgPurgeService,
  );
  return { handler, registry, prisma, purge, counts };
}

const job = (payload: unknown) => ({ id: 'job-1', payload }) as never;

describe('KgPurgeHandler — registration and profile', () => {
  it('registers under kg.purge', () => {
    const { handler, registry } = harness();
    handler.onModuleInit();

    expect(handler.type).toBe(KG_PURGE_JOB_TYPE);
    expect(registry.get(KG_PURGE_JOB_TYPE)).toBe(handler);
  });

  it('declares { maxRuntimeMs: 1_800_000, maxAttempts: 1 } — never auto-retried', () => {
    const { handler } = harness();

    expect(handler.profile).toEqual({ maxRuntimeMs: 1_800_000, maxAttempts: 1 });
  });

  it('is server-only permanently — no node members, listed in serverOnlyTypes()', () => {
    const { handler, registry } = harness();
    handler.onModuleInit();

    const asRecord = handler as unknown as Record<string, unknown>;
    expect(asRecord.nodeResultSchema).toBeUndefined();
    expect(asRecord.persistNodeResult).toBeUndefined();
    expect(asRecord.nodeSecretBroker).toBeUndefined();
    expect(registry.serverOnlyTypes()).toContain(KG_PURGE_JOB_TYPE);
  });
});

describe('KgPurgeHandler.process', () => {
  it.each([
    ['null', null],
    ['an unknown scope', { userId: USER, scope: 'everything' }],
    ['person without an entity', { userId: USER, scope: 'person' }],
  ])('returns without throwing or deleting for an unreadable payload: %s', async (_label, payload) => {
    const { handler, purge, prisma } = harness();

    await expect(handler.process(job(payload))).resolves.toBeUndefined();
    expect(purge.purgePerson).not.toHaveBeenCalled();
    expect(purge.purgeAll).not.toHaveBeenCalled();
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it('forgets a person and audits graph.person_forgotten with counts and ids only', async () => {
    const { handler, purge, prisma } = harness();

    await handler.process(job({ userId: USER, scope: 'person', entityId: ENTITY }));

    expect(purge.purgePerson).toHaveBeenCalledWith(USER, ENTITY);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: USER,
        action: GRAPH_PERSON_FORGOTTEN_ACTION,
        targetType: 'kg_entity',
        targetId: ENTITY,
        meta: {
          entities: 2,
          aliases: 3,
          relations: 2,
          items: 3,
          evidence: 15,
          mentions: 3,
          proposalItems: 6,
          entityIds: [ENTITY, TOMBSTONE],
        },
      },
    });
  });

  it('writes no audit row when the person was not there to forget', async () => {
    const { handler, purge, prisma } = harness();
    purge.purgePerson.mockResolvedValue(null);

    await expect(handler.process(job({ userId: USER, scope: 'person', entityId: ENTITY }))).resolves.toBeUndefined();
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it('purges a whole graph and audits graph.purged against the user, with every count', async () => {
    const { handler, purge, prisma, counts } = harness();

    await handler.process(job({ userId: USER, scope: 'all' }));

    expect(purge.purgeAll).toHaveBeenCalledWith(USER);
    expect(purge.purgePerson).not.toHaveBeenCalled();
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: USER,
        action: GRAPH_PURGED_ACTION,
        targetType: 'user',
        targetId: USER,
        meta: { ...counts },
      },
    });
  });

  it('lets a purge failure fail the job — a destructive fan-out must surface', async () => {
    const { handler, purge, prisma } = harness();
    purge.purgeAll.mockRejectedValue(new Error('boom'));

    await expect(handler.process(job({ userId: USER, scope: 'all' }))).rejects.toThrow('boom');
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });
});
