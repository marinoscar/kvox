import request from 'supertest';
import { APP_SLUG } from '@app/shared';
import { ONTOLOGY_VERSION, kvNamespace } from '@app/shared/ontology';

import { TestContext, createTestApp, closeTestApp } from '../../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../../mocks/prisma.mock';
import { setupBaseMocks } from '../../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../../helpers/auth-mock.helper';
import { OWL, objectsOf, parseTurtle, subjectsOfType, SH } from './rdf-fixtures';

// =============================================================================
// GET /api/graph/ontology.ttl and /api/graph/ontology.shacl.ttl (#385)
// =============================================================================
//
// Driven through the REAL `AppModule` — guards, the global interceptors, the
// controller — with only `PrismaService` replaced, like
// `graph-ontology.integration.spec.ts`:
//
//   - auth: every role holds `graph:read` → 200; stripped of it → 403; no
//     token → 401;
//   - raw `text/turtle; charset=utf-8`, NOT the `{ data }` envelope, and the
//     body parses with n3 in the application's own namespace;
//   - weak ETag + `Cache-Control`, 304 with no body on `If-None-Match`, and a
//     new attribute definition changes the ETag;
//   - owner isolation: owner B's attribute definitions never reach owner A.
// =============================================================================

const OWL_ROUTE = '/api/graph/ontology.ttl';
const SHACL_ROUTE = '/api/graph/ontology.shacl.ttl';
const NS = kvNamespace(APP_SLUG);

/** Removes one permission from one user, as the JWT strategy loads it (see graph-ontology.integration.spec). */
function stripPermission(userId: string, permission: string): void {
  const original = prismaMock.user.findUnique.getMockImplementation();

  prismaMock.user.findUnique.mockImplementation(async (args: never) => {
    const user = (await original?.(args)) as
      | {
          id: string;
          userRoles?: Array<{ role: { rolePermissions: Array<{ permission: { name: string } }> } }>;
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

const defRow = (ownerId: string, id: string, label: string, overrides: Record<string, unknown> = {}) => ({
  id,
  ownerId,
  entityType: 'Organization',
  key: 'u_tier000001',
  label,
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

const A_DEF = '88888888-8888-4888-8888-888888888888';
const B_DEF = '99999999-9999-4999-8999-999999999999';

describe('GET /api/graph/ontology.ttl and ontology.shacl.ttl (integration)', () => {
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
    prismaMock.kgAttributeDef.findMany.mockResolvedValue([] as never);
  });

  const get = (route: string, token: string) =>
    request(context.app.getHttpServer()).get(route).set(authHeader(token));

  describe.each([
    ['ontology.ttl', OWL_ROUTE],
    ['ontology.shacl.ttl', SHACL_ROUTE],
  ])('%s', (_name, route) => {
    it.each(['admin', 'contributor', 'viewer'] as const)('answers 200 raw Turtle for a %s', async (roleName) => {
      const user = await createMockTestUser(context, { roleName });

      const res = await get(route, user.accessToken).expect(200);

      expect(res.headers['content-type']).toBe('text/turtle; charset=utf-8');
      expect(res.headers['cache-control']).toBe('private, max-age=0, must-revalidate');
      expect(res.headers.etag).toMatch(/^W\/"[0-9a-f]{64}"$/);

      const body = res.text;
      expect(body.startsWith('@prefix ')).toBe(true);
      expect(body).not.toContain('"meta"');
      const quads = parseTurtle(body);
      expect(quads.length).toBeGreaterThan(0);
      expect(body).toContain(`@prefix kv: <${NS}> .`);

      expect(prismaMock.kgAttributeDef.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerId: user.id } }),
      );
    });

    it('answers 304 with no body when If-None-Match matches, and 200 when it does not', async () => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });
      const first = await get(route, user.accessToken).expect(200);
      const etag = first.headers.etag as string;

      const again = await get(route, user.accessToken).set('If-None-Match', etag).expect(304);
      expect(again.text ?? '').toBe('');
      expect(again.headers.etag).toBe(etag);

      // Weak comparison: a validator with the W/ stripped still matches.
      await get(route, user.accessToken).set('If-None-Match', etag.replace(/^W\//, '')).expect(304);
      await get(route, user.accessToken).set('If-None-Match', 'W/"stale"').expect(200);
    });

    it('changes the ETag when an attribute definition is added', async () => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });
      const before = (await get(route, user.accessToken).expect(200)).headers.etag as string;

      prismaMock.kgAttributeDef.findMany.mockResolvedValue([defRow(user.id, A_DEF, 'Tier')] as never);
      const after = await get(route, user.accessToken).set('If-None-Match', before).expect(200);

      expect(after.headers.etag).not.toBe(before);
      expect(after.text).toContain(`attr/${A_DEF}`);
    });

    it('answers 403 without graph:read, before reading anything', async () => {
      const user = await createMockTestUser(context, { roleName: 'viewer' });
      stripPermission(user.id, 'graph:read');

      await get(route, user.accessToken).expect(403);
      expect(prismaMock.kgAttributeDef.findMany).not.toHaveBeenCalled();
    });

    it('answers 401 without a token', async () => {
      await request(context.app.getHttpServer()).get(route).expect(401);
    });
  });

  it('declares owl:versionInfo = ONTOLOGY_VERSION in the application namespace', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const quads = parseTurtle((await get(OWL_ROUTE, user.accessToken).expect(200)).text);

    expect(subjectsOfType(quads, `${OWL}Ontology`)).toEqual([NS]);
    expect(objectsOf(quads, NS, `${OWL}versionInfo`).map((o) => o.value)).toEqual([ONTOLOGY_VERSION]);
  });

  it('serves node shapes from the SHACL route', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const quads = parseTurtle((await get(SHACL_ROUTE, user.accessToken).expect(200)).text);

    expect(subjectsOfType(quads, `${SH}NodeShape`)).toContain(`${NS}PersonShape`);
  });

  it('shows each owner only their own attribute definitions', async () => {
    const ownerA = await createMockTestUser(context, { roleName: 'viewer' });
    const ownerB = await createMockTestUser(context, { roleName: 'viewer' });

    prismaMock.kgAttributeDef.findMany.mockImplementation((async (args: { where: { ownerId: string } }) =>
      args.where.ownerId === ownerA.id
        ? [defRow(ownerA.id, A_DEF, 'Alpha tier')]
        : args.where.ownerId === ownerB.id
          ? [defRow(ownerB.id, B_DEF, 'Beta tier')]
          : []) as never);

    for (const route of [OWL_ROUTE, SHACL_ROUTE]) {
      const a = (await get(route, ownerA.accessToken).expect(200)).text;
      const b = (await get(route, ownerB.accessToken).expect(200)).text;

      expect(a).toContain(`attr/${A_DEF}`);
      expect(a).toContain('Alpha tier');
      expect(a).not.toContain(B_DEF);
      expect(a).not.toContain('Beta tier');

      expect(b).toContain(`attr/${B_DEF}`);
      expect(b).not.toContain(A_DEF);
      expect(b).not.toContain('Alpha tier');
    }
  });

  it('never serves a sensitive definition', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    prismaMock.kgAttributeDef.findMany.mockResolvedValue([
      defRow(user.id, A_DEF, 'Diagnosis', { sensitivity: 'sensitive' }),
    ] as never);

    for (const route of [OWL_ROUTE, SHACL_ROUTE]) {
      const text = (await get(route, user.accessToken).expect(200)).text;
      expect(text).not.toContain(A_DEF);
      expect(text).not.toContain('Diagnosis');
    }
  });
});
