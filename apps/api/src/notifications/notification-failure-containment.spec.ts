import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationDeliveryStatus } from '@prisma/client';

import {
  EmailSettingsService,
  SesEmailProvider,
  SmtpEmailProvider,
  type EmailSettings,
} from '../email';
import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { IdentityNotifierAdapter } from '../platform/identity/identity-notifier.adapter';
import { EmailNotificationChannel } from './channels/email-notification.channel';
import { NotificationDeliveryService } from './notification-delivery.service';
import { DEFAULT_NOTIFICATION_POLICY } from './notification-policy';
import { NotificationPolicyService } from './notification-policy.service';
import { NotificationsService } from './notifications.service';
import {
  NOTIFICATION_CHANNEL_SENDERS,
  type NotificationChannelSender,
} from './notification.types';

// =============================================================================
// A send failure does not fail or roll back its trigger (issue #128, epic #109)
// =============================================================================
//
// THE SINGLE MOST IMPORTANT ASSERTION IN THE EPIC (#109 success criterion 9,
// and the property #128 exists to prove). Everything else in this framework is
// machinery; this is the guarantee that makes it safe to put a `notify()` call
// on a business path at all.
//
// It is asserted at the REAL SEAM rather than in isolation. The dispatcher,
// the delivery-record service and the email channel are all the real classes
// here, wired to a mail provider that is forced to fail, and the trigger is
// the real `IdentityNotifierAdapter.roleChanged`: the port the platform's
// identity slice calls AFTER a role change committed (#465; the role-replacing
// transaction itself is the platform's and is covered by its own suite). A test that mocked
// `NotificationsService` would prove only that a mock resolves — it would pass
// just as happily against an implementation that awaited the send inside the
// caller's transaction.
//
// Prisma is mocked, so the guarantee is stated at the layer that is ours: the
// port RESOLVES instead of rejecting — identity awaits it after its own write
// committed, so a rejection here would fail a role change that already
// happened — while every channel underneath it is failing as hard as it can.
// The complementary end-to-end assertion against a real database belongs with
// the integration suite.
// =============================================================================

const RECIPIENT = {
  id: 'target-user-id',
  email: 'target@example.com',
};

/** Settings that make the email channel actually attempt a send. */
const WORKING_EMAIL_SETTINGS: EmailSettings = {
  enabled: true,
  provider: 'ses',
  fromAddress: 'no-reply@example.com',
  fromName: 'Enterprise App Foundation',
};

describe('a notification send failure never fails or rolls back its trigger', () => {
  let notifier: IdentityNotifierAdapter;
  let notifications: NotificationsService;
  let prisma: MockPrismaService;
  let ses: { send: jest.Mock };
  let browserSender: jest.Mocked<NotificationChannelSender>;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    // ---------------------------------------------------------------------
    // One mock Prisma serves both the trigger and the (detached) dispatch, so
    // `user.findUnique` is keyed on the SHAPE of the call rather than on call
    // order. Ordering would be the wrong thing to encode anyway: the dispatch
    // is deliberately detached, so when its read lands relative to the
    // trigger's is not something this test should be asserting on.
    // ---------------------------------------------------------------------
    prisma.user.findUnique.mockImplementation(() =>
      // The dispatcher's `loadRecipient`.
      Promise.resolve({
        id: RECIPIENT.id,
        email: RECIPIENT.email,
        // No stored preferences. Irrelevant either way for a `mandatory`
        // event, which ignores them — but stated so the test does not
        // accidentally depend on the absent-key contract.
        userSettings: null,
      }) as any,
    );
    prisma.auditEvent.create.mockResolvedValue({} as any);
    prisma.notificationDelivery.create.mockResolvedValue({
      id: 'delivery-id',
    } as any);
    prisma.notificationDelivery.update.mockResolvedValue({} as any);

    // THE FORCED FAILURE. The provider REPORTS a failure rather than throwing,
    // which is the contract `EmailProvider.send` actually carries — a mail
    // server refusing a message is an ordinary result, not an exception.
    ses = { send: jest.fn().mockResolvedValue({ success: false, error: 'SES refused the message' }) };

    // A SECOND, HARSHER FAILURE on the other channel: a sender that THROWS,
    // violating `NotificationChannelSender`'s never-throw contract outright.
    // Included because #125's guarantee is explicitly required to survive a
    // channel written by somebody who did not read that contract, and a test
    // that only exercises well-behaved failures never checks that.
    browserSender = {
      channel: 'browser',
      resolveTo: jest.fn(() => RECIPIENT.id),
      deliver: jest.fn(() => {
        throw new Error('browser channel exploded');
      }),
    } as unknown as jest.Mocked<NotificationChannelSender>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IdentityNotifierAdapter,
        NotificationsService,
        NotificationDeliveryService,
        EmailNotificationChannel,
        { provide: PrismaService, useValue: prisma },
        // #226. The dispatcher now reads the deployment-wide notification
        // policy; this suite is not about that policy, so it gets the
        // permissive default every untouched deployment has.
        {
          provide: NotificationPolicyService,
          useValue: {
            getPolicy: jest.fn().mockResolvedValue(DEFAULT_NOTIFICATION_POLICY),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('https://app.example.com') },
        },
        {
          provide: EmailSettingsService,
          useValue: { get: jest.fn().mockResolvedValue(WORKING_EMAIL_SETTINGS) },
        },
        { provide: SesEmailProvider, useValue: ses },
        { provide: SmtpEmailProvider, useValue: { send: jest.fn() } },
        {
          provide: NOTIFICATION_CHANNEL_SENDERS,
          useFactory: (
            email: EmailNotificationChannel,
          ): NotificationChannelSender[] => [email, browserSender],
          inject: [EmailNotificationChannel],
        },
      ],
    }).compile();

    notifier = module.get(IdentityNotifierAdapter);
    notifications = module.get(NotificationsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const NOTICE = {
    recipientEmail: RECIPIENT.email,
    previousRoles: ['admin'],
    currentRoles: ['viewer'],
    changedAt: new Date('2026-09-01T00:00:00Z'),
  };

  it('the notification port returns normally while every channel fails', async () => {
    // 1. THE PORT RESOLVED. No rejection reached the caller (identity), whose
    //    own write had already committed.
    await expect(notifier.roleChanged(RECIPIENT.id, NOTICE)).resolves.toBeUndefined();

    // 2. The dispatch had not even run yet when the port returned — that is
    //    what "detached" means, and it is why the send cannot be inside the
    //    caller's transaction or on its latency budget.
    expect(ses.send).not.toHaveBeenCalled();

    // Drain the fire-and-forget dispatch, the same way `onModuleDestroy` does.
    await notifications.flush();

    // 3. Both channels were attempted and both failed — the failure was real,
    //    not a test that quietly never sent anything.
    expect(ses.send).toHaveBeenCalledTimes(1);
    expect(browserSender.deliver).toHaveBeenCalledTimes(1);

    // 4. And the failures were RECORDED rather than thrown: two delivery rows,
    //    both moved to `failed` with the reason. This is the operator's
    //    answer to "did the user get it?", which is the only thing that should
    //    change when a send fails.
    const statuses = prisma.notificationDelivery.update.mock.calls.map(
      (call: any) => call[0].data.status,
    );
    expect(statuses).toEqual([
      NotificationDeliveryStatus.failed,
      NotificationDeliveryStatus.failed,
    ]);
  });

  it('a provider that throws is contained just as well as one that reports failure', async () => {
    // The other half of the failure space: a transport that violates its
    // never-throw contract from inside `send`.
    ses.send.mockRejectedValue(new Error('socket hang up'));

    await expect(notifier.roleChanged(RECIPIENT.id, NOTICE)).resolves.toBeUndefined();

    // The dispatch itself must also settle rather than leaving an unhandled
    // rejection behind — `flush` resolving is the assertion.
    await expect(notifications.flush()).resolves.toBeUndefined();

    expect(ses.send).toHaveBeenCalledTimes(1);
  });
});
