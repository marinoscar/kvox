import { randomUUID } from 'node:crypto';

import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader, createMockViewerUser } from '../helpers/auth-mock.helper';

// =============================================================================
// Push subscription endpoints, over HTTP (issue #229, epic #215)
// =============================================================================
//
// #229 stores the browser's `PushSubscription` object; #230 (separate, future)
// is what actually sends anything to it. This suite is the storage/HTTP half:
//
//   1. Any `viewer` can POST/DELETE their OWN subscriptions — `@Auth()` with no
//      extra permission, same as the rest of this controller (#127/#226).
//   2. Re-POSTing the same `endpoint` upserts in place rather than creating a
//      second row — proven here through Prisma's own `upsert` call shape,
//      keyed on `endpoint`, backed by a fake store that genuinely enforces the
//      unique-by-endpoint constraint the schema declares.
//   3. THE CORE SECURITY CRITERION: a DELETE for an endpoint owned by a
//      DIFFERENT user returns 404 — never a 403, never any signal that the
//      endpoint exists at all for somebody else.
//   4. With no VAPID keys configured (the default test environment — see
//      `.env.test`, which declares none), POST returns 409 and
//      `GET /api/notifications/config` reports `pushEnabled: false,
//      vapidPublicKey: null`.
//
// Mocked Prisma throughout (`useMockDatabase: true`), like every other
// integration suite in this directory. `pushSubscription.upsert`/`.deleteMany`
// are given a small in-memory implementation (keyed by `endpoint`, exactly
// like the real `@unique` column) rather than a bare `mockResolvedValue`,
// because the properties under test — "does a second POST create a duplicate
// row", "does DELETE only remove a row this caller owns" — are about how the
// query behaves against that constraint, not just what the controller passes
// through.
// =============================================================================

interface FakeSubscriptionRow {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: Date | null;
  userAgent: string | null;
  failureCount: number;
  createdAt: Date;
  updatedAt: Date;
}

let subscriptionsByEndpoint: Map<string, FakeSubscriptionRow>;

/** A fake `push_subscriptions` table, enforcing the real `endpoint` uniqueness. */
function setupPushSubscriptionMocks(): void {
  subscriptionsByEndpoint = new Map();

  (prismaMock.pushSubscription.upsert as jest.Mock).mockImplementation(
    async ({ where, update, create }: any) => {
      const existing = subscriptionsByEndpoint.get(where.endpoint);
      const now = new Date();

      if (existing) {
        const updated: FakeSubscriptionRow = {
          ...existing,
          ...update,
          updatedAt: now,
        };
        subscriptionsByEndpoint.set(where.endpoint, updated);
        return updated;
      }

      const created: FakeSubscriptionRow = {
        id: randomUUID(),
        failureCount: 0,
        createdAt: now,
        updatedAt: now,
        ...create,
      };
      subscriptionsByEndpoint.set(where.endpoint, created);
      return created;
    },
  );

  (prismaMock.pushSubscription.deleteMany as jest.Mock).mockImplementation(
    async ({ where }: any) => {
      const existing = subscriptionsByEndpoint.get(where.endpoint);
      // Genuine ownership check: only delete when BOTH the endpoint exists
      // AND its stored userId matches the caller's. This mirrors exactly what
      // a real `deleteMany({ where: { userId, endpoint } })` does against the
      // database — a row that does not match every field in `where` is not
      // deleted, and no error or extra information distinguishes "wrong user"
      // from "no such row" here either.
      if (existing && existing.userId === where.userId) {
        subscriptionsByEndpoint.delete(where.endpoint);
        return { count: 1 };
      }
      return { count: 0 };
    },
  );
}

const ENDPOINT_A = 'https://fcm.googleapis.com/fcm/send/endpoint-a';

function subscribeBody(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: ENDPOINT_A,
    keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
    ...overrides,
  };
}

describe('Push subscriptions integration (#229)', () => {
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
    setupPushSubscriptionMocks();
  });

  // ==========================================================================
  // No VAPID keys configured (the default test environment)
  // ==========================================================================

  describe('with no VAPID keys configured (this test environment)', () => {
    it('GET /api/notifications/config reports pushEnabled: false and vapidPublicKey: null', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/notifications/config')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.pushEnabled).toBe(false);
      expect(response.body.data.vapidPublicKey).toBeNull();
    });

    it('POST /api/notifications/push/subscriptions returns 409, not 500', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .post('/api/notifications/push/subscriptions')
        .set(authHeader(viewer.accessToken))
        .send(subscribeBody())
        .expect(409);

      expect(response.body).toHaveProperty('message');
      expect(subscriptionsByEndpoint.size).toBe(0);
    });
  });

  // ==========================================================================
  // With VAPID configured — override ConfigService's view for this describe
  // block via the real endpoint behaviour is not possible without env vars,
  // so these tests reach into the same `PushSubscriptionService` the app
  // already constructed by monkey-patching its `isEnabled`/`getVapidPublicKey`
  // for the duration of each test. This keeps the rest of the wiring (guards,
  // pipes, real HTTP) exactly as a genuine deployment would exercise it.
  // ==========================================================================

  describe('with VAPID keys configured', () => {
    beforeEach(async () => {
      const { PushSubscriptionService } = await import(
        '../../src/notifications/push-subscription.service'
      );
      const pushSubscriptions = context.module.get(PushSubscriptionService);
      jest.spyOn(pushSubscriptions, 'isEnabled').mockResolvedValue(true);
      jest
        .spyOn(pushSubscriptions, 'getVapidPublicKey')
        .mockResolvedValue('test-vapid-public-key');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('GET /api/notifications/config now reports pushEnabled: true and the public key', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/notifications/config')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.pushEnabled).toBe(true);
      expect(response.body.data.vapidPublicKey).toBe('test-vapid-public-key');
    });

    it('a viewer-role user can POST their own subscription with no special permission required', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .post('/api/notifications/push/subscriptions')
        .set(authHeader(viewer.accessToken))
        .send(subscribeBody())
        .expect(201);

      expect(response.body.data).toMatchObject({ endpoint: ENDPOINT_A });
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data).toHaveProperty('createdAt');
    });

    it('a viewer-role user can DELETE their own subscription with no special permission required', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .post('/api/notifications/push/subscriptions')
        .set(authHeader(viewer.accessToken))
        .send(subscribeBody())
        .expect(201);

      await request(context.app.getHttpServer())
        .delete('/api/notifications/push/subscriptions')
        .set(authHeader(viewer.accessToken))
        .send({ endpoint: ENDPOINT_A })
        .expect(204);

      expect(subscriptionsByEndpoint.has(ENDPOINT_A)).toBe(false);
    });

    it('rejects an unauthenticated POST/DELETE with 401', async () => {
      await request(context.app.getHttpServer())
        .post('/api/notifications/push/subscriptions')
        .send(subscribeBody())
        .expect(401);

      await request(context.app.getHttpServer())
        .delete('/api/notifications/push/subscriptions')
        .send({ endpoint: ENDPOINT_A })
        .expect(401);
    });

    // ------------------------------------------------------------------------
    // Re-subscribing upserts, does not duplicate
    // ------------------------------------------------------------------------

    it('re-subscribing the SAME endpoint twice upserts the same row rather than creating a duplicate', async () => {
      const viewer = await createMockViewerUser(context);

      await request(context.app.getHttpServer())
        .post('/api/notifications/push/subscriptions')
        .set(authHeader(viewer.accessToken))
        .send(subscribeBody())
        .expect(201);

      await request(context.app.getHttpServer())
        .post('/api/notifications/push/subscriptions')
        .set(authHeader(viewer.accessToken))
        .send(subscribeBody({ keys: { p256dh: 'new-key', auth: 'new-secret' } }))
        .expect(201);

      // Prisma's upsert was invoked twice, both keyed on the identical
      // endpoint — and the fake store (keyed by endpoint, exactly like the
      // schema's `@unique` column) ends up holding exactly one row.
      expect(prismaMock.pushSubscription.upsert).toHaveBeenCalledTimes(2);
      const calls = (prismaMock.pushSubscription.upsert as jest.Mock).mock
        .calls;
      expect(calls[0][0].where).toEqual({ endpoint: ENDPOINT_A });
      expect(calls[1][0].where).toEqual({ endpoint: ENDPOINT_A });

      expect(subscriptionsByEndpoint.size).toBe(1);
      expect(subscriptionsByEndpoint.get(ENDPOINT_A)).toMatchObject({
        p256dh: 'new-key',
        auth: 'new-secret',
      });
    });

    // ------------------------------------------------------------------------
    // THE CORE OWNERSHIP CRITERION
    // ------------------------------------------------------------------------

    it('DELETE for an endpoint owned by a DIFFERENT user returns 404 — never leaking that it exists for someone else', async () => {
      const owner = await createMockViewerUser(context);
      const attacker = await createMockViewerUser(context);

      // The owner subscribes.
      await request(context.app.getHttpServer())
        .post('/api/notifications/push/subscriptions')
        .set(authHeader(owner.accessToken))
        .send(subscribeBody())
        .expect(201);

      // A different authenticated user attempts to delete the SAME endpoint.
      const attackerResponse = await request(context.app.getHttpServer())
        .delete('/api/notifications/push/subscriptions')
        .set(authHeader(attacker.accessToken))
        .send({ endpoint: ENDPOINT_A })
        .expect(404);

      // Never a 403 ("forbidden, but it exists") — the response must be
      // indistinguishable from deleting an endpoint that was never
      // registered at all.
      expect(attackerResponse.status).toBe(404);

      // The row is untouched: the real owner can still delete it afterwards.
      expect(subscriptionsByEndpoint.has(ENDPOINT_A)).toBe(true);

      await request(context.app.getHttpServer())
        .delete('/api/notifications/push/subscriptions')
        .set(authHeader(owner.accessToken))
        .send({ endpoint: ENDPOINT_A })
        .expect(204);

      expect(subscriptionsByEndpoint.has(ENDPOINT_A)).toBe(false);
    });

    it('DELETE for an endpoint that never existed at all returns the SAME 404 shape', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .delete('/api/notifications/push/subscriptions')
        .set(authHeader(viewer.accessToken))
        .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/never-existed' })
        .expect(404);

      expect(response.body).toHaveProperty('message');
    });
  });
});
