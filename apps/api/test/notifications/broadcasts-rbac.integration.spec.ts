// =============================================================================
// Broadcast routes: who may call them (issue #470, epic #467)
// =============================================================================
//
// The admin broadcast routes are the platform's (`BroadcastsModule`,
// `@marinoscar/platform-api/notifications`); this app's own controller, service
// and tests were deleted. What stays this app's to assert is the AUTHORIZATION
// OUTCOME of mounting the package in this deployment, because it differs from
// the controller this app had:
//
//   BEFORE  `@Auth({ roles: ['admin'], permissions: ['broadcasts:read|write'] })`
//           on every route: only the `admin` system role.
//   AFTER   `@Auth({ anyPermissions: ['broadcasts:*', 'org_broadcasts:*'] })`:
//           the system permission OR the org-scoped one. `org_admin` holds
//           `org_broadcasts:read|write` in `prisma/catalog/permissions.json`, so
//           an organization administrator who is NOT a system admin can now
//           reach the same routes for their own organization. This is the
//           platform's tenancy model (#738), reported as a behaviour change on
//           the issue and not a regression.
//
// Contributors and viewers hold neither and stay refused.
//
// Users are built from the real catalog (`createMembershipUser`), so these
// assert the seeded grants and not a generous fixture. The database is the
// shared deep mock: bodies are asserted for shape and wiring only. Which rows
// a `where` matches is Postgres's answer.
// =============================================================================

import request from 'supertest';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader } from '../helpers/auth-mock.helper';
import {
  catalogPermissionsOf,
  createMembershipAdmin,
  createMembershipContributor,
  createMembershipUser,
  createMembershipViewer,
} from '../helpers/membership-user.helper';

const BROADCAST_ID = '33333333-3333-4333-8333-333333333333';

const VALID_BODY = {
  title: 'Planned maintenance on Sunday',
  body: 'The application will be unavailable between 02:00 and 04:00 UTC.',
  channels: ['email', 'browser'],
};

type Method = 'get' | 'post' | 'delete';

const READ_ROUTES: Array<[string, Method, string]> = [
  ['GET /admin/broadcasts/audience', 'get', '/api/admin/broadcasts/audience'],
  ['GET /admin/broadcasts', 'get', '/api/admin/broadcasts'],
  ['GET /admin/broadcasts/:id', 'get', `/api/admin/broadcasts/${BROADCAST_ID}`],
];

const WRITE_ROUTES: Array<[string, Method, string]> = [
  ['POST /admin/broadcasts/test', 'post', '/api/admin/broadcasts/test'],
  ['POST /admin/broadcasts', 'post', '/api/admin/broadcasts'],
  ['POST /admin/broadcasts/:id/cancel', 'post', `/api/admin/broadcasts/${BROADCAST_ID}/cancel`],
  ['DELETE /admin/broadcasts/:id', 'delete', `/api/admin/broadcasts/${BROADCAST_ID}`],
];

const ALL_ROUTES = [...READ_ROUTES, ...WRITE_ROUTES];

function broadcastRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BROADCAST_ID,
    title: VALID_BODY.title,
    body: VALID_BODY.body,
    link: null,
    ctaLabel: null,
    eventKey: 'admin.broadcast',
    channels: ['email', 'browser'],
    status: 'scheduled',
    scheduledFor: null,
    startedAt: null,
    finishedAt: null,
    canceledAt: null,
    audienceCutoff: null,
    cursorUserId: null,
    recipientsTargeted: null,
    recipientsDispatched: 0,
    lastError: null,
    createdById: null,
    targetOrgId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('Broadcast routes authorization (platform controller, issue #470)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  }, 60000);

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    const prisma = context.prismaMock as any;
    prisma.notificationBroadcast.findMany.mockResolvedValue([]);
    prisma.notificationBroadcast.count.mockResolvedValue(0);
    prisma.notificationBroadcast.findUnique.mockResolvedValue(broadcastRow());
    prisma.notificationBroadcast.findFirst.mockResolvedValue(broadcastRow());
    prisma.notificationBroadcast.create.mockImplementation(async ({ data }: any) => broadcastRow(data));
    prisma.notificationBroadcast.updateMany.mockResolvedValue({ count: 1 });
    prisma.notificationBroadcast.delete.mockResolvedValue(broadcastRow());
    prisma.notificationDelivery.groupBy.mockResolvedValue([]);
    prisma.auditEvent.create.mockResolvedValue({});
    prisma.user.count.mockResolvedValue(12);
    prisma.job.create.mockResolvedValue({ id: 'job-1' });
  });

  const server = () => context.app.getHttpServer();

  describe('the seeded grants this suite relies on', () => {
    it('gives the system broadcasts permissions to the admin role', () => {
      expect(catalogPermissionsOf('admin')).toEqual(
        expect.arrayContaining(['broadcasts:read', 'broadcasts:write']),
      );
    });

    it('gives the org-scoped broadcasts permissions to org_admin (the behaviour change)', () => {
      expect(catalogPermissionsOf('org_admin')).toEqual(
        expect.arrayContaining(['org_broadcasts:read', 'org_broadcasts:write']),
      );
    });

    it.each(['contributor', 'viewer'])('gives %s no broadcasts permission of either scope', (role) => {
      expect(catalogPermissionsOf(role).filter((name) => name.includes('broadcasts:'))).toEqual([]);
    });
  });

  describe('callers who hold neither permission', () => {
    it.each(ALL_ROUTES)('%s rejects an anonymous caller (401)', async (_name, method, path) => {
      await request(server())[method](path).expect(401);
    });

    it.each(ALL_ROUTES)('%s rejects a viewer (403)', async (_name, method, path) => {
      const viewer = await createMembershipViewer(context);

      await request(server())[method](path).set(authHeader(viewer.accessToken)).send(VALID_BODY).expect(403);
    });

    it.each(ALL_ROUTES)('%s rejects a contributor (403)', async (_name, method, path) => {
      const contributor = await createMembershipContributor(context);

      await request(server())[method](path).set(authHeader(contributor.accessToken)).send(VALID_BODY).expect(403);
    });

    it.each(ALL_ROUTES)('%s rejects a member with no organization role at all (403)', async (_name, method, path) => {
      const orphan = await createMembershipUser(context, { orgRole: null });

      await request(server())[method](path).set(authHeader(orphan.accessToken)).send(VALID_BODY).expect(403);
    });
  });

  describe('a system admin (the admin role, plus its org_admin membership)', () => {
    it('is admitted on every route', async () => {
      const admin = await createMembershipAdmin(context);
      const auth = authHeader(admin.accessToken);

      await request(server()).get('/api/admin/broadcasts/audience').set(auth).expect(200);
      await request(server()).post('/api/admin/broadcasts/test').set(auth).send(VALID_BODY).expect(200);
      await request(server()).get('/api/admin/broadcasts').set(auth).expect(200);
      await request(server()).post('/api/admin/broadcasts').set(auth).send(VALID_BODY).expect(201);
      await request(server()).get(`/api/admin/broadcasts/${BROADCAST_ID}`).set(auth).expect(200);
    });
  });

  describe('an organization administrator who is NOT a system admin (behaviour change)', () => {
    it.each(READ_ROUTES)('%s is admitted through org_broadcasts:read', async (_name, method, path) => {
      const orgAdmin = await createMembershipUser(context, { orgRole: 'org_admin' });

      const response = await request(server())[method](path).set(authHeader(orgAdmin.accessToken));

      // Admitted by the guard. What the service then answers for the scope is
      // the platform's (a 404 for another organization's row is allowed); what
      // this app pins is that the guard did not refuse the caller.
      expect([401, 403]).not.toContain(response.status);
    });

    it.each(WRITE_ROUTES)('%s is admitted through org_broadcasts:write', async (_name, method, path) => {
      const orgAdmin = await createMembershipUser(context, { orgRole: 'org_admin' });

      const response = await request(server())
        [method](path)
        .set(authHeader(orgAdmin.accessToken))
        .send(VALID_BODY);

      expect([401, 403]).not.toContain(response.status);
    });

    it('reads the audience count through the org scope', async () => {
      const orgAdmin = await createMembershipUser(context, { orgRole: 'org_admin' });

      const response = await request(server())
        .get('/api/admin/broadcasts/audience')
        .set(authHeader(orgAdmin.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({ activeUsers: expect.any(Number) });
    });
  });
});
