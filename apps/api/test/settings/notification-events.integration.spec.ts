import request from 'supertest';
import { JwtService } from '@nestjs/jwt';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockAdminUser, authHeader } from '../helpers/auth-mock.helper';
import { NOTIFICATION_EVENTS } from '../../src/notifications/notification-events';

// =============================================================================
// GET /api/notifications/events Integration (issue #124, epic #109)
// =============================================================================
//
// One rule this endpoint exists to prove: authenticated, but gated on NO
// permission at all. Every signed-in user renders their own notification
// preferences against this registry, so a user holding literally zero
// permissions must still be able to read it — the guard the other
// `/api/email-settings*` endpoints rely on (`system_settings:read/write`)
// would lock a plain Viewer out of a page that belongs to every account.
// =============================================================================

describe('Notification Events Integration', () => {
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

  /** A signed-in, active user holding NO roles and therefore NO permissions. */
  async function createNoPermissionUser(): Promise<{ accessToken: string }> {
    const jwtService = context.module.get<JwtService>(JwtService);
    const id = 'zero-permission-user';
    const email = 'zero-permission-user@example.com';

    context.prismaMock.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where?.id !== id && where?.email !== email) return null;
      return {
        id,
        email,
        displayName: null,
        providerDisplayName: 'No Permissions',
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        // No roles at all — `toRequestUser` derives an empty permission set
        // from an empty `userRoles` array (see
        // `auth/interfaces/authenticated-user.interface.ts`).
        userRoles: [],
      };
    });

    const accessToken = jwtService.sign({ sub: id, email, roles: [] });
    return { accessToken };
  }

  describe('GET /api/notifications/events', () => {
    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .get('/api/notifications/events')
        .expect(401);
    });

    it('a user with an empty permission set can read it (200, not 403)', async () => {
      const user = await createNoPermissionUser();

      const response = await request(context.app.getHttpServer())
        .get('/api/notifications/events')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(Array.isArray(response.body.data)).toBe(true);
      expect(response.body.data.length).toBe(NOTIFICATION_EVENTS.length);
    });

    it('an ordinary admin can also read it (the gate is authentication, not a specific role)', async () => {
      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .get('/api/notifications/events')
        .set(authHeader(admin.accessToken))
        .expect(200);
    });

    it('returns the registry in the declared order, normalising `mandatory` to a boolean', async () => {
      const user = await createNoPermissionUser();

      const response = await request(context.app.getHttpServer())
        .get('/api/notifications/events')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.map((event: { key: string }) => event.key)).toEqual(
        NOTIFICATION_EVENTS.map((event) => event.key),
      );
      for (const event of response.body.data) {
        expect(typeof event.mandatory).toBe('boolean');
      }
    });
  });
});
