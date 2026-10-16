import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { BrowserNotificationChannel } from './channels/browser-notification.channel';
import { NotificationDeliveryService } from './notification-delivery.service';
import { DEFAULT_NOTIFICATION_POLICY, type NotificationPolicy } from './notification-policy';
import { NotificationPolicyService } from './notification-policy.service';
import { NotificationStreamService } from './notification-stream.service';
import { NotificationsService } from './notifications.service';
import {
  NOTIFICATION_CHANNEL_SENDERS,
  type NotificationChannelSender,
} from './notification.types';

// =============================================================================
// The admin toggle mutes the TOAST, never the ROW (issue #226, epic #215)
// =============================================================================
//
// THE INVARIANT THIS FILE EXISTS FOR, and the one thing in #226 that must not
// regress: `security.role_changed` is `mandatory: true` precisely so a
// privilege change is never silent, and `browser-notification.channel.ts`
// states that the durable `notifications` row IS the delivery while the OS
// toast is decoration on top of it. An operator who switches browser
// notifications off is muting the decoration. They must not thereby mute an
// audit-relevant inbox entry.
//
// So this suite drives the REAL dispatcher and the REAL browser channel — the
// preference gate, `policyChannels`, the INSERT and the publish, all of it —
// with the kill switch off, and asserts:
//
//   * `prisma.notification.create` was still called
//   * the stream still received the event
//   * and the only difference is `toast: false`
//
// Mocking the browser channel would have proven nothing here: the row write and
// the flag computation both live inside it, and this is a claim about what
// those two do relative to each other.
//
// The email channel IS mocked — #226 gives email no deployment-wide gate, and
// standing up transports and settings would add nothing to a policy test.
// =============================================================================

const RECIPIENT = {
  id: 'target-user-id',
  email: 'target@example.com',
};

const ROLE_CHANGE_PAYLOAD = {
  recipientEmail: RECIPIENT.email,
  previousRoles: ['admin'],
  currentRoles: ['viewer'],
  changedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const KILL_SWITCH_OFF: NotificationPolicy = {
  browserEnabled: false,
  disabledEvents: [],
};

const EVENT_SUPPRESSED: NotificationPolicy = {
  browserEnabled: true,
  disabledEvents: ['security.role_changed'],
};

describe('#226: the browser toggle suppresses the toast and never the notification row', () => {
  let notifications: NotificationsService;
  let prisma: MockPrismaService;
  let stream: { publish: jest.Mock };
  let emailSender: jest.Mocked<NotificationChannelSender>;
  let getPolicy: jest.Mock;

  async function buildWith(policy: NotificationPolicy): Promise<void> {
    prisma = createMockPrismaService();

    // The dispatcher's `loadRecipient`. No stored preferences at all — the
    // ordinary account — so nothing but the policy is narrowing anything.
    prisma.user.findUnique.mockResolvedValue({
      id: RECIPIENT.id,
      email: RECIPIENT.email,
      userSettings: null,
    } as any);

    prisma.notification.create.mockResolvedValue({
      id: 'notification-id',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    } as any);
    prisma.notificationDelivery.create.mockResolvedValue({
      id: 'delivery-id',
    } as any);
    prisma.notificationDelivery.update.mockResolvedValue({} as any);

    stream = { publish: jest.fn().mockReturnValue(1) };

    emailSender = {
      channel: 'email',
      resolveTo: jest.fn(() => RECIPIENT.email),
      deliver: jest
        .fn()
        .mockResolvedValue({ success: true, messageId: 'email-1' }),
    } as unknown as jest.Mocked<NotificationChannelSender>;

    getPolicy = jest.fn().mockResolvedValue(policy);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        NotificationDeliveryService,
        BrowserNotificationChannel,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationStreamService, useValue: stream },
        { provide: NotificationPolicyService, useValue: { getPolicy } },
        {
          provide: NOTIFICATION_CHANNEL_SENDERS,
          useFactory: (
            browser: BrowserNotificationChannel,
          ): NotificationChannelSender[] => [emailSender, browser],
          inject: [BrowserNotificationChannel],
        },
      ],
    }).compile();

    notifications = module.get(NotificationsService);
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('writes the row and streams it with toast:false when the kill switch is off', async () => {
    await buildWith(KILL_SWITCH_OFF);

    await notifications.notify(
      'security.role_changed',
      RECIPIENT.id,
      ROLE_CHANGE_PAYLOAD,
    );
    await notifications.flush();

    // THE ASSERTION THAT MATTERS. The inbox row exists.
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: RECIPIENT.id,
          eventKey: 'security.role_changed',
        }),
      }),
    );

    // And it was still published — the tab is told, so the bell updates live.
    expect(stream.publish).toHaveBeenCalledTimes(1);
    expect(stream.publish).toHaveBeenCalledWith(
      RECIPIENT.id,
      expect.objectContaining({
        eventKey: 'security.role_changed',
        toast: false,
      }),
    );
  });

  it('does the same when the event alone is suppressed', async () => {
    await buildWith(EVENT_SUPPRESSED);

    await notifications.notify(
      'security.role_changed',
      RECIPIENT.id,
      ROLE_CHANGE_PAYLOAD,
    );
    await notifications.flush();

    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(stream.publish).toHaveBeenCalledWith(
      RECIPIENT.id,
      expect.objectContaining({ toast: false }),
    );
  });

  it('publishes toast:true under the default policy', async () => {
    await buildWith(DEFAULT_NOTIFICATION_POLICY);

    await notifications.notify(
      'security.role_changed',
      RECIPIENT.id,
      ROLE_CHANGE_PAYLOAD,
    );
    await notifications.flush();

    expect(stream.publish).toHaveBeenCalledWith(
      RECIPIENT.id,
      expect.objectContaining({ toast: true }),
    );
  });

  it('records the delivery as SENT even with the toast suppressed', async () => {
    await buildWith(KILL_SWITCH_OFF);

    await notifications.notify(
      'security.role_changed',
      RECIPIENT.id,
      ROLE_CHANGE_PAYLOAD,
    );
    await notifications.flush();

    // A suppressed toast is not a failed delivery: the row was written, which
    // is what this channel promises. Recording it as a failure would fill
    // `notification_deliveries` with the consequences of a configuration
    // choice and bury the real failures that table exists to surface.
    const browserDelivery = prisma.notificationDelivery.create.mock.calls.find(
      (call: any) => call[0]?.data?.channel === 'browser',
    );
    expect(browserDelivery).toBeDefined();
    expect(prisma.notificationDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'sent' }),
      }),
    );
  });

  it('reads the policy once per dispatch and uses that one snapshot', async () => {
    await buildWith(KILL_SWITCH_OFF);

    await notifications.notify(
      'security.role_changed',
      RECIPIENT.id,
      ROLE_CHANGE_PAYLOAD,
    );
    await notifications.flush();

    // One read for the channel decision AND the toast flag. Two reads would be
    // two snapshots, and a policy edited mid-dispatch could then produce a row
    // whose `toast` contradicts the decision that wrote it.
    expect(getPolicy).toHaveBeenCalledTimes(1);
  });
});
