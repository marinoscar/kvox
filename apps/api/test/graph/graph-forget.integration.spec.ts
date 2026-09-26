import request from 'supertest';
import { Prisma } from '@prisma/client';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockTestUser } from '../helpers/auth-mock.helper';
import { forgetEntityResponseSchema } from '../../src/graph/dto/graph-forget.dto';

// =============================================================================
// POST /api/graph/entities/:id/forget over the wire (#357, epic #344)
// =============================================================================
//
// Driven through the REAL `AppModule` — guards, `GraphAccessService`,
// `JobsService.enqueue` and its dedup, the response envelope — with only
// `PrismaService` replaced by small in-memory stores for `kg_entities` and
// `jobs`. The deletion itself is `kg.purge`'s (see `kg-purge.db.spec.ts`);
// this file is the route's contract:
//
//   - 202 with `{ jobId, entityId, status }` and a `graph.person_forget_requested`
//     audit row carrying ids only;
//   - 400 for a missing/wrong confirmation and for a non-Person;
//   - 404 (byte-identical) for another user's Person, a missing id and a merged
//     entity; 403 for the owner without `graph:write`;
//   - asking twice while pending returns the SAME job.
// =============================================================================

const PERSON_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MERGED_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const url = (id = PERSON_ID) => `/api/graph/entities/${id}/forget`;
const CONFIRM = { confirmation: 'FORGET' };

type Row = Record<string, any>;

/** Same technique as `graph-entities.integration.spec.ts`. */
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

describe('POST /api/graph/entities/:id/forget (integration)', () => {
  let context: TestContext;
  let entities: Row[];
  let jobs: Row[];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  function seed(ownerId: string) {
    const now = new Date('2026-09-01T00:00:00.000Z');
    const base = { ownerId, props: {}, occurredAt: null, ontologyVersion: '1.0.0', createdAt: now, updatedAt: now };
    entities = [
      { ...base, id: PERSON_ID, type: 'Person', label: 'Sarah Chen', reviewStatus: 'accepted', mergedIntoId: null },
      { ...base, id: ORG_ID, type: 'Organization', label: 'Acme', reviewStatus: 'accepted', mergedIntoId: null },
      { ...base, id: MERGED_ID, type: 'Person', label: 'S. Chen', reviewStatus: 'merged', mergedIntoId: PERSON_ID },
    ];
  }

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    entities = [];
    jobs = [];

    prismaMock.kgEntity.findUnique.mockImplementation(async ({ where }: { where: Row }) =>
      entities.find((e) => e.id === where.id) ?? null,
    );

    // `JobsService.enqueue`: an INSERT that the active-dedup index refuses
    // while a pending/running row holds the same key, then the re-read.
    prismaMock.job.create.mockImplementation(async ({ data }: { data: Row }) => {
      const live = jobs.find(
        (j) => j.dedupKey && j.dedupKey === data.dedupKey && ['pending', 'running'].includes(j.status),
      );
      if (live) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['dedup_key'] },
        });
      }
      const row = { ...data, id: `job-${jobs.length + 1}`, status: 'pending', createdAt: new Date() };
      jobs.push(row);
      return row;
    });
    prismaMock.job.findFirst.mockImplementation(async ({ where }: { where: Row }) =>
      jobs.find((j) => j.dedupKey === where.dedupKey && ['pending', 'running'].includes(j.status)) ?? null,
    );
  });

  const audits = () =>
    prismaMock.auditEvent.create.mock.calls
      .map((c: [{ data: Row }]) => c[0].data)
      .filter((d: Row) => d.action === 'graph.person_forget_requested');

  it('queues kg.purge for the owner\'s Person: 202, the job, an ids-only audit row', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);

    const res = await request(context.app.getHttpServer())
      .post(url())
      .set(authHeader(owner.accessToken))
      .send(CONFIRM)
      .expect(202);

    const body = res.body.data;
    expect(forgetEntityResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({ jobId: 'job-1', entityId: PERSON_ID, status: 'pending' });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: 'kg.purge',
      subjectType: 'kg_entity',
      subjectId: PERSON_ID,
      payload: { userId: owner.id, scope: 'person', entityId: PERSON_ID },
    });

    expect(audits()).toEqual([
      {
        actorUserId: owner.id,
        action: 'graph.person_forget_requested',
        targetType: 'kg_entity',
        targetId: PERSON_ID,
        meta: { entityId: PERSON_ID, jobId: 'job-1' },
      },
    ]);
    expect(JSON.stringify(audits())).not.toMatch(/Sarah/);

    // The entity is untouched by the request itself — the job deletes it.
    expect(prismaMock.kgEntity.delete).not.toHaveBeenCalled();
    expect(prismaMock.kgEntity.deleteMany).not.toHaveBeenCalled();
  });

  it('returns the SAME job when asked twice while the first is pending', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);

    const first = await request(context.app.getHttpServer())
      .post(url())
      .set(authHeader(owner.accessToken))
      .send(CONFIRM)
      .expect(202);
    const second = await request(context.app.getHttpServer())
      .post(url())
      .set(authHeader(owner.accessToken))
      .send(CONFIRM)
      .expect(202);

    expect(second.body.data.jobId).toBe(first.body.data.jobId);
    expect(jobs).toHaveLength(1);
  });

  it.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['a lowercase confirmation', { confirmation: 'forget' }],
    ['another scope word', { confirmation: 'EVERYTHING' }],
  ])('answers %s with 400 "Type FORGET to confirm."', async (_label, body) => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);

    const req = request(context.app.getHttpServer()).post(url()).set(authHeader(owner.accessToken));
    const res = await (body === undefined ? req : req.send(body)).expect(400);

    expect(res.body.message).toBe('Type FORGET to confirm.');
    expect(jobs).toHaveLength(0);
  });

  it('answers an Organization with 400', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);

    const res = await request(context.app.getHttpServer())
      .post(url(ORG_ID))
      .set(authHeader(owner.accessToken))
      .send(CONFIRM)
      .expect(400);

    expect(res.body.message).toBe(
      'Only a person can be forgotten; delete other entities by editing or reverting the proposal that created them.',
    );
    expect(jobs).toHaveLength(0);
  });

  it("answers another user's Person with the same 404 a missing one gets", async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    const stranger = await createMockTestUser(context, { roleName: 'admin' });
    seed(owner.id);

    const theirs = await request(context.app.getHttpServer())
      .post(url())
      .set(authHeader(stranger.accessToken))
      .send(CONFIRM)
      .expect(404);
    const missing = await request(context.app.getHttpServer())
      .post(url('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'))
      .set(authHeader(stranger.accessToken))
      .send(CONFIRM)
      .expect(404);

    expect(theirs.body.message).toBe('Entity not found');
    expect(missing.body.message).toBe(theirs.body.message);
    expect(jobs).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });

  it('answers a merged entity with 404', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);

    await request(context.app.getHttpServer())
      .post(url(MERGED_ID))
      .set(authHeader(owner.accessToken))
      .send(CONFIRM)
      .expect(404);
    expect(jobs).toHaveLength(0);
  });

  it('answers the owner without graph:write with 403', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);
    stripPermission(owner.id, 'graph:write');

    await request(context.app.getHttpServer())
      .post(url())
      .set(authHeader(owner.accessToken))
      .send(CONFIRM)
      .expect(403);
    expect(jobs).toHaveLength(0);
  });

  it('answers a malformed id with 400 and no token with 401', async () => {
    const owner = await createMockTestUser(context, { roleName: 'viewer' });
    seed(owner.id);

    await request(context.app.getHttpServer())
      .post('/api/graph/entities/not-a-uuid/forget')
      .set(authHeader(owner.accessToken))
      .send(CONFIRM)
      .expect(400);
    await request(context.app.getHttpServer()).post(url()).send(CONFIRM).expect(401);
  });
});
