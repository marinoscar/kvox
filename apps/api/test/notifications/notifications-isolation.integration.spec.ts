import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockTestUser, authHeader } from '../helpers/auth-mock.helper';

// =============================================================================
// Notifications HTTP-level isolation (issue #127, epic #109)
// =============================================================================
//
// `NotificationsController` takes the caller's user id EXCLUSIVELY from
// `@CurrentUser('id')` — no path, query, or body parameter anywhere carries a
// user id. This suite proves that property over real HTTP requests through
// the full Nest pipeline (guards + interceptors + controller + service, with
// only Prisma mocked):
//
//   * every route 401s with no token
//   * two different signed-in users each see only their own canned rows
//   * marking another user's notification read 404s IDENTICALLY to marking a
//     genuinely nonexistent one — the wire-level version of the store's
//     404-indistinguishability guarantee
//   * a `?userId=` query parameter has no effect whatsoever
//
// SSE (`GET /api/notifications/stream`) is deliberately NOT exercised here.
// Supertest against a genuinely open, header-flushing `@Sse()` stream is
// prone to hanging the test runner, and stream-level isolation (two users,
// one publish, no cross-talk) is already covered thoroughly and directly at
// the service layer in `notification-stream.service.spec.ts`. Forcing an HTTP
// stream test here would spend a lot of effort re-proving a property that
// suite already nails down.
// =============================================================================

const USER_A_ID = '11111111-1111-1111-1111-111111111111';
const USER_B_ID = '22222222-2222-2222-2222-222222222222';

const NOTIF_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NOTIF_B_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GHOST_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

function notifRow(overrides: Partial<{
  id: string;
  userId: string;
  eventKey: string;
  title: string;
  body: string;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
}> = {}) {
  return {
    id: NOTIF_A_ID,
    eventKey: 'security.role_changed',
    title: 'Default title',
    body: 'Default body',
    link: null,
    readAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('Notifications HTTP isolation (Integration)', () => {
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
  });

  async function userA() {
    return createMockTestUser(context, {
      id: USER_A_ID,
      email: 'user-a@example.com',
      roleName: 'viewer',
    });
  }

  async function userB() {
    return createMockTestUser(context, {
      id: USER_B_ID,
      email: 'user-b@example.com',
      roleName: 'viewer',
    });
  }

  // ==========================================================================
  // 401 without a token, on every route
  // ==========================================================================

  describe('401 without auth', () => {
    it('GET /api/notifications', async () => {
      await request(context.app.getHttpServer()).get('/api/notifications').expect(401);
    });

    it('GET /api/notifications/unread-count', async () => {
      await request(context.app.getHttpServer())
        .get('/api/notifications/unread-count')
        .expect(401);
    });

    it('POST /api/notifications/:id/read', async () => {
      await request(context.app.getHttpServer())
        .post(`/api/notifications/${NOTIF_A_ID}/read`)
        .expect(401);
    });

    it('POST /api/notifications/read-all', async () => {
      await request(context.app.getHttpServer())
        .post('/api/notifications/read-all')
        .expect(401);
    });
  });

  // ==========================================================================
  // Two users, two different canned datasets, isolation over HTTP
  // ==========================================================================

  describe('GET /api/notifications — each user sees only their own rows', () => {
    beforeEach(() => {
      context.prismaMock.notification.findMany.mockImplementation(
        async ({ where }: any) => {
          if (where.userId === USER_A_ID) {
            return [notifRow({ id: NOTIF_A_ID, userId: USER_A_ID, title: "A's notification" })];
          }
          if (where.userId === USER_B_ID) {
            return [notifRow({ id: NOTIF_B_ID, userId: USER_B_ID, title: "B's notification" })];
          }
          return [];
        },
      );
      context.prismaMock.notification.count.mockImplementation(async ({ where }: any) => {
        if (where.userId === USER_A_ID) return 1;
        if (where.userId === USER_B_ID) return 1;
        return 0;
      });
    });

    it('user A gets only A’s canned row', async () => {
      const a = await userA();

      const response = await request(context.app.getHttpServer())
        .get('/api/notifications')
        .set(authHeader(a.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0].id).toBe(NOTIF_A_ID);
      expect(response.body.data.items[0].title).toBe("A's notification");
    });

    it('user B gets only B’s canned row', async () => {
      const b = await userB();

      const response = await request(context.app.getHttpServer())
        .get('/api/notifications')
        .set(authHeader(b.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0].id).toBe(NOTIF_B_ID);
      expect(response.body.data.items[0].title).toBe("B's notification");
    });

    it('a ?userId=<other user> query parameter has no effect — A still gets A’s data', async () => {
      const a = await userA();

      const response = await request(context.app.getHttpServer())
        .get(`/api/notifications?userId=${USER_B_ID}`)
        .set(authHeader(a.accessToken))
        .expect(200);

      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0].id).toBe(NOTIF_A_ID);

      // Prove it structurally, not just by outcome: the where clause Prisma
      // actually received never carried the query-string value.
      const calls = context.prismaMock.notification.findMany.mock.calls as any[];
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall.where.userId).toBe(USER_A_ID);
      expect(lastCall.where.userId).not.toBe(USER_B_ID);
    });
  });

  // ==========================================================================
  // markRead 404-indistinguishability at the wire level
  // ==========================================================================

  describe('POST /api/notifications/:id/read — 404 is identical for "not yours" and "does not exist"', () => {
    beforeEach(() => {
      // Every id in this describe block resolves to "not this caller's" —
      // updateMany matches nothing, and the userId-scoped existence probe
      // also matches nothing, for both the id owned by B and the id that was
      // never created at all.
      context.prismaMock.notification.updateMany.mockResolvedValue({ count: 0 } as never);
      context.prismaMock.notification.count.mockResolvedValue(0 as never);
    });

    it('an id belonging to a different user (B) returns 404 when called as A', async () => {
      const a = await userA();

      const response = await request(context.app.getHttpServer())
        .post(`/api/notifications/${NOTIF_B_ID}/read`)
        .set(authHeader(a.accessToken))
        .expect(404);

      expect(response.body).toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Notification not found',
      });
    });

    it('a genuinely nonexistent id also returns 404 when called as A', async () => {
      const a = await userA();

      const response = await request(context.app.getHttpServer())
        .post(`/api/notifications/${GHOST_ID}/read`)
        .set(authHeader(a.accessToken))
        .expect(404);

      expect(response.body).toMatchObject({
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'Notification not found',
      });
    });

    it('the two responses are identical in every field except the echoed path (which differs only because the id in the URL differs)', async () => {
      const a = await userA();

      const otherUsersResponse = await request(context.app.getHttpServer())
        .post(`/api/notifications/${NOTIF_B_ID}/read`)
        .set(authHeader(a.accessToken))
        .expect(404);

      const nonexistentResponse = await request(context.app.getHttpServer())
        .post(`/api/notifications/${GHOST_ID}/read`)
        .set(authHeader(a.accessToken))
        .expect(404);

      const strip = (body: Record<string, unknown>) => {
        const { path, timestamp, ...rest } = body;
        return rest;
      };

      expect(strip(otherUsersResponse.body)).toEqual(strip(nonexistentResponse.body));
      expect(otherUsersResponse.status).toBe(nonexistentResponse.status);
    });
  });

  // ==========================================================================
  // No user-supplied value anywhere has any effect
  // ==========================================================================

  describe('there is no way to pass a user id that has any effect', () => {
    it('unread-count as A vs as B reflects each caller’s own scoped count, from the same endpoint with no parameters', async () => {
      context.prismaMock.notification.count.mockImplementation(async ({ where }: any) => {
        if (where.userId === USER_A_ID) return 3;
        if (where.userId === USER_B_ID) return 9;
        return 0;
      });

      const a = await userA();
      const b = await userB();

      const aResponse = await request(context.app.getHttpServer())
        .get('/api/notifications/unread-count')
        .set(authHeader(a.accessToken))
        .expect(200);
      const bResponse = await request(context.app.getHttpServer())
        .get('/api/notifications/unread-count')
        .set(authHeader(b.accessToken))
        .expect(200);

      expect(aResponse.body.data.unreadCount).toBe(3);
      expect(bResponse.body.data.unreadCount).toBe(9);
    });

    it('markAllRead as A never touches B’s rows', async () => {
      context.prismaMock.notification.updateMany.mockResolvedValue({ count: 2 } as never);
      context.prismaMock.notification.count.mockResolvedValue(0 as never);

      const a = await userA();

      await request(context.app.getHttpServer())
        .post('/api/notifications/read-all')
        .set(authHeader(a.accessToken))
        .expect(200);

      expect(context.prismaMock.notification.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: USER_A_ID }) }),
      );
      const calls = context.prismaMock.notification.updateMany.mock.calls as any[];
      for (const [args] of calls) {
        expect(args.where.userId).not.toBe(USER_B_ID);
      }
    });
  });
});
