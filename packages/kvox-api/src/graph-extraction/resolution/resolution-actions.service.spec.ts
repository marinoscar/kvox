import { NotFoundException } from '@nestjs/common';

import { GraphResolutionController } from './graph-resolution.controller.js';
import { ResolutionActionsService } from './resolution-actions.service.js';

const OWNER = '0a000000-0000-4000-8000-000000000001';
const S = '0f000000-0000-4000-8000-00000000000b';
const user = { id: OWNER, permissions: ['graph:read', 'graph:write'] } as never;

function harness(survivor: Record<string, unknown> = { id: S, ownerId: OWNER, reviewStatus: 'accepted', mergedIntoId: null }) {
  const merges = [
    { id: 'm2', mergedId: 'e2', createdAt: new Date('2026-02-01T00:00:00Z'), reversedAt: null },
    { id: 'm1', mergedId: 'e1', createdAt: new Date('2026-01-01T00:00:00Z'), reversedAt: new Date('2026-01-02T00:00:00Z') },
  ];
  const prisma = {
    kgMerge: { findMany: jest.fn().mockResolvedValue(merges) },
    kgEntity: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'e1', label: 'Sasa', type: 'Person' },
        { id: 'e2', label: 'S. Example', type: 'Person' },
      ]),
    },
  };
  const access = { require: jest.fn().mockResolvedValue(survivor) };
  const service = new ResolutionActionsService(prisma as never, access as never, {} as never, {} as never, {} as never);
  return { service, prisma, access };
}

describe('ResolutionActionsService.listMerges', () => {
  it('lists merges newest first with reversibility, scoped to the owner', async () => {
    const { service, prisma, access } = harness();
    const out = await service.listMerges(S, user);
    expect(access.require).toHaveBeenCalledWith(OWNER, 'entity', S, 'view', expect.anything(), { includeMerged: true });
    expect(prisma.kgMerge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: OWNER, survivorId: S }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    );
    expect(out.merges).toEqual([
      { mergeId: 'm2', mergedEntity: { id: 'e2', label: 'S. Example', type: 'Person' }, createdAt: '2026-02-01T00:00:00.000Z', reversedAt: null, reversible: true },
      { mergeId: 'm1', mergedEntity: { id: 'e1', label: 'Sasa', type: 'Person' }, createdAt: '2026-01-01T00:00:00.000Z', reversedAt: '2026-01-02T00:00:00.000Z', reversible: false },
    ]);
  });

  it('marks nothing reversible when the survivor was merged since', async () => {
    const { service } = harness({ id: S, ownerId: OWNER, reviewStatus: 'merged', mergedIntoId: 'x' });
    const out = await service.listMerges(S, user);
    expect(out.merges.every((m) => m.reversible === false)).toBe(true);
  });

  it('returns an empty list without querying entities', async () => {
    const { service, prisma } = harness();
    prisma.kgMerge.findMany.mockResolvedValue([]);
    expect(await service.listMerges(S, user)).toEqual({ merges: [] });
    expect(prisma.kgEntity.findMany).not.toHaveBeenCalled();
  });

  it('propagates the access 404 (no access is never a 403)', async () => {
    const { service, access } = harness();
    access.require.mockRejectedValue(new NotFoundException('Entity not found'));
    await expect(service.listMerges(S, user)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GraphResolutionController.listMerges', () => {
  it('delegates to the actions service', async () => {
    const actions = { listMerges: jest.fn().mockResolvedValue({ merges: [] }) };
    const controller = new GraphResolutionController(actions as never);
    await expect(controller.listMerges(S, user)).resolves.toEqual({ merges: [] });
    expect(actions.listMerges).toHaveBeenCalledWith(S, user);
  });

  it('declares graph:read on GET entities/:id/merges', () => {
    const meta = (key: string) => Reflect.getMetadataKeys(GraphResolutionController.prototype.listMerges).includes(key);
    expect(Reflect.getMetadataKeys(GraphResolutionController.prototype.listMerges).length).toBeGreaterThan(0);
    expect(meta('path')).toBe(true);
  });
});
