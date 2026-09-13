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
import { UsersService } from '../users/users.service';
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
// `security.role_changed` reaches both channels, mandatory, with the delta
// (issue #128, epic #109)
// =============================================================================
//
// The sibling of notification-failure-containment.spec.ts's suite: that file
// proves failure cannot roll back or fail `UsersService.updateUserRoles`. This
// file proves the HAPPY PATH properties #128 calls out for `security.role_changed`
// specifically, wired at the same real seam — the real `UsersService`, the real
// `NotificationsService` (dispatcher, preference resolution, `mandatory`
// override), and the real `EmailNotificationChannel`, all against a mocked
// Prisma:
//
//   1. It fires on a real role update and the payload carries the BEFORE state
//      as well as the after — a delta, not just the new roles.
//   2. Being `mandatory: true`, it is delivered even with an explicit stored
//      `false` for BOTH declared channels.
//   3. It reaches both `email` and `browser`.
//
// A test that mocked `NotificationsService` (as users.service.spec.ts does)
// could only prove `notify()` was called with the right arguments — it could
// not prove that a stored `false` fails to suppress a mandatory event, because
// that gate lives inside the real dispatcher, not at the call site.
// =============================================================================

const RECIPIENT = {
  id: 'target-user-id',
  email: 'target@example.com',
};

const ADMIN_USER_ID = 'admin-user-id';

const WORKING_EMAIL_SETTINGS: EmailSettings = {
  enabled: true,
  provider: 'ses',
  fromAddress: 'no-reply@example.com',
  fromName: 'Enterprise App Foundation',
};

const ROLES = {
  admin: { id: 'admin-role-id', name: 'admin' },
  viewer: { id: 'viewer-role-id', name: 'viewer' },
};

describe('security.role_changed: mandatory, both channels, and the before/after delta', () => {
  let users: UsersService;
  let prisma: MockPrismaService;
  let notifications: NotificationsService;
  let ses: { send: jest.Mock };
  let browserSender: jest.Mocked<NotificationChannelSender>;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    // Same shape-keyed mock as notification-failure-containment.spec.ts: one
    // mock Prisma serves both the trigger (`updateUserRoles`) and the
    // (detached) dispatch, so `user.findUnique` is keyed on the SHAPE of the
    // call rather than on call order.
    prisma.user.findUnique.mockImplementation((args: any) => {
      // The dispatcher's `loadRecipient` — a `select`, not an `include`.
      // BOTH channels are explicitly muted here — the property under test is
      // that `mandatory` ignores this entirely.
      if (args?.select) {
        return Promise.resolve({
          id: RECIPIENT.id,
          email: RECIPIENT.email,
          userSettings: {
            value: {
              notifications: {
                email: { 'security.role_changed': false },
                browser: { 'security.role_changed': false },
              },
            },
          },
        }) as any;
      }

      // `getUserById`, at the end of `updateUserRoles`.
      if (args?.include?.identities) {
        return Promise.resolve({
          ...RECIPIENT,
          displayName: null,
          providerDisplayName: null,
          profileImageUrl: null,
          providerProfileImageUrl: null,
          isActive: true,
          userRoles: [{ role: ROLES.viewer }],
          identities: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        }) as any;
      }

      // The validation lookup at the top of `updateUserRoles`, carrying the
      // BEFORE state of the roles — `admin`, about to become `viewer`.
      return Promise.resolve({
        ...RECIPIENT,
        isActive: true,
        userRoles: [{ role: ROLES.admin }],
      }) as any;
    });

    prisma.role.findMany.mockResolvedValue([ROLES.viewer] as any);
    prisma.$transaction.mockImplementation(async (cb: any) => cb(prisma));
    prisma.userRole.deleteMany.mockResolvedValue({ count: 1 } as any);
    prisma.userRole.createMany.mockResolvedValue({ count: 1 } as any);
    prisma.auditEvent.create.mockResolvedValue({} as any);
    prisma.notificationDelivery.create.mockResolvedValue({
      id: 'delivery-id',
    } as any);
    prisma.notificationDelivery.update.mockResolvedValue({} as any);

    ses = { send: jest.fn().mockResolvedValue({ success: true, messageId: 'ses-1' }) };

    browserSender = {
      channel: 'browser',
      resolveTo: jest.fn(() => RECIPIENT.id),
      deliver: jest
        .fn()
        .mockResolvedValue({ success: true, messageId: 'browser-1' }),
    } as unknown as jest.Mocked<NotificationChannelSender>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
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

    users = module.get(UsersService);
    notifications = module.get(NotificationsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('is delivered over BOTH channels despite an explicit stored false on both, and the payload carries the before/after delta', async () => {
    const result = await users.updateUserRoles(
      RECIPIENT.id,
      { roleNames: ['viewer'] },
      ADMIN_USER_ID,
    );

    expect(result.roles).toEqual(['viewer']);

    await notifications.flush();

    // MANDATORY OVERRIDES THE EXPLICIT FALSE ON BOTH CHANNELS.
    expect(ses.send).toHaveBeenCalledTimes(1);
    expect(browserSender.deliver).toHaveBeenCalledTimes(1);

    // Both delivery attempts recorded as sent, not skipped.
    const statuses = prisma.notificationDelivery.update.mock.calls.map(
      (call: any) => call[0].data.status,
    );
    expect(statuses).toEqual([
      NotificationDeliveryStatus.sent,
      NotificationDeliveryStatus.sent,
    ]);

    // THE PAYLOAD CARRIES THE DELTA. `browserSender.deliver`'s context is the
    // most direct read of what `NotificationsService` actually dispatched —
    // it is the second argument to `sender.deliver(context, to)`.
    const [context] = browserSender.deliver.mock.calls[0] as unknown as [
      { data: { previousRoles: string[]; currentRoles: string[] } },
      string,
    ];
    expect(context.data.previousRoles).toEqual(['admin']);
    expect(context.data.currentRoles).toEqual(['viewer']);

    // And the outbound email itself carries the same delta, rendered into the
    // message actually handed to the transport. `roleChangedEmail` title-cases
    // role names for the reader ('admin' -> 'Admin'), so the text part carries
    // the capitalised form.
    const [message] = ses.send.mock.calls[0] as [{ html: string; text: string }];
    expect(message.text).toContain('Admin');
    expect(message.text).toContain('Viewer');
  });

  it('reaches an admin who changes their OWN roles too — no self-suppression', async () => {
    // Admin keeps the admin role but also grants themselves contributor —
    // allowed by the self-prevention rule (`admin` stays present).
    prisma.role.findMany.mockResolvedValue([ROLES.admin] as any);

    const result = await users.updateUserRoles(
      ADMIN_USER_ID,
      { roleNames: ['admin'] },
      ADMIN_USER_ID,
    );

    expect(result).toBeDefined();

    await notifications.flush();

    expect(ses.send).toHaveBeenCalledTimes(1);
    expect(browserSender.deliver).toHaveBeenCalledTimes(1);
  });
});
