import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { SynonymsService } from './synonyms.service.js';

const OWNER = '0a000000-0000-4000-8000-000000000001';
const OTHER = '0a000000-0000-4000-8000-000000000002';
const ID = '11111111-1111-4111-8111-111111111111';
const user = { id: OWNER, permissions: ['graph:read', 'graph:write'] } as never;
const row = (over: Record<string, unknown> = {}) => ({
  id: ID, ownerId: OWNER, terms: ['OAC', 'Org Alpha Consulting'], normalized: ['oac', 'org alpha consulting'], entityType: null,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'), ...over,
});

function harness(o: { count?: number; found?: ReturnType<typeof row> | null; types?: string[] } = {}) {
  const prisma = {
    kgSynonym: {
      count: jest.fn().mockResolvedValue(o.count ?? 0),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => row(data)),
      delete: jest.fn().mockResolvedValue(row()),
      findUnique: jest.fn().mockResolvedValue(o.found === undefined ? row() : o.found),
      findMany: jest.fn().mockResolvedValue([row()]),
    },
  };
  const types = o.types ?? ['Organization'];
  const ontology = { effectiveSchemaFor: jest.fn().mockResolvedValue({ entityType: (k: string) => (types.includes(k) ? { deprecated: false } : undefined) }) };
  return { prisma, service: new SynonymsService(prisma as never, ontology as never) };
}

describe('SynonymsService', () => {
  it('creates a group with normalized terms, owner-scoped', async () => {
    const { service, prisma } = harness();
    const out = await service.create({ terms: ['OAC', 'Org Alpha Consulting', 'oac'], entityType: 'Organization' }, user);
    expect(prisma.kgSynonym.create).toHaveBeenCalledWith({
      data: { ownerId: OWNER, terms: ['OAC', 'Org Alpha Consulting'], normalized: ['oac', 'org alpha consulting'], entityType: 'Organization' },
    });
    expect(out.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('400 synonyms_too_few when the terms collapse to one', async () => {
    const { service, prisma } = harness();
    await expect(service.create({ terms: ['OAC', 'oac'] }, user)).rejects.toMatchObject({ response: { details: { reason: 'synonyms_too_few' } } });
    expect(prisma.kgSynonym.create).not.toHaveBeenCalled();
  });

  it('400 for a term without letters and for an unknown entity type', async () => {
    const { service } = harness();
    await expect(service.create({ terms: ['OAC', '--'] }, user)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create({ terms: ['OAC', 'Org Alpha'], entityType: 'Nope' }, user)).rejects.toMatchObject({
      response: { details: { reason: 'unknown_entity_type' } },
    });
  });

  it('409 synonyms_limit at 500 groups', async () => {
    const { service } = harness({ count: 500 });
    const err = await service.create({ terms: ['a1', 'b1'] }, user).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.response.details.reason).toBe('synonyms_limit');
  });

  it('404, never 403, for another owner\'s or a missing group', async () => {
    await expect(harness({ found: row({ ownerId: OTHER }) }).service.remove(ID, user)).rejects.toBeInstanceOf(NotFoundException);
    await expect(harness({ found: null }).service.update(ID, { terms: ['a1', 'b1'] }, user)).rejects.toBeInstanceOf(NotFoundException);
    await expect(harness().service.remove('not-a-uuid', user)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates and deletes the owner\'s group', async () => {
    const { service, prisma } = harness();
    await service.update(ID, { terms: ['OZM', 'Org Zeta Metrics'], entityType: null }, user);
    expect(prisma.kgSynonym.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { terms: ['OZM', 'Org Zeta Metrics'], normalized: ['ozm', 'org zeta metrics'], entityType: null },
    });
    await service.remove(ID, user);
    expect(prisma.kgSynonym.delete).toHaveBeenCalledWith({ where: { id: ID } });
  });

  it('lists only the owner\'s groups', async () => {
    const { service, prisma } = harness();
    const out = await service.list(user);
    expect(prisma.kgSynonym.findMany.mock.calls[0][0].where).toEqual({ ownerId: OWNER });
    expect(out.groups[0].terms).toEqual(['OAC', 'Org Alpha Consulting']);
  });
});
