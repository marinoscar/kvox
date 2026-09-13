import { ConflictException, NotFoundException } from '@nestjs/common';

import {
  createMockPrismaService,
  MockPrismaService,
} from '../../test/mocks/prisma.mock';
import { PrismaService } from '../prisma/prisma.service';
import { PushConfigService, ActiveVapidConfig } from './push-config.service';
import { PushSubscriptionService } from './push-subscription.service';
import type { PushSubscribeRequest } from './dto/push-subscription.dto';

// =============================================================================
// PushSubscriptionService — tests (issue #229, epic #215; #355 made it async)
// =============================================================================
//
// Three properties this issue's acceptance criteria turn on, in the order
// they matter most:
//
//   1. `isEnabled()`/`getVapidPublicKey()` are now thin ASYNC wrappers over
//      `PushConfigService.resolveActiveVapidConfig()` (#355) — the full
//      env/DB precedence matrix that method implements is exercised
//      separately in `push-config.service.spec.ts`. Here we only prove the
//      delegation itself: a resolved config means "enabled" and hands back
//      its public key; `null` means "disabled" and `null`.
//   2. `subscribe()` upserts BY ENDPOINT — a second call with the same
//      endpoint updates the same row (and resets `failureCount`), and a
//      re-subscribe under a DIFFERENT userId reassigns ownership rather than
//      forking a duplicate.
//   3. `unsubscribe()` scopes its delete by BOTH `userId` AND `endpoint` — a
//      different user's id must not be able to match another user's row. This
//      is the security-relevant "cannot delete another user's subscription"
//      criterion, proven here at the query-shape level (Prisma itself is what
//      actually enforces the resulting filter against the database).
// =============================================================================

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

function subscribeDto(
  overrides: Partial<PushSubscribeRequest> = {},
): PushSubscribeRequest {
  return {
    endpoint: ENDPOINT,
    keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
    expirationTime: null,
    ...overrides,
  };
}

const ACTIVE_CONFIG: ActiveVapidConfig = {
  publicKey: 'pub-key',
  privateKey: 'priv-key',
  subject: 'mailto:ops@example.com',
};

/** A mock `PushConfigService` exposing only what this service touches. */
function mockPushConfig(
  resolved: ActiveVapidConfig | null,
): jest.Mocked<Pick<PushConfigService, 'resolveActiveVapidConfig'>> {
  return {
    resolveActiveVapidConfig: jest.fn().mockResolvedValue(resolved),
  };
}

describe('PushSubscriptionService', () => {
  let mockPrisma: MockPrismaService;

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // isEnabled() / getVapidPublicKey() — thin async delegation to
  // PushConfigService.resolveActiveVapidConfig()
  // ==========================================================================

  describe('isEnabled()', () => {
    it('is true when resolveActiveVapidConfig() resolves an active config', async () => {
      mockPrisma = createMockPrismaService();
      const pushConfig = mockPushConfig(ACTIVE_CONFIG);
      const service = new PushSubscriptionService(
        mockPrisma as unknown as PrismaService,
        pushConfig as unknown as PushConfigService,
      );

      await expect(service.isEnabled()).resolves.toBe(true);
      expect(pushConfig.resolveActiveVapidConfig).toHaveBeenCalledTimes(1);
    });

    it('is false when resolveActiveVapidConfig() resolves null (the default test environment)', async () => {
      mockPrisma = createMockPrismaService();
      const pushConfig = mockPushConfig(null);
      const service = new PushSubscriptionService(
        mockPrisma as unknown as PrismaService,
        pushConfig as unknown as PushConfigService,
      );

      await expect(service.isEnabled()).resolves.toBe(false);
    });
  });

  describe('getVapidPublicKey()', () => {
    it('returns the resolved config\'s publicKey when active', async () => {
      mockPrisma = createMockPrismaService();
      const pushConfig = mockPushConfig(ACTIVE_CONFIG);
      const service = new PushSubscriptionService(
        mockPrisma as unknown as PrismaService,
        pushConfig as unknown as PushConfigService,
      );

      await expect(service.getVapidPublicKey()).resolves.toBe('pub-key');
    });

    it('returns null (not undefined) when nothing is active', async () => {
      mockPrisma = createMockPrismaService();
      const pushConfig = mockPushConfig(null);
      const service = new PushSubscriptionService(
        mockPrisma as unknown as PrismaService,
        pushConfig as unknown as PushConfigService,
      );

      await expect(service.getVapidPublicKey()).resolves.toBeNull();
    });
  });

  // ==========================================================================
  // subscribe()
  // ==========================================================================

  describe('subscribe()', () => {
    function enabledService(): PushSubscriptionService {
      mockPrisma = createMockPrismaService();
      return new PushSubscriptionService(
        mockPrisma as unknown as PrismaService,
        mockPushConfig(ACTIVE_CONFIG) as unknown as PushConfigService,
      );
    }

    it('throws ConflictException (409) when this deployment has no active VAPID config', async () => {
      mockPrisma = createMockPrismaService();
      const service = new PushSubscriptionService(
        mockPrisma as unknown as PrismaService,
        mockPushConfig(null) as unknown as PushConfigService,
      );

      await expect(
        service.subscribe(USER_ID, subscribeDto(), 'test-agent'),
      ).rejects.toThrow(ConflictException);
      expect(mockPrisma.pushSubscription.upsert).not.toHaveBeenCalled();
    });

    it('upserts keyed on endpoint alone, not a composite (userId, endpoint) key', async () => {
      const service = enabledService();
      mockPrisma.pushSubscription.upsert.mockResolvedValue({
        id: 'sub-1',
        endpoint: ENDPOINT,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      } as never);

      await service.subscribe(USER_ID, subscribeDto(), 'test-agent');

      expect(mockPrisma.pushSubscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { endpoint: ENDPOINT } }),
      );
    });

    it('create branch carries userId, endpoint, keys and userAgent, with no failureCount override', async () => {
      const service = enabledService();
      mockPrisma.pushSubscription.upsert.mockResolvedValue({
        id: 'sub-1',
        endpoint: ENDPOINT,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      } as never);

      await service.subscribe(USER_ID, subscribeDto(), 'test-agent');

      const [args] = mockPrisma.pushSubscription.upsert.mock.calls[0] as [
        {
          create: Record<string, unknown>;
        },
      ];
      expect(args.create).toEqual({
        userId: USER_ID,
        endpoint: ENDPOINT,
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
        expirationTime: null,
        userAgent: 'test-agent',
      });
    });

    it('update branch resets failureCount to 0', async () => {
      const service = enabledService();
      mockPrisma.pushSubscription.upsert.mockResolvedValue({
        id: 'sub-1',
        endpoint: ENDPOINT,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      } as never);

      await service.subscribe(USER_ID, subscribeDto(), 'test-agent');

      const [args] = mockPrisma.pushSubscription.upsert.mock.calls[0] as [
        { update: Record<string, unknown> },
      ];
      expect(args.update).toMatchObject({ failureCount: 0 });
    });

    it('a SECOND subscribe with the SAME endpoint updates in place rather than creating a duplicate', async () => {
      const service = enabledService();
      mockPrisma.pushSubscription.upsert.mockResolvedValue({
        id: 'sub-1',
        endpoint: ENDPOINT,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      } as never);

      await service.subscribe(USER_ID, subscribeDto(), 'test-agent');
      await service.subscribe(USER_ID, subscribeDto(), 'test-agent');

      // Two upserts issued, but both keyed on the SAME endpoint — the whole
      // point of upsert-by-endpoint is that Prisma resolves this to one row,
      // not two.
      expect(mockPrisma.pushSubscription.upsert).toHaveBeenCalledTimes(2);
      const [firstCall, secondCall] = mockPrisma.pushSubscription.upsert.mock
        .calls as unknown as [
        [{ where: { endpoint: string } }],
        [{ where: { endpoint: string } }],
      ];
      expect(firstCall[0].where).toEqual({ endpoint: ENDPOINT });
      expect(secondCall[0].where).toEqual({ endpoint: ENDPOINT });
    });

    it('re-subscribing the SAME endpoint under a DIFFERENT userId reassigns ownership on the update branch', async () => {
      const service = enabledService();
      mockPrisma.pushSubscription.upsert.mockResolvedValue({
        id: 'sub-1',
        endpoint: ENDPOINT,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      } as never);

      // Same browser endpoint, first signed in as USER_ID...
      await service.subscribe(USER_ID, subscribeDto(), 'test-agent');
      // ...then re-registered while signed in as OTHER_USER_ID (shared
      // machine / re-login scenario the service's header documents).
      await service.subscribe(OTHER_USER_ID, subscribeDto(), 'test-agent');

      const [, secondCall] = mockPrisma.pushSubscription.upsert.mock
        .calls as unknown as [unknown, [{ where: unknown; update: { userId: string } }]];

      expect(secondCall[0].where).toEqual({ endpoint: ENDPOINT });
      expect(secondCall[0].update.userId).toBe(OTHER_USER_ID);
    });

    it('converts a numeric expirationTime to a Date before hitting Prisma', async () => {
      const service = enabledService();
      mockPrisma.pushSubscription.upsert.mockResolvedValue({
        id: 'sub-1',
        endpoint: ENDPOINT,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      } as never);

      const expirationTime = 1893456000000; // 2030-01-01T00:00:00.000Z
      await service.subscribe(
        USER_ID,
        subscribeDto({ expirationTime }),
        'test-agent',
      );

      const [args] = mockPrisma.pushSubscription.upsert.mock.calls[0] as [
        { create: { expirationTime: Date } },
      ];
      expect(args.create.expirationTime).toEqual(new Date(expirationTime));
    });

    it('treats an absent expirationTime as null, not undefined', async () => {
      const service = enabledService();
      mockPrisma.pushSubscription.upsert.mockResolvedValue({
        id: 'sub-1',
        endpoint: ENDPOINT,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      } as never);

      await service.subscribe(
        USER_ID,
        subscribeDto({ expirationTime: undefined }),
        'test-agent',
      );

      const [args] = mockPrisma.pushSubscription.upsert.mock.calls[0] as [
        { create: { expirationTime: unknown } },
      ];
      expect(args.create.expirationTime).toBeNull();
    });

    it('falls back to null userAgent when the header is absent', async () => {
      const service = enabledService();
      mockPrisma.pushSubscription.upsert.mockResolvedValue({
        id: 'sub-1',
        endpoint: ENDPOINT,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      } as never);

      await service.subscribe(USER_ID, subscribeDto(), undefined);

      const [args] = mockPrisma.pushSubscription.upsert.mock.calls[0] as [
        { create: { userAgent: unknown } },
      ];
      expect(args.create.userAgent).toBeNull();
    });

    it('returns only id, endpoint and createdAt — not the keys or userId', async () => {
      const service = enabledService();
      const createdAt = new Date('2026-03-01T00:00:00.000Z');
      mockPrisma.pushSubscription.upsert.mockResolvedValue({
        id: 'sub-1',
        userId: USER_ID,
        endpoint: ENDPOINT,
        p256dh: 'p256dh-key',
        auth: 'auth-secret',
        createdAt,
      } as never);

      const result = await service.subscribe(USER_ID, subscribeDto(), 'ua');

      expect(result).toEqual({ id: 'sub-1', endpoint: ENDPOINT, createdAt });
    });
  });

  // ==========================================================================
  // unsubscribe()
  // ==========================================================================

  describe('unsubscribe()', () => {
    beforeEach(() => {
      mockPrisma = createMockPrismaService();
    });

    function service(): PushSubscriptionService {
      return new PushSubscriptionService(
        mockPrisma as unknown as PrismaService,
        mockPushConfig(null) as unknown as PushConfigService,
      );
    }

    it('deletes with a where clause scoped to BOTH userId and endpoint', async () => {
      mockPrisma.pushSubscription.deleteMany.mockResolvedValue({
        count: 1,
      } as never);

      await service().unsubscribe(USER_ID, ENDPOINT);

      expect(mockPrisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, endpoint: ENDPOINT },
      });
    });

    it('resolves normally when exactly one row matched', async () => {
      mockPrisma.pushSubscription.deleteMany.mockResolvedValue({
        count: 1,
      } as never);

      await expect(
        service().unsubscribe(USER_ID, ENDPOINT),
      ).resolves.toBeUndefined();
    });

    it('throws NotFoundException when count is 0 (endpoint truly does not exist)', async () => {
      mockPrisma.pushSubscription.deleteMany.mockResolvedValue({
        count: 0,
      } as never);

      await expect(service().unsubscribe(USER_ID, ENDPOINT)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('THE CORE OWNERSHIP CRITERION: a different user cannot delete this endpoint — the where-clause genuinely includes userId, not just endpoint', async () => {
      // Simulate Prisma's real behaviour for the "endpoint exists but belongs
      // to someone else" case: `deleteMany` only counts rows matching BOTH
      // fields in `where`, so a call for OTHER_USER_ID against an endpoint
      // owned by USER_ID matches nothing.
      mockPrisma.pushSubscription.deleteMany.mockImplementation(
        (async ({ where }: { where: { userId: string; endpoint: string } }) => {
          const ownedByUserId = USER_ID;
          const matches =
            where.userId === ownedByUserId && where.endpoint === ENDPOINT;
          return { count: matches ? 1 : 0 };
        }) as never,
      );

      // The owner succeeds...
      await expect(
        service().unsubscribe(USER_ID, ENDPOINT),
      ).resolves.toBeUndefined();

      // ...but a different user's id for the SAME endpoint is indistinguishable
      // from "no such endpoint" and throws 404, never leaking that the
      // endpoint belongs to somebody else.
      await expect(
        service().unsubscribe(OTHER_USER_ID, ENDPOINT),
      ).rejects.toThrow(NotFoundException);

      // And the where clause passed for the rejected attempt genuinely named
      // the OTHER user's id — proving the query itself carries the caller's
      // identity rather than the check happening after an unscoped delete.
      const lastCall = mockPrisma.pushSubscription.deleteMany.mock.calls[
        mockPrisma.pushSubscription.deleteMany.mock.calls.length - 1
      ] as unknown as [{ where: { userId: string; endpoint: string } }];
      expect(lastCall[0].where).toEqual({
        userId: OTHER_USER_ID,
        endpoint: ENDPOINT,
      });
    });

    it('never issues a bare delete-by-endpoint call — endpoint always accompanies userId', async () => {
      mockPrisma.pushSubscription.deleteMany.mockResolvedValue({
        count: 1,
      } as never);

      await service().unsubscribe(USER_ID, ENDPOINT);

      const [args] = mockPrisma.pushSubscription.deleteMany.mock.calls[0] as [
        { where: Record<string, unknown> },
      ];
      expect(Object.keys(args.where).sort()).toEqual(['endpoint', 'userId']);
    });
  });
});
