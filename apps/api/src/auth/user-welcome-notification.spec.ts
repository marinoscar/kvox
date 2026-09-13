import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import { AdminBootstrapService } from '../common/services/admin-bootstrap.service';
import { AllowlistService } from '../allowlist/allowlist.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { DEFAULT_NOTIFICATION_POLICY } from '../notifications/notification-policy';
import { NotificationPolicyService } from '../notifications/notification-policy.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  NOTIFICATION_CHANNEL_SENDERS,
  type ChannelDeliveryResult,
  type NotificationChannelSender,
  type NotificationRecipient,
} from '../notifications/notification.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { GoogleProfile } from './strategies/google.strategy';

// =============================================================================
// `user.welcome` fires only after the creating transaction has committed
// (issue #128, epic #109)
// =============================================================================
//
// auth.service.spec.ts asserts the CALL SITE contract with `NotificationsService`
// mocked away (fire-once, never on login, never on identity-linking, never on
// a post-creation refusal). This file wires the REAL dispatcher instead, to
// prove the property that requires it: `notify('user.welcome', user.id, ...)`
// hands the dispatcher only an id, and the dispatcher resolves the recipient
// through ITS OWN `prisma.user.findUnique` call — a fresh read, not the row
// `createNewUser`'s transaction produced. That is the mechanism the header
// comment in auth.service.ts is describing when it says raising this inside
// the transaction "would have the dispatch race a row it cannot see": the
// dispatch is detached (a later microtask) and reads on its own connection,
// so it only ever sees what has actually committed.
// =============================================================================

const NEW_USER_ID = 'newly-created-user-id';

const mockGoogleProfile: GoogleProfile = {
  id: 'google-999',
  email: 'welcome-me@example.com',
  displayName: 'Welcome Me',
  picture: 'https://example.com/photo.jpg',
};

function makeEmailSender(): jest.Mocked<NotificationChannelSender> {
  return {
    channel: 'email',
    resolveTo: jest.fn((recipient: NotificationRecipient) => recipient.email),
    deliver: jest
      .fn()
      .mockResolvedValue({ success: true, messageId: 'msg-1' } satisfies ChannelDeliveryResult),
  } as jest.Mocked<NotificationChannelSender>;
}

describe('user.welcome: fires after commit, and the dispatcher reads the recipient on its own connection', () => {
  let authService: AuthService;
  let notifications: NotificationsService;
  let prisma: MockPrismaService;
  let emailSender: jest.Mocked<NotificationChannelSender>;

  beforeEach(async () => {
    prisma = createMockPrismaService();
    emailSender = makeEmailSender();

    const mockRole = { id: 'viewer-role', name: 'viewer', rolePermissions: [] };
    const createdUser = {
      id: NEW_USER_ID,
      email: mockGoogleProfile.email,
      isActive: true,
      userRoles: [{ role: mockRole }],
    };

    prisma.userIdentity.findUnique.mockResolvedValue(null as never);
    // The "identity-linking" lookup by email, inside `handleGoogleLogin` —
    // `include`d, never `select`ed. Distinct from the dispatcher's own read
    // below by that shape, exactly as notification-failure-containment.spec.ts
    // distinguishes its two `user.findUnique` call sites.
    prisma.user.findUnique.mockImplementation((args: any) => {
      if (args?.select) {
        // THE DISPATCHER'S OWN READ (`NotificationsService.loadRecipient`).
        // Keyed on the id `notify()` was actually given, proving the
        // dispatcher never received — and did not need — the row the
        // transaction produced.
        if (args.where?.id === NEW_USER_ID) {
          return Promise.resolve({
            id: NEW_USER_ID,
            email: mockGoogleProfile.email,
            userSettings: null,
          }) as any;
        }
        return Promise.resolve(null) as any;
      }
      // The pre-creation "does this email already exist" check.
      return Promise.resolve(null) as any;
    });
    prisma.role.findUnique.mockResolvedValue(mockRole as never);
    prisma.$transaction.mockImplementation(async (callback: any) => callback(prisma));
    prisma.user.create.mockResolvedValue(createdUser as never);
    prisma.user.update.mockResolvedValue(createdUser as never);
    prisma.refreshToken.create.mockResolvedValue({} as never);
    prisma.notificationDelivery.create.mockResolvedValue({ id: 'delivery-1' } as never);
    prisma.notificationDelivery.update.mockResolvedValue({} as never);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        NotificationsService,
        NotificationDeliveryService,
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
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue('jwt'),
            signAsync: jest.fn().mockResolvedValue('jwt'),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(undefined) },
        },
        {
          provide: AdminBootstrapService,
          useValue: { shouldGrantAdminRole: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: AllowlistService,
          useValue: {
            isEmailAllowed: jest.fn().mockResolvedValue(true),
            markEmailClaimed: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NOTIFICATION_CHANNEL_SENDERS, useValue: [emailSender] },
      ],
    }).compile();

    authService = module.get(AuthService);
    notifications = module.get(NotificationsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('the dispatcher resolves the recipient through its own keyed query, using only the id notify() was given', async () => {
    // `notify` is detached (see notifications.service.ts's header): it never
    // hands the dispatcher the row `createNewUser`'s transaction produced,
    // only `user.id`. Awaiting `handleGoogleLogin` proves the trigger side
    // (the login itself, and the scheduling call) completed; draining the
    // dispatcher — the same drain `onModuleDestroy` performs — is what proves
    // the dispatcher then went and read the recipient FOR ITSELF.
    await authService.handleGoogleLogin(mockGoogleProfile);
    await notifications.flush();

    const selectCalls = prisma.user.findUnique.mock.calls.filter(
      ([args]: [any]) => args?.select,
    );
    expect(selectCalls).toHaveLength(1);
    expect(selectCalls[0][0]).toMatchObject({
      where: { id: NEW_USER_ID },
    });

    // And the send that read reached actually happened, addressed to the
    // account the dispatcher's own query resolved — not a value carried over
    // from the creation transaction.
    expect(emailSender.deliver).toHaveBeenCalledTimes(1);
    const [, to] = emailSender.deliver.mock.calls[0];
    expect(to).toBe(mockGoogleProfile.email);
  });

  it('if the dispatcher\'s own read cannot see the row, delivery is skipped rather than thrown — the reason committing first matters', async () => {
    // Simulate what raising `notify` BEFORE commit would expose the dispatcher
    // to: its own connection cannot see the row yet.
    prisma.user.findUnique.mockImplementation((args: any) => {
      if (args?.select) return Promise.resolve(null) as any;
      return Promise.resolve(null) as any;
    });

    await expect(authService.handleGoogleLogin(mockGoogleProfile)).resolves.toBeDefined();
    await expect(notifications.flush()).resolves.toBeUndefined();

    expect(emailSender.deliver).not.toHaveBeenCalled();
  });
});
