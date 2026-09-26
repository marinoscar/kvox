import { Test } from '@nestjs/testing';
import { ONTOLOGY_VERSION } from '@app/shared/ontology';

import { PrismaService } from '../../prisma/prisma.service';
import { GraphPreferencesService } from '../preferences/graph-preferences.service';
import { graphOntologyResponseSchema } from '../dto/graph-ontology.dto';
import { GraphOntologyService, toUserAttributeDef } from './graph-ontology.service';

// =============================================================================
// GraphOntologyService (#354, epic #344, docs/specs/ontology.md §17.2–§17.4)
// =============================================================================

const OWNER = '11111111-1111-4111-8111-111111111111';

const attributeDefRow = (overrides: Record<string, unknown> = {}) => ({
  id: '55555555-5555-4555-8555-555555555555',
  ownerId: OWNER,
  entityType: 'Person',
  key: 'u_favcolour1',
  label: 'Favourite colour',
  kind: 'text',
  options: null,
  extractable: false,
  extractionHint: null,
  sensitivity: null,
  sortOrder: 0,
  deprecatedAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  ...overrides,
});

describe('GraphOntologyService', () => {
  let service: GraphOntologyService;
  let prisma: {
    kgAttributeDef: { findMany: jest.Mock };
    userSettings: { findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      kgAttributeDef: { findMany: jest.fn().mockResolvedValue([]) },
      // No `user_settings` row: every graph preference is its default.
      userSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    const module = await Test.createTestingModule({
      providers: [
        GraphOntologyService,
        GraphPreferencesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(GraphOntologyService);
  });

  it('defaults to core + work', async () => {
    const schema = await service.effectiveSchemaFor(OWNER);

    expect(schema.enabledDomains).toEqual(['core', 'work']);

    const payload = await service.payloadFor(OWNER);
    expect(payload.version).toBe(ONTOLOGY_VERSION);
    expect(payload.domains.find((d) => d.key === 'core')).toMatchObject({
      enabled: true,
      alwaysOn: true,
    });
    expect(payload.domains.find((d) => d.key === 'work')).toMatchObject({ enabled: true });

    const person = payload.entityTypes.find((t) => t.key === 'Person');
    expect(person?.attributes).toContainEqual(
      expect.objectContaining({ key: 'title', source: 'mixin', domain: 'work' }),
    );
  });

  it('reads the caller\'s attribute defs with exactly one owner-scoped query, deprecated included', async () => {
    await service.payloadFor(OWNER);

    expect(prisma.kgAttributeDef.findMany).toHaveBeenCalledTimes(1);
    const [args] = prisma.kgAttributeDef.findMany.mock.calls[0];
    // No `deprecatedAt` filter: deprecated definitions stay in the payload,
    // flagged, so values already stored under them remain readable.
    expect(args.where).toEqual({ ownerId: OWNER });
  });

  it('maps attribute-def rows into the payload, deprecated ones flagged', async () => {
    prisma.kgAttributeDef.findMany.mockResolvedValue([
      attributeDefRow(),
      attributeDefRow({
        id: '66666666-6666-4666-8666-666666666666',
        key: 'u_oldfield01',
        label: 'Old field',
        sortOrder: 1,
        deprecatedAt: new Date('2026-09-10T12:00:00.000Z'),
      }),
    ]);

    const payload = await service.payloadFor(OWNER);
    const person = payload.entityTypes.find((t) => t.key === 'Person');
    const users = person?.attributes.filter((a) => a.source === 'user') ?? [];

    expect(users).toEqual([
      expect.objectContaining({
        key: 'u_favcolour1',
        label: 'Favourite colour',
        attributeDefId: '55555555-5555-4555-8555-555555555555',
        deprecated: false,
        domain: null,
      }),
      expect.objectContaining({ key: 'u_oldfield01', deprecated: true }),
    ]);
  });

  it('turns deprecatedAt into an ISO string', () => {
    expect(
      toUserAttributeDef(
        attributeDefRow({ deprecatedAt: new Date('2026-09-10T12:00:00.000Z') }) as never,
      ).deprecatedAt,
    ).toBe('2026-09-10T12:00:00.000Z');
    expect(toUserAttributeDef(attributeDefRow() as never).deprecatedAt).toBeNull();
  });

  it('produces a payload the OpenAPI mirror parses, so the mirror cannot drift', async () => {
    prisma.kgAttributeDef.findMany.mockResolvedValue([
      attributeDefRow({
        kind: 'select',
        options: { choices: [{ value: 'red', label: 'Red' }] },
        sensitivity: 'personal',
        extractable: true,
        extractionHint: 'Their favourite colour, if stated.',
      }),
    ]);

    const payload = await service.payloadFor(OWNER);

    const parsed = graphOntologyResponseSchema.safeParse(payload);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
  });

  it('lets a subclass override only the enabledDomains seam (#369)', async () => {
    class CoreOnly extends GraphOntologyService {
      protected override async enabledDomains() {
        return ['core' as const];
      }
    }
    const coreOnly = new CoreOnly(prisma as never, {} as never);

    const payload = await coreOnly.payloadFor(OWNER);
    expect(payload.domains.find((d) => d.key === 'work')?.enabled).toBe(false);
    expect(payload.entityTypes.some((t) => t.domain === 'work')).toBe(false);
  });

  it('reads enabled domains from the `graph.domains` preference (#369)', async () => {
    prisma.userSettings.findUnique.mockResolvedValue({
      value: {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: null },
        graph: { domains: { work: false, personal: false } },
      },
    });

    const schema = await service.effectiveSchemaFor(OWNER);
    expect(schema.enabledDomains).toEqual(['core']);

    const payload = await service.payloadFor(OWNER);
    expect(payload.domains.find((d) => d.key === 'core')?.enabled).toBe(true);
    expect(payload.domains.find((d) => d.key === 'work')?.enabled).toBe(false);
  });
});
