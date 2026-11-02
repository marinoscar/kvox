import { NotFoundException } from '@nestjs/common';

import { GRAPH_NOT_FOUND_MESSAGES } from '../access/graph-access.service.js';
import { GraphReadService } from './graph-read.service.js';

// =============================================================================
// GraphReadService.getEntity: a merged tombstone is admitted (200, survivor id)
// so the page can redirect; a live entity carries mergedIntoId null; an
// unreviewed or rejected entity stays a 404. Mocked Prisma and access.
// =============================================================================

const USER = '00000000-0000-4000-8000-0000000000aa';
const ENTITY = '00000000-0000-4000-8000-000000000001';
const SURVIVOR = '00000000-0000-4000-8000-000000000002';
const CREATED = new Date('2026-09-01T00:00:00.000Z');

function row(over: Record<string, unknown>) {
  return {
    id: ENTITY,
    ownerId: USER,
    type: 'Person',
    label: 'Sasha',
    props: { title: 'CTO' },
    occurredAt: null,
    reviewStatus: 'accepted',
    mergedIntoId: null,
    ontologyVersion: '1.0.0',
    createdAt: CREATED,
    updatedAt: CREATED,
    ...over,
  };
}

function build(entity: Record<string, unknown> | null) {
  const require = jest.fn(async (_u: string, _k: string, _id: string, _a: string, _x?: unknown, opts?: { includeMerged?: boolean }) => {
    if (!entity) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);
    const status = entity.reviewStatus as string;
    const merged = status === 'merged' || entity.mergedIntoId != null;
    if (merged && !opts?.includeMerged) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);
    if (status === 'unreviewed' || status === 'rejected') throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);
    return entity;
  });
  const queryRaw = jest.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('FROM kg_mentions')) return [];
    if (sql.includes('min(x.at)')) return [];
    if (sql.includes('GROUP BY r.type')) return [];
    return [{ relations: 0, evidence: 0, commitment: 0, decision: 0, claim: 0, person_fact: 0, risk: 0, open_commitments: 0 }];
  });
  const prisma = { kgEntityAlias: { findMany: jest.fn(async () => []) }, $queryRaw: queryRaw };
  const service = new GraphReadService(prisma as never, { require } as never, {} as never, {} as never, {} as never);
  return { service, require, prisma };
}

describe('GraphReadService.getEntity', () => {
  it('returns a merged tombstone as 200 pointing at the survivor, with empty aliases and zero counts', async () => {
    const { service, require, prisma } = build(row({ reviewStatus: 'merged', mergedIntoId: SURVIVOR }));
    const out = await service.getEntity({ id: USER } as never, ENTITY);
    expect(out).toMatchObject({
      id: ENTITY,
      reviewStatus: 'merged',
      mergedIntoId: SURVIVOR,
      aliases: [],
      firstSeenAt: null,
      lastSeenAt: null,
    });
    expect(out.counts).toMatchObject({ relations: 0, mentions: 0, evidence: 0, openCommitments: 0, relationsByType: {}, relationsByNeighborType: {} });
    expect(require).toHaveBeenCalledWith(USER, 'entity', ENTITY, 'view', undefined, { includeMerged: true });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns a live entity with mergedIntoId null', async () => {
    const { service } = build(row({ reviewStatus: 'accepted' }));
    const out = await service.getEntity({ id: USER } as never, ENTITY);
    expect(out.reviewStatus).toBe('accepted');
    expect(out.mergedIntoId).toBeNull();
  });

  it.each(['unreviewed', 'rejected'])('keeps a %s entity a 404', async (reviewStatus) => {
    const { service } = build(row({ reviewStatus }));
    await expect(service.getEntity({ id: USER } as never, ENTITY)).rejects.toBeInstanceOf(NotFoundException);
  });
});
