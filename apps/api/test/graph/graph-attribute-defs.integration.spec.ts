import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { graphAttributeDefSchema } from '../../src/graph/dto/graph-attribute-def.dto';

// =============================================================================
// /api/graph/attribute-defs over the wire (#355, epic #344; ontology.md §17.3)
// =============================================================================
//
// The REAL `AppModule`, with `kg_attribute_defs` replaced by an in-memory
// table. CRUD, the immutability of kind/entityType/key, the no-removed-choice
// rule, the 50-per-type limit, `includeDeprecated`, owner-only 404s, and the
// definition reaching `GET /api/graph/ontology` as `source: 'user'`.
// =============================================================================

const BASE = '/api/graph/attribute-defs';

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => row[key] === cond);
}

describe('/api/graph/attribute-defs (integration)', () => {
  let context: TestContext;
  let defs: Row[];
  let seq: number;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    defs = [];
    seq = 0;

    prismaMock.kgAttributeDef.findMany.mockImplementation(async ({ where, orderBy }: { where: Row; orderBy?: unknown }) => {
      const rows = defs.filter((d) => matches(d, where));
      return orderBy ? rows.sort((a, b) => a.entityType.localeCompare(b.entityType) || a.sortOrder - b.sortOrder || a.createdAt - b.createdAt) : rows;
    });
    prismaMock.kgAttributeDef.count.mockImplementation(async ({ where }: { where: Row }) =>
      defs.filter((d) => matches(d, where)).length,
    );
    prismaMock.kgAttributeDef.findUnique.mockImplementation(async ({ where }: { where: Row }) =>
      defs.find((d) => d.id === where.id) ?? null,
    );
    prismaMock.kgAttributeDef.create.mockImplementation(async ({ data }: { data: Row }) => {
      seq += 1;
      const at = new Date(Date.UTC(2026, 8, 1, 0, 0, seq));
      const row = {
        id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(seq).padStart(12, '0')}`,
        options: null,
        deprecatedAt: null,
        createdAt: at,
        updatedAt: at,
        ...data,
      };
      if (row.options && typeof row.options === 'object' && !('choices' in row.options) && !('targetTypes' in row.options)) {
        row.options = null; // Prisma.DbNull
      }
      defs.push(row);
      return { ...row };
    });
    prismaMock.kgAttributeDef.update.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
      const row = defs.find((d) => d.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date('2026-09-20T00:00:00.000Z') });
      return { ...row };
    });
  });

  const server = () => context.app.getHttpServer();

  function createDef(token: string, body: Row) {
    return request(server()).post(BASE).set(authHeader(token)).send(body);
  }

  it('creates a definition with a server-generated u_ key (201) and lists it', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });

    const res = await createDef(user.accessToken, {
      entityType: 'Person',
      label: 'Tier',
      kind: 'select',
      options: { choices: [{ value: 'gold', label: 'Gold' }] },
    }).expect(201);

    const dto = res.body.data;
    expect(graphAttributeDefSchema.safeParse(dto).success).toBe(true);
    expect(dto).toMatchObject({ entityType: 'Person', label: 'Tier', kind: 'select', deprecatedAt: null });
    expect(dto.key).toMatch(/^u_[a-z0-9]{10}$/);

    const list = await request(server()).get(BASE).set(authHeader(user.accessToken)).expect(200);
    expect(list.body.data.items.map((d: Row) => d.id)).toEqual([dto.id]);

    const audit = prismaMock.auditEvent.create.mock.calls
      .map((c: [{ data: Row }]) => c[0].data)
      .find((d: Row) => d.action === 'graph.attribute_def_created');
    expect(audit.meta).toEqual({ entityType: 'Person', key: dto.key, kind: 'select' });
  });

  it("puts the definition in the caller's GET /api/graph/ontology with source: 'user'", async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const created = await createDef(user.accessToken, { entityType: 'Person', label: 'Nickname', kind: 'text' }).expect(201);

    const res = await request(server()).get('/api/graph/ontology').set(authHeader(user.accessToken)).expect(200);
    const person = res.body.data.entityTypes.find((t: Row) => t.key === 'Person');
    expect(person.attributes).toContainEqual(
      expect.objectContaining({ key: created.body.data.key, label: 'Nickname', source: 'user' }),
    );
  });

  it.each([
    ['kind', { kind: 'number' }],
    ['entityType', { entityType: 'Organization' }],
    ['key', { key: 'u_zzzzzzzzzz' }],
  ])('refuses changing %s (400)', async (_field, body) => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const created = await createDef(user.accessToken, { entityType: 'Person', label: 'Nickname', kind: 'text' }).expect(201);

    await request(server()).patch(`${BASE}/${created.body.data.id}`).set(authHeader(user.accessToken)).send(body).expect(400);
  });

  it('refuses removing a choice, and allows adding and relabelling', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const created = await createDef(user.accessToken, {
      entityType: 'Person',
      label: 'Tier',
      kind: 'select',
      options: { choices: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }] },
    }).expect(201);
    const path = `${BASE}/${created.body.data.id}`;

    const refused = await request(server())
      .patch(path)
      .set(authHeader(user.accessToken))
      .send({ options: { choices: [{ value: 'gold', label: 'Gold' }] } })
      .expect(400);
    expect(refused.body.details).toEqual({ removedChoices: ['silver'] });

    const ok = await request(server())
      .patch(path)
      .set(authHeader(user.accessToken))
      .send({
        label: 'Level',
        options: { choices: [{ value: 'gold', label: 'GOLD' }, { value: 'silver', label: 'Silver' }, { value: 'bronze', label: 'Bronze' }] },
      })
      .expect(200);
    expect(ok.body.data.label).toBe('Level');
    expect(ok.body.data.options.choices).toHaveLength(3);
  });

  it('deprecates on DELETE (200, idempotent) and hides deprecated rows unless includeDeprecated=true', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    const created = await createDef(user.accessToken, { entityType: 'Person', label: 'Nickname', kind: 'text' }).expect(201);
    const path = `${BASE}/${created.body.data.id}`;

    const first = await request(server()).delete(path).set(authHeader(user.accessToken)).expect(200);
    const second = await request(server()).delete(path).set(authHeader(user.accessToken)).expect(200);
    expect(first.body.data.deprecatedAt).not.toBeNull();
    expect(second.body.data.deprecatedAt).toBe(first.body.data.deprecatedAt);
    expect(defs).toHaveLength(1);

    const live = await request(server()).get(BASE).set(authHeader(user.accessToken)).expect(200);
    expect(live.body.data.items).toEqual([]);
    const all = await request(server()).get(`${BASE}?includeDeprecated=true`).set(authHeader(user.accessToken)).expect(200);
    expect(all.body.data.items).toHaveLength(1);

    // …and PATCH { deprecated: false } restores it.
    await request(server()).patch(path).set(authHeader(user.accessToken)).send({ deprecated: false }).expect(200);
    const restored = await request(server()).get(BASE).set(authHeader(user.accessToken)).expect(200);
    expect(restored.body.data.items).toHaveLength(1);
  });

  it("answers another user's definition with 404 on PATCH and DELETE", async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    const stranger = await createMockTestUser(context, { roleName: 'admin' });
    const created = await createDef(owner.accessToken, { entityType: 'Person', label: 'Nickname', kind: 'text' }).expect(201);
    const path = `${BASE}/${created.body.data.id}`;

    const patch = await request(server()).patch(path).set(authHeader(stranger.accessToken)).send({ label: 'X' }).expect(404);
    expect(patch.body.message).toBe('Attribute definition not found');
    await request(server()).delete(path).set(authHeader(stranger.accessToken)).expect(404);

    const theirs = await request(server()).get(BASE).set(authHeader(stranger.accessToken)).expect(200);
    expect(theirs.body.data.items).toEqual([]);
  });

  it('refuses a 51st live definition on one entity type', async () => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    for (let i = 0; i < 50; i++) {
      const at = new Date(Date.UTC(2026, 7, 1, 0, 0, i));
      defs.push({
        id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, '0')}`,
        ownerId: user.id,
        entityType: 'Person',
        key: `u_${String(i).padStart(10, '0')}`,
        label: `Attribute ${i}`,
        kind: 'text',
        options: null,
        extractable: false,
        extractionHint: null,
        sensitivity: null,
        sortOrder: i,
        deprecatedAt: null,
        createdAt: at,
        updatedAt: at,
      });
    }
    const res = await createDef(user.accessToken, { entityType: 'Person', label: 'One too many', kind: 'text' }).expect(400);
    expect(res.body.message).toMatch(/50 attributes on Person/);
  });

  it.each([
    ['an entity type outside the schema', { entityType: 'Spaceship', label: 'X', kind: 'text' }],
    ['a select without choices', { entityType: 'Person', label: 'X', kind: 'select' }],
    ['an entity_ref without target types', { entityType: 'Person', label: 'X', kind: 'entity_ref' }],
    ['options on a text attribute', { entityType: 'Person', label: 'X', kind: 'text', options: { targetTypes: ['Person'] } }],
    ['extractable without a hint', { entityType: 'Person', label: 'X', kind: 'text', extractable: true }],
  ])('refuses %s with 400', async (_name, body) => {
    const user = await createMockTestUser(context, { roleName: 'viewer' });
    await createDef(user.accessToken, body).expect(400);
    expect(defs).toHaveLength(0);
  });
});
