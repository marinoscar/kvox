import request from 'supertest';

import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { prismaMock, resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { createMockSystemSettings } from '../fixtures/test-data.factory';
import {
  authHeader,
  createMockAdminUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { NOTIFICATION_EVENTS } from '../../src/notifications/notification-events';
import { policyChannels } from '../../src/notifications/notification-policy';
import { resolveChannels } from '../../src/notifications/notification-preferences';

// =============================================================================
// Admin notification policy, over HTTP (issue #226, epic #215)
// =============================================================================
//
// #225 gave an administrator a switch. This suite is about the two things that
// switch has to be true for it to be a control rather than a decoration:
//
//   1. THE USERS IT AFFECTS CAN READ IT. `viewer` and `contributor` hold
//      `user_settings:*` and `storage:read` and nothing else, so
//      `GET /api/system-settings` (gated on `system_settings:read`) is a 403 for
//      them — for exactly the accounts whose notifications the policy governs.
//      `GET /api/notifications/config` is the narrow, purpose-built answer, and
//      the first test below is the assertion that it did not simply inherit the
//      admin gate by copy-paste.
//
//   2. THE MATRIX AND THE DISPATCHER AGREE. `GET /api/notifications/events`
//      publishes `channels`, and `resolveChannels` decides delivery. Both call
//      `policyChannels`; the last test here asserts the two answers are equal
//      for every event under every policy, because a matrix offering a toggle
//      the dispatcher ignores teaches the user something false.
//
// Mocked Prisma throughout (`useMockDatabase: true`), like every other
// integration suite here: the policy is one JSONB value, and reading it is a
// `findUnique` by primary key.
// =============================================================================

/** Point the mocked `system_settings` row at a specific policy. */
function storePolicy(notifications: unknown): void {
  (prismaMock.systemSettings.findUnique as jest.Mock).mockResolvedValue(
    createMockSystemSettings({
      value: {
        ...(notifications === undefined ? {} : { notifications }),
      },
    }),
  );
}

describe('Notification policy integration (#226)', () => {
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

  // ==========================================================================
  // GET /api/notifications/config
  // ==========================================================================

  describe('GET /api/notifications/config', () => {
    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .get('/api/notifications/config')
        .expect(401);
    });

    it('a viewer — who cannot read system settings at all — can read it', async () => {
      const viewer = await createMockViewerUser(context);

      // The premise, asserted rather than assumed: this is the endpoint the
      // viewer is locked out of, and the reason #226 does not simply widen
      // `system_settings:read` (which would also publish the rest of the
      // settings blob — the job queue, worker fleet and backup policy —
      // to every signed-in account).
      await request(context.app.getHttpServer())
        .get('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      const response = await request(context.app.getHttpServer())
        .get('/api/notifications/config')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data).toEqual({
        browserEnabled: true,
        pushEnabled: false,
        vapidPublicKey: null,
      });
    });

    it('an admin reads the same thing — the gate is authentication, not a role', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/notifications/config')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.browserEnabled).toBe(true);
    });

    it('reports `browserEnabled: false` once an administrator switches it off', async () => {
      storePolicy({ browserEnabled: false, disabledEvents: [] });
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/notifications/config')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.browserEnabled).toBe(false);
    });

    it('does not leak the per-event suppression list', async () => {
      // Which events a deployment considers noisy is not something a client
      // needs — the per-event answer arrives with each notification, as the
      // stream's `toast` flag — and it is a small map of operator judgement.
      storePolicy({
        browserEnabled: true,
        disabledEvents: ['security.role_changed'],
      });
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/notifications/config')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(Object.keys(response.body.data).sort()).toEqual([
        'browserEnabled',
        'pushEnabled',
        'vapidPublicKey',
      ]);
    });

    it('falls back to permissive when the stored row is malformed', async () => {
      // A damaged settings row must not silence notifications, and must not
      // 500 an endpoint every signed-in client calls on load.
      storePolicy('not an object at all');
      const viewer = await createMockViewerUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/notifications/config')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.browserEnabled).toBe(true);
    });
  });

  // ==========================================================================
  // GET /api/notifications/events — capability ∩ policy
  // ==========================================================================

  describe('GET /api/notifications/events applies the policy to `channels`', () => {
    async function readEvents(
      token: string,
    ): Promise<Array<{ key: string; channels: string[]; mandatory: boolean }>> {
      const response = await request(context.app.getHttpServer())
        .get('/api/notifications/events')
        .set(authHeader(token))
        .expect(200);

      return response.body.data;
    }

    it('offers every declared channel under the default policy', async () => {
      const viewer = await createMockViewerUser(context);

      const events = await readEvents(viewer.accessToken);

      for (const declared of NOTIFICATION_EVENTS) {
        const served = events.find((e) => e.key === declared.key);
        expect(served?.channels).toEqual(declared.channels);
      }
    });

    it('withdraws the browser channel from every optional event when the kill switch is off', async () => {
      storePolicy({ browserEnabled: false, disabledEvents: [] });
      const viewer = await createMockViewerUser(context);

      const events = await readEvents(viewer.accessToken);

      for (const event of events) {
        // MANDATORY EVENTS KEEP THEIRS, and that is the invariant of #226
        // rather than an oversight: their `notifications` row IS the delivery,
        // so removing the channel would stop the row being written. The policy
        // reaches those through `toast: false` on the stream instead — see
        // notification-policy-enforcement.spec.ts, which proves the row
        // survives. Every other event loses the channel outright.
        if (event.mandatory) continue;
        expect(event.channels).not.toContain('browser');
      }

      // Today `security.role_changed` is the only browser-capable event and it
      // is mandatory, so state the positive half explicitly — otherwise the
      // loop above is vacuously satisfied and would stay green if the filter
      // were deleted.
      const roleChanged = events.find((e) => e.key === 'security.role_changed');
      expect(roleChanged?.mandatory).toBe(true);
      expect(roleChanged?.channels).toContain('browser');
    });

    it('a per-event disable removes only that event’s browser channel', async () => {
      // Suppress an event that is NOT mandatory. Every browser-capable event in
      // today's registry is mandatory, so the observable effect here is on the
      // events' other channels being untouched; the removal itself is proven
      // over a synthetic optional event in notification-policy.spec.ts, which
      // tests the function rather than today's contents of a growing list.
      storePolicy({
        browserEnabled: true,
        disabledEvents: ['user.welcome'],
      });
      const viewer = await createMockViewerUser(context);

      const events = await readEvents(viewer.accessToken);

      for (const declared of NOTIFICATION_EVENTS) {
        const served = events.find((e) => e.key === declared.key);
        // `user.welcome` is email-only, so suppressing it changes nothing —
        // policy narrows the browser channel and never touches email.
        expect(served?.channels).toEqual(declared.channels);
      }
    });

    it('an unknown key in `disabledEvents` changes nothing', async () => {
      storePolicy({
        browserEnabled: true,
        disabledEvents: ['nothing.declares_this'],
      });
      const viewer = await createMockViewerUser(context);

      const events = await readEvents(viewer.accessToken);

      for (const declared of NOTIFICATION_EVENTS) {
        expect(events.find((e) => e.key === declared.key)?.channels).toEqual(
          declared.channels,
        );
      }
    });

    it('agrees with `resolveChannels` for every event under every policy', async () => {
      // THE AGREEMENT PROPERTY, end to end: what the endpoint publishes is what
      // the dispatcher would use for a user with no stored preferences.
      const policies = [
        { browserEnabled: true, disabledEvents: [] },
        { browserEnabled: false, disabledEvents: [] },
        { browserEnabled: true, disabledEvents: ['security.role_changed'] },
        { browserEnabled: false, disabledEvents: ['user.welcome'] },
      ];

      for (const policy of policies) {
        storePolicy(policy);
        const viewer = await createMockViewerUser(context);

        const events = await readEvents(viewer.accessToken);

        for (const declared of NOTIFICATION_EVENTS) {
          const served = events.find((e) => e.key === declared.key);

          expect(served?.channels).toEqual(policyChannels(declared, policy));
          expect(served?.channels).toEqual(
            resolveChannels(declared, {}, policy),
          );
        }
      }
    });
  });
});
