import { computeEffectiveSchema } from '@app/shared/ontology';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service';
import type { GraphAccessService } from '../access/graph-access.service';
import type { GraphOntologyService } from '../ontology/graph-ontology.service';
import {
  ATTRIBUTE_DEF_AUDIT_ACTIONS,
  generateAttributeKey,
  GraphAttributeDefsService,
  MAX_LIVE_ATTRIBUTE_DEFS_PER_TYPE,
} from './graph-attribute-defs.service';

const OWNER = '11111111-1111-4111-8111-111111111111';
const DEF = '22222222-2222-4222-8222-222222222222';
const user = { id: OWNER, permissions: ['graph:read', 'graph:write'] } as never;
const schema = computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] });

const row = (overrides: Record<string, unknown> = {}) => ({
  id: DEF,
  ownerId: OWNER,
  entityType: 'Person',
  key: 'u_abcdefghij',
  label: 'Tier',
  kind: 'select',
  options: { choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  extractable: false,
  extractionHint: null,
  sensitivity: null,
  sortOrder: 0,
  deprecatedAt: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  ...overrides,
});

function setup(current = row()) {
  const prisma = {
    kgAttributeDef: {
      findMany: jest.fn(async (_args: { where: Record<string, unknown> }) => [current]),
      count: jest.fn(async () => 0),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => row({ ...data })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => row({ ...current, ...data })),
    },
    auditEvent: { create: jest.fn(async (_args: { data: Record<string, unknown> }) => ({})) },
  };
  const access = { require: jest.fn(async () => current) };
  const ontology = { effectiveSchemaFor: jest.fn(async () => schema) };
  const service = new GraphAttributeDefsService(
    prisma as unknown as PrismaService,
    access as unknown as GraphAccessService,
    ontology as unknown as GraphOntologyService,
  );
  return { service, prisma, access };
}

async function details(promise: Promise<unknown>) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  return (err as BadRequestException).getResponse() as { message: string; details?: Record<string, unknown> };
}

describe('generateAttributeKey', () => {
  it('is u_ plus ten lowercase alphanumerics, and random', () => {
    const keys = new Set(Array.from({ length: 50 }, generateAttributeKey));
    for (const key of keys) expect(key).toMatch(/^u_[a-z0-9]{10}$/);
    expect(keys.size).toBe(50);
  });
});

describe('GraphAttributeDefsService', () => {
  describe('list', () => {
    it('lists own live rows by default, ordered by (entityType, sortOrder, createdAt)', async () => {
      const { service, prisma } = setup();
      await service.list(OWNER, {});
      expect(prisma.kgAttributeDef.findMany).toHaveBeenCalledWith({
        where: { ownerId: OWNER, deprecatedAt: null },
        orderBy: [{ entityType: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
    });

    it('filters by entity type and can include deprecated rows', async () => {
      const { service, prisma } = setup();
      await service.list(OWNER, { entityType: 'Person', includeDeprecated: true });
      expect(prisma.kgAttributeDef.findMany.mock.calls[0][0]).toMatchObject({
        where: { ownerId: OWNER, entityType: 'Person' },
      });
      expect(prisma.kgAttributeDef.findMany.mock.calls[0][0].where).not.toHaveProperty('deprecatedAt');
    });
  });

  describe('create', () => {
    const base = { entityType: 'Person', label: 'Nickname', kind: 'text' as const, extractable: false };

    it('generates a u_ key, stores no options for a text attribute, and audits keys only', async () => {
      const { service, prisma } = setup();
      const dto = await service.create(base, user);
      expect(dto.key).toMatch(/^u_[a-z0-9]{10}$/);
      expect(prisma.kgAttributeDef.create.mock.calls[0][0].data).toMatchObject({ ownerId: OWNER, kind: 'text' });
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: ATTRIBUTE_DEF_AUDIT_ACTIONS.created,
          targetType: 'kg_attribute_def',
          meta: { entityType: 'Person', key: dto.key, kind: 'text' },
        }),
      });
    });

    it.each([
      ['an entity type outside the schema', { ...base, entityType: 'Spaceship' }],
      ['a select with no choices', { ...base, kind: 'select' as const }],
      ['an entity_ref with no target types', { ...base, kind: 'entity_ref' as const, options: {} }],
      ['an entity_ref targeting an item type', { ...base, kind: 'entity_ref' as const, options: { targetTypes: ['Claim'] } }],
      ['options for a text attribute', { ...base, options: { choices: [{ value: 'a', label: 'A' }] } }],
      ['extractable without a hint', { ...base, extractable: true }],
    ])('refuses %s', async (_name, dto) => {
      const { service, prisma } = setup();
      await details(service.create(dto, user));
      expect(prisma.kgAttributeDef.create).not.toHaveBeenCalled();
    });

    it(`refuses a ${MAX_LIVE_ATTRIBUTE_DEFS_PER_TYPE + 1}st live definition on one type`, async () => {
      const { service, prisma } = setup();
      prisma.kgAttributeDef.count.mockResolvedValue(MAX_LIVE_ATTRIBUTE_DEFS_PER_TYPE);
      await details(service.create(base, user));
    });
  });

  describe('update', () => {
    it('refuses removing a choice, naming it', async () => {
      const { service } = setup();
      const res = await details(
        service.update(DEF, { options: { choices: [{ value: 'a', label: 'Alpha' }] } }, user),
      );
      expect(res.details).toEqual({ removedChoices: ['b'] });
    });

    it('allows adding and relabelling choices', async () => {
      const { service, prisma } = setup();
      await service.update(
        DEF,
        { options: { choices: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }] } },
        user,
      );
      expect(prisma.kgAttributeDef.update.mock.calls[0][0].data.options).toEqual({
        choices: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C' },
        ],
      });
    });

    it('deprecates with deprecated: true (audited as deprecated) and restores with false', async () => {
      const { service, prisma } = setup();
      await service.update(DEF, { deprecated: true }, user);
      expect(prisma.kgAttributeDef.update.mock.calls[0][0].data.deprecatedAt).toBeInstanceOf(Date);
      expect(prisma.auditEvent.create.mock.calls[0][0].data.action).toBe(ATTRIBUTE_DEF_AUDIT_ACTIONS.deprecated);

      const restored = setup(row({ deprecatedAt: new Date() }));
      await restored.service.update(DEF, { deprecated: false }, user);
      expect(restored.prisma.kgAttributeDef.update.mock.calls[0][0].data.deprecatedAt).toBeNull();
    });

    it('refuses turning extraction on without a hint', async () => {
      const { service } = setup();
      await details(service.update(DEF, { extractable: true }, user));
    });

    it("passes through the access service's 404", async () => {
      const { service, access } = setup();
      access.require.mockRejectedValue(new NotFoundException('Attribute definition not found'));
      await expect(service.update(DEF, { label: 'X' }, user)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deprecate', () => {
    it('sets deprecatedAt and audits once', async () => {
      const { service, prisma } = setup();
      const dto = await service.deprecate(DEF, user);
      expect(dto.deprecatedAt).not.toBeNull();
      expect(prisma.auditEvent.create).toHaveBeenCalledTimes(1);
    });

    it('is idempotent: an already-deprecated definition is returned unchanged', async () => {
      const at = new Date('2026-09-10T00:00:00Z');
      const { service, prisma } = setup(row({ deprecatedAt: at }));
      const dto = await service.deprecate(DEF, user);
      expect(dto.deprecatedAt).toBe(at.toISOString());
      expect(prisma.kgAttributeDef.update).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });
  });
});
