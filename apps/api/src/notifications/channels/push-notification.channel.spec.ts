import { WebPushError } from 'web-push';

import { NOTIFICATION_EVENTS } from '../notification-events';
import type {
  NotificationDispatchContext,
  NotificationRecipient,
} from '../notification.types';
import type { PushConfigService } from '../push-config.service';
import { PushNotificationChannel } from './push-notification.channel';

// =============================================================================
// PushNotificationChannel — tests (issue #230, epic #215; #355 swapped the
// VAPID config source)
// =============================================================================
//
// `jest.mock('web-push', ...)` replaces `sendNotification`/`setVapidDetails`
// with mocks while keeping the REAL `WebPushError` class — the channel's own
// `import { WebPushError } from 'web-push'` resolves to the same mocked
// module, so a fake with the right shape but the wrong prototype would fail
// the `err instanceof WebPushError` check the pruning logic depends on. No
// real network call is ever attempted: `sendNotification` never has a real
// implementation in this suite.
//
// `mockPrisma` is a hand-rolled object (not `createMockPrismaService()`/
// `jest-mock-extended`) mirroring `browser-notification.channel.spec.ts`'s own
// choice: this suite is about the channel's branching (pruning, threshold,
// payload shape, VAPID plumbing), not about Prisma's generated types.
//
// -----------------------------------------------------------------------------
// #355: THE CHANNEL NOW READS `PushConfigService.resolveActiveVapidConfig()`,
// NOT `ConfigService.get('push.*')`
// -----------------------------------------------------------------------------
//
// `mockPushConfig.resolveActiveVapidConfig` stands in for the single call the
// channel now makes per delivery. Its return value IS the env/DB precedence
// answer — that precedence itself is `PushConfigService`'s own suite's job
// (`push-config.service.spec.ts`); this file only proves the channel reacts
// correctly to what it's handed back, including the case that matters most
// for #355's reason for being: an unconfigured deployment (`null`) now
// produces an honest, admin-actionable FAILED delivery — the channel is
// unconditionally registered (see `notifications.module.ts`), so this is the
// path that turns into a real `notification_deliveries` row where before this
// channel would never have been reached at all.
// =============================================================================

jest.mock('web-push', () => {
  const actual = jest.requireActual('web-push');
  return {
    ...actual,
    sendNotification: jest.fn(),
    setVapidDetails: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const webpush = jest.requireMock('web-push') as {
  sendNotification: jest.Mock;
  setVapidDetails: jest.Mock;
};

const recipient: NotificationRecipient = {
  userId: 'user-1',
  email: 'user@example.com',
  preferences: {},
};

const VAPID_PUBLIC_KEY = 'test-public-key';
const VAPID_PRIVATE_KEY = 'test-private-key';
const VAPID_SUBJECT = 'mailto:ops@example.com';

const ACTIVE_CONFIG = {
  publicKey: VAPID_PUBLIC_KEY,
  privateKey: VAPID_PRIVATE_KEY,
  subject: VAPID_SUBJECT,
};

function contextFor(eventKey: string, data: unknown = {}): NotificationDispatchContext {
  const event = NOTIFICATION_EVENTS.find((e) => e.key === eventKey);
  if (!event) {
    throw new Error(`Test fixture error: no such event '${eventKey}' in the registry.`);
  }
  return { event, recipient, data };
}

/** A `push_subscriptions` row shape, as `prisma.pushSubscription.findMany` would return it. */
function subscriptionRow(overrides: Partial<{
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failureCount: number;
}> = {}) {
  return {
    id: 'sub-1',
    userId: 'user-1',
    endpoint: 'https://push.example.com/endpoint-1',
    p256dh: 'p256dh-key',
    auth: 'auth-key',
    failureCount: 0,
    ...overrides,
  };
}

describe('PushNotificationChannel', () => {
  let channel: PushNotificationChannel;
  let mockPrisma: {
    pushSubscription: {
      findMany: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    notification: { create: jest.Mock };
  };
  let mockPushConfig: { resolveActiveVapidConfig: jest.Mock };

  beforeEach(() => {
    mockPrisma = {
      pushSubscription: {
        findMany: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      notification: { create: jest.fn() },
    };

    mockPushConfig = {
      resolveActiveVapidConfig: jest.fn().mockResolvedValue(ACTIVE_CONFIG),
    };

    channel = new PushNotificationChannel(
      mockPrisma as never,
      mockPushConfig as unknown as PushConfigService,
    );

    mockPrisma.notification.create.mockResolvedValue({ id: 'notif-1' });
    mockPrisma.pushSubscription.update.mockResolvedValue({ failureCount: 0 });
    mockPrisma.pushSubscription.delete.mockResolvedValue({});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // resolveTo
  // ==========================================================================

  describe('resolveTo', () => {
    it('returns the recipient userId', () => {
      expect(channel.resolveTo(recipient)).toBe('user-1');
    });

    it('returns null for an account-less recipient (userId: null)', () => {
      expect(channel.resolveTo({ ...recipient, userId: null })).toBeNull();
    });
  });

  // ==========================================================================
  // No subscriptions: fails cleanly, no web-push call
  // ==========================================================================

  describe('deliver() with no subscriptions for the user', () => {
    it('returns { success: false } and never calls web-push', async () => {
      mockPrisma.pushSubscription.findMany.mockResolvedValue([]);

      const result = await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toContain('No push subscriptions');
      expect(webpush.sendNotification).not.toHaveBeenCalled();
      // No subscriptions means nothing to notify about — the inbox row is
      // still written by the caller's browser channel if one runs; this
      // channel does not bail out before writing ITS OWN row, since the
      // deliverInner short-circuits before that point.
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // One subscription, success
  // ==========================================================================

  describe('deliver() with one subscription that succeeds', () => {
    it('returns { success: true }, resets failureCount to 0, and updates lastSuccessAt', async () => {
      const sub = subscriptionRow();
      mockPrisma.pushSubscription.findMany.mockResolvedValue([sub]);
      webpush.sendNotification.mockResolvedValue(undefined);

      const result = await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(result).toEqual({ success: true, messageId: 'notif-1' });
      expect(mockPrisma.pushSubscription.update).toHaveBeenCalledWith({
        where: { id: sub.id },
        data: { lastSuccessAt: expect.any(Date), failureCount: 0 },
      });
      expect(mockPrisma.pushSubscription.delete).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Multiple subscriptions: one succeeds, one fails — still an overall success
  // ==========================================================================

  describe('deliver() with multiple subscriptions, one succeeding and one failing', () => {
    it('reports { success: true } (at-least-one-success rule) and handles each branch independently via Promise.allSettled', async () => {
      const okSub = subscriptionRow({ id: 'sub-ok', endpoint: 'https://push.example.com/ok' });
      const badSub = subscriptionRow({ id: 'sub-bad', endpoint: 'https://push.example.com/bad' });
      mockPrisma.pushSubscription.findMany.mockResolvedValue([okSub, badSub]);

      webpush.sendNotification.mockImplementation((subscription: { endpoint: string }) => {
        if (subscription.endpoint === okSub.endpoint) return Promise.resolve(undefined);
        return Promise.reject(new Error('generic failure'));
      });
      mockPrisma.pushSubscription.update.mockResolvedValue({ failureCount: 1 });

      const result = await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(result).toEqual({ success: true, messageId: 'notif-1' });
      expect(webpush.sendNotification).toHaveBeenCalledTimes(2);

      // The success branch ran: lastSuccessAt/failureCount reset for the
      // succeeding subscription.
      expect(mockPrisma.pushSubscription.update).toHaveBeenCalledWith({
        where: { id: okSub.id },
        data: { lastSuccessAt: expect.any(Date), failureCount: 0 },
      });
      // The failure branch ALSO ran (independently, not aborted by the other
      // promise) — a generic rejection increments failureCount rather than
      // pruning outright.
      expect(mockPrisma.pushSubscription.update).toHaveBeenCalledWith({
        where: { id: badSub.id },
        data: { failureCount: { increment: 1 } },
        select: { failureCount: true },
      });
      expect(mockPrisma.pushSubscription.delete).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 404/410 prune the subscription row immediately
  // ==========================================================================

  describe('a 404 or 410 WebPushError prunes the subscription row', () => {
    it.each([404, 410])('deletes the subscription on a %d response, without touching failureCount', async (statusCode) => {
      const sub = subscriptionRow();
      mockPrisma.pushSubscription.findMany.mockResolvedValue([sub]);
      webpush.sendNotification.mockRejectedValue(
        new WebPushError('gone', statusCode, {}, '', sub.endpoint),
      );

      const result = await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(mockPrisma.pushSubscription.delete).toHaveBeenCalledWith({
        where: { id: sub.id },
      });
      // Pruned via the 404/410 path, not the failure-count path.
      expect(mockPrisma.pushSubscription.update).not.toHaveBeenCalled();
      // No other subscription succeeded, so the overall delivery is a failure.
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // 429/5xx: increments failureCount, deletes only once it hits the threshold
  // ==========================================================================

  describe('a 429/5xx WebPushError increments failureCount without deleting, until the threshold', () => {
    it('increments failureCount and does NOT delete when the new count is below MAX_PUSH_FAILURE_COUNT (5)', async () => {
      const sub = subscriptionRow({ failureCount: 3 });
      mockPrisma.pushSubscription.findMany.mockResolvedValue([sub]);
      webpush.sendNotification.mockRejectedValue(
        new WebPushError('server error', 500, {}, '', sub.endpoint),
      );
      // The updated row after `{ increment: 1 }` — 3 -> 4, still below 5.
      mockPrisma.pushSubscription.update.mockResolvedValue({ failureCount: 4 });

      await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(mockPrisma.pushSubscription.update).toHaveBeenCalledWith({
        where: { id: sub.id },
        data: { failureCount: { increment: 1 } },
        select: { failureCount: true },
      });
      expect(mockPrisma.pushSubscription.delete).not.toHaveBeenCalled();
    });

    it('deletes the subscription exactly when the incremented failureCount reaches MAX_PUSH_FAILURE_COUNT (5), not before', async () => {
      const sub = subscriptionRow({ failureCount: 4 });
      mockPrisma.pushSubscription.findMany.mockResolvedValue([sub]);
      webpush.sendNotification.mockRejectedValue(
        new WebPushError('too many requests', 429, {}, '', sub.endpoint),
      );
      // 4 -> 5: the threshold itself.
      mockPrisma.pushSubscription.update.mockResolvedValue({ failureCount: 5 });

      const result = await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(mockPrisma.pushSubscription.update).toHaveBeenCalledWith({
        where: { id: sub.id },
        data: { failureCount: { increment: 1 } },
        select: { failureCount: true },
      });
      expect(mockPrisma.pushSubscription.delete).toHaveBeenCalledWith({
        where: { id: sub.id },
      });
      expect(result.success).toBe(false);
    });

    it('does not delete one increment below the threshold (4 stays, 5 deletes) — boundary check', async () => {
      const sub = subscriptionRow({ failureCount: 3 });
      mockPrisma.pushSubscription.findMany.mockResolvedValue([sub]);
      webpush.sendNotification.mockRejectedValue(
        new WebPushError('bad gateway', 502, {}, '', sub.endpoint),
      );
      mockPrisma.pushSubscription.update.mockResolvedValue({ failureCount: 4 });

      await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(mockPrisma.pushSubscription.delete).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // The rendered payload is EXACTLY { id, eventKey, title, body, link }
  // ==========================================================================

  describe('the payload handed to sendNotification', () => {
    it('is exactly { id, eventKey, title, body, link } — no extra fields', async () => {
      const sub = subscriptionRow();
      mockPrisma.pushSubscription.findMany.mockResolvedValue([sub]);
      webpush.sendNotification.mockResolvedValue(undefined);

      await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
      const [, serializedPayload] = webpush.sendNotification.mock.calls[0] as [
        unknown,
        string,
        unknown,
      ];
      const payload = JSON.parse(serializedPayload);

      expect(Object.keys(payload).sort()).toEqual(
        ['body', 'eventKey', 'id', 'link', 'title'].sort(),
      );
      expect(payload).toEqual({
        id: 'notif-1',
        eventKey: 'user.welcome',
        title: expect.any(String),
        body: expect.any(String),
        link: null,
      });
    });
  });

  // ==========================================================================
  // VAPID details — now sourced from PushConfigService.resolveActiveVapidConfig()
  // ==========================================================================

  describe('VAPID details', () => {
    it('are passed as the third argument to every sendNotification call, and setVapidDetails is never called', async () => {
      const subA = subscriptionRow({ id: 'sub-a', endpoint: 'https://push.example.com/a' });
      const subB = subscriptionRow({ id: 'sub-b', endpoint: 'https://push.example.com/b' });
      mockPrisma.pushSubscription.findMany.mockResolvedValue([subA, subB]);
      webpush.sendNotification.mockResolvedValue(undefined);

      await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
      for (const call of webpush.sendNotification.mock.calls) {
        const [, , options] = call as [unknown, unknown, { vapidDetails: unknown }];
        expect(options).toEqual({
          vapidDetails: {
            subject: VAPID_SUBJECT,
            publicKey: VAPID_PUBLIC_KEY,
            privateKey: VAPID_PRIVATE_KEY,
          },
        });
      }
      expect(webpush.setVapidDetails).not.toHaveBeenCalled();
      expect(mockPushConfig.resolveActiveVapidConfig).toHaveBeenCalledTimes(1);
    });

    it('reads whatever subject resolveActiveVapidConfig() hands back — including its own generic fallback', async () => {
      mockPushConfig.resolveActiveVapidConfig.mockResolvedValue({
        publicKey: VAPID_PUBLIC_KEY,
        privateKey: VAPID_PRIVATE_KEY,
        subject: 'mailto:admin@example.com',
      });
      const sub = subscriptionRow();
      mockPrisma.pushSubscription.findMany.mockResolvedValue([sub]);
      webpush.sendNotification.mockResolvedValue(undefined);

      await channel.deliver(contextFor('user.welcome'), 'user-1');

      const [, , options] = webpush.sendNotification.mock.calls[0] as [
        unknown,
        unknown,
        { vapidDetails: { subject: string } },
      ];
      expect(options.vapidDetails.subject).toBe('mailto:admin@example.com');
    });

    // -------------------------------------------------------------------------
    // #355's whole point: an unconfigured deployment is now an HONEST FAILED
    // DELIVERY, not silence — because the channel is unconditionally
    // registered (notifications.module.ts), this branch is what a real
    // `notification_deliveries` row now looks like for it.
    // -------------------------------------------------------------------------

    it('fails cleanly, with no sendNotification call, when resolveActiveVapidConfig() resolves null (unconfigured/disabled)', async () => {
      mockPushConfig.resolveActiveVapidConfig.mockResolvedValue(null);
      mockPrisma.pushSubscription.findMany.mockResolvedValue([subscriptionRow()]);

      const result = await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(result.success).toBe(false);
      expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    it('the failure carries a clear, admin-actionable message naming Web Push as not configured/disabled', async () => {
      mockPushConfig.resolveActiveVapidConfig.mockResolvedValue(null);
      mockPrisma.pushSubscription.findMany.mockResolvedValue([subscriptionRow()]);

      const result = await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(result.success).toBe(false);
      expect((result as { error: string }).error).toMatch(/not configured|disabled/i);
    });

    it('still writes the notification row before discovering push is unconfigured — the inbox entry is not lost', async () => {
      mockPushConfig.resolveActiveVapidConfig.mockResolvedValue(null);
      mockPrisma.pushSubscription.findMany.mockResolvedValue([subscriptionRow()]);

      await channel.deliver(contextFor('user.welcome'), 'user-1');

      // The row is written before the VAPID lookup (see deliverInner's
      // ordering), so an operator inspecting the notifications table sees the
      // attempt even though the wire send never happened.
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // deliver() never throws, even for an unexpected (non-WebPushError) rejection
  // ==========================================================================

  describe('deliver() never throws', () => {
    it('resolves { success: false } when sendNotification rejects with a generic Error', async () => {
      mockPrisma.pushSubscription.findMany.mockResolvedValue([subscriptionRow()]);
      webpush.sendNotification.mockRejectedValue(new Error('ECONNRESET'));

      await expect(
        channel.deliver(contextFor('user.welcome'), 'user-1'),
      ).resolves.toMatchObject({ success: false });
    });

    it('resolves { success: false } even when prisma.pushSubscription.findMany itself rejects', async () => {
      mockPrisma.pushSubscription.findMany.mockRejectedValue(new Error('db unavailable'));

      await expect(
        channel.deliver(contextFor('user.welcome'), 'user-1'),
      ).resolves.toMatchObject({ success: false });
      expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    it('resolves { success: false } when prisma.notification.create rejects', async () => {
      mockPrisma.pushSubscription.findMany.mockResolvedValue([subscriptionRow()]);
      mockPrisma.notification.create.mockRejectedValue(new Error('db down'));

      const result = await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(result.success).toBe(false);
      expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    it('resolves { success: false } when resolveActiveVapidConfig() itself rejects', async () => {
      mockPrisma.pushSubscription.findMany.mockResolvedValue([subscriptionRow()]);
      mockPushConfig.resolveActiveVapidConfig.mockRejectedValue(new Error('db down'));

      const result = await channel.deliver(contextFor('user.welcome'), 'user-1');

      expect(result.success).toBe(false);
      expect(webpush.sendNotification).not.toHaveBeenCalled();
    });

    it('resolves { success: false } when the render step throws (a registered template blows up)', async () => {
      // security.role_changed is EVENT_BROWSER_TEMPLATES' one entry, and it
      // reads fields off `data` — an empty payload makes it throw.
      mockPrisma.pushSubscription.findMany.mockResolvedValue([subscriptionRow()]);

      const result = await channel.deliver(
        contextFor('security.role_changed', {}),
        'user-1',
      );

      expect(result.success).toBe(false);
      expect(webpush.sendNotification).not.toHaveBeenCalled();
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });
  });
});
