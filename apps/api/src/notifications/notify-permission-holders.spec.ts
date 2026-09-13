import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { NotificationDeliveryService } from './notification-delivery.service';
import { DEFAULT_NOTIFICATION_POLICY } from './notification-policy';
import { NotificationPolicyService } from './notification-policy.service';
import { NotificationsService } from './notifications.service';
import {
  NOTIFICATION_CHANNEL_SENDERS,
  type ChannelDeliveryResult,
  type NotificationChannelSender,
  type NotificationRecipient,
} from './notification.types';

// =============================================================================
// notifyPermissionHolders / notifyPermissionHoldersNow — tests (#288, epic #254)
// =============================================================================
//
// The third way of BUILDING a recipient (after `notify`'s user id and
// `notifyAddress`'s email address), and the first whose audience is a SET. What
// is proven here is exactly the set of claims the method's header makes:
//
//   1. The audience is resolved as ACTIVE users holding the permission through
//      any role — asserted against the query itself, because that predicate is
//      the whole feature and a mocked Prisma cannot execute it.
//   2. It fans out through the SAME per-user path as `notify`, so the
//      preference gate, `mandatory` and the delivery rows are not
//      reimplemented.
//   3. Zero recipients is a silent no-op, not a warning and not a throw.
//   4. A throwing recipient query does not reject and dispatches nothing.
//   5. One recipient's failure does not silence the rest.
//   6. `alsoNotifyUserIds` unions and DE-DUPLICATES by user id.
//   7. The awaited sibling has delivered everything by the time it resolves —
//      the property `DatabaseRestoreService.swap()` depends on, because a
//      detached dispatch would be dropped by its `process.exit(0)`.
//
// The dispatcher, the delivery-record service and the preference resolution are
// all REAL here; only Prisma and the transports are stand-ins. A suite that
// mocked the dispatch would prove nothing about (2).
// =============================================================================

const EVENT = 'db_backup.backup_failed';
const PERMISSION = 'db_backup:read';

function makeSender(
  channel: 'email' | 'browser',
): jest.Mocked<NotificationChannelSender> {
  return {
    channel,
    resolveTo: jest.fn((recipient: NotificationRecipient) =>
      channel === 'email' ? recipient.email : `browser:${recipient.userId}`,
    ),
    deliver: jest
      .fn()
      .mockResolvedValue({ success: true, messageId: 'msg' } satisfies ChannelDeliveryResult),
  } as unknown as jest.Mocked<NotificationChannelSender>;
}

describe('NotificationsService.notifyPermissionHolders', () => {
  let service: NotificationsService;
  let prisma: MockPrismaService;
  let emailSender: jest.Mocked<NotificationChannelSender>;
  let browserSender: jest.Mocked<NotificationChannelSender>;

  /** Users the fake audience query returns. */
  function holders(...ids: string[]): void {
    prisma.user.findMany.mockResolvedValue(ids.map((id) => ({ id })) as never);
  }

  beforeEach(async () => {
    prisma = createMockPrismaService();

    holders();

    // `loadRecipient` — one row per user id, with no stored preferences.
    prisma.user.findUnique.mockImplementation((async (args: {
      where: { id: string };
    }) => ({
      id: args.where.id,
      email: `${args.where.id}@example.com`,
      userSettings: null,
    })) as never);


    prisma.notificationDelivery.create.mockResolvedValue({ id: 'delivery' } as never);
    prisma.notificationDelivery.update.mockResolvedValue({} as never);

    emailSender = makeSender('email');
    browserSender = makeSender('browser');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        NotificationDeliveryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: NotificationPolicyService,
          useValue: {
            getPolicy: jest.fn().mockResolvedValue(DEFAULT_NOTIFICATION_POLICY),
          },
        },
        {
          provide: NOTIFICATION_CHANNEL_SENDERS,
          useValue: [emailSender, browserSender],
        },
      ],
    }).compile();

    service = module.get(NotificationsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. THE AUDIENCE QUERY
  // ---------------------------------------------------------------------------

  it('resolves ACTIVE users holding the permission through any role, in one query selecting only ids', async () => {
    holders('admin-1');

    await service.notifyPermissionHolders(EVENT, PERMISSION, {});
    await service.flush();

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        // Deactivated accounts cannot sign in and therefore cannot act on an
        // operational failure. This is a DIFFERENT question from
        // `loadRecipient`'s deliberate refusal to filter on `isActive`, where
        // the account is the SUBJECT of the event rather than an audience for
        // somebody else's incident.
        isActive: true,
        userRoles: {
          some: {
            role: {
              rolePermissions: { some: { permission: { name: PERMISSION } } },
            },
          },
        },
      },
      // Only ids. A failure path must not pull settings blobs or profile rows
      // for an audience it may not even dispatch to.
      select: { id: true },
    });
  });

  it('does not dispatch to a user who is not in the resolved audience', async () => {
    holders('admin-1');

    await service.notifyPermissionHolders(EVENT, PERMISSION, {});
    await service.flush();

    const recipients = prisma.user.findUnique.mock.calls.map(
      (call) => (call[0].where as { id: string }).id,
    );

    expect(recipients).toEqual(['admin-1']);
  });

  // ---------------------------------------------------------------------------
  // 2. IT REUSES THE PER-USER PATH
  // ---------------------------------------------------------------------------

  it('fans out to every holder over the event’s declared channels, one delivery row per attempt', async () => {
    holders('admin-1', 'admin-2');

    await service.notifyPermissionHolders(EVENT, PERMISSION, { runId: 'run-1' });
    await service.flush();

    // Two recipients x two channels (`db_backup.backup_failed` declares email
    // and browser).
    expect(emailSender.deliver).toHaveBeenCalledTimes(2);
    expect(browserSender.deliver).toHaveBeenCalledTimes(2);
    expect(prisma.notificationDelivery.create).toHaveBeenCalledTimes(4);
  });

  it('honours a stored per-channel mute, because it goes through the same gate as notify()', async () => {
    // THE POINT OF REUSING `dispatchToUser`. If this method had its own fan-out
    // it could — and eventually would — forget the preference gate.
    holders('admin-1');
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin-1@example.com',
      userSettings: {
        value: { notifications: { email: { [EVENT]: false } } },
      },
    } as never);

    await service.notifyPermissionHolders(EVENT, PERMISSION, {});
    await service.flush();

    expect(emailSender.deliver).not.toHaveBeenCalled();
    expect(browserSender.deliver).toHaveBeenCalledTimes(1);
  });

  it('ignores a stored mute for a MANDATORY event, again through the same gate', async () => {
    holders('admin-1');
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin-1@example.com',
      userSettings: {
        value: {
          notifications: {
            email: { 'db_backup.restore_completed': false },
            browser: { 'db_backup.restore_completed': false },
          },
        },
      },
    } as never);

    await service.notifyPermissionHolders(
      'db_backup.restore_completed',
      PERMISSION,
      {},
    );
    await service.flush();

    expect(emailSender.deliver).toHaveBeenCalledTimes(1);
    expect(browserSender.deliver).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // 3 & 4. THE TWO QUIET OUTCOMES
  // ---------------------------------------------------------------------------

  it('zero recipients is a silent no-op: nothing dispatched, nothing recorded, nothing thrown', async () => {
    holders();

    await expect(
      service.notifyPermissionHolders(EVENT, PERMISSION, {}),
    ).resolves.toBeUndefined();
    await service.flush();

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(emailSender.deliver).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
  });

  it('a THROWING recipient query does not reject and dispatches nothing', async () => {
    prisma.user.findMany.mockRejectedValue(new Error('connection reset'));

    await expect(
      service.notifyPermissionHolders(EVENT, PERMISSION, {}),
    ).resolves.toBeUndefined();
    await expect(service.flush()).resolves.toBeUndefined();

    expect(emailSender.deliver).not.toHaveBeenCalled();
    expect(prisma.notificationDelivery.create).not.toHaveBeenCalled();
  });

  it('an unknown event key is a no-op that never even resolves an audience', async () => {
    await expect(
      service.notifyPermissionHolders('does.not_exist', PERMISSION, {}),
    ).resolves.toBeUndefined();
    await service.flush();

    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 5. ONE BAD RECIPIENT DOES NOT SILENCE THE REST
  // ---------------------------------------------------------------------------

  it('a recipient whose row cannot be read does not stop the recipients after it', async () => {
    holders('admin-1', 'admin-2', 'admin-3');
    prisma.user.findUnique.mockImplementation((async (args: {
      where: { id: string };
    }) => {
      if (args.where.id === 'admin-1') throw new Error('row read failed');

      return {
        id: args.where.id,
        email: `${args.where.id}@example.com`,
        userSettings: null,
      };
    }) as never);

    await service.notifyPermissionHolders(EVENT, PERMISSION, {});
    await expect(service.flush()).resolves.toBeUndefined();

    // admin-2 and admin-3 were still delivered to.
    expect(emailSender.deliver).toHaveBeenCalledTimes(2);
  });

  // ---------------------------------------------------------------------------
  // 6. `alsoNotifyUserIds`
  // ---------------------------------------------------------------------------

  it('unions alsoNotifyUserIds with the permission holders', async () => {
    holders('admin-1');

    await service.notifyPermissionHolders(EVENT, PERMISSION, {}, {
      alsoNotifyUserIds: ['actor-9'],
    });
    await service.flush();

    const recipients = prisma.user.findUnique.mock.calls.map(
      (call) => (call[0].where as { id: string }).id,
    );

    expect(recipients).toEqual(['admin-1', 'actor-9']);
  });

  it('DE-DUPLICATES by user id: an actor who also holds the permission is notified once', async () => {
    // The failure this exists to prevent: two emails and two bell rows for one
    // restore, which is what sending the actor separately would produce.
    holders('admin-1', 'actor-9');

    await service.notifyPermissionHolders(EVENT, PERMISSION, {}, {
      alsoNotifyUserIds: ['actor-9'],
    });
    await service.flush();

    const recipients = prisma.user.findUnique.mock.calls.map(
      (call) => (call[0].where as { id: string }).id,
    );

    expect(recipients).toEqual(['admin-1', 'actor-9']);
    expect(emailSender.deliver).toHaveBeenCalledTimes(2);
  });

  it('an empty alsoNotifyUserIds changes nothing', async () => {
    holders('admin-1');

    await service.notifyPermissionHolders(EVENT, PERMISSION, {}, {
      alsoNotifyUserIds: [],
    });
    await service.flush();

    expect(emailSender.deliver).toHaveBeenCalledTimes(1);
  });

  it('still NARROWS on options.channels, exactly as notify() does', async () => {
    holders('admin-1');

    await service.notifyPermissionHolders(EVENT, PERMISSION, {}, {
      channels: ['email'],
    });
    await service.flush();

    expect(emailSender.deliver).toHaveBeenCalledTimes(1);
    expect(browserSender.deliver).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 7. THE AWAITED SIBLING
  // ---------------------------------------------------------------------------

  describe('notifyPermissionHoldersNow', () => {
    it('has delivered to every recipient by the time it resolves — the property the restore’s process.exit depends on', async () => {
      holders('admin-1', 'admin-2');

      await service.notifyPermissionHoldersNow(EVENT, PERMISSION, {});

      // NO `flush()`. If this needed draining, a `process.exit(0)` immediately
      // after the call would drop the notification — which for the
      // `mandatory` `db_backup.restore_completed` is the exact failure #288
      // exists to prevent.
      expect(emailSender.deliver).toHaveBeenCalledTimes(2);
      expect(browserSender.deliver).toHaveBeenCalledTimes(2);
    });

    it('the DETACHED sibling has NOT delivered when it resolves — which is why the restore cannot use it', async () => {
      holders('admin-1');

      await service.notifyPermissionHolders(EVENT, PERMISSION, {});

      expect(emailSender.deliver).not.toHaveBeenCalled();

      await service.flush();

      expect(emailSender.deliver).toHaveBeenCalledTimes(1);
    });

    it('never rejects, even when the audience query throws', async () => {
      prisma.user.findMany.mockRejectedValue(new Error('connection reset'));

      await expect(
        service.notifyPermissionHoldersNow(EVENT, PERMISSION, {}),
      ).resolves.toBeUndefined();
    });

    it('never rejects, even when a channel throws outright', async () => {
      holders('admin-1');
      emailSender.deliver.mockImplementation(() => {
        throw new Error('transport exploded');
      });

      await expect(
        service.notifyPermissionHoldersNow(EVENT, PERMISSION, {}),
      ).resolves.toBeUndefined();
    });

    it('is an unknown-key no-op, exactly like the detached sibling', async () => {
      await expect(
        service.notifyPermissionHoldersNow('does.not_exist', PERMISSION, {}),
      ).resolves.toBeUndefined();

      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });
});
