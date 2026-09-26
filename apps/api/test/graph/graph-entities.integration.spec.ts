import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { graphEntitySchema } from '../../src/graph/dto/graph-entity.dto';

// =============================================================================
// PATCH /api/graph/entities/:id over the wire (#355, epic #344)
// =============================================================================
//
// Driven through the REAL `AppModule` — guards, validation pipe, envelope,
// `GraphAccessService`, `GraphWriteService` — with only `PrismaService`
// replaced by a small in-memory store for the two tables the edit touches.
//
//   - The RBAC matrix: the owner gets 200; a stranger gets the byte-identical
//     404 a missing row gets; the owner WITHOUT `graph:write` gets 403.
//   - The behaviour: label change keeps the old label as an alias, props merge
//     with null clearing, `accepted` → `edited`, an audit row with no values.
//   - The validation 400s: `type`, an empty body, an undeclared prop, an alias
//     that normalizes to nothing.
// =============================================================================

const ENTITY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MERGED_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const url = (id = ENTITY_ID) => `/api/graph/entities/${id}`;

/** Same technique as `graph-ontology.integration.spec.ts`. */
function stripPermission(userId: string, permission: string): void {
  const original = prismaMock.user.findUnique.getMockImplementation();
  prismaMock.user.findUnique.mockImplementation(async (args: never) => {
    const user = (await original?.(args)) as
      | { id: string; userRoles?: Array<{ role: { rolePermissions: Array<{ permission: { name: string } }> } }> }
      | null;
    if (!user || user.id !== userId || !user.userRoles) return user as never;
    return {
      ...user,
      userRoles: user.userRoles.map((userRole) => ({
        ...userRole,
        role: {
          ...userRole.role,
          rolePermissions: userRole.role.rolePermissions.filter((rp) => rp.permission.name !== permission),
        },
      })),
    } as never;
  });
}

type Row = Record<string, any>;

/** Equality and `{ in: [...] }` — every shape of `where` this route issues. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && 'in' in cond) {
      return (cond.in as unknown[]).includes(row[key]);
    }
    return row[key] === cond;
  });
}

describe('PATCH /api/graph/entities/:id (integration)', () => {
  let context: TestContext;
  let entities: Row[];
  let aliases: Row[];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  function seed(ownerId: string) {
    const now = new Date('2026-09-01T00:00:00.000Z');
    entities = [
      {
        id: ENTITY_ID,
        ownerId,
        type: 'Person',
        label: 'Sarah Chen',
        props: { title: 'CTO' },
        reviewStatus: 'accepted',
        mergedIntoId: null,
        occurredAt: null,
        ontologyVersion: '1.0.0',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: MERGED_ID,
        ownerId,
        type: 'Person',
        label: 'S. Chen',
        props: {},
        reviewStatus: 'merged',
        mergedIntoId: ENTITY_ID,
        occurredAt: null,
        ontologyVersion: '1.0.0',
        createdAt: now,
        updatedAt: now,
      },
    ];
    aliases = [
      { id: 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0', entityId: ENTITY_ID, ownerId, alias: 'Sarah Chen', normalized: 'sarah chen', source: 'extraction', createdAt: now },
    ];
  }

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    entities = [];
    aliases = [];

    prismaMock.kgAttributeDef.findMany.mockResolvedValue([]);
    prismaMock.kgEntity.findUnique.mockImplementation(async ({ where }: { where: Row }) =>
      entities.find((e) => matches(e, where)) ?? null,
    );
    prismaMock.kgEntity.findFirst.mockImplementation(async ({ where }: { where: Row }) =>
      entities.find((e) => matches(e, where)) ?? null,
    );
    prismaMock.kgEntity.update.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
      const row = entities.find((e) => e.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date('2026-09-02T00:00:00.000Z') });
      return { ...row };
    });
    prismaMock.kgEntityAlias.findMany.mockImplementation(async ({ where }: { where: Row }) =>
      aliases.filter((a) => matches(a, where)),
    );
    prismaMock.kgEntityAlias.createMany.mockImplementation(async ({ data }: { data: Row[] }) => {
      data.forEach((a, i) =>
        aliases.push({ ...a, id: `d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d${i}`, createdAt: new Date('2026-09-02T00:00:00.000Z') }),
      );
      return { count: data.length };
    });
    prismaMock.kgEntityAlias.deleteMany.mockImplementation(async ({ where }: { where: Row }) => {
      const before = aliases.length;
      aliases = aliases.filter((a) => !matches(a, where));
      return { count: before - aliases.length };
    });
  });

  it('lets the owner rename, merge props and add aliases; keeps the old label; flips accepted → edited', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);

    const res = await request(context.app.getHttpServer())
      .patch(url())
      .set(authHeader(owner.accessToken))
      .send({ label: 'Sarah Chen-Li', props: { title: null }, addAliases: ['Sally', 'SALLY!'] })
      .expect(200);

    const body = res.body.data;
    expect(graphEntitySchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ id: ENTITY_ID, label: 'Sarah Chen-Li', props: {}, reviewStatus: 'edited' });
    expect(body.aliases.map((a: Row) => [a.alias, a.source])).toEqual([
      ['Sarah Chen', 'extraction'],
      ['Sarah Chen-Li', 'user'],
      ['Sally', 'user'],
    ]);

    const audit = prismaMock.auditEvent.create.mock.calls
      .map((c: [{ data: Row }]) => c[0].data)
      .find((d: Row) => d.action === 'graph.entity_edited');
    expect(audit).toEqual({
      actorUserId: owner.id,
      action: 'graph.entity_edited',
      targetType: 'kg_entity',
      targetId: ENTITY_ID,
      meta: { changedKeys: ['title'], labelChanged: true, aliasesAdded: 2, aliasesRemoved: 0 },
    });
    // No values anywhere in the audit row.
    expect(JSON.stringify(audit)).not.toMatch(/Sarah|Sally|CTO/);
  });

  it("answers another user's entity with the same 404 a missing one gets", async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    const stranger = await createMockTestUser(context, { roleName: 'admin' });
    seed(owner.id);

    const theirs = await request(context.app.getHttpServer())
      .patch(url())
      .set(authHeader(stranger.accessToken))
      .send({ label: 'Hijacked' })
      .expect(404);
    const missing = await request(context.app.getHttpServer())
      .patch(url('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'))
      .set(authHeader(stranger.accessToken))
      .send({ label: 'Hijacked' })
      .expect(404);

    expect(theirs.body.message).toBe('Entity not found');
    expect(missing.body.message).toBe(theirs.body.message);
    expect(prismaMock.kgEntity.update).not.toHaveBeenCalled();
  });

  it('answers a merged entity with 404', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);
    await request(context.app.getHttpServer())
      .patch(url(MERGED_ID))
      .set(authHeader(owner.accessToken))
      .send({ label: 'X' })
      .expect(404);
  });

  it('answers the owner without graph:write with 403', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);
    stripPermission(owner.id, 'graph:write');

    await request(context.app.getHttpServer())
      .patch(url())
      .set(authHeader(owner.accessToken))
      .send({ label: 'X' })
      .expect(403);
    expect(prismaMock.kgEntity.update).not.toHaveBeenCalled();
  });

  it.each([
    ['a type change', { type: 'Organization' }],
    ['an empty body', {}],
    ['an alias that normalizes to nothing', { addAliases: ['!!!'] }],
  ])('answers %s with 400', async (_name, body) => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);
    await request(context.app.getHttpServer())
      .patch(url())
      .set(authHeader(owner.accessToken))
      .send(body)
      .expect(400);
    expect(prismaMock.kgEntity.update).not.toHaveBeenCalled();
  });

  it('answers an undeclared prop with 400 naming it in details.issues', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);
    const res = await request(context.app.getHttpServer())
      .patch(url())
      .set(authHeader(owner.accessToken))
      .send({ props: { shoeSize: 42 } })
      .expect(400);
    expect(res.body.details.issues).toEqual([expect.objectContaining({ path: 'shoeSize' })]);
  });

  it('answers 401 without a token', async () => {
    await request(context.app.getHttpServer()).patch(url()).send({ label: 'X' }).expect(401);
  });
});
