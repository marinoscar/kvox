import request from 'supertest';
import { ONTOLOGY_VERSION } from '@app/shared/ontology';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { graphOntologyResponseSchema } from '../../src/graph/dto/graph-ontology.dto';

// =============================================================================
// GET /api/graph/ontology over the wire (#354, epic #344)
// =============================================================================
//
// Driven through the REAL `AppModule` — the guards, the response envelope and
// the controller — with only `PrismaService` replaced.
//
//   - The RBAC matrix: admin, contributor and viewer all hold `graph:read`
//     (seeded to every role), so each gets 200 with the same default effective
//     schema; a caller stripped of `graph:read` gets a PERMISSION 403 (not an
//     access one); no token is a 401.
//   - The caller's own `kg_attribute_defs` reach their payload, and the query
//     is scoped to them, so another user's never does.
// =============================================================================

const ONTOLOGY = '/api/graph/ontology';

/**
 * `graph:read` is seeded to all three roles, so the 403 path has to be
 * arranged by removing it from one user, by wrapping the lookup the JWT
 * strategy uses — the same technique `transcript-corrections.integration.spec`
 * uses for `transcripts:write`.
 */
function stripPermission(userId: string, permission: string): void {
  const original = prismaMock.user.findUnique.getMockImplementation();

  prismaMock.user.findUnique.mockImplementation(async (args: never) => {
    const user = (await original?.(args)) as
      | {
          id: string;
          userRoles?: Array<{
            role: { rolePermissions: Array<{ permission: { name: string } }> };
          }>;
        }
      | null;

    if (!user || user.id !== userId || !user.userRoles) return user as never;

    return {
      ...user,
      userRoles: user.userRoles.map((userRole) => ({
        ...userRole,
        role: {
          ...userRole.role,
          rolePermissions: userRole.role.rolePermissions.filter(
            (rolePermission) => rolePermission.permission.name !== permission,
          ),
        },
      })),
    } as never;
  });
}

const attributeDefRow = (ownerId: string) => ({
  id: '77777777-7777-4777-8777-777777777777',
  ownerId,
  entityType: 'Person',
  key: 'u_nickname01',
  label: 'Nickname',
  kind: 'text',
  options: null,
  extractable: true,
  extractionHint: 'What colleagues call them, if stated.',
  sensitivity: null,
  sortOrder: 0,
  deprecatedAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
});

describe('GET /api/graph/ontology (integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    // Attribute defs are owner-scoped in the query itself; answer by owner so
    // a test can prove one user never sees another's.
    prismaMock.kgAttributeDef.findMany.mockResolvedValue([] as never);
  });

  it.each(['admin', 'contributor', 'viewer'] as const)(
    'answers 200 with the default effective schema for a %s',
    async (roleName) => {
      const user = await createMockTestUser(context, { roleName });

      const res = await request(context.app.getHttpServer())
        .get(ONTOLOGY)
        .set(authHeader(user.accessToken))
        .expect(200);

      const payload = res.body.data;
      expect(graphOntologyResponseSchema.safeParse(payload).success).toBe(true);
      expect(payload.version).toBe(ONTOLOGY_VERSION);

      expect(payload.domains).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'core', enabled: true, alwaysOn: true }),
          expect.objectContaining({ key: 'work', enabled: true }),
        ]),
      );

      const person = payload.entityTypes.find((t: { key: string }) => t.key === 'Person');
      expect(person).toBeDefined();
      expect(person.attributes).toContainEqual(
        expect.objectContaining({ key: 'title', source: 'mixin', domain: 'work' }),
      );

      expect(prismaMock.kgAttributeDef.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerId: user.id } }),
      );
    },
  );

  it('shows a user their own Person attribute definition, and another user does not see it', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    const other = await createMockTestUser(context, { roleName: 'viewer' });

    prismaMock.kgAttributeDef.findMany.mockImplementation((async (args: {
      where: { ownerId: string };
    }) => (args.where.ownerId === owner.id ? [attributeDefRow(owner.id)] : [])) as never);

    const mine = await request(context.app.getHttpServer())
      .get(ONTOLOGY)
      .set(authHeader(owner.accessToken))
      .expect(200);
    const ownerPerson = mine.body.data.entityTypes.find(
      (t: { key: string }) => t.key === 'Person',
    );
    expect(ownerPerson.attributes).toContainEqual(
      expect.objectContaining({
        key: 'u_nickname01',
        label: 'Nickname',
        source: 'user',
        attributeDefId: '77777777-7777-4777-8777-777777777777',
      }),
    );

    const theirs = await request(context.app.getHttpServer())
      .get(ONTOLOGY)
      .set(authHeader(other.accessToken))
      .expect(200);
    const otherPerson = theirs.body.data.entityTypes.find(
      (t: { key: string }) => t.key === 'Person',
    );
    expect(otherPerson.attributes.some((a: { key: string }) => a.key === 'u_nickname01')).toBe(
      false,
    );
  });

  it('answers 403 for a caller without graph:read', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    stripPermission(user.id, 'graph:read');

    await request(context.app.getHttpServer())
      .get(ONTOLOGY)
      .set(authHeader(user.accessToken))
      .expect(403);

    expect(prismaMock.kgAttributeDef.findMany).not.toHaveBeenCalled();
  });

  it('answers 401 without a token', async () => {
    await request(context.app.getHttpServer()).get(ONTOLOGY).expect(401);
  });
});
