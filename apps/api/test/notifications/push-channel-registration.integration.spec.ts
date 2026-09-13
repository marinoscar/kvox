import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  NOTIFICATION_CHANNEL_SENDERS,
  type NotificationChannelSender,
} from '../../src/notifications/notification.types';

// =============================================================================
// Unconditional registration of PushNotificationChannel (issue #355)
// =============================================================================
//
// UNTIL #355, `notifications.module.ts`'s factory pushed
// `PushNotificationChannel` into the `NOTIFICATION_CHANNEL_SENDERS` array only
// when `PushSubscriptionService.isEnabled()` was true (both VAPID env vars
// configured) AT BOOT — see this file's git history for that suite. #355
// REMOVED the premise that made that the right call: Web Push configuration
// is now admin-UI-configurable at RUNTIME through `PushConfigController`/
// `PushConfigService`, with no restart, so a deployment that has not yet
// generated a key pair has a real, in-app remedy rather than a channel that
// silently does not exist. `push` now follows the exact same pattern
// `email`/`browser` already do: unconditional registration, with
// `PushNotificationChannel`'s own defensive guard (an unresolved VAPID
// config -> `{ success: false, error }`, now backed by
// `PushConfigService.resolveActiveVapidConfig()`) as the real, always-live
// gate. See `notifications.module.ts`'s own header comment for the full
// reasoning, and `src/notifications/channels/push-notification.channel.spec.ts`
// for proof of the honest-failed-delivery behaviour this enables.
//
// This is exercised over a REAL, fully-wired `NotificationsModule` (via the
// full `AppModule`, mocked Prisma only) rather than a hand-built test module
// with the providers reimplemented, so a drift between this test and the real
// factory wiring is structurally impossible — there is only one factory, and
// this is it.
//
// `NOTIFICATION_CHANNEL_SENDERS` is NOT exported from `NotificationsModule`
// (see that file's header: exporting internals would let a feature reach past
// the dispatcher's preference/mandatory gates). `context.module.get(token,
// { strict: false })` is the same escape hatch `storage.integration.spec.ts`
// already uses to reach `STORAGE_PROVIDER` for an equivalent reason — it
// searches the whole compiled container rather than only what the root module
// exports, which is exactly what a white-box test of an internal wiring
// decision needs.
// =============================================================================

function channelsOf(context: TestContext): string[] {
  const senders = context.module.get<NotificationChannelSender[]>(
    NOTIFICATION_CHANNEL_SENDERS,
    { strict: false },
  );
  return senders.map((sender) => sender.channel);
}

describe('NOTIFICATION_CHANNEL_SENDERS: push is unconditionally registered (#355)', () => {
  describe('no VAPID configuration anywhere (env vars unset, no admin-configured row)', () => {
    let context: TestContext;

    beforeAll(async () => {
      // Belt-and-braces: `.env.test` already declares neither key, but a
      // prior describe block in a shared worker process must not be able to
      // leak env state into this one.
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;

      context = await createTestApp({ useMockDatabase: true });
    });

    afterAll(async () => {
      await closeTestApp(context);
    });

    beforeEach(() => {
      resetPrismaMock();
      setupBaseMocks();
    });

    it('STILL includes "push" in the resolved channel senders — registration no longer depends on configuration', () => {
      expect(channelsOf(context)).toContain('push');
    });

    it('includes "email" and "browser" too — push joins them rather than replacing the gate', () => {
      const channels = channelsOf(context);
      expect(channels).toContain('email');
      expect(channels).toContain('browser');
    });

    it('registers exactly one sender per channel — no duplicate push entry', () => {
      const channels = channelsOf(context);
      expect(channels.filter((c) => c === 'push')).toHaveLength(1);
      expect(channels.sort()).toEqual(['browser', 'email', 'push']);
    });
  });

  describe('legacy env vars ARE configured (a pre-#355 deployment that never touches the admin UI)', () => {
    let context: TestContext;

    beforeAll(async () => {
      process.env.VAPID_PUBLIC_KEY = 'test-public-key';
      process.env.VAPID_PRIVATE_KEY = 'test-private-key';

      context = await createTestApp({ useMockDatabase: true });
    });

    afterAll(async () => {
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;

      await closeTestApp(context);
    });

    beforeEach(() => {
      resetPrismaMock();
      setupBaseMocks();
    });

    it('includes "push" — the same as with no env vars, since registration is no longer gated on them', () => {
      expect(channelsOf(context)).toContain('push');
    });
  });
});
